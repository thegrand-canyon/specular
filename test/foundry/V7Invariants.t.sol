// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "forge-std/Test.sol";
import "../../contracts/core/AgentLiquidityMarketplaceV62.sol";
import "../../contracts/core/AgentRegistryV2.sol";
import "../../contracts/core/ReputationManagerV4.sol";
import "../../contracts/tokens/MockUSDC.sol";

/**
 * @title V7Invariants — stateful invariants for the V7 credit model
 * @notice Extends the V6/V6.1 invariant campaigns with the state the V7 change
 *         introduces: the M2 self-stake (locked, first-loss, coverage-gated) and the
 *         M1 credit ladder (`maxRepaidPrincipal`, the tier cap, the default lockout),
 *         plus the L7 socialisation basis.
 *
 *   State invariants (checked after every handler call):
 *     (a) exact solvency + per-pool conservation, incl. unclaimed interest
 *     (b) pendingTranche.amount <= position.amount
 *     (h) outstandingPrincipal[agent] == Σ ACTIVE principal
 *     (q) creditLimitOf(agent) <= MAX_TIER_LIMIT for every agent, always
 *     (r) a locked-out agent's credit limit is exactly 0
 *     (s) the ladder limit is min(tier, k*maxRepaid + step) — the view agrees with the state
 *
 *   Call-time properties recorded as ghost counters (must stay 0):
 *     (M2a) a pool creator's withdrawal while outstandingPrincipal > 0 ALWAYS reverts
 *     (M2c) after every successful requestLoan, selfStake >= unsecured exposure / k
 *     (M2b) on every lossy liquidation the creator's position absorbs
 *           min(loss, creatorAmountBefore) BEFORE any other lender is reduced,
 *           and Σ principal falls by exactly min(loss, Σ principal)
 *     (L7)  a lender whose qualified amount for the defaulted loan was 0 is not
 *           reduced while a qualified lender still holds principal
 *     (M1)  maxRepaidPrincipal only ever rises, except to exactly 0 on a default
 *     (M1b) a locked-out agent can never open a loan
 */
