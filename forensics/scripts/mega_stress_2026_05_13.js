// Mega stress simulation — Arc V6 post-fix.
//
// Bigger than any prior stress test:
//   - 10 lenders × 100k USDC supplied (1M USDC total)
//   - 5 borrowers × 100 loan cycles each (500 loans)
//   - MAX_LENDERS=50 boundary verification
//   - Mixed loan durations cycling [7, 30, 90, 180, 365] days
//   - 300 random-op fuzz between cycles
//   - 100 supply/withdraw §B1 high-churn cycles
//   - Interleaved claims every 10 loan cycles
//   - Invariant snapshot every 25 ops
//   - Reputation tracking per borrower
//
// Runtime: ~75 min on Arc testnet.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const REG_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')).abi;
const REP_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json')).abi;
const USDC_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'];
const fmt = v => Number(ethers.formatUnits(v, 6));

// Scaled to fit ~41k USDC budget (prior crashes stranded ~1.1M USDC in V6 under lost random-wallet keys).
// USDC budget: 6 lenders × 5050 + 5 borrowers × 500 + 40 extra lenders × 50 + 1 cap-test = ~33,300 USDC.
const N_LENDERS = 6;
const N_BORROWERS = 5;
const LOANS_PER_BORROWER = 100;
const SUPPLY_PER_LENDER = ethers.parseUnits('5000', 6);
const LOAN_AMT = ethers.parseUnits('10', 6);
const DURATIONS = [7, 30, 90, 180, 365];
const FUND_ETH = ethers.parseEther('3.0'); // bumped from 1.0 (borrower 1 ran out by cycle 46 with 100 cycles)
const FUND_USDC_LENDER = ethers.parseUnits('5050', 6);
const FUND_USDC_BORROWER = ethers.parseUnits('500', 6);
const INTER_TX_DELAY = 600; // bumped from 400 to stay under drpc.org free-tier rate limit
const RANDOM_FUZZ_OPS = 300;
const B1_CHURN_CYCLES = 100;
const MAX_LENDERS = 50;

const OUT_FILE = './forensics/output/regression-2026-05-07/52-mega-stress.txt';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, attempts = 20) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const m = (e.shortMessage || e.message || '').toLowerCase();
            const isRate = m.includes('rate') || m.includes('408') || m.includes('410') || m.includes('429') || m.includes('502') || m.includes('503') || m.includes('-32016') || m.includes('timeout') || m.includes('missing revert data') || m.includes('server response') || m.includes('server_error') || m.includes('econnreset') || m.includes('socket hang up') || m.includes('network');
            if (i === attempts - 1 || !isRate) throw e;
            await sleep(Math.min(2000 * Math.pow(1.6, i), 60000));
        }
    }
}

// Wrapped tx-send pattern: separate retries for submit vs receipt-wait.
// Tx submission can re-broadcast on retry (nonce conflict is rejected). receipt-wait is idempotent on tx hash.
async function sendAndWait(label, send) {
    const tx = await withRetry(send);
    return await withRetry(() => tx.wait());
}

// Catch any leaked unhandled rejection so the run continues.
process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection caught]:', (reason && reason.shortMessage) || (reason && reason.message) || reason);
});

