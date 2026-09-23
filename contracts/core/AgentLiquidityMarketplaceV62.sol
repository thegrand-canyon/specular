// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./AgentRegistryV2.sol";
import "./ReputationManagerV4.sol";

/**
 * @title AgentLiquidityMarketplaceV62
 * @notice P2P lending marketplace — V6.2, the marketplace half of the Specular V7
 *         credit model (the fix for audit finding F-04). Identical to V6.1 except
 *         for the changes listed under "V6.2" below; V6.1 remains in the repo as
 *         `AgentLiquidityMarketplaceV6` and is unchanged so its regression suites
 *         keep running against the exact source they were written for.
 *
 * V6.2 (V7 credit model, 2026-09-22 — see forensics/output/v7-model/V7_DESIGN_AND_VALIDATION.md):
 *   M2-a — the pool creator's OWN lender position is LOCKED while the agent has
 *          outstanding principal: `withdrawLiquidity` refuses it. Every bust-out in
 *          the economic simulation started with the attacker withdrawing its own
 *          seed; that is now impossible.
 *   M2-b — on default, that self-stake position absorbs the loss FIRST, before any
 *          other lender's principal is touched. The attacker's own capital is
 *          genuinely first-loss rather than pari passu.
 *   M2-c — a loan at a partially- or un-collateralised tier requires
 *          `selfStake >= unsecuredExposure / creditMultiple`, where unsecured
 *          exposure is (outstanding + amount) × (100 − collateral%) / 100.
 *   M2-d — every reputation call now carries the marketplace `loanId`
 *          (`recordBorrow` / `recordLoanCompletion` / `recordDefault`), so
 *          ReputationManagerV4 can compute hold time exactly. Matching a repayment
 *          to its borrow BY AMOUNT (the report's scratch model) is ambiguous with
 *          concurrent equal-size loans, so this signature change is required.
 *   M2-e — `recordLoanCompletion` also carries `lateSeconds`, which V4 turns into a
 *          reputation penalty (the hook V6.1 lacked).
 *   L7   — socialised default loss now falls FIRST on the principal that was
 *          QUALIFIED for the defaulted loan at its `startTime`. A lender who joined
 *          mid-loan earns nothing from that loan (W1) but under V6.1 absorbed its
 *          full pro-rata loss — a systematic transfer from new lenders to existing
 *          ones, and an invitation to open a large loan and solicit liquidity after.
 *          Any residual beyond the qualified basis still falls on the remaining
 *          principal, then on unclaimed interest (F-05), so conservation is exact.
 *
 * Inherited from V6, unchanged:
 * @dev Drop-in successor to v4. Storage layout intentionally NOT compatible — fresh deploy + migrate.
 *
 * Fixes vs v4:
 *   §B1 — `isInPoolLenders` flag prevents duplicate poolLenders entries on supply→withdraw→supply.
 *         Added `compactPoolLenders(agentId)` admin to dedup any state seeded from v4.
 *   §S1 — `claimInterest` decrements `pool.availableLiquidity` to match the USDC leaving the contract.
 *   §S5 — `activeLoanCount` mapping replaces `_countActiveLoans` array walk (O(N) → O(1)).
 *
 * Admin migration helpers (owner-only, locked once setMigrationFinalized() called):
 *   - `seedPool(agentId, agentAddress, totalLiquidity, availableLiquidity, totalEarned)`
 *   - `seedPosition(agentId, lender, amount, earnedInterest, depositTimestamp)`
 *   - `compactPoolLenders(agentId)` — dedup any state seeded from v4
 *   - `setMigrationFinalized()` — irreversibly disables seed* and unlocks normal operation
 *
 * V6.1 (internal audit 2026-09-19, see forensics/output/audit-2026-09/):
 *   F-01 — loan-closing path resolves the agent by `loan.agentId` (via the registry's
 *          `ownerOf`, whose holder always maps back to the id), so an agent-NFT transfer
 *          can no longer freeze `repayLoan`/`liquidateLoan`. Repay is allowed from the
 *          original borrower OR the current NFT holder; collateral always returns to
 *          `loan.borrower` (the address that posted it).
 *   F-02 — a lender top-up while loans are in flight goes into a PENDING tranche; the
 *          previously-qualified principal keeps its `depositTimestamp` and its share of
 *          every in-flight loan. See `supplyLiquidity` for the fold/merge rules.
 *   F-03 — interest is charged on max(duration, elapsed) capped at duration +
 *          `LATE_INTEREST_CAP`; lateness is recorded per loan/agent and emitted.
 *   F-05 — a socialized loss larger than Σ principal is also socialized across
 *          unclaimed `earnedInterest` (exact, no dust), so booked interest is never
 *          unbacked and `claimInterest` is never first-come-first-served.
 *   F-07 — `createAgentPool`/`requestLoan` require the agent to be active in the registry.
 *
 * NOT independently audited. Do not deploy to Base mainnet without external review.
 */
