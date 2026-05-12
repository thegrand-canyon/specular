// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/core/AgentLiquidityMarketplaceV6.sol";
import "../../contracts/core/AgentRegistryV2.sol";
import "../../contracts/core/ReputationManagerV3.sol";
import "../../contracts/tokens/MockUSDC.sol";

/**
 * @title V6Invariants
 * @notice Foundry invariant tests for AgentLiquidityMarketplaceV6.
 *         The fuzzer drives random user operations through a Handler contract;
 *         after every call sequence, Foundry asserts the invariant() functions.
 */
contract V6InvariantTest is Test {
    AgentLiquidityMarketplaceV6 public v6;
    AgentRegistryV2 public registry;
    ReputationManagerV3 public reputation;
    MockUSDC public usdc;
    Handler public handler;

    address public owner = address(0xAAAA);
    address public agent = address(0xA9E7);
    address[5] public lenders = [address(0xB1), address(0xB2), address(0xB3), address(0xB4), address(0xB5)];

    function setUp() public {
        vm.startPrank(owner);
        registry = new AgentRegistryV2();
        reputation = new ReputationManagerV3(address(registry));
        usdc = new MockUSDC();
        v6 = new AgentLiquidityMarketplaceV6(address(registry), address(reputation), address(usdc));
        reputation.authorizePool(address(v6));
        vm.stopPrank();

        // Register the agent
        vm.prank(agent);
        AgentRegistryV2.MetadataEntry[] memory empty;
        registry.register("ipfs://test", empty);
        vm.prank(agent);
        v6.createAgentPool();

        // Mint USDC + approvals
        vm.prank(owner);
        usdc.mint(agent, 1e12); // 1M USDC
        vm.prank(agent);
        usdc.approve(address(v6), type(uint256).max);
        for (uint256 i = 0; i < lenders.length; i++) {
            vm.prank(owner);
            usdc.mint(lenders[i], 1e12);
            vm.prank(lenders[i]);
            usdc.approve(address(v6), type(uint256).max);
        }

        handler = new Handler(v6, registry, usdc, agent, lenders);
        targetContract(address(handler));
    }

    /// §B1 invariant: poolLenders[agentId] never contains duplicates.
    function invariant_B1_no_duplicate_lenders() public view {
        uint256[] memory pools = handler.knownPools();
        for (uint256 p = 0; p < pools.length; p++) {
            uint256 aid = pools[p];
            (, , , , , , uint256 lc) = v6.getAgentPool(aid);
            address[] memory seen = new address[](lc);
            uint256 seenCount = 0;
            for (uint256 j = 0; j < lc; j++) {
                address l = v6.poolLenders(aid, j);
                for (uint256 k = 0; k < seenCount; k++) {
                    require(seen[k] != l, "B1: duplicate found");
                }
                seen[seenCount++] = l;
            }
        }
    }

    /// §B1 flag invariant: addr in poolLenders[aid] iff isInPoolLenders[aid][addr] == true.
    function invariant_B1_flag_consistent() public view {
        uint256[] memory pools = handler.knownPools();
        for (uint256 p = 0; p < pools.length; p++) {
            uint256 aid = pools[p];
            (, , , , , , uint256 lc) = v6.getAgentPool(aid);
            for (uint256 j = 0; j < lc; j++) {
                address l = v6.poolLenders(aid, j);
                require(v6.isInPoolLenders(aid, l), "B1: flag missing");
            }
        }
    }

    /// §S1 invariant: Σ pool.availableLiquidity ≤ usdc.balanceOf(MP).
    function invariant_S1_solvency() public view {
        uint256[] memory pools = handler.knownPools();
        uint256 sumAvail = 0;
        for (uint256 p = 0; p < pools.length; p++) {
            (, , uint256 avail, , , , ) = v6.getAgentPool(pools[p]);
            sumAvail += avail;
        }
        uint256 mpBal = usdc.balanceOf(address(v6));
        require(sumAvail <= mpBal, "S1: sumAvail > mpBal");
    }

    /// §S5 invariant: no agent has activeLoanCount > MAX_ACTIVE_LOANS_PER_AGENT.
    function invariant_S5_cap_respected() public view {
        uint256 max = v6.MAX_ACTIVE_LOANS_PER_AGENT();
        address[] memory borrowers = handler.knownBorrowers();
        for (uint256 i = 0; i < borrowers.length; i++) {
            require(v6.activeLoanCount(borrowers[i]) <= max, "S5: counter > cap");
        }
    }

    /// §S5 integrity: counter equals the array walk count.
    function invariant_S5_counter_matches_array() public view {
        address[] memory borrowers = handler.knownBorrowers();
        for (uint256 i = 0; i < borrowers.length; i++) {
            uint256 counter = v6.activeLoanCount(borrowers[i]);
            uint256 actual = 0;
            for (uint256 j = 0; j < 100; j++) {
                try v6.agentLoans(borrowers[i], j) returns (uint256 lid) {
                    (, , , , , , , , , AgentLiquidityMarketplaceV6.LoanState st) = v6.loans(lid);
                    if (st == AgentLiquidityMarketplaceV6.LoanState.ACTIVE) actual++;
                } catch {
                    break;
                }
            }
            require(counter == actual, "S5: counter mismatch with array walk");
        }
    }
}

