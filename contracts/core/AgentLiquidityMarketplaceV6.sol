// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./AgentRegistryV2.sol";
import "./ReputationManagerV3.sol";

/**
 * @title AgentLiquidityMarketplaceV6
 * @notice P2P lending marketplace — v6 with §B1, §S1, §S5 fixes + migration helpers.
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
 * NOT independently audited. Do not deploy to Base mainnet without external review.
 */
contract AgentLiquidityMarketplaceV6 is Ownable2Step, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    // State variables (set in constructor, immutable for gas savings — slither finding)
    AgentRegistryV2 public immutable agentRegistry;
    ReputationManagerV3 public immutable reputationManager;
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
        uint256 amount;              // USDC supplied to agent
        uint256 earnedInterest;      // Interest earned so far
        uint256 depositTimestamp;    // When they deposited
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

    // Constants
    uint256 public constant MAX_INTEREST_RATE = 2000; // 20% max
    uint256 public constant MIN_LOAN_DURATION = 7 days;
    uint256 public constant MAX_LOAN_DURATION = 365 days;
    // [H-04 mitigation] Cap lenders per pool to bound _distributeInterest gas cost
    uint256 public constant MAX_LENDERS_PER_POOL = 50;
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

    constructor(
        address _agentRegistry,
        address _reputationManager,
        address _usdcToken
    ) Ownable(msg.sender) {
        agentRegistry = AgentRegistryV2(_agentRegistry);
        reputationManager = ReputationManagerV3(_reputationManager);
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
        if (minSupplyAmount > 0 && !isInPoolLenders[agentId][msg.sender]) {
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
        if (!isInPoolLenders[agentId][msg.sender]) {
            require(
                poolLenders[agentId].length < MAX_LENDERS_PER_POOL,
                "Pool lender capacity reached"
            );
            poolLenders[agentId].push(msg.sender);
            isInPoolLenders[agentId][msg.sender] = true;
        }
        // CLAUDE_AUDIT_WORLDCLASS W1 mitigation: depositTimestamp updated on EVERY supply
        // (not just first). _distributeInterest uses this to qualify lenders against a
        // specific loan's startTime — only lenders whose deposits predate the loan share
        // its interest. Blocks the mempool-sandwich attack pattern where an attacker
        // front-runs repayLoan to capture interest they didn't earn.
        // Side effect: also addresses CLAUDE_AUDIT_DEEP F12 (depositTimestamp staleness).
        position.depositTimestamp = block.timestamp;
        position.amount += amount;

        emit LiquiditySupplied(agentId, msg.sender, amount);
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
        require(pool.availableLiquidity >= amount, "Insufficient pool liquidity");

        // Update position
        position.amount -= amount;

        // Update pool.
        // [audit 2026-08] totalLiquidity is a principal-accounting figure that can
        // legitimately drift BELOW Σ position.amount after a lossy liquidation
        // (which reduces totalLiquidity by the loss but leaves positions intact)
        // or when interest paid into availableLiquidity is withdrawn as principal.
        // A plain `-=` then underflow-reverts (solc 0.8.20 checked math), bricking
        // withdrawals of liquidity that demonstrably exists in availableLiquidity.
        // Saturate. availableLiquidity is the solvency-critical figure and is
        // guarded by the require above, so it uses a plain subtraction.
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

    /**
     * @notice Agent requests a loan from their dedicated pool
     */
    function requestLoan(uint256 amount, uint256 durationDays) external nonReentrant whenNotPaused returns (uint256) {
        // CLAUDE_REVIEW Finding 3: reject zero-amount loans (prevents self-griefing fill of MAX_ACTIVE_LOANS)
        require(amount > 0, "Amount must be > 0");
        uint256 agentId = agentRegistry.addressToAgentId(msg.sender);
        require(agentId != 0, "Not a registered agent");
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

        // [H-3 fix] Track aggregate outstanding principal for the credit check.
        outstandingPrincipal[loan.agentId] += loan.amount;

        // Transfer funds to borrower
        usdcToken.safeTransfer(loan.borrower, loan.amount);

        // Record with reputation manager
        reputationManager.recordBorrow(loan.borrower, loan.amount);

        emit LoanDisbursed(loanId, loan.amount);
    }

    /**
     * @notice Repay a loan
     */
    function repayLoan(uint256 loanId) external nonReentrant whenNotPaused {
        Loan storage loan = loans[loanId];
        require(msg.sender == loan.borrower, "Not the borrower");
        require(loan.state == LoanState.ACTIVE, "Loan not active");

        // Calculate interest
        uint256 interest = calculateInterest(
            loan.amount,
            loan.interestRate,
            loan.duration
        );

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

        // [H-3 fix] Principal repaid — free the borrower's aggregate exposure.
        outstandingPrincipal[loan.agentId] -= loan.amount;

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

        // INTERACTIONS: return collateral last
        if (loan.collateralAmount > 0) {
            usdcToken.safeTransfer(loan.borrower, loan.collateralAmount);
        }

        // Record with reputation manager.
        // [M-2 lever] Only reward reputation if the loan was held long enough —
        // blunts request→repay farming. recordLoanCompletion applies NO penalty
        // when the flag is false, so a too-fast on-time repay simply earns no
        // bonus (neither reward nor penalty).
        // [D1] Also require the loan to have paid non-zero interest — a
        // zero-interest (sub-rounding) dust loan earns no reputation. Combined
        // with the principal-scaled bonus in the reputation manager, this makes
        // reputation reflect real economic activity, not free loop count.
        bool onTime = block.timestamp <= loan.endTime;
        bool heldLongEnough = minHoldForReputationReward == 0
            || (block.timestamp - loan.startTime) >= minHoldForReputationReward;
        bool paidInterest = interest > 0;
        reputationManager.recordLoanCompletion(loan.borrower, loan.amount, onTime && heldLongEnough && paidInterest);

        emit LoanRepaid(loanId, loan.amount, interest);
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

        // First pass: compute qualified-total (lenders supplied at or before loanStartTime)
        uint256 qualifiedTotal = 0;
        for (uint256 i = 0; i < lenders.length; i++) {
            LenderPosition storage p = positions[agentId][lenders[i]];
            if (p.amount > 0 && p.depositTimestamp <= loanStartTime) {
                qualifiedTotal += p.amount;
            }
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
        for (uint256 i = 0; i < lenders.length; i++) {
            LenderPosition storage p = positions[agentId][lenders[i]];
            if (p.amount > 0 && p.depositTimestamp <= loanStartTime) {
                uint256 share = (totalInterest * p.amount) / qualifiedTotal;
                p.earnedInterest += share;
                distributed += share;
            }
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

        // Reduce totalLiquidity by the unrecovered loss so it reflects real pool
        // value. [audit 2026-08] Saturate — the loss can exceed the (already
        // drifted) totalLiquidity, and a plain `-=` would underflow-revert and
        // brick liquidation permanently (loan stuck ACTIVE, default penalty
        // evaded). totalLiquidity is not solvency-critical (availableLiquidity is).
        if (loss > 0) {
            pool.totalLiquidity = loss >= pool.totalLiquidity ? 0 : pool.totalLiquidity - loss;
        }

        // Update loaned amount
        pool.totalLoaned -= loan.amount;

        // Mark as defaulted
        loan.state = LoanState.DEFAULTED;

        // §S5 FIX: decrement counter on transition out of ACTIVE
        activeLoanCount[loan.agentId]--;

        // [H-3 fix] Defaulted principal is no longer outstanding for credit purposes.
        outstandingPrincipal[loan.agentId] -= loan.amount;

        // Record default with reputation manager
        reputationManager.recordDefault(loan.borrower, loan.amount);

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
     * @notice Get the agentIds of all pools whose isActive flag is set.
     * @dev [audit 2026-08 D12] Implemented against the tracked `agentPoolIds`
     *      instead of the old reverting stub. View-only; unbounded in principle
     *      but only ever iterated off-chain, so gas is not a concern.
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

        if (!isInPoolLenders[agentId][lender]) {
            require(poolLenders[agentId].length < MAX_LENDERS_PER_POOL, "Lender cap");
            poolLenders[agentId].push(lender);
            isInPoolLenders[agentId][lender] = true;
        }

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
     * @dev Recalculates totalLoaned by summing active loans for agent.
     *      Recalculates availableLiquidity from totalLiquidity + Σ unclaimed
     *      interest − totalLoaned. CLAUDE_AUDIT_DEEP fixes #1 + #2 applied.
     * @param agentId The agent ID whose pool to fix
     */
    function resetPoolAccounting(uint256 agentId) external onlyOwner {
        AgentPool storage pool = agentPools[agentId];
        require(pool.agentId == agentId, "Pool does not exist");

        // CLAUDE_AUDIT_DEEP Finding 1: detect NFT transfer that would invalidate
        // agentLoans[pool.agentAddress] lookup. After an agent NFT is transferred,
        // new loans go to agentLoans[NEW_owner] but pool.agentAddress is still the
        // OLD owner — walking only one would undercount totalLoaned. Force admin to
        // use seedPool/seedPosition (migration helpers) for transferred agents.
        require(
            agentRegistry.ownerOf(agentId) == pool.agentAddress,
            "Agent transferred; resync via migration helpers"
        );

        // Recalculate totalLoaned from active loans
        uint256 actualLoaned = 0;
        uint256[] memory loanIds = agentLoans[pool.agentAddress];
        for (uint256 i = 0; i < loanIds.length; i++) {
            Loan storage loan = loans[loanIds[i]];
            if (loan.state == LoanState.ACTIVE) {
                actualLoaned += loan.amount;
            }
        }

        // CLAUDE_AUDIT_DEEP Finding 2: use Σ position.earnedInterest (unclaimed)
        // instead of pool.totalEarned (lifetime). totalEarned never decrements on
        // claimInterest, so the prior formula double-counted already-claimed
        // interest. Bounded loop: MAX_LENDERS_PER_POOL = 50.
        uint256 unclaimedInterest = 0;
        address[] storage lenders = poolLenders[agentId];
        for (uint256 i = 0; i < lenders.length; i++) {
            unclaimedInterest += positions[agentId][lenders[i]].earnedInterest;
        }

        // Update pool state.
        // [audit 2026-08] Saturate: if actualLoaned exceeds totalLiquidity +
        // unclaimedInterest (possible once totalLiquidity has drifted below the
        // loaned principal), a plain subtraction underflow-reverts — bricking the
        // very emergency tool an operator would reach for on an underwater pool.
        uint256 oldLoaned = pool.totalLoaned;
        pool.totalLoaned = actualLoaned;
        uint256 backing = pool.totalLiquidity + unclaimedInterest;
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
