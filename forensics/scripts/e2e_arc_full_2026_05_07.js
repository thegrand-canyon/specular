// Arc E2E full lifecycle — supply→borrow→repay→withdraw on agent 49's own pool.
// Each agent borrows from their OWN pool (per AgentLiquidityMarketplace.sol:200).
// Includes §B1 setup demonstration: withdraw+resupply creates duplicate poolLenders.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const MP_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;
const USDC_ABI = [
    'function approve(address,uint256) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
];

const OUT_DIR = './forensics/output/regression-2026-05-07';
const fmt = (v) => Number(ethers.formatUnits(v, 6));
const SELF_AGENT = 49n;
const SUPPLY_AMOUNT = ethers.parseUnits('5', 6);
const LOAN_AMOUNT = ethers.parseUnits('3', 6);
const LOAN_DURATION_DAYS = 7;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, label, attempts = 5) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const msg = e.shortMessage || e.message;
            if (i === attempts - 1) throw e;
            const isRetryable = msg.includes('408') || msg.includes('410') || msg.includes('timeout') || msg.includes('rate');
            if (!isRetryable) throw e;
            const wait = 2000 * Math.pow(2, i);
            console.log(`  ⚠ ${label}: ${msg.slice(0, 80)} retry ${i+2}/${attempts} in ${wait}ms`);
            await sleep(wait);
        }
    }
}

const events = [];
const log = (...a) => { console.log(...a); events.push(a.map(String).join(' ')); };

async function poolLendersList(mp, agentId) {
    const pool = await mp.getAgentPool(agentId);
    const count = Number(pool[6]);
    const list = [];
    for (let j = 0; j < count; j++) {
        list.push((await mp.poolLenders(agentId, j)).toLowerCase());
    }
    return list;
}