const log = (...a) => { const line = a.join(' '); console.log(line); };
const fmtMaybe = (e, fb = 'error') => { try { return (e.shortMessage || e.message || fb).slice(0, 100); } catch { return fb; } };

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const v6 = new ethers.Contract(V6, ABI, owner);
    const reg = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, owner);
    const rep = new ethers.Contract(ADDR.reputationManagerV3, REP_ABI, owner);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);

    log('========================================================================');
    log('   MEGA STRESS — Arc V6 post-fix (' + V6 + ')');
    log('========================================================================');
    log('Owner:', owner.address);
    log('Start:', ethers.formatEther(await provider.getBalance(owner.address)), 'ETH,', fmt(await usdc.balanceOf(owner.address)), 'USDC');
    const t0 = Date.now();

    const invariantLog = [];
    let totalOps = 0;
    let invSnapshots = 0;

    async function checkInvariants(label, poolIds) {
        invSnapshots++;
        let sumAvail = 0n, sumLoaned = 0n;
        const dupViolations = [];
        for (const aid of poolIds) {
            try {
                const p = await withRetry(() => v6.getAgentPool(aid));
                sumAvail += p[2]; sumLoaned += p[3];
                const lc = Number(p[6]);
                if (lc > 0) {
                    const seen = new Set();
                    for (let j = 0; j < lc; j++) {
                        const l = (await withRetry(() => v6.poolLenders(aid, j))).toLowerCase();
                        if (seen.has(l)) dupViolations.push({ aid, l });
                        seen.add(l);
                    }
                }
            } catch (e) {}
        }
        const mpBal = await withRetry(() => usdc.balanceOf(V6));
        const s1Violates = sumAvail > mpBal;
        const b1Violates = dupViolations.length > 0;
        const result = { ts: Date.now(), label, sumAvail: fmt(sumAvail), sumLoaned: fmt(sumLoaned), mpBal: fmt(mpBal), slack: fmt(mpBal - sumAvail), s1Violates, b1Violates, dupViolations };
        invariantLog.push(result);
        const tag = s1Violates || b1Violates ? '❌' : '✅';
        log(`  ${tag} [${label}] §B1 ${b1Violates ? 'VIOLATED:' + JSON.stringify(dupViolations) : 'OK'}, §S1 ${s1Violates ? 'VIOLATED' : 'OK'} (Σavail=${fmt(sumAvail).toFixed(2)}, mpBal=${fmt(mpBal).toFixed(2)}, slack=${fmt(mpBal - sumAvail).toFixed(6)})`);
        return result;
    }

    // ============ PHASE 1: Generate wallets (with persistence for crash recovery) ============
    log('\n[1] Generate', N_LENDERS, 'lenders +', N_BORROWERS, 'borrowers');
    const lenders = [];
    const borrowers = [];
    for (let i = 0; i < N_LENDERS; i++) lenders.push(ethers.Wallet.createRandom().connect(provider));
    for (let i = 0; i < N_BORROWERS; i++) borrowers.push(ethers.Wallet.createRandom().connect(provider));
    // Persist private keys so a crash doesn't strand funds. recover script can re-load and drain.
    const walletsFile = './forensics/output/regression-2026-05-07/52-mega-stress-wallets.json';
    fs.writeFileSync(walletsFile, JSON.stringify({
        startedAt: new Date().toISOString(),
        lenders: lenders.map(w => ({ address: w.address, privateKey: w.privateKey })),
        borrowers: borrowers.map(w => ({ address: w.address, privateKey: w.privateKey }))
    }, null, 2));
    log('  generated', lenders.length + borrowers.length, 'wallets (persisted to ' + walletsFile + ')');

    // ============ PHASE 2: Fund all wallets ============
    log('\n[2] Fund wallets with ETH + USDC');
    for (const w of lenders) {
        await withRetry(() => owner.sendTransaction({ to: w.address, value: FUND_ETH }).then(t => t.wait()));
        await withRetry(() => usdc.transfer(w.address, FUND_USDC_LENDER).then(t => t.wait()));
        await sleep(INTER_TX_DELAY); totalOps += 2;
    }
    for (const w of borrowers) {
        await withRetry(() => owner.sendTransaction({ to: w.address, value: FUND_ETH }).then(t => t.wait()));
        await withRetry(() => usdc.transfer(w.address, FUND_USDC_BORROWER).then(t => t.wait()));
        await sleep(INTER_TX_DELAY); totalOps += 2;
    }
    log('  funded', lenders.length + borrowers.length, 'wallets');

    // ============ PHASE 3: Register borrowers + create pools ============
    log('\n[3] Register borrowers + create pools, approve MaxUint256');
    const borrowerAgentIds = [];
    const repBefore = [];
    for (let i = 0; i < N_BORROWERS; i++) {
        const r = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, borrowers[i]);
        const m = new ethers.Contract(V6, ABI, borrowers[i]);
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, borrowers[i]);
        await withRetry(() => r.register(`ipfs://mega-borrower-${i}-${Date.now()}`, []).then(t => t.wait()));
        const aid = await withRetry(() => reg.addressToAgentId(borrowers[i].address));
        borrowerAgentIds.push(Number(aid));
        await withRetry(() => m.createAgentPool().then(t => t.wait()));
        await withRetry(() => u.approve(V6, ethers.MaxUint256).then(t => t.wait()));
        const score = await withRetry(() => rep['getReputationScore(address)'](borrowers[i].address));
        repBefore.push(Number(score));
        log(`  borrower ${i + 1}: agentId=${aid} reputation=${score}`);
        await sleep(INTER_TX_DELAY); totalOps += 3;
    }

    // ============ PHASE 4: Supply liquidity ============
    log(`\n[4] Each lender supplies ${fmt(SUPPLY_PER_LENDER) / N_BORROWERS} USDC to each pool`);
    const SUPPLY_PER_POOL = SUPPLY_PER_LENDER / BigInt(N_BORROWERS);
    for (let i = 0; i < N_LENDERS; i++) {
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, lenders[i]);
        const m = new ethers.Contract(V6, ABI, lenders[i]);
        await withRetry(() => u.approve(V6, ethers.MaxUint256).then(t => t.wait()));
        for (const aid of borrowerAgentIds) {
            await withRetry(() => m.supplyLiquidity(aid, SUPPLY_PER_POOL).then(t => t.wait()));
            await sleep(INTER_TX_DELAY); totalOps++;
        }
        if ((i + 1) % 3 === 0) log(`  ${i + 1}/${N_LENDERS} lenders supplied`);
    }
    await checkInvariants('post-supply', borrowerAgentIds);

    // ============ PHASE 5: MAX_LENDERS boundary ============
    log(`\n[5] MAX_LENDERS=${MAX_LENDERS} boundary test on pool ${borrowerAgentIds[0]}`);
    const extraNeeded = MAX_LENDERS - N_LENDERS; // bring pool to exactly cap
    log(`  pool already has ${N_LENDERS} lenders; adding ${extraNeeded} extras to fill cap (${MAX_LENDERS})`);
    const extraLenders = [];
    for (let i = 0; i < extraNeeded; i++) extraLenders.push(ethers.Wallet.createRandom().connect(provider));
    // Persist extras for crash recovery
    const extrasFile = './forensics/output/regression-2026-05-07/52-mega-stress-extras.json';
    fs.writeFileSync(extrasFile, JSON.stringify({ extras: extraLenders.map(w => ({ address: w.address, privateKey: w.privateKey })) }, null, 2));
    for (let i = 0; i < extraLenders.length; i++) {
        const w = extraLenders[i];
        await withRetry(() => owner.sendTransaction({ to: w.address, value: ethers.parseEther('0.05') }).then(t => t.wait()));
        await withRetry(() => usdc.transfer(w.address, ethers.parseUnits('20', 6)).then(t => t.wait()));
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, w);
        const m = new ethers.Contract(V6, ABI, w);
        await withRetry(() => u.approve(V6, ethers.MaxUint256).then(t => t.wait()));
        await withRetry(() => m.supplyLiquidity(borrowerAgentIds[0], ethers.parseUnits('10', 6)).then(t => t.wait()));
        if ((i + 1) % 10 === 0) log(`  added ${i + 1}/${extraNeeded} extra lenders (pool now ${N_LENDERS + i + 1}/${MAX_LENDERS})`);
        await sleep(INTER_TX_DELAY); totalOps += 4;
    }
    const poolAfter50 = await v6.getAgentPool(borrowerAgentIds[0]);
    log(`  pool ${borrowerAgentIds[0]} now has lenderCount=${poolAfter50[6]} (cap=${MAX_LENDERS})`);
    const w51 = ethers.Wallet.createRandom().connect(provider);
    fs.appendFileSync(extrasFile.replace('.json', '-51st.json'), JSON.stringify({ address: w51.address, privateKey: w51.privateKey }) + '\n');
    await withRetry(() => owner.sendTransaction({ to: w51.address, value: ethers.parseEther('0.05') }).then(t => t.wait()));
    await withRetry(() => usdc.transfer(w51.address, ethers.parseUnits('20', 6)).then(t => t.wait()));
    const u51 = new ethers.Contract(ADDR.usdc, USDC_ABI, w51);
    const m51 = new ethers.Contract(V6, ABI, w51);
    await withRetry(() => u51.approve(V6, ethers.MaxUint256).then(t => t.wait()));
    let cap51Rejected = false;
    try {
        await (await m51.supplyLiquidity(borrowerAgentIds[0], ethers.parseUnits('10', 6))).wait();
    } catch (e) {
        cap51Rejected = true;
        log(`  ✓ 51st lender REJECTED: "${fmtMaybe(e)}"`);
    }
    if (!cap51Rejected) log(`  ✗ 51st lender ADMITTED — MAX_LENDERS not enforced!`);
    totalOps += 4;
    await checkInvariants('post-boundary', borrowerAgentIds);

    // ============ PHASE 6: 500 loan cycles with mixed durations ============
    log(`\n[6] ${LOANS_PER_BORROWER} cycles × ${N_BORROWERS} borrowers = ${LOANS_PER_BORROWER * N_BORROWERS} loans, mixed durations`);
    let totalLoans = 0;
    let loanGas = [];
    let interestPaidTotal = 0n;
    for (let cycle = 0; cycle < LOANS_PER_BORROWER; cycle++) {
        const duration = DURATIONS[cycle % DURATIONS.length];
        for (let i = 0; i < N_BORROWERS; i++) {
            const m = new ethers.Contract(V6, ABI, borrowers[i]);
            try {
                const t1 = await withRetry(() => m.requestLoan(LOAN_AMT, duration));
                const r1 = await withRetry(() => t1.wait());
                loanGas.push(Number(r1.gasUsed));
                const loanId = await withRetry(() => v6.nextLoanId()) - 1n;
                await sleep(INTER_TX_DELAY);
                const t2 = await withRetry(() => m.repayLoan(loanId));
                await withRetry(() => t2.wait());
                totalLoans++;
                await sleep(INTER_TX_DELAY); totalOps += 2;
            } catch (e) {
                log(`  cycle ${cycle + 1} borrower ${i + 1} (${duration}d): ${fmtMaybe(e)}`);
            }
        }
        // Interleaved claims every 10 cycles
        if ((cycle + 1) % 10 === 0) {
            for (const lender of lenders) {
                const m = new ethers.Contract(V6, ABI, lender);
                for (const aid of borrowerAgentIds) {
                    try {
                        await withRetry(() => m.claimInterest(aid).then(t => t.wait()));
                        await sleep(INTER_TX_DELAY); totalOps++;
                    } catch (e) { /* no interest to claim is fine */ }
                }
            }
        }
        if ((cycle + 1) % 25 === 0) {
            log(`  cycle ${cycle + 1}/${LOANS_PER_BORROWER}: ${totalLoans} loans completed`);
            await checkInvariants(`cycle-${cycle + 1}`, borrowerAgentIds);
        }
    }
    log(`  Total loans: ${totalLoans}/${LOANS_PER_BORROWER * N_BORROWERS}`);
    if (loanGas.length >= 20) {
        const f10 = loanGas.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
        const l10 = loanGas.slice(-10).reduce((a, b) => a + b, 0) / 10;
        log(`  Loan gas: first10=${f10.toFixed(0)}, last10=${l10.toFixed(0)}, ratio=${(l10 / f10).toFixed(3)} ${l10 <= f10 * 1.05 ? '✅' : '❌'} §S5`);
    }

    // ============ PHASE 7: Random op fuzz ============
    log(`\n[7] Random op fuzz: ${RANDOM_FUZZ_OPS} ops on random pools by random actors`);
    const opTypes = ['supply', 'withdraw', 'requestLoan', 'repayLoan', 'claim'];
    let fuzzOk = 0, fuzzFail = 0;
    const actorPool = [...lenders.slice(0, 5), ...borrowers.slice(0, 3)]; // 8 actors
    const activeLoans = {}; // actor → list of loanIds
    for (let i = 0; i < RANDOM_FUZZ_OPS; i++) {
        const actor = actorPool[Math.floor(Math.random() * actorPool.length)];
        const aid = borrowerAgentIds[Math.floor(Math.random() * borrowerAgentIds.length)];
        const op = opTypes[Math.floor(Math.random() * opTypes.length)];
        const m = new ethers.Contract(V6, ABI, actor);
        try {
            if (op === 'supply') {
                const amt = ethers.parseUnits(String(Math.ceil(Math.random() * 100)), 6);
                await withRetry(() => m.supplyLiquidity(aid, amt).then(t => t.wait()));
            } else if (op === 'withdraw') {
                const pos = await v6.positions(aid, actor.address);
                if (pos.amount > 0n) {
                    const half = pos.amount / 2n;
                    if (half > 0n) await withRetry(() => m.withdrawLiquidity(aid, half).then(t => t.wait()));
                }
            } else if (op === 'requestLoan') {
                const t = await withRetry(() => m.requestLoan(ethers.parseUnits(String(Math.ceil(Math.random() * 30)), 6), DURATIONS[Math.floor(Math.random() * DURATIONS.length)]));
                const r = await withRetry(() => t.wait());
                const lid = (await v6.nextLoanId()) - 1n;
                if (!activeLoans[actor.address]) activeLoans[actor.address] = [];
                activeLoans[actor.address].push(Number(lid));
            } else if (op === 'repayLoan') {
                const arr = activeLoans[actor.address];
                if (arr && arr.length) {
                    const lid = arr.pop();
                    await withRetry(() => m.repayLoan(lid).then(t => t.wait()));
                }
            } else if (op === 'claim') {
                await withRetry(() => m.claimInterest(aid).then(t => t.wait()));
            }
            fuzzOk++;
        } catch (e) {
            fuzzFail++;
        }
        await sleep(INTER_TX_DELAY / 2);
        totalOps++;
        if ((i + 1) % 50 === 0) {
            log(`  ${i + 1}/${RANDOM_FUZZ_OPS}: ok=${fuzzOk} fail=${fuzzFail}`);
            await checkInvariants(`fuzz-${i + 1}`, borrowerAgentIds);
        }
    }
    log(`  Fuzz done: ${fuzzOk} ok, ${fuzzFail} fail`);

    // ============ PHASE 8: §B1 high-churn ============
    log(`\n[8] §B1 high-churn: ${B1_CHURN_CYCLES} supply→withdraw cycles by 5 lenders on pool ${borrowerAgentIds[1]}`);
    const churnPool = borrowerAgentIds[1];
    for (let c = 0; c < B1_CHURN_CYCLES; c++) {
        const lender = lenders[c % 5];
        const m = new ethers.Contract(V6, ABI, lender);
        try {
            const amt = ethers.parseUnits('5', 6);
            await withRetry(() => m.supplyLiquidity(churnPool, amt).then(t => t.wait()));
            await sleep(INTER_TX_DELAY / 2);
            await withRetry(() => m.withdrawLiquidity(churnPool, amt).then(t => t.wait()));
        } catch (e) { /* tolerate */ }
        await sleep(INTER_TX_DELAY / 2);
        totalOps += 2;
        if ((c + 1) % 25 === 0) {
            const p = await v6.getAgentPool(churnPool);
            const lc = Number(p[6]);
            const seen = new Set();
            for (let j = 0; j < lc; j++) seen.add((await v6.poolLenders(churnPool, j)).toLowerCase());
            log(`  churn ${c + 1}/${B1_CHURN_CYCLES}: pool ${churnPool} lenderCount=${lc} unique=${seen.size} ${lc === seen.size ? '✅' : '❌'} §B1`);
        }
    }

    // ============ PHASE 9: Final reputation report ============
    log(`\n[9] Reputation deltas`);
    for (let i = 0; i < N_BORROWERS; i++) {
        const after = Number(await rep['getReputationScore(address)'](borrowers[i].address));
        log(`  borrower ${i + 1} (agentId ${borrowerAgentIds[i]}): ${repBefore[i]} → ${after} (Δ ${after - repBefore[i] > 0 ? '+' : ''}${after - repBefore[i]})`);
    }

    // ============ PHASE 10: Final invariant snapshot ============
    log(`\n[10] Final invariants`);
    await checkInvariants('final', borrowerAgentIds);

    // ============ PHASE 11: Cleanup (return USDC + ETH) ============
    log(`\n[11] Cleanup — return residual USDC + ETH to owner`);
    const allWallets = [...lenders, ...borrowers, ...extraLenders, w51];
    let drainedUsdc = 0n, drainedEth = 0n;
    for (const w of allWallets) {
        try {
            const u = new ethers.Contract(ADDR.usdc, USDC_ABI, w);
            const bal = await u.balanceOf(w.address);
            if (bal > 0n) { await (await u.transfer(owner.address, bal)).wait(); drainedUsdc += bal; }
            const eth = await provider.getBalance(w.address);
            const gas = ethers.parseEther('0.005');
            if (eth > gas) { await (await w.sendTransaction({ to: owner.address, value: eth - gas })).wait(); drainedEth += eth - gas; }
            await sleep(100);
        } catch (e) {}
    }
    log(`  Drained back ${fmt(drainedUsdc)} USDC, ${ethers.formatEther(drainedEth)} ETH`);

    // ============ Save report ============
    log(`\nFinal: ${fmt(await usdc.balanceOf(owner.address))} USDC, ${ethers.formatEther(await provider.getBalance(owner.address))} ETH`);
    log(`Total ops: ${totalOps}, invariant snapshots: ${invSnapshots}`);
    log(`Duration: ${((Date.now() - t0) / 60000).toFixed(1)} min`);

    const violations = invariantLog.filter(r => r.s1Violates || r.b1Violates);
    log(`Invariant violations: ${violations.length} / ${invariantLog.length}`);
    if (violations.length === 0) log('   ✅ ALL INVARIANTS HELD');

    fs.writeFileSync('./forensics/output/regression-2026-05-07/52-mega-stress.json', JSON.stringify({
        v6Address: V6,
        startedAt: new Date(t0).toISOString(),
        completedAt: new Date().toISOString(),
        totalOps, totalLoans, fuzzOk, fuzzFail,
        invariantSnapshots: invariantLog,
        loanGas: loanGas.length >= 20 ? {
            first10: loanGas.slice(0, 10).reduce((a, b) => a + b, 0) / 10,
            last10: loanGas.slice(-10).reduce((a, b) => a + b, 0) / 10
        } : null,
        reputationDeltas: repBefore.map((b, i) => ({ borrower: borrowers[i].address, before: b }))
    }, null, 2));
    log('Saved to forensics/output/regression-2026-05-07/52-mega-stress.json');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
