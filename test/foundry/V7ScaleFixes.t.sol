// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/core/AgentLiquidityMarketplaceV62.sol";
import "../../contracts/core/AgentRegistryV2.sol";
import "../../contracts/core/ReputationManagerV4.sol";
import "../../contracts/tokens/MockUSDC.sol";

/**
 * @title V7ScaleFixes — regression suite for the V7 scale-and-gas must-fix list
 * @notice One test per finding in forensics/output/v7-model/V7_SCALE_AND_GAS_REPORT.md §6.
 *         Every test asserts the SECURE / FIXED property, so each one FAILS on the
 *         pre-fix contracts and PASSES after. Written before the fix, on purpose.
 *
 *         Run: forge test --isolate --match-path test/foundry/V7ScaleFixes.t.sol -vv
 */
contract V7ScaleFixesTest is Test {
    AgentRegistryV2 registry;
    ReputationManagerV4 rep;
    MockUSDC usdc;
    AgentLiquidityMarketplaceV62 mp;

    address owner = address(0xAAAA);
    address agent = address(0xA9E7);
    address victimLender = address(0xF00D);
    address[] squatters;

    uint256 constant MIN_SUPPLY = 10e6; // the live Arc-mainnet F-C lever

    function setUp() public {
        vm.startPrank(owner);
        registry = new AgentRegistryV2();
        rep = new ReputationManagerV4(address(registry));
        usdc = new MockUSDC();
        mp = new AgentLiquidityMarketplaceV62(address(registry), address(rep), address(usdc));
        rep.authorizePool(address(mp));
        rep.authorizePool(owner);
        mp.setMinSupplyAmount(MIN_SUPPLY);
        vm.stopPrank();

        AgentRegistryV2.MetadataEntry[] memory empty;
        vm.prank(agent);
        registry.register("ipfs://scale", empty);
        vm.prank(agent);
        mp.createAgentPool();

        _pump();

        for (uint256 i = 0; i < 60; i++) {
            address a = address(uint160(0xD000 + i));
            squatters.push(a);
            _fund(a);
        }
        _fund(agent);
        _fund(victimLender);
    }

    function _pump() internal {
        vm.prank(agent);
        rep.initializeReputation();
        vm.startPrank(owner);
        rep.setScoringParameters(50, 50, 100, 1000e6);
        uint256 synth = 1_000_000;
        while (rep.getReputationScore(1) < 800) {
            rep.recordBorrow(agent, synth, 100e6);
            vm.warp(block.timestamp + 7 days);
            rep.recordLoanCompletion(agent, synth, 100e6, true, 0);
            synth++;
        }
        rep.recordBorrow(agent, synth, 5000e6);
        vm.warp(block.timestamp + 7 days);
        rep.recordLoanCompletion(agent, synth, 5000e6, true, 0);
        rep.setScoringParameters(10, 50, 100, 1000e6);
        vm.stopPrank();
    }

    function _fund(address who) internal {
        vm.prank(owner);
        usdc.mint(who, 1e14);
        vm.prank(who);
        usdc.approve(address(mp), type(uint256).max);
    }

    function _log(string memory k, uint256 v) internal pure {
        console.log(string.concat("FIX | ", k, " | ", vm.toString(v)));
    }

    // =====================================================================
    // P1-1 — the lender-slot squat (report D1/D2, inherited F-06)
    // =====================================================================

    /// A slot may not be held by a sub-minimum dust position: a partial withdrawal
    /// that would leave 0 < remaining < minSupplyAmount is refused.
    function test_P1_squat_cannot_leave_a_dust_position() public {
        vm.prank(squatters[0]);
        mp.supplyLiquidity(1, MIN_SUPPLY);

        vm.prank(squatters[0]);
        vm.expectRevert("Remaining below minimum supply");
        mp.withdrawLiquidity(1, MIN_SUPPLY - 1);

        // 1 base unit below the floor is equally refused
        vm.prank(squatters[0]);
        vm.expectRevert("Remaining below minimum supply");
        mp.withdrawLiquidity(1, 1);

        // the squatter still holds the FULL minimum — the slot is not free
        (uint256 amt,,) = mp.positions(1, squatters[0]);
        assertEq(amt, MIN_SUPPLY, "position was reduced below the floor");
        _log("P1 capital a squatter must keep locked per slot", amt);
    }

    /// A lender must ALWAYS be able to leave completely. Full exit frees the slot.
    function test_P1_full_exit_is_always_allowed() public {
        vm.prank(squatters[0]);
        mp.supplyLiquidity(1, MIN_SUPPLY);
        (,,,,,, uint256 before_) = mp.getAgentPool(1);

        vm.prank(squatters[0]);
        mp.withdrawLiquidity(1, MIN_SUPPLY);

        (,,,,,, uint256 after_) = mp.getAgentPool(1);
        assertEq(after_, before_ - 1, "full exit did not free the slot");
        assertEq(usdc.balanceOf(squatters[0]), 1e14, "capital not fully returned");
    }

    /// A partial withdrawal that leaves the position AT or ABOVE the floor is fine.
    function test_P1_partial_withdrawal_above_the_floor_still_works() public {
        vm.prank(squatters[0]);
        mp.supplyLiquidity(1, 100e6);
        vm.prank(squatters[0]);
        mp.withdrawLiquidity(1, 90e6); // leaves exactly MIN_SUPPLY
        (uint256 amt,,) = mp.positions(1, squatters[0]);
        assertEq(amt, MIN_SUPPLY, "legitimate partial withdrawal was mangled");
    }

    /// The owner may RAISE minSupplyAmount after the fact. An existing position that
    /// is now below the new floor must still be fully withdrawable.
    function test_P1_position_below_a_raised_minimum_is_still_withdrawable() public {
        vm.prank(owner);
        mp.setMinSupplyAmount(1e6); // 1 USDC
        vm.prank(squatters[0]);
        mp.supplyLiquidity(1, 2e6); // legal at the time

        vm.prank(owner);
        mp.setMinSupplyAmount(100e6); // owner raises the floor to 100 USDC

        // partial is refused (it would leave a sub-floor slot holder)...
        vm.prank(squatters[0]);
        vm.expectRevert("Remaining below minimum supply");
        mp.withdrawLiquidity(1, 1e6);

        // ... but the full exit always works, and frees the slot
        vm.prank(squatters[0]);
        mp.withdrawLiquidity(1, 2e6);
        (uint256 amt,,) = mp.positions(1, squatters[0]);
        assertEq(amt, 0, "lender could not exit under a raised minimum");
        assertFalse(mp.isInPoolLenders(1, squatters[0]), "slot not released on full exit");
    }

    /// The pool creator is EXEMPT from the floor on both sides (it is exempt from
    /// minSupplyAmount on supply because M2-c can legitimately require less).
    function test_P1_creator_is_exempt_from_the_withdraw_floor() public {
        vm.prank(agent);
        mp.supplyLiquidity(1, 5e6); // below MIN_SUPPLY — the M2-a creator exemption
        vm.prank(agent);
        mp.withdrawLiquidity(1, 4e6); // leaves 1 USDC, below the floor: allowed
        (uint256 amt,,) = mp.positions(1, agent);
        assertEq(amt, 1e6, "creator self-stake blocked by the lender floor");
    }

    /// THE D2 ESCALATION: the last lender slot is RESERVED for the pool creator's
    /// M2-c self-stake, so a full squat can never make unsecured borrowing impossible.
    function test_P1_last_slot_is_reserved_for_the_creator_self_stake() public {
        // 49 third parties take every unreserved slot, each locking the real minimum
        for (uint256 i = 0; i < 49; i++) {
            vm.prank(squatters[i]);
            mp.supplyLiquidity(1, MIN_SUPPLY);
        }
        (,,,,,, uint256 count) = mp.getAgentPool(1);
        assertEq(count, 49, "third parties did not fill the unreserved slots");

        // the 50th THIRD PARTY is refused — that slot belongs to the agent
        vm.prank(squatters[49]);
        vm.expectRevert("Last slot reserved for agent self-stake");
        mp.supplyLiquidity(1, MIN_SUPPLY);

        // ... but the AGENT can always post its first-loss stake and borrow
        vm.prank(agent);
        mp.supplyLiquidity(1, 2_500e6);
        (,,,,,, uint256 count2) = mp.getAgentPool(1);
        assertEq(count2, 50, "creator could not claim the reserved slot");

        vm.warp(block.timestamp + 60);
        vm.prank(agent);
        uint256 id = mp.requestLoan(1_000e6, 7);
        assertGt(id, 0, "agent still cannot borrow on a squatted pool");
        _log("P1 loanId opened on a fully squatted pool", id);
    }

    /// Once the creator holds its slot the reservation is satisfied, so the pool is
    /// simply full at MAX_LENDERS_PER_POOL and the ordinary message is used.
    function test_P1_reservation_released_once_the_creator_holds_a_slot() public {
        vm.prank(agent);
        mp.supplyLiquidity(1, 2_500e6);
        for (uint256 i = 0; i < 49; i++) {
            vm.prank(squatters[i]);
            mp.supplyLiquidity(1, MIN_SUPPLY);
        }
        (,,,,,, uint256 count) = mp.getAgentPool(1);
        assertEq(count, 50, "pool did not reach the cap");
        vm.prank(squatters[49]);
        vm.expectRevert("Pool lender capacity reached");
        mp.supplyLiquidity(1, MIN_SUPPLY);
    }

    // =====================================================================
    // P1-2 — resetPoolAccounting must be O(active loans), not O(loan history)
    // =====================================================================
    function test_P1_resetPoolAccounting_is_flat_in_loan_history() public {
        vm.prank(agent);
        mp.supplyLiquidity(1, 2_500e6);
        vm.warp(block.timestamp + 60);

        uint256 g1;
        for (uint256 i = 0; i < 200; i++) {
            vm.prank(agent);
            uint256 id = mp.requestLoan(100e6, 7);
            vm.warp(block.timestamp + 8 days);
            vm.prank(agent);
            mp.repayLoan(id);
            if (i == 0) {
                vm.prank(owner);
                mp.resetPoolAccounting(1);
                g1 = vm.lastCallGas().gasTotalUsed;
            }
        }
        vm.prank(owner);
        mp.resetPoolAccounting(1);
        uint256 g200 = vm.lastCallGas().gasTotalUsed;

        _log("P1 resetPoolAccounting gas @1 loan of history", g1);
        _log("P1 resetPoolAccounting gas @200 loans of history", g200);
        assertLt(g200, g1 + 5_000, "resetPoolAccounting still grows with agentLoans[]");
    }

    /// It must still produce the right answer with loans OPEN.
    function test_P1_resetPoolAccounting_still_rebuilds_totalLoaned() public {
        vm.prank(agent);
        mp.supplyLiquidity(1, 2_500e6);
        vm.prank(victimLender);
        mp.supplyLiquidity(1, 5_000e6);
        vm.warp(block.timestamp + 60);

        vm.prank(agent);
        mp.requestLoan(400e6, 7);
        vm.prank(agent);
        mp.requestLoan(600e6, 7);

        vm.prank(owner);
        mp.resetPoolAccounting(1);
        (, uint256 totalLiq, uint256 avail, uint256 loaned,,,) = mp.getAgentPool(1);
        assertEq(loaned, 1_000e6, "totalLoaned not rebuilt from the active set");
        assertEq(totalLiq, 7_500e6, "totalLiquidity not rebuilt from positions");
        assertEq(avail, 6_500e6, "availableLiquidity not rebuilt");
    }

    /// The tool must be usable on a pool whose agent NFT has moved — it is agentId
    /// keyed now, so the old "resync via migration helpers" blocker is gone.
    function test_P1_resetPoolAccounting_works_after_an_nft_transfer() public {
        vm.prank(agent);
        mp.supplyLiquidity(1, 2_500e6);
        vm.warp(block.timestamp + 60);
        vm.prank(agent);
        mp.requestLoan(500e6, 7);

        address buyer = address(0xB0B);
        _fund(buyer);
        vm.prank(agent);
        registry.transferFrom(agent, buyer, 1);

        vm.prank(owner);
        mp.resetPoolAccounting(1); // must not revert
        (,,, uint256 loaned,,,) = mp.getAgentPool(1);
        assertEq(loaned, 500e6, "totalLoaned wrong after transfer");
    }

    // =====================================================================
    // P2-3 — loanId namespace per authorized marketplace (report D9)
    // =====================================================================
    function test_P2_two_marketplaces_do_not_collide_on_loanId() public {
        vm.startPrank(owner);
        AgentLiquidityMarketplaceV62 mp2 =
            new AgentLiquidityMarketplaceV62(address(registry), address(rep), address(usdc));
        rep.authorizePool(address(mp2));
        vm.stopPrank();
        vm.prank(agent);
        usdc.approve(address(mp2), type(uint256).max);
        vm.prank(agent);
        mp2.createAgentPool();

        vm.prank(agent);
        mp.supplyLiquidity(1, 2_500e6);
        vm.prank(agent);
        mp2.supplyLiquidity(1, 2_500e6);
        vm.warp(block.timestamp + 60);

        vm.prank(agent);
        uint256 idA = mp.requestLoan(100e6, 7);
        assertEq(idA, 1, "first marketplace loanId");

        // SECURE PROPERTY: the second marketplace's loanId 1 is a DIFFERENT record
        vm.prank(agent);
        uint256 idB = mp2.requestLoan(100e6, 7);
        assertEq(idB, 1, "second marketplace loanId");

        (uint128 amtA, uint64 startA,) = rep.openLoans(address(mp), idA);
        (uint128 amtB, uint64 startB,) = rep.openLoans(address(mp2), idB);
        assertGt(startA, 0, "marketplace A record missing");
        assertGt(startB, 0, "marketplace B record missing");
        assertEq(amtA, 100e6);
        assertEq(amtB, 100e6);

        // closing one must not disturb the other
        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        mp.repayLoan(idA);
        (, uint64 startAafter,) = rep.openLoans(address(mp), idA);
        (, uint64 startBafter,) = rep.openLoans(address(mp2), idB);
        assertEq(startAafter, 0, "A not closed");
        assertEq(startBafter, startB, "closing A disturbed B");
    }

    // =====================================================================
    // P2-4 — requiredSelfStake must survive an agent-NFT transfer (report D13)
    // =====================================================================
    function test_P2_requiredSelfStake_survives_an_nft_transfer() public {
        vm.prank(agent);
        mp.supplyLiquidity(1, 2_500e6);
        uint256 before_ = mp.requiredSelfStake(1, 1_000e6);
        assertGt(before_, 0, "no stake demanded before transfer");

        address buyer = address(0xB0B);
        _fund(buyer);
        vm.prank(agent);
        registry.transferFrom(agent, buyer, 1);

        uint256 after_ = mp.requiredSelfStake(1, 1_000e6);
        _log("P2 requiredSelfStake before transfer", before_);
        _log("P2 requiredSelfStake after transfer", after_);
        assertEq(after_, before_, "the view still collapses after an NFT transfer");

        // and the agentId-keyed collateral view on V4 agrees with the tier
        assertEq(rep.collateralRequirementOf(1), 0, "tier lost on transfer");
    }

    // =====================================================================
    // P2-5 — getActiveAgents must be paginable (report D8)
    // =====================================================================
    function test_P2_getActiveAgents_is_paginable() public {
        AgentRegistryV2.MetadataEntry[] memory empty;
        for (uint256 i = 0; i < 9; i++) {
            address a = address(uint160(0x100000 + i));
            vm.prank(a);
            registry.register("ipfs://page", empty);
            vm.prank(a);
            mp.createAgentPool();
        }
        assertEq(mp.totalPools(), 10, "pool count");

        uint256[] memory all = mp.getActiveAgents();
        assertEq(all.length, 10, "unpaginated overload changed shape");

        // walk the whole set in pages of 4 and reassemble it
        uint256[] memory seen = new uint256[](10);
        uint256 k = 0;
        uint256 cursor = 0;
        while (cursor < mp.totalPools()) {
            (uint256[] memory page, uint256 next) = mp.getActiveAgents(cursor, 4);
            for (uint256 i = 0; i < page.length; i++) seen[k++] = page[i];
            assertGt(next, cursor, "cursor did not advance");
            cursor = next;
        }
        assertEq(k, 10, "pagination lost entries");
        for (uint256 i = 0; i < 10; i++) assertEq(seen[i], all[i], "page order differs");

        // out-of-range start is empty, not a revert
        (uint256[] memory none, uint256 nx) = mp.getActiveAgents(100, 4);
        assertEq(none.length, 0);
        assertEq(nx, mp.totalPools());
        _log("P2 pages walked over totalPools", mp.totalPools());
    }
}
