// Multi-lender interest distribution test on Arc V6.
//
// Generates 3 fresh test wallets, funds them with ETH + USDC from the secure
// wallet, has each supply to agent #49's pool, then agent #49 borrows + repays.
// Verifies interest is distributed proportionally and §B1 does NOT panic
// (this is the exact path that panics on v4 with duplicate poolLenders).
//
// Cleans up by having each lender withdraw + claim, then refunds extras.

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
const N_LENDERS = 3;
const FUND_ETH_PER_WALLET = ethers.parseEther('0.025');
const FUND_USDC_PER_WALLET = ethers.parseUnits('0.3', 6); // each can supply up to 0.3
const SUPPLY_AMOUNTS = [ethers.parseUnits('0.2', 6), ethers.parseUnits('0.15', 6), ethers.parseUnits('0.1', 6)]; // total 0.45
const LOAN = ethers.parseUnits('0.3', 6);
const DURATION = 30; // 30 days for higher interest

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, label, attempts = 6) {
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

const events = [];
const log = (...a) => { console.log(...a); events.push(a.map(String).join(' ')); };

async function snapshotPool(v6, usdc) {
    const pool = await withRetry(() => v6.getAgentPool(SELF_AGENT), 'pool');
    const mpBal = await withRetry(() => usdc.balanceOf(V6), 'mpBal');
    const lc = Number(pool[6]);
    const lenders = [];
    for (let j = 0; j < lc; j++) {
        lenders.push((await withRetry(() => v6.poolLenders(SELF_AGENT, j), `pl${j}`)).toLowerCase());
    }
    return { totalLiq: pool[1], avail: pool[2], totalLoaned: pool[3], totalEarned: pool[4], lenderCount: lc, lenders, mpBal };
}

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    log('Owner (agent #49):', owner.address);
    log('V6:', V6);

    const v6Owner = new ethers.Contract(V6, ABI, owner);
    const usdcOwner = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);

    const pre = await snapshotPool(v6Owner, usdcOwner);
    log(`PRE pool: lenderCount=${pre.lenderCount}, lenders=${JSON.stringify(pre.lenders)}, avail=${fmt(pre.avail)}`);

    // ---- 1. Generate fresh lender wallets ----
    const lenders = [];
    for (let i = 0; i < N_LENDERS; i++) {
        const w = ethers.Wallet.createRandom().connect(provider);
        lenders.push(w);
        log(`lender ${i+1}: ${w.address}`);
    }

    // ---- 2. Fund each with ETH + USDC ----
    log('\n[1] funding lenders');
    for (const lender of lenders) {
        // ETH
        const ethTx = await withRetry(() => owner.sendTransaction({ to: lender.address, value: FUND_ETH_PER_WALLET }), 'fundETH');
        await withRetry(() => ethTx.wait(), 'fundETH.wait');
        // USDC
        const usdcTx = await withRetry(() => usdcOwner.transfer(lender.address, FUND_USDC_PER_WALLET), 'fundUSDC');
        await withRetry(() => usdcTx.wait(), 'fundUSDC.wait');
    }
    log('  funded all 3 lenders');

    // ---- 3. Each lender approves + supplies ----
    log('\n[2] each lender supplies to agent #49 pool');
    for (let i = 0; i < N_LENDERS; i++) {
        const lender = lenders[i];
        const amt = SUPPLY_AMOUNTS[i];
        const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, lender);
        const v6L = new ethers.Contract(V6, ABI, lender);
        const aTx = await withRetry(() => usdc.approve(V6, amt), `approve${i}`);
        await withRetry(() => aTx.wait(), 'approve.wait');
        const sTx = await withRetry(() => v6L.supplyLiquidity(SELF_AGENT, amt), `supply${i}`);
        const r = await withRetry(() => sTx.wait(), 'supply.wait');
        log(`  lender ${i+1}: supplied ${fmt(amt)} USDC, tx=${sTx.hash}, gas=${r.gasUsed.toString()}`);
    }

    const afterSupply = await snapshotPool(v6Owner, usdcOwner);
    const expectedNewLenders = N_LENDERS + (pre.lenderCount > 0 && !pre.lenders.includes(owner.address.toLowerCase()) ? 0 : (pre.lenders.length === 1 ? 1 : 0));
    log(`POST-SUPPLY: lenderCount=${afterSupply.lenderCount} (was ${pre.lenderCount}, expected +${N_LENDERS})`);
    log(`  unique lenders: ${new Set(afterSupply.lenders).size}`);
    log(`  poolLenders: ${JSON.stringify(afterSupply.lenders)}`);

    // ---- 4. Owner approves + supplies a small amount too (so owner is also a lender) ----
    // Skip — adds complexity. Multi-lender = the 3 fresh ones + owner if pre-existing.

    // ---- 5. Owner (agent #49) requests + repays loan ----
    log('\n[3] agent #49 requests 0.3 USDC loan, 30 days');
    const ownerAllow = await usdcOwner.balanceOf(owner.address); // sanity
    log(`  owner USDC balance: ${fmt(ownerAllow)}`);

    // Need to approve for collateral + repay (100% collateral due to score 0)
    const approveAmt = ethers.parseUnits('0.7', 6); // collateral + repay
    const ownerUsdcAllow = await withRetry(() => new ethers.Contract(ADDR.usdc, ['function allowance(address,address) view returns (uint256)'], provider).allowance(owner.address, V6), 'allow');
    if (ownerUsdcAllow < approveAmt) {
        const t = await withRetry(() => usdcOwner.approve(V6, approveAmt), 'ownerApprove');
        await withRetry(() => t.wait(), 'ownerApprove.wait');
        log('  owner approved 0.7 USDC for collateral + repay');
    }

    const loanTx = await withRetry(() => v6Owner.requestLoan(LOAN, DURATION), 'loan');
    const loanR = await withRetry(() => loanTx.wait(), 'loan.wait');
    log(`  loan tx: ${loanTx.hash}, gas: ${loanR.gasUsed.toString()}`);
    const iface = new ethers.Interface(ABI);
    let loanId;
    for (const lg of loanR.logs) {
        try { const p = iface.parseLog(lg); if (p && p.name === 'LoanRequested') { loanId = p.args.loanId; break; } } catch {}
    }
    log(`  loanId: ${loanId.toString()}`);

    // ---- 6. Repay (this is the §B1-panic-trigger on v4) ----
    log('\n[4] repay loan — would panic on v4 with duplicate lenders, must succeed on V6');
    const repayTx = await withRetry(() => v6Owner.repayLoan(loanId), 'repay');
    const repayR = await withRetry(() => repayTx.wait(), 'repay.wait');
    log(`  repay tx: ${repayTx.hash}, gas: ${repayR.gasUsed.toString()}`);
    log('  ✅ NO PANIC — interest distribution succeeded with multiple lenders');

    // ---- 7. Verify each lender's earnedInterest ----
    log('\n[5] verify each lender received proportional interest');
    const totalSupply = SUPPLY_AMOUNTS.reduce((a, b) => a + b, 0n);
    const expectedInterest = (LOAN * 1500n * BigInt(DURATION) * 86400n) / (365n * 86400n * 10000n);
    const platformFee = (expectedInterest * 100n) / 10000n; // 1%
    const lenderInterest = expectedInterest - platformFee;
    log(`  expected total interest: ${fmt(expectedInterest)}, platform fee: ${fmt(platformFee)}, to lenders: ${fmt(lenderInterest)}`);

    const positions = [];
    for (let i = 0; i < N_LENDERS; i++) {
        const pos = await withRetry(() => v6Owner.positions(SELF_AGENT, lenders[i].address), `pos${i}`);
        const expectedShare = (lenderInterest * SUPPLY_AMOUNTS[i]) / totalSupply;
        positions.push({
            lender: lenders[i].address,
            supplied: fmt(SUPPLY_AMOUNTS[i]),
            earnedInterest: fmt(pos[1]),
            expectedShare: fmt(expectedShare),
        });
        log(`  lender ${i+1}: earned ${fmt(pos[1]).toFixed(8)} (expected ~${fmt(expectedShare).toFixed(8)})`);
    }

    // ---- 8. Each lender claims interest (§S1 test on multi-lender) ----
    log('\n[6] each lender claims interest (§S1 test)');
    const beforeClaim = await snapshotPool(v6Owner, usdcOwner);
    log(`  pre-claim avail: ${fmt(beforeClaim.avail)}`);
    let totalClaimed = 0n;
    for (let i = 0; i < N_LENDERS; i++) {
        const v6L = new ethers.Contract(V6, ABI, lenders[i]);
        try {
            const tx = await withRetry(() => v6L.claimInterest(SELF_AGENT), `claim${i}`);
            const r = await withRetry(() => tx.wait(), 'claim.wait');
            log(`  lender ${i+1}: claimed, tx=${tx.hash}, gas=${r.gasUsed.toString()}`);
            totalClaimed += BigInt(positions[i].earnedInterest * 1e6);
        } catch (e) { log(`  lender ${i+1}: claim failed ${(e.shortMessage || e.message).slice(0, 60)}`); }
    }
    const afterClaim = await snapshotPool(v6Owner, usdcOwner);
    log(`  post-claim avail: ${fmt(afterClaim.avail)} (Δ ${(fmt(afterClaim.avail) - fmt(beforeClaim.avail)).toFixed(8)})`);
    log(`  expected Δ: -${fmt(lenderInterest).toFixed(8)} (≈)`);

    // §S1 invariant
    const invariantHolds = afterClaim.avail <= afterClaim.mpBal;
    log(`  §S1 invariant: avail=${fmt(afterClaim.avail).toFixed(8)} ≤ mpBal=${fmt(afterClaim.mpBal).toFixed(8)} ${invariantHolds ? '✅' : '❌'}`);

    // ---- 9. Cleanup: lenders withdraw remaining + return ETH ----
    log('\n[7] cleanup');
    for (let i = 0; i < N_LENDERS; i++) {
        const lender = lenders[i];
        const v6L = new ethers.Contract(V6, ABI, lender);
        const usdcL = new ethers.Contract(ADDR.usdc, USDC_ABI, lender);
        try {
            const pos = await withRetry(() => v6Owner.positions(SELF_AGENT, lender.address), `finalPos${i}`);
            if (pos[0] > 0n) {
                const t = await withRetry(() => v6L.withdrawLiquidity(SELF_AGENT, pos[0]), `wd${i}`);
                await withRetry(() => t.wait(), 'wd.wait');
                log(`  lender ${i+1}: withdrew ${fmt(pos[0])}`);
            }
            // Return USDC to owner
            const usdcBal = await withRetry(() => usdcL.balanceOf(lender.address), `bal${i}`);
            if (usdcBal > 0n) {
                const t = await withRetry(() => usdcL.transfer(owner.address, usdcBal), `return${i}`);
                await withRetry(() => t.wait(), 'return.wait');
                log(`  lender ${i+1}: returned ${fmt(usdcBal)} USDC`);
            }
        } catch (e) { log(`  lender ${i+1} cleanup err: ${(e.shortMessage || e.message).slice(0, 80)}`); }
    }

    const post = await snapshotPool(v6Owner, usdcOwner);
    log(`\nPOST: lenderCount=${post.lenderCount}, avail=${fmt(post.avail)}`);
    log(`  unique lenders: ${new Set(post.lenders).size} (should equal lenderCount: ${post.lenderCount})`);

    fs.writeFileSync(path.join(OUT, '26-v6-multi-lender.json'), JSON.stringify({
        n_lenders: N_LENDERS,
        supply_amounts: SUPPLY_AMOUNTS.map(String),
        lenders: lenders.map(l => l.address),
        positions,
        loan: { id: loanId.toString(), amount: LOAN.toString(), duration: DURATION },
        expected_interest: { total: fmt(expectedInterest), platformFee: fmt(platformFee), toLenders: fmt(lenderInterest) },
        s1_invariant_holds: invariantHolds,
        events,
    }, null, 2));
    log('\nSaved.');
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
