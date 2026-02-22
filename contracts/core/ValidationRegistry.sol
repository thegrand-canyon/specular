// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "./AgentRegistryV2.sol";

/**
 * @title ValidationRegistry
 * @notice ERC-8004 compliant Validation Registry for third-party agent verification
 * @dev Enables validators to verify agent claims, loan performance, and service quality
 */
contract ValidationRegistry is Ownable {
    AgentRegistryV2 public immutable agentRegistry;

    // Validation status enum
    enum ValidationStatus {
        PENDING,
        APPROVED,
        REJECTED,
        DISPUTED
    }

    struct ValidationRequest {
        bytes32 requestHash;
        uint256 agentId;
        address requester;
        address validatorAddress;
        string requestURI; // Off-chain request details
        bytes32 requestContentHash; // Hash of off-chain content
        uint256 timestamp;
        ValidationStatus status;
        uint8 responseScore; // 0-100 scale
        string responseURI; // Off-chain response details
        bytes32 responseContentHash; // Hash of off-chain response
        string tag; // Category/type of validation
    }

    struct Validator {
        bool isApproved;
        uint256 validationsCompleted;
        uint256 validationsDisputed;
        uint256 stake; // Optional: validators can stake tokens
        string validatorURI; // Metadata about validator
    }

    // Storage
    mapping(address => Validator) public validators;
    mapping(bytes32 => ValidationRequest) public validations;
    mapping(uint256 => bytes32[]) public agentValidations; // agentId => validationHashes
    mapping(address => bytes32[]) public validatorValidations; // validator => validationHashes

    uint256 public totalValidations;
    address[] public approvedValidators;

    // Events (ERC-8004 compliant)
    event ValidationRequested(
        bytes32 indexed requestHash,
        uint256 indexed agentId,
        address indexed validator,
        address requester,
        uint256 timestamp
    );

    event ValidationResponded(
        bytes32 indexed requestHash,
        address indexed validator,
        uint8 response,
        string tag
    );

    event ValidatorApproved(address indexed validator, string validatorURI);
    event ValidatorRemoved(address indexed validator);
    event ValidationDisputed(bytes32 indexed requestHash, address indexed disputer);

    constructor(address _agentRegistry) Ownable(msg.sender) {
        agentRegistry = AgentRegistryV2(_agentRegistry);
    }

    // ========== Validator Management ==========

    /**
     * @notice Approve a validator to perform validations
     * @param validatorAddress The validator's address
     * @param validatorURI Metadata URI for the validator
     */
    function approveValidator(address validatorAddress, string calldata validatorURI)
        external
        onlyOwner
    {
        require(validatorAddress != address(0), "Invalid validator address");
        require(!validators[validatorAddress].isApproved, "Validator already approved");

        validators[validatorAddress] = Validator({
            isApproved: true,
            validationsCompleted: 0,
            validationsDisputed: 0,
            stake: 0,
            validatorURI: validatorURI
        });

        approvedValidators.push(validatorAddress);

        emit ValidatorApproved(validatorAddress, validatorURI);
    }

    /**
     * @notice Remove a validator's approval
     * @param validatorAddress The validator's address
     */
    function removeValidator(address validatorAddress) external onlyOwner {
        require(validators[validatorAddress].isApproved, "Validator not approved");

        validators[validatorAddress].isApproved = false;

        emit ValidatorRemoved(validatorAddress);
    }

    /**
     * @notice Get all approved validators
     */
    function getApprovedValidators() external view returns (address[] memory) {
        // Filter out removed validators
        uint256 count = 0;
        for (uint256 i = 0; i < approvedValidators.length; i++) {
            if (validators[approvedValidators[i]].isApproved) {
                count++;
            }
        }

        address[] memory active = new address[](count);
        uint256 index = 0;
        for (uint256 i = 0; i < approvedValidators.length; i++) {
            if (validators[approvedValidators[i]].isApproved) {
                active[index++] = approvedValidators[i];
            }
        }

        return active;
    }

    // ========== ERC-8004 Validation Functions ==========

    /**
     * @notice Request validation for an agent (ERC-8004)
     * @param validatorAddress The validator to request from
     * @param agentId The agent's NFT ID
     * @param requestURI URI to off-chain request details
     * @param requestHash Hash of off-chain request content
     * @return The validation request hash
     */
    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external returns (bytes32) {
        require(validators[validatorAddress].isApproved, "Validator not approved");
        require(agentRegistry.ownerOf(agentId) != address(0), "Agent does not exist");

        // Generate unique request hash if not provided
        if (requestHash == bytes32(0)) {
            requestHash = keccak256(
                abi.encodePacked(
                    agentId,
                    msg.sender,
                    validatorAddress,
                    requestURI,
                    block.timestamp,
                    totalValidations
                )
            );
        }

        require(
            validations[requestHash].timestamp == 0,
            "Validation request already exists"
        );

        validations[requestHash] = ValidationRequest({
            requestHash: requestHash,
            agentId: agentId,
            requester: msg.sender,
            validatorAddress: validatorAddress,
            requestURI: requestURI,
            requestContentHash: requestHash,
            timestamp: block.timestamp,
            status: ValidationStatus.PENDING,
            responseScore: 0,
            responseURI: "",
            responseContentHash: bytes32(0),
            tag: ""
        });

        agentValidations[agentId].push(requestHash);
        validatorValidations[validatorAddress].push(requestHash);
        totalValidations++;

        emit ValidationRequested(
            requestHash,
            agentId,
            validatorAddress,
            msg.sender,
            block.timestamp
        );

        return requestHash;
    }

    /**
     * @notice Submit validation response (ERC-8004)
     * @param requestHash The validation request hash
     * @param response Validation result (0-100 scale, >50 = approved)
     * @param responseURI URI to off-chain response details
     * @param responseHash Hash of off-chain response content
     * @param tag Category/type of validation
     */
    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external {
        ValidationRequest storage validation = validations[requestHash];

        require(validation.timestamp != 0, "Validation request does not exist");
        require(
            msg.sender == validation.validatorAddress,
            "Not the assigned validator"
        );
        require(
            validation.status == ValidationStatus.PENDING,
            "Validation already completed"
        );
        require(response <= 100, "Response must be 0-100");

        validation.responseScore = response;
        validation.responseURI = responseURI;
        validation.responseContentHash = responseHash;
        validation.tag = tag;

        // Set status based on response score
        if (response > 50) {
            validation.status = ValidationStatus.APPROVED;
        } else {
            validation.status = ValidationStatus.REJECTED;
        }

        validators[msg.sender].validationsCompleted++;

        emit ValidationResponded(requestHash, msg.sender, response, tag);
    }

    /**
     * @notice Dispute a validation result
     * @param requestHash The validation request hash
     */
    function disputeValidation(bytes32 requestHash) external {
        ValidationRequest storage validation = validations[requestHash];

        require(validation.timestamp != 0, "Validation does not exist");
        require(
            msg.sender == validation.requester ||
                msg.sender == agentRegistry.ownerOf(validation.agentId),
            "Not authorized to dispute"
        );
        require(
            validation.status == ValidationStatus.APPROVED ||
                validation.status == ValidationStatus.REJECTED,
            "Can only dispute completed validations"
        );

        validation.status = ValidationStatus.DISPUTED;
        validators[validation.validatorAddress].validationsDisputed++;

        emit ValidationDisputed(requestHash, msg.sender);
    }

    /**
     * @notice Get validation status (ERC-8004)
     * @param requestHash The validation request hash
     * @return The validation request struct
     */
    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (ValidationRequest memory)
    {
        require(validations[requestHash].timestamp != 0, "Validation does not exist");
        return validations[requestHash];
    }

    /**
     * @notice Get aggregate validation summary (ERC-8004)
     * @param agentId The agent's NFT ID
     * @param validatorAddresses Filter by validators (empty = all)
     * @param tag Filter by tag (empty = all)
     * @return totalCount Total validations
     * @return approvedCount Approved validations
     * @return rejectedCount Rejected validations
     * @return averageScore Average validation score
     */
    function getSummary(
        uint256 agentId,
        address[] calldata validatorAddresses,
        string calldata tag
    )
        external
        view
        returns (
            uint256 totalCount,
            uint256 approvedCount,
            uint256 rejectedCount,
            uint256 averageScore
        )
    {
        bytes32[] memory hashes = agentValidations[agentId];
        uint256 scoreSum = 0;
        uint256 scoreCount = 0;

        for (uint256 i = 0; i < hashes.length; i++) {
            ValidationRequest memory validation = validations[hashes[i]];

            // Skip pending or disputed
            if (
                validation.status == ValidationStatus.PENDING ||
                validation.status == ValidationStatus.DISPUTED
            ) {
                continue;
            }

            // Filter by validator
            bool validatorMatch = validatorAddresses.length == 0;
            for (uint256 j = 0; j < validatorAddresses.length && !validatorMatch; j++) {
                if (validation.validatorAddress == validatorAddresses[j]) {
                    validatorMatch = true;
                }
            }
            if (!validatorMatch) continue;

            // Filter by tag
            if (bytes(tag).length > 0) {
                if (
                    keccak256(bytes(validation.tag)) != keccak256(bytes(tag))
                ) {
                    continue;
                }
            }

            // Aggregate
            totalCount++;
            if (validation.status == ValidationStatus.APPROVED) {
                approvedCount++;
            } else if (validation.status == ValidationStatus.REJECTED) {
                rejectedCount++;
            }

            scoreSum += validation.responseScore;
            scoreCount++;
        }

        if (scoreCount > 0) {
            averageScore = scoreSum / scoreCount;
        }
    }

    /**
     * @notice Get all validations for an agent
     * @param agentId The agent's NFT ID
     * @return Array of validation request hashes
     */
    function getAgentValidations(uint256 agentId)
        external
        view
        returns (bytes32[] memory)
    {
        return agentValidations[agentId];
    }

    /**
     * @notice Get all validations performed by a validator
     * @param validatorAddress The validator's address
     * @return Array of validation request hashes
     */
    function getValidatorValidations(address validatorAddress)
        external
        view
        returns (bytes32[] memory)
    {
        return validatorValidations[validatorAddress];
    }
}
