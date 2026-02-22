// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./AgentRegistryV2.sol";

/**
 * @title ReputationManagerV2
 * @notice ERC-8004 compliant Reputation Registry with credit scoring
 * @dev Combines ERC-8004 feedback system with Specular's credit scoring
 */
contract ReputationManagerV2 is Ownable {
    AgentRegistryV2 public immutable agentRegistry;
    address public lendingPool;

    // Credit scoring constants
    uint256 public constant INITIAL_SCORE = 100;
    uint256 public constant MAX_SCORE = 1000;
    uint256 public constant ON_TIME_BONUS = 10;
    uint256 public constant DEFAULT_PENALTY = 50;

    // ERC-8004 Feedback structure
    struct Feedback {
        uint256 agentId;
        address clientAddress;
        int128 value; // Signed integer for feedback score
        uint8 valueDecimals; // Decimal precision
        string tag1; // Primary category
        string tag2; // Secondary category
        string endpoint; // Service endpoint used
        string feedbackURI; // Off-chain feedback details
        bytes32 feedbackHash; // Hash of off-chain content
        uint256 timestamp;
        bool revoked;
        string response; // Agent/validator response
    }

    // Specular credit scoring structure
    struct ReputationData {
        uint256 score;
        uint256 loansCompleted;
        uint256 loansDefaulted;
        uint256 totalBorrowed;
        uint256 totalRepaid;
        uint256 lastUpdated;
    }

    // Storage
    mapping(uint256 => ReputationData) public reputation; // agentId => reputation
    mapping(bytes32 => Feedback) public feedbacks; // feedbackHash => Feedback
    mapping(uint256 => bytes32[]) public agentFeedbacks; // agentId => feedbackHashes
    uint256 public totalFeedbackCount;

    // Events (ERC-8004 compliant)
    event FeedbackGiven(
        bytes32 indexed feedbackHash,
        uint256 indexed agentId,
        address indexed clientAddress,
        int128 value,
        string tag1,
        string tag2,
        uint256 timestamp
    );
    event FeedbackRevoked(bytes32 indexed feedbackHash, address indexed revoker);
    event ResponseAppended(bytes32 indexed feedbackHash, string response);

    // Specular events
    event ReputationInitialized(uint256 indexed agentId, uint256 initialScore);
    event ReputationUpdated(uint256 indexed agentId, uint256 newScore, string reason);

    constructor(address _agentRegistry) Ownable(msg.sender) {
        agentRegistry = AgentRegistryV2(_agentRegistry);
    }

    modifier onlyLendingPool() {
        require(msg.sender == lendingPool, "Only lending pool");
        _;
    }

    /**
     * @notice Set the lending pool address (one-time only)
     */
    function setLendingPool(address _lendingPool) external onlyOwner {
        require(lendingPool == address(0), "Lending pool already set");
        require(_lendingPool != address(0), "Invalid lending pool address");
        lendingPool = _lendingPool;
    }

    // ========== ERC-8004 Reputation Registry Functions ==========

    /**
     * @notice Submit feedback for an agent (ERC-8004)
     * @param agentId The agent's NFT ID
     * @param value Feedback score (signed integer)
     * @param valueDecimals Decimal precision for the score
     * @param tag1 Primary category (e.g., "loan", "repayment")
     * @param tag2 Secondary category (e.g., "on-time", "defaulted")
     * @param endpoint Service endpoint used
     * @param feedbackURI URI to off-chain feedback details
     * @param feedbackHash Hash of off-chain feedback content
     * @return The feedback hash
     */
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external returns (bytes32) {
        require(agentRegistry.ownerOf(agentId) != address(0), "Agent does not exist");

        // Generate unique feedback hash if not provided
        if (feedbackHash == bytes32(0)) {
            feedbackHash = keccak256(
                abi.encodePacked(
                    agentId,
                    msg.sender,
                    value,
                    tag1,
                    tag2,
                    block.timestamp,
                    totalFeedbackCount
                )
            );
        }

        require(feedbacks[feedbackHash].timestamp == 0, "Feedback already exists");

        feedbacks[feedbackHash] = Feedback({
            agentId: agentId,
            clientAddress: msg.sender,
            value: value,
            valueDecimals: valueDecimals,
            tag1: tag1,
            tag2: tag2,
            endpoint: endpoint,
            feedbackURI: feedbackURI,
            feedbackHash: feedbackHash,
            timestamp: block.timestamp,
            revoked: false,
            response: ""
        });

        agentFeedbacks[agentId].push(feedbackHash);
        totalFeedbackCount++;

        emit FeedbackGiven(
            feedbackHash,
            agentId,
            msg.sender,
            value,
            tag1,
            tag2,
            block.timestamp
        );

        return feedbackHash;
    }

    /**
     * @notice Read a specific feedback entry (ERC-8004)
     * @param feedbackHash The hash of the feedback
     * @return The feedback struct
     */
    function readFeedback(bytes32 feedbackHash)
        external
        view
        returns (Feedback memory)
    {
        require(feedbacks[feedbackHash].timestamp != 0, "Feedback does not exist");
        return feedbacks[feedbackHash];
    }

    /**
     * @notice Read all feedback for an agent with optional filtering (ERC-8004)
     * @param agentId The agent's NFT ID
     * @param clientAddresses Filter by client addresses (empty = no filter)
     * @param tags Filter by tags (empty = no filter)
     * @return Array of feedback entries
     */
    function readAllFeedback(
        uint256 agentId,
        address[] calldata clientAddresses,
        string[] calldata tags
    ) external view returns (Feedback[] memory) {
        bytes32[] memory hashes = agentFeedbacks[agentId];

        // First pass: count matching feedback
        uint256 matchCount = 0;
        bool[] memory matches = new bool[](hashes.length);

        for (uint256 i = 0; i < hashes.length; i++) {
            Feedback memory fb = feedbacks[hashes[i]];

            // Skip if revoked
            if (fb.revoked) continue;

            // Filter by client addresses
            bool clientMatch = clientAddresses.length == 0;
            for (uint256 j = 0; j < clientAddresses.length && !clientMatch; j++) {
                if (fb.clientAddress == clientAddresses[j]) {
                    clientMatch = true;
                }
            }
            if (!clientMatch) continue;

            // Filter by tags
            bool tagMatch = tags.length == 0;
            for (uint256 j = 0; j < tags.length && !tagMatch; j++) {
                if (
                    keccak256(bytes(fb.tag1)) == keccak256(bytes(tags[j])) ||
                    keccak256(bytes(fb.tag2)) == keccak256(bytes(tags[j]))
                ) {
                    tagMatch = true;
                }
            }
            if (!tagMatch) continue;

            matches[i] = true;
            matchCount++;
        }

        // Second pass: build result array
        Feedback[] memory result = new Feedback[](matchCount);
        uint256 resultIndex = 0;

        for (uint256 i = 0; i < hashes.length; i++) {
            if (matches[i]) {
                result[resultIndex++] = feedbacks[hashes[i]];
            }
        }

        return result;
    }

    /**
     * @notice Get aggregate summary of feedback (ERC-8004)
     * @param agentId The agent's NFT ID
     * @param clientAddresses Filter by clients (empty = all)
     * @param tags Filter by tags (empty = all)
     * @return count Total feedback count
     * @return averageValue Average feedback value
     * @return minValue Minimum feedback value
     * @return maxValue Maximum feedback value
     */
    function getSummary(
        uint256 agentId,
        address[] calldata clientAddresses,
        string[] calldata tags
    )
        external
        view
        returns (
            uint256 count,
            int128 averageValue,
            int128 minValue,
            int128 maxValue
        )
    {
        bytes32[] memory hashes = agentFeedbacks[agentId];

        int128 sum = 0;
        minValue = type(int128).max;
        maxValue = type(int128).min;

        for (uint256 i = 0; i < hashes.length; i++) {
            Feedback memory fb = feedbacks[hashes[i]];

            if (fb.revoked) continue;

            // Apply filters (same logic as readAllFeedback)
            bool clientMatch = clientAddresses.length == 0;
            for (uint256 j = 0; j < clientAddresses.length && !clientMatch; j++) {
                if (fb.clientAddress == clientAddresses[j]) clientMatch = true;
            }
            if (!clientMatch) continue;

            bool tagMatch = tags.length == 0;
            for (uint256 j = 0; j < tags.length && !tagMatch; j++) {
                if (
                    keccak256(bytes(fb.tag1)) == keccak256(bytes(tags[j])) ||
                    keccak256(bytes(fb.tag2)) == keccak256(bytes(tags[j]))
                ) {
                    tagMatch = true;
                }
            }
            if (!tagMatch) continue;

            // Aggregate
            count++;
            sum += fb.value;
            if (fb.value < minValue) minValue = fb.value;
            if (fb.value > maxValue) maxValue = fb.value;
        }

        if (count > 0) {
            averageValue = sum / int128(int256(count));
        } else {
            minValue = 0;
            maxValue = 0;
        }
    }

    /**
     * @notice Revoke previously submitted feedback (ERC-8004)
     * @param feedbackHash The hash of the feedback to revoke
     */
    function revokeFeedback(bytes32 feedbackHash) external {
        Feedback storage fb = feedbacks[feedbackHash];
        require(fb.timestamp != 0, "Feedback does not exist");
        require(fb.clientAddress == msg.sender, "Not feedback author");
        require(!fb.revoked, "Already revoked");

        fb.revoked = true;

        emit FeedbackRevoked(feedbackHash, msg.sender);
    }

    /**
     * @notice Append a response to feedback (ERC-8004)
     * @param feedbackHash The hash of the feedback
     * @param response The response text
     */
    function appendResponse(bytes32 feedbackHash, string calldata response)
        external
    {
        Feedback storage fb = feedbacks[feedbackHash];
        require(fb.timestamp != 0, "Feedback does not exist");

        // Only agent owner or contract owner can respond
        address agentOwner = agentRegistry.ownerOf(fb.agentId);
        require(
            msg.sender == agentOwner || msg.sender == owner(),
            "Not authorized"
        );

        fb.response = response;

        emit ResponseAppended(feedbackHash, response);
    }

    // ========== Specular Credit Scoring Functions ==========

    /**
     * @notice Initialize reputation for a newly registered agent
     * @param agentId Agent's NFT ID
     */
    function initializeReputation(uint256 agentId) external {
        require(agentRegistry.ownerOf(agentId) != address(0), "Agent does not exist");
        require(reputation[agentId].lastUpdated == 0, "Reputation already initialized");

        reputation[agentId] = ReputationData({
            score: INITIAL_SCORE,
            loansCompleted: 0,
            loansDefaulted: 0,
            totalBorrowed: 0,
            totalRepaid: 0,
            lastUpdated: block.timestamp
        });

        emit ReputationInitialized(agentId, INITIAL_SCORE);
    }

    /**
     * @notice Internal: Record a completed loan and update reputation
     */
    function _recordLoanCompletion(
        uint256 agentId,
        uint256 _amount,
        bool _onTime
    ) internal {
        require(reputation[agentId].lastUpdated > 0, "Reputation not initialized");

        ReputationData storage rep = reputation[agentId];
        rep.loansCompleted++;
        rep.totalRepaid += _amount;
        rep.lastUpdated = block.timestamp;

        if (_onTime) {
            // Reward on-time repayment
            uint256 bonus = ON_TIME_BONUS + (_amount / 10000);
            if (rep.score + bonus <= MAX_SCORE) {
                rep.score += bonus;
            } else {
                rep.score = MAX_SCORE;
            }

            emit ReputationUpdated(agentId, rep.score, "On-time loan repayment");
        }
    }

    /**
     * @notice Internal: Record a loan default and penalize reputation
     */
    function _recordDefault(uint256 agentId, uint256 _amount) internal {
        require(reputation[agentId].lastUpdated > 0, "Reputation not initialized");

        ReputationData storage rep = reputation[agentId];
        rep.loansDefaulted++;
        rep.lastUpdated = block.timestamp;

        // Scale penalty by loan size
        uint256 penalty = DEFAULT_PENALTY + (_amount / 20000);
        if (rep.score >= penalty) {
            rep.score -= penalty;
        } else {
            rep.score = 0;
        }

        emit ReputationUpdated(agentId, rep.score, "Loan default");
    }

    /**
     * @notice Internal: Record that a loan was borrowed (for tracking)
     */
    function _recordBorrow(uint256 agentId, uint256 _amount) internal {
        require(reputation[agentId].lastUpdated > 0, "Reputation not initialized");
        reputation[agentId].totalBorrowed += _amount;
    }

    /**
     * @notice Record a completed loan and update reputation
     * @param agentId Agent's NFT ID
     * @param _amount Loan amount
     * @param _onTime Whether the loan was repaid on time
     */
    function recordLoanCompletion(
        uint256 agentId,
        uint256 _amount,
        bool _onTime
    ) external onlyLendingPool {
        _recordLoanCompletion(agentId, _amount, _onTime);
    }

    /**
     * @notice Record a loan default and penalize reputation
     * @param agentId Agent's NFT ID
     * @param _amount Loan amount
     */
    function recordDefault(uint256 agentId, uint256 _amount)
        external
        onlyLendingPool
    {
        _recordDefault(agentId, _amount);
    }

    /**
     * @notice Record that a loan was borrowed (for tracking)
     * @param agentId Agent's NFT ID
     * @param _amount Loan amount
     */
    function recordBorrow(uint256 agentId, uint256 _amount)
        external
        onlyLendingPool
    {
        _recordBorrow(agentId, _amount);
    }

    /**
     * @notice Get reputation score for an agent
     * @param agentId Agent's NFT ID
     * @return Reputation score (0-1000)
     */
    function getReputationScore(uint256 agentId)
        external
        view
        returns (uint256)
    {
        require(reputation[agentId].lastUpdated > 0, "Reputation not initialized");
        return reputation[agentId].score;
    }

    /**
     * @notice Calculate credit limit based on reputation score
     * @param agentId Agent's NFT ID
     * @return Credit limit in USDC (6 decimals)
     */
    function calculateCreditLimit(uint256 agentId)
        external
        view
        returns (uint256)
    {
        require(reputation[agentId].lastUpdated > 0, "Reputation not initialized");

        uint256 score = reputation[agentId].score;

        // Tiered credit limits based on score
        if (score >= 800) {
            return 50_000 * 1e6; // 50k USDC
        } else if (score >= 600) {
            return 25_000 * 1e6; // 25k USDC
        } else if (score >= 400) {
            return 10_000 * 1e6; // 10k USDC
        } else if (score >= 200) {
            return 5_000 * 1e6; // 5k USDC
        } else {
            return 1_000 * 1e6; // 1k USDC minimum
        }
    }

    /**
     * @notice Calculate required collateral percentage based on reputation
     * @param agentId Agent's NFT ID
     * @return Collateral percentage (0-100)
     */
    function calculateCollateralRequirement(uint256 agentId)
        external
        view
        returns (uint256)
    {
        require(reputation[agentId].lastUpdated > 0, "Reputation not initialized");

        uint256 score = reputation[agentId].score;

        // Tiered collateral requirements
        if (score >= 800) {
            return 0; // No collateral needed
        } else if (score >= 600) {
            return 0; // No collateral needed
        } else if (score >= 400) {
            return 25; // 25% collateral
        } else if (score >= 200) {
            return 50; // 50% collateral
        } else {
            return 100; // 100% collateral
        }
    }

    // ========== Backwards Compatibility ==========

    /**
     * @notice Get reputation score by address (backwards compatibility)
     */
    function getReputationScore(address agentAddress)
        external
        view
        returns (uint256)
    {
        uint256 agentId = agentRegistry.addressToAgentId(agentAddress);
        require(agentId != 0, "Agent not registered");
        require(reputation[agentId].lastUpdated > 0, "Reputation not initialized");
        return reputation[agentId].score;
    }

    /**
     * @notice Calculate credit limit by address (backwards compatibility)
     */
    function calculateCreditLimit(address agentAddress)
        external
        view
        returns (uint256)
    {
        uint256 agentId = agentRegistry.addressToAgentId(agentAddress);
        require(agentId != 0, "Agent not registered");
        return this.calculateCreditLimit(agentId);
    }

    /**
     * @notice Calculate collateral requirement by address (backwards compatibility)
     */
    function calculateCollateralRequirement(address agentAddress)
        external
        view
        returns (uint256)
    {
        uint256 agentId = agentRegistry.addressToAgentId(agentAddress);
        require(agentId != 0, "Agent not registered");
        return this.calculateCollateralRequirement(agentId);
    }

    /**
     * @notice Initialize reputation by address (backwards compatibility)
     */
    function initializeReputation(address agentAddress) external {
        uint256 agentId = agentRegistry.addressToAgentId(agentAddress);
        require(agentId != 0, "Agent not registered");
        this.initializeReputation(agentId);
    }

    /**
     * @notice Record borrow by address (backwards compatibility)
     */
    function recordBorrow(address agentAddress, uint256 _amount) external onlyLendingPool {
        uint256 agentId = agentRegistry.addressToAgentId(agentAddress);
        require(agentId != 0, "Agent not registered");
        _recordBorrow(agentId, _amount);
    }

    /**
     * @notice Record loan completion by address (backwards compatibility)
     */
    function recordLoanCompletion(
        address agentAddress,
        uint256 _amount,
        bool _onTime
    ) external onlyLendingPool {
        uint256 agentId = agentRegistry.addressToAgentId(agentAddress);
        require(agentId != 0, "Agent not registered");
        _recordLoanCompletion(agentId, _amount, _onTime);
    }

    /**
     * @notice Record default by address (backwards compatibility)
     */
    function recordDefault(address agentAddress, uint256 _amount)
        external
        onlyLendingPool
    {
        uint256 agentId = agentRegistry.addressToAgentId(agentAddress);
        require(agentId != 0, "Agent not registered");
        _recordDefault(agentId, _amount);
    }
}
