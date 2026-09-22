// Engineered violation states for the invariant-monitor detection matrix.
//
// Each scenario mutates the LOCAL hardhat deployment into a state that a real
// bug (or a real attack) would produce, so the monitor can be measured against
// ground truth instead of against "it has never alerted, so it must work".
//
// Where a public/owner function can produce the state it is used (pause,
// ownership transfer, seedPool). Where the contract deliberately makes the state
// unreachable — a duplicate poolLenders entry IS the §B1 fix — the state is
// written directly with hardhat_setStorageAt, against a slot map that is asserted
// against the contract's own getters first (scripts/op-resilience/storage.js).

const { ethers } = require('hardhat');
const S = require('./storage');

const USDC = n => ethers.parseUnits(n.toString(), 6);

// packed PendingTranche{uint128 amount; uint128 timestamp}
const packTranche = (amount, timestamp) => (BigInt(timestamp) << 128n) | BigInt(amount);

/**
 * Each scenario: { key, title, expect: what a correct monitor must flag, apply(ctx) }
 * ctx = { v6, usdc, registry, addr, agentAId, agentBId, lender1, lender2, signers }
 */
const scenarios = [
    {
        key: 'clean',
        title: 'Healthy baseline (control — must NOT alert)',
        expectDetect: false,
        async apply() { /* no-op */ },
    },

    // ---- (a) §S1 phantom liquidity -------------------------------------------------
    {
        key: 's1_phantom_gross',
        title: '(a) §S1 phantom liquidity, gross: availableLiquidity far exceeds USDC backing',
        expectDetect: true,
        async apply(ctx) {
            // seedPool is a live owner power while migrationFinalized == false —
            // this is exactly the F-08 blast radius, used here as the corruption tool.
            await ctx.v6.seedPool(ctx.agentAId, ctx.addr._testAccounts.agentA, USDC(50000), USDC(50000), 0);
        },
    },
    {
        key: 's1_phantom_masked',
        title: '(a) §S1 phantom liquidity, MASKED: +500 USDC phantom, less than the 700 USDC of escrowed collateral',
        expectDetect: true,
        async apply(ctx) {
            const base = BigInt(S.mapSlot(ctx.agentAId, S.SLOT.agentPools));
            const cur = BigInt(await S.getStorage(ctx.v6Addr, base + 3n));
            await S.setStorage(ctx.v6Addr, base + 3n, cur + USDC(500));
        },
    },

    // ---- (b) §B1 duplicate lender ---------------------------------------------------
    {
        key: 'b1_duplicate_lender',
        title: '(b) §B1 duplicate address in poolLenders[] (the state the §B1 fix prevents)',
        expectDetect: true,
        async apply(ctx) {
            const lenSlot = BigInt(S.mapSlot(ctx.agentAId, S.SLOT.poolLenders));
            const len = BigInt(await S.getStorage(ctx.v6Addr, lenSlot));
            const data = BigInt(ethers.keccak256(S.h32(lenSlot)));
            const first = await S.getStorage(ctx.v6Addr, data); // lender at index 0
            await S.setStorage(ctx.v6Addr, data + len, first);   // duplicate it at the tail
            await S.setStorage(ctx.v6Addr, lenSlot, len + 1n);
        },
    },

    // ---- (c) §S5 runaway activeLoanCount -------------------------------------------
    {
        key: 's5_runaway_counter',
        title: '(c) §S5 runaway activeLoanCount: 47 active loans recorded, cap is 10, 1 loan actually ACTIVE',
        expectDetect: true,
        async apply(ctx) {
            await S.setStorage(ctx.v6Addr, S.mapSlot(ctx.agentAId, S.SLOT.activeLoanCount), 47);
        },
    },

    // ---- (d) insolvency --------------------------------------------------------------
    {
        key: 'insolvency',
        title: '(d) Insolvency: lender claims + fees + collateral exceed the marketplace USDC balance',
        expectDetect: true,
        async apply(ctx) {
            // A lender position and its pool accounting inflated together: Σ positions
            // and availableLiquidity both grow, but no USDC ever arrived.
            const posBase = BigInt(S.map2Slot(ctx.agentAId, ctx.addr._testAccounts.lender1, S.SLOT.positions));
            const curPos = BigInt(await S.getStorage(ctx.v6Addr, posBase));
            await S.setStorage(ctx.v6Addr, posBase, curPos + USDC(2000));
            const poolBase = BigInt(S.mapSlot(ctx.agentAId, S.SLOT.agentPools));
            const curTl = BigInt(await S.getStorage(ctx.v6Addr, poolBase + 2n)); // totalLiquidity
            await S.setStorage(ctx.v6Addr, poolBase + 2n, curTl + USDC(2000));
            const curAv = BigInt(await S.getStorage(ctx.v6Addr, poolBase + 3n)); // availableLiquidity
            await S.setStorage(ctx.v6Addr, poolBase + 3n, curAv + USDC(2000));
        },
    },
    {
        key: 'insolvency_pool_only',
        title: '(d2) Pool-level insolvency: lender claims exceed pool backing, global balance still looks fine',
        expectDetect: true,
        async apply(ctx) {
            // Only the lender position grows — the pool's availableLiquidity does not.
            const posBase = BigInt(S.map2Slot(ctx.agentAId, ctx.addr._testAccounts.lender1, S.SLOT.positions));
            const curPos = BigInt(await S.getStorage(ctx.v6Addr, posBase));
            await S.setStorage(ctx.v6Addr, posBase, curPos + USDC(300));
        },
    },

    // ---- (e) totalLoaned vs ACTIVE loans --------------------------------------------
    {
        key: 'totalloaned_mismatch',
        title: '(e) pool.totalLoaned disagrees with the sum of ACTIVE loans (seedPool zeroes it under an open loan)',
        expectDetect: true,
        async apply(ctx) {
            // The F-08 note: seedPool on a pool with active loans zeroes totalLoaned.
            const p = await ctx.v6.getAgentPool(ctx.agentAId);
            await ctx.v6.seedPool(ctx.agentAId, ctx.addr._testAccounts.agentA, p[1], p[2], p[4]);
        },
    },

    // ---- (f) ownership change ---------------------------------------------------------
    {
        key: 'ownership_change',
        title: '(f) Ownership handed to a different wallet (Ownable2Step transfer + accept)',
        expectDetect: true,
        async apply(ctx) {
            const attacker = ctx.signers[7];
            await ctx.v6.transferOwnership(attacker.address);
            await ctx.v6.connect(attacker).acceptOwnership();
        },
    },
    {
        key: 'ownership_pending',
        title: '(f2) Ownership transfer PENDING but not yet accepted (pendingOwner set)',
        expectDetect: true,
        async apply(ctx) {
            await ctx.v6.transferOwnership(ctx.signers[7].address);
        },
    },

    // ---- (g) unexpected pause ---------------------------------------------------------
    {
        key: 'unexpected_pause',
        title: '(g) Contract paused without an operator expecting it',
        expectDetect: true,
        async apply(ctx) { await ctx.v6.pause(); },
    },

    // ---- (h) accumulatedFees > balance --------------------------------------------------
    {
        key: 'fees_exceed_balance',
        title: '(h) accumulatedFees exceeds the marketplace USDC balance',
        expectDetect: true,
        async apply(ctx) {
            await S.setStorage(ctx.v6Addr, S.SLOT.accumulatedFees, USDC(999999));
        },
    },

    // ================= V6.1-specific state =================================================
    {
        key: 'v61_pending_gt_position',
        title: '[V6.1] pendingTranche.amount exceeds position.amount',
        expectDetect: true,
        async apply(ctx) {
            const posBase = BigInt(S.map2Slot(ctx.agentAId, ctx.addr._testAccounts.lender1, S.SLOT.positions));
            const amount = BigInt(await S.getStorage(ctx.v6Addr, posBase));
            const ts = BigInt(await S.getStorage(ctx.v6Addr, posBase + 2n));
            const slot = S.map2Slot(ctx.agentAId, ctx.addr._testAccounts.lender1, S.SLOT.pendingTranche);
            await S.setStorage(ctx.v6Addr, slot, packTranche(amount + USDC(1000), ts + 10n));
        },
    },
    {
        key: 'v61_pending_ts_before_base',
        title: '[V6.1] pendingTranche timestamp older than the base tranche (re-qualifies unqualified money)',
        expectDetect: true,
        async apply(ctx) {
            const posBase = BigInt(S.map2Slot(ctx.agentAId, ctx.addr._testAccounts.lender1, S.SLOT.positions));
            const ts = BigInt(await S.getStorage(ctx.v6Addr, posBase + 2n));
            const slot = S.map2Slot(ctx.agentAId, ctx.addr._testAccounts.lender1, S.SLOT.pendingTranche);
            await S.setStorage(ctx.v6Addr, slot, packTranche(USDC(100), ts - 1000n));
        },
    },
    {
        key: 'v61_activeloanids_stale',
        title: '[V6.1] activeLoanIds contains a REPAID loan id (stale entry, count still 1)',
        expectDetect: true,
        async apply(ctx) {
            const lenSlot = BigInt(S.mapSlot(ctx.agentAId, S.SLOT.activeLoanIds));
            const len = BigInt(await S.getStorage(ctx.v6Addr, lenSlot));
            const data = BigInt(ethers.keccak256(S.h32(lenSlot)));
            await S.setStorage(ctx.v6Addr, data + len, 1); // loan #1 is REPAID
            await S.setStorage(ctx.v6Addr, lenSlot, len + 1n);
        },
    },
    {
        key: 'v61_activeloanids_missing',
        title: '[V6.1] activeLoanIds emptied while activeLoanCount still says 1 (missing ACTIVE loan)',
        expectDetect: true,
        async apply(ctx) {
            await S.setStorage(ctx.v6Addr, S.mapSlot(ctx.agentAId, S.SLOT.activeLoanIds), 0);
        },
    },
    {
        key: 'v61_qualified_revert',
        title: '[V6.1] pending > amount makes qualifiedAmountAt revert — _distributeInterest would revert, freezing every repayment on the pool',
        expectDetect: true,
        async apply(ctx) {
            // Give the lender a pending tranche stamped BEFORE the active loan while
            // leaving position.amount untouched: qualifiedAmountAt returns
            // (amount − pending) + pending = amount for the base, plus the pending
            // again is not possible — so inflate position bookkeeping instead:
            // set pendingTranche with an old timestamp AND shrink position.amount so
            // the qualified sum exceeds Σ positions.
            const lender = ctx.addr._testAccounts.lender2;
            const posBase = BigInt(S.map2Slot(ctx.agentAId, lender, S.SLOT.positions));
            const amount = BigInt(await S.getStorage(ctx.v6Addr, posBase));
            const ts = BigInt(await S.getStorage(ctx.v6Addr, posBase + 2n));
            const slot = S.map2Slot(ctx.agentAId, lender, S.SLOT.pendingTranche);
            // pending > amount with an old timestamp: qualified = (amount-pending
            // underflow-free in solidity? it reverts) — use pending == amount and then
            // halve position.amount so pending > amount.
            await S.setStorage(ctx.v6Addr, slot, packTranche(amount, ts - 100n));
            await S.setStorage(ctx.v6Addr, posBase, amount / 2n);
        },
    },
    {
        key: 'v61_lateness_regression',
        title: '[V6.1] lateRepayCount rewritten downwards (non-monotonic lateness record)',
        expectDetect: true,
        async apply(ctx) {
            await S.setStorage(ctx.v6Addr, S.mapSlot(ctx.agentAId, S.SLOT.lateRepayCount), 0);
        },
    },
    {
        key: 'v61_lateness_inflated',
        title: '[V6.1] lateSecondsTotal inflated beyond the per-loan repayment records',
        expectDetect: true,
        async apply(ctx) {
            await S.setStorage(ctx.v6Addr, S.mapSlot(ctx.agentAId, S.SLOT.lateSecondsTotal), 99999999);
        },
    },
    {
        key: 'f01_nft_moved',
        title: '[F-01 follow-up] Agent NFT transferred while a loan is ACTIVE',
        expectDetect: true,
        async apply(ctx) {
            const agentA = await ethers.getSigner(ctx.addr._testAccounts.agentA);
            await ctx.registry.connect(agentA).transferFrom(agentA.address, ctx.signers[8].address, ctx.agentAId);
        },
    },
];

module.exports = { scenarios, USDC, packTranche };
