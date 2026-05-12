// Comprehensive V6 stress simulation.
//
// Multi-borrower (3 agents) + multi-lender (5 lenders × 100k) on V6 pool.
// Each borrower does ~30 loan cycles; lenders interspersed claim/cycle.
// Continuous invariant assertions every 25 ops.
//
// Total ops: ~150-200. RPC-aware with 500ms inter-tx delay.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const REG_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')).abi;
const USDC_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'];
const fmt = v => Number(ethers.formatUnits(v, 6));
const OUT = './forensics/output/regression-2026-05-07';

const N_LENDERS = 5;
const SUPPLY_PER_LENDER = ethers.parseUnits('100000', 6); // 100k each = 500k total
const N_BORROWERS = 3;
const LOANS_PER_BORROWER = 30;
const LOAN_AMT = ethers.parseUnits('100', 6); // 100 USDC per loan
const DURATION = 30;
const FUND_ETH = ethers.parseEther('0.5'); // covers tons of tx
const FUND_USDC_LENDER = ethers.parseUnits('100100', 6);
const FUND_USDC_BORROWER = ethers.parseUnits('110', 6); // collateral buffer (low rep = 100% collateral)
const INTER_TX_DELAY = 500;

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, attempts = 12) {
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

const log = (...a) => console.log(...a);

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const v6 = new ethers.Contract(V6, ABI, owner);
    const reg = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, owner);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);

    log('=== COMPREHENSIVE V6 STRESS SIMULATION ===');
    log('Owner:', owner.address);
    const startEth = await provider.getBalance(owner.address);
    const startUsdc = await usdc.balanceOf(owner.address);
    log(`Start: ${ethers.formatEther(startEth)} ETH, ${fmt(startUsdc)} USDC`);

    // ===== Generate wallets =====
    log(`\n[1] Generate ${N_LENDERS} lenders + ${N_BORROWERS} borrowers`);
    const lenders = [];
    const borrowers = [];
    for (let i = 0; i < N_LENDERS; i++) lenders.push(ethers.Wallet.createRandom().connect(provider));
    for (let i = 0; i < N_BORROWERS; i++) borrowers.push(ethers.Wallet.createRandom().connect(provider));

    // ===== Fund =====
    log(`\n[2] Fund wallets`);
    for (const w of lenders) {
        await withRetry(() => owner.sendTransaction({ to: w.address, value: FUND_ETH }).then(t => t.wait()));
        await withRetry(() => usdc.transfer(w.address, FUND_USDC_LENDER).then(t => t.wait()));
        await sleep(INTER_TX_DELAY);
    }
    for (const w of borrowers) {
        await withRetry(() => owner.sendTransaction({ to: w.address, value: FUND_ETH }).then(t => t.wait()));
        await withRetry(() => usdc.transfer(w.address, FUND_USDC_BORROWER).then(t => t.wait()));
        await sleep(INTER_TX_DELAY);
    }
    log(`  funded ${N_LENDERS + N_BORROWERS} wallets`);

    // ===== Register borrowers + create pools =====
    log(`\n[3] Each borrower registers + creates own V6 pool`);
    const borrowerAgentIds = [];
    for (let i = 0; i < N_BORROWERS; i++) {
        const r = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, borrowers[i]);
        const m = new ethers.Contract(V6, ABI, borrowers[i]);
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, borrowers[i]);
        try {
            await withRetry(() => r.register(`ipfs://stress-borrower-${i}`, []).then(t => t.wait()));
            const aid = await withRetry(() => reg.addressToAgentId(borrowers[i].address));
            borrowerAgentIds.push(Number(aid));
            await withRetry(() => m.createAgentPool().then(t => t.wait()));
            await withRetry(() => u.approve(V6, FUND_USDC_BORROWER).then(t => t.wait()));
            log(`  borrower ${i + 1}: agentId=${aid}`);
            await sleep(INTER_TX_DELAY);
        } catch (e) { log(`  borrower ${i}: ${(e.shortMessage || e.message).slice(0, 60)}`); }
    }

    // ===== Each lender supplies to each borrower's pool =====
    log(`\n[4] Each lender supplies ${fmt(SUPPLY_PER_LENDER)/N_BORROWERS} USDC to each borrower's pool`);
    const SUPPLY_PER_POOL = SUPPLY_PER_LENDER / BigInt(N_BORROWERS);
    log(`  per-pool supply per lender: ${fmt(SUPPLY_PER_POOL)} USDC`);
    for (let i = 0; i < N_LENDERS; i++) {
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, lenders[i]);
        const m = new ethers.Contract(V6, ABI, lenders[i]);
        await withRetry(() => u.approve(V6, SUPPLY_PER_LENDER).then(t => t.wait()));
        for (const aid of borrowerAgentIds) {
            try {
                await withRetry(() => m.supplyLiquidity(aid, SUPPLY_PER_POOL).then(t => t.wait()));
                await sleep(INTER_TX_DELAY);
            } catch (e) { log(`  L${i}→pool${aid}: ${(e.shortMessage || e.message).slice(0, 60)}`); }
        }
        log(`  lender ${i + 1} supplied to all 3 pools`);
    }

    // ===== Invariant check helper =====
    async function checkInvariants(label) {
        let sumAvail = 0n, sumLoaned = 0n;
        for (const aid of borrowerAgentIds) {
            const p = await withRetry(() => v6.getAgentPool(aid));
            sumAvail += p[2];
            sumLoaned += p[3];
            // §B1
            const lc = Number(p[6]);
            const seen = new Set();
            for (let j = 0; j < lc; j++) {
                const lender = (await withRetry(() => v6.poolLenders(aid, j))).toLowerCase();
                if (seen.has(lender)) throw new Error(`§B1 VIOLATION: duplicate ${lender} in pool ${aid}`);
                seen.add(lender);
            }
        }
        const mpBal = await withRetry(() => usdc.balanceOf(V6));
        const slack = mpBal - sumAvail;
        if (sumAvail > mpBal) throw new Error(`§S1 VIOLATION: sumAvail ${fmt(sumAvail)} > mpBal ${fmt(mpBal)}`);
        log(`  ✅ [${label}] §B1 OK, §S1 OK (Σavail=${fmt(sumAvail).toFixed(2)}, mpBal=${fmt(mpBal).toFixed(2)}, slack=${fmt(slack).toFixed(6)})`);
    }
    await checkInvariants('post-supply');

    // ===== Each borrower does N loan cycles =====
    log(`\n[5] Each borrower does ${LOANS_PER_BORROWER} loan/repay cycles concurrently (round-robin)`);
    const loanGas = [];
    const repayGas = [];
    let totalLoans = 0;
    const iface = new ethers.Interface(ABI);
    let invariantChecks = 0;

    for (let cycle = 0; cycle < LOANS_PER_BORROWER; cycle++) {
        for (let i = 0; i < N_BORROWERS; i++) {
            const m = new ethers.Contract(V6, ABI, borrowers[i]);
            try {
                // Loan
                const lTx = await withRetry(() => m.requestLoan(LOAN_AMT, DURATION));
                const lR = await withRetry(() => lTx.wait());
                loanGas.push(Number(lR.gasUsed));
                await sleep(INTER_TX_DELAY);

                // Find loanId
                let lid;
                for (const lg of lR.logs) {
                    try { const p = iface.parseLog(lg); if (p && p.name === 'LoanRequested') { lid = p.args.loanId; break; } } catch {}
                }

                // Repay
                const rTx = await withRetry(() => m.repayLoan(lid));
                const rR = await withRetry(() => rTx.wait());
                repayGas.push(Number(rR.gasUsed));
                totalLoans++;
                await sleep(INTER_TX_DELAY);
            } catch (e) {
                log(`  cycle ${cycle + 1} borrower ${i + 1}: ${(e.shortMessage || e.message).slice(0, 80)}`);
                if ((e.shortMessage || '').includes('Panic')) throw new Error('§B1 PANIC during repay!');
            }
        }
        if ((cycle + 1) % 5 === 0) {
            log(`  cycle ${cycle + 1}/${LOANS_PER_BORROWER}: ${totalLoans} loans completed; first 5 loan gas ${loanGas.slice(0, 5).reduce((a,b)=>a+b,0)/5}, last 5 ${loanGas.slice(-5).reduce((a,b)=>a+b,0)/5}`);
            await checkInvariants(`cycle ${cycle + 1}`);
            invariantChecks++;
        }
    }

    log(`\n  Total loans completed: ${totalLoans}`);

    // ===== Lender claim cycles =====
    log(`\n[6] Each lender claims interest from each pool`);
    let totalClaimed = 0n;
    for (let i = 0; i < N_LENDERS; i++) {
        const m = new ethers.Contract(V6, ABI, lenders[i]);
        for (const aid of borrowerAgentIds) {
            try {
                const pos = await withRetry(() => v6.positions(aid, lenders[i].address));
                if (pos[1] > 0n) {
                    await withRetry(() => m.claimInterest(aid).then(t => t.wait()));
                    totalClaimed += pos[1];
                    await sleep(INTER_TX_DELAY);
                }
            } catch (e) { log(`  L${i}→pool${aid}: ${(e.shortMessage || e.message).slice(0, 60)}`); }
        }
    }
    log(`  total interest claimed: ${fmt(totalClaimed)} USDC`);
    await checkInvariants('post-claim');

    // ===== §B1 stress: each lender does supply→withdraw→supply 5× on pool 1 =====
    log(`\n[7] §B1 stress: each lender does supply→withdraw 5× on borrower 0's pool`);
    const stressAgentId = borrowerAgentIds[0];
    const cycleAmt = ethers.parseUnits('1000', 6);
    for (let i = 0; i < N_LENDERS; i++) {
        const m = new ethers.Contract(V6, ABI, lenders[i]);
        for (let k = 0; k < 5; k++) {
            try {
                await withRetry(() => m.supplyLiquidity(stressAgentId, cycleAmt).then(t => t.wait()));
                await sleep(INTER_TX_DELAY);
                await withRetry(() => m.withdrawLiquidity(stressAgentId, cycleAmt).then(t => t.wait()));
                await sleep(INTER_TX_DELAY);
            } catch (e) { log(`  L${i} cycle ${k}: ${(e.shortMessage || e.message).slice(0, 60)}`); break; }
        }
        log(`  lender ${i + 1}: 5 supply→withdraw cycles done`);
    }
    // Confirm no duplicates
    const stressPool = await withRetry(() => v6.getAgentPool(stressAgentId));
    const stressLenders = [];
    for (let j = 0; j < Number(stressPool[6]); j++) stressLenders.push((await withRetry(() => v6.poolLenders(stressAgentId, j))).toLowerCase());
    const unique = new Set(stressLenders);
    log(`  pool ${stressAgentId} lenderCount: ${stressPool[6]}, unique: ${unique.size} ${stressPool[6] == unique.size ? '✅ §B1 holds' : '❌ duplicates'}`);

    // Gas analysis
    if (loanGas.length > 0) {
        const first10 = loanGas.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
        const last10 = loanGas.slice(-10).reduce((a, b) => a + b, 0) / 10;
        log(`\nLoan gas: first10=${first10.toFixed(0)}, last10=${last10.toFixed(0)}, ratio=${(last10/first10).toFixed(3)} ${(last10/first10) < 1.2 ? '✅ §S5 OK' : '⚠'}`);
    }

    // ===== Cleanup =====
    log(`\n[8] Cleanup`);
    for (let i = 0; i < N_LENDERS; i++) {
        const m = new ethers.Contract(V6, ABI, lenders[i]);
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, lenders[i]);
        for (const aid of borrowerAgentIds) {
            try {
                const pos = await withRetry(() => v6.positions(aid, lenders[i].address));
                if (pos[0] > 0n) {
                    await withRetry(() => m.withdrawLiquidity(aid, pos[0]).then(t => t.wait()));
                    await sleep(INTER_TX_DELAY);
                }
            } catch {}
        }
        const bal = await withRetry(() => u.balanceOf(lenders[i].address));
        if (bal > 0n) {
            await withRetry(() => u.transfer(owner.address, bal).then(t => t.wait()));
        }
    }
    for (let i = 0; i < N_BORROWERS; i++) {
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, borrowers[i]);
        const bal = await withRetry(() => u.balanceOf(borrowers[i].address));
        if (bal > 0n) {
            await withRetry(() => u.transfer(owner.address, bal).then(t => t.wait()));
        }
    }
    log(`  cleanup done`);

    const endEth = await provider.getBalance(owner.address);
    const endUsdc = await usdc.balanceOf(owner.address);
    log(`\nEnd: ${ethers.formatEther(endEth)} ETH (Δ ${ethers.formatEther(endEth - startEth)})`);
    log(`USDC: ${fmt(endUsdc)} (Δ ${(fmt(endUsdc) - fmt(startUsdc)).toFixed(2)})`);
    log(`Invariant checks during run: ${invariantChecks}`);

    fs.writeFileSync(path.join(OUT, '47-comprehensive-stress.json'), JSON.stringify({
        n_lenders: N_LENDERS, n_borrowers: N_BORROWERS,
        supply_per_lender: fmt(SUPPLY_PER_LENDER), total_pool: fmt(SUPPLY_PER_LENDER) * N_LENDERS,
        loans_completed: totalLoans,
        invariant_checks_passed: invariantChecks,
        b1_stress_lender_count: Number(stressPool[6]),
        b1_stress_unique: unique.size,
        b1_holds: stressPool[6] == unique.size,
        eth_delta: ethers.formatEther(endEth - startEth),
        usdc_delta: fmt(endUsdc) - fmt(startUsdc),
    }, null, 2));
    log('\nSaved.');
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