/// forge-config: default.invariant.runs = 48
/// forge-config: default.invariant.depth = 192
contract V7InvariantTest is Test {
    AgentLiquidityMarketplaceV62 public v62;
    AgentRegistryV2 public registry;
    ReputationManagerV4 public reputation;
    MockUSDC public usdc;
    HandlerV7 public handler;

    address public owner = address(0xAAAA);
    address[2] public agents = [address(0xA1), address(0xA2)];
    address[3] public lenders = [address(0xB1), address(0xB2), address(0xB3)];

    function setUp() public {
        vm.startPrank(owner);
        registry = new AgentRegistryV2();
        reputation = new ReputationManagerV4(address(registry));
        usdc = new MockUSDC();
        v62 = new AgentLiquidityMarketplaceV62(address(registry), address(reputation), address(usdc));
        reputation.authorizePool(address(v62));
        reputation.authorizePool(owner);
        reputation.setReputationRateLimit(0, 1 days);
        reputation.setLadderParameters(2, 100e6, 100e6, 7 days);
        v62.setMinHoldForReputationReward(0);
        v62.setMinSupplyAmount(1e6);
        vm.stopPrank();

        AgentRegistryV2.MetadataEntry[] memory empty;
        for (uint256 i = 0; i < 2; i++) {
            vm.prank(agents[i]);
            registry.register("ipfs://v7", empty);
            vm.prank(agents[i]);
            v62.createAgentPool();
        }

        // Agent 1 → the 0 %-collateral top tier with a 5,000 ladder, so defaults are
        // genuinely lossy. Agent 2 stays at score 0 (100 % collateral) so the
        // collateral-return path and the "no self-stake required" branch are exercised.
        vm.startPrank(owner);
        uint256 synth = 1_000_000;
        while (reputation.getReputationScore(1) < 800) {
            reputation.recordBorrow(agents[0], synth, 100e6);
            vm.warp(block.timestamp + 7 days);
            reputation.recordLoanCompletion(agents[0], synth, 100e6, true, 0);
            synth++;
        }
        reputation.recordBorrow(agents[0], synth, 5000e6);
        vm.warp(block.timestamp + 7 days);
        reputation.recordLoanCompletion(agents[0], synth, 5000e6, true, 0);
        vm.stopPrank();

        address[5] memory funded = [agents[0], agents[1], lenders[0], lenders[1], lenders[2]];
        for (uint256 i = 0; i < funded.length; i++) {
            vm.prank(owner);
            usdc.mint(funded[i], 1e13);
            vm.prank(funded[i]);
            usdc.approve(address(v62), type(uint256).max);
        }

        handler = new HandlerV7(v62, registry, reputation, usdc, agents, lenders, owner);
        targetContract(address(handler));
    }

    function _poolSums(uint256 aid) internal view returns (uint256 sumAmount, uint256 sumInterest, uint256 count) {
        (, , , , , , count) = v62.getAgentPool(aid);
        for (uint256 i = 0; i < count; i++) {
            (uint256 amount, uint256 earned, ) = v62.positions(aid, v62.poolLenders(aid, i));
            sumAmount += amount;
            sumInterest += earned;
        }
    }

    // ------------------------------------------------------------------- (a)
    function invariant_a_balance_identity() public view {
        uint256 sumAvail; uint256 sumLoaned;
        for (uint256 aid = 1; aid <= 2; aid++) {
            (, uint256 total, uint256 avail, uint256 loaned, , , ) = v62.getAgentPool(aid);
            (uint256 a, uint256 e, ) = _poolSums(aid);
            require(total == a, "a: totalLiquidity != sum amount");
            require(avail + loaned == a + e, "a: avail+loaned != sum(amount+interest)");
            sumAvail += avail; sumLoaned += loaned;
        }
        uint256 sumCollateral;
        uint256 n = v62.nextLoanId();
        for (uint256 id = 1; id < n; id++) {
            (, , , , uint256 coll, , , , , AgentLiquidityMarketplaceV62.LoanState st) = v62.loans(id);
            if (st == AgentLiquidityMarketplaceV62.LoanState.ACTIVE) sumCollateral += coll;
        }
        require(
            usdc.balanceOf(address(v62)) == sumAvail + v62.accumulatedFees() + sumCollateral,
            "a: exact solvency broken"
        );
    }

    // ------------------------------------------------------------------- (b)
    function invariant_b_pending_within_position() public view {
        for (uint256 aid = 1; aid <= 2; aid++) {
            for (uint256 i = 0; i < 4; i++) {
                address l = i < 3 ? lenders[i] : agents[aid - 1];
                (uint256 amount, , ) = v62.positions(aid, l);
                (uint128 pend, ) = v62.pendingTranche(aid, l);
                require(pend <= amount, "b: pending > amount");
            }
        }
    }

    // ------------------------------------------------------------------- (h)
    function invariant_h_outstanding_principal() public view {
        uint256 n = v62.nextLoanId();
        for (uint256 aid = 1; aid <= 2; aid++) {
            uint256 sum;
            for (uint256 id = 1; id < n; id++) {
                (, , uint256 laid, uint256 amount, , , , , , AgentLiquidityMarketplaceV62.LoanState st) = v62.loans(id);
                if (laid == aid && st == AgentLiquidityMarketplaceV62.LoanState.ACTIVE) sum += amount;
            }
            require(v62.outstandingPrincipal(aid) == sum, "h: outstandingPrincipal mismatch");
        }
    }

    // ------------------------------------------------------------- (q)(r)(s)
    function invariant_q_tier_cap_is_absolute() public view {
        for (uint256 aid = 1; aid <= 2; aid++) {
            require(reputation.creditLimitOf(aid) <= reputation.MAX_TIER_LIMIT(), "q: credit limit above ceiling");
        }
    }

    function invariant_r_lockout_zeroes_the_line() public view {
        for (uint256 aid = 1; aid <= 2; aid++) {
            if (reputation.isLockedOut(aid)) {
                require(reputation.creditLimitOf(aid) == 0, "r: locked-out agent still has a line");
            }
        }
    }

    function invariant_s_ladder_view_matches_state() public view {
        for (uint256 aid = 1; aid <= 2; aid++) {
            if (reputation.isLockedOut(aid)) continue;
            uint256 expectedLadder = reputation.creditMultiple() * reputation.maxRepaidPrincipal(aid)
                + reputation.growthStep();
            if (expectedLadder < reputation.bootstrapLimit()) expectedLadder = reputation.bootstrapLimit();
            require(reputation.ladderLimit(aid) == expectedLadder, "s: ladderLimit drifted");
            uint256 tl = reputation.tierLimit(reputation.getReputationScore(aid));
            uint256 expected = expectedLadder < tl ? expectedLadder : tl;
            require(reputation.creditLimitOf(aid) == expected, "s: creditLimitOf drifted");
        }
    }

    // ---------------------------------------------------------------- ghosts
    function invariant_ghost_no_violations() public view {
        require(handler.vM2a() == 0, "M2a: creator withdrew while borrowing");
        require(handler.vM2c() == 0, "M2c: loan granted without the required self-stake");
        require(handler.vM2b() == 0, "M2b: self-stake was not first-loss, or loss not exact");
        require(handler.vL7() == 0, "L7: an unqualified lender absorbed loss ahead of a qualified one");
        require(handler.vM1() == 0, "M1: maxRepaidPrincipal moved illegally");
        require(handler.vM1b() == 0, "M1b: locked-out agent opened a loan");
    }

    function afterInvariant() public view {
        console.log("supply/withdraw/claim", handler.nSupply(), handler.nWithdraw(), handler.nClaim());
        console.log("creator withdraw attempts blocked", handler.nCreatorBlocked());
        console.log("loans / repays / late", handler.nLoan(), handler.nRepay(), handler.nLate());
        console.log("loans refused for self-stake", handler.nStakeRefused());
        console.log("liquidations / lossy / self-stake absorbed", handler.nLiq(), handler.nLiqLossy(), handler.nSelfAbsorbed());
        console.log("lockouts observed / blocked borrows", handler.nLockout(), handler.nLockedBorrowBlocked());
        console.log("ladder advances", handler.nLadderUp());
    }
}

