// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IAgentLiquidityMarketplace {
    function supplyLiquidity(uint256 agentId, uint256 amount) external;
    function agentPools(uint256 agentId) external view returns (
        uint256,
        address,
        uint256,
        uint256,
        uint256,
        uint256,
        bool
    );
}

/**
 * @title DepositRouter
 * @notice Routes USDC deposits from any chain to agent pools on Arc
 * @dev Receives USDC from CCTP bridge and automatically supplies to agent pools
 */
contract DepositRouter is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // State variables
    IERC20 public usdc;
    IAgentLiquidityMarketplace public marketplace;

    // Cross-chain deposit tracking
    struct CrossChainDeposit {
        address depositor;
        uint256 agentId;
        uint256 amount;
        uint32 sourceChain;
        uint256 timestamp;
        bool processed;
    }

    mapping(bytes32 => CrossChainDeposit) public deposits;
    mapping(address => uint256) public totalDeposited;
    mapping(uint32 => string) public chainNames;

    // Statistics
    uint256 public totalCrossChainVolume;
    uint256 public totalDeposits;

    // Events
    event CrossChainDepositReceived(
        bytes32 indexed depositId,
        address indexed depositor,
        uint256 indexed agentId,
        uint256 amount,
        uint32 sourceChain
    );

    event DepositRouted(
        bytes32 indexed depositId,
        uint256 indexed agentId,
        uint256 amount
    );

    event DirectDepositRouted(
        address indexed depositor,
        uint256 indexed agentId,
        uint256 amount
    );

    constructor(
        address _usdc,
        address _marketplace
    ) Ownable(msg.sender) {
        usdc = IERC20(_usdc);
        marketplace = IAgentLiquidityMarketplace(_marketplace);

        // Initialize chain names
        chainNames[0] = "Ethereum";
        chainNames[1] = "Optimism";
        chainNames[2] = "Arbitrum";
        chainNames[6] = "Base";
        chainNames[7] = "Polygon";
    }

    /**
     * @notice Receive cross-chain USDC deposit and route to agent pool
     * @param depositor Original depositor address
     * @param agentId Target agent pool
     * @param amount Amount of USDC
     * @param sourceChain Source chain domain ID
     */
    function receiveAndRoute(
        address depositor,
        uint256 agentId,
        uint256 amount,
        uint32 sourceChain
    ) external nonReentrant {
        require(amount > 0, "Amount must be > 0");

        // Generate unique deposit ID
        bytes32 depositId = keccak256(
            abi.encodePacked(depositor, agentId, amount, sourceChain, block.timestamp)
        );

        // Transfer USDC from sender (CCTP receiver or bridge)
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        // Record deposit
        deposits[depositId] = CrossChainDeposit({
            depositor: depositor,
            agentId: agentId,
            amount: amount,
            sourceChain: sourceChain,
            timestamp: block.timestamp,
            processed: false
        });

        emit CrossChainDepositReceived(depositId, depositor, agentId, amount, sourceChain);

        // Route to agent pool if agentId is specified
        if (agentId > 0) {
            _routeToPool(depositId, agentId, amount);
        }
    }

    /**
     * @notice Direct deposit from Arc users (no bridging)
     * @param agentId Target agent pool
     * @param amount Amount of USDC
     */
    function depositDirect(
        uint256 agentId,
        uint256 amount
    ) external nonReentrant {
        require(amount > 0, "Amount must be > 0");
        require(agentId > 0, "Invalid agent ID");

        // Transfer USDC from sender
        usdc.safeTransferFrom(msg.sender, address(this), amount);

        // Approve marketplace
        usdc.approve(address(marketplace), amount);

        // Supply to pool
        marketplace.supplyLiquidity(agentId, amount);

        // Update stats
        totalDeposited[msg.sender] += amount;
        totalCrossChainVolume += amount;
        totalDeposits++;

        emit DirectDepositRouted(msg.sender, agentId, amount);
    }

    /**
     * @notice Internal function to route deposit to pool
     */
    function _routeToPool(
        bytes32 depositId,
        uint256 agentId,
        uint256 amount
    ) internal {
        CrossChainDeposit storage deposit = deposits[depositId];
        require(!deposit.processed, "Already processed");

        // Verify pool exists
        (,,,,,, bool isActive) = marketplace.agentPools(agentId);
        require(isActive, "Pool not active");

        // Approve marketplace
        usdc.approve(address(marketplace), amount);

        // Supply to pool
        marketplace.supplyLiquidity(agentId, amount);

        // Mark as processed
        deposit.processed = true;

        // Update stats
        totalDeposited[deposit.depositor] += amount;
        totalCrossChainVolume += amount;
        totalDeposits++;

        emit DepositRouted(depositId, agentId, amount);
    }

    /**
     * @notice Manually route a pending deposit
     * @param depositId Deposit to route
     */
    function manualRoute(bytes32 depositId) external onlyOwner {
        CrossChainDeposit storage deposit = deposits[depositId];
        require(!deposit.processed, "Already processed");
        require(deposit.amount > 0, "Deposit not found");

        _routeToPool(depositId, deposit.agentId, deposit.amount);
    }

    /**
     * @notice Get deposit details
     * @param depositId Deposit ID
     */
    function getDeposit(bytes32 depositId)
        external
        view
        returns (CrossChainDeposit memory)
    {
        return deposits[depositId];
    }

    /**
     * @notice Get chain name from domain ID
     * @param domain Chain domain ID
     */
    function getChainName(uint32 domain) external view returns (string memory) {
        return chainNames[domain];
    }

    /**
     * @notice Update marketplace address
     * @param _marketplace New marketplace address
     */
    function setMarketplace(address _marketplace) external onlyOwner {
        require(_marketplace != address(0), "Invalid marketplace");
        marketplace = IAgentLiquidityMarketplace(_marketplace);
    }

    /**
     * @notice Add chain name
     * @param domain Chain domain ID
     * @param name Chain name
     */
    function addChainName(uint32 domain, string calldata name) external onlyOwner {
        chainNames[domain] = name;
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
