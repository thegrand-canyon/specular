// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "./AgentRegistryV2.sol";

/**
 * @title AgentCreditFaucet
 * @notice Initial credit boost for new agents on Specular Protocol.
 *
 * Owner pre-funds the faucet with USDC. Newly registered agents can claim
 * a one-time grant (default 10 USDC) to bootstrap their first loan cycle.
 * This solves the cold-start "ETH-to-borrow-ETH" problem documented in
 * AGENT_ADOPTION_STRATEGY.md.
 *
 * Claim eligibility:
 *   - Caller must be a registered agent (agentRegistry.addressToAgentId != 0)
 *   - Caller must not have claimed before
 *   - Caller's agentId must be within `maxEligibleAgentId` (anti-griefing —
 *     owner advances this as the protocol grows)
 *
 * No interaction with V6 — agent receives raw USDC and can supply/borrow at
 * their discretion. This contract is standalone and could be deployed without
 * affecting any other Specular contract.
 *
 * Security:
 *   - Ownable: only owner can configure parameters
 *   - ReentrancyGuard on claim()
 *   - USDC transfer happens last (CEI)
 *   - Per-agent claim deduplication via `claimed` mapping
 */
contract AgentCreditFaucet is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    AgentRegistryV2 public immutable agentRegistry;
    IERC20 public immutable usdcToken;

    /// @notice Per-claim amount in USDC base units. Default 10 USDC = 10_000_000.
    uint256 public claimAmount = 10 * 1e6;

    /// @notice Highest agentId currently eligible to claim. Owner advances as needed.
    /// @dev Set to 0 to disable claims; max uint256 to allow all current and future agents.
    uint256 public maxEligibleAgentId;

    /// @notice Per-agent claim tracking. True iff the agent has already claimed.
    mapping(uint256 => bool) public claimed;

    /// @notice [M-3 fix 2026-07] Per-address claim tracking. Agent registration
    /// is permissionless and transferring the agent NFT frees the sender's
    /// addressToAgentId, so a single funded EOA could otherwise register→claim→
    /// transfer→re-register→claim to drain the faucet. Dedup by the claiming
    /// address too so each EOA can claim at most once regardless of NFT cycling.
    mapping(address => bool) public claimedByAddress;

    /// @notice Aggregate USDC granted to date. For analytics.
    uint256 public totalGranted;

    event Claimed(uint256 indexed agentId, address indexed agent, uint256 amount);
    event ClaimAmountChanged(uint256 oldAmount, uint256 newAmount);
    event MaxEligibleAgentIdChanged(uint256 oldMax, uint256 newMax);
    event Refilled(address indexed from, uint256 amount);
    event Drained(address indexed to, uint256 amount);

    constructor(address _agentRegistry, address _usdcToken) Ownable(msg.sender) {
        require(_agentRegistry != address(0), "Invalid registry");
        require(_usdcToken != address(0), "Invalid USDC");
        agentRegistry = AgentRegistryV2(_agentRegistry);
        usdcToken = IERC20(_usdcToken);
    }

    /**
     * @notice Claim the one-time initial credit grant. Caller must be a
     *         registered agent and not have claimed previously.
     * @return amount The USDC amount granted (in base units).
     */
    function claim() external nonReentrant returns (uint256 amount) {
        uint256 agentId = agentRegistry.addressToAgentId(msg.sender);
        require(agentId != 0, "Not a registered agent");
        require(agentId <= maxEligibleAgentId, "Agent not yet eligible");
        require(!claimed[agentId], "Already claimed");
        // [M-3 fix] Block the register→claim→transfer→re-register Sybil loop.
        require(!claimedByAddress[msg.sender], "Address already claimed");

        amount = claimAmount;
        require(amount > 0, "Faucet inactive");
        require(usdcToken.balanceOf(address(this)) >= amount, "Faucet empty");

        // Effects
        claimed[agentId] = true;
        claimedByAddress[msg.sender] = true;
        totalGranted += amount;

        // Interaction (last)
        usdcToken.safeTransfer(msg.sender, amount);

        emit Claimed(agentId, msg.sender, amount);
    }

    /**
     * @notice Owner: set the per-claim grant amount.
     */
    function setClaimAmount(uint256 newAmount) external onlyOwner {
        require(newAmount <= 100 * 1e6, "Claim amount too high (>100 USDC)");
        uint256 old = claimAmount;
        claimAmount = newAmount;
        emit ClaimAmountChanged(old, newAmount);
    }

    /**
     * @notice Owner: set the maximum eligible agentId. Used to gate access
     *         (e.g., open faucet to first 1000 agents only).
     */
    function setMaxEligibleAgentId(uint256 newMax) external onlyOwner {
        uint256 old = maxEligibleAgentId;
        maxEligibleAgentId = newMax;
        emit MaxEligibleAgentIdChanged(old, newMax);
    }

    /**
     * @notice Owner: drain remaining USDC. For winding down the faucet.
     */
    function drain(uint256 amount) external onlyOwner {
        require(amount <= usdcToken.balanceOf(address(this)), "Insufficient");
        usdcToken.safeTransfer(owner(), amount);
        emit Drained(owner(), amount);
    }

    /**
     * @notice Optional: notify the contract of a refill (transfer is permissionless
     *         via standard USDC transfer to this address — this method just emits
     *         an event for off-chain monitoring).
     */
    function notifyRefill(uint256 amount) external {
        emit Refilled(msg.sender, amount);
    }

    /**
     * @notice View: current USDC balance held by the faucet.
     */
    function balance() external view returns (uint256) {
        return usdcToken.balanceOf(address(this));
    }

    /**
     * @notice View: whether a specific agentId is eligible AND not yet claimed.
     */
    function isEligible(uint256 agentId) external view returns (bool) {
        return agentId != 0 && agentId <= maxEligibleAgentId && !claimed[agentId];
    }
}
