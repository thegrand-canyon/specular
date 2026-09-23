// 5 borrowers all share ONE pool. Lender supplies 25k, borrowers borrow concurrently.
// Tests pool can serve multiple borrowers without state contamination.

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

// V6 has one pool per agent. Borrowing from another agent's pool requires sharing creditLimit.
// In V6, a borrower borrows from THEIR pool only — pool ID == borrower's agentId.
// To test "multi-borrower-same-pool", we need 1 lender supplying to 5 different borrowers' pools,
// then have those 5 borrowers borrow simultaneously. That's what mega_stress already did.
//
// True "multi-borrower-same-pool" isn't supported by V6's design — each borrower has their own
// pool by agentId. So this test instead does: 5 borrowers each with own pool, 1 lender supplies
// to all 5, then they all request+repay concurrently. Captures cross-pool concurrency stress.

const N_BORROWERS = 5;
const N_CYCLES = 10;

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const reg = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, owner);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);
    const v6 = new ethers.Contract(V6, ABI, owner);

    log('=== MULTI-BORROWER cross-pool concurrent stress ===');
    log('NOTE: V6 design = 1 pool per borrower. This test = 5 borrowers + 1 lender across 5 pools, concurrent activity.');

    const borrowers = Array.from({ length: N_BORROWERS }, () => ethers.Wallet.createRandom().connect(provider));
    const lender = ethers.Wallet.createRandom().connect(provider);
    fs.writeFileSync('./forensics/output/regression-2026-05-07/65-multiborrower-wallets.json', JSON.stringify({
        borrowers: borrowers.map(w => ({ addr: w.address, key: w.privateKey })),
        lender: { addr: lender.address, key: lender.privateKey }
    }, null, 2));

    log('[1] Funding');
    await withRetry(() => owner.sendTransaction({ to: lender.address, value: ethers.parseEther('0.5') }).then(t => t.wait()));
    await withRetry(() => usdc.transfer(lender.address, ethers.parseUnits('5000', 6)).then(t => t.wait()));
    for (const b of borrowers) {
        await withRetry(() => owner.sendTransaction({ to: b.address, value: ethers.parseEther('0.5') }).then(t => t.wait()));
        await withRetry(() => usdc.transfer(b.address, ethers.parseUnits('500', 6)).then(t => t.wait()));
    }

    log('[2] Register borrowers + create pools');
    const aids = [];
    for (let i = 0; i < N_BORROWERS; i++) {
        const r = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, borrowers[i]);
        const m = new ethers.Contract(V6, ABI, borrowers[i]);
        const u = new ethers.Contract(ADDR.usdc, USDC_ABI, borrowers[i]);
        await withRetry(() => r.register(`ipfs://multiborr-${i}-${Date.now()}`, []).then(t => t.wait()));
        const aid = Number(await reg.addressToAgentId(borrowers[i].address));
        aids.push(aid);
        await withRetry(() => m.createAgentPool().then(t => t.wait()));
        await withRetry(() => u.approve(V6, ethers.MaxUint256).then(t => t.wait()));
        log(`  borrower ${i + 1}: agentId=${aid}`);
    }

    log('[3] Lender supplies 1k to each pool');
    const usdcL = new ethers.Contract(ADDR.usdc, USDC_ABI, lender);
    const v6L = new ethers.Contract(V6, ABI, lender);
    await withRetry(() => usdcL.approve(V6, ethers.MaxUint256).then(t => t.wait()));
    for (const aid of aids) {
        await withRetry(() => v6L.supplyLiquidity(aid, ethers.parseUnits('1000', 6)).then(t => t.wait()));
    }

    log('[4] Concurrent loan cycles');
    let totalOk = 0, totalFail = 0;
    for (let cycle = 0; cycle < N_CYCLES; cycle++) {
        // Concurrent request: get tx hashes via Promise.all
        const requestResults = await Promise.allSettled(borrowers.map(async (b, i) => {
            const m = new ethers.Contract(V6, ABI, b);
            const t = await withRetry(() => m.requestLoan(ethers.parseUnits('5', 6), 7));
            const r = await withRetry(() => t.wait());
            // Find the loan ID from the LoanRequested event
            const ev = r.logs.find(l => { try { const p = m.interface.parseLog(l); return p && p.name === 'LoanRequested'; } catch { return false; } });
            const loanId = ev ? m.interface.parseLog(ev).args.loanId : null;
            return { borrower: i, loanId };
        }));
        const requestedLoans = requestResults.filter(r => r.status === 'fulfilled').map(r => r.value);
        // Concurrent repay
        const repayResults = await Promise.allSettled(requestedLoans.map(async ({ borrower, loanId }) => {
            const m = new ethers.Contract(V6, ABI, borrowers[borrower]);
            await withRetry(() => m.repayLoan(loanId).then(t => t.wait()));
            return 'ok';
        }));
        const ok = repayResults.filter(r => r.status === 'fulfilled').length;
        const fail = repayResults.length - ok;
        totalOk += ok; totalFail += fail + (N_BORROWERS - requestedLoans.length);
        log(`  cycle ${cycle + 1}/${N_CYCLES}: requested ${requestedLoans.length}/${N_BORROWERS}, repaid ${ok}/${requestedLoans.length}`);
    }

    // Invariant check
    let dups = 0;
    for (const aid of aids) {
        const p = await v6.getAgentPool(aid);
        const lc = Number(p[6]);
        const seen = new Set();
        for (let i = 0; i < lc; i++) {
            const a = (await v6.poolLenders(aid, i)).toLowerCase();
            if (seen.has(a)) dups++;
            seen.add(a);
        }
    }
    log(`\n=== RESULTS ===`);
    log(`Total loan ops attempted: ${N_BORROWERS * N_CYCLES}, ok: ${totalOk}, fail: ${totalFail}`);
    log(`Final §B1 dup violations across ${aids.length} pools: ${dups} ${dups === 0 ? '✅' : '❌'}`);

    // Cleanup
    for (const aid of aids) { try { const lp = await v6.positions(aid, lender.address); if (lp.amount > 0n) { const pa = await v6.getAgentPool(aid); const w = lp.amount < pa[2] ? lp.amount : pa[2]; if (w > 0n) await (await v6L.withdrawLiquidity(aid, w)).wait(); } } catch (e) {} }
    try { await (await usdcL.transfer(owner.address, await usdc.balanceOf(lender.address))).wait(); } catch (e) {}
    for (const b of borrowers) { try { const u = new ethers.Contract(ADDR.usdc, USDC_ABI, b); await (await u.transfer(owner.address, await usdc.balanceOf(b.address))).wait(); } catch (e) {} }

    fs.writeFileSync('./forensics/output/regression-2026-05-07/65-multiborrower.json', JSON.stringify({
        timestamp: new Date().toISOString(), nBorrowers: N_BORROWERS, nCycles: N_CYCLES,
        totalOk, totalFail, finalDups: dups
    }, null, 2));
    log('Saved.');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
