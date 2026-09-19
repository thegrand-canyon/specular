// Shared helpers for the 2026-09-19 audit FIX regression tests (V6.1).
// Builds on test/audit-2026-09/_fixture.js (exact Arc-mainnet launch config).

const { expect } = require("chai");
const { deployLaunchStack, USDC, DAY } = require("../audit-2026-09/_fixture");

/**
 * Pump an agent's score to `target` via the reputation manager's authorized-pool
 * path (the same shortcut test/foundry/V6Invariants.t.sol uses). Requires the
 * fixture to have been deployed with { rateLimit: 0 }.
 */
async function pumpScore(f, wallet, target) {
    const agentId = await f.registry.addressToAgentId(wallet.address);
    if (!(await f.reputation.authorizedPools(f.owner.address))) {
        await f.reputation.authorizePool(f.owner.address);
    }
    while ((await f.reputation["getReputationScore(uint256)"](agentId)) < BigInt(target)) {
        await f.reputation.recordLoanCompletion(wallet.address, USDC(100), true);
    }
}

/** Per-pool exact conservation: availableLiquidity + totalLoaned == Σ amount + Σ earnedInterest. */
async function poolState(f, agentId) {
    const pool = await f.v6.getAgentPool(agentId);
    let sumAmount = 0n, sumEarned = 0n, sumPending = 0n;
    for (let i = 0n; i < pool.lenderCount; i++) {
        const l = await f.v6.poolLenders(agentId, i);
        const p = await f.v6.positions(agentId, l);
        const pt = await f.v6.pendingTranche(agentId, l);
        sumAmount += p.amount; sumEarned += p.earnedInterest; sumPending += pt.amount;
        expect(pt.amount, `pending ⊆ amount for ${l}`).to.be.lte(p.amount);
    }
    return { pool, sumAmount, sumEarned, sumPending };
}

async function expectConserved(f, agentId, label = "") {
    const { pool, sumAmount, sumEarned } = await poolState(f, agentId);
    expect(pool.availableLiquidity + pool.totalLoaned, `pool conservation ${label}`).to.equal(sumAmount + sumEarned);
    expect(pool.totalLiquidity, `totalLiquidity == Σ amount ${label}`).to.equal(sumAmount);
    const { bal, rhs } = await f.solvent([agentId]);
    expect(bal, `global solvency ${label}`).to.equal(rhs);
}

/** Mirrors calculateInterest() exactly (divide-before-multiply), in SECONDS. */
function interestSec(principal, rateBps, seconds) {
    const annual = (principal * BigInt(rateBps)) / 10000n;
    return (annual * BigInt(seconds)) / BigInt(365 * DAY);
}

module.exports = { deployLaunchStack, USDC, DAY, pumpScore, poolState, expectConserved, interestSec };