contract AgentLiquidityMarketplaceV62 is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    /// @notice Source version. "V6.2" = V6.1 + the V7 credit model (M2 self-stake,
    ///         loanId/lateSeconds pass-through, L7 socialisation basis).
    string public constant VERSION = "V6.2";

    // State variables (set in constructor, immutable for gas savings — slither finding)
    AgentRegistryV2 public immutable agentRegistry;
    ReputationManagerV4 public immutable reputationManager;
    IERC20 public immutable usdcToken;

    // Agent liquidity pools
    struct AgentPool {
        uint256 agentId;
        address agentAddress;
        uint256 totalLiquidity;      // Total USDC supplied to this agent
        uint256 availableLiquidity;  // USDC available for borrowing
        uint256 totalLoaned;         // Currently loaned out
        uint256 totalEarned;         // Total interest earned
        bool isActive;               // Agent can accept liquidity
    }

    // Lender position tracking
    struct LenderPosition {
        uint256 amount;              // USDC supplied to agent (TOTAL principal, incl. any pending tranche)
        uint256 earnedInterest;      // Interest earned so far
        uint256 depositTimestamp;    // Qualification timestamp of the BASE tranche (amount − pending)
    }

    // [F-02 fix 2026-09] Pending tranche: the part of `LenderPosition.amount` that was
    // topped up while loans were in flight. It qualifies for a loan only if
    // `timestamp <= loan.startTime`, while the base tranche keeps its own
    // `depositTimestamp` — so a top-up never forfeits the base tranche's share of
    // in-flight loans (the V6 behaviour reset the whole position's timestamp).
    // Packed into one slot: amounts are 6-dec USDC (fit uint128), timestamps fit uint128.
    struct PendingTranche {
        uint128 amount;
        uint128 timestamp;
    }

    // [F-03 fix 2026-09] Per-loan repayment record (kept out of `Loan` so the
    // `loans()` tuple shape is unchanged for existing consumers).
    struct RepaymentRecord {
        uint256 repaidAt;            // block.timestamp of repayLoan
        uint256 interestPaid;        // interest actually charged (elapsed-time based)
        uint256 lateSeconds;         // repaidAt − endTime if late, else 0
    }

    // Loan tracking
    struct Loan {
        uint256 loanId;
        address borrower;
        uint256 agentId;
        uint256 amount;
        uint256 collateralAmount;
        uint256 interestRate;        // Basis points (e.g., 500 = 5%)
        uint256 startTime;
        uint256 endTime;
        uint256 duration;            // In days
        LoanState state;
    }

    enum LoanState {
        REQUESTED,
        ACTIVE,
        REPAID,
        DEFAULTED
    }

    // Mappings
    mapping(uint256 => AgentPool) public agentPools;                          // agentId => pool
    mapping(uint256 => mapping(address => LenderPosition)) public positions;  // agentId => lender => position
    mapping(uint256 => address[]) public poolLenders;                         // agentId => lender addresses
    mapping(uint256 => Loan) public loans;                                    // loanId => loan
    mapping(address => uint256[]) public agentLoans;                          // agent => loanIds

    uint256 public nextLoanId = 1;
    uint256 public platformFeeRate = 100; // 1% platform fee (in basis points)
    uint256 public accumulatedFees;

    // [M-2 lever 2026-07] Minimum time (seconds) a loan must be held before an
    // on-time repayment earns reputation. 0 = disabled (current behavior). Set
    // > 0 to blunt request→repay reputation farming. Owner-tunable risk param.
    uint256 public minHoldForReputationReward;

    // [M-1 lever 2026-07] When true, only a pool's original creator address may
    // borrow from it — so transferring the agent NFT does NOT hand the buyer
    // borrowing rights against lenders' liquidity (reputation is keyed by
    // agentId and would otherwise transfer with the NFT). false = current behavior.
    bool public bindBorrowToPoolCreator;

    // [F-C lever 2026-08] Minimum supply amount. poolLenders is hard-capped at
    // MAX_LENDERS_PER_POOL to bound _distributeInterest gas; with no minimum, an
    // attacker can occupy all 50 slots with 1-base-unit deposits from 50 Sybil
    // addresses and (never withdrawing) permanently lock out real lenders. A
    // minimum forces a squatter to LOCK minSupplyAmount × 50 per pool. 0 =
    // disabled (current behavior); set > 0 at launch. Owner-tunable.
    uint256 public minSupplyAmount;

    // Discovery: ordered list of all agent IDs that have created pools
    uint256[] public agentPoolIds;

    // §S5 fix: O(1) active-loan counter — replaces _countActiveLoans array walk.
    // [audit 2026-08 D2] Keyed by agentId, not address: the credit limit and
    // reputation are per-agentId, so the aggregate must follow the same identity.
    // Keying by address let a transferred agent NFT reset the aggregate (fresh
    // address, same reputation) — the H-3 bypass that otherwise depended on the
    // M-1 lever to block. agentId-keying decouples H-3 from M-1.
    mapping(uint256 => uint256) public activeLoanCount;

    // [H-3 fix 2026-07] Aggregate outstanding principal per AGENT (see D2 above).
    mapping(uint256 => uint256) public outstandingPrincipal;

    // §B1 fix: presence flag — gates poolLenders.push(), prevents duplicate entries
    mapping(uint256 => mapping(address => bool)) public isInPoolLenders;

    // Migration phase — owner can seed* state until finalized; irreversible after finalization
    bool public migrationFinalized;

    // [F-02] agentId => lender => pending (post-loan-start) tranche. Always ⊆ positions[..].amount.
    mapping(uint256 => mapping(address => PendingTranche)) public pendingTranche;

    // [F-02] agentId => loanIds currently ACTIVE. Bounded by MAX_ACTIVE_LOANS_PER_AGENT
    // (10). Maintained at _disburseLoan (push) and repay/liquidate (swap-and-pop).
    // Used to decide whether a pending tranche can be folded/merged losslessly.
    mapping(uint256 => uint256[]) public activeLoanIds;

    // [F-03] loanId => repayment record; agentId => lateness counters (on-chain
    // record for a future reputation model / off-chain scoring — ReputationManagerV3
    // exposes no late-repayment hook and is intentionally NOT modified).
    mapping(uint256 => RepaymentRecord) public repayments;
    mapping(uint256 => uint256) public lateRepayCount;
    mapping(uint256 => uint256) public lateSecondsTotal;

    // Constants
    uint256 public constant MAX_INTEREST_RATE = 2000; // 20% max
    uint256 public constant MIN_LOAN_DURATION = 7 days;
    uint256 public constant MAX_LOAN_DURATION = 365 days;
    // [F-03] Interest keeps accruing past endTime for at most this long. Bounds the
    // repayment amount so a late borrower is charged for time used but never faces
    // an unpayable bill (which would only push them into default).
    uint256 public constant LATE_INTEREST_CAP = 30 days;
    // [H-04 mitigation] Cap lenders per pool to bound _distributeInterest gas cost.
    //
    // DO NOT RAISE THIS WITHOUT RE-MEASURING (V7_SCALE_AND_GAS_REPORT.md §6 item 7).
    // `repayLoan` costs ≈ 32,700 gas per lender and `liquidateLoan` ≈ 24,600; at 50
    // that is 1.97 M / 1.37 M, i.e. 15.2× / 21.9× headroom on Arc's 30M block.
    // Extrapolated, `repayLoan` reaches a 30M block at roughly **530 lenders** — a
    // cap of 200 would still fit (~6.6 M) but a cap of 500 would not, and the whole
    // §S5 class of failure returns the moment that loop is effectively unbounded.
    //
    // The EFFECTIVE THIRD-PARTY cap is 49, not 50: `_claimLenderSlot` reserves the
    // last slot for the pool creator's M2-c first-loss self-stake (see D2 there).
    uint256 public constant MAX_LENDERS_PER_POOL = 50;
    /// @notice The number of slots third parties may occupy: one is reserved for the
    ///         pool creator's M2-c self-stake. Published so clients can explain the
    ///         "Last slot reserved for agent self-stake" refusal.
    uint256 public constant MAX_THIRD_PARTY_LENDERS_PER_POOL = MAX_LENDERS_PER_POOL - 1;
    // [SECURITY-01] Limit concurrent active loans per agent to prevent credit limit bypass
    uint256 public constant MAX_ACTIVE_LOANS_PER_AGENT = 10;

    // Events
    event PoolCreated(uint256 indexed agentId, address indexed agentAddress);
    event LiquiditySupplied(uint256 indexed agentId, address indexed lender, uint256 amount);
    event LiquidityWithdrawn(uint256 indexed agentId, address indexed lender, uint256 amount);
    event LoanRequested(uint256 indexed loanId, uint256 indexed agentId, address indexed borrower, uint256 amount);
    event LoanDisbursed(uint256 indexed loanId, uint256 amount);
    event LoanRepaid(uint256 indexed loanId, uint256 principal, uint256 interest);
    event LoanDefaulted(uint256 indexed loanId);
    event InterestDistributed(uint256 indexed agentId, uint256 totalInterest);
    event InterestClaimed(uint256 indexed agentId, address indexed lender, uint256 amount);
    event PoolLendersCompacted(uint256 indexed agentId, uint256 removed);
    event MigrationFinalized();
    event PoolSeeded(uint256 indexed agentId, address indexed agentAddress);
    event PositionSeeded(uint256 indexed agentId, address indexed lender, uint256 amount, uint256 earnedInterest);
    event FeesWithdrawn(address indexed to, uint256 amount);
    // [F-02] Emitted whenever a lender's pending tranche changes (set, merged, folded, drawn down).
    event PendingTrancheUpdated(uint256 indexed agentId, address indexed lender, uint256 pendingAmount, uint256 pendingTimestamp);
    // [F-03] Emitted on a late repayment. `lateInterest` = interest charged beyond the nominal-duration amount.
    event LoanRepaidLate(uint256 indexed loanId, uint256 indexed agentId, uint256 lateSeconds, uint256 lateInterest);
    // [F-05] Emitted when a default loss exceeded Σ principal and the excess was socialized across unclaimed interest.
    event InterestLossSocialized(uint256 indexed agentId, uint256 interestReduced);
    // [M2-b] Emitted when the pool creator's own first-loss stake absorbed part of a default loss.
    event SelfStakeAbsorbedLoss(uint256 indexed agentId, address indexed agentAddress, uint256 amount);

    constructor(
        address _agentRegistry,
        address _reputationManager,
        address _usdcToken
    ) Ownable(msg.sender) {
        agentRegistry = AgentRegistryV2(_agentRegistry);
        reputationManager = ReputationManagerV4(_reputationManager);
        usdcToken = IERC20(_usdcToken);
    }

    /**
     * @notice [audit 2026-08 D5] Ownership cannot be renounced. This contract has
     *         owner-only levers (liquidate, withdrawFees, migration finalize,
     *         pause/unpause, protective levers); renouncing would permanently
     *         brick them and could strand funds. Use Ownable2Step transfer instead.
     */
    function renounceOwnership() public view override onlyOwner {
        revert("Ownership cannot be renounced");
    }

    /**
     * @notice Create a liquidity pool for an agent
     */
    function createAgentPool() external whenNotPaused {
        uint256 agentId = agentRegistry.addressToAgentId(msg.sender);
        require(agentId != 0, "Not a registered agent");
        // [F-07 fix 2026-09] Per-agent kill switch: honour registry deactivation.
        require(agentRegistry.isAgentActive(msg.sender), "Agent deactivated");
        require(!agentPools[agentId].isActive, "Pool already exists");

        agentPools[agentId] = AgentPool({
            agentId: agentId,
            agentAddress: msg.sender,
            totalLiquidity: 0,
            availableLiquidity: 0,
            totalLoaned: 0,
            totalEarned: 0,
            isActive: true
        });

        agentPoolIds.push(agentId);

        emit PoolCreated(agentId, msg.sender);
    }

    /**
     * @notice Returns the total number of agent pools created
     */
    function totalPools() external view returns (uint256) {
        return agentPoolIds.length;
    }

    /**
     * @notice Supply USDC liquidity to a specific agent's pool.
     * @dev §B1-fix: a sender is added to `poolLenders[agentId]` AT MOST ONCE via the
     *      `isInPoolLenders` flag. Subsequent supplies (after any withdrawal pattern)
     *      do not push duplicate entries, eliminating the v4 panic risk in
     *      `_distributeInterest`. Reverts if `amount == 0`, if the pool is inactive,
     *      or if the pool's lender count is already at `MAX_LENDERS_PER_POOL`.
     * @param agentId The agent whose pool to supply.
     * @param amount  USDC amount in base units (6 decimals).
     */
    function supplyLiquidity(uint256 agentId, uint256 amount) external nonReentrant whenNotPaused {
        require(amount > 0, "Amount must be > 0");
        // [F-C lever] Raise the cost of lender-slot squatting when enabled. Only
        // gates a NEW slot: an existing lender may top up by any amount.
        // [M2-a] The pool creator's own first-loss stake is EXEMPT: it is locked
        // while the agent borrows and is seized first on default, so it is the
        // opposite of a squat, and M2-c can legitimately require less than
        // `minSupplyAmount` (e.g. a 50 USDC loan at the 75 %-collateral tier needs
        // only 6.25 USDC of stake at k = 2). Without the exemption the gate would
        // make small honest borrowing impossible.
        if (
            minSupplyAmount > 0
            && !isInPoolLenders[agentId][msg.sender]
            && msg.sender != agentPools[agentId].agentAddress
        ) {
            require(amount >= minSupplyAmount, "Below minimum supply");
        }
        require(agentPools[agentId].isActive, "Pool not active");

        AgentPool storage pool = agentPools[agentId];
        LenderPosition storage position = positions[agentId][msg.sender];

        // Transfer USDC from lender
        usdcToken.safeTransferFrom(msg.sender, address(this), amount);

        // Update pool
        pool.totalLiquidity += amount;
        pool.availableLiquidity += amount;

        // §B1 FIX: gate push on isInPoolLenders flag instead of `position.amount == 0`.
        // This ensures that supply→withdraw→supply does NOT create a duplicate entry.
        _claimLenderSlot(agentId, msg.sender);
        // CLAUDE_AUDIT_WORLDCLASS W1 mitigation (kept): NEW money is stamped with
        // block.timestamp so it can never qualify for a loan that is already open —
        // this blocks the mempool-sandwich (front-run repayLoan with a large supply).
        //
        // [F-02 fix 2026-09] What changed: the stamp is no longer applied to the
        // lender's EXISTING principal. V6 reset the whole position's timestamp on
        // every supply, so a 1-base-unit top-up forfeited the position's share of
        // every in-flight loan. Now:
        //   (a) no qualified principal to protect (fresh position, or no loan in
        //       flight): everything becomes one base tranche stamped now.
        //   (b) loans in flight, no pending tranche yet: the base tranche keeps its
        //       timestamp; the new money becomes a PENDING tranche stamped now.
        //   (c) a pending tranche exists and no ACTIVE loan started in
        //       [base.ts, pending.ts): the pending tranche is qualified for exactly
        //       the loans the base is → fold it into the base (lossless), new money
        //       becomes the pending tranche.
        //   (d) else, if no ACTIVE loan started in [pending.ts, now): merging the new
        //       money into the pending tranche and re-stamping it is lossless.
        //   (e) else the position would need a third tranche; rather than silently
        //       forfeit in-flight interest (V6) the top-up is refused. It becomes
        //       possible again once the older in-flight loans close (see canTopUp).
        PendingTranche storage pt = pendingTranche[agentId][msg.sender];
        if (position.amount == 0 || activeLoanCount[agentId] == 0) {
            if (pt.amount != 0) {
                delete pendingTranche[agentId][msg.sender];
                emit PendingTrancheUpdated(agentId, msg.sender, 0, 0);
            }
            position.depositTimestamp = block.timestamp;
        } else if (pt.amount == 0) {
            pt.amount = _toU128(amount);
            pt.timestamp = uint128(block.timestamp);
            emit PendingTrancheUpdated(agentId, msg.sender, amount, block.timestamp);
        } else if (!_activeLoanStartedIn(agentId, position.depositTimestamp, pt.timestamp)) {
            // (c) fold: base keeps depositTimestamp; pending := new money only
            pt.amount = _toU128(amount);
            pt.timestamp = uint128(block.timestamp);
            emit PendingTrancheUpdated(agentId, msg.sender, amount, block.timestamp);
        } else if (!_activeLoanStartedIn(agentId, pt.timestamp, block.timestamp)) {
            // (d) merge into pending and re-stamp
            uint256 newPending = uint256(pt.amount) + amount;
            pt.amount = _toU128(newPending);
            pt.timestamp = uint128(block.timestamp);
            emit PendingTrancheUpdated(agentId, msg.sender, newPending, block.timestamp);
        } else {
            revert("Top-up would forfeit in-flight interest");
        }
        position.amount += amount;

        emit LiquiditySupplied(agentId, msg.sender, amount);
    }

    /**
     * @dev §B1 + [D2 fix 2026-09-22] Claim `lender`'s slot in `poolLenders[agentId]`,
     *      at most once (the §B1 no-duplicate guarantee).
     *
     *      THE LAST SLOT IS RESERVED FOR THE POOL CREATOR. M2-c requires the agent to
     *      hold its own lender position before it may borrow below 100 % collateral,
     *      and that position only exists by calling `supplyLiquidity` — which pushes
     *      onto this same capped array. Without the reservation, whoever fills the 50
     *      slots first decides whether the agent can EVER borrow unsecured, and no
     *      owner tool reverses it (`compactPoolLenders` only de-duplicates). That is
     *      report finding D2: the V7 escalation of the inherited F-06 slot squat.
     *
     *      Consequence, and it is deliberate: the effective THIRD-PARTY lender cap is
     *      MAX_LENDERS_PER_POOL − 1 = 49 while the creator holds no position, and
     *      exactly 49 + the creator once it does. The §1 gas tables' "N=50" therefore
     *      always means 49 third parties plus the agent. Clients must surface
     *      "Last slot reserved for agent self-stake" as a distinct, explainable
     *      refusal rather than a generic capacity error.
     */
    function _claimLenderSlot(uint256 agentId, address lender) internal {
        if (isInPoolLenders[agentId][lender]) return;
        uint256 len = poolLenders[agentId].length;
        require(len < MAX_LENDERS_PER_POOL, "Pool lender capacity reached");
        // Only consult the creator's flag at the boundary, so the common path costs
        // nothing extra.
        if (len == MAX_LENDERS_PER_POOL - 1) {
            address creator = agentPools[agentId].agentAddress;
            require(
                lender == creator || isInPoolLenders[agentId][creator],
                "Last slot reserved for agent self-stake"
            );
        }
        poolLenders[agentId].push(lender);
        isInPoolLenders[agentId][lender] = true;
    }

    /// @dev True if any ACTIVE loan of `agentId` started in [lo, hi). ≤ MAX_ACTIVE_LOANS_PER_AGENT reads.
    function _activeLoanStartedIn(uint256 agentId, uint256 lo, uint256 hi) internal view returns (bool) {
        uint256[] storage ids = activeLoanIds[agentId];
        for (uint256 i = 0; i < ids.length; i++) {
            uint256 s = loans[ids[i]].startTime;
            if (s >= lo && s < hi) return true;
        }
        return false;
    }

    function _toU128(uint256 x) internal pure returns (uint128) {
        require(x <= type(uint128).max, "Amount overflow");
        return uint128(x);
    }

    /**
     * @notice [F-02] Whether `lender` can currently top up `agentId`'s pool without
     *         forfeiting in-flight interest (i.e. `supplyLiquidity` would not revert
     *         with "Top-up would forfeit in-flight interest"). SDK/MCP pre-check.
     */
    function canTopUp(uint256 agentId, address lender) external view returns (bool) {
        LenderPosition storage p = positions[agentId][lender];
        PendingTranche storage pt = pendingTranche[agentId][lender];
        if (p.amount == 0 || activeLoanCount[agentId] == 0 || pt.amount == 0) return true;
        if (!_activeLoanStartedIn(agentId, p.depositTimestamp, pt.timestamp)) return true;
        // [fix 2026-09-20, testing round] The supply tx lands in a LATER block than the
        // one this view is evaluated against, so a loan that started in the current
        // block (start == block.timestamp) will be inside the tx's half-open
        // [pending.ts, tx.timestamp) window. Use an inclusive upper bound here so the
        // pre-check predicts the tx exactly (found by V61PropertyFuzz property (i)).
        return !_activeLoanStartedIn(agentId, pt.timestamp, block.timestamp + 1);
    }

    /**
     * @notice [F-02] Principal of `lender` that qualifies for interest on a loan that
     *         started at `loanStartTime` (base tranche if its timestamp ≤ start, plus
     *         the pending tranche if ITS timestamp ≤ start).
     */
    function qualifiedAmountAt(uint256 agentId, address lender, uint256 loanStartTime) public view returns (uint256 q) {
        LenderPosition storage p = positions[agentId][lender];
        if (p.amount == 0) return 0;
        PendingTranche storage pt = pendingTranche[agentId][lender];
        uint256 pend = pt.amount;
        if (p.depositTimestamp <= loanStartTime) q = p.amount - pend;
        if (pend > 0 && pt.timestamp <= loanStartTime) q += pend;
    }

    /// @notice [F-02] Loan ids currently ACTIVE for `agentId` (≤ MAX_ACTIVE_LOANS_PER_AGENT).
    function getActiveLoanIds(uint256 agentId) external view returns (uint256[] memory) {
        return activeLoanIds[agentId];
    }

    /**
     * @notice Withdraw liquidity from an agent's pool
     */
    function withdrawLiquidity(uint256 agentId, uint256 amount) external nonReentrant whenNotPaused {
        // CLAUDE_REVIEW Finding 4: reject zero-amount withdrawals (prevents wasted-gas no-op)
        require(amount > 0, "Amount must be > 0");
        LenderPosition storage position = positions[agentId][msg.sender];
        AgentPool storage pool = agentPools[agentId];

        require(position.amount >= amount, "Insufficient balance");

        // [M2-a] The pool creator's own position is the agent's first-loss stake. It
        // is LOCKED for as long as the agent carries outstanding principal. Every
        // bust-out in the economic simulation began with the attacker withdrawing
        // its own seed immediately before drawing the pool down; that ordering is
        // now impossible, and M2-b makes the stake absorb the loss first.
        // Checked BEFORE the liquidity require so a locked creator always gets the
        // informative reason (after a full draw availableLiquidity is 0 and the
        // generic "Insufficient pool liquidity" would mask the real constraint).
        require(
            msg.sender != pool.agentAddress || outstandingPrincipal[agentId] == 0,
            "Self-stake locked while borrowing"
        );

        require(pool.availableLiquidity >= amount, "Insufficient pool liquidity");

        // [F-06 / D1 fix 2026-09-22] `minSupplyAmount` is a MAINTAINED floor, not
        // just an entry fee. It used to be checked only when a NEW slot was claimed,
        // so a squatter supplied the minimum, withdrew all but one base unit, and
        // held the slot forever for 0.000001 USDC — the H-2 slot-free condition
        // (`amount == 0 && earnedInterest == 0`) never fires on a dust remainder.
        // 50 of those bricked a pool (report D1) and, since V6.2, the agent's own
        // M2-c self-stake as well (D2). A partial withdrawal may therefore not leave
        // a position in (0, minSupplyAmount).
        //
        // Deliberately a REVERT, not a silent forced full exit: transferring more
        // than the caller asked for is a nasty surprise for an integrator's
        // accounting. The client's remedy is one call with the full balance.
        //
        // Two exemptions keep the legitimate cases working:
        //   * a FULL exit (remaining == 0) is ALWAYS allowed, including when the
        //     owner has since RAISED minSupplyAmount above an existing position;
        //   * the pool creator is exempt, symmetrically with the M2-a supply-side
        //     exemption (M2-c can legitimately require less than minSupplyAmount,
        //     and the creator's position is already locked by M2-a while borrowing).
        //
        // Ordered so a FULL exit never even reads `minSupplyAmount`: the path that
        // must always work is also the cheapest one.
        if (position.amount > amount && msg.sender != pool.agentAddress) {
            uint256 floor = minSupplyAmount;
            require(floor == 0 || position.amount - amount >= floor, "Remaining below minimum supply");
        }

        // Update position. [F-02] Draw down the PENDING (newest, least-qualified)
        // tranche first, so a lender who tops up and then withdraws the same amount
        // keeps the base tranche's qualification intact (LIFO). This cannot grant
        // qualification: the base tranche's timestamp is never moved earlier.
        PendingTranche storage pt = pendingTranche[agentId][msg.sender];
        if (pt.amount > 0) {
            uint256 fromPending = amount < pt.amount ? amount : pt.amount;
            uint256 newPending = pt.amount - fromPending;
            if (newPending == 0) {
                delete pendingTranche[agentId][msg.sender];
                emit PendingTrancheUpdated(agentId, msg.sender, 0, 0);
            } else {
                pt.amount = uint128(newPending);
                emit PendingTrancheUpdated(agentId, msg.sender, newPending, pt.timestamp);
            }
        }
        position.amount -= amount;

        // Update pool.
        // [audit 2026-08] totalLiquidity can legitimately drift below Σ
        // position.amount (e.g. interest paid into availableLiquidity withdrawn as
        // principal), so a plain `-=` could underflow-revert (solc 0.8.20 checked
        // math) and brick a withdrawal of liquidity that demonstrably exists in
        // availableLiquidity. Saturate. (D4 keeps positions and totalLiquidity in
        // step on loss, but this defensive saturation is retained.)
        // availableLiquidity is the solvency-critical figure and is guarded by the
        // require above, so it uses a plain subtraction.
        pool.totalLiquidity = amount >= pool.totalLiquidity ? 0 : pool.totalLiquidity - amount;
        pool.availableLiquidity -= amount;

        // [H-2 FIX 2026-07] Free the lender's slot once their balance hits zero.
        // Previously the §B1 flag was set permanently and withdraw never removed
        // the entry, so an attacker could supply→withdraw from 50 addresses to
        // permanently occupy MAX_LENDERS_PER_POOL and lock out all future lenders.
        // Removing here keeps the §B1 no-duplicate guarantee: a later re-supply
        // sees isInPoolLenders=false and pushes exactly one entry.
        // [audit 2026-08] Only remove when there is ALSO no unclaimed interest.
        // resetPoolAccounting sums earnedInterest over poolLenders to rebuild
        // availableLiquidity; removing a lender who still has earnedInterest would
        // drop their interest from that sum → understated availableLiquidity →
        // their claimInterest reverts "Drain underflow" (frozen funds). A lender
        // who withdraws all principal but has interest stays until they claim;
        // claimInterest then removes them (see below), so no slot is leaked.
        if (position.amount == 0 && position.earnedInterest == 0) {
            _removePoolLender(agentId, msg.sender);
        }

        // Transfer USDC back to lender
        usdcToken.safeTransfer(msg.sender, amount);

        emit LiquidityWithdrawn(agentId, msg.sender, amount);
    }

    /**
     * @notice Remove a lender from a pool's lender list (swap-and-pop) and clear
     *         its membership flag. Bounded by MAX_LENDERS_PER_POOL (≤50 SLOADs).
     */
    function _removePoolLender(uint256 agentId, address lender) internal {
        if (!isInPoolLenders[agentId][lender]) return;
        address[] storage lenders = poolLenders[agentId];
        for (uint256 i = 0; i < lenders.length; i++) {
            if (lenders[i] == lender) {
                lenders[i] = lenders[lenders.length - 1];
                lenders.pop();
                break;
            }
        }
        isInPoolLenders[agentId][lender] = false;
    }

    /// @dev Swap-and-pop `poolLenders[agentId][idx]` and clear its flag (no search).
    function _removePoolLenderAt(uint256 agentId, uint256 idx) internal {
        address[] storage lenders = poolLenders[agentId];
        address lender = lenders[idx];
        lenders[idx] = lenders[lenders.length - 1];
        lenders.pop();
        isInPoolLenders[agentId][lender] = false;
    }

    /// @dev [F-02] Keep `pendingTranche ⊆ position.amount` after a principal reduction of
    ///      `share`: reduce the pending tranche pro-rata (floor), the rest comes off the base.
    function _shrinkPendingProRata(uint256 agentId, address lender, uint256 share, uint256 amountBefore) internal {
        PendingTranche storage pt = pendingTranche[agentId][lender];
        uint256 pend = pt.amount;
        if (pend == 0) return;
        uint256 cut = (share * pend) / amountBefore;
        uint256 newPending = pend - cut;
        // Never let pending exceed the remaining principal (rounding safety).
        if (newPending > amountBefore - share) newPending = amountBefore - share;
        if (newPending == 0) {
            delete pendingTranche[agentId][lender];
            emit PendingTrancheUpdated(agentId, lender, 0, 0);
        } else if (newPending != pend) {
            pt.amount = uint128(newPending);
            emit PendingTrancheUpdated(agentId, lender, newPending, pt.timestamp);
        }
    }

    /**
     * @notice [F-05 fix 2026-09] Second-pass socialization: reduce every lender's
     *         UNCLAIMED `earnedInterest` pro-rata by `loss`, exactly min(loss, Σ earned)
     *         (floor-division remainder assigned, no dust). Called only for the part of
     *         a default loss that exceeded Σ principal — i.e. the defaulted loan was
     *         funded (in part) from lendable unclaimed interest, and without this pass
     *         the booked interest would be unbacked and `claimInterest` first-come-
     *         first-served with the last claimant reverting "Drain underflow".
     */
    function _socializeInterestLoss(uint256 agentId, uint256 loss) internal returns (uint256 reduced) {
        address[] storage lenders = poolLenders[agentId];
        uint256 totalInterest = 0;
        for (uint256 i = 0; i < lenders.length; i++) {
            totalInterest += positions[agentId][lenders[i]].earnedInterest;
        }
        if (totalInterest == 0) return 0;

        uint256 cappedLoss = loss > totalInterest ? totalInterest : loss;
        for (uint256 i = 0; i < lenders.length; i++) {
            LenderPosition storage p = positions[agentId][lenders[i]];
            if (p.earnedInterest == 0) continue;
            uint256 share = (cappedLoss * p.earnedInterest) / totalInterest;
            p.earnedInterest -= share;
            reduced += share;
        }
        uint256 remainder = cappedLoss - reduced;
        for (uint256 i = 0; i < lenders.length && remainder > 0; i++) {
            LenderPosition storage p = positions[agentId][lenders[i]];
            uint256 take = p.earnedInterest < remainder ? p.earnedInterest : remainder;
            p.earnedInterest -= take;
            reduced += take;
            remainder -= take;
        }
        return reduced;
    }

    /// @dev After a loss, free the slots of lenders left with no principal AND no
    ///      interest (they could never call withdraw/claim to free it themselves).
    ///      Iterates from the end so swap-and-pop is safe. Bounded by MAX_LENDERS_PER_POOL.
    function _pruneEmptyLenders(uint256 agentId) internal {
        address[] storage lenders = poolLenders[agentId];
        for (uint256 i = lenders.length; i > 0; i--) {
            LenderPosition storage p = positions[agentId][lenders[i - 1]];
            if (p.amount == 0 && p.earnedInterest == 0) {
                _removePoolLenderAt(agentId, i - 1);
            }
        }
    }

    /**
     * @notice [audit 2026-08 D4] Reduce every lender's principal position in a
     *         pool pro-rata by `loss`, distributing a defaulted-loan shortfall
     *         fairly. Returns the actual total reduction applied — EXACTLY
     *         min(loss, totalPrincipal): the floor-division remainder is assigned
     *         so no dust is left unreduced (keeps totalLiquidity == Σ position.amount
     *         and availableLiquidity+totalLoaned == Σamount+Σinterest exact).
     * @dev Bounded by MAX_LENDERS_PER_POOL (≤ 50). Only principal (position.amount)
     *      is reduced — earnedInterest is untouched.
     */
    /// @dev [M2-b] Reduce a single lender's principal by `want` (clamped to what they
    ///      have), keeping `pendingTranche ⊆ amount`. Returns the amount actually taken.
    function _takeFrom(uint256 agentId, address lender, uint256 want) internal returns (uint256 take) {
        LenderPosition storage p = positions[agentId][lender];
        take = p.amount < want ? p.amount : want;
        if (take == 0) return 0;
        _shrinkPendingProRata(agentId, lender, take, p.amount);
        p.amount -= take;
    }

    /**
     * @dev [L7] One pro-rata pass of principal reduction over a chosen BASIS.
     *      `useQualified == true`  → basis is `qualifiedAmountAt(.., loanStartTime)`,
     *                                i.e. only the principal that was eligible to earn
     *                                interest on the defaulted loan (the L7 fix);
     *      `useQualified == false` → basis is the lender's whole remaining principal
     *                                (the fallback pass, so conservation stays exact).
     *      `excluded` is skipped entirely (the self-stake, already absorbed in full).
     *      Reduces by EXACTLY min(loss, Σ basis): the floor-division remainder is
     *      assigned, so no accounting dust accrues.
     */
    function _reduceByBasis(
        uint256 agentId,
        uint256 loss,
        uint256 loanStartTime,
        address excluded,
        bool useQualified
    ) internal returns (uint256 reduced) {
        address[] storage lenders = poolLenders[agentId];
        uint256 n = lenders.length;
        uint256[] memory basis = new uint256[](n);
        uint256 total = 0;
        for (uint256 i = 0; i < n; i++) {
            address l = lenders[i];
            if (l == excluded) continue;
            uint256 amt = positions[agentId][l].amount;
            if (amt == 0) continue;
            uint256 b = useQualified ? qualifiedAmountAt(agentId, l, loanStartTime) : amt;
            if (b > amt) b = amt; // qualified can never exceed the position, but clamp anyway
            basis[i] = b;
            total += b;
        }
        if (total == 0) return 0;

        uint256 cappedLoss = loss > total ? total : loss;
        for (uint256 i = 0; i < n; i++) {
            if (basis[i] == 0) continue;
            // Proportional share; floor division means Σshares ≤ cappedLoss, and
            // share ≤ basis[i] ≤ position.amount so it can never over-reduce.
            reduced += _takeFrom(agentId, lenders[i], (cappedLoss * basis[i]) / total);
        }
        uint256 remainder = cappedLoss - reduced;
        for (uint256 i = 0; i < n && remainder > 0; i++) {
            if (basis[i] == 0) continue;
            uint256 take = _takeFrom(agentId, lenders[i], remainder);
            reduced += take;
            remainder -= take;
        }
        return reduced;
    }

    /**
     * @notice [audit 2026-08 D4 + L7 2026-09] Socialize a defaulted-loan shortfall
     *         across lender principal. Returns the actual total reduction applied —
     *         EXACTLY min(loss, Σ principal of non-excluded lenders).
     * @dev Two passes. Pass 1 charges only the principal that was QUALIFIED for the
     *      defaulted loan at its `startTime` (L7: a lender who joined mid-loan could
     *      never earn interest on it under the W1 rule, so it must not bear its loss
     *      while earlier lenders are made whole). Pass 2 charges whatever is left over
     *      to the remaining principal, so per-pool conservation is still exact even
     *      when the qualified lenders have since withdrawn.
     * @param excluded Lender to skip — the pool creator's self-stake, which M2-b has
     *        already absorbed in full before this is called.
     */
    function _socializeLoss(uint256 agentId, uint256 loss, uint256 loanStartTime, address excluded)
        internal returns (uint256 reduced)
    {
        reduced = _reduceByBasis(agentId, loss, loanStartTime, excluded, true);
        if (reduced < loss) {
            reduced += _reduceByBasis(agentId, loss - reduced, 0, excluded, false);
        }
        return reduced;
    }

    /**
     * @notice Agent requests a loan from their dedicated pool
     */
    function requestLoan(uint256 amount, uint256 durationDays) external nonReentrant whenNotPaused returns (uint256) {
        // CLAUDE_REVIEW Finding 3: reject zero-amount loans (prevents self-griefing fill of MAX_ACTIVE_LOANS)
        require(amount > 0, "Amount must be > 0");
        uint256 agentId = agentRegistry.addressToAgentId(msg.sender);
        require(agentId != 0, "Not a registered agent");
        // [F-07 fix 2026-09] Per-agent kill switch: a registry-deactivated agent
        // cannot open new loans (it can still repay — the closing path must stay live).
        require(agentRegistry.isAgentActive(msg.sender), "Agent deactivated");
        require(agentPools[agentId].isActive, "No pool for agent");

        AgentPool storage pool = agentPools[agentId];
        require(amount <= pool.availableLiquidity, "Insufficient pool liquidity");

        // [M-1 lever] Optionally bind borrowing to the pool's original creator,
        // so a transferred agent NFT cannot borrow against existing lenders.
        if (bindBorrowToPoolCreator) {
            require(pool.agentAddress == msg.sender, "Borrow restricted to pool creator");
        }

        // Validate loan parameters
        uint256 duration = durationDays * 1 days;
        require(duration >= MIN_LOAN_DURATION && duration <= MAX_LOAN_DURATION, "Invalid duration");

        // Get credit limit based on reputation.
        // [H-3 fix 2026-07] Enforce the limit on AGGREGATE outstanding principal,
        // not the single loan. Previously `amount <= creditLimit` let an agent
        // hold up to MAX_ACTIVE_LOANS_PER_AGENT loans each at the full limit —
        // e.g. 10 × 25k = 250k unsecured for a 0-collateral tier.
        uint256 creditLimit = reputationManager.calculateCreditLimit(msg.sender);
        require(outstandingPrincipal[agentId] + amount <= creditLimit, "Exceeds credit limit");

        // [SECURITY-01] Enforce concurrent loan limit to prevent credit limit bypass
        uint256 activeLoans = _countActiveLoans(agentId);
        require(activeLoans < MAX_ACTIVE_LOANS_PER_AGENT, "Too many active loans");

        // Calculate collateral requirement
        uint256 collateralPercent = reputationManager.calculateCollateralRequirement(msg.sender);
        uint256 requiredCollateral = (amount * collateralPercent) / 100;

        // [M2-c] Self-stake gate. Any exposure the collateral does not cover must be
        // backed by the agent's OWN first-loss capital in its own pool, at
        // `creditMultiple` leverage. At the 0 %-collateral tiers this is exactly the
        // report's rule `selfStake >= outstandingPrincipal / creditMultiple`;
        // generalising it by the collateral percentage closes the 500-tier (75 %
        // collateral, 25 % unsecured) route around the same cap.
        if (collateralPercent < 100) {
            require(
                positions[agentId][pool.agentAddress].amount
                    >= _requiredSelfStake(outstandingPrincipal[agentId] + amount, collateralPercent),
                "Insufficient self-stake"
            );
        }

        // Get interest rate
        uint256 interestRate = reputationManager.calculateInterestRate(msg.sender);

        // Create loan
        uint256 loanId = nextLoanId++;
        loans[loanId] = Loan({
            loanId: loanId,
            borrower: msg.sender,
            agentId: agentId,
            amount: amount,
            collateralAmount: requiredCollateral,
            interestRate: interestRate,
            startTime: 0, // Set when disbursed
            endTime: 0,
            duration: duration,
            state: LoanState.REQUESTED
        });

        agentLoans[msg.sender].push(loanId);

        emit LoanRequested(loanId, agentId, msg.sender, amount);

        // Auto-disburse if no collateral required
        if (requiredCollateral == 0) {
            _disburseLoan(loanId);
        } else {
            // Require collateral to be deposited
            usdcToken.safeTransferFrom(msg.sender, address(this), requiredCollateral);
            _disburseLoan(loanId);
        }

        return loanId;
    }

    /// @dev [M2-c] First-loss self-stake required to carry `exposure` of principal at
    ///      a tier whose collateral requirement is `collateralPercent`.
    function _requiredSelfStake(uint256 exposure, uint256 collateralPercent) internal view returns (uint256) {
        if (collateralPercent >= 100) return 0;
        uint256 unsecured = (exposure * (100 - collateralPercent)) / 100;
        uint256 k = reputationManager.creditMultiple();
        return k == 0 ? unsecured : unsecured / k;
    }

    /**
     * @notice [M2-c] Self-stake the agent must already hold in its own pool before it
     *         could borrow `additionalAmount` more. SDK/MCP pre-check.
     * @dev [D13 fix 2026-09-22] The collateral tier is resolved BY agentId, not by
     *      `pool.agentAddress`. The registry deletes `addressToAgentId[seller]` when
     *      an agent NFT is transferred, so the address-keyed lookup fell through to
     *      agentId 0 → score 0 → 100 % collateral and this view returned 0 — a
     *      view/tx mismatch of the same class as the 2026-09-20 `canTopUp` bug, and
     *      one that told an integrator "no first-loss stake needed" for an agent
     *      whose seller still had capital locked and at risk.
     *
     *      NOTE this fixes the VIEW. It does not change who the stake belongs to:
     *      the M2 self-stake is and remains `positions[agentId][pool.agentAddress]`,
     *      i.e. the SELLER's capital, locked by M2-a and first-loss under M2-b. With
     *      the M-1 lever OFF a buyer can borrow against it. **Keep M-1 ON.**
     */
    function requiredSelfStake(uint256 agentId, uint256 additionalAmount) external view returns (uint256) {
        if (agentPools[agentId].agentAddress == address(0)) return 0;
        uint256 pct = reputationManager.collateralRequirementOf(agentId);
        return _requiredSelfStake(outstandingPrincipal[agentId] + additionalAmount, pct);
    }

    /// @notice [M2-a] The pool creator's locked first-loss position, and whether it is
    ///         currently locked (i.e. the agent has outstanding principal).
    function selfStake(uint256 agentId) external view returns (uint256 amount, bool locked) {
        address agentAddr = agentPools[agentId].agentAddress;
        amount = positions[agentId][agentAddr].amount;
        locked = outstandingPrincipal[agentId] > 0;
    }

    /**
     * @notice Internal function to disburse loan
     */
    function _disburseLoan(uint256 loanId) internal {
        Loan storage loan = loans[loanId];
        AgentPool storage pool = agentPools[loan.agentId];

        require(loan.state == LoanState.REQUESTED, "Invalid loan state");

        // Update pool
        pool.availableLiquidity -= loan.amount;
        pool.totalLoaned += loan.amount;

        // Update loan
        loan.state = LoanState.ACTIVE;
        loan.startTime = block.timestamp;
        loan.endTime = block.timestamp + loan.duration;

        // §S5 FIX: increment counter on transition to ACTIVE
        activeLoanCount[loan.agentId]++;
        // [F-02] Track the active set (bounded by MAX_ACTIVE_LOANS_PER_AGENT).
        activeLoanIds[loan.agentId].push(loanId);

        // [H-3 fix] Track aggregate outstanding principal for the credit check.
        outstandingPrincipal[loan.agentId] += loan.amount;

        // Transfer funds to borrower
        usdcToken.safeTransfer(loan.borrower, loan.amount);

        // Record with reputation manager. [M2-d] The loanId is passed so V4 can key
        // the open-loan record exactly (hold time drives the M1 bonus).
        reputationManager.recordBorrow(loan.borrower, loanId, loan.amount);

        emit LoanDisbursed(loanId, loan.amount);
    }

    /**
     * @notice Repay a loan
     */
    function repayLoan(uint256 loanId) external nonReentrant whenNotPaused {
        Loan storage loan = loans[loanId];
        require(loan.state == LoanState.ACTIVE, "Loan not active");
        // [F-01 fix 2026-09] Repayer policy: the ORIGINAL borrower address (the
        // party that received the principal and posted the collateral) OR the
        // CURRENT holder of the agent NFT (after a legitimate sale the buyer may
        // want to clear the agent's debt to protect its reputation). Anyone else is
        // refused. The registry guarantees `addressToAgentId[ownerOf(id)] == id`,
        // so `holder` is always a resolvable agent for the reputation manager —
        // the loan can be closed regardless of where the NFT went.
        address holder = agentRegistry.ownerOf(loan.agentId);
        require(msg.sender == loan.borrower || msg.sender == holder, "Not the borrower");

        // [F-03 fix 2026-09] Interest is charged on the time actually used:
        // max(duration, elapsed), capped at duration + LATE_INTEREST_CAP. An early
        // repayment still pays the full nominal term (unchanged); a late one pays
        // for the overrun so overdue credit is no longer free.
        (uint256 interest, , uint256 lateSeconds) = _interestDue(loan);

        uint256 totalRepayment = loan.amount + interest;

        // Calculate platform fee
        uint256 platformFee = (interest * platformFeeRate) / 10000;
        uint256 lenderInterest = interest - platformFee;

        // [C-01 FIX] Collect repayment FIRST before any state changes (strict CEI)
        usdcToken.safeTransferFrom(msg.sender, address(this), totalRepayment);

        // EFFECTS: update state only after funds confirmed received
        loan.state = LoanState.REPAID;

        // §S5 FIX: decrement counter on transition out of ACTIVE
        activeLoanCount[loan.agentId]--;
        _removeActiveLoanId(loan.agentId, loanId);

        // [H-3 fix] Principal repaid — free the borrower's aggregate exposure.
        outstandingPrincipal[loan.agentId] -= loan.amount;

        // [F-03] Record lateness on-chain (the loan tuple is unchanged; see `repayments`).
        repayments[loanId] = RepaymentRecord({ repaidAt: block.timestamp, interestPaid: interest, lateSeconds: lateSeconds });
        if (lateSeconds > 0) {
            lateRepayCount[loan.agentId] += 1;
            lateSecondsTotal[loan.agentId] += lateSeconds;
            uint256 nominal = calculateInterest(loan.amount, loan.interestRate, loan.duration);
            emit LoanRepaidLate(loanId, loan.agentId, lateSeconds, interest - nominal);
        }

        // Update pool
        AgentPool storage pool = agentPools[loan.agentId];
        pool.availableLiquidity += loan.amount + lenderInterest;
        pool.totalLoaned -= loan.amount;
        pool.totalEarned += lenderInterest;

        // Distribute interest to lenders proportionally — pass loan.startTime so
        // only lenders who supplied BEFORE this loan started qualify (W1 sandwich fix).
        _distributeInterest(loan.agentId, lenderInterest, loan.startTime);

        // Accumulate platform fees
        accumulatedFees += platformFee;

        // INTERACTIONS: return collateral last.
        // [F-01] Collateral ALWAYS goes back to `loan.borrower` — the address that
        // posted it. An NFT transfer moves the agent identity, not USDC held in
        // escrow for a specific wallet; a new holder who chooses to repay is
        // settling the agent's debt and must arrange any collateral transfer with
        // the seller off-chain. (No theft vector either way: repaying costs
        // principal + interest for collateral ≤ principal.)
        if (loan.collateralAmount > 0) {
            usdcToken.safeTransfer(loan.borrower, loan.collateralAmount);
        }

        // Record with reputation manager — keyed by the agent NFT's CURRENT holder,
        // i.e. by loan.agentId (F-01), never by the historical borrower address.
        // [M-2 lever] Only reward reputation if the loan was held long enough —
        // blunts request→repay farming. recordLoanCompletion applies NO penalty
        // when the flag is false, so a too-fast on-time repay simply earns no
        // bonus (neither reward nor penalty).
        // [D1] Also require the loan to have paid non-zero interest — a
        // zero-interest (sub-rounding) dust loan earns no reputation. Combined
        // with the principal-scaled bonus in the reputation manager, this makes
        // reputation reflect real economic activity, not free loop count.
        // [F-03] A late repayment earns no bonus (onTime=false). ReputationManagerV3
        // has no late-penalty hook; lateness is recorded above for a future model.
        // [M2-e] `lateSeconds` is now passed through: ReputationManagerV4 applies the
        // late-repayment penalty that V6.1 could only record (V3 had no hook).
        bool onTime = block.timestamp <= loan.endTime; // == (lateSeconds == 0)
        bool heldLongEnough = minHoldForReputationReward == 0
            || (block.timestamp - loan.startTime) >= minHoldForReputationReward;
        bool paidInterest = interest > 0;
        reputationManager.recordLoanCompletion(
            holder, loanId, loan.amount, onTime && heldLongEnough && paidInterest, lateSeconds
        );

        emit LoanRepaid(loanId, loan.amount, interest);
    }

    /// @dev [F-03] Interest due now on an ACTIVE loan: max(duration, elapsed) capped at
    ///      duration + LATE_INTEREST_CAP, at the rate locked at request time.
    function _interestDue(Loan storage loan)
        internal view returns (uint256 interest, uint256 chargeableSeconds, uint256 lateSeconds)
    {
        uint256 elapsed = block.timestamp - loan.startTime;
        chargeableSeconds = elapsed > loan.duration ? elapsed : loan.duration;
        uint256 cap = loan.duration + LATE_INTEREST_CAP;
        if (chargeableSeconds > cap) chargeableSeconds = cap;
        lateSeconds = block.timestamp > loan.endTime ? block.timestamp - loan.endTime : 0;
        interest = calculateInterest(loan.amount, loan.interestRate, chargeableSeconds);
    }

    /**
     * @notice [F-03] Amount `repayLoan(loanId)` would pull right now. SDK/MCP must
     *         approve `total` (not principal + nominal interest) for a late loan.
     * @return interest          interest that would be charged now
     * @return total             principal + interest
     * @return chargeableSeconds seconds of interest charged (duration ≤ x ≤ duration + LATE_INTEREST_CAP)
     * @return lateSeconds       seconds past endTime (0 if on time)
     */
    function previewRepayment(uint256 loanId)
        external view returns (uint256 interest, uint256 total, uint256 chargeableSeconds, uint256 lateSeconds)
    {
        Loan storage loan = loans[loanId];
        require(loan.state == LoanState.ACTIVE, "Loan not active");
        (interest, chargeableSeconds, lateSeconds) = _interestDue(loan);
        total = loan.amount + interest;
    }

    /// @dev [F-02] Remove `loanId` from the agent's active set (≤ 10 entries).
    function _removeActiveLoanId(uint256 agentId, uint256 loanId) internal {
        uint256[] storage ids = activeLoanIds[agentId];
        uint256 n = ids.length;
        for (uint256 i = 0; i < n; i++) {
            if (ids[i] == loanId) {
                ids[i] = ids[n - 1];
                ids.pop();
                return;
            }
        }
    }

    /**
     * @notice Distribute interest to lenders proportionally — only to lenders who
     *         supplied BEFORE this specific loan started. Blocks mempool-sandwich
     *         attacks where an attacker front-runs `repayLoan` with a large supply
     *         to capture proportional interest they didn't earn.
     * @dev CLAUDE_AUDIT_WORLDCLASS W1 fix: each lender's `position.depositTimestamp`
     *      (now updated on EVERY supply, not just first) is compared to `loanStartTime`.
     *      Lenders whose deposit is at or before loan start qualify; later supplies don't.
     *      Two-pass loop: first compute qualified total (denominator), then distribute.
     *      Bounded at MAX_LENDERS_PER_POOL = 50 → ≤100 SLOADs per call. Acceptable.
     *      If no lenders qualify (edge: pool had no pre-loan deposits, e.g., loan
     *      requested in same block as the only supply), the interest goes to fees.
     */
    function _distributeInterest(uint256 agentId, uint256 totalInterest, uint256 loanStartTime) internal {
        address[] storage lenders = poolLenders[agentId];

        // First pass: compute each lender's qualified amount and the qualified total.
        // [F-02] Qualification is per TRANCHE (base and pending have their own
        // timestamps) — see qualifiedAmountAt. Cached in memory for the second pass.
        uint256 n = lenders.length;
        uint256[] memory q = new uint256[](n);
        uint256 qualifiedTotal = 0;
        for (uint256 i = 0; i < n; i++) {
            q[i] = qualifiedAmountAt(agentId, lenders[i], loanStartTime);
            qualifiedTotal += q[i];
        }

        if (qualifiedTotal == 0) {
            // No qualified lenders — interest goes to fees rather than being trapped.
            // This can happen for new pools where the only lender supplied after the
            // loan was already in REQUESTED state, or for sandwich attempts where
            // attackers supplied after loan start.
            // [H-1 FIX 2026-07] repayLoan already added the full lenderInterest to
            // pool.availableLiquidity. Routing it to fees WITHOUT this decrement
            // would double-count it (withdrawFees moves USDC out but never touches
            // availableLiquidity) — the §S1 phantom-liquidity drift. Remove it from
            // availableLiquidity as it leaves for fees.
            agentPools[agentId].availableLiquidity -= totalInterest;
            accumulatedFees += totalInterest;
            emit InterestDistributed(agentId, totalInterest);
            return;
        }

        // Second pass: distribute to qualified lenders proportionally
        uint256 distributed = 0;
        for (uint256 i = 0; i < n; i++) {
            if (q[i] == 0) continue;
            uint256 share = (totalInterest * q[i]) / qualifiedTotal;
            positions[agentId][lenders[i]].earnedInterest += share;
            distributed += share;
        }

        // [H-01 FIX preserved] Rounding dust → platform fees rather than trapped.
        // [H-1 FIX 2026-07] Also decrement availableLiquidity by the dust: it was
        // added to availableLiquidity in repayLoan as part of lenderInterest but
        // is never distributed as a lender's earnedInterest, so leaving it in
        // availableLiquidity while also crediting accumulatedFees double-counts it
        // (phantom liquidity). Mirror the §S1 discipline.
        uint256 dust = totalInterest - distributed;
        if (dust > 0) {
            agentPools[agentId].availableLiquidity -= dust;
            accumulatedFees += dust;
        }

        emit InterestDistributed(agentId, totalInterest);
    }

    /**
     * @notice Liquidate a defaulted loan
     */
    function liquidateLoan(uint256 loanId) external onlyOwner nonReentrant whenNotPaused {
        Loan storage loan = loans[loanId];
        require(loan.state == LoanState.ACTIVE, "Loan not active");
        require(block.timestamp > loan.endTime, "Loan not overdue");

        AgentPool storage pool = agentPools[loan.agentId];

        // [H-02 FIX] Correctly account for principal loss when collateral < loan amount
        uint256 recovered = loan.collateralAmount;
        uint256 loss = loan.amount > recovered ? loan.amount - recovered : 0;

        // Seize collateral (what we actually recover)
        pool.availableLiquidity += recovered;

        // [audit 2026-08 D4] Socialize the unrecovered loss PRO-RATA across all
        // current lenders by reducing each position.amount by its share. This
        // restores the invariant `Σ position.amount == availableLiquidity +
        // totalLoaned`, so first-come-first-served withdrawal can no longer let an
        // alert/colluding lender exit whole and dump the shortfall on the last
        // lender — every lender bears the loss in proportion to their stake,
        // regardless of withdrawal order. Bounded by MAX_LENDERS_PER_POOL (50).
        if (loss > 0) {
            // [M2-b] FIRST-LOSS WATERFALL. The pool creator's own position absorbs the
            // loss before any other lender is touched. M2-a guarantees it is still
            // there (it could not be withdrawn while principal was outstanding), so
            // the attacker's own capital is genuinely subordinated rather than pari
            // passu with the lenders it is about to hurt.
            address selfLender = pool.agentAddress;
            uint256 selfAbsorbed = _takeFrom(loan.agentId, selfLender, loss);
            if (selfAbsorbed > 0) emit SelfStakeAbsorbedLoss(loan.agentId, selfLender, selfAbsorbed);

            // [L7] Whatever the self-stake could not cover is socialized across the
            // OTHER lenders, charged first to the principal that was qualified for
            // THIS loan at its startTime, then to the rest.
            uint256 reduced = selfAbsorbed;
            if (loss > selfAbsorbed) {
                reduced += _socializeLoss(loan.agentId, loss - selfAbsorbed, loan.startTime, selfLender);
            }
            // Keep totalLiquidity == Σ position.amount. reduced == min(loss, Σ principal).
            pool.totalLiquidity = reduced >= pool.totalLiquidity ? 0 : pool.totalLiquidity - reduced;
            // [F-05 fix 2026-09] Whatever principal could not absorb came out of
            // lendable UNCLAIMED INTEREST (the only other backing of availableLiquidity),
            // so socialize the excess across earnedInterest too. Keeps
            // availableLiquidity + totalLoaned == Σ amount + Σ earnedInterest exact,
            // and therefore every remaining claim backed.
            if (loss > reduced) {
                uint256 interestReduced = _socializeInterestLoss(loan.agentId, loss - reduced);
                if (interestReduced > 0) emit InterestLossSocialized(loan.agentId, interestReduced);
            }
            _pruneEmptyLenders(loan.agentId);
        }

        // Update loaned amount
        pool.totalLoaned -= loan.amount;

        // Mark as defaulted
        loan.state = LoanState.DEFAULTED;

        // §S5 FIX: decrement counter on transition out of ACTIVE
        activeLoanCount[loan.agentId]--;
        _removeActiveLoanId(loan.agentId, loanId);

        // [H-3 fix] Defaulted principal is no longer outstanding for credit purposes.
        outstandingPrincipal[loan.agentId] -= loan.amount;

        // Record default with reputation manager — against the agent NFT's current
        // holder, i.e. keyed by loan.agentId (F-01). The registry guarantees the
        // holder resolves to this agentId, so liquidation never depends on the
        // historical borrower address still being registered.
        reputationManager.recordDefault(agentRegistry.ownerOf(loan.agentId), loanId, loan.amount);

        emit LoanDefaulted(loanId);
    }

    /**
     * @notice Calculate interest for a loan
     */
    function calculateInterest(
        uint256 principal,
        uint256 annualRateBPS,
        uint256 durationSeconds
    ) public pure returns (uint256) {
        uint256 annualInterest = (principal * annualRateBPS) / 10000;
        uint256 interest = (annualInterest * durationSeconds) / 365 days;
        return interest;
    }

    /**
     * @notice Get agent pool details
     */
    function getAgentPool(uint256 agentId) external view returns (
        address agentAddress,
        uint256 totalLiquidity,
        uint256 availableLiquidity,
        uint256 totalLoaned,
        uint256 totalEarned,
        uint256 utilizationRate,
        uint256 lenderCount
    ) {
        AgentPool memory pool = agentPools[agentId];
        uint256 utilization = pool.totalLiquidity > 0
            ? (pool.totalLoaned * 10000) / pool.totalLiquidity
            : 0;

        return (
            pool.agentAddress,
            pool.totalLiquidity,
            pool.availableLiquidity,
            pool.totalLoaned,
            pool.totalEarned,
            utilization,
            poolLenders[agentId].length
        );
    }

    /**
     * @notice Get lender position for an agent
     */
    function getLenderPosition(uint256 agentId, address lender) external view returns (
        uint256 amount,
        uint256 earnedInterest,
        uint256 depositTimestamp,
        uint256 shareOfPool
    ) {
        LenderPosition memory position = positions[agentId][lender];
        AgentPool memory pool = agentPools[agentId];

        uint256 share = pool.totalLiquidity > 0
            ? (position.amount * 10000) / pool.totalLiquidity
            : 0;

        return (
            position.amount,
            position.earnedInterest,
            position.depositTimestamp,
            share
        );
    }

    /**
     * @notice One page of the active-pool list: the agentIds with `isActive` set
     *         among `agentPoolIds[start .. start+count)`.
     * @dev [D8 fix 2026-09-22] The unbounded `getActiveAgents()` costs ~5,482 gas per
     *      pool and passes a 30M `eth_call` cap at roughly 5,472 pools. It is a view,
     *      so it cannot brick a transaction, but the dashboard and the hosted API
     *      both depend on it and would simply start failing. Off-chain callers should
     *      use THIS form and page with the returned cursor; the no-argument overload
     *      is kept only for backward compatibility and should not be used at scale.
     * @param start Index into `agentPoolIds` to scan from.
     * @param count How many `agentPoolIds` entries to SCAN (not how many actives to
     *        return — a page may return fewer than `count` if some pools are inactive).
     * @return active    The active agentIds found in this window, in `agentPoolIds` order.
     * @return nextStart Cursor for the next page; equals `totalPools()` when done.
     */
    function getActiveAgents(uint256 start, uint256 count)
        external view returns (uint256[] memory active, uint256 nextStart)
    {
        uint256 total = agentPoolIds.length;
        if (start >= total) return (new uint256[](0), total);
        uint256 end = start + count;
        if (end > total || end < start) end = total;

        uint256 n = 0;
        for (uint256 i = start; i < end; i++) {
            if (agentPools[agentPoolIds[i]].isActive) n++;
        }
        active = new uint256[](n);
        uint256 j = 0;
        for (uint256 i = start; i < end; i++) {
            uint256 aid = agentPoolIds[i];
            if (agentPools[aid].isActive) active[j++] = aid;
        }
        nextStart = end;
    }

    /**
     * @notice Get the agentIds of all pools whose isActive flag is set.
     * @dev [audit 2026-08 D12] Implemented against the tracked `agentPoolIds`
     *      instead of the old reverting stub.
     *      [D8 2026-09-22] UNBOUNDED — ~5,482 gas per pool, past a 30M `eth_call`
     *      cap at ≈ 5,472 pools. Retained for backward compatibility only; new
     *      callers must use `getActiveAgents(start, count)` above.
     */
    function getActiveAgents() external view returns (uint256[] memory) {
        uint256 total = agentPoolIds.length;
        uint256 count = 0;
        for (uint256 i = 0; i < total; i++) {
            if (agentPools[agentPoolIds[i]].isActive) count++;
        }
        uint256[] memory active = new uint256[](count);
        uint256 j = 0;
        for (uint256 i = 0; i < total; i++) {
            uint256 aid = agentPoolIds[i];
            if (agentPools[aid].isActive) active[j++] = aid;
        }
        return active;
    }

    /**
     * @notice Claim accrued interest as a lender of `agentId`'s pool.
     * @dev §S1-fix: `pool.availableLiquidity` is decremented by `interest` so that
     *      the contract's accounting matches the USDC custody movement. v4 omitted
     *      this decrement and accumulated phantom availableLiquidity over time.
     *      Reverts if there is no interest to claim. The `Drain underflow` require
     *      should never trip under correct state but is a defense in depth.
     *      Emits `InterestClaimed(agentId, msg.sender, amount)`.
     * @param agentId The pool to claim from.
     */
    function claimInterest(uint256 agentId) external nonReentrant whenNotPaused {
        LenderPosition storage position = positions[agentId][msg.sender];
        AgentPool storage pool = agentPools[agentId];
        uint256 interest = position.earnedInterest;

        require(interest > 0, "No interest to claim");
        // CLAUDE_AUDIT_WORLDCLASS W3: validate before writing state. Even though EVM atomicity
        // makes the prior ordering safe, validate-before-write is the clearer convention.
        require(pool.availableLiquidity >= interest, "Drain underflow");

        position.earnedInterest = 0;

        // §S1 FIX: decrement pool.availableLiquidity to match the USDC leaving the contract.
        // Without this, claimed interest is double-counted as both "withdrawn USDC" and "still
        // available", producing the phantom liquidity drift documented in the audit.
        pool.availableLiquidity -= interest;

        // [audit 2026-08] If this lender has now fully exited (no principal, and
        // interest just zeroed), free their poolLenders slot — the counterpart to
        // the withdraw-side removal, so a lender who withdrew principal before
        // claiming interest doesn't leave a permanent dust slot.
        if (position.amount == 0) {
            _removePoolLender(agentId, msg.sender);
        }

        usdcToken.safeTransfer(msg.sender, interest);
        emit InterestClaimed(agentId, msg.sender, interest);
    }

    /**
     * @notice Owner withdraws platform fees
     */
    function withdrawFees(uint256 amount) external onlyOwner nonReentrant {
        require(amount <= accumulatedFees, "Insufficient fees");
        accumulatedFees -= amount;
        usdcToken.safeTransfer(owner(), amount);
        emit FeesWithdrawn(owner(), amount);
    }

    /**
     * @notice Emergency pause
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    // ===================================================================================
    // Migration helpers (owner-only, locked once `setMigrationFinalized()` is called).
    // Used to seed state from a v4 snapshot. After finalization, normal operation only.
    // ===================================================================================

    modifier whileMigrating() {
        require(!migrationFinalized, "Migration finalized");
        _;
    }

    /**
     * @notice Seed an agent pool from a v4 snapshot during migration.
     * @dev Owner-only; reverts after `setMigrationFinalized()`. Overwrites existing
     *      pool state for the given agentId (intentional — migration may need to
     *      reset). Sets `totalLoaned = 0` because active loans are not migrated
     *      (they remain on v4 to be repaid or liquidated there). Adds agentId to
     *      `agentPoolIds` array on first seed only. Emits `PoolCreated` (if new)
     *      and always `PoolSeeded`.
     * @param agentId            Agent's ID from AgentRegistryV2.
     * @param agentAddress       Wallet associated with the agent (matches v4 pool).
     * @param totalLiquidity     v4 snapshot total (USDC base units).
     * @param availableLiquidity v4 snapshot available (USDC base units).
     * @param totalEarned        v4 snapshot lifetime interest earned.
     */
    function seedPool(
        uint256 agentId,
        address agentAddress,
        uint256 totalLiquidity,
        uint256 availableLiquidity,
        uint256 totalEarned
    ) external onlyOwner whileMigrating {
        require(agentId != 0, "Invalid agentId");
        require(agentAddress != address(0), "Invalid agentAddress");
        // CLAUDE_REVIEW Finding 1: validate agentAddress matches registry mapping
        require(
            agentRegistry.addressToAgentId(agentAddress) == agentId,
            "agentAddress/agentId mismatch"
        );
        AgentPool storage pool = agentPools[agentId];
        bool isNew = (pool.agentId == 0);

        pool.agentId = agentId;
        pool.agentAddress = agentAddress;
        pool.totalLiquidity = totalLiquidity;
        pool.availableLiquidity = availableLiquidity;
        pool.totalLoaned = 0; // active loans not migrated; assume freshly loaned out is 0
        pool.totalEarned = totalEarned;
        pool.isActive = true;

        if (isNew) {
            agentPoolIds.push(agentId);
            emit PoolCreated(agentId, agentAddress);
        }
        emit PoolSeeded(agentId, agentAddress);
    }

    /**
     * @notice Seed a lender's position from a v4 snapshot during migration.
     * @dev Owner-only; reverts after `setMigrationFinalized()`. Overwrites position.
     *      §B1-fix-aware: uses `isInPoolLenders` flag to push to `poolLenders[]`
     *      AT MOST ONCE per lender per pool — operator error cannot create
     *      duplicates. Requires the pool to have been `seedPool`-ed first.
     * @param agentId          Pool agentId.
     * @param lender           Lender address.
     * @param amount           v4 snapshot supplied amount.
     * @param earnedInterest   v4 snapshot unclaimed interest.
     * @param depositTimestamp v4 snapshot deposit timestamp (preserve for analytics).
     */
    function seedPosition(
        uint256 agentId,
        address lender,
        uint256 amount,
        uint256 earnedInterest,
        uint256 depositTimestamp
    ) external onlyOwner whileMigrating {
        require(lender != address(0), "Invalid lender");
        require(agentPools[agentId].agentId == agentId, "Pool not seeded");

        positions[agentId][lender] = LenderPosition({
            amount: amount,
            earnedInterest: earnedInterest,
            depositTimestamp: depositTimestamp
        });
        delete pendingTranche[agentId][lender]; // [F-02] seeded positions are a single base tranche

        // [D2 fix] Same slot discipline as supplyLiquidity, including the creator
        // reservation — operator error during migration must not be able to brick
        // the agent's M2-c self-stake either.
        _claimLenderSlot(agentId, lender);

        // CLAUDE_REVIEW Finding 2: enforce Σ positions ≤ pool.totalLiquidity.
        // Bounded by MAX_LENDERS_PER_POOL = 50 → ≤ 50 SLOAD ops per call. Acceptable.
        // Without this, operator could seed positions summing more than totalLiquidity,
        // breaking _distributeInterest's share formula (denominator-too-small → overflow).
        address[] storage lendersList = poolLenders[agentId];
        uint256 sumPositions = 0;
        for (uint256 i = 0; i < lendersList.length; i++) {
            sumPositions += positions[agentId][lendersList[i]].amount;
        }
        require(
            sumPositions <= agentPools[agentId].totalLiquidity,
            "Position sum exceeds totalLiquidity"
        );

        emit PositionSeeded(agentId, lender, amount, earnedInterest);
    }

    /**
     * @notice Dedup the `poolLenders[agentId]` array in place. NOT gated by
     *         migration phase — admin can run this post-finalization as a sanity
     *         tool. Removes any duplicate addresses while preserving the first
     *         occurrence. Caps at `MAX_LENDERS_PER_POOL` iterations, so gas is
     *         bounded. Emits `PoolLendersCompacted(agentId, removed)`.
     * @dev Algorithm: reset all `isInPoolLenders` flags, then walk the list and
     *      re-mark each first-seen address. Pop tail entries. O(N) in pool size.
     * @param agentId Pool to compact.
     */
    function compactPoolLenders(uint256 agentId) external onlyOwner {
        address[] storage list = poolLenders[agentId];
        // Reset flags
        for (uint256 i = 0; i < list.length; i++) {
            isInPoolLenders[agentId][list[i]] = false;
        }
        // Rebuild deduped list in-place
        uint256 writeIdx = 0;
        for (uint256 i = 0; i < list.length; i++) {
            address lender = list[i];
            if (!isInPoolLenders[agentId][lender]) {
                isInPoolLenders[agentId][lender] = true;
                list[writeIdx] = lender;
                writeIdx++;
            }
        }
        uint256 removed = list.length - writeIdx;
        while (list.length > writeIdx) list.pop();
        emit PoolLendersCompacted(agentId, removed);
    }

    /**
     * @notice Mark migration as complete. After this is called, `seedPool`,
     *         `seedPosition`, and `setMigrationFinalized` itself all revert with
     *         "Migration finalized". This is intentionally IRREVERSIBLE — recovery
     *         from an incorrect finalization requires deploying a new contract.
     *         `compactPoolLenders` remains available post-finalization for sanity.
     * @dev Owner-only. Emits `MigrationFinalized()`.
     */
    function setMigrationFinalized() external onlyOwner whileMigrating {
        migrationFinalized = true;
        emit MigrationFinalized();
    }

    /**
     * @notice Update platform fee rate
     */
    function setPlatformFeeRate(uint256 newRate) external onlyOwner {
        require(newRate <= 500, "Fee too high"); // Max 5%
        uint256 oldRate = platformFeeRate;
        platformFeeRate = newRate;
        emit PlatformFeeRateChanged(oldRate, newRate);
    }

    /**
     * @notice [M-2 lever] Set the minimum loan hold time (seconds) required for
     *         an on-time repayment to earn reputation. 0 disables the gate.
     * @dev [audit 2026-08] Capped at MIN_LOAN_DURATION (7d), not MAX. A minHold
     *      above the shortest allowed loan term would silently deny reputation to
     *      every loan repaid at its (shorter) term — a foot-gun. Bounding it to
     *      MIN_LOAN_DURATION guarantees any loan held to term always qualifies.
     */
    function setMinHoldForReputationReward(uint256 newMinHold) external onlyOwner {
        require(newMinHold <= MIN_LOAN_DURATION, "Min hold exceeds min loan duration");
        uint256 old = minHoldForReputationReward;
        minHoldForReputationReward = newMinHold;
        emit MinHoldForReputationRewardChanged(old, newMinHold);
    }

    /**
     * @notice [M-1 lever] Toggle whether borrowing is restricted to a pool's
     *         original creator address (blocks a transferred agent NFT from
     *         borrowing against existing lenders' liquidity).
     */
    function setBindBorrowToPoolCreator(bool enabled) external onlyOwner {
        bindBorrowToPoolCreator = enabled;
        emit BindBorrowToPoolCreatorChanged(enabled);
    }

    /**
     * @notice [F-C lever] Set the minimum amount required to OPEN a new lender
     *         slot in a pool (existing lenders may top up by any amount). Raises
     *         the capital an attacker must lock to squat the MAX_LENDERS_PER_POOL
     *         cap. 0 disables. Capped so it can't lock out ordinary lenders.
     */
    function setMinSupplyAmount(uint256 newMin) external onlyOwner {
        require(newMin <= 100 * 1e6, "Min supply too high (>100 USDC)");
        uint256 old = minSupplyAmount;
        minSupplyAmount = newMin;
        emit MinSupplyAmountChanged(old, newMin);
    }

    /**
     * @notice Emergency function to recalculate and fix pool accounting
     * @dev Recalculates totalLoaned by summing the agent's ACTIVE loans.
     *      Recalculates availableLiquidity from totalLiquidity + Σ unclaimed
     *      interest − totalLoaned. CLAUDE_AUDIT_DEEP fixes #1 + #2 applied.
     *
     *      [D7 fix 2026-09-22] `totalLoaned` is rebuilt from `activeLoanIds[agentId]`
     *      (≤ MAX_ACTIVE_LOANS_PER_AGENT = 10 entries, maintained at disburse/close
     *      and already the authority everywhere else) instead of walking the
     *      append-only, never-pruned `agentLoans[pool.agentAddress]`. The old walk
     *      cost ~4,625 gas per historical loan: it lost 3× block headroom at ≈ 2,140
     *      lifetime loans and became UNCALLABLE at ≈ 6,473 — the §S5 failure shape
     *      surviving inside the owner's emergency repair tool, on exactly the
     *      high-activity agent most likely to need it. Now O(1) in loan history.
     *
     *      Two consequences of keying by agentId:
     *        * the old "Agent transferred; resync via migration helpers" guard is
     *          GONE. It existed only because `agentLoans` is ADDRESS-keyed, so a
     *          transferred NFT split the history across two addresses and the walk
     *          would undercount. `activeLoanIds` is agentId-keyed and follows the
     *          agent, so the tool now works on a transferred agent too — which is
     *          precisely when an operator is most likely to need it.
     *        * the rebuilt figure counts exactly the loans the contract itself
     *          treats as outstanding, so it can no longer disagree with
     *          `activeLoanCount` / `outstandingPrincipal`.
     * @param agentId The agent ID whose pool to fix
     */
    function resetPoolAccounting(uint256 agentId) external onlyOwner {
        AgentPool storage pool = agentPools[agentId];
        require(pool.agentId == agentId, "Pool does not exist");

        // Recalculate totalLoaned from the bounded active set (≤ 10 entries).
        uint256 actualLoaned = 0;
        uint256[] storage activeIds = activeLoanIds[agentId];
        for (uint256 i = 0; i < activeIds.length; i++) {
            Loan storage loan = loans[activeIds[i]];
            if (loan.state == LoanState.ACTIVE) {
                actualLoaned += loan.amount;
            }
        }

        // CLAUDE_AUDIT_DEEP Finding 2: use Σ position.earnedInterest (unclaimed)
        // instead of pool.totalEarned (lifetime). totalEarned never decrements on
        // claimInterest, so the prior formula double-counted already-claimed
        // interest. Bounded loop: MAX_LENDERS_PER_POOL = 50.
        // [audit 2026-08 A1 follow-up] Rebuild totalLiquidity from Σ position.amount
        // (ground truth) in the SAME loop, instead of trusting the possibly-drifted
        // pool.totalLiquidity. Deriving availableLiquidity from the drifted value
        // could silently understate it and strand withdrawable USDC — the exact
        // failure mode of the emergency tool an operator reaches for on an
        // underwater pool. Positions are the authoritative principal record.
        uint256 unclaimedInterest = 0;
        uint256 actualPrincipal = 0;
        address[] storage lenders = poolLenders[agentId];
        for (uint256 i = 0; i < lenders.length; i++) {
            LenderPosition storage p = positions[agentId][lenders[i]];
            unclaimedInterest += p.earnedInterest;
            actualPrincipal += p.amount;
        }

        // Update pool state from ground truth. Saturate defensively (should not
        // trigger now that principal is rebuilt from positions, but keeps the tool
        // from ever reverting on a pathological pool).
        uint256 oldLoaned = pool.totalLoaned;
        pool.totalLoaned = actualLoaned;
        pool.totalLiquidity = actualPrincipal;
        uint256 backing = actualPrincipal + unclaimedInterest;
        pool.availableLiquidity = actualLoaned >= backing ? 0 : backing - actualLoaned;

        emit PoolAccountingReset(agentId, oldLoaned, actualLoaned, pool.availableLiquidity);
    }

    /**
     * @notice Count active loans for an agent
     * @dev §S5 FIX: O(1) lookup via activeLoanCount counter, replaces array walk.
     *      The counter is maintained at requestLoan (++), repayLoan (--), liquidateLoan (--).
     *      [D2] Keyed by agentId.
     */
    function _countActiveLoans(uint256 agentId) internal view returns (uint256) {
        return activeLoanCount[agentId];
    }

    /**
     * @notice Legacy O(N) implementation, retained for verifying counter integrity in tests.
     */
    function _countActiveLoansFromArray(address agent) internal view returns (uint256) {
        uint256[] memory loanIds = agentLoans[agent];
        uint256 activeCount = 0;

        for (uint256 i = 0; i < loanIds.length; i++) {
            if (loans[loanIds[i]].state == LoanState.ACTIVE) {
                activeCount++;
            }
        }

        return activeCount;
    }

    // Events
    event PoolAccountingReset(
        uint256 indexed agentId,
        uint256 oldTotalLoaned,
        uint256 newTotalLoaned,
        uint256 newAvailableLiquidity
    );

    // CLAUDE_AUDIT_WORLDCLASS W2: emit on platform fee changes for off-chain monitoring
    event PlatformFeeRateChanged(uint256 oldRate, uint256 newRate);
    event MinHoldForReputationRewardChanged(uint256 oldValue, uint256 newValue);
    event BindBorrowToPoolCreatorChanged(bool enabled);
    event MinSupplyAmountChanged(uint256 oldValue, uint256 newValue);
}
