// Multi-pool concurrent burst: 10 borrowers + 5 lenders, concurrent Promise.all bursts.
// Tests concurrent state manipulation rather than the sequential round-robin pattern.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const REG_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')).abi;
const USDC_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];
const fmt = v => Number(ethers.formatUnits(v, 6));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const N_BORROWERS = 10, N_LENDERS = 5, N_BURSTS = 10;

async function withRetry(fn, attempts = 20) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const m = (e.shortMessage || e.message || '').toLowerCase();
            const isRate = m.includes('rate') || m.includes('408') || m.includes('429') || m.includes('-32016') || m.includes('timeout') || m.includes('server response') || m.includes('econnreset');
            if (i === attempts - 1 || !isRate) throw e;
            await sleep(Math.min(2000 * Math.pow(1.5, i), 30000));
        }
    }
}
const log = (...a) => console.log(...a);

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const reg = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, owner);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);
    const v6 = new ethers.Contract(V6, ABI, owner);

    log('=== MULTI-POOL CONCURRENT BURST ===');

    // Generate + fund
    const borrowers = Array.from({ length: N_BORROWERS }, () => ethers.Wallet.createRandom().connect(provider));
    const lenders = Array.from({ length: N_LENDERS }, () => ethers.Wallet.createRandom().connect(provider));
    fs.writeFileSync('./forensics/output/regression-2026-05-07/60-concurrent-wallets.json',
        JSON.stringify({ borrowers: borrowers.map(w => ({ a: w.address, k: w.privateKey })), lenders: lenders.map(w => ({ a: w.address, k: w.privateKey })) }, null, 2));
    log(`[1] Generated ${N_BORROWERS} borrowers + ${N_LENDERS} lenders`);

    log('[2] Funding (sequential, to avoid nonce collisions on owner)');
    for (const w of [...lenders, ...borrowers]) {
        await withRetry(() => owner.sendTransaction({ to: w.address, value: ethers.parseEther('0.3') }).then(t => t.wait()));
    }
    for (const w of lenders) await withRetry(() => usdc.transfer(w.address, ethers.parseUnits('2000', 6)).then(t => t.wait()));
    for (const w of borrowers) await withRetry(() => usdc.transfer(w.address, ethers.parseUnits('100', 6)).then(t => t.wait()));

    log('[3] Register borrowers + create pools (CONCURRENT)');
    const registerResults = await Promise.allSettled(borrowers.map(async (b, i) => {
        const r = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, b);
        const m = new ethers.Contract(V6, ABI, b);
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, b);
        await withRetry(() => r.register(`ipfs://concurrent-${i}-${Date.now()}`, []).then(t => t.wait()));
        const aid = Number(await reg.addressToAgentId(b.address));
        await withRetry(() => m.createAgentPool().then(t => t.wait()));
        await withRetry(() => u.approve(V6, ethers.MaxUint256).then(t => t.wait()));
        return aid;
    }));
    const borrowerAgentIds = registerResults.map(r => r.status === 'fulfilled' ? r.value : null).filter(Boolean);
    log(`  Registered ${borrowerAgentIds.length}/${N_BORROWERS} borrowers concurrently`);

    log('[4] Lenders approve V6 (concurrent)');
    await Promise.allSettled(lenders.map(async l => {
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, l);
        await withRetry(() => u.approve(V6, ethers.MaxUint256).then(t => t.wait()));
    }));

    log('[5] Concurrent supply burst: 5 lenders × 10 pools = 50 supply tx in parallel');
    const supplyOps = [];
    for (const l of lenders) {
        for (const aid of borrowerAgentIds) {
            const m = new ethers.Contract(V6, ABI, l);
            supplyOps.push(withRetry(() => m.supplyLiquidity(aid, ethers.parseUnits('100', 6)).then(t => t.wait())));
        }
    }
    const supplyResults = await Promise.allSettled(supplyOps);
    const supplyOk = supplyResults.filter(r => r.status === 'fulfilled').length;
    log(`  supply ok: ${supplyOk}/${supplyOps.length}`);

    // Invariant snapshot
    let totalAvail = 0n, totalLoaned = 0n, totalLenderCount = 0;
    let dupViolations = [];
    for (const aid of borrowerAgentIds) {
        const p = await withRetry(() => v6.getAgentPool(aid));
        totalAvail += p[2]; totalLoaned += p[3]; totalLenderCount += Number(p[6]);
        const lc = Number(p[6]);
        const seen = new Set();
        for (let j = 0; j < lc; j++) {
            const l = (await withRetry(() => v6.poolLenders(aid, j))).toLowerCase();
            if (seen.has(l)) dupViolations.push({ aid, l });
            seen.add(l);
        }
    }
    const mpBal = await usdc.balanceOf(V6);
    log(`  post-supply invariants: Σavail=${fmt(totalAvail)}, dupViolations=${dupViolations.length}, §B1=${dupViolations.length === 0 ? '✅' : '❌'}`);

    log(`[6] Concurrent loan bursts × ${N_BURSTS}`);
    let totalLoans = 0, totalFails = 0;
    for (let burst = 0; burst < N_BURSTS; burst++) {
        const ops = borrowers.slice(0, borrowerAgentIds.length).map(async b => {
            const m = new ethers.Contract(V6, ABI, b);
            try {
                const t = await withRetry(() => m.requestLoan(ethers.parseUnits('5', 6), 7));
                await withRetry(() => t.wait());
                await sleep(100);
                const lid = (await v6.nextLoanId()) - 1n;
                // Note: lid here may be off due to concurrent activity. Need per-borrower active loan lookup.
                const activeLoans = await v6.agentLoans(b.address, 0);
                const t2 = await withRetry(() => m.repayLoan(activeLoans));
                await withRetry(() => t2.wait());
                return 'ok';
            } catch (e) { return 'fail:' + (e.shortMessage || e.message).slice(0, 50); }
        });
        const results = await Promise.allSettled(ops);
        const ok = results.filter(r => r.status === 'fulfilled' && r.value === 'ok').length;
        const fail = results.length - ok;
        totalLoans += ok; totalFails += fail;
        log(`  burst ${burst + 1}/${N_BURSTS}: ${ok} ok, ${fail} fail`);
    }

    // Final invariant snapshot
    totalAvail = 0n; dupViolations = [];
    for (const aid of borrowerAgentIds) {
        const p = await withRetry(() => v6.getAgentPool(aid));
        totalAvail += p[2];
        const lc = Number(p[6]);
        const seen = new Set();
        for (let j = 0; j < lc; j++) {
            const l = (await withRetry(() => v6.poolLenders(aid, j))).toLowerCase();
            if (seen.has(l)) dupViolations.push({ aid, l });
            seen.add(l);
        }
    }
    const finalMpBal = await usdc.balanceOf(V6);
    log(`\n=== RESULTS ===`);
    log(`Total loan ops attempted: ${N_BORROWERS * N_BURSTS}, ok: ${totalLoans}, fail: ${totalFails}`);
    log(`Final §B1 dupViolations: ${dupViolations.length} ${dupViolations.length === 0 ? '✅' : '❌'}`);
    log(`Final Σavail (across our 10 pools): ${fmt(totalAvail)} USDC`);
    log(`Final V6 USDC balance: ${fmt(finalMpBal)} USDC`);

    // Recover: lenders withdraw
    log('\n[7] Cleanup: lenders withdraw all positions, drain to owner');
    for (const l of lenders) {
        for (const aid of borrowerAgentIds) {
            try {
                const pos = await v6.positions(aid, l.address);
                if (pos.amount > 0n) {
                    const m = new ethers.Contract(V6, ABI, l);
                    await withRetry(() => m.withdrawLiquidity(aid, pos.amount).then(t => t.wait()));
                }
            } catch (e) {}
        }
        try {
            const u = new ethers.Contract(ADDR.usdc, USDC_ABI, l);
            const bal = await usdc.balanceOf(l.address);
            if (bal > 0n) await (await u.transfer(owner.address, bal)).wait();
        } catch (e) {}
    }
    for (const b of borrowers) {
        try {
            const u = new ethers.Contract(ADDR.usdc, USDC_ABI, b);
            const bal = await usdc.balanceOf(b.address);
            if (bal > 0n) await (await u.transfer(owner.address, bal)).wait();
        } catch (e) {}
    }
    log('Cleanup done.');

    fs.writeFileSync('./forensics/output/regression-2026-05-07/60-concurrent.json', JSON.stringify({
        timestamp: new Date().toISOString(), nBorrowers: borrowerAgentIds.length, nLenders: N_LENDERS, nBursts: N_BURSTS,
        supplyOk, totalLoans, totalFails, finalDupViolations: dupViolations.length, finalMpBal: finalMpBal.toString()
    }, null, 2));
    log('Saved.');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
