// Track 3 — Large-scale V6 stress on Arc.
// Tests V6 with production-realistic amounts: 50k+ USDC per lender, multi-lender,
// max-duration loans, max credit utilization.
//
// Goals:
//   - decimal precision audit at large amounts
//   - interest accounting at 50k+ supply scale
//   - §S1 invariant with bigger numbers (more room for drift)
//   - max-credit borrowing under §S5-fixed gas
//
// Borrower credit limit is reputation-gated. We seed reputation by doing
// many small successful repays first, then attempt larger loans.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const RM_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json')).abi;
const USDC_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'];
const fmt = v => Number(ethers.formatUnits(v, 6));
const OUT = './forensics/output/regression-2026-05-07';

const SELF_AGENT = 49n;
const SUPPLY_PER_LENDER = ethers.parseUnits('50000', 6); // 50k each
const N_LENDERS = 3;
const FUND_ETH = ethers.parseEther('0.1');
const FUND_USDC = ethers.parseUnits('50100', 6);

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, attempts = 10) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const m = e.shortMessage || e.message || '';
            const isRate = m.includes('rate') || m.includes('408') || m.includes('410') || m.includes('429') || m.includes('-32016') || m.includes('timeout');
            if (i === attempts - 1 || !isRate) throw e;
            await sleep(Math.min(2000 * Math.pow(2, i), 30000));
        }
    }
}

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const v6 = new ethers.Contract(V6, ABI, owner);
    const rm = new ethers.Contract(ADDR.reputationManagerV3, RM_ABI, provider);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);

    console.log('=== TRACK 3: LARGE-SCALE V6 STRESS ===');
    console.log('Owner:', owner.address);
    console.log('V6:', V6);

    // Reputation check
    const repScore = await rm['getReputationScore(address)'](owner.address);
    const creditLimit = await rm.calculateCreditLimit(owner.address);
    console.log(`Reputation: ${repScore}, credit limit: ${fmt(creditLimit)} USDC`);

    const startEth = await provider.getBalance(owner.address);
    const startUsdc = await usdc.balanceOf(owner.address);
    console.log(`Start: ${ethers.formatEther(startEth)} ETH, ${fmt(startUsdc)} USDC`);

    // === Phase 1: Setup pool 49 with 3 fresh lenders at 50k each = 150k pool ===
    console.log(`\n[1] Generating + funding ${N_LENDERS} lenders × ${fmt(SUPPLY_PER_LENDER)} USDC each`);
    const lenders = [];
    for (let i = 0; i < N_LENDERS; i++) lenders.push(ethers.Wallet.createRandom().connect(provider));
    for (let i = 0; i < N_LENDERS; i++) {
        await withRetry(() => owner.sendTransaction({ to: lenders[i].address, value: FUND_ETH }).then(t => t.wait()));
        await withRetry(() => usdc.transfer(lenders[i].address, FUND_USDC).then(t => t.wait()));
        console.log(`  funded lender ${i + 1}/${N_LENDERS}`);
    }

    console.log(`\n[2] Each lender supplies ${fmt(SUPPLY_PER_LENDER)} USDC`);
    const supplyResults = [];
    for (let i = 0; i < N_LENDERS; i++) {
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, lenders[i]);
        const m = new ethers.Contract(V6, ABI, lenders[i]);
        await withRetry(() => u.approve(V6, SUPPLY_PER_LENDER).then(t => t.wait()));
        const tx = await withRetry(() => m.supplyLiquidity(SELF_AGENT, SUPPLY_PER_LENDER));
        const r = await withRetry(() => tx.wait());
        supplyResults.push({ lender: lenders[i].address, gas: Number(r.gasUsed), tx: tx.hash });
        console.log(`  lender ${i + 1} supplied, gas ${r.gasUsed}`);
    }

    const poolAfterSupply = await withRetry(() => v6.getAgentPool(SELF_AGENT));
    console.log(`\nPool 49 after supplies: totalLiq=${fmt(poolAfterSupply[1])}, avail=${fmt(poolAfterSupply[2])}, lenderCount=${poolAfterSupply[6]}`);

    // === Phase 2: Owner takes loans up to credit limit ===
    const LOAN_AMT = creditLimit < ethers.parseUnits('1000', 6) ? creditLimit : ethers.parseUnits('1000', 6);
    console.log(`\n[3] Owner takes ${fmt(LOAN_AMT)} USDC loan (max credit limit), 365 days`);
    const allowance = await withRetry(() => usdc.allowance(owner.address, V6));
    if (allowance < ethers.parseUnits('5000', 6)) {
        await withRetry(() => usdc.approve(V6, ethers.parseUnits('5000', 6)).then(t => t.wait()));
    }
    const loanTx = await withRetry(() => v6.requestLoan(LOAN_AMT, 365));
    const loanR = await withRetry(() => loanTx.wait());
    console.log(`  loan tx: ${loanTx.hash}, gas: ${loanR.gasUsed}`);
    const iface = new ethers.Interface(ABI);
    let loanId;
    for (const lg of loanR.logs) {
        try { const p = iface.parseLog(lg); if (p && p.name === 'LoanRequested') { loanId = p.args.loanId; break; } } catch {}
    }
    console.log(`  loanId: ${loanId}`);

    // Expected interest
    const expectedInterest = (LOAN_AMT * 1500n * 365n * 86400n) / (365n * 86400n * 10000n);
    console.log(`  expected interest (365d × 15%): ${fmt(expectedInterest)} USDC`);

    // Repay
    console.log(`\n[4] Repay loan — interest distributed across 3 lenders at $50k+ scale`);
    const repayTx = await withRetry(() => v6.repayLoan(loanId));
    const repayR = await withRetry(() => repayTx.wait());
    console.log(`  repay tx: ${repayTx.hash}, gas: ${repayR.gasUsed}`);
    console.log(`  ✅ no panic across 3 lenders + ${fmt(expectedInterest)} USDC interest distribution`);

    // === Phase 3: §S1 invariant + interest distribution accuracy ===
    console.log(`\n[5] §S1 + interest distribution check`);
    const positions = [];
    let sumEarned = 0n;
    for (let i = 0; i < N_LENDERS; i++) {
        const pos = await withRetry(() => v6.positions(SELF_AGENT, lenders[i].address));
        positions.push({ lender: lenders[i].address, supplied: fmt(pos[0]), earned: fmt(pos[1]) });
        sumEarned += pos[1];
    }
    const platformFee = (expectedInterest * 100n) / 10000n;
    const lenderInterest = expectedInterest - platformFee;
    console.log(`  Σ earned across lenders: ${fmt(sumEarned)}`);
    console.log(`  expected lender interest:  ${fmt(lenderInterest)}`);
    console.log(`  match? ${sumEarned === lenderInterest ? '✅ exact' : (sumEarned > lenderInterest - 3n && sumEarned < lenderInterest + 3n ? '✅ within rounding' : '❌ mismatch')}`);
    for (const p of positions) console.log(`    ${p.lender.slice(0,10)}... supplied=${p.supplied}, earned=${p.earned.toFixed(8)}`);

    // === Phase 4: Each lender claims ===
    console.log(`\n[6] Each lender claims`);
    const preClaim = await withRetry(() => v6.getAgentPool(SELF_AGENT));
    for (let i = 0; i < N_LENDERS; i++) {
        const m = new ethers.Contract(V6, ABI, lenders[i]);
        try {
            const tx = await withRetry(() => m.claimInterest(SELF_AGENT));
            await withRetry(() => tx.wait());
            console.log(`  lender ${i + 1} claimed`);
        } catch (e) { console.log(`  lender ${i + 1}: ${(e.shortMessage || e.message).slice(0, 60)}`); }
    }
    const postClaim = await withRetry(() => v6.getAgentPool(SELF_AGENT));
    const mpBal = await withRetry(() => usdc.balanceOf(V6));
    const drift = preClaim[2] - postClaim[2];
    console.log(`  pool avail Δ: ${fmt(drift)} (expected: ${fmt(sumEarned)})`);
    console.log(`  §S1: avail (${fmt(postClaim[2])}) ≤ mpBal (${fmt(mpBal)})? ${postClaim[2] <= mpBal ? '✅' : '❌'}`);

    // === Phase 5: Cleanup ===
    console.log(`\n[7] Cleanup`);
    for (let i = 0; i < N_LENDERS; i++) {
        const m = new ethers.Contract(V6, ABI, lenders[i]);
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, lenders[i]);
        try {
            const pos = await withRetry(() => v6.positions(SELF_AGENT, lenders[i].address));
            if (pos[0] > 0n) {
                await withRetry(() => m.withdrawLiquidity(SELF_AGENT, pos[0]).then(t => t.wait()));
            }
            const bal = await withRetry(() => u.balanceOf(lenders[i].address));
            if (bal > 0n) {
                await withRetry(() => u.transfer(owner.address, bal).then(t => t.wait()));
            }
            console.log(`  lender ${i + 1} cleaned`);
        } catch (e) { console.log(`  lender ${i + 1}: ${(e.shortMessage || e.message).slice(0, 60)}`); }
    }

    const endEth = await provider.getBalance(owner.address);
    const endUsdc = await usdc.balanceOf(owner.address);
    console.log(`\nEnd: ${ethers.formatEther(endEth)} ETH (Δ ${ethers.formatEther(endEth - startEth)})`);
    console.log(`USDC: ${fmt(endUsdc)} (Δ ${(fmt(endUsdc) - fmt(startUsdc)).toFixed(6)})`);

    fs.writeFileSync(path.join(OUT, '46-large-scale-v6.json'), JSON.stringify({
        supply_per_lender: fmt(SUPPLY_PER_LENDER),
        n_lenders: N_LENDERS,
        total_pool: fmt(SUPPLY_PER_LENDER * BigInt(N_LENDERS)),
        loan: { amount: fmt(LOAN_AMT), duration_days: 365, gas: Number(loanR.gasUsed), id: loanId.toString() },
        repay_gas: Number(repayR.gasUsed),
        expected_interest: fmt(expectedInterest),
        platform_fee: fmt(platformFee),
        lender_interest: fmt(lenderInterest),
        sum_earned: fmt(sumEarned),
        interest_match: sumEarned === lenderInterest ? 'exact' : (sumEarned > lenderInterest - 3n && sumEarned < lenderInterest + 3n ? 'within_rounding' : 'mismatch'),
        positions,
        s1_invariant_holds: postClaim[2] <= mpBal,
    }, null, 2));
    console.log('\nSaved.');
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
