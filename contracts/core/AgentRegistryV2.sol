// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/**
 * @title AgentRegistryV2
 * @notice ERC-8004 compliant Identity Registry for AI agents
 * @dev Implements ERC-721 with ERC-8004 extensions for agent discovery and trust
 */
contract AgentRegistryV2 is ERC721URIStorage, Ownable, Pausable, EIP712 {
    using ECDSA for bytes32;

    struct MetadataEntry {
        string key;
        bytes value;
    }

    struct Agent {
        uint256 agentId;
        address owner;
        address agentWallet; // Designated payment wallet
        string agentURI;
        uint256 registrationTime;
        bool isActive;
    }

    // Agent ID counter
    uint256 private _nextAgentId;

    // Mappings
    mapping(uint256 => Agent) public agents; // agentId => Agent
    mapping(address => uint256) public addressToAgentId; // owner address => agentId
    mapping(uint256 => mapping(string => bytes)) public agentMetadata; // agentId => key => value

    // EIP-712 for setAgentWallet signatures
    bytes32 private constant SET_WALLET_TYPEHASH =
        keccak256("SetWallet(uint256 agentId,address newWallet,uint256 deadline)");

    // Events (ERC-8004 compliant)
    event AgentRegistered(
        uint256 indexed agentId,
        address indexed owner,
        string agentURI,
        uint256 timestamp
    );
    event AgentURIUpdated(uint256 indexed agentId, string newURI);
    event AgentWalletUpdated(uint256 indexed agentId, address indexed newWallet);
    event MetadataUpdated(uint256 indexed agentId, string key, bytes value);
    event AgentDeactivated(uint256 indexed agentId);
    event AgentReactivated(uint256 indexed agentId);

    constructor()
        ERC721("Specular Agent", "SPAGENT")
        Ownable(msg.sender)
        EIP712("SpecularAgentRegistry", "1")
    {
        _nextAgentId = 1; // Start from 1, 0 is reserved
    }

    /**
     * @notice Register a new agent (ERC-8004 Identity Registry)
     * @param agentURI URI pointing to agent's metadata (IPFS, HTTP, etc.)
     * @param metadata Array of key-value pairs for custom metadata
     * @return agentId The newly minted agent NFT ID
     */
    function register(
        string calldata agentURI,
        MetadataEntry[] calldata metadata
    ) external whenNotPaused returns (uint256) {
        require(addressToAgentId[msg.sender] == 0, "Agent already registered");
        require(bytes(agentURI).length > 0, "Agent URI cannot be empty");

        uint256 agentId = _nextAgentId++;

        // Mint the agent NFT to the caller
        _safeMint(msg.sender, agentId);
        _setTokenURI(agentId, agentURI);

        // Store agent data
        agents[agentId] = Agent({
            agentId: agentId,
            owner: msg.sender,
            agentWallet: msg.sender, // Default to owner
            agentURI: agentURI,
            registrationTime: block.timestamp,
            isActive: true
        });

        addressToAgentId[msg.sender] = agentId;

        // Store custom metadata
        for (uint256 i = 0; i < metadata.length; i++) {
            agentMetadata[agentId][metadata[i].key] = metadata[i].value;
            emit MetadataUpdated(agentId, metadata[i].key, metadata[i].value);
        }

        emit AgentRegistered(agentId, msg.sender, agentURI, block.timestamp);

        return agentId;
    }

    /**
     * @notice Update agent URI (ERC-8004)
     * @param agentId The agent's NFT ID
     * @param newURI New URI for the agent's metadata
     */
    function setAgentURI(uint256 agentId, string calldata newURI) external {
        require(ownerOf(agentId) == msg.sender, "Not agent owner");
        require(bytes(newURI).length > 0, "URI cannot be empty");

        _setTokenURI(agentId, newURI);
        agents[agentId].agentURI = newURI;

        emit AgentURIUpdated(agentId, newURI);
    }

    /**
     * @notice Set designated payment wallet for an agent (ERC-8004)
     * @param agentId The agent's NFT ID
     * @param newWallet The new payment wallet address
     * @param deadline Signature expiration timestamp
     * @param signature EIP-712 signature from agent owner
     */
    function setAgentWallet(
        uint256 agentId,
        address newWallet,
        uint256 deadline,
        bytes calldata signature
    ) external {
        require(block.timestamp <= deadline, "Signature expired");
        require(newWallet != address(0), "Invalid wallet address");

        // Verify EIP-712 signature
        bytes32 structHash = keccak256(
            abi.encode(SET_WALLET_TYPEHASH, agentId, newWallet, deadline)
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = digest.recover(signature);

        require(signer == ownerOf(agentId), "Invalid signature");

        agents[agentId].agentWallet = newWallet;

        emit AgentWalletUpdated(agentId, newWallet);
    }

    /**
     * @notice Get custom metadata for an agent (ERC-8004)
     * @param agentId The agent's NFT ID
     * @param metadataKey The metadata key
     * @return The metadata value
     */
    function getMetadata(uint256 agentId, string calldata metadataKey)
        external
        view
        returns (bytes memory)
    {
        require(_ownerOf(agentId) != address(0), "Agent does not exist");
        return agentMetadata[agentId][metadataKey];
    }

    /**
     * @notice Set custom metadata for an agent (ERC-8004)
     * @param agentId The agent's NFT ID
     * @param metadataKey The metadata key
     * @param metadataValue The metadata value
     */
    function setMetadata(
        uint256 agentId,
        string calldata metadataKey,
        bytes calldata metadataValue
    ) external {
        require(ownerOf(agentId) == msg.sender, "Not agent owner");
        require(bytes(metadataKey).length > 0, "Key cannot be empty");

        agentMetadata[agentId][metadataKey] = metadataValue;

        emit MetadataUpdated(agentId, metadataKey, metadataValue);
    }

    /**
     * @notice Deactivate an agent (only owner can call)
     * @param agentId The agent's NFT ID
     */
    function deactivateAgent(uint256 agentId) external onlyOwner {
        require(_ownerOf(agentId) != address(0), "Agent does not exist");
        require(agents[agentId].isActive, "Agent already deactivated");

        agents[agentId].isActive = false;

        emit AgentDeactivated(agentId);
    }

    /**
     * @notice Reactivate an agent (only owner can call)
     * @param agentId The agent's NFT ID
     */
    function reactivateAgent(uint256 agentId) external onlyOwner {
        require(_ownerOf(agentId) != address(0), "Agent does not exist");
        require(!agents[agentId].isActive, "Agent already active");

        agents[agentId].isActive = true;

        emit AgentReactivated(agentId);
    }

    // ========== Backwards Compatibility Functions ==========

    /**
     * @notice Check if an address is registered
     * @param agentAddress The address to check
     * @return true if registered
     */
    function isRegistered(address agentAddress) external view returns (bool) {
        return addressToAgentId[agentAddress] != 0;
    }

    /**
     * @notice Check if an agent is active
     * @param agentAddress The address to check
     * @return true if agent is registered and active
     */
    function isAgentActive(address agentAddress) external view returns (bool) {
        uint256 agentId = addressToAgentId[agentAddress];
        return agentId != 0 && agents[agentId].isActive;
    }

    /**
     * @notice Get agent info by address (backwards compatibility)
     * @param agentAddress The agent's address
     * @return Agent struct
     */
    function getAgentInfo(address agentAddress)
        external
        view
        returns (Agent memory)
    {
        uint256 agentId = addressToAgentId[agentAddress];
        require(agentId != 0, "Agent not registered");
        return agents[agentId];
    }

    /**
     * @notice Get agent info by ID
     * @param agentId The agent's NFT ID
     * @return Agent struct
     */
    function getAgentInfoById(uint256 agentId)
        external
        view
        returns (Agent memory)
    {
        require(_ownerOf(agentId) != address(0), "Agent does not exist");
        return agents[agentId];
    }

    /**
     * @notice Get total number of registered agents
     */
    function totalAgents() external view returns (uint256) {
        return _nextAgentId - 1;
    }

    /**
     * @notice Pause the contract (only owner)
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause the contract (only owner)
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Override transfer to update address mapping
     */
    function _update(address to, uint256 tokenId, address auth)
        internal
        override
        returns (address)
    {
        address from = _ownerOf(tokenId);

        // Update mappings on transfer
        if (from != address(0)) {
            delete addressToAgentId[from];
        }
        if (to != address(0)) {
            addressToAgentId[to] = tokenId;
            agents[tokenId].owner = to;
        }

        return super._update(to, tokenId, auth);
    }
}
