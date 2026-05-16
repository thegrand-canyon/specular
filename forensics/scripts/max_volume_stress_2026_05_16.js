// Max-volume stress: 5.7M USDC throughput in ~415 ops.
// Higher amounts per op, lower op count → stays within RPC budget while maximizing $ volume.

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

const N_LENDERS = 5;
const N_BORROWERS = 5;
const SUPPLY_PER_LENDER = ethers.parseUnits('100000', 6); // 100k per lender, 500k total
const CHURN_AMT = ethers.parseUnits('50000', 6); // 50k per churn cycle
const CHURN_CYCLES_PER_LENDER = 10;
const LOAN_CYCLES_PER_BORROWER = 20;
const LOAN_AMT = ethers.parseUnits('500', 6);
const FUND_ETH = ethers.parseEther('2.0');
const FUND_USDC_LENDER = ethers.parseUnits('160000', 6); // 100k supply + 60k churn buffer (50k cycle + safety)
const FUND_USDC_BORROWER = ethers.parseUnits('1500', 6);
const INTER_TX_DELAY = 700;

async function withRetry(fn, attempts = 20) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const m = (e.shortMessage || e.message || '').toLowerCase();
            const isRate = m.includes('rate') || m.includes('408') || m.includes('410') || m.includes('429') || m.includes('502') || m.includes('503') || m.includes('-32016') || m.includes('timeout') || m.includes('server response') || m.includes('missing revert data') || m.includes('econnreset') || m.includes('socket hang up') || m.includes('network');
            if (i === attempts - 1 || !isRate) throw e;
            await sleep(Math.min(2500 * Math.pow(1.5, i), 60000));
        }
    }
}

process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]:', (reason && reason.shortMessage) || (reason && reason.message) || reason);
});

