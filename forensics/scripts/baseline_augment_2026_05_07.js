// Baseline augmentation — captures what tmp_dual_network_probe.js misses.
// Read-only. Companion to tmp_dual_network_probe.js.
//
// Outputs to forensics/output/regression-2026-05-07/02-baseline-augment.{txt,json}
//   - paused() and owner() on both marketplaces
//   - poolLenders[] enumeration per pool with duplicate detection (§B1 root cause)
//   - agentLoans length for known high-volume agents (§S5)
//   - bytecode keccak hash for both marketplaces (deploy-source comparison)
//   - per-pool position summary (lender, supplied, earnedInterest)

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const NETS = {
    arc: {
        rpc: process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
        addr: JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json')),
    },
    base: {
        rpc: 'https://mainnet.base.org',
        addr: JSON.parse(fs.readFileSync('./src/config/base-addresses.json')),
    },
};

const MP_ABI = JSON.parse(fs.readFileSync(
    './artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;
const REG_ABI = JSON.parse(fs.readFileSync(
    './artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')).abi;

const fmt = (v) => Number(ethers.formatUnits(v, 6));
const OUT_DIR = './forensics/output/regression-2026-05-07';
fs.mkdirSync(OUT_DIR, { recursive: true });

const results = { arc: {}, base: {}, generatedAt: new Date().toISOString() };

async function probe(label, cfg) {
    console.log(`\n${'='.repeat(70)}\n  ${label.toUpperCase()} AUGMENTATION\n${'='.repeat(70)}`);
    const provider = new ethers.JsonRpcProvider(cfg.rpc, undefined, { batchMaxCount: 1 });
    const mp = new ethers.Contract(cfg.addr.agentLiquidityMarketplace, MP_ABI, provider);
    const registry = new ethers.Contract(cfg.addr.agentRegistryV2, REG_ABI, provider);

    const r = results[label];
    r.marketplace = cfg.addr.agentLiquidityMarketplace;

    // --- Pause state + owner ---
    console.log('\n[A] Pause + owner');
    try { r.paused = await mp.paused(); console.log(`  paused(): ${r.paused}`); }
    catch (e) { r.paused = `error: ${e.shortMessage || e.message}`; console.log(`  paused(): ${r.paused}`); }
    try { r.owner = await mp.owner(); console.log(`  owner(): ${r.owner}`); }
    catch (e) { r.owner = null; console.log(`  owner(): ${e.message}`); }

    // --- Bytecode hash ---
    console.log('\n[B] Bytecode keccak hash');
    const code = await provider.getCode(cfg.addr.agentLiquidityMarketplace);
    r.bytecodeKeccak = ethers.keccak256(code);
    r.bytecodeLen = (code.length - 2) / 2; // hex chars - "0x" prefix, /2 for bytes
    console.log(`  keccak: ${r.bytecodeKeccak}`);
    console.log(`  len:    ${r.bytecodeLen} bytes`);

    // --- §B1 root cause: duplicate poolLenders detection ---
    console.log('\n[C] §B1 duplicate poolLenders enumeration');
    const totalPools = Number(await mp.totalPools().catch(() => 0n));
    r.totalPools = totalPools;
    const dupReport = [];
    let totalLenderEntries = 0, totalUnique = 0, poolsWithDups = 0;

    for (let i = 0; i < totalPools; i++) {
        try {
            const aid = await mp.agentPoolIds(i);
            const v = await mp.getAgentPool(aid);
            const lenderCount = Number(v[6]);
            if (lenderCount === 0) continue;

            const lenders = [];
            for (let j = 0; j < lenderCount; j++) {
                lenders.push((await mp.poolLenders(aid, j)).toLowerCase());
            }
            totalLenderEntries += lenders.length;
            const unique = new Set(lenders);
            totalUnique += unique.size;

            if (lenders.length !== unique.size) {
                poolsWithDups++;
                const counts = {};
                for (const l of lenders) counts[l] = (counts[l] || 0) + 1;
                const dups = Object.entries(counts).filter(([_, c]) => c > 1);
                dupReport.push({ agentId: aid.toString(), lenderCount, uniqueCount: unique.size, duplicates: dups });
                console.log(`  pool agentId=${aid}: ${lenders.length} entries, ${unique.size} unique, dups=${dups.map(d => `${d[0].slice(0,10)}...×${d[1]}`).join(',')}`);
            }
        } catch (e) {
            console.log(`  pool index ${i}: error ${e.message}`);
        }
    }
    r.b1_totalLenderEntries = totalLenderEntries;
    r.b1_totalUniqueLenders = totalUnique;
    r.b1_poolsWithDuplicates = poolsWithDups;
    r.b1_duplicateDetail = dupReport;
    console.log(`  pools with duplicate entries: ${poolsWithDups} / ${totalPools}`);
    console.log(`  total entries: ${totalLenderEntries}, unique: ${totalUnique}, dup overhead: ${totalLenderEntries - totalUnique}`);

    // --- §S5 per-agent loan history depth ---
    console.log('\n[D] §S5 agentLoans depth on known high-volume agents');
    // Strategy: for each pool's agentId, find the wallet, then probe agentLoans length via doubling
    const KNOWN_HIGH_VOL = ['0x656086A21073272533c8A3f56A94c1f3D8BCFcE2']; // Arc Agent #43
    const samples = label === 'arc' ? KNOWN_HIGH_VOL : [];
    // Also enumerate agents from registry for completeness
    const totalAgents = Number(await registry.totalAgents());
    r.totalAgents = totalAgents;
    const checkSet = new Set(samples.map(a => a.toLowerCase()));
    for (let id = 1; id <= Math.min(totalAgents, 100); id++) {
        try {
            const a = await registry.agents(id);
            if (a.owner !== ethers.ZeroAddress) checkSet.add(a.agentWallet.toLowerCase());
        } catch {}
    }

    const loanDepths = [];
    for (const wallet of checkSet) {
        // Doubling search for agentLoans length
        let lo = 0, hi = 1;
        // Find an upper bound that fails
        while (hi < 10000) {
            try { await mp.agentLoans(wallet, hi); lo = hi; hi *= 2; }
            catch { break; }
        }
        // Binary search between lo and hi for exact length
        let length = lo + 1; // at least lo+1 if lo succeeded
        let l = lo, h = Math.min(hi, 10000);
        while (l < h) {
            const m = Math.floor((l + h) / 2);
            try { await mp.agentLoans(wallet, m); l = m + 1; }
            catch { h = m; }
        }
        length = l;
        if (length > 0) loanDepths.push({ wallet, length });
    }
    loanDepths.sort((a, b) => b.length - a.length);
    r.s5_loanDepths = loanDepths.slice(0, 20); // top 20
    console.log(`  scanned ${checkSet.size} wallets`);
    for (const { wallet, length } of loanDepths.slice(0, 10)) {
        console.log(`    ${wallet} → ${length} loans`);
    }
    if (loanDepths.length === 0) console.log('  (no loan history found in sample)');

    // --- Per-pool detailed positions (Arc only — Base has 1 pool) ---
    console.log('\n[E] Per-pool lender positions (top by earnedInterest)');
    const poolDetails = [];
    for (let i = 0; i < Math.min(totalPools, 50); i++) {
        try {
            const aid = await mp.agentPoolIds(i);
            const v = await mp.getAgentPool(aid);
            const lenderCount = Number(v[6]);
            if (lenderCount === 0) continue;
            const positions = [];
            for (let j = 0; j < lenderCount; j++) {
                const lender = await mp.poolLenders(aid, j);
                const pos = await mp.positions(aid, lender);
                positions.push({
                    lender: lender.toLowerCase(),
                    supplied: fmt(pos[0]),
                    earnedInterest: fmt(pos[1]),
                });
            }
            poolDetails.push({
                agentId: aid.toString(),
                totalLiquidity: fmt(v[1]),
                availableLiquidity: fmt(v[2]),
                totalLoaned: fmt(v[3]),
                totalEarned: fmt(v[4]),
                lenderCount,
                positions,
            });
        } catch (e) {
            console.log(`  pool ${i}: error ${e.message}`);
        }
    }
    r.poolDetails = poolDetails;
    const topInterest = poolDetails
        .flatMap(p => p.positions.map(pos => ({ agentId: p.agentId, ...pos })))
        .filter(p => p.earnedInterest > 0)
        .sort((a, b) => b.earnedInterest - a.earnedInterest)
        .slice(0, 10);
    if (topInterest.length > 0) {
        console.log(`  top earnedInterest positions:`);
        for (const t of topInterest) {
            console.log(`    pool ${t.agentId} / ${t.lender.slice(0,10)}... → ${t.earnedInterest.toFixed(6)} USDC`);
        }
    } else {
        console.log('  (no positions with earnedInterest > 0)');
    }
}

(async () => {
    await probe('arc', NETS.arc);
    await probe('base', NETS.base);

    console.log(`\n${'='.repeat(70)}\n  CROSS-NETWORK SUMMARY\n${'='.repeat(70)}`);
    console.log(`                                Arc                    Base`);
    console.log(`  paused()                    : ${String(results.arc.paused).padEnd(22)} ${results.base.paused}`);
    console.log(`  owner()                     : ${String(results.arc.owner).slice(0,22).padEnd(22)} ${String(results.base.owner).slice(0,22)}`);
    console.log(`  totalPools                  : ${String(results.arc.totalPools).padEnd(22)} ${results.base.totalPools}`);
    console.log(`  pools w/ dup poolLenders    : ${String(results.arc.b1_poolsWithDuplicates).padEnd(22)} ${results.base.b1_poolsWithDuplicates}`);
    console.log(`  dup overhead (entries-uniq) : ${String(results.arc.b1_totalLenderEntries - results.arc.b1_totalUniqueLenders).padEnd(22)} ${results.base.b1_totalLenderEntries - results.base.b1_totalUniqueLenders}`);
    console.log(`  bytecode keccak             : ${results.arc.bytecodeKeccak.slice(0,22)} ${results.base.bytecodeKeccak.slice(0,22)}`);
    console.log(`  bytecode len                : ${String(results.arc.bytecodeLen).padEnd(22)} ${results.base.bytecodeLen}`);
    const arcMaxLoan = results.arc.s5_loanDepths[0]?.length || 0;
    const baseMaxLoan = results.base.s5_loanDepths[0]?.length || 0;
    console.log(`  max agentLoans depth        : ${String(arcMaxLoan).padEnd(22)} ${baseMaxLoan}`);

    fs.writeFileSync(path.join(OUT_DIR, '02-baseline-augment.json'), JSON.stringify(results, null, 2));
    console.log(`\nSaved: ${OUT_DIR}/02-baseline-augment.json`);
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
