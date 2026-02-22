// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

// Circle CCTP interfaces
interface ITokenMessenger {
    function depositForBurn(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken
    ) external returns (uint64 nonce);
}

interface IMessageTransmitter {
    function receiveMessage(
        bytes calldata message,
        bytes calldata attestation
    ) external returns (bool success);
}

/**
 * @title CCTPBridge
 * @notice Cross-Chain Transfer Protocol bridge for routing USDC to Arc Network
 * @dev Integrates with Circle's CCTP to enable seamless USDC transfers across chains
 */
contract CCTPBridge is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // State variables
    ITokenMessenger public tokenMessenger;
    IMessageTransmitter public messageTransmitter;
    IERC20 public usdc;

    address public arcMarketplace; // AgentLiquidityMarketplace on Arc
    uint32 public arcDomain; // Circle domain ID for Arc

    // Tracking
    mapping(uint64 => BridgeTransaction) public bridgeTransactions;
    mapping(address => uint256) public totalBridged;

    struct BridgeTransaction {
        address sender;
        uint256 amount;
        uint256 agentId; // Target agent pool on Arc
        uint64 nonce;
        uint256 timestamp;
        bool completed;
    }

    // Events
    event BridgeInitiated(
        address indexed sender,
        uint256 amount,
        uint256 indexed agentId,
        uint64 nonce,
        uint32 destinationDomain
    );

    event BridgeCompleted(
        uint64 indexed nonce,
        uint256 amount,
        address recipient
    );

    event MarketplaceUpdated(address indexed newMarketplace);

    constructor(
        address _tokenMessenger,
        address _messageTransmitter,
        address _usdc,
        address _arcMarketplace,
        uint32 _arcDomain
    ) Ownable(msg.sender) {
        tokenMessenger = ITokenMessenger(_tokenMessenger);
        messageTransmitter = IMessageTransmitter(_messageTransmitter);
        usdc = IERC20(_usdc);
        arcMarketplace = _arcMarketplace;
        arcDomain = _arcDomain;
    }

    /**
     * @notice Bridge USDC to Arc and deposit to agent pool
     * @param amount Amount of USDC to bridge
     * @param agentId Target agent ID on Arc
     */
    function bridgeToArcPool(
        uint256 amount,
        uint256 agentId
    ) external nonReentrant returns (uint64) {
        require(amount > 0, "Amount must be > 0");
        require(arcMarketplace != address(0), "Arc marketplace not set");

        // Transfer USDC from sender
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        // Approve CCTP TokenMessenger
        usdc.approve(address(tokenMessenger), amount);

        // Encode agentId in the recipient data
        bytes32 mintRecipient = bytes32(uint256(uint160(arcMarketplace)));

        // Initiate CCTP burn
        uint64 nonce = tokenMessenger.depositForBurn(
            amount,
            arcDomain,
            mintRecipient,
            address(usdc)
        );

        // Record transaction
        bridgeTransactions[nonce] = BridgeTransaction({
            sender: msg.sender,
            amount: amount,
            agentId: agentId,
            nonce: nonce,
            timestamp: block.timestamp,
            completed: false
        });

        totalBridged[msg.sender] += amount;

        emit BridgeInitiated(msg.sender, amount, agentId, nonce, arcDomain);

        return nonce;
    }

    /**
     * @notice Bridge USDC to Arc (general purpose)
     * @param amount Amount of USDC to bridge
     * @param recipient Recipient address on Arc
     */
    function bridgeToArc(
        uint256 amount,
        address recipient
    ) external nonReentrant returns (uint64) {
        require(amount > 0, "Amount must be > 0");
        require(recipient != address(0), "Invalid recipient");

        // Transfer USDC from sender
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        // Approve CCTP TokenMessenger
        usdc.approve(address(tokenMessenger), amount);

        // Convert recipient to bytes32
        bytes32 mintRecipient = bytes32(uint256(uint160(recipient)));

        // Initiate CCTP burn
        uint64 nonce = tokenMessenger.depositForBurn(
            amount,
            arcDomain,
            mintRecipient,
            address(usdc)
        );

        // Record transaction
        bridgeTransactions[nonce] = BridgeTransaction({
            sender: msg.sender,
            amount: amount,
            agentId: 0, // No specific pool
            nonce: nonce,
            timestamp: block.timestamp,
            completed: false
        });

        totalBridged[msg.sender] += amount;

        emit BridgeInitiated(msg.sender, amount, 0, nonce, arcDomain);

        return nonce;
    }

    /**
     * @notice Get bridge transaction details
     * @param nonce CCTP nonce
     */
    function getBridgeTransaction(uint64 nonce)
        external
        view
        returns (BridgeTransaction memory)
    {
        return bridgeTransactions[nonce];
    }

    /**
     * @notice Update Arc marketplace address
     * @param _arcMarketplace New marketplace address
     */
    function setArcMarketplace(address _arcMarketplace) external onlyOwner {
        require(_arcMarketplace != address(0), "Invalid marketplace");
        arcMarketplace = _arcMarketplace;
        emit MarketplaceUpdated(_arcMarketplace);
    }

    /**
     * @notice Update Arc domain
     * @param _arcDomain New Arc domain ID
     */
    function setArcDomain(uint32 _arcDomain) external onlyOwner {
        arcDomain = _arcDomain;
    }

    /**
     * @notice Emergency withdraw (only owner)
     * @param token Token to withdraw
     * @param amount Amount to withdraw
     */
    function emergencyWithdraw(address token, uint256 amount) external onlyOwner {
        IERC20(token).safeTransfer(owner(), amount);
    }
}
