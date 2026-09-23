// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/core/AgentLiquidityMarketplaceV6.sol";
import "../../contracts/core/AgentRegistryV2.sol";
import "../../contracts/core/ReputationManagerV3.sol";
import "../../contracts/tokens/MockUSDC.sol";
import "./legacy/AgentLiquidityMarketplaceV6_0.sol";

/**
 * @title V61Gas — V6.0 (tag arc-mainnet-v6-deployed-2026-09-19) vs V6.1 execution gas
 * @notice Same scenario driven against both marketplaces on fresh, identical stacks.
 *         Numbers are vm.lastCallGas().gasTotalUsed with `--isolate`, i.e. each measured
 *         call runs as its own transaction with cold storage (comparable to a receipt's
 *         gasUsed minus the 21k intrinsic + calldata cost).
 *         Run: forge test --isolate --match-path test/foundry/V61Gas.t.sol -vv
 */
contract V61GasTest is Test {
    struct Stack {
        AgentRegistryV2 registry;
        ReputationManagerV3 reputation;
        MockUSDC usdc;
        AgentLiquidityMarketplaceV6 mp; // ABI-compatible view of either version
        bool legacy;
    }

    address owner = address(0xAAAA);
    address agent = address(0xA9E7);
    address[] lenders50;

    function setUp() public {
        for (uint256 i = 0; i < 50; i++) lenders50.push(address(uint160(0xB000 + i)));
    }

    function _deploy(bool legacy) internal returns (Stack memory s) {
        s.legacy = legacy;
        vm.startPrank(owner);
        s.registry = new AgentRegistryV2();
        s.reputation = new ReputationManagerV3(address(s.registry));
        s.usdc = new MockUSDC();
        address mp = legacy
            ? address(new AgentLiquidityMarketplaceV6_0(address(s.registry), address(s.reputation), address(s.usdc)))
            : address(new AgentLiquidityMarketplaceV6(address(s.registry), address(s.reputation), address(s.usdc)));
        s.mp = AgentLiquidityMarketplaceV6(mp);
        s.reputation.authorizePool(mp);
        s.reputation.authorizePool(owner);
        vm.stopPrank();

        AgentRegistryV2.MetadataEntry[] memory empty;
        vm.prank(agent);
        s.registry.register("ipfs://gas", empty);
        vm.prank(agent);
        s.mp.createAgentPool();
        vm.startPrank(owner);
        for (uint256 i = 0; i < 65; i++) s.reputation.recordLoanCompletion(agent, 100e6, true); // 0% tier
        vm.stopPrank();
        _fund(s, agent);
        for (uint256 i = 0; i < 50; i++) _fund(s, lenders50[i]);
    }

    function _fund(Stack memory s, address who) internal {
        vm.prank(owner);
        s.usdc.mint(who, 1e13);
        vm.prank(who);
        s.usdc.approve(address(s.mp), type(uint256).max);
    }

    // ------------------------------------------------------------ measured ops
    function _supply(Stack memory s, address l, uint256 amt) internal returns (uint256 g) {
        vm.prank(l);
        s.mp.supplyLiquidity(1, amt);
        g = vm.lastCallGas().gasTotalUsed;
    }
    function _withdraw(Stack memory s, address l, uint256 amt) internal returns (uint256 g) {
        vm.prank(l);
        s.mp.withdrawLiquidity(1, amt);
        g = vm.lastCallGas().gasTotalUsed;
    }
    function _loan(Stack memory s, uint256 amt, uint256 days_) internal returns (uint256 g, uint256 id) {
        vm.prank(agent);
        id = s.mp.requestLoan(amt, days_);
        g = vm.lastCallGas().gasTotalUsed;
    }
    function _repay(Stack memory s, uint256 id) internal returns (uint256 g) {
        vm.prank(agent);
        s.mp.repayLoan(id);
        g = vm.lastCallGas().gasTotalUsed;
    }
    function _liquidate(Stack memory s, uint256 id) internal returns (uint256 g) {
        vm.prank(owner);
        s.mp.liquidateLoan(id);
        g = vm.lastCallGas().gasTotalUsed;
    }
    function _claim(Stack memory s, address l) internal returns (uint256 g) {
        vm.prank(l);
        s.mp.claimInterest(1);
        g = vm.lastCallGas().gasTotalUsed;
    }

    // ------------------------------------------------------------ scenarios (return gas)
    function sc_supplyFresh(Stack memory s) internal returns (uint256) {
        return _supply(s, lenders50[0], 100e6);
    }
    function sc_topUpNoLoan(Stack memory s) internal returns (uint256) {
        _supply(s, lenders50[0], 100e6);
        vm.warp(block.timestamp + 60);
        return _supply(s, lenders50[0], 50e6);
    }
    function sc_topUpPendingCreate(Stack memory s) internal returns (uint256) {
        _supply(s, lenders50[0], 100e6);
        vm.warp(block.timestamp + 60);
        _loan(s, 10e6, 7);
        vm.warp(block.timestamp + 60);
        return _supply(s, lenders50[0], 50e6);
    }
    function sc_topUpMerge(Stack memory s) internal returns (uint256) {
        _supply(s, lenders50[0], 100e6);
        vm.warp(block.timestamp + 60);
        _loan(s, 10e6, 7);
        vm.warp(block.timestamp + 60);
        _supply(s, lenders50[0], 50e6); // pending
        vm.warp(block.timestamp + 60);
        return _supply(s, lenders50[0], 50e6); // (d) merge: no loan since pending
    }
    function sc_topUpFold(Stack memory s) internal returns (uint256) {
        _supply(s, lenders50[0], 100e6);
        vm.warp(block.timestamp + 60);
        (, uint256 a) = _loan(s, 10e6, 7);
        vm.warp(block.timestamp + 60);
        _supply(s, lenders50[0], 50e6); // pending (A in flight)
        vm.warp(block.timestamp + 60);
        _repay(s, a);
        _loan(s, 10e6, 7);               // B: starts after pending → pending qualified like base
        vm.warp(block.timestamp + 60);
        return _supply(s, lenders50[0], 50e6); // (c) fold
    }
    function sc_topUpFoldWith10Active(Stack memory s) internal returns (uint256) {
        _supply(s, lenders50[0], 1000e6);
        vm.warp(block.timestamp + 60);
        (, uint256 a) = _loan(s, 10e6, 7);
        vm.warp(block.timestamp + 60);
        _supply(s, lenders50[0], 50e6);
        vm.warp(block.timestamp + 60);
        _repay(s, a);
        for (uint256 i = 0; i < 10; i++) { _loan(s, 10e6, 7); vm.warp(block.timestamp + 1); }
        return _supply(s, lenders50[0], 50e6); // scans a full active set (10) twice at most
    }
    function sc_withdrawTrim(Stack memory s) internal returns (uint256) {
        _supply(s, lenders50[0], 100e6);
        vm.warp(block.timestamp + 60);
        _loan(s, 10e6, 7);
        vm.warp(block.timestamp + 60);
        _supply(s, lenders50[0], 50e6); // pending 50
        return _withdraw(s, lenders50[0], 30e6); // trims pending to 20
    }
    function sc_withdrawFullExit(Stack memory s) internal returns (uint256) {
        _supply(s, lenders50[0], 100e6);
        return _withdraw(s, lenders50[0], 100e6);
    }
    function sc_requestLoan(Stack memory s) internal returns (uint256) {
        _supply(s, lenders50[0], 100e6);
        vm.warp(block.timestamp + 60);
        (uint256 g, ) = _loan(s, 10e6, 7);
        return g;
    }
    function sc_repay1(Stack memory s) internal returns (uint256) {
        _supply(s, lenders50[0], 100e6);
        vm.warp(block.timestamp + 60);
        (, uint256 id) = _loan(s, 10e6, 7);
        vm.warp(block.timestamp + 1 days);
        return _repay(s, id);
    }
    function sc_repay1LateBeyondCap(Stack memory s) internal returns (uint256) {
        _supply(s, lenders50[0], 100e6);
        vm.warp(block.timestamp + 60);
        (, uint256 id) = _loan(s, 10e6, 7);
        vm.warp(block.timestamp + 60 days);
        return _repay(s, id);
    }
    function sc_repay50(Stack memory s) internal returns (uint256) {
        for (uint256 i = 0; i < 50; i++) _supply(s, lenders50[i], 100e6);
        vm.warp(block.timestamp + 60);
        (, uint256 id) = _loan(s, 1000e6, 30);
        vm.warp(block.timestamp + 1 days);
        return _repay(s, id);
    }
    function sc_repay50WithTranches(Stack memory s) internal returns (uint256) {
        for (uint256 i = 0; i < 50; i++) _supply(s, lenders50[i], 100e6);
        vm.warp(block.timestamp + 60);
        (, uint256 id) = _loan(s, 1000e6, 30);
        vm.warp(block.timestamp + 60);
        for (uint256 i = 0; i < 50; i++) _supply(s, lenders50[i], 10e6); // every lender has a pending tranche
        vm.warp(block.timestamp + 1 days);
        return _repay(s, id);
    }
    function sc_liquidate50Lossy(Stack memory s) internal returns (uint256) {
        for (uint256 i = 0; i < 50; i++) _supply(s, lenders50[i], 100e6);
        vm.warp(block.timestamp + 60);
        (, uint256 id) = _loan(s, 1000e6, 7);
        vm.warp(block.timestamp + 8 days);
        return _liquidate(s, id);
    }
    function sc_liquidate50WithTranches(Stack memory s) internal returns (uint256) {
        for (uint256 i = 0; i < 50; i++) _supply(s, lenders50[i], 100e6);
        vm.warp(block.timestamp + 60);
        (, uint256 id) = _loan(s, 1000e6, 7);
        vm.warp(block.timestamp + 60);
        for (uint256 i = 0; i < 50; i++) _supply(s, lenders50[i], 10e6);
        vm.warp(block.timestamp + 8 days);
        return _liquidate(s, id); // _shrinkPendingProRata on all 50
    }
    function sc_liquidate50InterestSocialized(Stack memory s) internal returns (uint256) {
        for (uint256 i = 0; i < 50; i++) _supply(s, lenders50[i], 100e6);
        vm.warp(block.timestamp + 60);
        (, uint256 id) = _loan(s, 5000e6, 365);
        vm.warp(block.timestamp + 365 days);
        _repay(s, id); // ~250 USDC interest booked across 50 lenders
        for (uint256 i = 0; i < 50; i++) _withdraw(s, lenders50[i], 100e6); // principal gone
        vm.warp(block.timestamp + 60);
        (, uint256 id2) = _loan(s, 200e6, 7); // funded purely from unclaimed interest
        vm.warp(block.timestamp + 8 days);
        return _liquidate(s, id2); // loss 200 > Σ principal 0 → F-05 second pass (V6.1 only)
    }
    function sc_claim(Stack memory s) internal returns (uint256) {
        _supply(s, lenders50[0], 100e6);
        vm.warp(block.timestamp + 60);
        (, uint256 id) = _loan(s, 50e6, 30);
        vm.warp(block.timestamp + 30 days);
        _repay(s, id);
        return _claim(s, lenders50[0]);
    }

    // ------------------------------------------------------------ report
    function _row(string memory name, uint256 g60, uint256 g61) internal pure {
        string memory delta = g61 >= g60
            ? string.concat("+", vm.toString(g61 - g60))
            : string.concat("-", vm.toString(g60 - g61));
        console.log(string.concat("GAS | ", name, " | ", vm.toString(g60), " | ", vm.toString(g61), " | ", delta));
    }

    function test_gas_report() public {
        console.log("GAS | scenario | V6.0 | V6.1 | delta");
        _row("supplyLiquidity fresh (new slot)", sc_supplyFresh(_deploy(true)), sc_supplyFresh(_deploy(false)));
        _row("supplyLiquidity top-up, no loan in flight (base restamp)", sc_topUpNoLoan(_deploy(true)), sc_topUpNoLoan(_deploy(false)));
        _row("supplyLiquidity top-up mid-loan, first (pending create) (b)", sc_topUpPendingCreate(_deploy(true)), sc_topUpPendingCreate(_deploy(false)));
        _row("supplyLiquidity top-up merge (d)", sc_topUpMerge(_deploy(true)), sc_topUpMerge(_deploy(false)));
        _row("supplyLiquidity top-up fold (c)", sc_topUpFold(_deploy(true)), sc_topUpFold(_deploy(false)));
        _row("supplyLiquidity top-up fold with 10 active loans", sc_topUpFoldWith10Active(_deploy(true)), sc_topUpFoldWith10Active(_deploy(false)));
        _row("withdrawLiquidity partial with pending trim", sc_withdrawTrim(_deploy(true)), sc_withdrawTrim(_deploy(false)));
        _row("withdrawLiquidity full exit (slot freed)", sc_withdrawFullExit(_deploy(true)), sc_withdrawFullExit(_deploy(false)));
        _row("requestLoan (1 lender)", sc_requestLoan(_deploy(true)), sc_requestLoan(_deploy(false)));
        _row("repayLoan 1 lender, on time", sc_repay1(_deploy(true)), sc_repay1(_deploy(false)));
        _row("repayLoan 1 lender, 53d late (beyond cap)", sc_repay1LateBeyondCap(_deploy(true)), sc_repay1LateBeyondCap(_deploy(false)));
        _row("repayLoan 50 lenders, no tranches", sc_repay50(_deploy(true)), sc_repay50(_deploy(false)));
        _row("repayLoan 50 lenders, all with pending tranches", sc_repay50WithTranches(_deploy(true)), sc_repay50WithTranches(_deploy(false)));
        _row("liquidateLoan 50 lenders, lossy (principal)", sc_liquidate50Lossy(_deploy(true)), sc_liquidate50Lossy(_deploy(false)));
        _row("liquidateLoan 50 lenders, lossy, all with pending tranches", sc_liquidate50WithTranches(_deploy(true)), sc_liquidate50WithTranches(_deploy(false)));
        _row("liquidateLoan 50 lenders, loss > principal (interest socialized)", sc_liquidate50InterestSocialized(_deploy(true)), sc_liquidate50InterestSocialized(_deploy(false)));
        _row("claimInterest", sc_claim(_deploy(true)), sc_claim(_deploy(false)));
    }
}
