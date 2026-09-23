// Test A — MAX_LENDERS=50 boundary live test on Arc V6.
//
// Pool #49 currently has lenderCount=1 (the secure wallet from earlier testing).
// We add 49 fresh wallets so total = 50 (the cap). Then attempt a 51st supply
// which MUST revert. Then run a loan + repay so interest distributes across
// all 50 lenders. Each lender claims. Cleanup.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const USDC_ABI = [
    'function approve(address,uint256) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function transfer(address,uint256) returns (bool)',
];
const fmt = v => Number(ethers.formatUnits(v, 6));
const OUT = './forensics/output/regression-2026-05-07';

const SELF_AGENT = 49n;
const N_FRESH = 49; // 49 fresh + 1 existing = 50 = cap
const FUND_ETH = ethers.parseEther('0.05');
const FUND_USDC = ethers.parseUnits('110', 6);
const SUPPLY_AMT = ethers.parseUnits('100', 6);
const LOAN_AMT = ethers.parseUnits('500', 6); // borrow from the seeded pool
const DURATION_DAYS = 30;

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

const log = (...a) => { console.log(...a); };

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    log('Owner (agent #49):', owner.address);
    log('V6:', V6);

    const v6 = new ethers.Contract(V6, ABI, owner);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);

    const pre = await withRetry(() => v6.getAgentPool(SELF_AGENT), 'pre');
    log(`PRE pool: lenderCount=${pre[6]}, totalLiq=${fmt(pre[1])}, avail=${fmt(pre[2])}`);
    log(`needed fresh wallets: ${N_FRESH} (to reach cap of 50 with existing 1)`);

    // Pre-flight: owner approves enough for cap-test attempt + collateral
    const allowance = await withRetry(() => new ethers.Contract(ADDR.usdc, ['function allowance(address,address) view returns (uint256)'], provider).allowance(owner.address, V6), 'allow');
    if (allowance < ethers.parseUnits('1500', 6)) {
        const tx = await withRetry(() => usdc.approve(V6, ethers.parseUnits('1500', 6)), 'ownerApprove');
        await withRetry(() => tx.wait(), 'ownerApprove.wait');
        log('owner approved 1500 USDC for V6');
    }

    // ---- 1. Generate + fund 49 fresh wallets ----
    log(`\n[1] Generating + funding ${N_FRESH} fresh wallets`);
    const lenders = [];
    for (let i = 0; i < N_FRESH; i++) {
        const w = ethers.Wallet.createRandom().connect(provider);
        lenders.push(w);
    }
    // Fund in serial (avoid nonce issues — could parallelize with manual nonce mgmt)
    for (let i = 0; i < N_FRESH; i++) {
        const ethTx = await withRetry(() => owner.sendTransaction({ to: lenders[i].address, value: FUND_ETH }), `fundETH${i}`);
        await withRetry(() => ethTx.wait(), 'fundETH.wait');
        const usdcTx = await withRetry(() => usdc.transfer(lenders[i].address, FUND_USDC), `fundUSDC${i}`);
        await withRetry(() => usdcTx.wait(), 'fundUSDC.wait');
        if ((i + 1) % 10 === 0) log(`  funded ${i + 1}/${N_FRESH}`);
    }
    log('  all funded');

    // ---- 2. Each fresh lender approves + supplies ----
    log(`\n[2] Each fresh lender supplies ${fmt(SUPPLY_AMT)} USDC`);
    const supplyResults = [];
    for (let i = 0; i < N_FRESH; i++) {
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, lenders[i]);
        const m = new ethers.Contract(V6, ABI, lenders[i]);
        try {
            const aTx = await withRetry(() => u.approve(V6, SUPPLY_AMT), `app${i}`);
            await withRetry(() => aTx.wait(), 'app.wait');
            const sTx = await withRetry(() => m.supplyLiquidity(SELF_AGENT, SUPPLY_AMT), `sup${i}`);
            const r = await withRetry(() => sTx.wait(), 'sup.wait');
            supplyResults.push({ i, addr: lenders[i].address, gas: r.gasUsed.toString(), tx: sTx.hash });
            if ((i + 1) % 10 === 0) log(`  supplied ${i + 1}/${N_FRESH}, last gas=${r.gasUsed}`);
        } catch (e) {
            log(`  ❌ lender ${i} supply failed: ${(e.shortMessage || e.message).slice(0, 80)}`);
            supplyResults.push({ i, addr: lenders[i].address, error: e.shortMessage || e.message });
            break;
        }
    }
    const successCount = supplyResults.filter(r => !r.error).length;
    log(`  successful supplies: ${successCount}/${N_FRESH}`);

    const afterSupply = await withRetry(() => v6.getAgentPool(SELF_AGENT), 'afterSupply');
    log(`  pool lenderCount: ${afterSupply[6]}`);

    // ---- 3. Try 51st supply — MUST revert ----
    log(`\n[3] 51st supply attempt — must revert with "Pool lender capacity reached"`);
    const cap51 = ethers.Wallet.createRandom().connect(provider);
    let cap51Funded = false;
    try {
        const ethTx = await withRetry(() => owner.sendTransaction({ to: cap51.address, value: FUND_ETH }), 'cap51eth');
        await withRetry(() => ethTx.wait(), 'cap51eth.wait');
        const usdcTx = await withRetry(() => usdc.transfer(cap51.address, FUND_USDC), 'cap51usdc');
        await withRetry(() => usdcTx.wait(), 'cap51usdc.wait');
        cap51Funded = true;
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, cap51);
        const m = new ethers.Contract(V6, ABI, cap51);
        await withRetry(() => u.approve(V6, SUPPLY_AMT).then(t => t.wait()), 'cap51approve');
        try {
            await withRetry(() => m.supplyLiquidity(SELF_AGENT, SUPPLY_AMT), 'cap51supply');
            log('  ❌ BUG: 51st supply succeeded (cap not enforced)');
        } catch (e) {
            const msg = (e.shortMessage || e.message);
            if (msg.includes('Pool lender capacity reached')) log(`  ✅ correctly reverted: "${msg.slice(0, 80)}"`);
            else log(`  ⚠ reverted (different reason): ${msg.slice(0, 100)}`);
        }
    } catch (e) {
        log(`  setup failed: ${(e.shortMessage || e.message).slice(0, 80)}`);
    }

    // ---- 4. Owner takes loan, repays — interest distributes across 50 lenders ----
    log(`\n[4] Owner borrows ${fmt(LOAN_AMT)} USDC, repays — interest distributes across all lenders`);
    let loanId;
    try {
        const lTx = await withRetry(() => v6.requestLoan(LOAN_AMT, DURATION_DAYS), 'loan');
        const lR = await withRetry(() => lTx.wait(), 'loan.wait');
        log(`  loan tx: ${lTx.hash}, gas: ${lR.gasUsed.toString()}`);
        const iface = new ethers.Interface(ABI);
        for (const lg of lR.logs) {
            try { const p = iface.parseLog(lg); if (p && p.name === 'LoanRequested') { loanId = p.args.loanId; break; } } catch {}
        }
        log(`  loanId: ${loanId.toString()}`);

        const rTx = await withRetry(() => v6.repayLoan(loanId), 'repay');
        const rR = await withRetry(() => rTx.wait(), 'repay.wait');
        log(`  repay tx: ${rTx.hash}, gas: ${rR.gasUsed.toString()}`);
        log(`  ✅ NO PANIC across 50 distinct lenders`);
    } catch (e) {
        log(`  ❌ loan/repay error: ${(e.shortMessage || e.message).slice(0, 100)}`);
    }

    // ---- 5. Each lender claims ----
    log(`\n[5] Each lender claims interest`);
    let totalClaimed = 0n;
    for (let i = 0; i < successCount; i++) {
        const m = new ethers.Contract(V6, ABI, lenders[i]);
        try {
            const pos = await withRetry(() => v6.positions(SELF_AGENT, lenders[i].address), `pos${i}`);
            if (pos[1] > 0n) {
                const tx = await withRetry(() => m.claimInterest(SELF_AGENT), `claim${i}`);
                await withRetry(() => tx.wait(), 'claim.wait');
                totalClaimed += pos[1];
            }
            if ((i + 1) % 10 === 0) log(`  claimed ${i + 1}/${successCount}`);
        } catch (e) { log(`  lender ${i} claim err: ${(e.shortMessage || e.message).slice(0, 60)}`); }
    }
    log(`  total claimed: ${fmt(totalClaimed)} USDC`);

    // ---- §S1 invariant check ----
    const finalPool = await withRetry(() => v6.getAgentPool(SELF_AGENT), 'final');
    const finalMpBal = await withRetry(() => usdc.balanceOf(V6), 'finalMpBal');
    log(`\n§S1 invariant: avail=${fmt(finalPool[2]).toFixed(6)} ≤ mpBal=${fmt(finalMpBal).toFixed(6)}? ${finalPool[2] <= finalMpBal ? '✅' : '❌'}`);

    // ---- 6. Cleanup: each lender withdraws + returns USDC ----
    log(`\n[6] Cleanup`);
    for (let i = 0; i < successCount; i++) {
        const m = new ethers.Contract(V6, ABI, lenders[i]);
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, lenders[i]);
        try {
            const pos = await withRetry(() => v6.positions(SELF_AGENT, lenders[i].address), `cpos${i}`);
            if (pos[0] > 0n) {
                const t = await withRetry(() => m.withdrawLiquidity(SELF_AGENT, pos[0]), `cwd${i}`);
                await withRetry(() => t.wait(), 'cwd.wait');
            }
            const bal = await withRetry(() => u.balanceOf(lenders[i].address), `cbal${i}`);
            if (bal > 0n) {
                const t = await withRetry(() => u.transfer(owner.address, bal), `cret${i}`);
                await withRetry(() => t.wait(), 'cret.wait');
            }
            if ((i + 1) % 10 === 0) log(`  cleaned ${i + 1}/${successCount}`);
        } catch (e) { log(`  cleanup ${i} err: ${(e.shortMessage || e.message).slice(0, 60)}`); }
    }
    // Cap51 cleanup if funded
    if (cap51Funded) {
        try {
            const u = new ethers.Contract(ADDR.usdc, USDC_ABI, cap51);
            const bal = await withRetry(() => u.balanceOf(cap51.address), 'cap51bal');
            if (bal > 0n) {
                const t = await withRetry(() => u.transfer(owner.address, bal), 'cap51ret');
                await withRetry(() => t.wait(), 'cap51ret.wait');
            }
        } catch {}
    }

    const post = await withRetry(() => v6.getAgentPool(SELF_AGENT), 'post');
    log(`\nPOST pool: lenderCount=${post[6]}, totalLiq=${fmt(post[1])}, avail=${fmt(post[2])}`);

    fs.writeFileSync(path.join(OUT, '28-test-a-max-lenders.json'), JSON.stringify({
        n_fresh: N_FRESH, supplyResults, finalLenderCount: Number(post[6]),
        s1_invariant: finalPool[2] <= finalMpBal,
    }, null, 2));
    log('\nSaved.');
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
