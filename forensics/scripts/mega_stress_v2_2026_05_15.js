// Mega Stress v2 — bigger than any prior run.
//
//   20 lenders × 5,000 USDC × 10 pools = 1M USDC supplied
//   10 borrowers × 100 cycles = 1,000 loan/repay cycles
//   MAX_LENDERS=50 cap tested on 2 different pools
//   300 random fuzz ops + 100 §B1 high-churn cycles
//   Event-based loanId (fixed from suite 3 Test B)
//   Robust retry wrapping .wait() calls

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const REG_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')).abi;
const USDC_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'];
const fmt = v => Number(ethers.formatUnits(v, 6));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const N_LENDERS = 20;
const N_BORROWERS = 10;
const LOANS_PER_BORROWER = 100;
const SUPPLY_PER_LENDER = ethers.parseUnits('5000', 6);
const LOAN_AMT = ethers.parseUnits('10', 6);
const DURATIONS = [7, 30, 90, 180, 365];
const FUND_ETH = ethers.parseEther('3.0');
const FUND_USDC_LENDER = ethers.parseUnits('5050', 6);
const FUND_USDC_BORROWER = ethers.parseUnits('1000', 6);
const INTER_TX_DELAY = 600;
const RANDOM_FUZZ_OPS = 300;
const B1_CHURN_CYCLES = 100;
const MAX_LENDERS = 50;

async function withRetry(fn, attempts = 25) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const m = (e.shortMessage || e.message || '').toLowerCase();
            const isRate = m.includes('rate') || m.includes('408') || m.includes('410') || m.includes('429') || m.includes('502') || m.includes('503') || m.includes('-32016') || m.includes('timeout') || m.includes('server response') || m.includes('missing revert data') || m.includes('econnreset') || m.includes('socket hang up') || m.includes('network');
            if (i === attempts - 1 || !isRate) throw e;
            await sleep(Math.min(2500 * Math.pow(1.6, i), 90000));
        }
    }
}

process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection caught]:', (reason && reason.shortMessage) || (reason && reason.message) || reason);
});

const log = (...a) => { const line = a.join(' '); console.log(line); };
const fmtMaybe = (e, fb = 'error') => { try { return (e.shortMessage || e.message || fb).slice(0, 100); } catch { return fb; } };

