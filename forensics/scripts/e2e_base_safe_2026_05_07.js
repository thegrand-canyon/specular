// Base E2E — safe supply/withdraw round trip on agent #1's pool.
// Avoids triggering §B1 panic by NOT involving loans.
// Captures: gas costs, lenderCount invariance when position>0, ghost-lender baseline.
//
// Also runs static-call repayLoan(2/3/4) to capture the live Panic(0x11) evidence.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC = process.env.BASE_RPC_URL || 'https://base.publicnode.com';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, label, attempts = 5) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const msg = (e.shortMessage || e.message || '') + ' ' + JSON.stringify(e.info || {});
            const isRate = msg.includes('rate') || msg.includes('408') || msg.includes('429') || msg.includes('-32016');
            if (i === attempts - 1 || !isRate) throw e;
            const wait = 2000 * Math.pow(2, i);
            console.log(`  ⚠ ${label}: rate-limited, retry ${i+2}/${attempts} in ${wait}ms`);
            await sleep(wait);
        }
    }
}
const ADDR = JSON.parse(fs.readFileSync('./src/config/base-addresses.json'));
const MP_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;
const USDC_ABI = [
    'function approve(address,uint256) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
];

const OUT_DIR = './forensics/output/regression-2026-05-07';
const fmt = (v) => Number(ethers.formatUnits(v, 6));
const SELF_AGENT = 1n;
const SUPPLY_AMOUNT = ethers.parseUnits('0.1', 6); // small amount

const events = [];
const log = (...a) => { console.log(...a); events.push(a.map(String).join(' ')); };

async function poolLendersList(mp, agentId) {
    const pool = await withRetry(() => mp.getAgentPool(agentId), 'pl.getAgentPool');
    const list = [];
    for (let j = 0; j < Number(pool[6]); j++) {
        list.push((await withRetry(() => mp.poolLenders(agentId, j), `poolLenders[${j}]`)).toLowerCase());
    }
    return list;
}

async function snapshot(mp, usdc, wallet, label) {
    const usdcBal = await withRetry(() => usdc.balanceOf(wallet), 'usdc.bal');
    const pool = await withRetry(() => mp.getAgentPool(SELF_AGENT), 'getAgentPool');
    const myPos = await withRetry(() => mp.positions(SELF_AGENT, wallet), 'positions');
    const mpBal = await withRetry(() => usdc.balanceOf(ADDR.agentLiquidityMarketplace), 'mp.bal');
    const lendersList = await poolLendersList(mp, SELF_AGENT);
    return {
        label, ts: new Date().toISOString(),
        wallet_usdc: fmt(usdcBal), mp_usdc: fmt(mpBal),
        own_pool: {
            totalLiq: fmt(pool[1]), avail: fmt(pool[2]),
            totalLoaned: fmt(pool[3]), totalEarned: fmt(pool[4]),
            lenderCount: Number(pool[6]),
        },
        poolLenders: lendersList,
        my_position: { supplied: fmt(myPos[0]), earnedInterest: fmt(myPos[1]) },
    };
}

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    log('Wallet:', wallet.address, '(agent', SELF_AGENT.toString() + ')');
    log('Network: Base Mainnet (chainId', (await provider.getNetwork()).chainId.toString() + ')');
    const ethBal = await provider.getBalance(wallet.address);
    log('Base ETH:', ethers.formatEther(ethBal));

    const mp = new ethers.Contract(ADDR.agentLiquidityMarketplace, MP_ABI, wallet);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, wallet);

    const pre = await snapshot(mp, usdc, wallet.address, 'pre');
    log('\n--- PRE ---'); log(JSON.stringify(pre, null, 2));

    // ---- Static-call repayLoan(2/3/4) for Panic(0x11) evidence ----
    log('\n[A] §B1 LIVE PANIC EVIDENCE (static-call simulations)');
    const panicEvidence = [];
    for (const id of [2, 3, 4]) {
        try {
            await mp.repayLoan.staticCall(id);
            panicEvidence.push({ loanId: id, result: 'would_succeed' });
            log(`  loan ${id}: would succeed (no panic)`);
        } catch (e) {
            const data = e.data || (e.info?.error?.data) || '';
            const isPanicX11 = data.startsWith('0x4e487b71') && data.endsWith('11');
            panicEvidence.push({
                loanId: id, panic: isPanicX11, message: (e.shortMessage || e.message).slice(0, 120),
                data,
            });
            log(`  loan ${id}: ${isPanicX11 ? '🚨 Panic(0x11) ← §B1' : 'revert'} — ${(e.shortMessage || e.message).slice(0, 80)}`);
        }
    }

    // ---- Approve + supply ----
    const allowance = await usdc.allowance(wallet.address, ADDR.agentLiquidityMarketplace);
    if (allowance < SUPPLY_AMOUNT) {
        log('\n[B] Approving 0.5 USDC');
        const tx = await usdc.approve(ADDR.agentLiquidityMarketplace, ethers.parseUnits('0.5', 6));
        log('  tx:', tx.hash);
        await tx.wait();
    } else log('\n[B] Allowance sufficient:', fmt(allowance));

    // ---- Supply 0.1 USDC (position > 0 → should NOT push poolLenders) ----
    log('\n[C] Supply 0.1 USDC to own pool (position already 1.5 → no new poolLenders push)');
    const supTx = await mp.supplyLiquidity(SELF_AGENT, SUPPLY_AMOUNT);
    log('  tx:', supTx.hash);
    const supR = await supTx.wait();
    log('  mined block', supR.blockNumber, 'gas', supR.gasUsed.toString());
    const afterSup = await snapshot(mp, usdc, wallet.address, 'after_supply');
    log('  poolLenders count:', afterSup.own_pool.lenderCount, '(was', pre.own_pool.lenderCount + ')');
    log('  expected: unchanged (no push because position>0)');

    // ---- Withdraw 0.1 USDC ----
    log('\n[D] Withdraw 0.1 USDC');
    const wTx = await mp.withdrawLiquidity(SELF_AGENT, SUPPLY_AMOUNT);
    log('  tx:', wTx.hash);
    const wR = await wTx.wait();
    log('  mined block', wR.blockNumber, 'gas', wR.gasUsed.toString());

    const post = await snapshot(mp, usdc, wallet.address, 'post');
    log('\n--- POST ---'); log(JSON.stringify(post, null, 2));

    log('\n--- DIFF ---');
    log(`wallet USDC:  ${pre.wallet_usdc} → ${post.wallet_usdc}    Δ ${(post.wallet_usdc - pre.wallet_usdc).toFixed(6)}`);
    log(`MP USDC:      ${pre.mp_usdc} → ${post.mp_usdc}    Δ ${(post.mp_usdc - pre.mp_usdc).toFixed(6)}`);
    log(`pool avail:   ${pre.own_pool.avail} → ${post.own_pool.avail}`);
    log(`lenderCount:  ${pre.own_pool.lenderCount} → ${post.own_pool.lenderCount}`);
    log(`my supplied:  ${pre.my_position.supplied} → ${post.my_position.supplied}`);
    log(`pre poolLenders:  ${JSON.stringify(pre.poolLenders)}`);
    log(`post poolLenders: ${JSON.stringify(post.poolLenders)}`);

    fs.writeFileSync(path.join(OUT_DIR, '10-base-e2e-safe.json'),
        JSON.stringify({ pre, afterSupply: afterSup, post, panicEvidence, events }, null, 2));
    log('\nSaved.');
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
