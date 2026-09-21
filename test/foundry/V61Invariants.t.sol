// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/core/AgentLiquidityMarketplaceV6.sol";
import "../../contracts/core/AgentRegistryV2.sol";
import "../../contracts/core/ReputationManagerV3.sol";
import "../../contracts/tokens/MockUSDC.sol";

/**
 * @title V61Invariants (2026-09-20 testing round for the V6.1 diff)
 * @notice Stateful invariant tests targeting the V6.1 changes (F-01/02/03/05/07):
 *   3 lenders x 2 agents (agent 1 pumped to the 0%-collateral tier so defaults
 *   produce REAL losses; agent 2 left at score 0 so every loan carries 100%
 *   collateral and exercises the collateral-return path), with handler ops for
 *   top-ups (tranche fold/merge/refuse), LIFO withdraws, on-time / late / beyond-
 *   cap repayments by borrower OR NFT holder, liquidations (incl. loss > Σ
 *   principal), interest claims, agent-NFT transfers and registry deactivation.
 *
 *   Invariants (checked after every handler call):
 *     (a)  balance + Σ totalLoaned == Σ amount + Σ earnedInterest + fees + Σ active collateral
 *          (and the two existing exact identities it is composed of)
 *     (b)  pendingTranche.amount <= position.amount for every (pool, lender);
 *          lenders not in poolLenders hold nothing
 *     (f)  activeLoanIds[agent] == the set of ACTIVE loans of that agent, length == activeLoanCount
 *     (g)  addressToAgentId[ownerOf(agentId)] == agentId (the F-01 premise)
 *     (h)  outstandingPrincipal[agent] == Σ ACTIVE principal (H-3)
 *   Call-time properties recorded as ghost violation counters (must stay 0):
 *     (c)  every lender's earnedInterest delta on repay == lenderInterest * qualifiedAmountAt / Σ qualifiedAmountAt
 *     (d)  a lender can always withdraw the full position.amount when availableLiquidity covers it
 *     (e)  interest paid == calculateInterest(principal, rate, max(duration, min(elapsed, duration + 30d))),
 *          and previewRepayment agrees
 *     (i)  canTopUp() is an exact oracle for the "Top-up would forfeit in-flight interest" revert
 *     (j)  repay: borrower / current holder never refused (and never revert), third party always refused;
 *          collateral always returns to loan.borrower
 *     (k)  liquidation of an overdue ACTIVE loan never reverts (even after NFT transfer);
 *          Σ principal reduced by exactly min(loss, Σ principal), Σ interest by exactly
 *          min(loss − principalReduced, Σ interest)
 *     (l)  a registry-deactivated agent can never open a loan
 */
