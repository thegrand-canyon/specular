// V6 boundary tests on Arc Testnet:
//   1. MAX_ACTIVE_LOANS_PER_AGENT = 10 — verify 11th reverts, then unblocks after a repay.
//   2. Gas measurement at growing lifetime loan count (proves §S5 fix).

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
const LOAN = ethers.parseUnits('0.1', 6);
const POOL_SEED = ethers.parseUnits('1.2', 6);
const DUR = 7;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, label, attempts = 6) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const msg = e.shortMessage || e.message || '';
            const isRate = msg.includes('rate') || msg.includes('408') || msg.includes('410') || msg.includes('429') || msg.includes('-32016') || msg.includes('timeout');
            if (i === attempts - 1 || !isRate) throw e;
            await sleep(2000 * Math.pow(2, i));
        }
    }
}

(async () => {
    const p = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, p);
    const v6 = new ethers.Contract(V6, ABI, wallet);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, wallet);

    console.log('Wallet:', wallet.address);
    console.log('V6:', V6);

    // ---- Setup: ensure pool has enough liquidity + collateral approval ----
    const allowance = await withRetry(() => usdc.allowance(wallet.address, V6), 'allow');
    if (allowance < ethers.parseUnits('5', 6)) {
        const tx = await withRetry(() => usdc.approve(V6, ethers.parseUnits('5', 6)), 'approve');
        await withRetry(() => tx.wait(), 'approve.wait');
        console.log('approved 5 USDC');
    }
    const pool = await withRetry(() => v6.getAgentPool(SELF_AGENT), 'pool');
    console.log('pool avail before:', fmt(pool[2]));
    if (pool[2] < POOL_SEED) {
        console.log('supplying', fmt(POOL_SEED), 'USDC to seed pool');
        const tx = await withRetry(() => v6.supplyLiquidity(SELF_AGENT, POOL_SEED), 'supply');
        await withRetry(() => tx.wait(), 'supply.wait');
    }

    // ---- Phase A: take 10 loans, measuring gas ----
    console.log('\n=== Phase A: 10 sequential loans, gas measurement ===');
    const loanIds = [];
    const gasUsed = [];
    for (let i = 0; i < 10; i++) {
        const ac = Number(await withRetry(() => v6.activeLoanCount(wallet.address), `ac.${i}`));
        const estGas = await withRetry(() =>
            v6.requestLoan.estimateGas(LOAN, DUR), `est.${i}`);
        console.log(`  loan ${i+1}/10  activeBefore=${ac}  estGas=${estGas}`);
        const tx = await withRetry(() => v6.requestLoan(LOAN, DUR), `req.${i}`);
        const r = await withRetry(() => tx.wait(), `wait.${i}`);
        gasUsed.push({ loanIdx: i + 1, activeBefore: ac, estimateGas: estGas.toString(), actualGas: r.gasUsed.toString() });
        // Get loan id
        const iface = new ethers.Interface(ABI);
        for (const lg of r.logs) {
            try {
                const parsed = iface.parseLog(lg);
                if (parsed && parsed.name === 'LoanRequested') { loanIds.push(parsed.args.loanId); break; }
            } catch {}
        }
    }

    // ---- Phase B: 11th loan should REVERT ----
    console.log('\n=== Phase B: 11th loan attempt — should revert ===');
    const ac = Number(await withRetry(() => v6.activeLoanCount(wallet.address), 'ac11'));
    console.log('  activeLoanCount:', ac);
    let cap_ok = false;
    try {
        await withRetry(() => v6.requestLoan.staticCall(LOAN, DUR), 'tryCap');
        console.log('  ❌ BUG: 11th loan would succeed (cap not enforced)');
    } catch (e) {
        const msg = e.shortMessage || e.message;
        cap_ok = msg.toLowerCase().includes('too many') || msg.toLowerCase().includes('active');
        console.log('  ✅ revert:', msg.slice(0, 80));
        if (cap_ok) console.log('  ✅ MAX_ACTIVE_LOANS=10 cap correctly enforced');
    }

    // ---- Phase C: repay one, verify 11th now succeeds via staticCall ----
    console.log('\n=== Phase C: repay 1 loan, then re-test cap ===');
    const repayTx = await withRetry(() => v6.repayLoan(loanIds[0]), 'repay1');
    await withRetry(() => repayTx.wait(), 'repay1.wait');
    const ac2 = Number(await withRetry(() => v6.activeLoanCount(wallet.address), 'ac.afterRepay'));
    console.log('  activeLoanCount after repay:', ac2);
    let unblock_ok = false;
    try {
        await withRetry(() => v6.requestLoan.staticCall(LOAN, DUR), 'try10thAgain');
        unblock_ok = true;
        console.log('  ✅ static-call would succeed — cap correctly recomputed via O(1) counter');
    } catch (e) {
        console.log('  ❌ still reverts:', (e.shortMessage || e.message).slice(0, 80));
    }

    // ---- Phase D: gas non-scaling check ----
    console.log('\n=== Phase D: gas analysis ===');
    const first = Number(gasUsed[0].actualGas);
    const last = Number(gasUsed[gasUsed.length - 1].actualGas);
    const ratio = last / first;
    console.log(`  loan 1 gas: ${first}`);
    console.log(`  loan 10 gas: ${last}`);
    console.log(`  ratio: ${ratio.toFixed(3)}× ${ratio < 1.5 ? '✅ acceptable (no O(N) growth)' : '⚠ growth detected'}`);

    // ---- Phase E: cleanup — repay remaining 9 loans ----
    console.log('\n=== Phase E: cleanup — repay remaining loans ===');
    for (let i = 1; i < 10; i++) {
        const id = loanIds[i];
        try {
            const t = await withRetry(() => v6.repayLoan(id), `cleanup.${i}`);
            await withRetry(() => t.wait(), `cleanup.${i}.wait`);
        } catch (e) {
            console.log(`  loan ${id}: ${(e.shortMessage || e.message).slice(0, 60)}`);
        }
    }
    console.log('  cleanup done. activeLoanCount:', Number(await withRetry(() => v6.activeLoanCount(wallet.address), 'ac.final')));

    // Withdraw seeded USDC
    const myPos = await withRetry(() => v6.positions(SELF_AGENT, wallet.address), 'finalPos');
    if (myPos[0] > 0n) {
        const tx = await withRetry(() => v6.withdrawLiquidity(SELF_AGENT, myPos[0]), 'final.wd');
        await withRetry(() => tx.wait(), 'final.wd.wait');
        console.log('withdrew', fmt(myPos[0]), 'USDC');
    }

    // Save results
    fs.writeFileSync(path.join(OUT, '18-v6-boundary.json'), JSON.stringify({
        gasUsed,
        cap_enforced: cap_ok,
        cap_unblock_after_repay: unblock_ok,
        gas_ratio: ratio,
        loanIds: loanIds.map(String),
    }, null, 2));
    console.log('\nSaved.');
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
