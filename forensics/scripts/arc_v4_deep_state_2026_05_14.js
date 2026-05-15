// Arc v4 deep state probe — companion to base_deep_state_2026_05_13.js
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const MP = ADDR.agentLiquidityMarketplace; // v4 canonical
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;
const REG_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')).abi;
const USDC_ABI = ['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)'];
const fmt = v => Number(ethers.formatUnits(v, 6));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, attempts = 20) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const m = (e.shortMessage || e.message || '').toLowerCase();
            const isRate = m.includes('rate') || m.includes('408') || m.includes('429') || m.includes('-32016') || m.includes('timeout') || m.includes('server response') || m.includes('over rate limit') || m.includes('missing revert data');
            if (i === attempts - 1 || !isRate) throw e;
            await sleep(Math.min(2000 * Math.pow(1.5, i), 30000));
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
    log('   ARC V4 DEEP STATE PROBE — ' + new Date().toISOString());
    log('============================================================');
    log('Marketplace:', MP);
    log('Block:', await provider.getBlockNumber());

    const [paused, totalAgents, totalPools, mpUsdc, accFees, nextLoan] = await Promise.all([
        withRetry(() => mp.paused()), withRetry(() => reg.totalAgents()),
        withRetry(() => mp.totalPools()), withRetry(() => usdc.balanceOf(MP)),
        withRetry(() => mp.accumulatedFees()), withRetry(() => mp.nextLoanId())
    ]);
    log('\n[1] Top-level state');
    log('  paused:', paused);
    log('  totalAgents:', totalAgents.toString());
    log('  totalPools:', totalPools.toString());
    log('  MP USDC bal:', fmt(mpUsdc));
    log('  accumulatedFees:', fmt(accFees));
    log('  nextLoanId:', nextLoan.toString());

    log('\n[2] Per-pool deep dump');
    const pools = [];
    let sumTotalLiq = 0n, sumAvail = 0n, sumLoaned = 0n, sumEarned = 0n, sumPositionEarnedInterest = 0n;
    for (let i = 0; i < Number(totalPools); i++) {
        const aid = await withRetry(() => mp.agentPoolIds(i));
        const p = await withRetry(() => mp.getAgentPool(aid));
        const lc = Number(p[6]);
        const lenders = [];
        const dupMap = new Map();
        for (let j = 0; j < lc; j++) {
            const l = (await withRetry(() => mp.poolLenders(aid, j))).toLowerCase();
            lenders.push(l); dupMap.set(l, (dupMap.get(l) || 0) + 1);
            await sleep(30);
        }
        let sumPositionAmts = 0n;
        let positionEarnedSum = 0n;
        for (const l of [...new Set(lenders)]) {
            const pos = await withRetry(() => mp.positions(aid, l));
            sumPositionAmts += pos.amount;
            positionEarnedSum += pos.earnedInterest;
            await sleep(30);
        }
        const dups = [...dupMap.entries()].filter(([_, c]) => c > 1).map(([addr, count]) => ({ addr, count }));
        const pool = {
            agentId: Number(aid), agentAddress: p[0],
            totalLiquidity: p[1].toString(), availableLiquidity: p[2].toString(),
            totalLoaned: p[3].toString(), totalEarned: p[4].toString(),
            lenderCount: lc, uniqueLenders: [...new Set(lenders)].length,
            duplicates: dups, sumPositionAmts: sumPositionAmts.toString(),
            positionEarnedSum: positionEarnedSum.toString()
        };
        pools.push(pool);
        sumTotalLiq += p[1]; sumAvail += p[2]; sumLoaned += p[3]; sumEarned += p[4];
        sumPositionEarnedInterest += positionEarnedSum;
        if (dups.length || sumPositionAmts !== p[1] || (i % 5 === 0)) {
            log(`  pool[${aid}]: totalLiq=${fmt(p[1])}, avail=${fmt(p[2])}, loaned=${fmt(p[3])}, earned=${fmt(p[4])}, lc=${lc} (uniq=${[...new Set(lenders)].length}, dups=${dups.length})`);
            if (dups.length) for (const d of dups) log(`    DUP §B1: ${d.addr} ×${d.count}`);
        }
    }
    log(`  total ${pools.length} pools scanned, ${pools.filter(p => p.duplicates.length > 0).length} with §B1 duplicates`);

    // §S1 with earned interest factored in
    const claimedLiabilities = sumTotalLiq + accFees + sumPositionEarnedInterest;
    log('\n[3] §S1 accounting (with position.earnedInterest)');
    log(`  Σ totalLiquidity:           ${fmt(sumTotalLiq)} USDC`);
    log(`  + accumulatedFees:          ${fmt(accFees)} USDC`);
    log(`  + Σ position.earnedInterest: ${fmt(sumPositionEarnedInterest)} USDC`);
    log(`  = claimedLiabilities:       ${fmt(claimedLiabilities)} USDC`);
    log(`  actual MP USDC bal:         ${fmt(mpUsdc)} USDC`);
    log(`  §S1 deficit (phantom):      ${fmt(claimedLiabilities - mpUsdc)} USDC`);
    log(`  §S1 status: ${claimedLiabilities > mpUsdc ? '❌ VIOLATED' : '✅ OK'}`);

    // Available > totalLiquidity is the §S1 phantom mechanism
    const phantomPools = pools.filter(p => BigInt(p.availableLiquidity) > BigInt(p.totalLiquidity));
    log('\n[4] §S1 phantom mechanism (avail > totalLiq)');
    log(`  pools with avail > totalLiquidity: ${phantomPools.length}`);
    for (const p of phantomPools.slice(0, 10)) {
        const phantom = BigInt(p.availableLiquidity) - BigInt(p.totalLiquidity);
        log(`    pool ${p.agentId}: avail=${fmt(BigInt(p.availableLiquidity))} > totalLiq=${fmt(BigInt(p.totalLiquidity))}, phantom=${fmt(phantom)} USDC`);
    }

    // §S5 — highest loan-count agents
    log('\n[5] §S5 — top 10 highest-load agents by lifetime loans');
    const agentLoansCount = {};
    for (let lid = 1n; lid < nextLoan; lid++) {
        try {
            const l = await withRetry(() => mp.loans(lid));
            const a = l.borrower.toLowerCase();
            agentLoansCount[a] = (agentLoansCount[a] || 0) + 1;
        } catch (e) { break; }
        if (lid % 100n === 0n) log(`  scanned ${lid}/${nextLoan} loans`);
    }
    const top = Object.entries(agentLoansCount).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [addr, n] of top) log(`  ${addr}: ${n} lifetime loans`);

    log('\n============================================================');
    log('   SUMMARY');
    log('============================================================');
    log(`pools: ${pools.length}`);
    log(`§B1 violations: ${pools.filter(p => p.duplicates.length > 0).length} pools`);
    log(`§S1 phantom pools: ${phantomPools.length}`);
    log(`§S1 total deficit: ${fmt(claimedLiabilities - mpUsdc)} USDC`);
    log(`Duration: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    fs.writeFileSync('./forensics/output/regression-2026-05-07/57-arc-v4-deep-state.json', JSON.stringify({
        timestamp: new Date().toISOString(), block: await provider.getBlockNumber(),
        marketplace: MP, pools, agentLoansCount,
        invariants: {
            B1: { violations: pools.filter(p => p.duplicates.length > 0).length },
            S1: { deficit: (claimedLiabilities - mpUsdc).toString(), violated: claimedLiabilities > mpUsdc, phantomPools: phantomPools.length },
            S5: { topAgents: top }
        }
    }, null, 2));
    log('Saved.');
})().catch(e => { console.error('FATAL:', e.shortMessage || e.message); process.exit(1); });
