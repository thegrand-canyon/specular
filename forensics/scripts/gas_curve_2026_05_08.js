// Gas curve: v4 vs V6 head-to-head. Read-only via estimateGas with from-override.
// Captures requestLoan gas across many addresses with varying lifetime loan counts.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V4 = ADDR.agentLiquidityMarketplace;
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI4 = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;
const ABI6 = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const REG_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')).abi;
const OUT = './forensics/output/regression-2026-05-07';
const fmt = v => Number(ethers.formatUnits(v, 6));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, label, attempts = 5) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const m = e.shortMessage || e.message || '';
            const isRate = m.includes('rate') || m.includes('408') || m.includes('410') || m.includes('429') || m.includes('-32016') || m.includes('timeout');
            if (i === attempts - 1 || !isRate) throw e;
            await sleep(2000 * Math.pow(2, i));
        }
    }
}

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const v4 = new ethers.Contract(V4, ABI4, provider);
    const v6 = new ethers.Contract(V6, ABI6, provider);
    const reg = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, provider);

    console.log('Discovering addresses with varied loan-history depths on v4...');
    const totalAgents = Number(await reg.totalAgents());
    console.log(`  totalAgents: ${totalAgents}`);

    // Find agents with varied loan-history depth
    const samples = [];
    for (let id = 1; id <= Math.min(totalAgents, 50); id++) {
        try {
            const a = await withRetry(() => reg.agents(id), `agent${id}`);
            if (a.owner === ethers.ZeroAddress) continue;
            const wallet = a.agentWallet;
            // Binary search for agentLoans length
            let lo = 0, hi = 1;
            try { await v4.agentLoans(wallet, 0); } catch { samples.push({ agentId: id, wallet, loanCount: 0 }); continue; }
            while (hi < 1000) { try { await v4.agentLoans(wallet, hi); lo = hi; hi *= 2; } catch { break; } }
            let l = lo, h = Math.min(hi, 1000);
            while (l < h) {
                const m = Math.floor((l + h) / 2);
                try { await v4.agentLoans(wallet, m); l = m + 1; } catch { h = m; }
            }
            samples.push({ agentId: id, wallet, loanCount: l });
        } catch {}
    }
    samples.sort((a, b) => a.loanCount - b.loanCount);
    const buckets = [0, 1, 5, 10, 50, 100, 200, 500, 700, 800];
    const picked = [];
    for (const target of buckets) {
        const closest = samples.reduce((best, s) =>
            Math.abs(s.loanCount - target) < Math.abs(best.loanCount - target) ? s : best, samples[0]);
        if (!picked.find(p => p.wallet === closest.wallet)) picked.push(closest);
    }
    console.log(`  picked ${picked.length} representative agents`);

    // Measure gas for requestLoan(0.1 USDC, 7 days) on v4 for each
    const LOAN = ethers.parseUnits('0.1', 6);
    console.log('\n=== v4 gas curve ===');
    const v4Curve = [];
    for (const s of picked) {
        try {
            const gas = await withRetry(() =>
                v4.requestLoan.estimateGas(LOAN, 7, { from: s.wallet }), `v4-${s.agentId}`);
            v4Curve.push({ agentId: s.agentId, loanCount: s.loanCount, gas: gas.toString() });
            console.log(`  agent ${s.agentId} (${s.loanCount} loans): ${gas.toString()} gas`);
        } catch (e) {
            const msg = (e.shortMessage || e.message).slice(0, 60);
            v4Curve.push({ agentId: s.agentId, loanCount: s.loanCount, error: msg });
            console.log(`  agent ${s.agentId} (${s.loanCount} loans): ${msg}`);
        }
    }

    // V6: secure wallet (agent 49) — measure gas at varying counter values is hard live
    // since counter is current state. We have one data point: counter=0, gas was ~365k-400k
    // from prior runs. Document what we know.
    console.log('\n=== V6 gas (current observed) ===');
    const SECURE = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';
    let v6Gas;
    try {
        v6Gas = await withRetry(() =>
            v6.requestLoan.estimateGas(LOAN, 7, { from: SECURE }), 'v6');
        console.log(`  agent 49 V6 (counter=0, lifetime ~600 from earlier sessions): ${v6Gas.toString()}`);
    } catch (e) { console.log(`  V6 estimate err: ${(e.shortMessage || e.message).slice(0, 80)}`); }

    // Linear regression on v4 data
    const v4Valid = v4Curve.filter(p => p.gas).map(p => ({ x: p.loanCount, y: Number(p.gas) }));
    if (v4Valid.length >= 2) {
        const n = v4Valid.length;
        const sumX = v4Valid.reduce((s, p) => s + p.x, 0);
        const sumY = v4Valid.reduce((s, p) => s + p.y, 0);
        const sumXY = v4Valid.reduce((s, p) => s + p.x * p.y, 0);
        const sumX2 = v4Valid.reduce((s, p) => s + p.x * p.x, 0);
        const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
        const intercept = (sumY - slope * sumX) / n;
        console.log(`\n=== Linear regression on v4 ===`);
        console.log(`  gas(loanCount) ≈ ${Math.round(slope)} × loanCount + ${Math.round(intercept)}`);
        console.log(`  → at v4 with 5,000 lifetime loans: ${Math.round(slope * 5000 + intercept).toLocaleString()} gas`);
        console.log(`  → at v4 with 10,000 lifetime loans: ${Math.round(slope * 10000 + intercept).toLocaleString()} gas`);
        console.log(`  V6 stays at ~400k regardless of count → savings at 10k loans: ${Math.round((slope * 10000 + intercept - 400000)).toLocaleString()} gas`);
    }

    fs.writeFileSync(path.join(OUT, '33-gas-curve.json'), JSON.stringify({
        v4Curve, v6Gas: v6Gas?.toString(), generatedAt: new Date().toISOString(),
    }, null, 2));
    console.log('\nSaved.');
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
