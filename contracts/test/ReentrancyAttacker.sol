// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ReentrancyAttacker
 * @dev Test-only malicious USDC variant that re-enters the marketplace during
 *      a transferFrom or transfer callback. Used to verify nonReentrant guards
 *      hold in V6.
 *
 *      Modes:
 *        ATTACK_NONE        — behave as a normal ERC20
 *        ATTACK_ON_TRANSFER_FROM — re-enter target during transferFrom
 *        ATTACK_ON_TRANSFER      — re-enter target during transfer
 */
contract ReentrancyAttacker {
    string public name = "AttackerUSDC";
    string public symbol = "ATTACK";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    enum AttackMode { NONE, ON_TRANSFER_FROM, ON_TRANSFER }
    AttackMode public attackMode;
    address public target;
    bytes public attackPayload;
    bool public reentered;
    uint8 public attackCount;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event ReentryAttempted(address by, bool succeeded);

    function setAttack(AttackMode mode, address _target, bytes calldata _payload) external {
        attackMode = mode;
        target = _target;
        attackPayload = _payload;
        reentered = false;
        attackCount = 0;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function _doAttack() internal {
        if (attackMode == AttackMode.NONE || attackCount > 0) return;
        attackCount++;
        // Try to re-enter target — should be blocked by nonReentrant
        (bool ok, bytes memory data) = target.call(attackPayload);
        emit ReentryAttempted(msg.sender, ok);
        // Re-record success (note: a successful re-entry is the bug we're testing for)
        if (ok) reentered = true;
        else {
            // Capture revert reason for diagnostic
            // (we don't bubble up — the outer call should still succeed)
        }
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        if (attackMode == AttackMode.ON_TRANSFER) _doAttack();
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= value, "allowance");
        require(balanceOf[from] >= value, "balance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        if (attackMode == AttackMode.ON_TRANSFER_FROM) _doAttack();
        return true;
    }
}
