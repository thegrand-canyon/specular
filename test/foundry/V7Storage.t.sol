// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import "../../contracts/core/AgentLiquidityMarketplaceV62.sol";
import "../../contracts/core/AgentRegistryV2.sol";
import "../../contracts/core/ReputationManagerV4.sol";
import "../../contracts/core/AgentLiquidityMarketplaceV6.sol";
import "../../contracts/core/ReputationManagerV3.sol";
import "../../contracts/tokens/MockUSDC.sol";

/**
 * @title V7Storage — permanent state added by an agent's lifecycle on the V7 stack
 * @notice Counts, by exact state diff (`vm.startStateDiffRecording`), how many storage
 *         slots each step of an agent's life turns from zero to non-zero (permanent
 *         state, paid for once at 20,000 gas and never reclaimed) and how many it frees.
 *         Run: forge test --match-path test/foundry/V7Storage.t.sol -vv
 */
contract V7StorageTest is Test {
    AgentRegistryV2 registry;
    ReputationManagerV4 rep;
    MockUSDC usdc;
    AgentLiquidityMarketplaceV62 mp;

    address owner = address(0xAAAA);
    address agent = address(0xA9E7);
    address lender = address(0xB001);

    // state-diff accounting, namespaced per measurement
    uint256 run;
    mapping(uint256 => mapping(bytes32 => bool)) seen;
    mapping(uint256 => mapping(bytes32 => bytes32)) firstPrev;
    mapping(uint256 => mapping(bytes32 => bytes32)) lastNew;
    mapping(uint256 => bytes32[]) touched;
    mapping(uint256 => mapping(bytes32 => address)) owner_;

    function setUp() public {
        vm.startPrank(owner);
        registry = new AgentRegistryV2();
        rep = new ReputationManagerV4(address(registry));
        usdc = new MockUSDC();
        mp = new AgentLiquidityMarketplaceV62(address(registry), address(rep), address(usdc));
        rep.authorizePool(address(mp));
        rep.authorizePool(owner);
        vm.stopPrank();
        _fund(agent);
        _fund(lender);
    }

    function _fund(address who) internal {
        vm.prank(owner);
        usdc.mint(who, 1e14);
        vm.prank(who);
        usdc.approve(address(mp), type(uint256).max);
    }

    function _start() internal {
        run += 1;
        vm.startStateDiffRecording();
    }

    /// @dev Returns (newly occupied slots, freed slots) across the whole stack, and the
    ///      subtotal attributable to the marketplace and the reputation manager.
    function _stop(string memory label) internal {
        VmSafe.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        uint256 r = run;
        for (uint256 i = 0; i < accesses.length; i++) {
            VmSafe.StorageAccess[] memory sa = accesses[i].storageAccesses;
            for (uint256 j = 0; j < sa.length; j++) {
                if (!sa[j].isWrite || sa[j].reverted) continue;
                bytes32 key = keccak256(abi.encode(sa[j].account, sa[j].slot));
                if (!seen[r][key]) {
                    seen[r][key] = true;
                    firstPrev[r][key] = sa[j].previousValue;
                    owner_[r][key] = sa[j].account;
                    touched[r].push(key);
                }
                lastNew[r][key] = sa[j].newValue;
            }
        }
        uint256 occupied;
        uint256 freed;
        uint256 rewritten;
        uint256 occMp;
        uint256 occRep;
        uint256 occReg;
        uint256 occUsdc;
        for (uint256 i = 0; i < touched[r].length; i++) {
            bytes32 key = touched[r][i];
            bytes32 p = firstPrev[r][key];
            bytes32 n = lastNew[r][key];
            if (p == bytes32(0) && n != bytes32(0)) {
                occupied++;
                address acct = owner_[r][key];
                if (acct == address(mp)) occMp++;
                else if (acct == address(rep)) occRep++;
                else if (acct == address(registry)) occReg++;
                else if (acct == address(usdc)) occUsdc++;
            }
            else if (p != bytes32(0) && n == bytes32(0)) freed++;
            else if (p != n) rewritten++;
        }
        console.log(
            string.concat(
                "STOR | ", label,
                " | newSlots=", vm.toString(occupied),
                " | freedSlots=", vm.toString(freed),
                " | rewritten=", vm.toString(rewritten),
                " | slotsTouched=", vm.toString(touched[r].length),
                " | new(mp/rep/registry/usdc)=", vm.toString(occMp), "/", vm.toString(occRep),
                "/", vm.toString(occReg), "/", vm.toString(occUsdc)
            )
        );
    }

    function test_storage_growth_per_lifecycle_step() public {
        AgentRegistryV2.MetadataEntry[] memory empty;

        _start();
        vm.prank(agent);
        registry.register("ipfs://s", empty);
        _stop("register (registry NFT + metadata)");

        _start();
        vm.prank(agent);
        mp.createAgentPool();
        _stop("createAgentPool");

        _start();
        vm.prank(agent);
        rep.initializeReputation();
        _stop("initializeReputation");

        _start();
        vm.prank(lender);
        mp.supplyLiquidity(1, 1000e6);
        _stop("supplyLiquidity (first, new lender slot)");

        _start();
        vm.prank(agent);
        mp.supplyLiquidity(1, 1000e6); // creator self-stake
        _stop("supplyLiquidity (creator self-stake, new slot)");

        vm.warp(block.timestamp + 60);

        // --- loan #1 (100 % collateral tier at score 100) ---
        _start();
        vm.prank(agent);
        uint256 id = mp.requestLoan(100e6, 7);
        _stop("requestLoan #1 (loan struct + activeLoanIds + agentLoans + openLoans)");

        vm.warp(block.timestamp + 7 days);
        _start();
        vm.prank(agent);
        mp.repayLoan(id);
        _stop("repayLoan #1 (repayments record, closes openLoans)");

        // --- loan #2: the steady-state marginal cost ---
        vm.warp(block.timestamp + 60);
        _start();
        vm.prank(agent);
        uint256 id2 = mp.requestLoan(100e6, 7);
        _stop("requestLoan #2 (marginal)");

        vm.warp(block.timestamp + 7 days);
        _start();
        vm.prank(agent);
        mp.repayLoan(id2);
        _stop("repayLoan #2 (marginal)");

        // --- a LATE repayment (first time the lateness counters are written) ---
        vm.warp(block.timestamp + 60);
        vm.prank(agent);
        uint256 id3 = mp.requestLoan(100e6, 7);
        vm.warp(block.timestamp + 10 days);
        _start();
        vm.prank(agent);
        mp.repayLoan(id3);
        _stop("repayLoan LATE (first, writes lateRepayCount/lateSecondsTotal)");

        // --- a default ---
        vm.warp(block.timestamp + 60);
        vm.prank(agent);
        uint256 id4 = mp.requestLoan(100e6, 7);
        vm.warp(block.timestamp + 30 days);
        _start();
        vm.prank(owner);
        mp.liquidateLoan(id4);
        _stop("liquidateLoan (default: lockedUntil, defaultCount)");

        console.log(string.concat("STOR | nextLoanId | ", vm.toString(mp.nextLoanId())));
    }

    /// @notice Marginal permanent state of a long-lived agent: 200 loan round trips.
    function test_storage_growth_long_lived_agent() public {
        AgentRegistryV2.MetadataEntry[] memory empty;
        vm.prank(agent);
        registry.register("ipfs://s", empty);
        vm.prank(agent);
        mp.createAgentPool();
        vm.prank(agent);
        rep.initializeReputation();
        vm.prank(lender);
        mp.supplyLiquidity(1, 100000e6);
        vm.prank(agent);
        mp.supplyLiquidity(1, 1000e6);
        vm.warp(block.timestamp + 60);

        _start();
        for (uint256 i = 0; i < 200; i++) {
            vm.prank(agent);
            uint256 id = mp.requestLoan(100e6, 7);
            vm.warp(block.timestamp + 7 days);
            vm.prank(agent);
            mp.repayLoan(id);
            vm.warp(block.timestamp + 60);
        }
        _stop("200 loan round trips (request + on-time repay)");

        console.log(string.concat("STOR | agentLoans length after 200 loans | ", vm.toString(uint256(200))));
        console.log(string.concat("STOR | nextLoanId | ", vm.toString(mp.nextLoanId())));
    }

    /// @notice The same 200 round trips on the V6.1 stack, to isolate what V6.2 added.
    function test_storage_growth_v61_comparison() public {
        vm.startPrank(owner);
        AgentRegistryV2 reg2 = new AgentRegistryV2();
        ReputationManagerV3 rep3 = new ReputationManagerV3(address(reg2));
        MockUSDC usdc2 = new MockUSDC();
        AgentLiquidityMarketplaceV6 mp61 =
            new AgentLiquidityMarketplaceV6(address(reg2), address(rep3), address(usdc2));
        rep3.authorizePool(address(mp61));
        usdc2.mint(agent, 1e14);
        usdc2.mint(lender, 1e14);
        vm.stopPrank();
        vm.prank(agent);
        usdc2.approve(address(mp61), type(uint256).max);
        vm.prank(lender);
        usdc2.approve(address(mp61), type(uint256).max);

        AgentRegistryV2.MetadataEntry[] memory empty;
        vm.prank(agent);
        reg2.register("ipfs://s61", empty);
        vm.prank(agent);
        mp61.createAgentPool();
        vm.prank(lender);
        mp61.supplyLiquidity(1, 100000e6);
        vm.warp(block.timestamp + 60);

        run += 1;
        uint256 r = run;
        vm.startStateDiffRecording();
        for (uint256 i = 0; i < 200; i++) {
            vm.prank(agent);
            uint256 id = mp61.requestLoan(100e6, 7);
            vm.warp(block.timestamp + 7 days);
            vm.prank(agent);
            mp61.repayLoan(id);
            vm.warp(block.timestamp + 60);
        }
        VmSafe.AccountAccess[] memory accesses = vm.stopAndReturnStateDiff();
        uint256 occMp;
        for (uint256 i = 0; i < accesses.length; i++) {
            VmSafe.StorageAccess[] memory sa = accesses[i].storageAccesses;
            for (uint256 j = 0; j < sa.length; j++) {
                if (!sa[j].isWrite || sa[j].reverted) continue;
                bytes32 key = keccak256(abi.encode(sa[j].account, sa[j].slot));
                if (!seen[r][key]) {
                    seen[r][key] = true;
                    firstPrev[r][key] = sa[j].previousValue;
                    owner_[r][key] = sa[j].account;
                    touched[r].push(key);
                }
                lastNew[r][key] = sa[j].newValue;
            }
        }
        for (uint256 i = 0; i < touched[r].length; i++) {
            bytes32 key = touched[r][i];
            if (firstPrev[r][key] == bytes32(0) && lastNew[r][key] != bytes32(0)
                && owner_[r][key] == address(mp61)) occMp++;
        }
        console.log(string.concat("STOR | V6.1: 200 loan round trips | newMarketplaceSlots=", vm.toString(occMp)));
    }
}
