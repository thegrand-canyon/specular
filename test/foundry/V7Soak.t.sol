// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/core/AgentLiquidityMarketplaceV62.sol";
import "../../contracts/core/AgentRegistryV2.sol";
import "../../contracts/core/ReputationManagerV4.sol";
import "../../contracts/tokens/MockUSDC.sol";

/**
 * @title V7Soak — one long randomised sequence over the V7 stack
 * @notice A SINGLE monotonically-growing state (not a Foundry invariant campaign, which
 *         resets between runs) so that per-op gas drift as state grows is measurable.
 *         5 agents × 10 lenders, seeded PRNG, time travel, defaults, liquidations, NFT
 *         transfers, registry deactivations, ladder growth and post-default lockouts.
 *
 *         Every V7 invariant is asserted after EVERY successful operation:
 *           (a)  exact solvency: USDC held == Σ availableLiquidity + fees + Σ active collateral
 *           (a2) per-pool conservation: totalLiquidity == Σ amount,
 *                avail + totalLoaned == Σ amount + Σ earnedInterest
 *           (b)  pendingTranche.amount <= position.amount
 *           (h)  outstandingPrincipal == Σ ACTIVE principal (ghost-tracked)
 *           (M2a) selfStake().locked == (outstandingPrincipal > 0), exactly
 *           (M2)  selfStake().amount == positions[agentId][pool creator].amount
 *           (q)  creditLimitOf <= tierLimit(score) <= MAX_TIER_LIMIT
 *           (M1) maxRepaidPrincipal is monotone non-decreasing, except a reset to
 *                exactly 0 in the same op as a default
 *
 *         SOAK_OPS overrides the op count. Run:
 *           forge test --match-path test/foundry/V7Soak.t.sol -vv
 */
