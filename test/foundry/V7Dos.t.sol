// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/core/AgentLiquidityMarketplaceV62.sol";
import "../../contracts/core/AgentLiquidityMarketplaceV6.sol";
import "../../contracts/core/AgentRegistryV2.sol";
import "../../contracts/core/ReputationManagerV3.sol";
import "../../contracts/core/ReputationManagerV4.sol";
import "../../contracts/tokens/MockUSDC.sol";

/**
 * @title V7Dos — DoS / griefing attempts against V6.2 + ReputationManagerV4
 * @notice Each test is a concrete attack attempt with its outcome asserted, so the
 *         report's matrix is reproducible. Run with `--isolate` for realistic gas.
 *         Run: forge test --isolate --match-path test/foundry/V7Dos.t.sol -vv
 */
contract V7DosTest is Test {
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
        registry.register("ipfs://dos", empty);
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
        console.log(string.concat("DOS | ", k, " | ", vm.toString(v)));
    }

    // =====================================================================
    // D1 — lender-slot squat: fill all 50 slots for dust and keep them forever
    // [FIXED 2026-09-22] `minSupplyAmount` is now a MAINTAINED floor. A partial
    // withdrawal may not leave 0 < remaining < minSupplyAmount, so the dust squat
    // is refused outright and a slot costs the full minimum, permanently.
    // =====================================================================
    function test_D1_slot_squat_is_permanent_and_nearly_free() public {
        vm.prank(squatters[0]);
        mp.supplyLiquidity(1, MIN_SUPPLY);

        // THE ATTACK: take the slot, then pull it all back but one base unit.
        vm.prank(squatters[0]);
        vm.expectRevert("Remaining below minimum supply");
        mp.withdrawLiquidity(1, MIN_SUPPLY - 1);

        // the squatter is left holding the full floor, or nothing at all
        (uint256 amt, , ) = mp.positions(1, squatters[0]);
        assertEq(amt, MIN_SUPPLY, "dust squat still possible");

        // the only way out is a full exit, which releases the slot
        vm.prank(squatters[0]);
        mp.withdrawLiquidity(1, MIN_SUPPLY);
        (, , , , , , uint256 lenderCount) = mp.getAgentPool(1);
        assertEq(lenderCount, 0, "full exit did not release the slot");

        _log("D1 capital a squatter must now lock per slot (base units)", MIN_SUPPLY);
        _log("D1 capital for a full 49-slot third-party squat", MIN_SUPPLY * 49);
    }

    // =====================================================================
    // D2 — the V6.2 increment: a squatted pool bricks the agent's own borrowing
    // [FIXED 2026-09-22] The last of the 50 slots is RESERVED for the pool
    // creator's M2-c self-stake, so a squat can never make unsecured borrowing
    // impossible — no matter how much capital the attacker is willing to lock.
    // =====================================================================
    function test_D2_squat_blocks_unsecured_borrowing_entirely() public {
        // the attacker now has to lock the real minimum, and gets only 49 slots
        for (uint256 i = 0; i < 49; i++) {
            vm.prank(squatters[i]);
            mp.supplyLiquidity(1, MIN_SUPPLY);
        }
        vm.prank(squatters[49]);
        vm.expectRevert("Last slot reserved for agent self-stake");
        mp.supplyLiquidity(1, MIN_SUPPLY);

        // 0 %-collateral tier → M2-c demands a self-stake, and the agent CAN post it
        assertEq(rep.calculateCollateralRequirement(agent), 0, "agent is not on a 0% tier");
        assertGt(mp.requiredSelfStake(1, 100e6), 0, "no self-stake demanded");
        vm.prank(agent);
        mp.supplyLiquidity(1, 2_500e6);
        (uint256 stake, ) = mp.selfStake(1);
        assertEq(stake, 2_500e6, "agent could not claim the reserved slot");

        vm.warp(block.timestamp + 60);
        vm.prank(agent);
        uint256 id = mp.requestLoan(100e6, 7);
        assertGt(id, 0, "agent still cannot borrow on a squatted pool");

        (, , , , , , uint256 after_) = mp.getAgentPool(1);
        assertEq(after_, 50, "unexpected slot count");
        _log("D2 loanId opened against a fully squatted pool", id);
        // RESIDUAL, unchanged and accepted: the squat still denies the pool
        // third-party liquidity — but now at 49 x minSupplyAmount of genuinely
        // locked, at-risk capital, which is simply "being a lender".
    }

    // =====================================================================
    // D3 — a squat raises ANOTHER party's repayLoan cost
    // [PARTIALLY FIXED] The gas curve is inherent to MAX_LENDERS_PER_POOL and is
    // unchanged; what changed is the price. Every one of the 49 slots now costs
    // the attacker a full, locked, at-risk minSupplyAmount instead of 1 base unit.
    // =====================================================================
    function test_D3_squat_raises_borrower_repay_cost() public {
        // baseline: agent-only pool, one repay
        vm.prank(agent);
        mp.supplyLiquidity(1, 2_500e6);
        vm.warp(block.timestamp + 60);
        vm.prank(agent);
        uint256 id = mp.requestLoan(1_000e6, 7);
        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        mp.repayLoan(id);
        uint256 cheap = vm.lastCallGas().gasTotalUsed;

        // attacker takes the remaining 49 slots — at the FULL floor each, now that
        // the dust withdrawal is refused
        for (uint256 i = 0; i < 49; i++) {
            vm.prank(squatters[i]);
            mp.supplyLiquidity(1, MIN_SUPPLY);
        }
        _log("D3 USDC the attacker must lock for the 49 slots", MIN_SUPPLY * 49);
        vm.warp(block.timestamp + 60);
        vm.prank(agent);
        uint256 id2 = mp.requestLoan(1_000e6, 7);
        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        mp.repayLoan(id2);
        uint256 dear = vm.lastCallGas().gasTotalUsed;

        _log("D3 repayLoan gas, 1 lender", cheap);
        _log("D3 repayLoan gas, 50 lenders (49 are dust squatters)", dear);
        _log("D3 gas the attacker added to every future repay", dear - cheap);
        assertGt(dear, cheap + 100_000, "squat did not materially raise the repay cost");
    }

    // =====================================================================
    // D4 — a squat raises another lender's withdraw / exit cost
    // [PARTIALLY FIXED] Same as D3: the linear `_removePoolLender` search is
    // unchanged and bounded (154x headroom); the slots now cost real capital.
    // =====================================================================
    function test_D4_squat_raises_lender_exit_cost() public {
        vm.prank(agent);
        mp.supplyLiquidity(1, 2_500e6);
        vm.prank(victimLender);
        mp.supplyLiquidity(1, 1_000e6);
        vm.prank(victimLender);
        mp.withdrawLiquidity(1, 1_000e6);
        uint256 cheap = vm.lastCallGas().gasTotalUsed;

        for (uint256 i = 0; i < 48; i++) {
            vm.prank(squatters[i]);
            mp.supplyLiquidity(1, MIN_SUPPLY);
        }
        vm.prank(victimLender);
        mp.supplyLiquidity(1, 1_000e6);
        vm.prank(victimLender);
        mp.withdrawLiquidity(1, 1_000e6);
        uint256 dear = vm.lastCallGas().gasTotalUsed;

        _log("D4 withdraw full-exit gas, 2 lenders", cheap);
        _log("D4 withdraw full-exit gas, 50 lenders", dear);
        _log("D4 added gas", dear - cheap);
    }

    // =====================================================================
    // D5 — activeLoanIds: fill to the cap and thrash it
    // =====================================================================
    function test_D5_activeLoanIds_cap_and_thrash() public {
        vm.prank(agent);
        mp.supplyLiquidity(1, 2_500e6);
        vm.prank(victimLender);
        mp.supplyLiquidity(1, 5_000e6);
        vm.warp(block.timestamp + 60);

        uint256[] memory ids = new uint256[](10);
        for (uint256 i = 0; i < 10; i++) {
            vm.prank(agent);
            ids[i] = mp.requestLoan(400e6, 7);
            vm.warp(block.timestamp + 1);
        }
        vm.prank(agent);
        vm.expectRevert("Too many active loans");
        mp.requestLoan(1e6, 7);

        // thrash: repay the OLDEST (worst case for the swap-and-pop search) and reopen
        uint256 worst;
        for (uint256 round = 0; round < 20; round++) {
            vm.warp(block.timestamp + 1 days);
            vm.prank(agent);
            mp.repayLoan(ids[0]);
            uint256 g = vm.lastCallGas().gasTotalUsed;
            if (g > worst) worst = g;
            vm.prank(agent);
            ids[0] = mp.requestLoan(400e6, 7);
        }
        assertEq(mp.getActiveLoanIds(1).length, 10, "active set drifted");
        _log("D5 worst repayLoan gas while thrashing a full 10-entry active set", worst);
    }

    // =====================================================================
    // D6 — ladder / maxRepaidPrincipal over hundreds of loans: no state growth
    // =====================================================================
    function test_D6_ladder_over_hundreds_of_loans_is_flat() public {
        vm.prank(agent);
        mp.supplyLiquidity(1, 2_500e6);
        vm.warp(block.timestamp + 60);

        uint256 first;
        uint256 last;
        for (uint256 i = 0; i < 300; i++) {
            vm.prank(agent);
            uint256 id = mp.requestLoan(100e6, 7);
            vm.warp(block.timestamp + 7 days); // exactly at endTime → ON TIME
            vm.prank(agent);
            mp.repayLoan(id);
            uint256 g = vm.lastCallGas().gasTotalUsed;
            if (i == 0) first = g;
            if (i == 299) last = g;
        }
        _log("D6 repayLoan #1 gas", first);
        _log("D6 repayLoan #300 gas", last);
        _log("D6 maxRepaidPrincipal", rep.maxRepaidPrincipal(1));
        _log("D6 creditLimitOf", rep.creditLimitOf(1));
        assertLt(last, first + 5000, "repay gas grows with loan history");
    }

    // =====================================================================
    // D7 — agentLoans[] grows without bound; resetPoolAccounting walks it
    // [FIXED 2026-09-22] `resetPoolAccounting` rebuilds totalLoaned from
    // `activeLoanIds[agentId]` (<= MAX_ACTIVE_LOANS_PER_AGENT = 10), not from the
    // append-only `agentLoans[]`. `agentLoans[]` still grows without bound, but
    // nothing iterates it on any reachable path any more.
    // =====================================================================
    function test_D7_agentLoans_unbounded_breaks_resetPoolAccounting() public {
        vm.prank(agent);
        mp.supplyLiquidity(1, 2_500e6);
        vm.warp(block.timestamp + 60);

        uint256 g1;
        for (uint256 i = 0; i < 400; i++) {
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
        uint256 g400 = vm.lastCallGas().gasTotalUsed;

        _log("D7 resetPoolAccounting gas @1 loan", g1);
        _log("D7 resetPoolAccounting gas @400 loans", g400);
        // SECURE PROPERTY: flat in loan history. (It falls slightly, because the
        // 400-loan call runs with warmer pool storage than the very first one.)
        assertLt(g400, g1 + 5_000, "resetPoolAccounting is still history-dependent");
        assertLt(g400, 10_000_000, "resetPoolAccounting lost 3x block headroom");
    }

    // =====================================================================
    // D8 — agentPoolIds grows without bound; getActiveAgents walks it
    // =====================================================================
    function test_D8_agentPoolIds_unbounded_view() public {
        AgentRegistryV2.MetadataEntry[] memory empty;
        uint256 g1;
        for (uint256 i = 0; i < 500; i++) {
            address a = address(uint160(0x100000 + i));
            vm.prank(a);
            registry.register("ipfs://spam", empty);
            vm.prank(a);
            mp.createAgentPool();
            if (i == 0) {
                mp.getActiveAgents();
                g1 = vm.lastCallGas().gasTotalUsed;
            }
        }
        mp.getActiveAgents();
        uint256 g500 = vm.lastCallGas().gasTotalUsed;
        uint256 perPool = (g500 - g1) / 499;
        _log("D8 getActiveAgents gas @2 pools", g1);
        _log("D8 getActiveAgents gas @501 pools", g500);
        _log("D8 marginal gas per pool", perPool);
        _log("D8 pools until the view exceeds 30M", perPool == 0 ? 0 : 30_000_000 / perPool);
        _log("D8 totalPools", mp.totalPools());
    }

    // =====================================================================
    // D9 — ReputationManagerV4 loanId namespace is GLOBAL, not per-marketplace
    // [FIXED 2026-09-22] `openLoansByKey` is keyed by keccak(marketplace, loanId).
    // =====================================================================
    function test_D9_two_authorized_marketplaces_collide_on_loanId() public {
        // a second V6.2 authorized on the SAME reputation manager (the shape of a
        // side-by-side migration) restarts nextLoanId at 1
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

        // SECURE PROPERTY: the second marketplace's loanId 1 no longer collides
        vm.prank(agent);
        uint256 idB = mp2.requestLoan(100e6, 7);
        assertEq(idB, 1, "second marketplace loanId");

        (uint128 amtA, uint64 startA, ) = rep.openLoans(address(mp), idA);
        (uint128 amtB, uint64 startB, ) = rep.openLoans(address(mp2), idB);
        assertGt(startA, 0, "marketplace A record missing");
        assertGt(startB, 0, "marketplace B record missing");
        assertEq(amtA, 100e6);
        assertEq(amtB, 100e6);
        assertTrue(rep.loanKey(address(mp), idA) != rep.loanKey(address(mp2), idB), "keys collide");

        // closing one leaves the other untouched
        vm.warp(block.timestamp + 1 days);
        vm.prank(agent);
        mp.repayLoan(idA);
        (, uint64 startAafter, ) = rep.openLoans(address(mp), idA);
        (, uint64 startBafter, ) = rep.openLoans(address(mp2), idB);
        assertEq(startAafter, 0, "A not closed");
        assertEq(startBafter, startB, "closing A disturbed B");
        _log("D9 two marketplaces coexist on one ReputationManagerV4", 1);
    }

    // =====================================================================
    // D10 — the self-stake is frozen for as long as the owner does not liquidate
    // =====================================================================
    function test_D10_self_stake_frozen_until_owner_liquidates() public {
        vm.prank(agent);
        mp.supplyLiquidity(1, 2_500e6);
        vm.warp(block.timestamp + 60);
        vm.prank(agent);
        uint256 id = mp.requestLoan(1_000e6, 7);

        vm.warp(block.timestamp + 3650 days); // ten years overdue, owner never acts
        vm.prank(agent);
        vm.expectRevert("Self-stake locked while borrowing");
        mp.withdrawLiquidity(1, 1);

        (uint256 amt, bool locked) = mp.selfStake(1);
        assertTrue(locked, "stake should still be locked");
        _log("D10 USDC frozen in the creator position after 10 years", amt);

        // only the owner can end it
        vm.prank(owner);
        mp.liquidateLoan(id);
        (, bool locked2) = mp.selfStake(1);
        assertFalse(locked2, "stake still locked after liquidation");
    }

    // =====================================================================
    // D11 — can a third party push the agent below its required self-stake?
    // =====================================================================
    function test_D11_third_party_cannot_invalidate_self_stake() public {
        vm.prank(agent);
        mp.supplyLiquidity(1, 500e6);
        vm.prank(victimLender);
        mp.supplyLiquidity(1, 1_000e6);
        vm.warp(block.timestamp + 60);
        vm.prank(agent);
        mp.requestLoan(1_000e6, 7);

        uint256 need = mp.requiredSelfStake(1, 0);
        (uint256 have, ) = mp.selfStake(1);
        assertGe(have, need, "stake below requirement at open");

        // a lender leaving cannot reduce the agent's position, only pool liquidity
        vm.prank(victimLender);
        vm.expectRevert("Insufficient pool liquidity");
        mp.withdrawLiquidity(1, 1_000e6);
        (uint256 have2, ) = mp.selfStake(1);
        assertEq(have2, have, "third party moved the agent's stake");
        _log("D11 required self-stake", need);
        _log("D11 held self-stake", have2);
    }

    // =====================================================================
    // D12 — pause() freezes repayment, exits and liquidation simultaneously
    // =====================================================================
    function test_D12_pause_blocks_the_whole_close_path() public {
        vm.prank(agent);
        mp.supplyLiquidity(1, 2_500e6);
        vm.warp(block.timestamp + 60);
        vm.prank(agent);
        uint256 id = mp.requestLoan(1_000e6, 7);
        vm.warp(block.timestamp + 30 days);

        vm.prank(owner);
        mp.pause();

        vm.prank(agent);
        vm.expectRevert();
        mp.repayLoan(id);
        vm.prank(owner);
        vm.expectRevert();
        mp.liquidateLoan(id);
        vm.prank(agent);
        vm.expectRevert();
        mp.withdrawLiquidity(1, 1);
        _log("D12 repay/liquidate/withdraw all blocked while paused", 1);
    }

    // =====================================================================
    // D13 — `requiredSelfStake` view collapses to 0 after an agent-NFT transfer
    // [VIEW FIXED 2026-09-22] The tier is resolved by agentId, so the view and the
    // transaction now agree. The ECONOMIC half of the finding is UNCHANGED and
    // still requires the M-1 lever: the M2 self-stake belongs to pool.agentAddress
    // (the seller), and with M-1 off the buyer borrows against it. Asserted below.
    // =====================================================================
    function test_D13_requiredSelfStake_view_wrong_after_nft_transfer() public {
        vm.prank(agent);
        mp.supplyLiquidity(1, 2_500e6);
        uint256 before_ = mp.requiredSelfStake(1, 1_000e6);
        assertGt(before_, 0, "no stake demanded before transfer");

        address buyer = address(0xB0B);
        _fund(buyer);
        vm.prank(agent);
        registry.transferFrom(agent, buyer, 1);

        // SECURE PROPERTY: the view resolves the collateral tier by agentId, which
        // follows the agent NFT, so it no longer collapses to "no stake required".
        uint256 after_ = mp.requiredSelfStake(1, 1_000e6);
        _log("D13 requiredSelfStake before NFT transfer", before_);
        _log("D13 requiredSelfStake after NFT transfer", after_);
        assertEq(after_, before_, "view still collapses after an NFT transfer");

        // RESIDUAL (unchanged, M-1 mitigates): requestLoan evaluates the tier of the
        // CALLER and the stake of
        // pool.agentAddress. With the M-1 lever off, the BUYER borrows unsecured against
        // the SELLER's locked first-loss capital, and the seller cannot withdraw it.
        vm.prank(owner);
        mp.setBindBorrowToPoolCreator(false);
        vm.warp(block.timestamp + 60);
        vm.prank(buyer);
        mp.requestLoan(1_000e6, 7);

        (uint256 stakeAmt, bool locked) = mp.selfStake(1);
        (uint256 buyerPos, , ) = mp.positions(1, buyer);
        assertEq(buyerPos, 0, "buyer posted stake after all");
        assertGt(stakeAmt, 0, "no first-loss stake at risk");
        assertTrue(locked, "seller's stake is not locked");
        _log("D13 first-loss capital at risk, owned by the SELLER", stakeAmt);
        vm.prank(agent);
        vm.expectRevert("Self-stake locked while borrowing");
        mp.withdrawLiquidity(1, 1);
    }
}
