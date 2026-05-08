// Test B — 100+ loan churn on V6 live.
// Single agent (#49) takes + repays loans in batches of 10 (the cap).
// Tracks gas across 100 loans to confirm §S5 fix at scale.

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
const TOTAL_LOANS = 100;
const BATCH_SIZE = 10; // = MAX_ACTIVE_LOANS_PER_AGENT
const LOAN_AMT = ethers.parseUnits('1', 6);
const POOL_SEED = ethers.parseUnits('500', 6); // pool liquidity to source loans

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, label, attempts = 8) {
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

const log = (...a) => console.log(...a);

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const v6 = new ethers.Contract(V6, ABI, owner);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);

    log('Owner:', owner.address);
    log('V6:', V6);
    log(`Plan: ${TOTAL_LOANS} loans (batches of ${BATCH_SIZE} active, repay before next batch)`);

    // Pre-flight
    const ethBal = await provider.getBalance(owner.address);
    log(`Owner ETH: ${ethers.formatEther(ethBal)}`);
    const usdcBal = await usdc.balanceOf(owner.address);
    log(`Owner USDC: ${fmt(usdcBal)}`);

    // Pool seed if needed
    const pool = await withRetry(() => v6.getAgentPool(SELF_AGENT), 'pool');
    log(`Pool 49 avail before: ${fmt(pool[2])}`);
    const allowance = await withRetry(() => usdc.allowance(owner.address, V6), 'allow');
    if (allowance < ethers.parseUnits('1000', 6)) {
        const tx = await withRetry(() => usdc.approve(V6, ethers.parseUnits('1000', 6)), 'approve');
        await withRetry(() => tx.wait(), 'approve.wait');
        log('Approved 1000 USDC');
    }
    if (pool[2] < ethers.parseUnits('200', 6)) {
        const need = POOL_SEED - pool[2];
        log(`Seeding pool with ${fmt(need)} USDC`);
        const tx = await withRetry(() => v6.supplyLiquidity(SELF_AGENT, need), 'seed');
        await withRetry(() => tx.wait(), 'seed.wait');
    }

    // Take + repay 100 loans, in batches of BATCH_SIZE
    const gasReadings = [];
    let loanCount = 0;
    log(`\n=== ${TOTAL_LOANS} loan churn ===`);
    while (loanCount < TOTAL_LOANS) {
        const remaining = TOTAL_LOANS - loanCount;
        const batchSize = Math.min(BATCH_SIZE, remaining);
        const batchLoanIds = [];
        const batchStart = loanCount + 1;

        // Take batch of loans
        for (let i = 0; i < batchSize; i++) {
            const idx = loanCount + i + 1;
            const estGas = await withRetry(() =>
                v6.requestLoan.estimateGas(LOAN_AMT, 7), `est${idx}`);
            const tx = await withRetry(() => v6.requestLoan(LOAN_AMT, 7), `req${idx}`);
            const r = await withRetry(() => tx.wait(), 'req.wait');
            gasReadings.push({ loanIdx: idx, estimateGas: estGas.toString(), actualGas: r.gasUsed.toString() });
            // Find loanId
            const iface = new ethers.Interface(ABI);
            for (const lg of r.logs) {
                try { const p = iface.parseLog(lg); if (p && p.name === 'LoanRequested') { batchLoanIds.push(p.args.loanId); break; } } catch {}
            }
        }
        log(`  loans ${batchStart}-${batchStart + batchSize - 1}: gas range ${gasReadings[gasReadings.length - batchSize].actualGas} → ${gasReadings[gasReadings.length - 1].actualGas}`);

        // Repay batch
        for (const lid of batchLoanIds) {
            const tx = await withRetry(() => v6.repayLoan(lid), `repay${lid}`);
            await withRetry(() => tx.wait(), 'repay.wait');
        }
        loanCount += batchSize;
        log(`  batch repaid. Total loans: ${loanCount}`);
    }

    // Analysis
    const first10 = gasReadings.slice(0, 10).map(g => Number(g.actualGas));
    const last10 = gasReadings.slice(-10).map(g => Number(g.actualGas));
    const avgFirst = first10.reduce((a, b) => a + b, 0) / first10.length;
    const avgLast = last10.reduce((a, b) => a + b, 0) / last10.length;
    const ratio = avgLast / avgFirst;
    log(`\n=== GAS ANALYSIS ===`);
    log(`Average gas first 10 loans: ${avgFirst.toFixed(0)}`);
    log(`Average gas last 10 loans: ${avgLast.toFixed(0)}`);
    log(`Ratio: ${ratio.toFixed(3)} (target: < 1.2 for §S5 fix to be confirmed at scale)`);
    if (ratio < 1.2) log(`✅ §S5 FIX CONFIRMED AT SCALE: gas does NOT scale with lifetime loan count`);
    else log(`⚠ Some gas growth detected — investigate`);

    // Cleanup: withdraw if any extra was supplied
    log('\n=== CLEANUP ===');
    const finalPool = await withRetry(() => v6.getAgentPool(SELF_AGENT), 'finalPool');
    const myPos = await withRetry(() => v6.positions(SELF_AGENT, owner.address), 'myPos');
    if (myPos[0] > 0n) {
        const t = await withRetry(() => v6.withdrawLiquidity(SELF_AGENT, myPos[0]), 'cleanup.wd');
        await withRetry(() => t.wait(), 'wd.wait');
        log(`Withdrew ${fmt(myPos[0])} USDC`);
    }

    fs.writeFileSync(path.join(OUT, '29-test-b-loan-churn.json'), JSON.stringify({
        total_loans: TOTAL_LOANS,
        batch_size: BATCH_SIZE,
        gas_readings: gasReadings,
        avg_first_10: Math.round(avgFirst),
        avg_last_10: Math.round(avgLast),
        ratio,
        verdict: ratio < 1.2 ? '§S5 fix confirmed at scale' : 'gas growth detected',
    }, null, 2));
    log('\nSaved.');
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