// Helper: pull the LoanRequested loanId out of a tx receipt (event-based, race-safe)
function extractLoanId(receipt, contractIface) {
    for (const log of receipt.logs || []) {
        try {
            const parsed = contractIface.parseLog({ topics: log.topics, data: log.data });
            if (parsed && parsed.name === 'LoanRequested') return parsed.args.loanId;
        } catch (e) {}
    }
    return null;
}

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const v6 = new ethers.Contract(V6, ABI, owner);
    const reg = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, owner);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);

    const t0 = Date.now();
    log('========================================================================');
    log('   MEGA STRESS V2 — Arc V6 post-fix');
    log('========================================================================');
    log('Owner:', owner.address);
    log('Start:', ethers.formatEther(await provider.getBalance(owner.address)), 'ETH,', fmt(await usdc.balanceOf(owner.address)), 'USDC');

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
        const result = { ts: Date.now(), label, sumAvail: fmt(sumAvail), sumLoaned: fmt(sumLoaned), mpBal: fmt(mpBal), slack: fmt(mpBal - sumAvail), s1Violates, b1Violates, dupViolations: dupViolations.length };
        invariantLog.push(result);
        const tag = s1Violates || b1Violates ? '❌' : '✅';
        log(`  ${tag} [${label}] §B1 ${b1Violates ? 'VIOLATED:' + JSON.stringify(dupViolations) : 'OK'}, §S1 ${s1Violates ? 'VIOLATED' : 'OK'} (Σavail=${result.sumAvail}, mpBal=${result.mpBal}, slack=${result.slack})`);
        return result;
    }

    // ============ PHASE 1: Generate + persist wallets ============
    log('\n[1] Generate', N_LENDERS, 'lenders +', N_BORROWERS, 'borrowers');
    const lenders = [];
    const borrowers = [];
    for (let i = 0; i < N_LENDERS; i++) lenders.push(ethers.Wallet.createRandom().connect(provider));
    for (let i = 0; i < N_BORROWERS; i++) borrowers.push(ethers.Wallet.createRandom().connect(provider));
    fs.writeFileSync('./forensics/output/regression-2026-05-07/73-mega-v2-wallets.json', JSON.stringify({
        startedAt: new Date().toISOString(),
        lenders: lenders.map(w => ({ addr: w.address, key: w.privateKey })),
        borrowers: borrowers.map(w => ({ addr: w.address, key: w.privateKey }))
    }, null, 2));
    log('  generated', lenders.length + borrowers.length, 'wallets (persisted)');

    // ============ PHASE 2: Fund ============
    log('\n[2] Fund wallets');
    for (const w of lenders) {
        await withRetry(() => owner.sendTransaction({ to: w.address, value: FUND_ETH }).then(t => withRetry(() => t.wait())));
        await withRetry(() => usdc.transfer(w.address, FUND_USDC_LENDER).then(t => withRetry(() => t.wait())));
        await sleep(INTER_TX_DELAY); totalOps += 2;
    }
    for (const w of borrowers) {
        await withRetry(() => owner.sendTransaction({ to: w.address, value: FUND_ETH }).then(t => withRetry(() => t.wait())));
        await withRetry(() => usdc.transfer(w.address, FUND_USDC_BORROWER).then(t => withRetry(() => t.wait())));
        await sleep(INTER_TX_DELAY); totalOps += 2;
    }
    log('  funded', lenders.length + borrowers.length, 'wallets');

    // ============ PHASE 3: Register + create pools + approve MaxUint256 ============
    log('\n[3] Register borrowers + create pools, approve MaxUint256');
    const borrowerAgentIds = [];
    for (let i = 0; i < N_BORROWERS; i++) {
        const r = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, borrowers[i]);
        const m = new ethers.Contract(V6, ABI, borrowers[i]);
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, borrowers[i]);
        await withRetry(() => r.register(`ipfs://mega2-borrower-${i}-${Date.now()}`, []).then(t => withRetry(() => t.wait())));
        const aid = await withRetry(() => reg.addressToAgentId(borrowers[i].address));
        borrowerAgentIds.push(Number(aid));
        await withRetry(() => m.createAgentPool().then(t => withRetry(() => t.wait())));
        await withRetry(() => u.approve(V6, ethers.MaxUint256).then(t => withRetry(() => t.wait())));
        log(`  borrower ${i + 1}: agentId=${aid}`);
        await sleep(INTER_TX_DELAY); totalOps += 3;
    }

    // ============ PHASE 4: Supply ============
    log(`\n[4] Each lender supplies ${fmt(SUPPLY_PER_LENDER) / N_BORROWERS} USDC to each pool`);
    const SUPPLY_PER_POOL = SUPPLY_PER_LENDER / BigInt(N_BORROWERS);
    log(`  ${fmt(SUPPLY_PER_POOL).toFixed(2)} USDC × ${N_BORROWERS} pools × ${N_LENDERS} lenders`);
    for (let i = 0; i < N_LENDERS; i++) {
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, lenders[i]);
        const m = new ethers.Contract(V6, ABI, lenders[i]);
        await withRetry(() => u.approve(V6, ethers.MaxUint256).then(t => withRetry(() => t.wait())));
        for (const aid of borrowerAgentIds) {
            await withRetry(() => m.supplyLiquidity(aid, SUPPLY_PER_POOL).then(t => withRetry(() => t.wait())));
            await sleep(INTER_TX_DELAY); totalOps++;
        }
        if ((i + 1) % 5 === 0) log(`  ${i + 1}/${N_LENDERS} lenders supplied`);
    }
    await checkInvariants('post-supply', borrowerAgentIds);

    // ============ PHASE 5: MAX_LENDERS=50 boundary on TWO pools ============
    log(`\n[5] MAX_LENDERS=${MAX_LENDERS} boundary tests on 2 pools`);
    const capExtras = [];
    const extrasFile = './forensics/output/regression-2026-05-07/73-mega-v2-extras.json';
    for (const targetIdx of [0, 1]) {
        const pool = borrowerAgentIds[targetIdx];
        log(`  Filling pool ${pool} from ${N_LENDERS} → ${MAX_LENDERS} lenders`);
        const extras = [];
        for (let i = 0; i < MAX_LENDERS - N_LENDERS; i++) extras.push(ethers.Wallet.createRandom().connect(provider));
        capExtras.push(...extras);
        fs.writeFileSync(extrasFile, JSON.stringify({ extras: capExtras.map(w => ({ addr: w.address, key: w.privateKey })) }, null, 2));
        for (let i = 0; i < extras.length; i++) {
            const w = extras[i];
            await withRetry(() => owner.sendTransaction({ to: w.address, value: ethers.parseEther('0.05') }).then(t => withRetry(() => t.wait())));
            await withRetry(() => usdc.transfer(w.address, ethers.parseUnits('20', 6)).then(t => withRetry(() => t.wait())));
            const u = new ethers.Contract(ADDR.usdc, USDC_ABI, w);
            const m = new ethers.Contract(V6, ABI, w);
            await withRetry(() => u.approve(V6, ethers.MaxUint256).then(t => withRetry(() => t.wait())));
            await withRetry(() => m.supplyLiquidity(pool, ethers.parseUnits('10', 6)).then(t => withRetry(() => t.wait())));
            if ((i + 1) % 10 === 0) log(`    extras ${i + 1}/${extras.length} → pool ${pool}`);
            await sleep(INTER_TX_DELAY); totalOps += 4;
        }
        // Cap test
        const w51 = ethers.Wallet.createRandom().connect(provider);
        capExtras.push(w51);
        fs.writeFileSync(extrasFile, JSON.stringify({ extras: capExtras.map(w => ({ addr: w.address, key: w.privateKey })) }, null, 2));
        await withRetry(() => owner.sendTransaction({ to: w51.address, value: ethers.parseEther('0.05') }).then(t => withRetry(() => t.wait())));
        await withRetry(() => usdc.transfer(w51.address, ethers.parseUnits('20', 6)).then(t => withRetry(() => t.wait())));
        const u51 = new ethers.Contract(ADDR.usdc, USDC_ABI, w51);
        const m51 = new ethers.Contract(V6, ABI, w51);
        await withRetry(() => u51.approve(V6, ethers.MaxUint256).then(t => withRetry(() => t.wait())));
        let rejected = false;
        try {
            await (await m51.supplyLiquidity(pool, ethers.parseUnits('10', 6))).wait();
        } catch (e) {
            rejected = true;
            log(`  ✓ Pool ${pool} 51st REJECTED: "${fmtMaybe(e)}"`);
        }
        if (!rejected) log(`  ✗ Pool ${pool} 51st ADMITTED — BUG!`);
        totalOps += 4;
    }
    await checkInvariants('post-boundary-2x', borrowerAgentIds);

    // ============ PHASE 6: 1000 loan cycles, mixed durations, event-based loanId ============
    log(`\n[6] ${LOANS_PER_BORROWER} cycles × ${N_BORROWERS} borrowers = ${LOANS_PER_BORROWER * N_BORROWERS} loans`);
    let totalLoans = 0;
    const loanGas = [];
    for (let cycle = 0; cycle < LOANS_PER_BORROWER; cycle++) {
        const duration = DURATIONS[cycle % DURATIONS.length];
        for (let i = 0; i < N_BORROWERS; i++) {
            const m = new ethers.Contract(V6, ABI, borrowers[i]);
            try {
                const t1 = await withRetry(() => m.requestLoan(LOAN_AMT, duration));
                const r1 = await withRetry(() => t1.wait());
                loanGas.push(Number(r1.gasUsed));
                const loanId = extractLoanId(r1, m.interface);
                if (loanId === null) throw new Error('LoanRequested event not found in receipt');
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
                        await withRetry(() => m.claimInterest(aid).then(t => withRetry(() => t.wait())));
                        await sleep(INTER_TX_DELAY); totalOps++;
                    } catch (e) {}
                }
            }
        }
        if ((cycle + 1) % 20 === 0) {
            log(`  cycle ${cycle + 1}/${LOANS_PER_BORROWER}: ${totalLoans} loans done`);
            await checkInvariants(`cycle-${cycle + 1}`, borrowerAgentIds);
        }
    }
    log(`  Total loans: ${totalLoans}/${LOANS_PER_BORROWER * N_BORROWERS}`);
    if (loanGas.length >= 20) {
        const f10 = loanGas.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
        const l10 = loanGas.slice(-10).reduce((a, b) => a + b, 0) / 10;
        log(`  Loan gas: first10=${f10.toFixed(0)}, last10=${l10.toFixed(0)}, ratio=${(l10 / f10).toFixed(3)} ${l10 <= f10 * 1.05 ? '✅' : '❌'} §S5`);
    }

    // ============ PHASE 7: Random fuzz ============
    log(`\n[7] Random op fuzz: ${RANDOM_FUZZ_OPS} ops`);
    const opTypes = ['supply', 'withdraw', 'requestLoan', 'repayLoan', 'claim'];
    const actorPool = [...lenders.slice(0, 10), ...borrowers.slice(0, 5)];
    const activeLoans = {};
    let fuzzOk = 0, fuzzFail = 0;
    for (let i = 0; i < RANDOM_FUZZ_OPS; i++) {
        const actor = actorPool[Math.floor(Math.random() * actorPool.length)];
        const aid = borrowerAgentIds[Math.floor(Math.random() * borrowerAgentIds.length)];
        const op = opTypes[Math.floor(Math.random() * opTypes.length)];
        const m = new ethers.Contract(V6, ABI, actor);
        try {
            if (op === 'supply') {
                await withRetry(() => m.supplyLiquidity(aid, ethers.parseUnits(String(Math.ceil(Math.random() * 50)), 6)).then(t => withRetry(() => t.wait())));
            } else if (op === 'withdraw') {
                const pos = await v6.positions(aid, actor.address);
                if (pos.amount > 0n) await withRetry(() => m.withdrawLiquidity(aid, pos.amount / 2n).then(t => withRetry(() => t.wait())));
            } else if (op === 'requestLoan') {
                const t = await withRetry(() => m.requestLoan(ethers.parseUnits(String(Math.ceil(Math.random() * 20)), 6), DURATIONS[Math.floor(Math.random() * DURATIONS.length)]));
                const r = await withRetry(() => t.wait());
                const lid = extractLoanId(r, m.interface);
                if (lid !== null) {
                    if (!activeLoans[actor.address]) activeLoans[actor.address] = [];
                    activeLoans[actor.address].push(Number(lid));
                }
            } else if (op === 'repayLoan') {
                const arr = activeLoans[actor.address];
                if (arr && arr.length) {
                    const lid = arr.pop();
                    await withRetry(() => m.repayLoan(lid).then(t => withRetry(() => t.wait())));
                }
            } else if (op === 'claim') {
                await withRetry(() => m.claimInterest(aid).then(t => withRetry(() => t.wait())));
            }
            fuzzOk++;
        } catch (e) { fuzzFail++; }
        await sleep(INTER_TX_DELAY / 2);
        totalOps++;
        if ((i + 1) % 50 === 0) {
            log(`  ${i + 1}/${RANDOM_FUZZ_OPS}: ok=${fuzzOk} fail=${fuzzFail}`);
            await checkInvariants(`fuzz-${i + 1}`, borrowerAgentIds);
        }
    }
    log(`  Fuzz done: ${fuzzOk} ok, ${fuzzFail} fail`);

    // ============ PHASE 8: §B1 churn ============
    log(`\n[8] §B1 high-churn: ${B1_CHURN_CYCLES} supply→withdraw cycles by 5 lenders on pool ${borrowerAgentIds[2]}`);
    const churnPool = borrowerAgentIds[2];
    for (let c = 0; c < B1_CHURN_CYCLES; c++) {
        const lender = lenders[c % 5];
        const m = new ethers.Contract(V6, ABI, lender);
        try {
            const amt = ethers.parseUnits('5', 6);
            await withRetry(() => m.supplyLiquidity(churnPool, amt).then(t => withRetry(() => t.wait())));
            await sleep(INTER_TX_DELAY / 2);
            await withRetry(() => m.withdrawLiquidity(churnPool, amt).then(t => withRetry(() => t.wait())));
        } catch (e) {}
        await sleep(INTER_TX_DELAY / 2);
        totalOps += 2;
        if ((c + 1) % 25 === 0) {
            const p = await v6.getAgentPool(churnPool);
            const lc = Number(p[6]);
            const seen = new Set();
            for (let j = 0; j < lc; j++) seen.add((await v6.poolLenders(churnPool, j)).toLowerCase());
            log(`  churn ${c + 1}/${B1_CHURN_CYCLES}: pool ${churnPool} lc=${lc} unique=${seen.size} ${lc === seen.size ? '✅' : '❌'} §B1`);
        }
    }

    // ============ PHASE 9: Final invariants ============
    log(`\n[9] Final invariants across all ${borrowerAgentIds.length} pools`);
    await checkInvariants('final', borrowerAgentIds);

    // ============ PHASE 10: Cleanup ============
    log(`\n[10] Cleanup`);
    const allWallets = [...lenders, ...borrowers, ...capExtras];
    let drainedU = 0n, drainedE = 0n;
    for (const w of allWallets) {
        try {
            const u = new ethers.Contract(ADDR.usdc, USDC_ABI, w);
            const bal = await u.balanceOf(w.address);
            if (bal > 0n) { await (await u.transfer(owner.address, bal)).wait(); drainedU += bal; }
            const eth = await provider.getBalance(w.address);
            const gas = ethers.parseEther('0.005');
            if (eth > gas) { await (await w.sendTransaction({ to: owner.address, value: eth - gas })).wait(); drainedE += eth - gas; }
        } catch (e) {}
        await sleep(50);
    }
    log(`  Drained ${fmt(drainedU)} USDC, ${ethers.formatEther(drainedE)} ETH`);

    // ============ Save ============
    log(`\nFinal: ${fmt(await usdc.balanceOf(owner.address))} USDC, ${ethers.formatEther(await provider.getBalance(owner.address))} ETH`);
    log(`Total ops: ${totalOps}, invariant snapshots: ${invSnapshots}`);
    log(`Duration: ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    const violations = invariantLog.filter(r => r.s1Violates || r.b1Violates);
    log(`Invariant violations: ${violations.length} / ${invariantLog.length}`);
    if (violations.length === 0) log('   ✅ ALL INVARIANTS HELD');

    fs.writeFileSync('./forensics/output/regression-2026-05-07/73-mega-v2.json', JSON.stringify({
        v6Address: V6, startedAt: new Date(t0).toISOString(), completedAt: new Date().toISOString(),
        totalOps, totalLoans, fuzzOk, fuzzFail,
        invariantSnapshots: invariantLog,
        loanGas: loanGas.length >= 20 ? { first10: loanGas.slice(0, 10).reduce((a, b) => a + b, 0) / 10, last10: loanGas.slice(-10).reduce((a, b) => a + b, 0) / 10 } : null
    }, null, 2));
    log('Saved.');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
