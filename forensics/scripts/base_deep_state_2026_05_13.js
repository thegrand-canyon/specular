// Base v4 deep state probe — comprehensive read-only audit of canonical contract.
//
// Maps: every pool, every lender position, every loan, identifies §B1 duplicates
// and §S1 accounting deficits with byte-exact numbers. Read-only (no transactions).

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/base-addresses.json'));
const MP = ADDR.agentLiquidityMarketplace;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;
const REG_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')).abi;
const USDC_ABI = ['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)'];
const fmt = v => Number(ethers.formatUnits(v, 6));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, attempts = 15) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const m = (e.shortMessage || e.message || '');
            const isRate = m.includes('rate') || m.includes('over rate limit') || m.includes('408') || m.includes('410') || m.includes('429') || m.includes('-32016') || m.includes('timeout') || m.includes('missing revert data');
            if (i === attempts - 1 || !isRate) throw e;
            await sleep(Math.min(1500 * Math.pow(1.6, i), 30000));
        }
    }
}
const log = (...a) => console.log(...a);

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const mp = new ethers.Contract(MP, ABI, provider);
    const reg = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, provider);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, provider);

    const t0 = Date.now();
    log('============================================================');
    log('   BASE V4 DEEP STATE PROBE — ' + new Date().toISOString());
    log('============================================================');
    log('Marketplace:', MP);
    log('Block:', await provider.getBlockNumber());

    // Top-level state
    const [paused, totalAgents, totalPools, mpUsdc, accFees, platRate, nextLoan] = await Promise.all([
        withRetry(() => mp.paused()),
        withRetry(() => reg.totalAgents()),
        withRetry(() => mp.totalPools()),
        withRetry(() => usdc.balanceOf(MP)),
        withRetry(() => mp.accumulatedFees()),
        withRetry(() => mp.platformFeeRate()),
        withRetry(() => mp.nextLoanId())
    ]);
    log('\n[1] Top-level state');
    log('  paused:', paused);
    log('  totalAgents:', totalAgents.toString());
    log('  totalPools:', totalPools.toString());
    log('  MP USDC balance:', fmt(mpUsdc));
    log('  accumulatedFees:', fmt(accFees));
    log('  platformFeeRate:', platRate.toString(), 'bps');
    log('  nextLoanId:', nextLoan.toString());

    // Walk every pool
    log('\n[2] Per-pool deep dump');
    const pools = [];
    let sumTotalLiq = 0n, sumAvail = 0n, sumLoaned = 0n, sumEarned = 0n;
    for (let i = 0; i < Number(totalPools); i++) {
        const aid = await withRetry(() => mp.agentPoolIds(i));
        const p = await withRetry(() => mp.getAgentPool(aid));
        const lc = Number(p[6]);
        const lenders = [];
        const dupCheck = new Map();
        for (let j = 0; j < lc; j++) {
            const l = (await withRetry(() => mp.poolLenders(aid, j))).toLowerCase();
            lenders.push(l);
            dupCheck.set(l, (dupCheck.get(l) || 0) + 1);
            await sleep(50);
        }
        const positions = [];
        let sumPositionAmts = 0n;
        for (const l of [...new Set(lenders)]) {
            const pos = await withRetry(() => mp.positions(aid, l));
            positions.push({ lender: l, amount: pos.amount.toString(), earnedInterest: pos.earnedInterest.toString() });
            sumPositionAmts += pos.amount;
            await sleep(50);
        }
        const dups = [...dupCheck.entries()].filter(([_, c]) => c > 1).map(([addr, count]) => ({ addr, count }));
        const pool = {
            agentId: Number(aid),
            agentAddress: p[0],
            totalLiquidity: p[1].toString(),
            availableLiquidity: p[2].toString(),
            totalLoaned: p[3].toString(),
            totalEarned: p[4].toString(),
            utilizationRate: Number(p[5]),
            lenderCount: lc,
            lenders,
            uniqueLenders: [...new Set(lenders)].length,
            duplicates: dups,
            positions,
            sumPositionAmts: sumPositionAmts.toString(),
            positionVsTotal: (sumPositionAmts - p[1]).toString()
        };
        pools.push(pool);
        sumTotalLiq += p[1]; sumAvail += p[2]; sumLoaned += p[3]; sumEarned += p[4];
        log(`  pool[${aid}]: totalLiq=${fmt(p[1])}, avail=${fmt(p[2])}, loaned=${fmt(p[3])}, earned=${fmt(p[4])}, lenders=${lc} (unique=${[...new Set(lenders)].length}, dups=${dups.length})`);
        if (dups.length) for (const d of dups) log(`    DUP §B1: ${d.addr} appears ${d.count}×`);
        if (sumPositionAmts !== p[1]) log(`    POSITION-SUM MISMATCH: Σpositions=${fmt(sumPositionAmts)}, totalLiquidity=${fmt(p[1])}, delta=${fmt(sumPositionAmts - p[1])}`);
    }

    // §S1 accounting check
    log('\n[3] §S1 accounting');
    const claimedLiabilities = sumTotalLiq + accFees;
    const deficit = claimedLiabilities - mpUsdc;
    log(`  Σ totalLiquidity:    ${fmt(sumTotalLiq)} USDC`);
    log(`  + accumulatedFees:   ${fmt(accFees)} USDC`);
    log(`  = claimedLiabilities ${fmt(claimedLiabilities)} USDC`);
    log(`  actual MP USDC bal:  ${fmt(mpUsdc)} USDC`);
    log(`  deficit (claim - actual): ${fmt(deficit)} USDC`);
    log(`  §S1 status: ${deficit > 0n ? '❌ VIOLATED' : '✅ OK'}`);

    // Per-loan dump (all loans up to nextLoanId-1)
    log('\n[4] All loans');
    const loanStates = ['REQUESTED', 'ACTIVE', 'REPAID', 'DEFAULTED'];
    const loans = [];
    for (let lid = 1n; lid < nextLoan; lid++) {
        const l = await withRetry(() => mp.loans(lid));
        loans.push({
            id: Number(lid),
            borrower: l.borrower,
            amount: l.amount.toString(),
            interest: l.interestRate.toString(),
            duration: l.duration.toString(),
            startTime: l.startTime.toString(),
            endTime: l.endTime.toString(),
            collateralAmount: l.collateralAmount.toString(),
            state: loanStates[Number(l.state)],
            agentId: Number(l.agentId)
        });
        log(`  loan[${lid}]: state=${loanStates[Number(l.state)]}, amt=${fmt(l.amount)}, agentId=${l.agentId}, borrower=${l.borrower}`);
        await sleep(50);
    }

    // §B1 aggregate
    log('\n[5] §B1 aggregate');
    const dupPools = pools.filter(p => p.duplicates.length > 0);
    log(`  pools with duplicates: ${dupPools.length} / ${pools.length}`);
    for (const p of dupPools) {
        log(`    pool ${p.agentId}: ${p.duplicates.length} duplicate addresses`);
        for (const d of p.duplicates) log(`      ${d.addr} appears ${d.count}×`);
    }

    // Final summary
    log('\n============================================================');
    log('   SUMMARY');
    log('============================================================');
    log(`pools: ${pools.length}, loans: ${loans.length}, lenders (unique union): ${new Set(pools.flatMap(p => p.lenders)).size}`);
    log(`§B1 violations: ${dupPools.length} pool(s)`);
    log(`§S1 deficit:    ${fmt(deficit)} USDC ${deficit > 0n ? '(VIOLATED)' : '(OK)'}`);
    log(`§S5: total active loans = ${loans.filter(l => l.state === 'ACTIVE').length}, defaulted = ${loans.filter(l => l.state === 'DEFAULTED').length}`);
    log(`Total duration: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    fs.writeFileSync('./forensics/output/regression-2026-05-07/53-base-deep-state.json', JSON.stringify({
        timestamp: new Date().toISOString(),
        block: await provider.getBlockNumber(),
        marketplace: MP,
        topLevel: { paused, totalAgents: totalAgents.toString(), totalPools: totalPools.toString(), mpUsdc: mpUsdc.toString(), accFees: accFees.toString(), nextLoanId: nextLoan.toString() },
        pools, loans,
        invariants: {
            B1: { violations: dupPools.length, details: dupPools.map(p => ({ aid: p.agentId, dups: p.duplicates })) },
            S1: { deficit: deficit.toString(), violated: deficit > 0n, claimedLiabilities: claimedLiabilities.toString(), mpBal: mpUsdc.toString() },
            S5: { active: loans.filter(l => l.state === 'ACTIVE').length, defaulted: loans.filter(l => l.state === 'DEFAULTED').length }
        }
    }, null, 2));
    log('Saved.');
})().catch(e => { console.error('FATAL:', e.shortMessage || e.message); process.exit(1); });
