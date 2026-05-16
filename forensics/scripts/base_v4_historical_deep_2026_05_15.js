// Base v4 historical deep dive — paged event scan over a wider window, characterize
// the full lifecycle of pool 1 (the only active pool on Base).

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/base-addresses.json'));
const MP = ADDR.agentLiquidityMarketplace;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;
const fmt = v => Number(ethers.formatUnits(v, 6));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, attempts = 20) {
    for (let i = 0; i < attempts; i++) { try { return await fn(); } catch (e) {
        const m = (e.shortMessage || e.message || '').toLowerCase();
        const isRate = m.includes('rate') || m.includes('429') || m.includes('-32016') || m.includes('timeout') || m.includes('over rate limit');
        if (i === attempts - 1 || !isRate) throw e;
        await sleep(Math.min(2500 * Math.pow(1.5, i), 60000));
    } }
}
const log = (...a) => console.log(...a);

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const mp = new ethers.Contract(MP, ABI, provider);
    const block = await provider.getBlockNumber();

    log('=== BASE V4 HISTORICAL DEEP — pool 1 lifecycle ===');
    log('Block:', block, 'MP:', MP);

    // Scan a wider window — last 100k blocks (~28 days at 2s/block)
    const fromBlock = Math.max(0, block - 100000);
    const PAGE = 5000;
    log(`Paging events ${fromBlock} → ${block} (page=${PAGE})`);

    const eventNames = ABI.filter(x => x.type === 'event').map(x => x.name);
    const eventsByType = {};
    for (const name of eventNames) eventsByType[name] = [];

    for (let from = fromBlock; from < block; from += PAGE) {
        const to = Math.min(from + PAGE - 1, block);
        for (const name of eventNames) {
            try {
                const filter = mp.filters[name]();
                const logs = await withRetry(() => mp.queryFilter(filter, from, to));
                if (logs.length > 0) {
                    eventsByType[name].push(...logs.map(l => ({ block: l.blockNumber, tx: l.transactionHash, args: l.args })));
                }
            } catch (e) {}
            await sleep(150);
        }
        if (from % (PAGE * 4) === 0) log(`  scanned ${from} → ${to}: cumulative events: ${Object.values(eventsByType).reduce((a, b) => a + b.length, 0)}`);
    }

    log('\n=== Event totals (last 100k blocks) ===');
    let total = 0;
    for (const [name, evs] of Object.entries(eventsByType)) {
        if (evs.length > 0) {
            log(`  ${name}: ${evs.length}`);
            total += evs.length;
        }
    }
    log(`  TOTAL: ${total}`);

    fs.writeFileSync('./forensics/output/regression-2026-05-07/74-base-v4-historical.json', JSON.stringify({
        timestamp: new Date().toISOString(), block, fromBlock, eventsByType,
        eventCounts: Object.fromEntries(Object.entries(eventsByType).map(([k, v]) => [k, v.length])),
        total
    }, null, 2));
    log('Saved.');
})().catch(e => { console.error('FATAL:', e.shortMessage || e.message); process.exit(1); });