contract V61InvariantTest is Test {
    AgentLiquidityMarketplaceV6 public v6;
    AgentRegistryV2 public registry;
    ReputationManagerV3 public reputation;
    MockUSDC public usdc;
    Handler61 public handler;

    address public owner = address(0xAAAA);
    address[2] public agents = [address(0xA1), address(0xA2)];
    address[2] public alts = [address(0xA1A1), address(0xA2A2)];
    address[3] public lenders = [address(0xB1), address(0xB2), address(0xB3)];

    function setUp() public {
        vm.startPrank(owner);
        registry = new AgentRegistryV2();
        reputation = new ReputationManagerV3(address(registry));
        usdc = new MockUSDC();
        v6 = new AgentLiquidityMarketplaceV6(address(registry), address(reputation), address(usdc));
        reputation.authorizePool(address(v6));
        reputation.authorizePool(owner);
        vm.stopPrank();

        AgentRegistryV2.MetadataEntry[] memory empty;
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(agents[i]);
            registry.register("ipfs://v61", empty);
            vm.prank(agents[i]);
            v6.createAgentPool();
        }
        // Agent 1 -> 0% collateral tier (score >= 600): defaults are lossy.
        vm.startPrank(owner);
        for (uint256 i = 0; i < 65; i++) {
            reputation.recordLoanCompletion(agents[0], 100e6, true);
        }
        vm.stopPrank();

        address[7] memory funded = [agents[0], agents[1], alts[0], alts[1], lenders[0], lenders[1], lenders[2]];
        for (uint256 i = 0; i < funded.length; i++) {
            vm.prank(owner);
            usdc.mint(funded[i], 1e12);
            vm.prank(funded[i]);
            usdc.approve(address(v6), type(uint256).max);
        }

        handler = new Handler61(v6, registry, usdc, agents, alts, lenders, owner);
        targetContract(address(handler));
    }

    // ---------------------------------------------------------------- helpers
    function _poolSums(uint256 aid) internal view returns (uint256 sumAmount, uint256 sumInterest, uint256 count) {
        (, , , , , , count) = v6.getAgentPool(aid);
        for (uint256 i = 0; i < count; i++) {
            (uint256 amount, uint256 earned, ) = v6.positions(aid, v6.poolLenders(aid, i));
            sumAmount += amount;
            sumInterest += earned;
        }
    }

    // ---------------------------------------------------------------- (a)
    function invariant_a_balance_identity() public view {
        uint256 sumAvail; uint256 sumLoaned; uint256 sumAmount; uint256 sumInterest;
        for (uint256 aid = 1; aid <= 2; aid++) {
            (, uint256 total, uint256 avail, uint256 loaned, , , ) = v6.getAgentPool(aid);
            (uint256 a, uint256 e, ) = _poolSums(aid);
            require(total == a, "a: totalLiquidity != sum amount");
            require(avail + loaned == a + e, "a: avail+loaned != sum(amount+interest)");
            sumAvail += avail; sumLoaned += loaned; sumAmount += a; sumInterest += e;
        }
        uint256 sumCollateral;
        uint256 n = v6.nextLoanId();
        for (uint256 id = 1; id < n; id++) {
            (, , , , uint256 coll, , , , , AgentLiquidityMarketplaceV6.LoanState st) = v6.loans(id);
            if (st == AgentLiquidityMarketplaceV6.LoanState.ACTIVE) sumCollateral += coll;
        }
        uint256 fees = v6.accumulatedFees();
        uint256 bal = usdc.balanceOf(address(v6));
        require(bal == sumAvail + fees + sumCollateral, "a: exact solvency broken");
        require(bal + sumLoaned == sumAmount + sumInterest + fees + sumCollateral, "a: balance identity broken");
    }

    // ---------------------------------------------------------------- (b)
    function invariant_b_pending_within_position() public view {
        for (uint256 aid = 1; aid <= 2; aid++) {
            for (uint256 i = 0; i < 3; i++) {
                address l = lenders[i];
                (uint256 amount, uint256 earned, uint256 ts) = v6.positions(aid, l);
                (uint128 pend, uint128 pts) = v6.pendingTranche(aid, l);
                require(pend <= amount, "b: pending > amount");
                if (pend > 0) require(pts >= ts, "b: pending stamped before base");
                if (!v6.isInPoolLenders(aid, l)) {
                    require(amount == 0 && earned == 0 && pend == 0, "b: non-member holds a position");
                }
            }
        }
    }

    // ---------------------------------------------------------------- (f)
    function invariant_f_activeLoanIds_consistent() public view {
        uint256 n = v6.nextLoanId();
        for (uint256 aid = 1; aid <= 2; aid++) {
            uint256[] memory ids = v6.getActiveLoanIds(aid);
            require(ids.length == v6.activeLoanCount(aid), "f: activeLoanIds.length != activeLoanCount");
            require(ids.length <= v6.MAX_ACTIVE_LOANS_PER_AGENT(), "f: over cap");
            uint256 live;
            for (uint256 id = 1; id < n; id++) {
                (, , uint256 laid, , , , , , , AgentLiquidityMarketplaceV6.LoanState st) = v6.loans(id);
                if (laid == aid && st == AgentLiquidityMarketplaceV6.LoanState.ACTIVE) live++;
            }
            require(live == ids.length, "f: live ACTIVE count != activeLoanIds.length");
            for (uint256 i = 0; i < ids.length; i++) {
                (, , uint256 laid, , , , , , , AgentLiquidityMarketplaceV6.LoanState st) = v6.loans(ids[i]);
                require(laid == aid && st == AgentLiquidityMarketplaceV6.LoanState.ACTIVE, "f: stale id in active set");
                for (uint256 j = i + 1; j < ids.length; j++) require(ids[i] != ids[j], "f: duplicate id");
            }
        }
    }

    // ---------------------------------------------------------------- (g) + (h)
    function invariant_g_holder_maps_back() public view {
        for (uint256 aid = 1; aid <= 2; aid++) {
            address h = registry.ownerOf(aid);
            require(registry.addressToAgentId(h) == aid, "g: holder does not map back to agentId");
        }
    }

    function invariant_h_outstanding_principal() public view {
        uint256 n = v6.nextLoanId();
        for (uint256 aid = 1; aid <= 2; aid++) {
            uint256 sum;
            for (uint256 id = 1; id < n; id++) {
                (, , uint256 laid, uint256 amount, , , , , , AgentLiquidityMarketplaceV6.LoanState st) = v6.loans(id);
                if (laid == aid && st == AgentLiquidityMarketplaceV6.LoanState.ACTIVE) sum += amount;
            }
            require(v6.outstandingPrincipal(aid) == sum, "h: outstandingPrincipal mismatch");
        }
    }

    // ---------------------------------------------------------------- ghost (c,d,e,i,j,k,l)
    function invariant_ghost_no_violations() public view {
        require(handler.vC() == 0, "c: qualified-share distribution mismatch");
        require(handler.vD() == 0, "d: full withdraw reverted despite liquidity");
        require(handler.vE() == 0, "e: interest != calculateInterest(max(dur, min(elapsed, dur+30d)))");
        require(handler.vI() == 0, "i: canTopUp disagreed with supplyLiquidity");
        require(handler.vJ() == 0, "j: repayer policy / collateral routing violated");
        require(handler.vK() == 0, "k: liquidation reverted or loss not socialized exactly");
        require(handler.vL() == 0, "l: deactivated agent opened a loan");
    }

    /// Prints the campaign profile once (foundry runs afterInvariant at the end of every run).
    function afterInvariant() public view {
        console.log("supplies ok / topups refused(e)", handler.nSupply(), handler.nTopUpRefused());
        console.log("withdraws / withdrawAll / drains / claims", handler.nWithdraw(), handler.nWithdrawAll(), handler.nDrain());
        console.log("claims", handler.nClaim());
        console.log("loans / repays / late", handler.nLoan(), handler.nRepay(), handler.nLate());
        console.log("beyondCap repays", handler.nBeyondCap());
        console.log("repay by holder!=borrower / 3rd-party refused", handler.nHolderRepay(), handler.nThirdPartyRefused());
        console.log("liquidations / lossy / loss>principal", handler.nLiq(), handler.nLiqLossy(), handler.nLiqOverPrincipal());
        console.log("liquidations with interest socialized", handler.nLiqInterestCut());
        console.log("nft transfers / deactivations / borrow-blocked", handler.nTransfer(), handler.nToggle(), handler.nBlockedInactive());
    }
}

