// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "../core/AgentRegistryV2.sol";

/**
 * @title ReputationManagerV4Sim — SCRATCH model-change candidate (NOT FOR DEPLOYMENT)
 * @notice Drop-in replacement for ReputationManagerV3 (identical external selectors,
 *         so AgentLiquidityMarketplaceV6 can be constructed against it unchanged).
 *
 * Model change "M1" evaluated in ECONOMIC_ATTACK_SIMULATION.md:
 *
 *  (1) PRINCIPAL-TIME BONUS. The on-time bonus is scaled by principal AND by how
 *      long the loan was actually held:
 *          bonus = onTimeBonus · min(amt,refAmount)/refAmount · min(held,refDuration)/refDuration
 *      V3 scaled by principal only, so a loan repaid after `minHold` (1 day) earned
 *      the same points as one held to term — the attacker's cheapest cycle. Hold
 *      time is derived inside the manager from `recordBorrow` (no marketplace change).
 *
 *  (2) EXPOSURE BOUNDED BY DEMONSTRATED REPAID VOLUME.
 *          creditLimit = min(tierLimit, max(bootstrapLimit, creditMultiple · maxRepaidPrincipal))
 *      An agent may only borrow a multiple of the largest loan it has already
 *      repaid, so unsecured exposure can never exceed `creditMultiple ×` the
 *      capital the agent itself has demonstrably put at risk. This is the lever
 *      that turns "0.12 USDC of fees" into "12,500 USDC of working capital".
 *
 *  (3) SIZE-PROPORTIONAL DEFAULT PENALTY + LOCKOUT + CAPACITY RESET.
 *      V3 charged a flat 100 points for ANY default over the large-loan threshold,
 *      so a 25,000 USDC bust-out cost the same as a 10,001 USDC one and was
 *      re-farmed in 20 days. Here the penalty scales with the defaulted amount,
 *      `maxRepaidPrincipal` resets to zero (the agent must re-demonstrate capacity)
 *      and the credit limit is forced to 0 for `defaultLockout`.
 *
 * Companion marketplace change (NOT implemented here — see the report): subordinate
 * and lock the borrower's own lender position in its own pool while it has
 * outstanding principal, so the self-stake is first-loss and cannot be withdrawn
 * ahead of a bust-out.
 */
