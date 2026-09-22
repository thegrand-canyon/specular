// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable2Step.sol";
import "./AgentRegistryV2.sol";
import "./ValidationRegistry.sol";

/**
 * @title ReputationManagerV4
 * @notice The Specular V7 credit model — the fix for audit finding F-04 (HIGH, design).
 *
 * F-04 (see forensics/output/audit-2026-09/INTERNAL_AUDIT_2026-09-19.md and the
 * quantitative follow-up forensics/output/testing-2026-09-20/ECONOMIC_ATTACK_SIMULATION.md)
 * is that V3 prices reputation in *interest paid*, which a self-lending agent
 * recaptures in full. The simulation proved that across all 40 feasible owner-lever
 * configurations the attacker's cost was exactly `platformFeeRate / 10000` of an
 * honest agent's cost for the same reputation — capped by the marketplace at 5 %.
 * Levers cannot fix it; the model has to change.
 *
 * ============================ M1 — what changed ============================
 *
 * (1) PRINCIPAL-TIME BONUS.
 *        bonus = onTimeBonus · min(amt, refAmount)/refAmount · min(held, refDuration)/refDuration
 *     V3 scaled by principal only, so the cheapest attacker cycle was a 7-day loan
 *     repaid after one day (the full nominal interest was charged either way, so
 *     holding longer cost capital and bought nothing). Hold time now buys the
 *     bonus, so the attacker must tie up 7× the capital for the same points.
 *     `held` is derived from the `recordBorrow` timestamp of the SAME loanId.
 *
 * (2) EXPOSURE BOUNDED BY DEMONSTRATED REPAID VOLUME (the "credit ladder").
 *        creditLimit = min(tierLimit(score),
 *                          max(bootstrapLimit, creditMultiple · maxRepaidPrincipal + growthStep))
 *     An agent may only borrow a bounded step beyond the largest single loan it has
 *     already repaid on time. NOTE the additive `growthStep`: the simulation found
 *     that `creditMultiple == 1` with no additive term DEADLOCKS — head-room can
 *     never exceed the record, so the ladder cannot climb and every agent stalls at
 *     `bootstrapLimit` forever. `growthStep > 0` is therefore enforced in the setter
 *     and the ladder is proven to climb by `test/v7/M1CreditLadder.test.js`.
 *
 * (3) SIZE-PROPORTIONAL DEFAULT PENALTY + CAPACITY RESET + LOCKOUT.
 *     V3 charged a flat `defaultPenaltyLarge` for ANY default over the threshold,
 *     so a 25,000 bust-out cost the same as a 10,001 one and was re-farmed in
 *     20 days at the live levers. Here:
 *        penalty        = max(defaultPenaltyBase, defaultPenaltyLarge · amount / largeLoanThreshold)
 *        maxRepaidPrincipal → 0   (capacity must be re-demonstrated from scratch)
 *        creditLimit        → 0   for `defaultLockout` (default 180 days)
 *
 * (4) TIER-TABLE CAP, OWNER-SETTABLE, WITH A HARD CEILING.
 *     Report §8.3 item 3: "a tier-table cap is worth more than every lever in §7
 *     combined, because it bounds the prize instead of pricing the path". The top
 *     tiers drop 25,000 → 2,500 and 50,000 → 5,000. The limits are owner-settable
 *     this time (they were hardcoded in V3, which is the only reason fixing them
 *     needs a redeploy at all) but every entry is bounded by the immutable
 *     `MAX_TIER_LIMIT` so a compromised owner key cannot re-open the exposure.
 *     The 500–599 collateral requirement moves 25 % → 75 % so that the *unsecured*
 *     exposure of that tier (10,000 × 25 % = 2,500) does not exceed the capped
 *     600 tier — otherwise the cap would simply be routed around one tier lower.
 *
 * (5) LATE-REPAYMENT REPUTATION PENALTY.
 *     V6.1 fixed the *economics* of lateness (interest on max(duration, elapsed))
 *     but deferred the reputation penalty because V3 exposed no hook — the only
 *     sanction was losing the bonus. `recordLoanCompletion` now takes `lateSeconds`
 *     and applies `latePenaltyBase + latePenaltyPerDay · fullDaysLate`, capped at
 *     `latePenaltyMax`. A late loan also does NOT advance the credit ladder.
 *
 * ========================= Companion marketplace (M2) =========================
 * `AgentLiquidityMarketplaceV6` at VERSION "V6.2" implements M2: the borrower's own
 * lender position in its own pool is locked while it has outstanding principal, is
 * first-loss on default, and must cover `unsecured exposure / creditMultiple` before
 * a low-collateral loan is granted. V6.2 also passes `loanId` into every call here.
 *
 * ============================== RESIDUAL RISK ==============================
 * This does NOT make the bust-out EV-negative. At the shipped parameters an attacker
 * that climbs the ladder to the 800 tier can still draw `tierLimit` and walk, losing
 * only its own self-stake (`tierLimit / creditMultiple`) and 180 days of capacity.
 * The report's conclusion stands: an unsecured line to a pseudonymous agent can only
 * be made EV-negative by backing it with something seizable. `creditMultiple` PRICES
 * that residual; it does not remove it. See V7_DESIGN_AND_VALIDATION.md §6.
 *
 * NOT independently audited. Fresh deploy — this contract is NOT upgradeable and has
 * NO storage-layout relationship to ReputationManagerV3.
 */