/**
 * @title Handler
 * @notice Drives random sequences of user operations against V6 for the invariant fuzzer.
 */
contract Handler is Test {
    AgentLiquidityMarketplaceV6 public v6;
    AgentRegistryV2 public registry;
    MockUSDC public usdc;
    address public agent;
    address[5] public lenders;

    uint256[] internal _activeLoanIds;
    uint256[] internal _knownPools;
    address[] internal _knownBorrowers;

    constructor(
        AgentLiquidityMarketplaceV6 _v6,
        AgentRegistryV2 _reg,
        MockUSDC _usdc,
        address _agent,
        address[5] memory _lenders
    ) {
        v6 = _v6;
        registry = _reg;
        usdc = _usdc;
        agent = _agent;
        lenders = _lenders;
        _knownPools.push(1);
        _knownBorrowers.push(_agent);
    }

    function knownPools() external view returns (uint256[] memory) { return _knownPools; }
    function knownBorrowers() external view returns (address[] memory) { return _knownBorrowers; }

    function supply(uint8 lenderIdx, uint8 amountSeed) external {
        address lender = lenders[lenderIdx % 5];
        uint256 amount = (uint256(amountSeed) % 50 + 1) * 1e6;
        if (usdc.balanceOf(lender) < amount) return;
        vm.prank(lender);
        try v6.supplyLiquidity(1, amount) {} catch {}
    }

    function withdraw(uint8 lenderIdx, uint8 amountSeed) external {
        address lender = lenders[lenderIdx % 5];
        (uint256 supplied, , ) = v6.positions(1, lender);
        if (supplied == 0) return;
        uint256 amount = (uint256(amountSeed) * supplied / 256);
        if (amount == 0) return;
        vm.prank(lender);
        try v6.withdrawLiquidity(1, amount) {} catch {}
    }

    function requestLoan(uint8 amountSeed, uint8 durSeed) external {
        (, , uint256 avail, , , , ) = v6.getAgentPool(1);
        if (avail < 1e6) return;
        if (v6.activeLoanCount(agent) >= 10) return;
        uint256 amt = (uint256(amountSeed) % 5 + 1) * 1e5; // 0.1 - 0.5 USDC
        if (amt > avail) return;
        uint256 dur = 7 + (uint256(durSeed) % 30);
        vm.prank(agent);
        try v6.requestLoan(amt, dur) returns (uint256 loanId) {
            _activeLoanIds.push(loanId);
        } catch {}
    }

    function repayLoan(uint8 idxSeed) external {
        if (_activeLoanIds.length == 0) return;
        uint256 idx = uint256(idxSeed) % _activeLoanIds.length;
        uint256 lid = _activeLoanIds[idx];
        vm.prank(agent);
        try v6.repayLoan(lid) {
            _activeLoanIds[idx] = _activeLoanIds[_activeLoanIds.length - 1];
            _activeLoanIds.pop();
        } catch {}
    }

    function claim(uint8 lenderIdx) external {
        address lender = lenders[lenderIdx % 5];
        (, uint256 earnedInt, ) = v6.positions(1, lender);
        if (earnedInt == 0) return;
        vm.prank(lender);
        try v6.claimInterest(1) {} catch {}
    }
}