contract ReputationManagerV4Sim is Ownable {
    AgentRegistryV2 public agentRegistry;

    mapping(address => bool) public authorizedPools;
    mapping(uint256 => uint256) private agentReputation;
    mapping(uint256 => bool) public initialized;

    uint256 public maxReputationGainPerWindow;
    uint256 public reputationGainWindow = 1 days;
    mapping(uint256 => uint256) public windowStart;
    mapping(uint256 => uint256) public gainedInWindow;

    mapping(uint256 => uint256) public totalBorrowed;
    mapping(uint256 => uint256) public totalRepaid;
    mapping(uint256 => uint256) public loanCount;
    mapping(uint256 => uint256) public defaultCount;

    uint256 public onTimeRepaymentBonus = 10;
    uint256 public defaultPenaltyBase = 50;
    uint256 public defaultPenaltyLarge = 100;
    uint256 public largeLoanThreshold = 10000 * 1e6;
    uint256 public bonusReferenceAmount = 100 * 1e6;

    // ---- M1 additions ----
    uint256 public refDuration = 7 days;           // (1) principal-time reference
    uint256 public creditMultiple = 2;             // (2) limit = k × maxRepaidPrincipal
    uint256 public bootstrapLimit = 100 * 1e6;     // (2) floor so a new agent can start
    uint256 public defaultLockout = 180 days;      // (3) credit frozen after a default
    mapping(uint256 => uint256) public maxRepaidPrincipal;
    mapping(uint256 => uint256) public lockedUntil;

    struct OpenLoan { uint128 amount; uint128 start; }
    mapping(uint256 => OpenLoan[]) public openLoans;

    event ReputationInitialized(uint256 indexed agentId, uint256 score);
    event ReputationUpdated(uint256 indexed agentId, uint256 oldScore, uint256 newScore, string reason);
    event LoanRecorded(uint256 indexed agentId, uint256 amount);
    event LoanCompleted(uint256 indexed agentId, uint256 amount, bool onTime);
    event DefaultRecorded(uint256 indexed agentId, uint256 amount);

    constructor(address _agentRegistry) Ownable(msg.sender) {
        agentRegistry = AgentRegistryV2(_agentRegistry);
    }

    modifier onlyAuthorizedPool() { require(authorizedPools[msg.sender], "Only authorized pools"); _; }

    function authorizePool(address pool) external onlyOwner { authorizedPools[pool] = true; }
    function revokePool(address pool) external onlyOwner { authorizedPools[pool] = false; }

    function setScoringParameters(uint256 b, uint256 pB, uint256 pL, uint256 t) external onlyOwner {
        require(b <= 50 && pB <= 200 && pL <= 300, "Out of range");
        onTimeRepaymentBonus = b; defaultPenaltyBase = pB; defaultPenaltyLarge = pL; largeLoanThreshold = t;
    }
    function setBonusReferenceAmount(uint256 r) external onlyOwner { require(r > 0, "Reference must be > 0"); bonusReferenceAmount = r; }
    function setReputationRateLimit(uint256 g, uint256 w) external onlyOwner { require(w > 0, "Window must be > 0"); maxReputationGainPerWindow = g; reputationGainWindow = w; }
    function setM1Parameters(uint256 _refDuration, uint256 _creditMultiple, uint256 _bootstrapLimit, uint256 _lockout) external onlyOwner {
        require(_refDuration > 0, "refDuration"); require(_creditMultiple > 0, "creditMultiple");
        refDuration = _refDuration; creditMultiple = _creditMultiple; bootstrapLimit = _bootstrapLimit; defaultLockout = _lockout;
    }

    function initializeReputation() external {
        uint256 agentId = agentRegistry.addressToAgentId(msg.sender);
        require(agentId != 0, "Not an agent");
        require(!initialized[agentId], "Already initialized");
        initialized[agentId] = true;
        agentReputation[agentId] = 100;
        emit ReputationInitialized(agentId, 100);
    }

    function recordBorrow(address borrower, uint256 amount) external onlyAuthorizedPool {
        uint256 agentId = agentRegistry.addressToAgentId(borrower);
        require(agentId != 0, "Not an agent");
        totalBorrowed[agentId] += amount;
        loanCount[agentId] += 1;
        openLoans[agentId].push(OpenLoan({ amount: uint128(amount), start: uint128(block.timestamp) }));
        emit LoanRecorded(agentId, amount);
    }

    /// @dev Pop the open-loan record matching `amount` (FIFO fallback) and return its start time.
    ///      Production version should take the loanId from the marketplace instead.
    function _popOpen(uint256 agentId, uint256 amount) internal returns (uint256 start) {
        OpenLoan[] storage arr = openLoans[agentId];
        uint256 n = arr.length;
        if (n == 0) return block.timestamp;
        // Pick the OLDEST open record with this amount (FIFO). Picking an arbitrary
        // match would under-credit hold time after a swap-and-pop reorder; FIFO is
        // both correct and the most generous reading for the borrower. A production
        // implementation should take the loanId from the marketplace instead of
        // matching on amount (that needs a marketplace-side signature change).
        uint256 idx = type(uint256).max; uint256 best = type(uint256).max;
        for (uint256 i = 0; i < n; i++) {
            if (arr[i].amount == uint128(amount) && arr[i].start < best) { best = arr[i].start; idx = i; }
        }
        if (idx == type(uint256).max) {
            idx = 0; best = arr[0].start;
            for (uint256 i = 1; i < n; i++) if (arr[i].start < best) { best = arr[i].start; idx = i; }
        }
        start = arr[idx].start;
        arr[idx] = arr[n - 1];
        arr.pop();
    }

    function recordLoanCompletion(address borrower, uint256 amount, bool onTime) external onlyAuthorizedPool {
        uint256 agentId = agentRegistry.addressToAgentId(borrower);
        require(agentId != 0, "Not an agent");
        totalRepaid[agentId] += amount;
        uint256 start = _popOpen(agentId, amount);

        if (onTime) {
            // (2) demonstrated capacity — only a loan actually repaid counts
            if (amount > maxRepaidPrincipal[agentId]) maxRepaidPrincipal[agentId] = amount;

            // (1) principal-TIME scaling
            uint256 held = block.timestamp > start ? block.timestamp - start : 0;
            uint256 effAmt = amount < bonusReferenceAmount ? amount : bonusReferenceAmount;
            uint256 effHeld = held < refDuration ? held : refDuration;
            uint256 bonus = (onTimeRepaymentBonus * effAmt * effHeld) / (bonusReferenceAmount * refDuration);

            if (block.timestamp < lockedUntil[agentId]) bonus = 0; // (3) no gains during lockout

            if (maxReputationGainPerWindow > 0) {
                if (block.timestamp >= windowStart[agentId] + reputationGainWindow) {
                    windowStart[agentId] = block.timestamp;
                    gainedInWindow[agentId] = 0;
                }
                uint256 remaining = maxReputationGainPerWindow > gainedInWindow[agentId]
                    ? maxReputationGainPerWindow - gainedInWindow[agentId] : 0;
                if (bonus > remaining) bonus = remaining;
            }
            if (bonus > 0) {
                if (maxReputationGainPerWindow > 0) gainedInWindow[agentId] += bonus;
                uint256 old = agentReputation[agentId];
                uint256 ns = old + bonus; if (ns > 1000) ns = 1000;
                agentReputation[agentId] = ns;
                emit ReputationUpdated(agentId, old, ns, "on-time repayment");
            }
        }
        emit LoanCompleted(agentId, amount, onTime);
    }

    function recordDefault(address borrower, uint256 amount) external onlyAuthorizedPool {
        uint256 agentId = agentRegistry.addressToAgentId(borrower);
        require(agentId != 0, "Not an agent");
        defaultCount[agentId] += 1;
        _popOpen(agentId, amount);

        // (3) penalty proportional to the SIZE of the default, floored at the base
        uint256 penalty = (defaultPenaltyLarge * amount) / largeLoanThreshold;
        if (penalty < defaultPenaltyBase) penalty = defaultPenaltyBase;
        if (penalty > 1000) penalty = 1000;

        uint256 old = agentReputation[agentId];
        uint256 ns = old > penalty ? old - penalty : 0;
        agentReputation[agentId] = ns;
        maxRepaidPrincipal[agentId] = 0;             // capacity must be re-demonstrated
        lockedUntil[agentId] = block.timestamp + defaultLockout;

        emit DefaultRecorded(agentId, amount);
        emit ReputationUpdated(agentId, old, ns, "default");
    }

    function getReputationScore(uint256 agentId) external view returns (uint256) { return agentReputation[agentId]; }
    function getReputationScore(address agent) external view returns (uint256) {
        return agentReputation[agentRegistry.addressToAgentId(agent)];
    }

    function tierLimit(uint256 score) public pure returns (uint256) {
        if (score >= 800) return 50000 * 1e6;
        if (score >= 600) return 25000 * 1e6;
        if (score >= 400) return 10000 * 1e6;
        if (score >= 200) return 5000 * 1e6;
        return 1000 * 1e6;
    }

    function calculateCreditLimit(address agent) external view returns (uint256) {
        uint256 agentId = agentRegistry.addressToAgentId(agent);
        if (block.timestamp < lockedUntil[agentId]) return 0;   // (3) post-default freeze
        uint256 tl = tierLimit(agentReputation[agentId]);
        uint256 demonstrated = creditMultiple * maxRepaidPrincipal[agentId];
        if (demonstrated < bootstrapLimit) demonstrated = bootstrapLimit;
        return demonstrated < tl ? demonstrated : tl;            // (2)
    }

    function calculateCollateralRequirement(address agent) external view returns (uint256) {
        uint256 score = agentReputation[agentRegistry.addressToAgentId(agent)];
        if (score >= 600) return 0;
        if (score >= 500) return 25;
        return 100;
    }

    function calculateInterestRate(address agent) external view returns (uint256) {
        uint256 score = agentReputation[agentRegistry.addressToAgentId(agent)];
        if (score >= 800) return 500;
        if (score >= 600) return 700;
        if (score >= 400) return 1000;
        return 1500;
    }
}
