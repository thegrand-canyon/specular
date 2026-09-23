// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/core/AgentLiquidityMarketplaceV6.sol";
import "../../contracts/core/AgentRegistryV2.sol";
import "../../contracts/core/ReputationManagerV3.sol";
import "../../contracts/tokens/MockUSDC.sol";

/**
 * @title V6Invariants (strengthened 2026-08 self-audit)
 * @notice Foundry stateful invariant tests. Upgrades vs the original:
 *   - handler now includes LIQUIDATE (with time-warp) and WARP ops — the paths
 *     that hid the A1 totalLiquidity-underflow bug;
 *   - the agent is pumped to the 0%-collateral tier so liquidations produce REAL
 *     losses (100%-collateral loans liquidate at zero loss and never exercise the
 *     totalLiquidity loss path);
 *   - EXACT solvency invariant (balance == Σ availableLiquidity + fees + Σ active
 *     collateral), not the weak `Σ avail ≤ balance`;
 *   - H-3 invariant (outstandingPrincipal == Σ active principal per borrower).
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

        vm.prank(agent);
        AgentRegistryV2.MetadataEntry[] memory empty;
        registry.register("ipfs://test", empty);
        vm.prank(agent);
        v6.createAgentPool();

        // Pump the agent into the 0%-collateral tier (score >= 600) so that
        // defaults produce real losses that exercise the totalLiquidity path.
        vm.startPrank(owner);
        reputation.authorizePool(owner);
        // Use the full bonusReferenceAmount (100 USDC) so each completion earns
        // the full +10 under the D1 principal-scaled bonus.
        for (uint256 i = 0; i < 65; i++) {
            reputation.recordLoanCompletion(agent, 100e6, true);
        }
        vm.stopPrank();

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

        handler = new Handler(v6, registry, usdc, agent, lenders, owner);
        targetContract(address(handler));
    }

    /// §B1: poolLenders[agentId] never contains duplicates.
    function invariant_B1_no_duplicate_lenders() public view {
        uint256[] memory pools = handler.knownPools();
        for (uint256 p = 0; p < pools.length; p++) {
            uint256 aid = pools[p];
            (, , , , , , uint256 count) = v6.getAgentPool(aid);
            for (uint256 i = 0; i < count; i++) {
                address a = v6.poolLenders(aid, i);
                for (uint256 j = i + 1; j < count; j++) {
                    require(a != v6.poolLenders(aid, j), "B1: duplicate lender");
                }
            }
        }
    }

    /// §B1 flag: address in poolLenders ⟺ isInPoolLenders true.
    function invariant_B1_flag_consistent() public view {
        uint256[] memory pools = handler.knownPools();
        for (uint256 p = 0; p < pools.length; p++) {
            uint256 aid = pools[p];
            (, , , , , , uint256 count) = v6.getAgentPool(aid);
            for (uint256 i = 0; i < count; i++) {
                require(v6.isInPoolLenders(aid, v6.poolLenders(aid, i)), "B1: flag false for member");
            }
        }
    }

    /// EXACT solvency: contract USDC == Σ availableLiquidity + fees + Σ active collateral.
    function invariant_S1_solvency_exact() public view {
        uint256[] memory pools = handler.knownPools();
        uint256 sumAvail = 0;
        for (uint256 p = 0; p < pools.length; p++) {
            (, , uint256 avail, , , , ) = v6.getAgentPool(pools[p]);
            sumAvail += avail;
        }
        uint256 fees = v6.accumulatedFees();
        uint256 sumCollateral = 0;
        uint256 n = v6.nextLoanId();
        for (uint256 id = 1; id < n; id++) {
            (, , , , uint256 coll, , , , , AgentLiquidityMarketplaceV6.LoanState st) = v6.loans(id);
            if (st == AgentLiquidityMarketplaceV6.LoanState.ACTIVE) sumCollateral += coll;
        }
        require(usdc.balanceOf(address(v6)) == sumAvail + fees + sumCollateral, "S1: exact solvency broken");
    }

    /// H-3: outstandingPrincipal[borrower] == Σ ACTIVE loan principal for that borrower.
    function invariant_H3_outstanding_principal() public view {
        address[] memory borrowers = handler.knownBorrowers();
        uint256 n = v6.nextLoanId();
        for (uint256 b = 0; b < borrowers.length; b++) {
            uint256 sum = 0;
            for (uint256 id = 1; id < n; id++) {
                (, address borrower, , uint256 amount, , , , , , AgentLiquidityMarketplaceV6.LoanState st) = v6.loans(id);
                if (borrower == borrowers[b] && st == AgentLiquidityMarketplaceV6.LoanState.ACTIVE) sum += amount;
            }
            // [D2] outstandingPrincipal is keyed by agentId.
            require(v6.outstandingPrincipal(registry.addressToAgentId(borrowers[b])) == sum, "H-3: outstandingPrincipal mismatch");
        }
    }

    /// §S5: activeLoanCount within cap and equal to the live ACTIVE count.
    function invariant_S5_counter() public view {
        uint256 max = v6.MAX_ACTIVE_LOANS_PER_AGENT();
        address[] memory borrowers = handler.knownBorrowers();
        uint256 n = v6.nextLoanId();
        for (uint256 b = 0; b < borrowers.length; b++) {
            uint256 aid = registry.addressToAgentId(borrowers[b]); // [D2] agentId-keyed
            require(v6.activeLoanCount(aid) <= max, "S5: over cap");
            uint256 actual = 0;
            for (uint256 id = 1; id < n; id++) {
                (, address borrower, , , , , , , , AgentLiquidityMarketplaceV6.LoanState st) = v6.loans(id);
                if (borrower == borrowers[b] && st == AgentLiquidityMarketplaceV6.LoanState.ACTIVE) actual++;
            }
            require(v6.activeLoanCount(aid) == actual, "S5: counter mismatch");
        }
    }

    /// Per-pool principal conservation (D4 socialized loss + A1). Two properties
    /// the fixes must maintain through supply/borrow/repay/claim AND lossy
    /// liquidation (which reduces positions pro-rata):
    ///   (a) totalLiquidity == Σ position.amount           (principal tracked)
    ///   (b) availableLiquidity + totalLoaned == Σ position.amount + Σ earnedInterest
    ///       (idle + lent == principal + accrued-unclaimed interest)
    function invariant_pool_principal_conservation() public view {
        uint256[] memory pools = handler.knownPools();
        for (uint256 p = 0; p < pools.length; p++) {
            uint256 aid = pools[p];
            (, uint256 total, uint256 avail, uint256 loaned, , , uint256 count) = v6.getAgentPool(aid);
            uint256 sumAmount = 0;
            uint256 sumInterest = 0;
            for (uint256 i = 0; i < count; i++) {
                (uint256 amount, uint256 earned, ) = v6.positions(aid, v6.poolLenders(aid, i));
                sumAmount += amount;
                sumInterest += earned;
            }
            require(total == sumAmount, "conservation: totalLiquidity != sum position.amount");
            require(avail + loaned == sumAmount + sumInterest, "conservation: avail+loaned != sum(amount+interest)");
        }
    }
}

/**
 * @title Handler
 * @notice Drives random user-op sequences, now including liquidation + time warp.
 */
