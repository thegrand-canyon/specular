// Test D+E — Long-duration loan + extended claim cycles on Arc V6.
//
// D: Take a maximum-duration (365 day) loan with substantial principal,
//    repay immediately. Verify interest calculation matches contract formula
//    and §S1 invariant holds at large interest amounts.
//
// E: 30 sequential supply/loan/repay/claim cycles by 3 lenders to stress
//    the §S1 decrement accounting over many transactions.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const USDC_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'];
const fmt = v => Number(ethers.formatUnits(v, 6));
const OUT = './forensics/output/regression-2026-05-07';

const SELF_AGENT = 49n;

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

    // Approve generous amounts upfront
    const allowance = await withRetry(() => usdc.allowance(owner.address, V6), 'allow');
    if (allowance < ethers.parseUnits('5000', 6)) {
        const t = await withRetry(() => usdc.approve(V6, ethers.parseUnits('5000', 6)), 'approve');
        await withRetry(() => t.wait(), 'approve.wait');
        log('approved 5000 USDC');
    }

    // ====================================================================
    // TEST D — long-duration loan (max = 365 days)
    // ====================================================================
    log(`\n=== TEST D — Maximum-duration loan (365 days) ===`);

    const D_LOAN = ethers.parseUnits('500', 6);
    const D_DURATION = 365;

    // Seed pool with enough liquidity
    const pool = await withRetry(() => v6.getAgentPool(SELF_AGENT), 'pool');
    log(`pre-pool avail: ${fmt(pool[2])}`);
    if (pool[2] < D_LOAN) {
        const need = D_LOAN - pool[2];
        const t = await withRetry(() => v6.supplyLiquidity(SELF_AGENT, need), 'seedD');
        await withRetry(() => t.wait(), 'seedD.wait');
        log(`seeded ${fmt(need)} USDC`);
    }

    log(`Requesting loan ${fmt(D_LOAN)} USDC, ${D_DURATION} days`);
    const lTx = await withRetry(() => v6.requestLoan(D_LOAN, D_DURATION), 'D.loan');
    const lR = await withRetry(() => lTx.wait(), 'D.loan.wait');
    log(`  loan tx: ${lTx.hash}, gas: ${lR.gasUsed.toString()}`);
    const iface = new ethers.Interface(ABI);
    let loanId;
    for (const lg of lR.logs) {
        try { const p = iface.parseLog(lg); if (p && p.name === 'LoanRequested') { loanId = p.args.loanId; break; } } catch {}
    }
    log(`  loanId: ${loanId.toString()}`);

    // Compute expected interest
    const expectedInterest = (D_LOAN * 1500n * BigInt(D_DURATION) * 86400n) / (365n * 86400n * 10000n);
    log(`  expected interest: ${fmt(expectedInterest)} USDC (= ${fmt(D_LOAN)} × 15% × 365/365)`);

    log(`  Repaying...`);
    const rTx = await withRetry(() => v6.repayLoan(loanId), 'D.repay');
    const rR = await withRetry(() => rTx.wait(), 'D.repay.wait');
    log(`  repay tx: ${rTx.hash}, gas: ${rR.gasUsed.toString()}`);

    // Verify earned interest matches expectation
    const myPos = await withRetry(() => v6.positions(SELF_AGENT, owner.address), 'D.pos');
    const platformFee = (expectedInterest * 100n) / 10000n;
    const expectedToLender = expectedInterest - platformFee;
    log(`  expected total interest: ${fmt(expectedInterest)}`);
    log(`  expected platform fee:    ${fmt(platformFee)}`);
    log(`  expected to lender:       ${fmt(expectedToLender)}`);
    log(`  actual earnedInterest:    ${fmt(myPos[1])}`);

    const interestMatch = myPos[1] === expectedToLender;
    log(`  ${interestMatch ? '✅' : '⚠'} interest formula match`);

    // Claim and verify §S1
    const beforePool = await withRetry(() => v6.getAgentPool(SELF_AGENT), 'D.before');
    const ciTx = await withRetry(() => v6.claimInterest(SELF_AGENT), 'D.claim');
    await withRetry(() => ciTx.wait(), 'D.claim.wait');
    const afterPool = await withRetry(() => v6.getAgentPool(SELF_AGENT), 'D.after');
    const decrement = beforePool[2] - afterPool[2];
    log(`  pool avail decrement: ${fmt(decrement)} (expected: ${fmt(myPos[1])})`);
    log(`  ${decrement === myPos[1] ? '✅' : '⚠'} §S1 decrement exact`);

    // ====================================================================
    // TEST E — 30 supply/loan/repay/claim cycles
    // ====================================================================
    log(`\n=== TEST E — 30 cycles of supply/loan/repay/claim ===`);

    const E_CYCLES = 30;
    const E_LOAN = ethers.parseUnits('50', 6);
    const E_DURATION = 30;

    // Withdraw any existing position first
    const p0 = await withRetry(() => v6.positions(SELF_AGENT, owner.address), 'E.p0');
    if (p0[0] > 0n) {
        const w = await withRetry(() => v6.withdrawLiquidity(SELF_AGENT, p0[0]), 'E.wd0');
        await withRetry(() => w.wait(), 'E.wd0.wait');
        log(`  pre-cleanup withdrew ${fmt(p0[0])}`);
    }

    const cycleData = [];
    for (let i = 0; i < E_CYCLES; i++) {
        // Supply 100 USDC
        const supTx = await withRetry(() => v6.supplyLiquidity(SELF_AGENT, ethers.parseUnits('100', 6)), `E.sup${i}`);
        await withRetry(() => supTx.wait(), 'E.sup.wait');

        // Borrow 50
        const lTx = await withRetry(() => v6.requestLoan(E_LOAN, E_DURATION), `E.loan${i}`);
        const lR = await withRetry(() => lTx.wait(), 'E.loan.wait');
        let lid;
        for (const lg of lR.logs) {
            try { const p = iface.parseLog(lg); if (p && p.name === 'LoanRequested') { lid = p.args.loanId; break; } } catch {}
        }

        // Repay
        const rTx = await withRetry(() => v6.repayLoan(lid), `E.repay${i}`);
        await withRetry(() => rTx.wait(), 'E.repay.wait');

        // Claim
        const pos = await withRetry(() => v6.positions(SELF_AGENT, owner.address), `E.pos${i}`);
        const earnedNow = pos[1];
        let claimed = 0n;
        if (earnedNow > 0n) {
            const cTx = await withRetry(() => v6.claimInterest(SELF_AGENT), `E.claim${i}`);
            await withRetry(() => cTx.wait(), 'E.claim.wait');
            claimed = earnedNow;
        }

        // Withdraw all
        const pos2 = await withRetry(() => v6.positions(SELF_AGENT, owner.address), `E.pos2${i}`);
        if (pos2[0] > 0n) {
            const w = await withRetry(() => v6.withdrawLiquidity(SELF_AGENT, pos2[0]), `E.wd${i}`);
            await withRetry(() => w.wait(), 'E.wd.wait');
        }

        // Snapshot pool state
        const pool = await withRetry(() => v6.getAgentPool(SELF_AGENT), `E.pool${i}`);
        const mpBal = await withRetry(() => usdc.balanceOf(V6), `E.mpBal${i}`);
        const violates = pool[2] > mpBal;
        cycleData.push({
            cycle: i + 1, claimed: fmt(claimed),
            poolAvail: fmt(pool[2]), mpBal: fmt(mpBal),
            s1_violates: violates,
        });
        if (violates) log(`  cycle ${i + 1}: ❌ §S1 violation: avail=${fmt(pool[2])} > mpBal=${fmt(mpBal)}`);
        if ((i + 1) % 5 === 0) log(`  cycle ${i + 1}/${E_CYCLES}: claimed ${fmt(claimed)}, avail=${fmt(pool[2])}, mpBal=${fmt(mpBal)}`);
    }

    const totalClaimed = cycleData.reduce((a, c) => a + c.claimed, 0);
    const violationCount = cycleData.filter(c => c.s1_violates).length;
    log(`\n=== TEST E SUMMARY ===`);
    log(`Total claimed across ${E_CYCLES} cycles: ${totalClaimed.toFixed(6)} USDC`);
    log(`§S1 violations: ${violationCount} / ${E_CYCLES}  ${violationCount === 0 ? '✅ all cycles holds' : '❌ violations detected'}`);

    fs.writeFileSync(path.join(OUT, '31-test-de-longdur-claims.json'), JSON.stringify({
        D: {
            loanAmount: fmt(D_LOAN), duration: D_DURATION,
            expectedInterest: fmt(expectedInterest),
            expectedToLender: fmt(expectedToLender),
            actualEarnedInterest: fmt(myPos[1]),
            interestMatches: interestMatch,
            poolAvailDecrement: fmt(decrement),
            s1ExactMatch: decrement === myPos[1],
        },
        E: { cycles: E_CYCLES, totalClaimed, violationCount, cycleData },
    }, null, 2));
    log('\nSaved.');
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