async function snapshot(mp, usdc, wallet, label) {
    return await withRetry(async () => {
        const usdcBal = await usdc.balanceOf(wallet);
        const ownPool = await mp.getAgentPool(SELF_AGENT);
        const myPos = await mp.positions(SELF_AGENT, wallet);
        const mpBal = await usdc.balanceOf(ADDR.agentLiquidityMarketplace);
        const lendersList = await poolLendersList(mp, SELF_AGENT);
        return {
            label, ts: new Date().toISOString(),
            wallet_usdc: fmt(usdcBal), mp_usdc: fmt(mpBal),
            own_pool: {
                totalLiq: fmt(ownPool[1]), avail: fmt(ownPool[2]),
                totalLoaned: fmt(ownPool[3]), totalEarned: fmt(ownPool[4]),
                lenderCount: Number(ownPool[6]),
            },
            poolLenders: lendersList,
            my_position: { supplied: fmt(myPos[0]), earnedInterest: fmt(myPos[1]) },
        };
    }, `snapshot-${label}`);
}

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    log('Wallet:', wallet.address, '(agent', SELF_AGENT.toString() + ')');
    const mp = new ethers.Contract(ADDR.agentLiquidityMarketplace, MP_ABI, wallet);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, wallet);

    const pre = await snapshot(mp, usdc, wallet.address, 'pre');
    log('\n--- PRE ---'); log(JSON.stringify(pre, null, 2));

    // ---- 1. Approve USDC ----
    const allowance = await withRetry(() => usdc.allowance(wallet.address, ADDR.agentLiquidityMarketplace), 'allowance');
    if (allowance < ethers.parseUnits('15', 6)) {
        log('\n[1] Approving 15 USDC');
        const tx = await withRetry(() => usdc.approve(ADDR.agentLiquidityMarketplace, ethers.parseUnits('15', 6)), 'approve');
        await withRetry(() => tx.wait(), 'approve.wait');
        log('  approved tx:', tx.hash);
    } else {
        log('\n[1] Allowance sufficient:', fmt(allowance));
    }

    // ---- 2. Supply 5 USDC to OWN pool ----
    log('\n[2] Supply 5 USDC to own pool (agent 49)');
    const supplyTx = await withRetry(() => mp.supplyLiquidity(SELF_AGENT, SUPPLY_AMOUNT), 'supplyLiquidity');
    log('  tx:', supplyTx.hash);
    const supplyR = await withRetry(() => supplyTx.wait(), 'supply.wait');
    log('  mined block', supplyR.blockNumber, 'gas', supplyR.gasUsed.toString());
    const afterSupply = await snapshot(mp, usdc, wallet.address, 'after_supply');
    log('  poolLenders[49]:', afterSupply.poolLenders);

    // ---- 3. Request 3 USDC loan ----
    log('\n[3] Request 3 USDC loan, 7 days');
    let loanId;
    const loanTx = await withRetry(() => mp.requestLoan(LOAN_AMOUNT, LOAN_DURATION_DAYS), 'requestLoan');
    log('  tx:', loanTx.hash);
    const loanR = await withRetry(() => loanTx.wait(), 'loan.wait');
    log('  mined block', loanR.blockNumber, 'gas', loanR.gasUsed.toString());
    const iface = new ethers.Interface(MP_ABI);
    for (const lg of loanR.logs) {
        try {
            const p = iface.parseLog(lg);
            if (p && p.name === 'LoanRequested') { loanId = p.args.loanId; break; }
        } catch {}
    }
    log('  loanId:', loanId?.toString());
    const afterLoan = await snapshot(mp, usdc, wallet.address, 'after_loan');
    log('  wallet USDC:', afterLoan.wallet_usdc, '(loan disbursed)');
    log('  pool avail:', afterLoan.own_pool.avail, '(was', afterSupply.own_pool.avail + ')');

    // ---- 4. Repay loan immediately ----
    log('\n[4] Repay loan ' + loanId.toString());
    const loan = await withRetry(() => mp.loans(loanId), 'loan-read');
    log('  loan amount:', fmt(loan.amount), 'state:', loan.state.toString());
    const repayTx = await withRetry(() => mp.repayLoan(loanId), 'repayLoan');
    log('  tx:', repayTx.hash);
    const repayR = await withRetry(() => repayTx.wait(), 'repay.wait');
    log('  mined block', repayR.blockNumber, 'gas', repayR.gasUsed.toString());
    const afterRepay = await snapshot(mp, usdc, wallet.address, 'after_repay');
    log('  earnedInterest:', afterRepay.my_position.earnedInterest, 'USDC');
    log('  pool totalEarned:', afterRepay.own_pool.totalEarned);

    // ---- 5. claimInterest (§S1 test on own position — no theft) ----
    if (afterRepay.my_position.earnedInterest > 0) {
        log('\n[5] claimInterest on own pool (§S1 test — observe pool.availableLiquidity vs USDC balance)');
        try {
            const ciTx = await withRetry(() => mp.claimInterest(SELF_AGENT), 'claimInterest');
            log('  tx:', ciTx.hash);
            await withRetry(() => ciTx.wait(), 'claim.wait');
        } catch (e) { log('  ⚠ claimInterest:', e.shortMessage || e.message); }
        const afterClaim = await snapshot(mp, usdc, wallet.address, 'after_claim');
        log('  wallet USDC:', afterClaim.wallet_usdc, 'earnedInt:', afterClaim.my_position.earnedInterest);
        log('  pool avail:', afterClaim.own_pool.avail, '(should DECREASE — but per §S1 it does not)');
        log('  Σavail vs MP USDC: ', afterClaim.own_pool.avail, 'vs', afterClaim.mp_usdc);
    } else {
        log('\n[5] No earnedInterest to claim — skipping claimInterest test');
    }

    // ---- 6. Withdraw remaining supply ----
    log('\n[6] Withdraw remaining supply');
    const myPos = await withRetry(() => mp.positions(SELF_AGENT, wallet.address), 'positions');
    if (myPos[0] > 0n) {
        const wtx = await withRetry(() => mp.withdrawLiquidity(SELF_AGENT, myPos[0]), 'withdraw');
        log('  withdrawing', fmt(myPos[0]), 'USDC, tx:', wtx.hash);
        await withRetry(() => wtx.wait(), 'withdraw.wait');
    }
    const post = await snapshot(mp, usdc, wallet.address, 'post');

    log('\n--- POST ---'); log(JSON.stringify(post, null, 2));

    // ---- §B1 demonstration: poolLenders[49] should still contain us as ghost ----
    log('\n--- §B1 GHOST LENDER CHECK ---');
    log(`pre  lenderCount: ${pre.own_pool.lenderCount}, our position: ${pre.my_position.supplied}`);
    log(`post lenderCount: ${post.own_pool.lenderCount}, our position: ${post.my_position.supplied}`);
    log(`poolLenders[49] post: ${JSON.stringify(post.poolLenders)}`);
    const stillGhost = post.poolLenders.includes(wallet.address.toLowerCase()) && post.my_position.supplied === 0;
    log(stillGhost ? '✅ §B1 ghost-lender confirmed: address remains in poolLenders[] after withdraw with supplied=0' :
        'ℹ️ no ghost lender (poolLenders correctly removed)');

    log('\n--- DIFF (pre → post) ---');
    log(`wallet USDC:  ${pre.wallet_usdc} → ${post.wallet_usdc}    Δ ${(post.wallet_usdc - pre.wallet_usdc).toFixed(6)}`);
    log(`MP USDC:      ${pre.mp_usdc} → ${post.mp_usdc}    Δ ${(post.mp_usdc - pre.mp_usdc).toFixed(6)}`);
    log(`pool avail:   ${pre.own_pool.avail} → ${post.own_pool.avail}`);
    log(`pool earned:  ${pre.own_pool.totalEarned} → ${post.own_pool.totalEarned}`);

    fs.writeFileSync(path.join(OUT_DIR, '09-arc-e2e-full.json'),
        JSON.stringify({ pre, afterSupply, afterLoan, afterRepay, post, events }, null, 2));
    log('\nSaved.');
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
