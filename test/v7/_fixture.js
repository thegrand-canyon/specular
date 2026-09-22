// Shared fixture for the V7 credit-model suites (ReputationManagerV4 + AgentLiquidityMarketplaceV62).
//
// Mirrors test/audit-2026-09/_fixture.js (the live Arc-mainnet launch config) so the
// F-01/F-02/F-03/F-05/F-07 regression suites can be replayed against V6.2 with the
// same setup, and adds the V7 knobs (ladder, lockout, tier table, late penalty).

const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const USDC = (n) => ethers.parseUnits(n.toString(), 6);
const DAY = 24 * 60 * 60;

/** V7 default tier table, as shipped in ReputationManagerV4. */
const DEFAULT_TIER_LIMITS = [USDC(1000), USDC(5000), USDC(10000), USDC(10000), USDC(2500), USDC(5000)];
const DEFAULT_TIER_COLLATERAL = [100, 100, 100, 75, 0, 0];
const TIER_MIN_SCORE = [0, 200, 400, 500, 600, 800];

async function deployV7Stack(opts = {}) {
    const signers = await ethers.getSigners();
    const [owner] = signers;
    const registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
    const reputation = await (await ethers.getContractFactory("ReputationManagerV4")).deploy(await registry.getAddress());
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const v62 = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV62")).deploy(
        await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
    await reputation.authorizePool(await v62.getAddress());

    // Live Arc-mainnet levers, carried forward.
    await reputation.setReputationRateLimit(opts.rateLimit ?? 20, DAY);
    await v62.setMinHoldForReputationReward(opts.minHold ?? DAY);
    await v62.setPlatformFeeRate(opts.feeBps ?? 100);
    await v62.setBindBorrowToPoolCreator(opts.bindM1 ?? true);
    await v62.setMinSupplyAmount(opts.minSupply ?? USDC(1));
    // V7 knobs
    await reputation.setLadderParameters(
        opts.creditMultiple ?? 2,
        opts.growthStep ?? USDC(100),
        opts.bootstrapLimit ?? USDC(100),
        opts.refDuration ?? 7 * DAY
    );
    await reputation.setDefaultLockout(opts.lockout ?? 180 * DAY);
    if (opts.tierLimits) await reputation.setTierLimits(opts.tierLimits);
    if (opts.finalizeMigration !== false) await v62.setMigrationFinalized();

    async function fund(w, amount = USDC(1_000_000)) {
        await usdc.mint(w.address, amount);
        await usdc.connect(w).approve(await v62.getAddress(), ethers.MaxUint256);
    }
    async function onboardAgent(w, uri = "ipfs://agent") {
        await registry.connect(w).register(uri, []);
        const id = await registry.addressToAgentId(w.address);
        await reputation.connect(w)["initializeReputation()"]();
        await v62.connect(w).createAgentPool();
        return id;
    }
    function interestFor(principal, rateBps, days) {
        const annual = (principal * BigInt(rateBps)) / 10000n;
        return (annual * BigInt(days * DAY)) / BigInt(365 * DAY);
    }
    async function solvent(agentIds) {
        let sumAvail = 0n, sumColl = 0n;
        for (const aid of agentIds) sumAvail += (await v62.getAgentPool(aid)).availableLiquidity;
        const n = await v62.nextLoanId();
        for (let id = 1n; id < n; id++) {
            const l = await v62.loans(id);
            if (Number(l.state) === 1) sumColl += l.collateralAmount;
        }
        const bal = await usdc.balanceOf(await v62.getAddress());
        return { bal, rhs: sumAvail + (await v62.accumulatedFees()) + sumColl };
    }

    // Alias `v6` so the V6.1 regression suites can be replayed verbatim against V6.2.
    return {
        signers, owner, registry, reputation, usdc, v62, v6: v62,
        fund, onboardAgent, interestFor, solvent, USDC, DAY, time,
    };
}

/**
 * Raise an agent's score to `target` through the authorized-pool path, bypassing the
 * loan machinery. Each synthetic completion uses a distinct loanId that was never
 * `recordBorrow`n, so hold time falls back to "now" → zero bonus; instead we record
 * the borrow first so the hold is a full `refDuration`.
 */
async function pumpScore(f, wallet, target) {
    const agentId = await f.registry.addressToAgentId(wallet.address);
    if (!(await f.reputation.authorizedPools(f.owner.address))) {
        await f.reputation.authorizePool(f.owner.address);
    }
    let synthetic = 1_000_000;
    while ((await f.reputation["getReputationScore(uint256)"](agentId)) < BigInt(target)) {
        const id = synthetic++;
        await f.reputation.recordBorrow(wallet.address, id, USDC(100));
        await f.time.increase(7 * DAY);
        await f.reputation.recordLoanCompletion(wallet.address, id, USDC(100), true, 0);
    }
}

/** Raise the ladder capacity (maxRepaidPrincipal) to `amount` directly. */
async function pumpCapacity(f, wallet, amount) {
    if (!(await f.reputation.authorizedPools(f.owner.address))) {
        await f.reputation.authorizePool(f.owner.address);
    }
    const id = 2_000_000 + Number(await f.reputation.loanCount(await f.registry.addressToAgentId(wallet.address)));
    await f.reputation.recordBorrow(wallet.address, id, amount);
    await f.time.increase(7 * DAY);
    await f.reputation.recordLoanCompletion(wallet.address, id, amount, true, 0);
}

async function poolState(f, agentId) {
    const pool = await f.v62.getAgentPool(agentId);
    let sumAmount = 0n, sumEarned = 0n, sumPending = 0n;
    for (let i = 0n; i < pool.lenderCount; i++) {
        const l = await f.v62.poolLenders(agentId, i);
        const p = await f.v62.positions(agentId, l);
        const pt = await f.v62.pendingTranche(agentId, l);
        sumAmount += p.amount; sumEarned += p.earnedInterest; sumPending += pt.amount;
    }
    return { pool, sumAmount, sumEarned, sumPending };
}

async function expectConserved(f, agentId, label = "") {
    const { expect } = require("chai");
    const { pool, sumAmount, sumEarned } = await poolState(f, agentId);
    expect(pool.availableLiquidity + pool.totalLoaned, `pool conservation ${label}`).to.equal(sumAmount + sumEarned);
    expect(pool.totalLiquidity, `totalLiquidity == Σ amount ${label}`).to.equal(sumAmount);
    const { bal, rhs } = await f.solvent([agentId]);
    expect(bal, `global solvency ${label}`).to.equal(rhs);
}

module.exports = {
    deployV7Stack, USDC, DAY, pumpScore, pumpCapacity, poolState, expectConserved,
    DEFAULT_TIER_LIMITS, DEFAULT_TIER_COLLATERAL, TIER_MIN_SCORE,
};
