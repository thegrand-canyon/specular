// V6 live E2E on Arc Testnet — full lifecycle + §B1/§S1 fix verification.
// Compares resulting state against the v4 baseline (recorded in 09-arc-e2e-full.json).

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6_ADDR = ADDR.agentLiquidityMarketplace_v6;
const V6_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const USDC_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'];

const OUT = './forensics/output/regression-2026-05-07';
const fmt = v => Number(ethers.formatUnits(v, 6));

const SELF_AGENT = 49n;
const SUPPLY = ethers.parseUnits('5', 6);
const LOAN = ethers.parseUnits('3', 6);
const DURATION_DAYS = 7;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, label, attempts = 6) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const msg = (e.shortMessage || e.message || '');
            const isRate = msg.includes('rate') || msg.includes('408') || msg.includes('410') || msg.includes('429') || msg.includes('-32016') || msg.includes('timeout');
            if (i === attempts - 1 || !isRate) throw e;
            await sleep(2000 * Math.pow(2, i));
        }
    }
}

const events = [];
const log = (...a) => { console.log(...a); events.push(a.map(String).join(' ')); };

async function snapshot(v6, usdc, wallet, label) {
    const usdcBal = await withRetry(() => usdc.balanceOf(wallet), 'bal');
    const pool = await withRetry(() => v6.getAgentPool(SELF_AGENT), 'pool');
    const myPos = await withRetry(() => v6.positions(SELF_AGENT, wallet), 'pos');
    const mpBal = await withRetry(() => usdc.balanceOf(V6_ADDR), 'mpBal');
    const lenderCount = Number(pool[6]);
    const poolLenders = [];
    for (let j = 0; j < lenderCount; j++) {
        poolLenders.push((await withRetry(() => v6.poolLenders(SELF_AGENT, j), `pl${j}`)).toLowerCase());
    }
    const isInList = await withRetry(() => v6.isInPoolLenders(SELF_AGENT, wallet), 'isInList');
    const activeLoanCount = Number(await withRetry(() => v6.activeLoanCount(wallet), 'activeLoanCount'));
    return {
        label, ts: new Date().toISOString(),
        wallet_usdc: fmt(usdcBal), mp_usdc: fmt(mpBal),
        pool_49: { totalLiq: fmt(pool[1]), avail: fmt(pool[2]), totalLoaned: fmt(pool[3]),
                   totalEarned: fmt(pool[4]), lenderCount },
        poolLenders, isInList, activeLoanCount,
        my_position: { supplied: fmt(myPos[0]), earnedInterest: fmt(myPos[1]) },
    };
}

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    log('Wallet:', wallet.address);
    log('V6 marketplace:', V6_ADDR);

    const v6 = new ethers.Contract(V6_ADDR, V6_ABI, wallet);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, wallet);

    // ---- 0. Verify V6 setup ----
    log('\n[0] V6 status check');
    const owner = await withRetry(() => v6.owner(), 'owner');
    log('  owner:', owner);
    log('  paused:', await withRetry(() => v6.paused(), 'paused'));
    log('  migrationFinalized:', await withRetry(() => v6.migrationFinalized(), 'finalized'));
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) throw new Error('Wallet not owner');

    const pre = await snapshot(v6, usdc, wallet.address, 'pre');
    log('PRE:', JSON.stringify(pre, null, 2));

    // ---- 1. createAgentPool (V6 has separate state from v4) ----
    if (pre.pool_49.totalLiq === 0 && pre.pool_49.lenderCount === 0) {
        // Need to check if pool is active first; v4 had a pool created, V6 doesn't yet
        const poolRaw = await withRetry(() => v6.agentPools(SELF_AGENT), 'agentPools');
        log('  V6 pool 49 isActive:', poolRaw.isActive);
        if (!poolRaw.isActive) {
            log('\n[1] createAgentPool on V6');
            const tx = await withRetry(() => v6.createAgentPool(), 'createPool');
            log('  tx:', tx.hash);
            const r = await withRetry(() => tx.wait(), 'createPool.wait');
            log('  mined block', r.blockNumber, 'gas', r.gasUsed.toString());
        }
    }

    // ---- 2. Approve + supply ----
    const allowance = await withRetry(() => usdc.allowance(wallet.address, V6_ADDR), 'allowance');
    if (allowance < ethers.parseUnits('15', 6)) {
        log('\n[2a] approve 15 USDC to V6');
        const tx = await withRetry(() => usdc.approve(V6_ADDR, ethers.parseUnits('15', 6)), 'approve');
        log('  tx:', tx.hash);
        await withRetry(() => tx.wait(), 'approve.wait');
    }

    log('\n[2b] supplyLiquidity 5 USDC to own pool 49');
    const sTx = await withRetry(() => v6.supplyLiquidity(SELF_AGENT, SUPPLY), 'supply');
    log('  tx:', sTx.hash);
    const sR = await withRetry(() => sTx.wait(), 'supply.wait');
    log('  mined block', sR.blockNumber, 'gas', sR.gasUsed.toString());
    const afterSupply = await snapshot(v6, usdc, wallet.address, 'after_supply');
    log('  poolLenders:', afterSupply.poolLenders);
    log('  isInPoolLenders:', afterSupply.isInList);

    // ---- 3. requestLoan ----
    log('\n[3] requestLoan(3 USDC, 7 days)');
    let loanId;
    const lTx = await withRetry(() => v6.requestLoan(LOAN, DURATION_DAYS), 'loan');
    log('  tx:', lTx.hash);
    const lR = await withRetry(() => lTx.wait(), 'loan.wait');
    log('  mined block', lR.blockNumber, 'gas', lR.gasUsed.toString());
    const iface = new ethers.Interface(V6_ABI);
    for (const event of lR.logs) {
        try {
            const parsed = iface.parseLog(event);
            if (parsed && parsed.name === 'LoanRequested') { loanId = parsed.args.loanId; break; }
        } catch {}
    }
    log('  loanId:', loanId?.toString());
    const afterLoan = await snapshot(v6, usdc, wallet.address, 'after_loan');
    log('  activeLoanCount:', afterLoan.activeLoanCount);

    // ---- 4. repayLoan ----
    log('\n[4] repayLoan(' + loanId + ')');
    const rTx = await withRetry(() => v6.repayLoan(loanId), 'repay');
    log('  tx:', rTx.hash);
    const rR = await withRetry(() => rTx.wait(), 'repay.wait');
    log('  mined block', rR.blockNumber, 'gas', rR.gasUsed.toString());
    const afterRepay = await snapshot(v6, usdc, wallet.address, 'after_repay');
    log('  earnedInterest:', afterRepay.my_position.earnedInterest, 'USDC');
    log('  pool totalEarned:', afterRepay.pool_49.totalEarned);
    log('  activeLoanCount:', afterRepay.activeLoanCount, '(should be 0)');

    // ---- 5. claimInterest (§S1 test — must decrement availableLiquidity on V6!) ----
    log('\n[5] claimInterest(49) — §S1 test');
    if (afterRepay.my_position.earnedInterest > 0) {
        const availBefore = afterRepay.pool_49.avail;
        const ciTx = await withRetry(() => v6.claimInterest(SELF_AGENT), 'claim');
        log('  tx:', ciTx.hash);
        await withRetry(() => ciTx.wait(), 'claim.wait');
        const afterClaim = await snapshot(v6, usdc, wallet.address, 'after_claim');
        log('  pool avail:', availBefore, '→', afterClaim.pool_49.avail,
            'Δ', (afterClaim.pool_49.avail - availBefore).toFixed(6));
        const expectedDelta = -afterRepay.my_position.earnedInterest;
        const actualDelta = afterClaim.pool_49.avail - availBefore;
        if (Math.abs(actualDelta - expectedDelta) < 1e-9) {
            log('  ✅ §S1 FIX VERIFIED: availableLiquidity correctly decremented by claimed amount');
        } else {
            log('  ❌ §S1 fix DID NOT work: expected Δ', expectedDelta, 'got', actualDelta);
        }
    }

    // ---- 6. Withdraw ----
    log('\n[6] withdrawLiquidity (full)');
    const myPos = await withRetry(() => v6.positions(SELF_AGENT, wallet.address), 'pos');
    if (myPos[0] > 0n) {
        const wTx = await withRetry(() => v6.withdrawLiquidity(SELF_AGENT, myPos[0]), 'withdraw');
        log('  tx:', wTx.hash);
        await withRetry(() => wTx.wait(), 'withdraw.wait');
    }
    const afterWithdraw = await snapshot(v6, usdc, wallet.address, 'after_withdraw');

    // ---- 7. CRITICAL §B1 TEST: re-supply after full withdraw — should NOT create duplicate ----
    log('\n[7] §B1 TEST: supply 1 USDC AGAIN after full withdraw');
    log('  pre-supply lenderCount:', afterWithdraw.pool_49.lenderCount);
    log('  pre-supply isInPoolLenders:', afterWithdraw.isInList);
    const reSupTx = await withRetry(() => v6.supplyLiquidity(SELF_AGENT, ethers.parseUnits('1', 6)), 're-supply');
    log('  tx:', reSupTx.hash);
    await withRetry(() => reSupTx.wait(), 're-supply.wait');
    const afterReSupply = await snapshot(v6, usdc, wallet.address, 'after_re_supply');
    log('  post-supply lenderCount:', afterReSupply.pool_49.lenderCount);
    log('  post-supply poolLenders:', afterReSupply.poolLenders);
    if (afterReSupply.pool_49.lenderCount === afterWithdraw.pool_49.lenderCount) {
        log('  ✅ §B1 FIX VERIFIED: re-supply did NOT create a duplicate poolLenders entry');
    } else {
        log('  ❌ §B1 fix DID NOT work: lenderCount went', afterWithdraw.pool_49.lenderCount, '→', afterReSupply.pool_49.lenderCount);
    }

    // ---- 8. Final cleanup withdraw ----
    log('\n[8] final cleanup withdraw');
    const finalPos = await withRetry(() => v6.positions(SELF_AGENT, wallet.address), 'finalPos');
    if (finalPos[0] > 0n) {
        const wTx = await withRetry(() => v6.withdrawLiquidity(SELF_AGENT, finalPos[0]), 'cleanup');
        log('  tx:', wTx.hash);
        await withRetry(() => wTx.wait(), 'cleanup.wait');
    }
    const post = await snapshot(v6, usdc, wallet.address, 'post');

    log('\n--- POST ---'); log(JSON.stringify(post, null, 2));

    // ---- Comparison summary ----
    log('\n=== COMPARISON: V6 vs v4 (recall: v4 left ghost lender + 0.008544 USDC phantom on pool 49) ===');
    log(`V6 final pool.availableLiquidity: ${post.pool_49.avail} USDC`);
    log(`V6 final lenderCount:             ${post.pool_49.lenderCount}`);
    log(`V6 final isInPoolLenders:         ${post.isInList}`);
    log(`v4 (from 09-arc-e2e-full.json):   avail=0.008544, lenderCount=1 (ghost), totalEarned=0.008544 (phantom)`);
    log(`Net wallet change:                ${(post.wallet_usdc - pre.wallet_usdc).toFixed(6)} USDC`);

    fs.writeFileSync(path.join(OUT, '17-v6-live-e2e.json'),
        JSON.stringify({ pre, afterSupply, afterLoan, afterRepay, afterWithdraw, afterReSupply, post, events }, null, 2));
    log('\nSaved.');
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
