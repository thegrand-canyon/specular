// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title AgentRegistry
 * @notice Manages agent registration and metadata storage
 * @dev Agents must register before participating in the lending protocol
 */
contract AgentRegistry is Ownable, Pausable {
    struct Agent {
        address agentAddress;
        string metadata;
        uint256 registrationTime;
        bool isActive;
    }

    mapping(address => Agent) public agents;
    mapping(address => bool) public isRegistered;

    uint256 public totalAgents;

    event AgentRegistered(address indexed agent, string metadata, uint256 timestamp);
    event MetadataUpdated(address indexed agent, string metadata);
    event AgentDeactivated(address indexed agent);
    event AgentReactivated(address indexed agent);

    constructor() Ownable(msg.sender) {}

    /**
     * @notice Register a new agent with metadata
     * @param _metadata JSON string containing agent information
     */
    function registerAgent(string memory _metadata) external whenNotPaused {
        require(!isRegistered[msg.sender], "Agent already registered");
        require(bytes(_metadata).length > 0, "Metadata cannot be empty");
        require(bytes(_metadata).length <= 1000, "Metadata too long");

        agents[msg.sender] = Agent({
            agentAddress: msg.sender,
            metadata: _metadata,
            registrationTime: block.timestamp,
            isActive: true
        });

        isRegistered[msg.sender] = true;
        totalAgents++;

        emit AgentRegistered(msg.sender, _metadata, block.timestamp);
    }

    /**
     * @notice Update agent metadata
     * @param _metadata New metadata JSON string
     */
    function updateMetadata(string memory _metadata) external {
        require(isRegistered[msg.sender], "Agent not registered");
        require(bytes(_metadata).length > 0, "Metadata cannot be empty");
        require(bytes(_metadata).length <= 1000, "Metadata too long");

        agents[msg.sender].metadata = _metadata;

        emit MetadataUpdated(msg.sender, _metadata);
    }

    /**
     * @notice Deactivate an agent (only owner can call)
     * @param _agent Address of the agent to deactivate
     */
    function deactivateAgent(address _agent) external onlyOwner {
        require(isRegistered[_agent], "Agent not registered");
        require(agents[_agent].isActive, "Agent already deactivated");

        agents[_agent].isActive = false;

        emit AgentDeactivated(_agent);
    }

    /**
     * @notice Reactivate an agent (only owner can call)
     * @param _agent Address of the agent to reactivate
     */
    function reactivateAgent(address _agent) external onlyOwner {
        require(isRegistered[_agent], "Agent not registered");
        require(!agents[_agent].isActive, "Agent already active");

        agents[_agent].isActive = true;

        emit AgentReactivated(_agent);
    }

    /**
     * @notice Get agent information
     * @param _agent Address of the agent
     * @return Agent struct with all details
     */
    function getAgentInfo(address _agent) external view returns (Agent memory) {
        require(isRegistered[_agent], "Agent not registered");
        return agents[_agent];
    }

    /**
     * @notice Check if an agent is active
     * @param _agent Address of the agent
     * @return true if agent is registered and active
     */
    function isAgentActive(address _agent) external view returns (bool) {
        return isRegistered[_agent] && agents[_agent].isActive;
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
}