contract V7SoakTest is Test {
    AgentRegistryV2 registry;
    ReputationManagerV4 rep;
    MockUSDC usdc;
    AgentLiquidityMarketplaceV62 mp;

    address owner = address(0xAAAA);
    uint256 constant NAGENTS = 5;
    uint256 constant NLENDERS = 10;
    address[NAGENTS] agents;
    address[NAGENTS] spares; // NFT transfer destinations
    address[NLENDERS] lenders;

    uint256 seed = 0x5EC0A7;

    // ghosts
    uint256 ghostCollateral;             // Σ collateral of ACTIVE loans
    uint256[NAGENTS + 1] ghostOutstanding; // agentId => Σ ACTIVE principal
    uint256[NAGENTS + 1] lastMaxRepaid;
    bool defaultedThisOp;

    // profile
    uint256 opsAttempted;
    uint256 opsExecuted;
    uint256 violations;
    mapping(bytes32 => uint256) profile;
    string[] profileKeys;

    // gas drift: 10 deciles × per-op-type accumulators
    uint256[10] gasRepaySum;
    uint256[10] gasRepayN;
    uint256[10] gasSupplySum;
    uint256[10] gasSupplyN;
    uint256[10] gasLoanSum;
    uint256[10] gasLoanN;
    uint256[10] gasLiqSum;
    uint256[10] gasLiqN;

    uint256 totalOps;
    uint256 opIndex;

    function setUp() public {
        vm.startPrank(owner);
        registry = new AgentRegistryV2();
        rep = new ReputationManagerV4(address(registry));
        usdc = new MockUSDC();
        mp = new AgentLiquidityMarketplaceV62(address(registry), address(rep), address(usdc));
        rep.authorizePool(address(mp));
        rep.authorizePool(owner);
        mp.setMinSupplyAmount(1e6);
        mp.setMinHoldForReputationReward(0);
        vm.stopPrank();

        AgentRegistryV2.MetadataEntry[] memory empty;
        for (uint256 i = 0; i < NAGENTS; i++) {
            agents[i] = address(uint160(0xA000 + i));
            spares[i] = address(uint160(0xE000 + i));
            vm.prank(agents[i]);
            registry.register("ipfs://soak", empty);
            vm.prank(agents[i]);
            mp.createAgentPool();
            vm.prank(agents[i]);
            rep.initializeReputation();
            _fund(agents[i]);
            _fund(spares[i]);
        }
        for (uint256 i = 0; i < NLENDERS; i++) {
            lenders[i] = address(uint160(0xB000 + i));
            _fund(lenders[i]);
        }

        // spread the agents across tiers: 0 and 1 to the 0 %-collateral top tier,
        // 2 to the 75 % tier, 3 and 4 left at the 100 %-collateral floor
        vm.startPrank(owner);
        rep.setScoringParameters(50, 50, 100, 1000e6);
        _pump(1, 800, 2000e6);
        _pump(2, 800, 2000e6);
        _pump(3, 520, 1000e6);
        rep.setScoringParameters(10, 50, 100, 1000e6);
        vm.stopPrank();

        for (uint256 a = 1; a <= NAGENTS; a++) lastMaxRepaid[a] = rep.maxRepaidPrincipal(a);
    }

    function _pump(uint256 agentId, uint256 target, uint256 big) internal {
        address a = agents[agentId - 1];
        uint256 synth = agentId * 1_000_000;
        while (rep.getReputationScore(agentId) < target) {
            rep.recordBorrow(a, synth, 100e6);
            vm.warp(block.timestamp + 7 days);
            rep.recordLoanCompletion(a, synth, 100e6, true, 0);
            synth++;
        }
        rep.recordBorrow(a, synth, big);
        vm.warp(block.timestamp + 7 days);
        rep.recordLoanCompletion(a, synth, big, true, 0);
    }

    function _fund(address who) internal {
        vm.prank(owner);
        usdc.mint(who, 1e15);
        vm.prank(who);
        usdc.approve(address(mp), type(uint256).max);
    }

    // ------------------------------------------------------------------ PRNG
    function _rnd() internal returns (uint256) {
        seed = uint256(keccak256(abi.encode(seed)));
        return seed;
    }
    function _rnd(uint256 m) internal returns (uint256) {
        return m == 0 ? 0 : _rnd() % m;
    }

    function _bump(string memory k) internal {
        bytes32 h = keccak256(bytes(k));
        if (profile[h] == 0) profileKeys.push(k);
        profile[h] += 1;
    }

    // ------------------------------------------------------------- invariants

    function _checkInvariants() internal {
        uint256 sumAvail;
        for (uint256 aid = 1; aid <= NAGENTS; aid++) {
            (address creator, uint256 total, uint256 avail, uint256 loaned, , , uint256 count) =
                mp.getAgentPool(aid);
            uint256 sumAmt;
            uint256 sumInt;
            for (uint256 i = 0; i < count; i++) {
                address l = mp.poolLenders(aid, i);
                (uint256 amt, uint256 earned, ) = mp.positions(aid, l);
                sumAmt += amt;
                sumInt += earned;
                (uint128 pAmt, ) = mp.pendingTranche(aid, l);
                if (pAmt > amt) _fail("(b) pendingTranche > position.amount");
            }
            if (total != sumAmt) _fail("(a2) totalLiquidity != sum(position.amount)");
            if (avail + loaned != sumAmt + sumInt) _fail("(a2) avail+loaned != sum(amount+interest)");
            if (mp.outstandingPrincipal(aid) != ghostOutstanding[aid]) _fail("(h) outstandingPrincipal drift");

            (uint256 stakeAmt, bool locked) = mp.selfStake(aid);
            (uint256 creatorAmt, , ) = mp.positions(aid, creator);
            if (stakeAmt != creatorAmt) _fail("(M2) selfStake != creator position");
            if (locked != (mp.outstandingPrincipal(aid) > 0)) _fail("(M2a) self-stake lock is not exact");

            uint256 lim = rep.creditLimitOf(aid);
            if (lim > rep.tierLimit(rep.getReputationScore(aid))) _fail("(q) credit limit exceeds tier limit");
            if (lim > rep.MAX_TIER_LIMIT()) _fail("(q) credit limit exceeds MAX_TIER_LIMIT");

            uint256 mrp = rep.maxRepaidPrincipal(aid);
            if (mrp < lastMaxRepaid[aid] && !(defaultedThisOp && mrp == 0)) {
                _fail("(M1) maxRepaidPrincipal fell without a default");
            }
            lastMaxRepaid[aid] = mrp;

            sumAvail += avail;
        }
        uint256 held = usdc.balanceOf(address(mp));
        if (held != sumAvail + mp.accumulatedFees() + ghostCollateral) _fail("(a) exact solvency broken");
        defaultedThisOp = false;
    }

    function _fail(string memory why) internal {
        violations += 1;
        console.log(string.concat("VIOLATION @op ", vm.toString(opIndex), ": ", why));
        revert(why);
    }

    function _decile() internal view returns (uint256 d) {
        d = (opIndex * 10) / (totalOps == 0 ? 1 : totalOps);
        if (d > 9) d = 9;
    }

    // ------------------------------------------------------------------- ops

    function _opSupply() internal {
        uint256 aid = 1 + _rnd(NAGENTS);
        address l = _rnd(4) == 0 ? agents[aid - 1] : lenders[_rnd(NLENDERS)];
        uint256 amt = 1e6 + _rnd(500e6);
        vm.prank(l);
        try mp.supplyLiquidity(aid, amt) {
            uint256 g = vm.lastCallGas().gasTotalUsed;
            uint256 d = _decile();
            gasSupplySum[d] += g;
            gasSupplyN[d] += 1;
            opsExecuted++;
            _bump("supply");
            _checkInvariants();
        } catch Error(string memory r) {
            _bump(string.concat("supply.refused:", r));
        }
    }

    function _opWithdraw(bool all) internal {
        uint256 aid = 1 + _rnd(NAGENTS);
        address l = _rnd(4) == 0 ? agents[aid - 1] : lenders[_rnd(NLENDERS)];
        (uint256 amt, , ) = mp.positions(aid, l);
        if (amt == 0) { _bump("withdraw.skip"); return; }
        uint256 want = all ? amt : 1 + _rnd(amt);
        vm.prank(l);
        try mp.withdrawLiquidity(aid, want) {
            opsExecuted++;
            _bump(all ? "withdraw.all" : "withdraw.partial");
            _checkInvariants();
        } catch Error(string memory r) {
            _bump(string.concat("withdraw.refused:", r));
        }
    }

    function _opClaim() internal {
        uint256 aid = 1 + _rnd(NAGENTS);
        address l = _rnd(4) == 0 ? agents[aid - 1] : lenders[_rnd(NLENDERS)];
        vm.prank(l);
        try mp.claimInterest(aid) {
            opsExecuted++;
            _bump("claim");
            _checkInvariants();
        } catch Error(string memory r) {
            _bump(string.concat("claim.refused:", r));
        }
    }

    function _opLoan() internal {
        uint256 aid = 1 + _rnd(NAGENTS);
        address holder = registry.ownerOf(aid);
        if (!registry.isAgentActive(holder)) { _bump("loan.skipInactive"); return; }
        (, , uint256 avail, , , , ) = mp.getAgentPool(aid);
        if (avail == 0) { _bump("loan.skip"); return; }
        // Size the ask so that a healthy fraction of attempts are FEASIBLE — otherwise
        // the campaign spends itself on "Exceeds credit limit" and never reaches the
        // close paths. Deliberately still over-asks ~1 time in 4.
        uint256 cap = avail;
        uint256 lim = rep.creditLimitOf(aid);
        uint256 out = mp.outstandingPrincipal(aid);
        uint256 head = lim > out ? lim - out : 0;
        if (head < cap) cap = head;
        uint256 pct = rep.calculateCollateralRequirement(holder);
        if (pct < 100) {
            (uint256 stake, ) = mp.selfStake(aid);
            uint256 k = rep.creditMultiple();
            uint256 maxExposure = (stake * k * 100) / (100 - pct);
            uint256 stakeHead = maxExposure > out ? maxExposure - out : 0;
            if (stakeHead < cap) cap = stakeHead;
        }
        if (_rnd(4) == 0) cap = avail; // keep exercising the refusal paths
        if (cap < 1e6) { _bump("loan.skipNoHeadroom"); return; }
        uint256 amt = 1e6 + _rnd(cap);
        uint256 dur = 7 + _rnd(60);
        vm.prank(holder);
        try mp.requestLoan(amt, dur) returns (uint256 id) {
            uint256 g = vm.lastCallGas().gasTotalUsed;
            uint256 d = _decile();
            gasLoanSum[d] += g;
            gasLoanN[d] += 1;
            ghostOutstanding[aid] += amt;
            (, , , , uint256 collat, , , , , ) = mp.loans(id); // field 4 == collateralAmount
            ghostCollateral += collat;
            opsExecuted++;
            _bump("loan");
            // (M2c) the self-stake gate held
            (uint256 stake, ) = mp.selfStake(aid);
            if (stake < mp.requiredSelfStake(aid, 0)) _fail("(M2c) self-stake below requirement after a loan");
            _checkInvariants();
        } catch Error(string memory r) {
            _bump(string.concat("loan.refused:", r));
        }
    }

    /// @dev Pick an agent that actually has ACTIVE loans, so the close paths are
    ///      exercised instead of being skipped most of the time.
    function _agentWithLoans() internal returns (uint256) {
        uint256 start = 1 + _rnd(NAGENTS);
        for (uint256 k = 0; k < NAGENTS; k++) {
            uint256 aid = 1 + ((start - 1 + k) % NAGENTS);
            if (mp.getActiveLoanIds(aid).length > 0) return aid;
        }
        return 0;
    }

    function _opRepay() internal {
        uint256 aid = _agentWithLoans();
        if (aid == 0) { _bump("repay.skip"); return; }
        uint256[] memory ids = mp.getActiveLoanIds(aid);
        uint256 id = ids[_rnd(ids.length)];
        (, address borrower, , uint256 amt, uint256 collat, , , uint256 endTime, , ) = mp.loans(id);
        // timing: now / just before term / 1-30d late / beyond the 30d cap
        uint256 mode = _rnd(4);
        if (mode == 1 && endTime > block.timestamp) vm.warp(endTime);
        if (mode == 2 && endTime > block.timestamp) vm.warp(endTime + 1 days + _rnd(29 days));
        if (mode == 3 && endTime > block.timestamp) vm.warp(endTime + 31 days + _rnd(60 days));
        address holder = registry.ownerOf(aid);
        address payer = _rnd(3) == 0 ? holder : borrower;
        vm.prank(payer);
        try mp.repayLoan(id) {
            uint256 g = vm.lastCallGas().gasTotalUsed;
            uint256 d = _decile();
            gasRepaySum[d] += g;
            gasRepayN[d] += 1;
            ghostOutstanding[aid] -= amt;
            ghostCollateral -= collat;
            opsExecuted++;
            _bump(mode == 0 ? "repay.early" : mode == 1 ? "repay.onTime" : mode == 2 ? "repay.late" : "repay.beyondCap");
            _checkInvariants();
        } catch Error(string memory r) {
            _bump(string.concat("repay.refused:", r));
        }
    }

    function _opLiquidate() internal {
        uint256 aid = _agentWithLoans();
        if (aid == 0) { _bump("liq.skip"); return; }
        uint256[] memory ids = mp.getActiveLoanIds(aid);
        uint256 id = ids[_rnd(ids.length)];
        (, , , uint256 amt, uint256 collat, , , uint256 endTime, , ) = mp.loans(id);
        if (block.timestamp <= endTime) vm.warp(endTime + 1 days + _rnd(30 days));
        vm.prank(owner);
        try mp.liquidateLoan(id) {
            uint256 g = vm.lastCallGas().gasTotalUsed;
            uint256 d = _decile();
            gasLiqSum[d] += g;
            gasLiqN[d] += 1;
            ghostOutstanding[aid] -= amt;
            ghostCollateral -= collat;
            defaultedThisOp = true;
            opsExecuted++;
            _bump("liquidate");
            if (!rep.isLockedOut(aid)) _fail("(M1-3) agent not locked out after a default");
            if (rep.maxRepaidPrincipal(aid) != 0) _fail("(M1-3) ladder not reset on default");
            _checkInvariants();
        } catch Error(string memory r) {
            _bump(string.concat("liq.refused:", r));
        }
    }

    function _opTransferNft() internal {
        uint256 aid = 1 + _rnd(NAGENTS);
        address from = registry.ownerOf(aid);
        address to = from == agents[aid - 1] ? spares[aid - 1] : agents[aid - 1];
        vm.prank(from);
        try registry.transferFrom(from, to, aid) {
            opsExecuted++;
            _bump("nft.transfer");
            _checkInvariants();
        } catch Error(string memory r) {
            _bump(string.concat("nft.refused:", r));
        }
    }

    function _opToggleActive() internal {
        uint256 aid = 1 + _rnd(NAGENTS);
        bool active = registry.isAgentActive(registry.ownerOf(aid));
        // bias towards reactivation: a permanently deactivated agent starves every
        // other op of work, which is a harness artefact rather than a contract state
        if (active && _rnd(3) != 0) { _bump("toggle.skip"); return; }
        vm.prank(owner);
        if (active) {
            try registry.deactivateAgent(aid) { opsExecuted++; _bump("deactivate"); _checkInvariants(); }
            catch Error(string memory r) { _bump(string.concat("deact.refused:", r)); }
        } else {
            try registry.reactivateAgent(aid) { opsExecuted++; _bump("reactivate"); _checkInvariants(); }
            catch Error(string memory r) { _bump(string.concat("react.refused:", r)); }
        }
    }

    function _opWarp() internal {
        // occasionally jump far enough to clear a 180-day post-default lockout
        vm.warp(block.timestamp + 1 + (_rnd(5) == 0 ? _rnd(220 days) : _rnd(10 days)));
        opsExecuted++;
        _bump("warp");
    }

    // ------------------------------------------------------------------ main

    /// @dev One op, executed as an EXTERNAL self-call so that every step gets a fresh
    ///      memory frame. Solidity never frees memory, so running 25,000 ops inside a
    ///      single frame hits quadratic memory-expansion cost (MemoryOOG) long before
    ///      anything interesting happens. Storage is shared, so the state still grows
    ///      monotonically across the whole run — which is the point of the soak.
    function stepExternal() external {
        require(msg.sender == address(this), "internal");
        opsAttempted++;
        uint256 r = _rnd(100);
        if (r < 22) _opSupply();
        else if (r < 32) _opWithdraw(false);
        else if (r < 37) _opWithdraw(true);
        else if (r < 45) _opClaim();
        else if (r < 65) _opLoan();
        else if (r < 82) _opRepay();
        else if (r < 87) _opLiquidate();
        else if (r < 91) _opTransferNft();
        else if (r < 94) _opToggleActive();
        else _opWarp();
    }

    function test_soak() public {
        totalOps = vm.envOr("SOAK_OPS", uint256(25000));
        for (opIndex = 0; opIndex < totalOps; opIndex++) {
            this.stepExternal();
        }

        console.log("SOAK | ops attempted", opsAttempted);
        console.log("SOAK | ops executed", opsExecuted);
        console.log("SOAK | invariant violations", violations);
        console.log("SOAK | final block.timestamp", block.timestamp);
        console.log("SOAK | nextLoanId", mp.nextLoanId());
        for (uint256 i = 0; i < profileKeys.length; i++) {
            console.log(string.concat("SOAKPROF | ", profileKeys[i], " | ", vm.toString(profile[keccak256(bytes(profileKeys[i]))])));
        }
        _drift("repayLoan", gasRepaySum, gasRepayN);
        _drift("supplyLiquidity", gasSupplySum, gasSupplyN);
        _drift("requestLoan", gasLoanSum, gasLoanN);
        _drift("liquidateLoan", gasLiqSum, gasLiqN);
        assertEq(violations, 0, "invariant violations during soak");
    }

    function _drift(string memory name, uint256[10] storage sum, uint256[10] storage n) internal view {
        string memory line = string.concat("SOAKGAS | ", name, " | deciles:");
        for (uint256 i = 0; i < 10; i++) {
            line = string.concat(line, " ", n[i] == 0 ? "-" : vm.toString(sum[i] / n[i]));
        }
        console.log(line);
    }
}
