// V6 orphan probe — map every position in every V6 pool, identify orphans (positions owned by
// addresses we don't have keys for) vs. recoverable (positions owned by wallets we still hold keys to).
// Read-only.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const USDC_ABI = ['function balanceOf(address) view returns (uint256)'];
const fmt = v => Number(ethers.formatUnits(v, 6));
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, attempts = 20) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const m = (e.shortMessage || e.message || '').toLowerCase();
            const isRate = m.includes('rate') || m.includes('408') || m.includes('429') || m.includes('-32016') || m.includes('timeout') || m.includes('server response') || m.includes('econnreset');
            if (i === attempts - 1 || !isRate) throw e;
            await sleep(Math.min(2000 * Math.pow(1.5, i), 30000));
        }
    }
}
const log = (...a) => console.log(...a);

// Load all known wallet keys
function loadKnownWallets() {
    const known = new Map(); // address → privateKey
    const candidates = [
        './forensics/output/regression-2026-05-07/52-mega-stress-wallets.json',
        './forensics/output/regression-2026-05-07/52-mega-stress-extras.json',
        './forensics/output/regression-2026-05-07/52-mega-stress-extras-51st.json',
        './forensics/output/regression-2026-05-07/56-migration-helpers-agent.json',
        './forensics/output/regression-2026-05-07/56-migration-helpers-lender.json',
        './forensics/output/regression-2026-05-07/59-s5-extreme-wallets.json',
        './forensics/output/regression-2026-05-07/60-concurrent-wallets.json',
        './forensics/output/regression-2026-05-07/58-b1-differential-wallets.json'
    ];
    for (const f of candidates) {
        if (!fs.existsSync(f)) continue;
        try {
            const txt = fs.readFileSync(f, 'utf8');
            // Try parsing as one big JSON
            try {
                const j = JSON.parse(txt);
                // Various shapes
                for (const arr of [j.lenders, j.borrowers, j.extras, j]) {
                    if (Array.isArray(arr)) {
                        for (const item of arr) {
                            const addr = item.address || item.addr || item.a;
                            const key = item.privateKey || item.key || item.k;
                            if (addr && key) known.set(addr.toLowerCase(), key);
                        }
                    } else if (arr && (arr.address || arr.addr || arr.a)) {
                        known.set((arr.address || arr.addr || arr.a).toLowerCase(), arr.privateKey || arr.key || arr.k);
                    }
                }
            } catch (e) {
                // Try line-delimited JSON
                for (const line of txt.split('\n')) {
                    if (!line.trim()) continue;
                    try {
                        const j = JSON.parse(line);
                        for (const sub of [j, j.lender, j.borrower]) {
                            if (sub && (sub.address || sub.addr)) {
                                const addr = (sub.address || sub.addr).toLowerCase();
                                const key = sub.privateKey || sub.key;
                                if (addr && key) known.set(addr, key);
                            }
                        }
                    } catch (e2) {}
                }
            }
        } catch (e) {}
    }
    return known;
}

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const v6 = new ethers.Contract(V6, ABI, provider);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, provider);

    log('=========================================================');
    log('  V6 ORPHAN PROBE — ' + V6);
    log('=========================================================');

    const known = loadKnownWallets();
    log(`Loaded ${known.size} known wallet addresses from persisted key files`);

    const totalPools = Number(await withRetry(() => v6.totalPools()));
    const mpUsdc = await withRetry(() => usdc.balanceOf(V6));
    log(`V6 has ${totalPools} pools, USDC balance: ${fmt(mpUsdc)}`);

    const pools = [];
    let recoverableTotal = 0n, orphanTotal = 0n;
    const orphanPositions = [];
    const recoverablePositions = [];
    for (let i = 0; i < totalPools; i++) {
        const aid = await withRetry(() => v6.agentPoolIds(i));
        const p = await withRetry(() => v6.getAgentPool(aid));
        const lc = Number(p[6]);
        if (lc === 0 && p[1] === 0n) continue;
        const lenders = [];
        for (let j = 0; j < lc; j++) {
            const l = (await withRetry(() => v6.poolLenders(aid, j))).toLowerCase();
            if (!lenders.includes(l)) lenders.push(l);
        }
        let poolRecoverable = 0n, poolOrphan = 0n;
        for (const l of lenders) {
            const pos = await withRetry(() => v6.positions(aid, l));
            if (pos.amount === 0n) continue;
            if (known.has(l)) {
                poolRecoverable += pos.amount;
                recoverablePositions.push({ aid: Number(aid), lender: l, amount: pos.amount.toString(), earnedInterest: pos.earnedInterest.toString() });
            } else {
                poolOrphan += pos.amount;
                orphanPositions.push({ aid: Number(aid), lender: l, amount: pos.amount.toString(), earnedInterest: pos.earnedInterest.toString(), depositTimestamp: pos.depositTimestamp.toString() });
            }
        }
        recoverableTotal += poolRecoverable;
        orphanTotal += poolOrphan;
        if (poolOrphan > 0n || poolRecoverable > 0n) {
            pools.push({ aid: Number(aid), totalLiquidity: p[1].toString(), availableLiquidity: p[2].toString(), totalLoaned: p[3].toString(), lenderCount: lc, poolRecoverable: poolRecoverable.toString(), poolOrphan: poolOrphan.toString() });
            log(`  pool[${aid}]: totalLiq=${fmt(p[1])}, avail=${fmt(p[2])}, loaned=${fmt(p[3])}, recoverable=${fmt(poolRecoverable)}, ORPHAN=${fmt(poolOrphan)}`);
        }
    }

    log('\n=========================================================');
    log(`  Recoverable via persisted keys (withdrawLiquidity): ${fmt(recoverableTotal)} USDC across ${recoverablePositions.length} positions`);
    log(`  Orphan (need seedPosition migration):              ${fmt(orphanTotal)} USDC across ${orphanPositions.length} positions`);
    log(`  Total recoverable:                                 ${fmt(recoverableTotal + orphanTotal)} USDC`);
    log(`  Pools touched:                                     ${pools.length}`);
    log('=========================================================');

    fs.writeFileSync('./forensics/output/regression-2026-05-07/61-v6-orphan-probe.json', JSON.stringify({
        timestamp: new Date().toISOString(), v6Address: V6,
        knownWalletsCount: known.size, totalPools, mpUsdcBalance: mpUsdc.toString(),
        recoverableTotal: recoverableTotal.toString(), orphanTotal: orphanTotal.toString(),
        pools, recoverablePositions, orphanPositions
    }, null, 2));
    log('Saved to 61-v6-orphan-probe.json');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