const log = (...a) => console.log(...a);
const fmtMaybe = (e, fb = 'error') => { try { return (e.shortMessage || e.message || fb).slice(0, 80); } catch { return fb; } };
function extractLoanId(receipt, contractIface) {
    for (const log of receipt.logs || []) {
        try {
            const p = contractIface.parseLog({ topics: log.topics, data: log.data });
            if (p && p.name === 'LoanRequested') return p.args.loanId;
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
    log('======================================================================');
    log('   MAX VOLUME STRESS — Arc V6 (target: ~5.7M USDC throughput)');
    log('======================================================================');
    const startUsdc = await usdc.balanceOf(owner.address);
    const startEth = await provider.getBalance(owner.address);
    log('Master start:', fmt(startUsdc), 'USDC,', ethers.formatEther(startEth), 'ETH');

    const invariantLog = [];
    let totalOps = 0;
    let volumeMoved = 0n;

    async function checkInvariants(label, poolIds) {
        let sumAvail = 0n;
        const dups = [];
        for (const aid of poolIds) {
            const p = await withRetry(() => v6.getAgentPool(aid));
            sumAvail += p[2];
            const lc = Number(p[6]);
            const seen = new Set();
            for (let j = 0; j < lc; j++) {
                const l = (await withRetry(() => v6.poolLenders(aid, j))).toLowerCase();
                if (seen.has(l)) dups.push({ aid, l });
                seen.add(l);
            }
        }
        const mpBal = await withRetry(() => usdc.balanceOf(V6));
        const s1 = sumAvail > mpBal;
        const b1 = dups.length > 0;
        const result = { label, sumAvail: fmt(sumAvail), mpBal: fmt(mpBal), s1, b1, dupsCount: dups.length };
        invariantLog.push(result);
        const tag = s1 || b1 ? '❌' : '✅';
        log(`  ${tag} [${label}] §B1 ${b1 ? 'VIOLATED' : 'OK'}, §S1 ${s1 ? 'VIOLATED' : 'OK'} (Σavail=${result.sumAvail}, mpBal=${result.mpBal}, dups=${result.dupsCount})`);
    }

    // ============ PHASE 1: Generate + persist ============
    log('\n[1] Generate + persist wallets');
    const lenders = [];
    const borrowers = [];
    for (let i = 0; i < N_LENDERS; i++) lenders.push(ethers.Wallet.createRandom().connect(provider));
    for (let i = 0; i < N_BORROWERS; i++) borrowers.push(ethers.Wallet.createRandom().connect(provider));
    fs.writeFileSync('./forensics/output/regression-2026-05-07/79-maxvol-wallets.json', JSON.stringify({
        startedAt: new Date().toISOString(),
        lenders: lenders.map(w => ({ addr: w.address, key: w.privateKey })),
        borrowers: borrowers.map(w => ({ addr: w.address, key: w.privateKey }))
    }, null, 2));
    log(`  generated ${N_LENDERS + N_BORROWERS} wallets`);

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
    log(`  funded ${N_LENDERS} lenders × ${fmt(FUND_USDC_LENDER)} USDC + ${N_BORROWERS} borrowers × ${fmt(FUND_USDC_BORROWER)}`);

    // ============ PHASE 3: Register + create pools ============
    log('\n[3] Register borrowers, create pools, approve MaxUint256');
    const borrowerAgentIds = [];
    for (let i = 0; i < N_BORROWERS; i++) {
        const r = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, borrowers[i]);
        const m = new ethers.Contract(V6, ABI, borrowers[i]);
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, borrowers[i]);
        await withRetry(() => r.register(`ipfs://maxvol-${i}-${Date.now()}`, []).then(t => withRetry(() => t.wait())));
        const aid = await withRetry(() => reg.addressToAgentId(borrowers[i].address));
        borrowerAgentIds.push(Number(aid));
        await withRetry(() => m.createAgentPool().then(t => withRetry(() => t.wait())));
        await withRetry(() => u.approve(V6, ethers.MaxUint256).then(t => withRetry(() => t.wait())));
        log(`  borrower ${i + 1}: aid=${aid}`);
        await sleep(INTER_TX_DELAY); totalOps += 3;
    }

    // ============ PHASE 4: Initial supply ============
    log('\n[4] Initial supply: each lender → all 5 pools (20k each, 100k per lender)');
    const SUPPLY_PER_POOL = SUPPLY_PER_LENDER / BigInt(N_BORROWERS);
    for (let i = 0; i < N_LENDERS; i++) {
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, lenders[i]);
        const m = new ethers.Contract(V6, ABI, lenders[i]);
        await withRetry(() => u.approve(V6, ethers.MaxUint256).then(t => withRetry(() => t.wait())));
        for (const aid of borrowerAgentIds) {
            await withRetry(() => m.supplyLiquidity(aid, SUPPLY_PER_POOL).then(t => withRetry(() => t.wait())));
            volumeMoved += SUPPLY_PER_POOL;
            await sleep(INTER_TX_DELAY); totalOps++;
        }
        log(`  lender ${i + 1}: 5×${fmt(SUPPLY_PER_POOL)} = ${fmt(SUPPLY_PER_LENDER)} USDC supplied`);
    }
    await checkInvariants('post-supply-500k', borrowerAgentIds);
    log(`  cumulative volume moved: ${fmt(volumeMoved)} USDC`);

    // ============ PHASE 5: §B1 high-volume churn ============
    log(`\n[5] §B1 high-volume churn: each lender does ${CHURN_CYCLES_PER_LENDER} cycles of ${fmt(CHURN_AMT)} on pool ${borrowerAgentIds[0]}`);
    const churnPool = borrowerAgentIds[0];
    for (let i = 0; i < N_LENDERS; i++) {
        const m = new ethers.Contract(V6, ABI, lenders[i]);
        for (let c = 0; c < CHURN_CYCLES_PER_LENDER; c++) {
            try {
                await withRetry(() => m.supplyLiquidity(churnPool, CHURN_AMT).then(t => withRetry(() => t.wait())));
                volumeMoved += CHURN_AMT;
                await sleep(INTER_TX_DELAY / 2);
                await withRetry(() => m.withdrawLiquidity(churnPool, CHURN_AMT).then(t => withRetry(() => t.wait())));
                volumeMoved += CHURN_AMT;
                totalOps += 2;
            } catch (e) {
                log(`    L${i + 1} c${c + 1}: ${fmtMaybe(e)}`);
            }
            await sleep(INTER_TX_DELAY / 2);
        }
        log(`  lender ${i + 1} done: ${CHURN_CYCLES_PER_LENDER} cycles, cumulative volume=${fmt(volumeMoved)}`);
    }
    await checkInvariants('post-churn-5M', borrowerAgentIds);

    // ============ PHASE 6: Loan cycles ============
    log(`\n[6] Loan cycles: ${N_BORROWERS} borrowers × ${LOAN_CYCLES_PER_BORROWER} cycles × ${fmt(LOAN_AMT)} USDC`);
    let totalLoans = 0;
    for (let cycle = 0; cycle < LOAN_CYCLES_PER_BORROWER; cycle++) {
        for (let i = 0; i < N_BORROWERS; i++) {
            const m = new ethers.Contract(V6, ABI, borrowers[i]);
            try {
                const t1 = await withRetry(() => m.requestLoan(LOAN_AMT, 7));
                const r1 = await withRetry(() => t1.wait());
                const loanId = extractLoanId(r1, m.interface);
                volumeMoved += LOAN_AMT;
                await sleep(INTER_TX_DELAY / 2);
                const t2 = await withRetry(() => m.repayLoan(loanId));
                await withRetry(() => t2.wait());
                volumeMoved += LOAN_AMT;
                totalLoans++;
                totalOps += 2;
            } catch (e) {
                log(`    cycle ${cycle + 1} borrower ${i + 1}: ${fmtMaybe(e)}`);
            }
            await sleep(INTER_TX_DELAY / 2);
        }
        if ((cycle + 1) % 5 === 0) {
            log(`  cycle ${cycle + 1}/${LOAN_CYCLES_PER_BORROWER}: ${totalLoans} loans done, volume=${fmt(volumeMoved)}`);
            await checkInvariants(`loan-cycle-${cycle + 1}`, borrowerAgentIds);
        }
    }

    // ============ PHASE 7: Claims ============
    log(`\n[7] Lenders claim interest from all pools`);
    let totalClaimed = 0n;
    for (let i = 0; i < N_LENDERS; i++) {
        const m = new ethers.Contract(V6, ABI, lenders[i]);
        for (const aid of borrowerAgentIds) {
            try {
                const pos = await v6.positions(aid, lenders[i].address);
                if (pos.earnedInterest > 0n) {
                    await withRetry(() => m.claimInterest(aid).then(t => withRetry(() => t.wait())));
                    totalClaimed += pos.earnedInterest;
                    volumeMoved += pos.earnedInterest;
                    totalOps++;
                }
            } catch (e) {}
            await sleep(INTER_TX_DELAY / 2);
        }
    }
    log(`  total interest claimed: ${fmt(totalClaimed)} USDC`);
    await checkInvariants('post-claims', borrowerAgentIds);

    // ============ PHASE 8: Cleanup ============
    log(`\n[8] Cleanup — withdraw all lender positions, drain residuals`);
    for (const lender of lenders) {
        for (const aid of borrowerAgentIds) {
            try {
                const pos = await v6.positions(aid, lender.address);
                if (pos.amount > 0n) {
                    const pool = await v6.getAgentPool(aid);
                    const withdrawable = pos.amount < pool[2] ? pos.amount : pool[2];
                    if (withdrawable > 0n) {
                        const m = new ethers.Contract(V6, ABI, lender);
                        await withRetry(() => m.withdrawLiquidity(aid, withdrawable).then(t => withRetry(() => t.wait())));
                    }
                }
            } catch (e) {}
            await sleep(200);
        }
    }
    let drainedU = 0n;
    for (const w of [...lenders, ...borrowers]) {
        try {
            const u = new ethers.Contract(ADDR.usdc, USDC_ABI, w);
            const bal = await usdc.balanceOf(w.address);
            if (bal > 0n) { await (await u.transfer(owner.address, bal)).wait(); drainedU += bal; }
            const eth = await provider.getBalance(w.address);
            const gas = ethers.parseEther('0.005');
            if (eth > gas) await (await w.sendTransaction({ to: owner.address, value: eth - gas })).wait();
        } catch (e) {}
        await sleep(100);
    }
    log(`  drained ${fmt(drainedU)} USDC back to master`);

    // ============ Final ============
    const endUsdc = await usdc.balanceOf(owner.address);
    const endEth = await provider.getBalance(owner.address);
    log(`\n======================================================================`);
    log(`   MAX VOLUME STRESS COMPLETE`);
    log(`======================================================================`);
    log(`Total ops: ${totalOps}`);
    log(`Total loans: ${totalLoans}`);
    log(`Cumulative USDC volume moved: ${fmt(volumeMoved)} USDC (${(fmt(volumeMoved) / 1e6).toFixed(2)}M)`);
    log(`Master USDC delta: ${fmt(endUsdc - startUsdc)} USDC (net loss = interest + fees + stranded)`);
    log(`Master ETH delta:  ${ethers.formatEther(endEth - startEth)} ETH`);
    log(`Duration: ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    const violations = invariantLog.filter(r => r.s1 || r.b1);
    log(`Invariant violations: ${violations.length} / ${invariantLog.length}`);
    if (violations.length === 0) log('   ✅ ALL INVARIANTS HELD ACROSS HIGH-VOLUME OPS');

    fs.writeFileSync('./forensics/output/regression-2026-05-07/79-maxvol-stress.json', JSON.stringify({
        v6: V6, startedAt: new Date(t0).toISOString(), completedAt: new Date().toISOString(),
        totalOps, totalLoans, volumeMoved: volumeMoved.toString(),
        masterUsdcDelta: (endUsdc - startUsdc).toString(),
        invariantSnapshots: invariantLog
    }, null, 2));
    log('Saved.');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
