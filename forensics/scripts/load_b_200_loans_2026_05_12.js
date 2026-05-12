// Track B (scaled) — 200-loan churn on Arc V6 with rate-limit-aware delays.
// Sustains on a single wallet to confirm §S5 fix at higher loan history depth.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const USDC_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'];
const fmt = v => Number(ethers.formatUnits(v, 6));
const OUT = './forensics/output/regression-2026-05-07';

const SELF_AGENT = 49n;
const TOTAL = 200;
const BATCH = 10;
const LOAN_AMT = ethers.parseUnits('1', 6);
const POOL_SEED = ethers.parseUnits('500', 6);
const INTER_TX_DELAY = 300; // ms — gives RPC breathing room

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, attempts = 12) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const m = e.shortMessage || e.message || '';
            const isRate = m.includes('rate') || m.includes('408') || m.includes('410') || m.includes('429') || m.includes('-32016') || m.includes('timeout');
            if (i === attempts - 1 || !isRate) throw e;
            const wait = Math.min(2000 * Math.pow(2, i), 60000);
            await sleep(wait);
        }
    }
}

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const v6 = new ethers.Contract(V6, ABI, owner);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);

    console.log(`=== TRACK B: ${TOTAL} LOAN CHURN ON V6 (with ${INTER_TX_DELAY}ms inter-tx delay) ===`);

    // Setup
    const allowance = await withRetry(() => usdc.allowance(owner.address, V6));
    if (allowance < ethers.parseUnits('1000', 6)) {
        const tx = await withRetry(() => usdc.approve(V6, ethers.parseUnits('1000', 6)));
        await withRetry(() => tx.wait());
    }
    const pool0 = await withRetry(() => v6.getAgentPool(SELF_AGENT));
    if (pool0[2] < POOL_SEED) {
        const need = POOL_SEED - pool0[2];
        console.log(`Seeding pool with ${fmt(need)} USDC`);
        const tx = await withRetry(() => v6.supplyLiquidity(SELF_AGENT, need));
        await withRetry(() => tx.wait());
    }

    const gasReadings = [];
    const startMs = Date.now();
    let loanCount = 0;
    const iface = new ethers.Interface(ABI);

    while (loanCount < TOTAL) {
        const remaining = TOTAL - loanCount;
        const batchSize = Math.min(BATCH, remaining);
        const lids = [];
        for (let i = 0; i < batchSize; i++) {
            const idx = loanCount + i + 1;
            const tx = await withRetry(() => v6.requestLoan(LOAN_AMT, 7));
            const r = await withRetry(() => tx.wait());
            gasReadings.push({ idx, gas: Number(r.gasUsed) });
            for (const lg of r.logs) {
                try { const p = iface.parseLog(lg); if (p && p.name === 'LoanRequested') { lids.push(p.args.loanId); break; } } catch {}
            }
            await sleep(INTER_TX_DELAY);
        }
        for (const lid of lids) {
            await withRetry(() => v6.repayLoan(lid).then(t => t.wait()));
            await sleep(INTER_TX_DELAY);
        }
        loanCount += batchSize;
        const elapsed = (Date.now() - startMs) / 1000;
        if (loanCount % 20 === 0 || loanCount === TOTAL) {
            const recentGas = gasReadings.slice(-batchSize).map(g => g.gas);
            const minG = Math.min(...recentGas), maxG = Math.max(...recentGas);
            console.log(`  ${loanCount}/${TOTAL} loans (${(loanCount/elapsed).toFixed(2)}/s)  last-batch gas ${minG}..${maxG}`);
        }
    }
    const elapsed = (Date.now() - startMs) / 1000;
    console.log(`\nCompleted ${TOTAL} loans in ${elapsed.toFixed(0)}s (${(TOTAL/elapsed).toFixed(2)}/s)`);

    // Analysis
    const first20 = gasReadings.slice(0, 20).map(g => g.gas);
    const last20 = gasReadings.slice(-20).map(g => g.gas);
    const avgFirst = first20.reduce((a, b) => a + b, 0) / first20.length;
    const avgLast = last20.reduce((a, b) => a + b, 0) / last20.length;
    const ratio = avgLast / avgFirst;
    console.log(`\nGas analysis:`);
    console.log(`  first 20 loans avg: ${avgFirst.toFixed(0)}`);
    console.log(`  last 20 loans avg:  ${avgLast.toFixed(0)}`);
    console.log(`  ratio: ${ratio.toFixed(3)}  ${ratio < 1.2 ? '✅ §S5 fix confirmed' : '⚠ growth'}`);

    // Cleanup
    const myPos = await withRetry(() => v6.positions(SELF_AGENT, owner.address));
    if (myPos[0] > 0n) {
        const tx = await withRetry(() => v6.withdrawLiquidity(SELF_AGENT, myPos[0]));
        await withRetry(() => tx.wait());
    }

    fs.writeFileSync(path.join(OUT, '45-load-b-200-loans.json'), JSON.stringify({
        total_loans: TOTAL,
        elapsed_seconds: elapsed,
        throughput_loans_per_sec: TOTAL / elapsed,
        first_20_avg_gas: Math.round(avgFirst),
        last_20_avg_gas: Math.round(avgLast),
        gas_ratio: ratio,
        verdict: ratio < 1.2 ? '§S5 fix confirmed at 200-loan scale' : 'growth detected',
        gas_readings: gasReadings,
    }, null, 2));
    console.log('Saved.');
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
