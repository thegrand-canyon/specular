// Base v4 event history scan — last 1k blocks of marketplace activity, characterize.
// Read-only.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/base-addresses.json'));
const MP = ADDR.agentLiquidityMarketplace;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;
const fmt = v => Number(ethers.formatUnits(v, 6));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, attempts = 15) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) { if (i === attempts - 1) throw e; await sleep(2000); }
    }
}
const log = (...a) => console.log(...a);

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const mp = new ethers.Contract(MP, ABI, provider);
    const block = await provider.getBlockNumber();

    log('=== BASE V4 EVENT HISTORY (last 10k blocks) ===');
    log('Block:', block, 'MP:', MP);

    const fromBlock = block - 10000;
    log(`Scanning ${fromBlock} → ${block}`);

    // Discover event topics by reading the ABI
    const eventNames = ABI.filter(x => x.type === 'event').map(x => x.name);
    log('Event types in ABI:', eventNames.length);

    const events = {};
    for (const name of eventNames) {
        try {
            const filter = mp.filters[name]();
            const logs = await withRetry(() => mp.queryFilter(filter, fromBlock, block));
            if (logs.length > 0) {
                events[name] = logs.length;
                log(`  ${name}: ${logs.length} events`);
            }
        } catch (e) { /* event filter not supported */ }
    }
    log(`\nTotal active event types: ${Object.keys(events).length}`);
    const total = Object.values(events).reduce((a, b) => a + b, 0);
    log(`Total events: ${total}`);

    fs.writeFileSync('./forensics/output/regression-2026-05-07/67-base-event-history.json', JSON.stringify({
        timestamp: new Date().toISOString(), fromBlock, toBlock: block, events, total
    }, null, 2));
    log('Saved.');
})().catch(e => { console.error('FATAL:', e.shortMessage || e.message); process.exit(1); });
