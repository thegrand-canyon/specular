// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./AgentRegistryV2.sol";
import "./ValidationRegistry.sol";

/**
 * @title ReputationManagerV3
 * @notice Multi-Pool Reputation Manager for Specular
 * @dev Supports multiple lending pools updating the same reputation scores
 */
contract ReputationManagerV3 is Ownable {
    AgentRegistryV2 public agentRegistry;
    ValidationRegistry public validationRegistry; // Optional ERC-8004 integration

    // Mapping: lending pool address => authorized
    mapping(address => bool) public authorizedPools;

    // Reputation storage
    mapping(uint256 => uint256) private agentReputation; // agentId => score (0-1000)
    mapping(address => uint256) private agentIdByAddress;

    // Loan tracking
    mapping(uint256 => uint256) public totalBorrowed; // agentId => total amount borrowed
    mapping(uint256 => uint256) public totalRepaid;   // agentId => total amount repaid
    mapping(uint256 => uint256) public loanCount;     // agentId => number of loans
    mapping(uint256 => uint256) public defaultCount;  // agentId => number of defaults

    // Configurable scoring parameters
    uint256 public onTimeRepaymentBonus = 10;     // Points added for on-time repayment
    uint256 public defaultPenaltyBase = 50;        // Base penalty for defaults
    uint256 public defaultPenaltyLarge = 100;      // Penalty for large loan defaults
    uint256 public largeLoanThreshold = 10000 * 1e6; // Threshold for large loan penalty (USDC)
    uint256 public validationBonusThreshold = 75;  // Min validation score for credit bonus (0-100)
    uint256 public validationCreditBonus = 2000 * 1e6; // Extra USDC credit limit for validated agents

    // Events
    event PoolAuthorized(address indexed pool);
    event PoolRevoked(address indexed pool);
    event ValidationRegistrySet(address indexed registry);
    event ScoringParametersUpdated(uint256 onTimeBonus, uint256 defaultPenaltyBase, uint256 defaultPenaltyLarge, uint256 largeLoanThreshold);
    event ValidationBonusParametersUpdated(uint256 bonusThreshold, uint256 creditBonus);
    event ReputationInitialized(uint256 indexed agentId, uint256 score);
    event ReputationUpdated(uint256 indexed agentId, uint256 oldScore, uint256 newScore, string reason);
    event LoanRecorded(uint256 indexed agentId, uint256 amount);
    event LoanCompleted(uint256 indexed agentId, uint256 amount, bool onTime);
    event DefaultRecorded(uint256 indexed agentId, uint256 amount);

    constructor(address _agentRegistry) Ownable(msg.sender) {
        agentRegistry = AgentRegistryV2(_agentRegistry);
    }

    modifier onlyAuthorizedPool() {
        require(authorizedPools[msg.sender], "Only authorized pools");
        _;
    }

    /**
     * @notice Authorize a lending pool to update reputation
     */
    function authorizePool(address pool) external onlyOwner {
        require(pool != address(0), "Invalid pool address");
        authorizedPools[pool] = true;
        emit PoolAuthorized(pool);
    }

    /**
     * @notice Revoke a lending pool's authorization
     */
    function revokePool(address pool) external onlyOwner {
        authorizedPools[pool] = false;
        emit PoolRevoked(pool);
    }

    /**
     * @notice Set the ValidationRegistry for ERC-8004 feedback integration
     */
    function setValidationRegistry(address _validationRegistry) external onlyOwner {
        validationRegistry = ValidationRegistry(_validationRegistry);
        emit ValidationRegistrySet(_validationRegistry);
    }

    /**
     * @notice Update scoring parameters
     */
    function setScoringParameters(
        uint256 _onTimeBonus,
        uint256 _defaultPenaltyBase,
        uint256 _defaultPenaltyLarge,
        uint256 _largeLoanThreshold
    ) external onlyOwner {
        require(_onTimeBonus <= 50, "Bonus too high");
        require(_defaultPenaltyBase <= 200, "Penalty too high");
        require(_defaultPenaltyLarge <= 300, "Large penalty too high");
        onTimeRepaymentBonus = _onTimeBonus;
        defaultPenaltyBase = _defaultPenaltyBase;
        defaultPenaltyLarge = _defaultPenaltyLarge;
        largeLoanThreshold = _largeLoanThreshold;
        emit ScoringParametersUpdated(_onTimeBonus, _defaultPenaltyBase, _defaultPenaltyLarge, _largeLoanThreshold);
    }

    /**
     * @notice Update validation bonus parameters
     */
    function setValidationBonusParameters(
        uint256 _bonusThreshold,
        uint256 _creditBonus
    ) external onlyOwner {
        require(_bonusThreshold <= 100, "Threshold must be 0-100");
        validationBonusThreshold = _bonusThreshold;
        validationCreditBonus = _creditBonus;
        emit ValidationBonusParametersUpdated(_bonusThreshold, _creditBonus);
    }

    /**
     * @notice Initialize reputation for an agent by ID
     * @dev [C-02 FIX] Caller must be the owner of the agent NFT to prevent identity spoofing
     */
    function initializeReputation(uint256 agentId) external {
        require(agentId != 0, "Invalid agent ID");
        require(agentReputation[agentId] == 0, "Already initialized");
        // Verify caller owns the agent NFT — prevents front-running and identity hijacking
        require(
            agentRegistry.addressToAgentId(msg.sender) == agentId,
            "Caller is not the owner of this agent"
        );

        agentReputation[agentId] = 100; // Start at 100
        agentIdByAddress[msg.sender] = agentId;

        emit ReputationInitialized(agentId, 100);
    }

    /**
     * @notice Initialize reputation for caller's agent
     */
    function initializeReputation() external {
        uint256 agentId = agentRegistry.addressToAgentId(msg.sender);
        require(agentId != 0, "Not an agent");
        require(agentReputation[agentId] == 0, "Already initialized");

        agentReputation[agentId] = 100;
        agentIdByAddress[msg.sender] = agentId;

        emit ReputationInitialized(agentId, 100);
    }

    /**
     * @notice Record a loan being taken
     */
    function recordBorrow(address borrower, uint256 amount) external onlyAuthorizedPool {
        uint256 agentId = agentRegistry.addressToAgentId(borrower);
        require(agentId != 0, "Not an agent");

        totalBorrowed[agentId] += amount;
        loanCount[agentId] += 1;

        emit LoanRecorded(agentId, amount);
    }

    /**
     * @notice Record a loan being completed
     */
    function recordLoanCompletion(address borrower, uint256 amount, bool onTime) external onlyAuthorizedPool {
        uint256 agentId = agentRegistry.addressToAgentId(borrower);
        require(agentId != 0, "Not an agent");

        totalRepaid[agentId] += amount;

        if (onTime) {
            uint256 oldScore = agentReputation[agentId];
            uint256 newScore = oldScore + onTimeRepaymentBonus;
            if (newScore > 1000) newScore = 1000;

            agentReputation[agentId] = newScore;
            emit ReputationUpdated(agentId, oldScore, newScore, "on-time repayment");
        }

        emit LoanCompleted(agentId, amount, onTime);
    }

    /**
     * @notice Record a loan default
     */
    function recordDefault(address borrower, uint256 amount) external onlyAuthorizedPool {
        uint256 agentId = agentRegistry.addressToAgentId(borrower);
        require(agentId != 0, "Not an agent");

        defaultCount[agentId] += 1;

        // Penalty scales with loan size
        uint256 penalty = defaultPenaltyBase;
        if (amount > largeLoanThreshold) penalty = defaultPenaltyLarge;

        uint256 oldScore = agentReputation[agentId];
        uint256 newScore = oldScore > penalty ? oldScore - penalty : 0;

        agentReputation[agentId] = newScore;

        emit DefaultRecorded(agentId, amount);
        emit ReputationUpdated(agentId, oldScore, newScore, "default");
    }

    /**
     * @notice Get reputation score by agent ID
     */
    function getReputationScore(uint256 agentId) external view returns (uint256) {
        return agentReputation[agentId];
    }

    /**
     * @notice Get reputation score by address
     */
    function getReputationScore(address agent) external view returns (uint256) {
        uint256 agentId = agentRegistry.addressToAgentId(agent);
        return agentReputation[agentId];
    }

    /**
     * @notice Calculate credit limit based on reputation, with optional ERC-8004 validation bonus
     */
    function calculateCreditLimit(address agent) external view returns (uint256) {
        uint256 agentId = agentRegistry.addressToAgentId(agent);
        uint256 score = agentReputation[agentId];

        uint256 baseLimit;
        if (score >= 800) baseLimit = 50000 * 1e6;  // 50k USDC
        else if (score >= 600) baseLimit = 25000 * 1e6;  // 25k USDC
        else if (score >= 400) baseLimit = 10000 * 1e6;  // 10k USDC
        else if (score >= 200) baseLimit = 5000 * 1e6;   // 5k USDC
        else baseLimit = 1000 * 1e6;                      // 1k USDC minimum

        // ERC-8004: add bonus if agent has strong validation score
        if (address(validationRegistry) != address(0) && validationCreditBonus > 0) {
            (,, , uint256 avgScore) = validationRegistry.getSummary(agentId, new address[](0), "");
            if (avgScore >= validationBonusThreshold) {
                baseLimit += validationCreditBonus;
            }
        }

        return baseLimit;
    }

    /**
     * @notice Calculate collateral requirement based on reputation
     */
    function calculateCollateralRequirement(address agent) external view returns (uint256) {
        uint256 agentId = agentRegistry.addressToAgentId(agent);
        uint256 score = agentReputation[agentId];

        if (score >= 800) return 0;    // No collateral
        if (score >= 600) return 0;    // No collateral
        if (score >= 500) return 25;   // 25%
        return 100;                     // 100% collateral
    }

    /**
     * @notice Calculate interest rate based on reputation
     */
    function calculateInterestRate(address agent) external view returns (uint256) {
        uint256 agentId = agentRegistry.addressToAgentId(agent);
        uint256 score = agentReputation[agentId];

        if (score >= 800) return 500;   // 5% APR
        if (score >= 600) return 700;   // 7% APR
        if (score >= 400) return 1000;  // 10% APR
        return 1500;                     // 15% APR
    }
}