/**
 * @title Handler61
 */
contract Handler61 is Test {
    AgentLiquidityMarketplaceV6 public v6;
    AgentRegistryV2 public registry;
    MockUSDC public usdc;
    address public owner;
    address[2] public agents;
    address[2] public alts;
    address[3] public lenders;
    address public stranger = address(0x5717A);

    uint256[] internal _open; // loan ids we believe ACTIVE

    // violation counters
    uint256 public vC; uint256 public vD; uint256 public vE; uint256 public vI; uint256 public vJ; uint256 public vK; uint256 public vL;
    // profile counters
    uint256 public nSupply; uint256 public nTopUpRefused; uint256 public nWithdraw; uint256 public nWithdrawAll; uint256 public nDrain; uint256 public nClaim;
    uint256 public nLoan; uint256 public nRepay; uint256 public nLate; uint256 public nBeyondCap; uint256 public nHolderRepay; uint256 public nThirdPartyRefused;
    uint256 public nLiq; uint256 public nLiqLossy; uint256 public nLiqOverPrincipal; uint256 public nLiqInterestCut;
    uint256 public nTransfer; uint256 public nToggle; uint256 public nBlockedInactive;

    constructor(
        AgentLiquidityMarketplaceV6 _v6, AgentRegistryV2 _reg, MockUSDC _usdc,
        address[2] memory _agents, address[2] memory _alts, address[3] memory _lenders, address _owner
    ) {
        v6 = _v6; registry = _reg; usdc = _usdc; agents = _agents; alts = _alts; lenders = _lenders; owner = _owner;
    }

    // ---------------------------------------------------------------- lender ops
    function supply(uint8 aSeed, uint8 lSeed, uint8 amountSeed) external {
        uint256 aid = uint256(aSeed) % 2 + 1;
        address lender = lenders[lSeed % 3];
        uint256 amount = (uint256(amountSeed) % 50 + 1) * 1e6;
        bool can = v6.canTopUp(aid, lender);
        // Model the real chain: the SDK reads the view against the latest block, the
        // tx lands in a LATER block (strictly greater timestamp). Same-timestamp
        // evaluation would hide the 2026-09-20 canTopUp bug (see V61PropertyFuzz).
        vm.warp(block.timestamp + 1);
        vm.prank(lender);
        try v6.supplyLiquidity(aid, amount) {
            nSupply++;
            if (!can) vI++; // oracle said refuse, contract accepted
        } catch Error(string memory reason) {
            if (keccak256(bytes(reason)) == keccak256("Top-up would forfeit in-flight interest")) {
                nTopUpRefused++;
                if (can) vI++; // oracle said ok, contract refused
            }
        } catch {}
    }

    function withdraw(uint8 aSeed, uint8 lSeed, uint8 amountSeed) external {
        uint256 aid = uint256(aSeed) % 2 + 1;
        address lender = lenders[lSeed % 3];
        (uint256 supplied, , ) = v6.positions(aid, lender);
        if (supplied == 0) return;
        uint256 amount = uint256(amountSeed) * supplied / 256;
        if (amount == 0) amount = 1;
        vm.prank(lender);
        try v6.withdrawLiquidity(aid, amount) { nWithdraw++; } catch {}
    }

    /// (d) full withdrawal must never be refused by tranche bookkeeping when liquidity covers it.
    function withdrawAll(uint8 aSeed, uint8 lSeed) external {
        uint256 aid = uint256(aSeed) % 2 + 1;
        address lender = lenders[lSeed % 3];
        (uint256 supplied, , ) = v6.positions(aid, lender);
        if (supplied == 0) return;
        (, , uint256 avail, , , , ) = v6.getAgentPool(aid);
        if (avail < supplied) return;
        vm.prank(lender);
        try v6.withdrawLiquidity(aid, supplied) {
            nWithdrawAll++;
            (uint256 after_, , ) = v6.positions(aid, lender);
            (uint128 pend, ) = v6.pendingTranche(aid, lender);
            if (after_ != 0 || pend != 0) vD++;
        } catch { vD++; }
    }

    /// Every lender pulls as much principal as availableLiquidity allows, leaving the
    /// pool backed (mostly) by unclaimed interest — the precondition for a default
    /// loss that exceeds Σ principal (F-05 second-pass socialization).
    function drainPrincipal(uint8 aSeed) external {
        uint256 aid = uint256(aSeed) % 2 + 1;
        for (uint256 i = 0; i < 3; i++) {
            (uint256 supplied, , ) = v6.positions(aid, lenders[i]);
            (, , uint256 avail, , , , ) = v6.getAgentPool(aid);
            uint256 w = supplied < avail ? supplied : avail;
            if (w == 0) continue;
            vm.prank(lenders[i]);
            try v6.withdrawLiquidity(aid, w) { nDrain++; } catch { vD++; }
        }
    }

    function claim(uint8 aSeed, uint8 lSeed) external {
        uint256 aid = uint256(aSeed) % 2 + 1;
        address lender = lenders[lSeed % 3];
        (, uint256 earned, ) = v6.positions(aid, lender);
        if (earned == 0) return;
        vm.prank(lender);
        try v6.claimInterest(aid) { nClaim++; } catch {}
    }

    // ---------------------------------------------------------------- borrower ops
    function requestLoan(uint8 aSeed, uint8 amountSeed, uint8 durSeed) external {
        uint256 aid = uint256(aSeed) % 2 + 1;
        address holder = registry.ownerOf(aid);
        (, , uint256 avail, , , , ) = v6.getAgentPool(aid);
        uint256 amt = (uint256(amountSeed) % 20 + 1) * 1e6;
        if (avail == 0) return;
        if (amt > avail) amt = avail; // sub-USDC loans: lets a drained pool lend its unclaimed interest
        uint256 durDays = 7 + (uint256(durSeed) % 60);
        bool active = registry.isAgentActive(holder);
        vm.prank(holder);
        try v6.requestLoan(amt, durDays) returns (uint256 lid) {
            nLoan++;
            _open.push(lid);
            if (!active) vL++;
        } catch Error(string memory reason) {
            if (keccak256(bytes(reason)) == keccak256("Agent deactivated")) nBlockedInactive++;
        } catch {}
    }

    struct RepayCtx {
        uint256 lid; address borrower; uint256 aid; uint256 amount; uint256 coll; uint256 rate;
        uint256 start; uint256 endTime; uint256 dur; uint256 expected; uint256 lenderInterest;
        uint256 n; uint256 qTotal; uint256 feesBefore; uint256 borrowerBal; uint256 payerBal;
    }

    /// Repay a loan on time, late, or beyond the 30d cap; by borrower, holder, or a stranger.
    function repayLoan(uint8 idxSeed, uint8 lateSeed, uint8 whoSeed) external {
        if (_open.length == 0) return;
        uint256 idx = uint256(idxSeed) % _open.length;
        RepayCtx memory c;
        c.lid = _open[idx];
        AgentLiquidityMarketplaceV6.LoanState st;
        (, c.borrower, c.aid, c.amount, c.coll, c.rate, c.start, c.endTime, c.dur, st) = v6.loans(c.lid);
        if (st != AgentLiquidityMarketplaceV6.LoanState.ACTIVE) { _drop(idx); return; }

        // time travel: 0 = now, 1 = inside term, 2 = 1..30d late, 3 = 31..90d late (beyond cap)
        // (time only ever moves forward — a backwards warp would be a harness artifact)
        uint256 mode = uint256(lateSeed) % 4;
        if (mode == 1) _warpTo(c.start + (uint256(lateSeed) * c.dur) / 256);
        else if (mode == 2) _warpTo(c.endTime + 1 + (uint256(lateSeed) % 30) * 1 days);
        else if (mode == 3) _warpTo(c.endTime + 31 days + (uint256(lateSeed) % 60) * 1 days);

        // (e) expected interest
        uint256 elapsed = block.timestamp - c.start;
        uint256 chargeable = elapsed > c.dur ? elapsed : c.dur;
        if (chargeable > c.dur + 30 days) chargeable = c.dur + 30 days;
        c.expected = v6.calculateInterest(c.amount, c.rate, chargeable);
        (uint256 pvInterest, uint256 pvTotal, uint256 pvCharge, uint256 pvLate) = v6.previewRepayment(c.lid);
        if (pvInterest != c.expected || pvTotal != c.amount + c.expected || pvCharge != chargeable
            || pvLate != (block.timestamp > c.endTime ? block.timestamp - c.endTime : 0)) vE++;
        uint256 fee = (c.expected * v6.platformFeeRate()) / 10000;
        c.lenderInterest = c.expected - fee;

        // (c) qualified snapshot
        (, , , , , , c.n) = v6.getAgentPool(c.aid);
        uint256[] memory q = new uint256[](c.n);
        uint256[] memory earnedBefore = new uint256[](c.n);
        address[] memory ls = new address[](c.n);
        for (uint256 i = 0; i < c.n; i++) {
            ls[i] = v6.poolLenders(c.aid, i);
            q[i] = v6.qualifiedAmountAt(c.aid, ls[i], c.start);
            (, earnedBefore[i], ) = v6.positions(c.aid, ls[i]);
            c.qTotal += q[i];
        }
        c.feesBefore = v6.accumulatedFees();

        // (j) who pays
        address holder = registry.ownerOf(c.aid);
        uint256 who = uint256(whoSeed) % 3;
        address payer = who == 0 ? c.borrower : (who == 1 ? holder : stranger);
        c.borrowerBal = usdc.balanceOf(c.borrower);
        c.payerBal = usdc.balanceOf(payer);

        vm.prank(payer);
        try v6.repayLoan(c.lid) {
            if (payer == stranger) { vJ++; _drop(idx); return; }
            nRepay++;
            if (block.timestamp > c.endTime) nLate++;
            if (elapsed > c.dur + 30 days) nBeyondCap++;
            if (payer != c.borrower) nHolderRepay++;
            _drop(idx);

            (, uint256 interestPaid, uint256 lateSeconds) = v6.repayments(c.lid);
            if (interestPaid != c.expected) vE++;
            if (lateSeconds != (block.timestamp > c.endTime ? block.timestamp - c.endTime : 0)) vE++;

            // (j) collateral to loan.borrower, principal+interest from payer
            if (payer == c.borrower) {
                if (usdc.balanceOf(c.borrower) != c.borrowerBal - (c.amount + c.expected) + c.coll) vJ++;
            } else {
                if (usdc.balanceOf(c.borrower) != c.borrowerBal + c.coll) vJ++;
                if (usdc.balanceOf(payer) != c.payerBal - (c.amount + c.expected)) vJ++;
            }

            // (c) distribution by qualified amount
            uint256 distributed;
            for (uint256 i = 0; i < c.n; i++) {
                (, uint256 earnedAfter, ) = v6.positions(c.aid, ls[i]);
                uint256 share = c.qTotal == 0 ? 0 : (c.lenderInterest * q[i]) / c.qTotal;
                if (earnedAfter != earnedBefore[i] + share) vC++;
                distributed += share;
            }
            if (v6.accumulatedFees() != c.feesBefore + fee + (c.lenderInterest - distributed)) vC++;
        } catch Error(string memory reason) {
            if (payer == stranger) {
                if (keccak256(bytes(reason)) == keccak256("Not the borrower")) nThirdPartyRefused++; else vJ++;
            } else {
                vJ++; // borrower/holder must never be refused (they are funded + approved)
            }
        } catch { vJ++; }
    }

    function liquidateLoan(uint8 idxSeed) external {
        if (_open.length == 0) return;
        uint256 idx = uint256(idxSeed) % _open.length;
        uint256 lid = _open[idx];
        (, , uint256 aid, uint256 amount, uint256 coll, , , uint256 endTime, , AgentLiquidityMarketplaceV6.LoanState st) = v6.loans(lid);
        if (st != AgentLiquidityMarketplaceV6.LoanState.ACTIVE) { _drop(idx); return; }
        if (block.timestamp <= endTime) vm.warp(endTime + 1);

        uint256 loss = amount > coll ? amount - coll : 0;
        (uint256 pBefore, uint256 eBefore) = _sums(aid);
        vm.prank(owner);
        try v6.liquidateLoan(lid) {
            nLiq++;
            _drop(idx);
            (uint256 pAfter, uint256 eAfter) = _sums(aid);
            uint256 expP = loss > pBefore ? pBefore : loss;
            uint256 rest = loss - expP;
            uint256 expE = rest > eBefore ? eBefore : rest;
            if (pBefore - pAfter != expP) vK++;
            if (eBefore - eAfter != expE) vK++;
            if (loss > 0) nLiqLossy++;
            if (loss > pBefore) nLiqOverPrincipal++;
            if (expE > 0) nLiqInterestCut++;
        } catch { vK++; }
    }

    // ---------------------------------------------------------------- identity ops
    function transferAgent(uint8 aSeed) external {
        if (aSeed % 4 == 0) return; // bias: keep the identity stable most of the time
        uint256 aid = uint256(aSeed) % 2 + 1;
        address holder = registry.ownerOf(aid);
        address to = holder == agents[aid - 1] ? alts[aid - 1] : agents[aid - 1];
        vm.prank(holder);
        try registry.transferFrom(holder, to, aid) { nTransfer++; } catch {}
    }

    function toggleActive(uint8 aSeed) external {
        if (aSeed % 4 != 0) return; // bias: deactivation is rare
        uint256 aid = uint256(aSeed) % 2 + 1;
        address holder = registry.ownerOf(aid);
        // [fix 2026-09-21] vm.prank applies to the NEXT call only; the isAgentActive
        // read below used to consume it, so deactivate/reactivate ran as the handler
        // and always reverted onlyOwner (silently caught) — the deactivation path
        // never fired in this campaign. Read first, prank immediately before the write.
        bool active = registry.isAgentActive(holder);
        if (active) {
            vm.prank(owner);
            try registry.deactivateAgent(aid) { nToggle++; } catch {}
        } else {
            vm.prank(owner);
            try registry.reactivateAgent(aid) { nToggle++; } catch {}
        }
    }

    function warpTime(uint16 secs) external {
        vm.warp(block.timestamp + (uint256(secs) % (30 days)) + 1);
    }

    function _warpTo(uint256 t) internal {
        if (t > block.timestamp) vm.warp(t);
    }

    // ---------------------------------------------------------------- internals
    function _sums(uint256 aid) internal view returns (uint256 p, uint256 e) {
        (, , , , , , uint256 count) = v6.getAgentPool(aid);
        for (uint256 i = 0; i < count; i++) {
            (uint256 amount, uint256 earned, ) = v6.positions(aid, v6.poolLenders(aid, i));
            p += amount; e += earned;
        }
    }

    function _drop(uint256 idx) internal {
        _open[idx] = _open[_open.length - 1];
        _open.pop();
    }
}