contract ReputationManagerV4 is Ownable2Step {
    /// @notice Source version. Consumed by the SDK/MCP capability probe.
    string public constant VERSION = "V4";

    AgentRegistryV2 public immutable agentRegistry;
    ValidationRegistry public validationRegistry; // Optional ERC-8004 integration

    // ------------------------------------------------------------------ access

    mapping(address => bool) public authorizedPools;

    // ------------------------------------------------------------- reputation

    mapping(uint256 => uint256) private agentReputation; // agentId => score (0-1000)
    mapping(uint256 => bool) public initialized;         // agentId => has been initialized

    uint256 public constant MAX_SCORE = 1000;
    uint256 public constant INITIAL_SCORE = 100;

    // [D1 residual, carried from V3] Reputation-gain rate limit.
    uint256 public maxReputationGainPerWindow; // points; 0 = unlimited
    uint256 public reputationGainWindow = 1 days;
    mapping(uint256 => uint256) public windowStart;
    mapping(uint256 => uint256) public gainedInWindow;

    // ----------------------------------------------------------- loan history

    mapping(uint256 => uint256) public totalBorrowed;
    mapping(uint256 => uint256) public totalRepaid;
    mapping(uint256 => uint256) public loanCount;
    mapping(uint256 => uint256) public defaultCount;
    mapping(uint256 => uint256) public lateCount;       // [M1-5] on-time-but-late repayments

    // ----------------------------------------------------- scoring parameters

    uint256 public onTimeRepaymentBonus = 10;
    uint256 public defaultPenaltyBase = 50;
    uint256 public defaultPenaltyLarge = 100;
    // [M1-3] Divisor of the size-proportional default penalty. V7 lowers it 10,000 →
    // 1,000 USDC (report §7 "Recommended lever set"): with the tier cap at 5,000, a
    // 10,000 threshold would make EVERY reachable default land on the
    // `defaultPenaltyBase` floor, i.e. flat again. At 1,000 a maximum bust-out
    // (5,000) costs 500 points — half the whole scale.
    uint256 public largeLoanThreshold = 1000 * 1e6;
    uint256 public bonusReferenceAmount = 100 * 1e6; // 100 USDC

    // [M1-1] Reference hold duration. A loan held for >= refDuration earns the full
    // principal-scaled bonus; one held for half of it earns half. Bounded below by
    // the setter so it can never be set to 0 (divisor).
    uint256 public refDuration = 7 days;

    // [M1-2] Credit ladder.
    uint256 public creditMultiple = 2;          // k
    uint256 public growthStep = 100 * 1e6;      // additive step — MUST be > 0 (k == 1 deadlocks)
    uint256 public bootstrapLimit = 100 * 1e6;  // floor so a brand-new agent can start
    mapping(uint256 => uint256) public maxRepaidPrincipal; // largest single ON-TIME repaid loan

    // [M1-3] Post-default lockout.
    uint256 public defaultLockout = 180 days;
    mapping(uint256 => uint256) public lockedUntil; // agentId => timestamp credit resumes

    // [M1-5] Late-repayment penalty.
    uint256 public latePenaltyBase = 10;    // applied to any repayment past endTime
    uint256 public latePenaltyPerDay = 5;   // per FULL day late, on top of the base
    uint256 public latePenaltyMax = 100;    // total cap per late repayment

    // ERC-8004 validation bonus (carried from V3)
    uint256 public validationBonusThreshold = 75;
    uint256 public validationCreditBonus = 2000 * 1e6;

    // ------------------------------------------------------------- tier table

    /// @notice [M1-4] Hard ceiling on ANY owner-settable tier limit. Immutable: the
    ///         whole point of the tier cap is that it bounds the prize even if the
    ///         owner key is compromised or coerced.
    uint256 public constant MAX_TIER_LIMIT = 10000 * 1e6; // 10,000 USDC

    /// @notice Score thresholds for the six tiers, ascending. Index 0 is the floor
    ///         tier (score 0) and is implicit; thresholds[i] is the minimum score
    ///         for tier i. Fixed shape, owner-settable limits only.
    uint256[6] private TIER_MIN_SCORE = [uint256(0), 200, 400, 500, 600, 800];

    /// @notice Per-tier credit limits (USDC base units), ascending by tier.
    ///         Defaults (V7): 1,000 / 5,000 / 10,000 / 10,000 / 2,500 / 5,000.
    ///         The 0 %-collateral tiers (600, 800) are the capped ones; the lower
    ///         tiers keep their V3 limits because they are 75–100 % collateralised,
    ///         so their UNSECURED exposure is 0 / 0 / 0 / 2,500 / 2,500 / 5,000.
    uint256[6] public tierLimits = [
        uint256(1000 * 1e6),
        5000 * 1e6,
        10000 * 1e6,
        10000 * 1e6,
        2500 * 1e6,
        5000 * 1e6
    ];

    /// @notice Per-tier collateral requirement in percent, descending by tier.
    ///         V3 was 100/100/100/25/0/0; the 500-tier moves 25 → 75 so its
    ///         unsecured exposure (10,000 × 25 %) matches the capped 600 tier
    ///         instead of exceeding it by 3×.
    uint256[6] public tierCollateralPct = [uint256(100), 100, 100, 75, 0, 0];

    /// @notice Per-tier interest rate in basis points.
    uint256[6] public tierInterestBps = [uint256(1500), 1500, 1000, 1000, 700, 500];

    // ---------------------------------------------------------- loan registry

    /// @dev [M1-1] Open-loan record, keyed by the marketplace's loanId. V6.2 passes
    ///      the loanId on every call, so hold time is exact — the scratch model in
    ///      the report matched repayments to borrows BY AMOUNT, which is ambiguous
    ///      with concurrent equal-sized loans.
    struct OpenLoan {
        uint128 amount;
        uint64 start;
        uint64 agentId;
    }
    mapping(uint256 => OpenLoan) public openLoans; // loanId => record

    // ---------------------------------------------------------------- events

    event PoolAuthorized(address indexed pool);
    event PoolRevoked(address indexed pool);
    event ValidationRegistrySet(address indexed registry);
    event ScoringParametersUpdated(uint256 onTimeBonus, uint256 defaultPenaltyBase, uint256 defaultPenaltyLarge, uint256 largeLoanThreshold);
    event ValidationBonusParametersUpdated(uint256 bonusThreshold, uint256 creditBonus);
    event BonusReferenceAmountUpdated(uint256 newReference);
    event ReputationRateLimitUpdated(uint256 maxGainPerWindow, uint256 window);
    event ReputationInitialized(uint256 indexed agentId, uint256 score);
    event ReputationUpdated(uint256 indexed agentId, uint256 oldScore, uint256 newScore, string reason);
    event LoanRecorded(uint256 indexed agentId, uint256 indexed loanId, uint256 amount);
    event LoanCompleted(uint256 indexed agentId, uint256 indexed loanId, uint256 amount, bool onTime);
    event DefaultRecorded(uint256 indexed agentId, uint256 indexed loanId, uint256 amount);
    // [M1] new
    event LadderParametersUpdated(uint256 creditMultiple, uint256 growthStep, uint256 bootstrapLimit, uint256 refDuration);
    event DefaultLockoutUpdated(uint256 lockout);
    event LatePenaltyParametersUpdated(uint256 base, uint256 perDay, uint256 max);
    event TierLimitsUpdated(uint256[6] limits);
    event CreditCapacityUpdated(uint256 indexed agentId, uint256 maxRepaidPrincipal);
    event AgentLockedOut(uint256 indexed agentId, uint256 until_);
    event LateRepaymentRecorded(uint256 indexed agentId, uint256 indexed loanId, uint256 lateSeconds, uint256 penalty);

    constructor(address _agentRegistry) Ownable(msg.sender) {
        require(_agentRegistry != address(0), "Invalid registry");
        agentRegistry = AgentRegistryV2(_agentRegistry);
    }

    modifier onlyAuthorizedPool() {
        require(authorizedPools[msg.sender], "Only authorized pools");
        _;
    }

    /**
     * @notice [I-1 fix] Ownership cannot be renounced — this contract holds the
     *         credit levers and renouncing would freeze the tier table forever.
     *         V3/registry/faucet were one-step `Ownable`; V4 is `Ownable2Step`.
     */
    function renounceOwnership() public view override onlyOwner {
        revert("Ownership cannot be renounced");
    }

    // ============================================================ admin

    function authorizePool(address pool) external onlyOwner {
        require(pool != address(0), "Invalid pool address");
        authorizedPools[pool] = true;
        emit PoolAuthorized(pool);
    }

    function revokePool(address pool) external onlyOwner {
        authorizedPools[pool] = false;
        emit PoolRevoked(pool);
    }

    function setValidationRegistry(address _validationRegistry) external onlyOwner {
        validationRegistry = ValidationRegistry(_validationRegistry);
        emit ValidationRegistrySet(_validationRegistry);
    }

    function setScoringParameters(
        uint256 _onTimeBonus,
        uint256 _defaultPenaltyBase,
        uint256 _defaultPenaltyLarge,
        uint256 _largeLoanThreshold
    ) external onlyOwner {
        require(_onTimeBonus <= 50, "Bonus too high");
        require(_defaultPenaltyBase <= 200, "Penalty too high");
        require(_defaultPenaltyLarge <= 300, "Large penalty too high");
        // [M1-3] largeLoanThreshold is a DIVISOR in the proportional penalty.
        require(_largeLoanThreshold > 0, "Threshold must be > 0");
        onTimeRepaymentBonus = _onTimeBonus;
        defaultPenaltyBase = _defaultPenaltyBase;
        defaultPenaltyLarge = _defaultPenaltyLarge;
        largeLoanThreshold = _largeLoanThreshold;
        emit ScoringParametersUpdated(_onTimeBonus, _defaultPenaltyBase, _defaultPenaltyLarge, _largeLoanThreshold);
    }

    function setBonusReferenceAmount(uint256 newRef) external onlyOwner {
        require(newRef > 0, "Reference must be > 0");
        bonusReferenceAmount = newRef;
        emit BonusReferenceAmountUpdated(newRef);
    }

    function setReputationRateLimit(uint256 maxGain, uint256 window) external onlyOwner {
        require(window > 0, "Window must be > 0");
        maxReputationGainPerWindow = maxGain;
        reputationGainWindow = window;
        emit ReputationRateLimitUpdated(maxGain, window);
    }

    function setValidationBonusParameters(uint256 _bonusThreshold, uint256 _creditBonus) external onlyOwner {
        require(_bonusThreshold <= 100, "Threshold must be 0-100");
        // The validation bonus is added on top of the ladder result and must not be
        // an escape hatch from the tier cap.
        require(_creditBonus <= MAX_TIER_LIMIT, "Bonus exceeds ceiling");
        validationBonusThreshold = _bonusThreshold;
        validationCreditBonus = _creditBonus;
        emit ValidationBonusParametersUpdated(_bonusThreshold, _creditBonus);
    }

    /**
     * @notice [M1-2] Configure the credit ladder.
     * @param _creditMultiple k in `k · maxRepaidPrincipal + growthStep`. Must be >= 1.
     *        It is ALSO the self-stake divisor the marketplace reads for M2, so a
     *        larger k means a faster ladder AND a smaller required self-stake:
     *        k is the single knob that prices the residual bust-out risk.
     * @param _growthStep Additive head-room, in USDC base units. MUST be > 0:
     *        the simulation proved `k == 1, step == 0` deadlocks the ladder at
     *        `bootstrapLimit` forever (a loan can never exceed the record it would
     *        have to beat). Capped at MAX_TIER_LIMIT so it cannot bypass the tiers.
     * @param _bootstrapLimit Floor limit for an agent with no repayment record.
     * @param _refDuration Hold-time reference for the principal-time bonus.
     */
    function setLadderParameters(
        uint256 _creditMultiple,
        uint256 _growthStep,
        uint256 _bootstrapLimit,
        uint256 _refDuration
    ) external onlyOwner {
        require(_creditMultiple >= 1, "creditMultiple < 1");
        require(_creditMultiple <= 10, "creditMultiple too high");
        require(_growthStep > 0, "growthStep must be > 0"); // k == 1 + step == 0 deadlocks
        require(_growthStep <= MAX_TIER_LIMIT, "growthStep exceeds ceiling");
        require(_bootstrapLimit > 0 && _bootstrapLimit <= MAX_TIER_LIMIT, "bootstrapLimit range");
        require(_refDuration > 0 && _refDuration <= 365 days, "refDuration range");
        creditMultiple = _creditMultiple;
        growthStep = _growthStep;
        bootstrapLimit = _bootstrapLimit;
        refDuration = _refDuration;
        emit LadderParametersUpdated(_creditMultiple, _growthStep, _bootstrapLimit, _refDuration);
    }

    /// @notice [M1-3] Post-default credit freeze, in seconds. Capped at 2 years so a
    ///         mis-set value cannot permanently brick an agent.
    function setDefaultLockout(uint256 lockout) external onlyOwner {
        require(lockout <= 730 days, "Lockout too long");
        defaultLockout = lockout;
        emit DefaultLockoutUpdated(lockout);
    }

    /// @notice [M1-5] Late-repayment reputation penalty parameters.
    function setLatePenaltyParameters(uint256 base, uint256 perDay, uint256 maxPenalty) external onlyOwner {
        require(maxPenalty <= 300, "Late penalty too high");
        require(base <= maxPenalty && perDay <= maxPenalty, "Component exceeds max");
        latePenaltyBase = base;
        latePenaltyPerDay = perDay;
        latePenaltyMax = maxPenalty;
        emit LatePenaltyParametersUpdated(base, perDay, maxPenalty);
    }

    /**
     * @notice [M1-4] Set the six per-tier credit limits (ascending by tier).
     * @dev Every entry is bounded by the immutable `MAX_TIER_LIMIT`, so the owner key
     *      can tune the table but can never restore the 25,000 / 50,000 exposure that
     *      made the F-04 bust-out worth running. Limits need not be monotone (a
     *      higher tier may legitimately carry a lower limit at a lower collateral
     *      requirement), but see `unsecuredTierExposure` for the figure that matters.
     */
    function setTierLimits(uint256[6] calldata limits) external onlyOwner {
        for (uint256 i = 0; i < 6; i++) {
            require(limits[i] <= MAX_TIER_LIMIT, "Tier limit exceeds ceiling");
            require(limits[i] > 0, "Tier limit must be > 0");
            tierLimits[i] = limits[i];
        }
        emit TierLimitsUpdated(limits);
    }

    // ============================================================ lifecycle

    function initializeReputation(uint256 agentId) external {
        require(agentId != 0, "Invalid agent ID");
        require(!initialized[agentId], "Already initialized");
        require(agentRegistry.addressToAgentId(msg.sender) == agentId, "Caller is not the owner of this agent");
        initialized[agentId] = true;
        agentReputation[agentId] = INITIAL_SCORE;
        emit ReputationInitialized(agentId, INITIAL_SCORE);
    }

    function initializeReputation() external {
        uint256 agentId = agentRegistry.addressToAgentId(msg.sender);
        require(agentId != 0, "Not an agent");
        require(!initialized[agentId], "Already initialized");
        initialized[agentId] = true;
        agentReputation[agentId] = INITIAL_SCORE;
        emit ReputationInitialized(agentId, INITIAL_SCORE);
    }

    /**
     * @notice Record a loan being taken. V4 REQUIRES the marketplace's `loanId`.
     * @dev The loanId keys the open-loan record so `recordLoanCompletion` can compute
     *      the exact hold time. The report flagged amount-matching as ambiguous with
     *      concurrent equal-size loans, which is why this signature changed.
     */
    function recordBorrow(address borrower, uint256 loanId, uint256 amount) external onlyAuthorizedPool {
        uint256 agentId = agentRegistry.addressToAgentId(borrower);
        require(agentId != 0, "Not an agent");
        require(openLoans[loanId].start == 0, "Loan already recorded");

        totalBorrowed[agentId] += amount;
        loanCount[agentId] += 1;
        openLoans[loanId] = OpenLoan({
            amount: uint128(amount),
            start: uint64(block.timestamp),
            agentId: uint64(agentId)
        });

        emit LoanRecorded(agentId, loanId, amount);
    }

    /**
     * @notice Record a loan being completed (repaid).
     * @param borrower   Current holder of the agent NFT (V6.2 resolves it by agentId — F-01).
     * @param loanId     Marketplace loan id, matching the `recordBorrow` call.
     * @param amount     Principal repaid.
     * @param onTime     Marketplace's reward gate (on time AND held long enough AND paid interest).
     * @param lateSeconds Seconds past `endTime`, 0 if not late. [M1-5]
     */
    function recordLoanCompletion(
        address borrower,
        uint256 loanId,
        uint256 amount,
        bool onTime,
        uint256 lateSeconds
    ) external onlyAuthorizedPool {
        uint256 agentId = agentRegistry.addressToAgentId(borrower);
        require(agentId != 0, "Not an agent");

        totalRepaid[agentId] += amount;
        uint256 start = _closeOpenLoan(loanId, agentId);

        if (lateSeconds > 0) {
            // [M1-5] Late repayment: reputation penalty, and the ladder does NOT
            // advance (capacity is demonstrated by loans repaid ON TIME only).
            lateCount[agentId] += 1;
            uint256 penalty = latePenaltyBase + latePenaltyPerDay * (lateSeconds / 1 days);
            if (penalty > latePenaltyMax) penalty = latePenaltyMax;
            if (penalty > 0) {
                uint256 oldS = agentReputation[agentId];
                uint256 newS = oldS > penalty ? oldS - penalty : 0;
                agentReputation[agentId] = newS;
                emit ReputationUpdated(agentId, oldS, newS, "late repayment");
            }
            emit LateRepaymentRecorded(agentId, loanId, lateSeconds, penalty);
        } else if (onTime) {
            // [M1-2] The ladder advances only on an on-time repayment, and only while
            // the agent is not locked out after a default.
            if (block.timestamp >= lockedUntil[agentId] && amount > maxRepaidPrincipal[agentId]) {
                maxRepaidPrincipal[agentId] = amount;
                emit CreditCapacityUpdated(agentId, amount);
            }

            // [M1-1] principal-TIME bonus.
            uint256 ref = bonusReferenceAmount;
            uint256 rd = refDuration;
            uint256 held = block.timestamp > start ? block.timestamp - start : 0;
            uint256 effAmount = amount < ref ? amount : ref;
            uint256 effHeld = held < rd ? held : rd;
            uint256 bonus = (onTimeRepaymentBonus * effAmount * effHeld) / (ref * rd);

            // [M1-3] No reputation gain at all during the post-default lockout.
            if (block.timestamp < lockedUntil[agentId]) bonus = 0;

            // [D1 residual, carried from V3] rate-limit the gain per rolling window.
            if (maxReputationGainPerWindow > 0) {
                if (block.timestamp >= windowStart[agentId] + reputationGainWindow) {
                    windowStart[agentId] = block.timestamp;
                    gainedInWindow[agentId] = 0;
                }
                uint256 remaining = maxReputationGainPerWindow > gainedInWindow[agentId]
                    ? maxReputationGainPerWindow - gainedInWindow[agentId]
                    : 0;
                if (bonus > remaining) bonus = remaining;
            }

            if (bonus > 0) {
                if (maxReputationGainPerWindow > 0) gainedInWindow[agentId] += bonus;
                uint256 oldScore = agentReputation[agentId];
                uint256 newScore = oldScore + bonus;
                if (newScore > MAX_SCORE) newScore = MAX_SCORE;
                agentReputation[agentId] = newScore;
                emit ReputationUpdated(agentId, oldScore, newScore, "on-time repayment");
            }
        }

        emit LoanCompleted(agentId, loanId, amount, onTime && lateSeconds == 0);
    }

    /**
     * @notice Record a loan default.
     * @dev [M1-3] Penalty is proportional to the defaulted amount, capacity resets to
     *      zero and the credit line is frozen for `defaultLockout`.
     */
    function recordDefault(address borrower, uint256 loanId, uint256 amount) external onlyAuthorizedPool {
        uint256 agentId = agentRegistry.addressToAgentId(borrower);
        require(agentId != 0, "Not an agent");

        defaultCount[agentId] += 1;
        _closeOpenLoan(loanId, agentId);

        uint256 penalty = (defaultPenaltyLarge * amount) / largeLoanThreshold;
        if (penalty < defaultPenaltyBase) penalty = defaultPenaltyBase;
        if (penalty > MAX_SCORE) penalty = MAX_SCORE;

        uint256 oldScore = agentReputation[agentId];
        uint256 newScore = oldScore > penalty ? oldScore - penalty : 0;
        agentReputation[agentId] = newScore;

        // Capacity must be re-demonstrated from scratch, and the line is frozen.
        if (maxRepaidPrincipal[agentId] != 0) {
            maxRepaidPrincipal[agentId] = 0;
            emit CreditCapacityUpdated(agentId, 0);
        }
        uint256 until_ = block.timestamp + defaultLockout;
        // Never shorten an existing lockout (a second, smaller default must not help).
        if (until_ > lockedUntil[agentId]) {
            lockedUntil[agentId] = until_;
            emit AgentLockedOut(agentId, until_);
        }

        emit DefaultRecorded(agentId, loanId, amount);
        emit ReputationUpdated(agentId, oldScore, newScore, "default");
    }

    /// @dev Close the open-loan record for `loanId` and return its start timestamp.
    ///      Falls back to `block.timestamp` (zero hold ⇒ zero bonus) if the loan was
    ///      never recorded — e.g. a loan disbursed before this manager was authorized.
    function _closeOpenLoan(uint256 loanId, uint256 agentId) internal returns (uint256 start) {
        OpenLoan storage ol = openLoans[loanId];
        start = ol.start;
        if (start == 0) return block.timestamp;
        // Defence in depth: the record must belong to this agent.
        require(ol.agentId == uint64(agentId), "Loan/agent mismatch");
        delete openLoans[loanId];
    }

    // ================================================================ views

    function getReputationScore(uint256 agentId) external view returns (uint256) {
        return agentReputation[agentId];
    }

    function getReputationScore(address agent) external view returns (uint256) {
        return agentReputation[agentRegistry.addressToAgentId(agent)];
    }

    /// @notice Tier index (0..5) for a score.
    function tierOf(uint256 score) public view returns (uint256) {
        for (uint256 i = 6; i > 0; i--) {
            if (score >= TIER_MIN_SCORE[i - 1]) return i - 1;
        }
        return 0;
    }

    /// @notice Per-tier credit limit for a score (before the ladder and the ERC-8004 bonus).
    function tierLimit(uint256 score) public view returns (uint256) {
        return tierLimits[tierOf(score)];
    }

    /// @notice Minimum score for tier `i`.
    function tierMinScore(uint256 i) external view returns (uint256) {
        require(i < 6, "Bad tier");
        return TIER_MIN_SCORE[i];
    }

    /**
     * @notice The figure the tier cap actually bounds: credit limit × (100 − collateral%) / 100.
     *         Published so the cap can be monitored off-chain and so `setTierLimits`
     *         can be sanity-checked against it.
     */
    function unsecuredTierExposure(uint256 tier) external view returns (uint256) {
        require(tier < 6, "Bad tier");
        return (tierLimits[tier] * (100 - tierCollateralPct[tier])) / 100;
    }

    /// @notice [M1-2] The ladder head-room for an agent, ignoring the tier cap.
    function ladderLimit(uint256 agentId) public view returns (uint256) {
        uint256 demonstrated = creditMultiple * maxRepaidPrincipal[agentId] + growthStep;
        return demonstrated < bootstrapLimit ? bootstrapLimit : demonstrated;
    }

    /**
     * @notice Credit limit: min(tier limit, ladder limit), zero during a post-default
     *         lockout. [M1-2] + [M1-3] + [M1-4].
     */
    function calculateCreditLimit(address agent) external view returns (uint256) {
        uint256 agentId = agentRegistry.addressToAgentId(agent);
        return creditLimitOf(agentId);
    }

    /// @notice agentId-keyed form (V6.2 resolves agents by id — see F-01).
    function creditLimitOf(uint256 agentId) public view returns (uint256) {
        if (block.timestamp < lockedUntil[agentId]) return 0; // [M1-3] post-default freeze

        uint256 baseLimit = tierLimit(agentReputation[agentId]);

        // ERC-8004: add the validation bonus to the TIER limit before the ladder min,
        // so an attested agent gets more headroom but still cannot borrow beyond what
        // it has demonstrated.
        if (address(validationRegistry) != address(0) && validationCreditBonus > 0) {
            (,, , uint256 avgScore) = validationRegistry.getSummary(agentId, new address[](0), "");
            if (avgScore >= validationBonusThreshold) baseLimit += validationCreditBonus;
        }

        uint256 ladder = ladderLimit(agentId);
        return ladder < baseLimit ? ladder : baseLimit;
    }

    function calculateCollateralRequirement(address agent) external view returns (uint256) {
        return tierCollateralPct[tierOf(agentReputation[agentRegistry.addressToAgentId(agent)])];
    }

    function calculateInterestRate(address agent) external view returns (uint256) {
        return tierInterestBps[tierOf(agentReputation[agentRegistry.addressToAgentId(agent)])];
    }

    /// @notice True while `agentId` is frozen after a default.
    function isLockedOut(uint256 agentId) external view returns (bool) {
        return block.timestamp < lockedUntil[agentId];
    }
}
