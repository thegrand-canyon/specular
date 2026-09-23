// §B1 forensic trace on Arc v4 — map exactly WHEN each duplicate was created.
// Walks LiquiditySupplied / LiquidityWithdrawn events for each affected pool,
// reconstructs the supply/withdraw timeline that produced the duplicate.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const MP = ADDR.agentLiquidityMarketplace; // v4
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;
const fmt = v => Number(ethers.formatUnits(v, 6));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, attempts = 15) {
    for (let i = 0; i < attempts; i++) { try { return await fn(); } catch (e) { if (i === attempts - 1) throw e; await sleep(2000); } }
}
const log = (...a) => console.log(...a);

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const mp = new ethers.Contract(MP, ABI, provider);

    log('=== Arc v4 §B1 FORENSIC TRACE ===');
    const block = await provider.getBlockNumber();
    log('Block:', block, 'MP:', MP);

    // Known §B1-affected agents on Arc v4: 43 (compromised wallet) and 49 (secure wallet duplicated)
    const AFFECTED_AGENTS = [43, 49];

    for (const aid of AFFECTED_AGENTS) {
        log(`\n--- Pool ${aid} ---`);
        const p = await withRetry(() => mp.getAgentPool(aid));
        log(`  totalLiq=${fmt(p[1])}, avail=${fmt(p[2])}, lenderCount=${p[6]}`);

        // Walk poolLenders, find duplicates
        const lenders = [];
        const dupMap = new Map();
        for (let j = 0; j < Number(p[6]); j++) {
            const l = (await withRetry(() => mp.poolLenders(aid, j))).toLowerCase();
            lenders.push(l);
            dupMap.set(l, (dupMap.get(l) || 0) + 1);
            await sleep(100);
        }
        const dupAddrs = [...dupMap.entries()].filter(([_, c]) => c > 1).map(([a]) => a);
        log(`  duplicate addresses: ${dupAddrs.length}`);
        for (const d of dupAddrs) log(`    ${d} (×${dupMap.get(d)})`);

        // Get event history for the affected agent
        // Scan deep — Arc has fast blocks, scan recent 50k blocks
        const fromBlock = Math.max(0, block - 50000);
        log(`  scanning events ${fromBlock} → ${block}`);
        for (const dup of dupAddrs) {
            log(`\n  Tracing ${dup} on pool ${aid}:`);
            const supplyFilter = mp.filters.LiquiditySupplied(aid, dup);
            const supplyLogs = await withRetry(() => mp.queryFilter(supplyFilter, fromBlock, block));
            const withdrawFilter = mp.filters.LiquidityWithdrawn(aid, dup);
            const withdrawLogs = await withRetry(() => mp.queryFilter(withdrawFilter, fromBlock, block));
            log(`    ${supplyLogs.length} supplies, ${withdrawLogs.length} withdrawals (last 50k blocks)`);

            const combined = [];
            for (const e of supplyLogs) combined.push({ block: e.blockNumber, type: 'SUPPLY', amount: e.args.amount });
            for (const e of withdrawLogs) combined.push({ block: e.blockNumber, type: 'WITHDRAW', amount: e.args.amount });
            combined.sort((a, b) => a.block - b.block);
            for (const ev of combined.slice(0, 20)) {
                log(`      block ${ev.block}: ${ev.type} ${fmt(ev.amount)} USDC`);
            }
            if (combined.length > 20) log(`      ... +${combined.length - 20} more events`);
        }
    }

    fs.writeFileSync('./forensics/output/regression-2026-05-07/71-b1-forensic.json', JSON.stringify({
        timestamp: new Date().toISOString(), block, affectedAgents: AFFECTED_AGENTS
    }, null, 2));
    log('\nSaved.');
})().catch(e => { console.error('FATAL:', e.shortMessage || e.message); process.exit(1); });