contract Handler is Test {
    AgentLiquidityMarketplaceV6 public v6;
    AgentRegistryV2 public registry;
    MockUSDC public usdc;
    address public agent;
    address public owner;
    address[5] public lenders;

    uint256[] internal _activeLoanIds;
    uint256[] internal _knownPools;
    address[] internal _knownBorrowers;

    constructor(
        AgentLiquidityMarketplaceV6 _v6,
        AgentRegistryV2 _reg,
        MockUSDC _usdc,
        address _agent,
        address[5] memory _lenders,
        address _owner
    ) {
        v6 = _v6;
        registry = _reg;
        usdc = _usdc;
        agent = _agent;
        owner = _owner;
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
        if (v6.activeLoanCount(1) >= 10) return; // [D2] agentId-keyed (agent == agentId 1)
        uint256 amt = (uint256(amountSeed) % 20 + 1) * 1e6; // 1 - 20 USDC (0% tier, no collateral)
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

    /// Liquidate a (possibly overdue) active loan — warps past endTime first.
    function liquidateLoan(uint8 idxSeed) external {
        if (_activeLoanIds.length == 0) return;
        uint256 idx = uint256(idxSeed) % _activeLoanIds.length;
        uint256 lid = _activeLoanIds[idx];
        (, , , , , , , uint256 endTime, , AgentLiquidityMarketplaceV6.LoanState st) = v6.loans(lid);
        if (st != AgentLiquidityMarketplaceV6.LoanState.ACTIVE) return;
        if (block.timestamp <= endTime) vm.warp(endTime + 1);
        vm.prank(owner);
        try v6.liquidateLoan(lid) {
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

    function warpTime(uint16 secs) external {
        vm.warp(block.timestamp + (uint256(secs) % (30 days)) + 1);
    }
}