/**
 * @title HandlerV7
 * @notice Drives the V7 stack and records the call-time properties that cannot be
 *         expressed as pure state invariants.
 */
contract HandlerV7 is Test {
    AgentLiquidityMarketplaceV62 public v62;
    AgentRegistryV2 public registry;
    ReputationManagerV4 public rep;
    MockUSDC public usdc;
    address public owner;
    address[2] public agents;
    address[3] public lenders;

    uint256[] internal _open;
    mapping(uint256 => uint256) public lastMaxRepaid;

    uint256 public vM2a; uint256 public vM2c; uint256 public vM2b; uint256 public vL7; uint256 public vM1; uint256 public vM1b;
    uint256 public nSupply; uint256 public nWithdraw; uint256 public nClaim; uint256 public nCreatorBlocked;
    uint256 public nLoan; uint256 public nRepay; uint256 public nLate; uint256 public nStakeRefused;
    uint256 public nLiq; uint256 public nLiqLossy; uint256 public nSelfAbsorbed;
    uint256 public nLockout; uint256 public nLockedBorrowBlocked; uint256 public nLadderUp;

    constructor(
        AgentLiquidityMarketplaceV62 _v62, AgentRegistryV2 _reg, ReputationManagerV4 _rep, MockUSDC _usdc,
        address[2] memory _agents, address[3] memory _lenders, address _owner
    ) {
        v62 = _v62; registry = _reg; rep = _rep; usdc = _usdc;
        agents = _agents; lenders = _lenders; owner = _owner;
        for (uint256 aid = 1; aid <= 2; aid++) lastMaxRepaid[aid] = rep.maxRepaidPrincipal(aid);
    }

    function _syncLadder() internal {
        for (uint256 aid = 1; aid <= 2; aid++) {
            uint256 now_ = rep.maxRepaidPrincipal(aid);
            uint256 prev = lastMaxRepaid[aid];
            // Legal transitions: unchanged, strictly up, or reset to exactly 0.
            if (now_ != prev && now_ != 0 && now_ <= prev) vM1++;
            if (now_ > prev) nLadderUp++;
            lastMaxRepaid[aid] = now_;
        }
    }

    // ------------------------------------------------------------ lender ops
    function supply(uint8 aSeed, uint8 lSeed, uint16 amountSeed) external {
        uint256 aid = uint256(aSeed) % 2 + 1;
        address lender = lenders[lSeed % 3];
        uint256 amount = (uint256(amountSeed) % 2000 + 1) * 1e6;
        vm.warp(block.timestamp + 1);
        vm.prank(lender);
        try v62.supplyLiquidity(aid, amount) { nSupply++; } catch {}
    }

    /// The agent tops up its own first-loss stake.
    function stake(uint8 aSeed, uint16 amountSeed) external {
        uint256 aid = uint256(aSeed) % 2 + 1;
        address agent = agents[aid - 1];
        uint256 amount = (uint256(amountSeed) % 3000 + 1) * 1e6;
        vm.prank(agent);
        try v62.supplyLiquidity(aid, amount) { nSupply++; } catch {}
    }

    function withdraw(uint8 aSeed, uint8 lSeed, uint8 amountSeed) external {
        uint256 aid = uint256(aSeed) % 2 + 1;
        address lender = lenders[lSeed % 3];
        (uint256 supplied, , ) = v62.positions(aid, lender);
        if (supplied == 0) return;
        uint256 amount = uint256(amountSeed) * supplied / 256;
        if (amount == 0) amount = 1;
        vm.prank(lender);
        try v62.withdrawLiquidity(aid, amount) { nWithdraw++; } catch {}
    }

    /// (M2a) The pool creator tries to pull its stake. It MUST be refused whenever
    /// the agent has outstanding principal — that ordering was the first move of
    /// every bust-out in the economic simulation.
    function creatorWithdraw(uint8 aSeed, uint8 amountSeed) external {
        uint256 aid = uint256(aSeed) % 2 + 1;
        address agent = agents[aid - 1];
        (uint256 supplied, , ) = v62.positions(aid, agent);
        if (supplied == 0) return;
        uint256 amount = uint256(amountSeed) * supplied / 256;
        if (amount == 0) amount = 1;
        bool locked = v62.outstandingPrincipal(aid) > 0;
        vm.prank(agent);
        try v62.withdrawLiquidity(aid, amount) {
            if (locked) vM2a++; // withdrew while borrowing — the lock failed
            nWithdraw++;
        } catch Error(string memory reason) {
            if (keccak256(bytes(reason)) == keccak256("Self-stake locked while borrowing")) {
                nCreatorBlocked++;
                if (!locked) vM2a++; // refused when nothing was outstanding
            }
        } catch {}
    }

    function claim(uint8 aSeed, uint8 lSeed) external {
        uint256 aid = uint256(aSeed) % 2 + 1;
        address lender = lSeed % 4 == 3 ? agents[aid - 1] : lenders[lSeed % 3];
        (, uint256 earned, ) = v62.positions(aid, lender);
        if (earned == 0) return;
        vm.prank(lender);
        try v62.claimInterest(aid) { nClaim++; } catch {}
    }

    // ---------------------------------------------------------- borrower ops
    function requestLoan(uint8 aSeed, uint16 amountSeed, uint8 durSeed) external {
        uint256 aid = uint256(aSeed) % 2 + 1;
        address agent = agents[aid - 1];
        (, , uint256 avail, , , , ) = v62.getAgentPool(aid);
        if (avail == 0) return;
        uint256 amt = (uint256(amountSeed) % 3000 + 1) * 1e6;
        if (amt > avail) amt = avail;
        uint256 durDays = 7 + (uint256(durSeed) % 3);
        bool lockedOut = rep.isLockedOut(aid);
        uint256 pct = rep.calculateCollateralRequirement(agent);
        uint256 outstandingAfter = v62.outstandingPrincipal(aid) + amt;

        vm.prank(agent);
        try v62.requestLoan(amt, durDays) returns (uint256 lid) {
            nLoan++;
            _open.push(lid);
            if (lockedOut) vM1b++;
            // (M2c) coverage must hold for the exposure just taken on
            if (pct < 100) {
                (uint256 selfAmt, ) = v62.selfStake(aid);
                uint256 unsecured = (outstandingAfter * (100 - pct)) / 100;
                if (selfAmt < unsecured / rep.creditMultiple()) vM2c++;
            }
        } catch Error(string memory reason) {
            if (keccak256(bytes(reason)) == keccak256("Insufficient self-stake")) nStakeRefused++;
            if (keccak256(bytes(reason)) == keccak256("Exceeds credit limit") && lockedOut) nLockedBorrowBlocked++;
        } catch {}
        _syncLadder();
    }

    function repayLoan(uint8 idSeed) external {
        if (_open.length == 0) return;
        uint256 i = uint256(idSeed) % _open.length;
        uint256 lid = _open[i];
        (, address borrower, , , , , , uint256 endTime, , AgentLiquidityMarketplaceV62.LoanState st) = v62.loans(lid);
        if (st != AgentLiquidityMarketplaceV62.LoanState.ACTIVE) { _drop(i); return; }
        bool late = block.timestamp > endTime;
        vm.prank(borrower);
        try v62.repayLoan(lid) { nRepay++; if (late) nLate++; _drop(i); } catch {}
        _syncLadder();
    }

    /**
     * (M2b) + (L7) Liquidate an overdue loan and check the waterfall:
     *   - the creator's own position absorbs min(loss, its principal) FIRST;
     *   - Σ principal falls by exactly min(loss, Σ principal);
     *   - no lender that was unqualified for this loan is reduced while a qualified
     *     lender still holds principal.
     */
    function liquidate(uint8 idSeed) external {
        if (_open.length == 0) return;
        uint256 i = uint256(idSeed) % _open.length;
        uint256 lid = _open[i];
        (, , uint256 aid, uint256 amount, uint256 coll, , uint256 startTime, uint256 endTime, , AgentLiquidityMarketplaceV62.LoanState st)
            = v62.loans(lid);
        if (st != AgentLiquidityMarketplaceV62.LoanState.ACTIVE) { _drop(i); return; }
        if (block.timestamp <= endTime) return;

        uint256 loss = amount > coll ? amount - coll : 0;
        address creator = agents[aid - 1];
        (uint256 creatorBefore, , ) = v62.positions(aid, creator);
        uint256[4] memory before_;
        uint256[4] memory qual;
        address[4] memory parties = [lenders[0], lenders[1], lenders[2], creator];
        uint256 sumBefore;
        for (uint256 k = 0; k < 4; k++) {
            (before_[k], , ) = v62.positions(aid, parties[k]);
            qual[k] = v62.qualifiedAmountAt(aid, parties[k], startTime);
            sumBefore += before_[k];
        }

        vm.prank(owner);
        try v62.liquidateLoan(lid) {
            nLiq++;
            _drop(i);
            if (loss == 0) { _syncLadder(); return; }
            nLiqLossy++;

            uint256 sumAfter;
            uint256[4] memory cut;
            for (uint256 k = 0; k < 4; k++) {
                (uint256 a, , ) = v62.positions(aid, parties[k]);
                sumAfter += a;
                cut[k] = before_[k] - a;
            }
            // (M2b) creator absorbs first, in full, up to the loss
            uint256 expectSelf = loss < creatorBefore ? loss : creatorBefore;
            if (cut[3] != expectSelf) vM2b++;
            if (expectSelf > 0) nSelfAbsorbed++;
            // Σ principal reduced by exactly min(loss, Σ principal)
            uint256 expectTotal = loss < sumBefore ? loss : sumBefore;
            if (sumBefore - sumAfter != expectTotal) vM2b++;

            // (L7) an unqualified third-party lender must not be cut while a
            // qualified one still has principal left to give.
            uint256 qualifiedLeft;
            for (uint256 k = 0; k < 3; k++) {
                if (qual[k] > 0) {
                    (uint256 a, , ) = v62.positions(aid, parties[k]);
                    qualifiedLeft += a;
                }
            }
            if (qualifiedLeft > 0) {
                for (uint256 k = 0; k < 3; k++) {
                    if (qual[k] == 0 && cut[k] > 0) vL7++;
                }
            }
            if (rep.isLockedOut(aid)) nLockout++;
        } catch {}
        _syncLadder();
    }

    function warpTime(uint16 secondsSeed) external {
        vm.warp(block.timestamp + (uint256(secondsSeed) % (12 days) + 1 hours));
    }

    /// Push time past a chosen open loan's endTime so the liquidation path is
    /// actually reachable inside a bounded invariant campaign.
    function warpPastDue(uint8 idSeed) external {
        if (_open.length == 0) return;
        uint256 lid = _open[uint256(idSeed) % _open.length];
        (, , , , , , , uint256 endTime, , AgentLiquidityMarketplaceV62.LoanState st) = v62.loans(lid);
        if (st != AgentLiquidityMarketplaceV62.LoanState.ACTIVE) return;
        if (block.timestamp <= endTime) vm.warp(endTime + 1 hours);
    }

    /// Seed both pools so the borrow path is reachable early in a campaign.
    function seedPool(uint8 aSeed, uint16 amountSeed) external {
        uint256 aid = uint256(aSeed) % 2 + 1;
        uint256 amount = (uint256(amountSeed) % 4000 + 100) * 1e6;
        vm.warp(block.timestamp + 1);
        vm.prank(lenders[uint256(amountSeed) % 3]);
        try v62.supplyLiquidity(aid, amount) { nSupply++; } catch {}
    }

    function _drop(uint256 i) internal {
        _open[i] = _open[_open.length - 1];
        _open.pop();
    }
}
