// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/core/AgentLiquidityMarketplaceV6.sol";
import "../../contracts/core/AgentLiquidityMarketplaceV62.sol";
import "../../contracts/core/AgentRegistryV2.sol";
import "../../contracts/core/ReputationManagerV3.sol";
import "../../contracts/core/ReputationManagerV4.sol";
import "../../contracts/tokens/MockUSDC.sol";

/**
 * @title V7Gas — V6.1 (+ReputationManagerV3) vs V6.2 (+ReputationManagerV4) execution gas
 * @notice Same scenario driven against both stacks, fresh and identical per scenario.
 *         Metering is `vm.lastCallGas().gasTotalUsed` under `--isolate`, i.e. every
 *         measured call is its own transaction with cold storage — the same method the
 *         2026-09-21 V6.0-vs-V6.1 report used, so the numbers are continuous with it.
 *
 *         Pool composition is IDENTICAL on both stacks: index 0 of the lender set is
 *         the agent itself (in V6.2 the M2-c self-stake forces the borrower to occupy a
 *         lender slot; making V6.1 do the same keeps `poolLenders.length` equal so the
 *         bounded loops iterate the same number of times on both sides).
 *
 *         Run: forge test --isolate --match-path test/foundry/V7Gas.t.sol -vv
 */
contract V7GasTest is Test {
    struct Stack {
        AgentRegistryV2 registry;
        ReputationManagerV3 rep3;
        ReputationManagerV4 rep4;
        MockUSDC usdc;
        AgentLiquidityMarketplaceV6 mp; // ABI view — selectors are identical on V6.2
        bool v62;
    }

    address owner = address(0xAAAA);
    address agent = address(0xA9E7);
    address[] lenders;

    uint256 constant N_LENDERS = 50;

    function setUp() public {
        for (uint256 i = 0; i < N_LENDERS + 2; i++) lenders.push(address(uint160(0xB000 + i)));
    }

    // ------------------------------------------------------------------ stacks

    function _deploy(bool v62) internal returns (Stack memory s) {
        s.v62 = v62;
        vm.startPrank(owner);
        s.registry = new AgentRegistryV2();
        s.usdc = new MockUSDC();
        address mp;
        if (v62) {
            s.rep4 = new ReputationManagerV4(address(s.registry));
            mp = address(new AgentLiquidityMarketplaceV62(address(s.registry), address(s.rep4), address(s.usdc)));
            s.rep4.authorizePool(mp);
            s.rep4.authorizePool(owner);
        } else {
            s.rep3 = new ReputationManagerV3(address(s.registry));
            mp = address(new AgentLiquidityMarketplaceV6(address(s.registry), address(s.rep3), address(s.usdc)));
            s.rep3.authorizePool(mp);
            s.rep3.authorizePool(owner);
        }
        s.mp = AgentLiquidityMarketplaceV6(mp);
        vm.stopPrank();

        AgentRegistryV2.MetadataEntry[] memory empty;
        vm.prank(agent);
        s.registry.register("ipfs://gas", empty);
        vm.prank(agent);
        s.mp.createAgentPool();

        _pumpToTopTier(s);

        _fund(s, agent);
        for (uint256 i = 0; i < lenders.length; i++) _fund(s, lenders[i]);
    }

    /// @dev Drive the agent to the 0 %-collateral top tier on either manager, and (V6.2)
    ///      give the ladder enough head-room for a 5,000 USDC line.
    function _pumpToTopTier(Stack memory s) internal {
        vm.startPrank(owner);
        if (s.v62) {
            vm.stopPrank();
            vm.prank(agent);
            s.rep4.initializeReputation(); // score 100
            vm.startPrank(owner);
            s.rep4.setScoringParameters(50, 50, 100, 1000e6); // faster pump
            uint256 synth = 1_000_000;
            while (s.rep4.getReputationScore(1) < 800) {
                s.rep4.recordBorrow(agent, synth, 100e6);
                vm.warp(block.timestamp + 7 days);
                s.rep4.recordLoanCompletion(agent, synth, 100e6, true, 0);
                synth++;
            }
            // one big on-time repayment so the ladder clears the 5,000 tier cap
            s.rep4.recordBorrow(agent, synth, 5000e6);
            vm.warp(block.timestamp + 7 days);
            s.rep4.recordLoanCompletion(agent, synth, 5000e6, true, 0);
            s.rep4.setScoringParameters(10, 50, 100, 1000e6); // back to shipped defaults
        } else {
            for (uint256 i = 0; i < 65; i++) s.rep3.recordLoanCompletion(agent, 100e6, true);
        }
        vm.stopPrank();
    }

    function _fund(Stack memory s, address who) internal {
        vm.prank(owner);
        s.usdc.mint(who, 1e14);
        vm.prank(who);
        s.usdc.approve(address(s.mp), type(uint256).max);
    }

    /// @dev Lender slot `i`. Slot 0 is the agent's own position on BOTH stacks.
    function _l(uint256 i) internal view returns (address) {
        return i == 0 ? agent : lenders[i];
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

    // ------------------------------------------------------------- composition

    /// @dev Fill the pool to exactly `n` lender slots. Slot 0 (the agent) gets
    ///      `selfStake` so the M2-c gate is satisfied on V6.2; the rest get `each`.
    function _fill(Stack memory s, uint256 n, uint256 selfStake, uint256 each) internal {
        if (n == 0) return;
        _supply(s, agent, selfStake);
        for (uint256 i = 1; i < n; i++) _supply(s, _l(i), each);
    }

    // ------------------------------------------------------------- scenarios

    // ---- supplyLiquidity -------------------------------------------------

    /// fresh slot: the n'th lender joining a pool that already holds n-1 entries.
    /// At n == 1 this is the very first supply into an empty pool (cold pool slots).
    function sc_supplyFresh(Stack memory s, uint256 n) internal returns (uint256) {
        _fill(s, n - 1, 500e6, 100e6);
        if (n > 1) vm.warp(block.timestamp + 60);
        return _supply(s, _l(n - 1), 100e6);
    }

    /// top-up with no loan in flight — case (a), base tranche restamped
    function sc_topUpBase(Stack memory s, uint256 n) internal returns (uint256) {
        _fill(s, n, 500e6, 100e6);
        vm.warp(block.timestamp + 60);
        return _supply(s, _l(n - 1), 50e6);
    }

    /// top-up mid-loan, first one — case (b), pending tranche created
    function sc_topUpPendingCreate(Stack memory s, uint256 n) internal returns (uint256) {
        _fill(s, n, 500e6, 100e6);
        vm.warp(block.timestamp + 60);
        _loan(s, 500e6, 7);
        vm.warp(block.timestamp + 60);
        return _supply(s, _l(n - 1), 50e6);
    }

    /// top-up merge — case (d): pending exists, no ACTIVE loan since it was stamped
    function sc_topUpMerge(Stack memory s, uint256 n) internal returns (uint256) {
        _fill(s, n, 500e6, 100e6);
        vm.warp(block.timestamp + 60);
        _loan(s, 500e6, 7);
        vm.warp(block.timestamp + 60);
        _supply(s, _l(n - 1), 50e6); // creates pending
        vm.warp(block.timestamp + 60);
        return _supply(s, _l(n - 1), 50e6); // (d)
    }

    /// top-up fold — case (c): pending qualified exactly as the base is
    function sc_topUpFold(Stack memory s, uint256 n) internal returns (uint256) {
        _fill(s, n, 500e6, 100e6);
        vm.warp(block.timestamp + 60);
        (, uint256 a) = _loan(s, 500e6, 7);
        vm.warp(block.timestamp + 60);
        _supply(s, _l(n - 1), 50e6); // pending while A is in flight
        vm.warp(block.timestamp + 60);
        _repay(s, a);
        _loan(s, 500e6, 7); // B starts after the pending stamp
        vm.warp(block.timestamp + 60);
        return _supply(s, _l(n - 1), 50e6); // (c) fold
    }

    /// worst-case supply: fold with the active-loan set at its 10-entry cap
    function sc_topUpFold10Active(Stack memory s, uint256 n) internal returns (uint256) {
        _fill(s, n, 2000e6, 100e6);
        vm.warp(block.timestamp + 60);
        (, uint256 a) = _loan(s, 100e6, 7);
        vm.warp(block.timestamp + 60);
        _supply(s, _l(n - 1), 50e6);
        vm.warp(block.timestamp + 60);
        _repay(s, a);
        for (uint256 i = 0; i < 10; i++) {
            _loan(s, 300e6, 7);
            vm.warp(block.timestamp + 1);
        }
        return _supply(s, _l(n - 1), 50e6); // scans the full 10-entry active set twice
    }

    // ---- requestLoan -----------------------------------------------------

    function sc_requestLoan(Stack memory s, uint256 n) internal returns (uint256) {
        _fill(s, n, 500e6, 100e6);
        vm.warp(block.timestamp + 60);
        (uint256 g, ) = _loan(s, 500e6, 7);
        return g;
    }

    /// requestLoan with every lender carrying a pending tranche
    function sc_requestLoanTranches(Stack memory s, uint256 n) internal returns (uint256) {
        _fill(s, n, 2000e6, 100e6);
        vm.warp(block.timestamp + 60);
        (, uint256 a) = _loan(s, 100e6, 7);
        vm.warp(block.timestamp + 60);
        for (uint256 i = 0; i < n; i++) _supply(s, _l(i), 10e6); // pending on all
        vm.warp(block.timestamp + 60);
        _repay(s, a);
        vm.warp(block.timestamp + 60);
        (uint256 g, ) = _loan(s, 500e6, 7);
        return g;
    }

    /// the 10th (last legal) concurrent loan
    function sc_requestLoan10th(Stack memory s, uint256 n) internal returns (uint256) {
        _fill(s, n, 2000e6, 100e6);
        vm.warp(block.timestamp + 60);
        for (uint256 i = 0; i < 9; i++) {
            _loan(s, 300e6, 7);
            vm.warp(block.timestamp + 1);
        }
        (uint256 g, ) = _loan(s, 300e6, 7);
        return g;
    }

    // ---- repayLoan -------------------------------------------------------

    function _repayScenario(
        Stack memory s,
        uint256 n,
        bool tranches,
        bool tenActive,
        uint256 lateDays
    ) internal returns (uint256) {
        uint256 amt = tenActive ? 300e6 : 500e6;
        _fill(s, n, 2000e6, 100e6);
        vm.warp(block.timestamp + 60);

        uint256 target;
        if (tenActive) {
            for (uint256 i = 0; i < 10; i++) {
                (, uint256 id) = _loan(s, amt, 7);
                if (i == 0) target = id;
                vm.warp(block.timestamp + 1);
            }
        } else {
            (, target) = _loan(s, amt, 7);
        }

        if (tranches) {
            vm.warp(block.timestamp + 60);
            for (uint256 i = 0; i < n; i++) _supply(s, _l(i), 10e6);
        }

        vm.warp(block.timestamp + (lateDays == 0 ? 1 days : 7 days + lateDays * 1 days));
        return _repay(s, target);
    }

    // ---- liquidateLoan ---------------------------------------------------

    /// Lossy liquidation, every lender carrying a pending tranche (V6.1's worst case).
    /// The creator holds the MINIMUM legal self-stake (loan/2 at k = 2), so on V6.2 the
    /// first-loss pass covers only half the loss and `_socializeLoss` still runs.
    function sc_liquidateTranches(Stack memory s, uint256 n) internal returns (uint256) {
        uint256 amt = n == 1 ? 100e6 : 200e6;
        _fill(s, n, 100e6, 100e6);
        vm.warp(block.timestamp + 60);
        (, uint256 id) = _loan(s, amt, 7);
        vm.warp(block.timestamp + 60);
        for (uint256 i = 0; i < n; i++) _supply(s, _l(i), 10e6);
        vm.warp(block.timestamp + 8 days);
        return _liquidate(s, id);
    }

    /**
     * WORST CASE. Every socialisation path runs in one call:
     *   - `n` lender slots, all carrying principal, unclaimed interest AND a pending tranche
     *   - the self-stake first-loss pass takes the creator's whole position
     *   - L7 pass 1 (qualified basis) cannot cover the loss, so pass 2 (whole principal) runs
     *   - the loss still exceeds Σ principal, so `_socializeInterestLoss` runs (3 loops)
     *   - every lender ends empty, so `_pruneEmptyLenders` pops all `n` slots
     */
    function sc_liquidateWorstCase(Stack memory s, uint256 n) internal returns (uint256) {
        // 1. seed principal and book interest on every lender
        _fill(s, n, 2500e6, 100e6);
        vm.warp(block.timestamp + 60);
        (, uint256 a) = _loan(s, 2000e6, 365);
        vm.warp(block.timestamp + 365 days);
        _repay(s, a); // ~100 USDC of interest spread over all n lenders
        vm.warp(block.timestamp + 60);

        // 2. drain almost all principal so the defaulting loan is funded from unclaimed
        //    interest, and leave the creator holding EXACTLY the minimum self-stake
        for (uint256 i = 1; i < n; i++) _withdraw(s, _l(i), 100e6 - 1); // leave 1 base unit
        _withdraw(s, agent, 2500e6 - 25e6); // self-stake := 25 USDC
        vm.warp(block.timestamp + 60);

        // 3. the loan that will default: 50 USDC, i.e. 2 × the self-stake, so the
        //    first-loss pass cannot cover it (k = 2 is the maximum leverage M2-c allows)
        (, uint256 id) = _loan(s, 50e6, 7);
        vm.warp(block.timestamp + 60);

        // 4. everyone tops up AFTER the loan started → pending tranches that are NOT
        //    qualified for it, so L7 pass 1 under-covers and pass 2 must run. Dust-sized
        //    so Σ principal stays far below the loss and the interest pass runs too.
        for (uint256 i = 0; i < n; i++) _supply(s, _l(i), 100);

        vm.warp(block.timestamp + 8 days);
        uint256 interestBefore = _sumInterest(s, n);
        uint256 g = _liquidate(s, id);

        // Proof that every path in the waterfall actually ran:
        //  (1) M2-b first loss — the creator's whole position is gone
        (uint256 selfAmt, , ) = s.mp.positions(1, agent);
        assertEq(selfAmt, 0, "worst case: self-stake was not fully absorbed");
        if (n > 1) {
            //  (2) L7 pass 2 — a third party's UNQUALIFIED pending dust was taken too
            //      (pass 1's basis for it was only its 1-base-unit base tranche)
            (uint256 otherAmt, , ) = s.mp.positions(1, _l(1));
            assertEq(otherAmt, 0, "worst case: L7 pass 2 did not run");
        }
        //  (3) F-05 interest socialisation — unclaimed interest was reduced
        assertLt(_sumInterest(s, n), interestBefore, "worst case: interest was not socialized");
        return g;
    }

    function _sumInterest(Stack memory s, uint256 n) internal view returns (uint256 t) {
        for (uint256 i = 0; i < n; i++) {
            (, uint256 e, ) = s.mp.positions(1, _l(i));
            t += e;
        }
    }

    // ---- other paths -----------------------------------------------------

    /// @dev Measured on a THIRD-PARTY lender (slot 1): the creator's own position is
    ///      locked while the agent borrows (M2-a), which is itself measured separately.
    function sc_withdrawTrim(Stack memory s, uint256 n) internal returns (uint256) {
        _fill(s, n, 500e6, 100e6);
        vm.warp(block.timestamp + 60);
        _loan(s, 300e6, 7);
        vm.warp(block.timestamp + 60);
        _supply(s, _l(1), 50e6); // pending 50
        return _withdraw(s, _l(1), 30e6); // LIFO trims the pending tranche
    }

    function sc_withdrawFull(Stack memory s, uint256 n) internal returns (uint256) {
        _fill(s, n, 500e6, 100e6);
        vm.warp(block.timestamp + 60);
        return _withdraw(s, _l(n - 1), 100e6); // frees the slot
    }

    function sc_claim(Stack memory s, uint256 n) internal returns (uint256) {
        _fill(s, n, 500e6, 100e6);
        vm.warp(block.timestamp + 60);
        (, uint256 id) = _loan(s, 500e6, 30);
        vm.warp(block.timestamp + 30 days);
        _repay(s, id);
        return _claim(s, _l(n - 1));
    }

    function sc_compact(Stack memory s, uint256 n) internal returns (uint256) {
        _fill(s, n, 500e6, 100e6);
        vm.prank(owner);
        s.mp.compactPoolLenders(1);
        return vm.lastCallGas().gasTotalUsed;
    }

    function sc_reset(Stack memory s, uint256 n) internal returns (uint256) {
        _fill(s, n, 500e6, 100e6);
        vm.warp(block.timestamp + 60);
        (, uint256 id) = _loan(s, 100e6, 7);
        vm.warp(block.timestamp + 7 days);
        _repay(s, id);
        vm.prank(owner);
        s.mp.resetPoolAccounting(1);
        return vm.lastCallGas().gasTotalUsed;
    }

    function sc_createPool(Stack memory s) internal returns (uint256) {
        address fresh = address(0xC0FFEE);
        AgentRegistryV2.MetadataEntry[] memory empty;
        vm.prank(fresh);
        s.registry.register("ipfs://fresh", empty);
        vm.prank(fresh);
        s.mp.createAgentPool();
        return vm.lastCallGas().gasTotalUsed;
    }

    function sc_register(Stack memory s) internal returns (uint256) {
        address fresh = address(0xDECAF);
        AgentRegistryV2.MetadataEntry[] memory empty;
        vm.prank(fresh);
        s.registry.register("ipfs://fresh2", empty);
        return vm.lastCallGas().gasTotalUsed;
    }

    // ------------------------------------------------------------ reporting

    function _row(string memory name, uint256 g61, uint256 g62) internal pure {
        string memory delta;
        if (g62 >= g61) {
            delta = string.concat("+", vm.toString(g62 - g61));
        } else {
            delta = string.concat("-", vm.toString(g61 - g62));
        }
        string memory pct = g61 == 0
            ? "n/a"
            : string.concat(
                g62 >= g61 ? "+" : "-",
                vm.toString(g62 >= g61 ? ((g62 - g61) * 1000) / g61 : ((g61 - g62) * 1000) / g61),
                "permil"
            );
        console.log(string.concat("GAS | ", name, " | ", vm.toString(g61), " | ", vm.toString(g62), " | ", delta, " | ", pct));
    }

    function _rowOne(string memory name, uint256 g) internal pure {
        console.log(string.concat("GAS1 | ", name, " | ", vm.toString(g)));
    }

    uint256[4] Ns = [uint256(1), 10, 25, 50];

    function test_gas_supply() public {
        console.log("GAS | scenario | V6.1 | V6.2 | delta | permil");
        for (uint256 k = 0; k < 4; k++) {
            uint256 n = Ns[k];
            _row(string.concat("supplyLiquidity fresh slot @N=", vm.toString(n)), sc_supplyFresh(_deploy(false), n), sc_supplyFresh(_deploy(true), n));
        }
        for (uint256 k = 0; k < 4; k++) {
            uint256 n = Ns[k];
            _row(string.concat("supplyLiquidity top-up base (a) @N=", vm.toString(n)), sc_topUpBase(_deploy(false), n), sc_topUpBase(_deploy(true), n));
        }
        for (uint256 k = 0; k < 4; k++) {
            uint256 n = Ns[k];
            _row(string.concat("supplyLiquidity pending create (b) @N=", vm.toString(n)), sc_topUpPendingCreate(_deploy(false), n), sc_topUpPendingCreate(_deploy(true), n));
        }
        for (uint256 k = 0; k < 4; k++) {
            uint256 n = Ns[k];
            _row(string.concat("supplyLiquidity merge (d) @N=", vm.toString(n)), sc_topUpMerge(_deploy(false), n), sc_topUpMerge(_deploy(true), n));
        }
        for (uint256 k = 0; k < 4; k++) {
            uint256 n = Ns[k];
            _row(string.concat("supplyLiquidity fold (c) @N=", vm.toString(n)), sc_topUpFold(_deploy(false), n), sc_topUpFold(_deploy(true), n));
        }
        _row("supplyLiquidity fold, 10 active loans @N=50", sc_topUpFold10Active(_deploy(false), 50), sc_topUpFold10Active(_deploy(true), 50));
    }

    function test_gas_requestLoan() public {
        console.log("GAS | scenario | V6.1 | V6.2 | delta | permil");
        for (uint256 k = 0; k < 4; k++) {
            uint256 n = Ns[k];
            _row(string.concat("requestLoan @N=", vm.toString(n)), sc_requestLoan(_deploy(false), n), sc_requestLoan(_deploy(true), n));
        }
        for (uint256 k = 0; k < 4; k++) {
            uint256 n = Ns[k];
            _row(string.concat("requestLoan, all lenders w/ pending @N=", vm.toString(n)), sc_requestLoanTranches(_deploy(false), n), sc_requestLoanTranches(_deploy(true), n));
        }
        _row("requestLoan 10th concurrent loan @N=50", sc_requestLoan10th(_deploy(false), 50), sc_requestLoan10th(_deploy(true), 50));
    }

    function test_gas_repayLoan() public {
        console.log("GAS | scenario | V6.1 | V6.2 | delta | permil");
        for (uint256 k = 0; k < 4; k++) {
            uint256 n = Ns[k];
            _row(string.concat("repayLoan on time, no tranches @N=", vm.toString(n)), _repayScenario(_deploy(false), n, false, false, 0), _repayScenario(_deploy(true), n, false, false, 0));
        }
        for (uint256 k = 0; k < 4; k++) {
            uint256 n = Ns[k];
            _row(string.concat("repayLoan on time, all tranches @N=", vm.toString(n)), _repayScenario(_deploy(false), n, true, false, 0), _repayScenario(_deploy(true), n, true, false, 0));
        }
        _row("repayLoan, 10 active loans, tranches @N=50", _repayScenario(_deploy(false), 50, true, true, 0), _repayScenario(_deploy(true), 50, true, true, 0));
        _row("repayLoan 3d late (inside cap), tranches @N=50", _repayScenario(_deploy(false), 50, true, false, 3), _repayScenario(_deploy(true), 50, true, false, 3));
        _row("repayLoan 53d late (beyond cap), tranches @N=50", _repayScenario(_deploy(false), 50, true, false, 53), _repayScenario(_deploy(true), 50, true, false, 53));
        _row("repayLoan 53d late, 10 active, tranches @N=50 [WORST]", _repayScenario(_deploy(false), 50, true, true, 53), _repayScenario(_deploy(true), 50, true, true, 53));
    }

    function test_gas_liquidate() public {
        console.log("GAS | scenario | V6.1 | V6.2 | delta | permil");
        for (uint256 k = 0; k < 4; k++) {
            uint256 n = Ns[k];
            _row(string.concat("liquidateLoan lossy, all tranches @N=", vm.toString(n)), sc_liquidateTranches(_deploy(false), n), sc_liquidateTranches(_deploy(true), n));
        }
        for (uint256 k = 0; k < 4; k++) {
            uint256 n = Ns[k];
            _row(string.concat("liquidateLoan WORST (all paths) @N=", vm.toString(n)), sc_liquidateWorstCase(_deploy(false), n), sc_liquidateWorstCase(_deploy(true), n));
        }
    }

    /**
     * ReputationManagerV4 (M1) measured directly, against ReputationManagerV3 where the
     * function exists on both. `history` is the number of prior completed loans on the
     * agent, to show the manager carries no per-agent unbounded state.
     */
    function _repGas(Stack memory s, uint256 history) internal {
        string memory tag = string.concat("@history=", vm.toString(history));
        vm.startPrank(owner);
        uint256 synth = 9_000_000;
        for (uint256 i = 0; i < history; i++) {
            if (s.v62) {
                s.rep4.recordBorrow(agent, synth + i, 50e6);
                vm.warp(block.timestamp + 8 days);
                s.rep4.recordLoanCompletion(agent, synth + i, 50e6, true, 0);
            } else {
                s.rep3.recordLoanCompletion(agent, 50e6, true);
            }
        }
        uint256 id = synth + history + 1;
        uint256 gBorrow;
        uint256 gOnTime;
        uint256 gLate;
        uint256 gDefault;
        if (s.v62) {
            s.rep4.recordBorrow(agent, id, 50e6);
            gBorrow = vm.lastCallGas().gasTotalUsed;
            vm.warp(block.timestamp + 8 days);
            s.rep4.recordLoanCompletion(agent, id, 50e6, true, 0);
            gOnTime = vm.lastCallGas().gasTotalUsed;

            s.rep4.recordBorrow(agent, id + 1, 50e6);
            vm.warp(block.timestamp + 40 days);
            s.rep4.recordLoanCompletion(agent, id + 1, 50e6, false, 33 days);
            gLate = vm.lastCallGas().gasTotalUsed;

            s.rep4.recordBorrow(agent, id + 2, 50e6);
            vm.warp(block.timestamp + 8 days);
            s.rep4.recordDefault(agent, id + 2, 50e6);
            gDefault = vm.lastCallGas().gasTotalUsed;
        } else {
            s.rep3.recordBorrow(agent, 50e6);
            gBorrow = vm.lastCallGas().gasTotalUsed;
            vm.warp(block.timestamp + 8 days);
            s.rep3.recordLoanCompletion(agent, 50e6, true);
            gOnTime = vm.lastCallGas().gasTotalUsed;
            s.rep3.recordLoanCompletion(agent, 50e6, false);
            gLate = vm.lastCallGas().gasTotalUsed;
            s.rep3.recordDefault(agent, 50e6);
            gDefault = vm.lastCallGas().gasTotalUsed;
        }
        vm.stopPrank();

        // views (these run INSIDE requestLoan, so their cost is on the hot path)
        uint256 gLimit;
        uint256 gCollat;
        if (s.v62) {
            s.rep4.calculateCreditLimit(agent);
            gLimit = vm.lastCallGas().gasTotalUsed;
            s.rep4.calculateCollateralRequirement(agent);
            gCollat = vm.lastCallGas().gasTotalUsed;
        } else {
            s.rep3.calculateCreditLimit(agent);
            gLimit = vm.lastCallGas().gasTotalUsed;
            s.rep3.calculateCollateralRequirement(agent);
            gCollat = vm.lastCallGas().gasTotalUsed;
        }
        s.mp.getAgentPool(1); // warm-up no-op so the next call is comparable
        uint256 gStake = 0;
        if (s.v62) {
            AgentLiquidityMarketplaceV62(address(s.mp)).requiredSelfStake(1, 100e6);
            gStake = vm.lastCallGas().gasTotalUsed;
        }

        string memory v = s.v62 ? "V6.2/RMV4" : "V6.1/RMV3";
        _rowOne(string.concat(v, " recordBorrow ", tag), gBorrow);
        _rowOne(string.concat(v, " recordLoanCompletion on-time ", tag), gOnTime);
        _rowOne(string.concat(v, " recordLoanCompletion LATE ", tag), gLate);
        _rowOne(string.concat(v, " recordDefault ", tag), gDefault);
        _rowOne(string.concat(v, " calculateCreditLimit (view) ", tag), gLimit);
        _rowOne(string.concat(v, " calculateCollateralRequirement (view) ", tag), gCollat);
        _rowOne(string.concat(v, " requiredSelfStake (view) ", tag), gStake);
    }

    function test_gas_reputation() public {
        _repGas(_deploy(false), 0);
        _repGas(_deploy(true), 0);
        _repGas(_deploy(false), 500);
        _repGas(_deploy(true), 500);
    }

    function test_gas_other() public {
        console.log("GAS | scenario | V6.1 | V6.2 | delta | permil");
        uint256[4] memory Ns2 = [uint256(2), 10, 25, 50]; // needs a third-party lender slot
        for (uint256 k = 0; k < 4; k++) {
            uint256 n = Ns2[k];
            _row(string.concat("withdrawLiquidity LIFO trim @N=", vm.toString(n)), sc_withdrawTrim(_deploy(false), n), sc_withdrawTrim(_deploy(true), n));
        }
        for (uint256 k = 0; k < 4; k++) {
            uint256 n = Ns[k];
            _row(string.concat("withdrawLiquidity full exit @N=", vm.toString(n)), sc_withdrawFull(_deploy(false), n), sc_withdrawFull(_deploy(true), n));
        }
        for (uint256 k = 0; k < 4; k++) {
            uint256 n = Ns[k];
            _row(string.concat("claimInterest @N=", vm.toString(n)), sc_claim(_deploy(false), n), sc_claim(_deploy(true), n));
        }
        _row("compactPoolLenders @N=50 (admin)", sc_compact(_deploy(false), 50), sc_compact(_deploy(true), 50));
        _row("resetPoolAccounting @N=50, 1 loan of history (admin)", sc_reset(_deploy(false), 50), sc_reset(_deploy(true), 50));
        _row("createAgentPool", sc_createPool(_deploy(false)), sc_createPool(_deploy(true)));
        _row("registry.register", sc_register(_deploy(false)), sc_register(_deploy(true)));
    }
}
