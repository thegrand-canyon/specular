// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./AgentRegistry.sol";

/**
 * @title ReputationManager
 * @notice Manages agent reputation scores and credit limits
 * @dev Score range: 0-1000, affects loan terms and eligibility
 */
contract ReputationManager is Ownable {
    struct ReputationData {
        uint256 score;
        uint256 loansCompleted;
        uint256 loansDefaulted;
        uint256 totalBorrowed;
        uint256 totalRepaid;
        uint256 lastUpdated;
    }

    AgentRegistry public agentRegistry;
    address public lendingPool;

    mapping(address => ReputationData) public reputation;

    uint256 public constant INITIAL_SCORE = 100;
    uint256 public constant MAX_SCORE = 1000;
    uint256 public constant MIN_SCORE = 0;
    uint256 public constant ON_TIME_BONUS = 10;
    uint256 public constant LATE_PENALTY = 5;
    uint256 public constant DEFAULT_PENALTY = 50;

    event ReputationInitialized(address indexed agent, uint256 score);
    event ReputationUpdated(address indexed agent, uint256 newScore, string reason);
    event LendingPoolUpdated(address indexed oldPool, address indexed newPool);

    modifier onlyLendingPool() {
        require(msg.sender == lendingPool, "Only lending pool can call");
        _;
    }

    constructor(address _agentRegistry) Ownable(msg.sender) {
        require(_agentRegistry != address(0), "Invalid agent registry");
        agentRegistry = AgentRegistry(_agentRegistry);
    }

    /**
     * @notice Set the lending pool address (only owner)
     * @param _lendingPool Address of the lending pool contract
     */
    function setLendingPool(address _lendingPool) external onlyOwner {
        require(_lendingPool != address(0), "Invalid lending pool address");
        address oldPool = lendingPool;
        lendingPool = _lendingPool;
        emit LendingPoolUpdated(oldPool, _lendingPool);
    }

    /**
     * @notice Initialize reputation for a newly registered agent
     * @param _agent Address of the agent
     */
    function initializeReputation(address _agent) external {
        require(agentRegistry.isRegistered(_agent), "Agent not registered");
        require(reputation[_agent].lastUpdated == 0, "Reputation already initialized");

        reputation[_agent] = ReputationData({
            score: INITIAL_SCORE,
            loansCompleted: 0,
            loansDefaulted: 0,
            totalBorrowed: 0,
            totalRepaid: 0,
            lastUpdated: block.timestamp
        });

        emit ReputationInitialized(_agent, INITIAL_SCORE);
    }

    /**
     * @notice Record a completed loan and update reputation
     * @param _agent Address of the agent
     * @param _amount Loan amount
     * @param _onTime Whether the loan was repaid on time
     */
    function recordLoanCompletion(
        address _agent,
        uint256 _amount,
        bool _onTime
    ) external onlyLendingPool {
        require(reputation[_agent].lastUpdated > 0, "Reputation not initialized");

        ReputationData storage rep = reputation[_agent];
        rep.loansCompleted++;
        rep.totalRepaid += _amount;
        rep.lastUpdated = block.timestamp;

        if (_onTime) {
            // Reward on-time repayment (scaled by loan size)
            uint256 bonus = ON_TIME_BONUS + (_amount / 10000); // +1 point per 10k borrowed
            if (bonus > 50) bonus = 50; // Cap bonus at 50

            uint256 newScore = rep.score + bonus;
            if (newScore > MAX_SCORE) newScore = MAX_SCORE;
            rep.score = newScore;

            emit ReputationUpdated(_agent, newScore, "On-time repayment");
        } else {
            // Penalize late repayment
            uint256 penalty = LATE_PENALTY;
            uint256 newScore = rep.score > penalty ? rep.score - penalty : MIN_SCORE;
            rep.score = newScore;

            emit ReputationUpdated(_agent, newScore, "Late repayment");
        }
    }

    /**
     * @notice Record a loan default and penalize reputation
     * @param _agent Address of the agent
     * @param _amount Loan amount that was defaulted
     */
    function recordDefault(address _agent, uint256 _amount) external onlyLendingPool {
        require(reputation[_agent].lastUpdated > 0, "Reputation not initialized");

        ReputationData storage rep = reputation[_agent];
        rep.loansDefaulted++;
        rep.lastUpdated = block.timestamp;

        // Heavy penalty for defaults (scaled by loan size)
        uint256 penalty = DEFAULT_PENALTY + (_amount / 5000); // +1 point per 5k defaulted
        if (penalty > 200) penalty = 200; // Cap penalty at 200

        uint256 newScore = rep.score > penalty ? rep.score - penalty : MIN_SCORE;
        rep.score = newScore;

        emit ReputationUpdated(_agent, newScore, "Loan default");
    }

    /**
     * @notice Record that a loan was borrowed (for tracking)
     * @param _agent Address of the agent
     * @param _amount Loan amount
     */
    function recordBorrow(address _agent, uint256 _amount) external onlyLendingPool {
        require(reputation[_agent].lastUpdated > 0, "Reputation not initialized");
        reputation[_agent].totalBorrowed += _amount;
    }

    /**
     * @notice Get the reputation score of an agent
     * @param _agent Address of the agent
     * @return Current reputation score (0-1000)
     */
    function getReputationScore(address _agent) external view returns (uint256) {
        require(reputation[_agent].lastUpdated > 0, "Reputation not initialized");
        return reputation[_agent].score;
    }

    /**
     * @notice Calculate maximum loan amount based on reputation
     * @param _agent Address of the agent
     * @return Maximum loan amount in USDC (with 6 decimals)
     */
    function calculateCreditLimit(address _agent) external view returns (uint256) {
        require(reputation[_agent].lastUpdated > 0, "Reputation not initialized");

        uint256 score = reputation[_agent].score;

        // Credit limits based on reputation score
        if (score >= 800) {
            return 100000 * 10**6; // 100,000 USDC
        } else if (score >= 600) {
            return 50000 * 10**6; // 50,000 USDC
        } else if (score >= 400) {
            return 25000 * 10**6; // 25,000 USDC
        } else if (score >= 200) {
            return 10000 * 10**6; // 10,000 USDC
        } else {
            return 5000 * 10**6; // 5,000 USDC minimum
        }
    }

    /**
     * @notice Calculate required collateral percentage
     * @param _agent Address of the agent
     * @return Collateral percentage (0-100)
     */
    function calculateCollateralRequirement(address _agent) external view returns (uint256) {
        require(reputation[_agent].lastUpdated > 0, "Reputation not initialized");

        uint256 score = reputation[_agent].score;

        if (score >= 700) {
            return 0; // No collateral required
        } else if (score >= 500) {
            return 25; // 25% collateral
        } else if (score >= 300) {
            return 50; // 50% collateral
        } else {
            return 100; // 100% collateral (or deny loan)
        }
    }

    /**
     * @notice Get full reputation data for an agent
     * @param _agent Address of the agent
     * @return ReputationData struct
     */
    function getReputationData(address _agent) external view returns (ReputationData memory) {
        require(reputation[_agent].lastUpdated > 0, "Reputation not initialized");
        return reputation[_agent];
    }
}
