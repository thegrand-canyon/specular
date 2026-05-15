// Pause/unpause live verification. Owner pauses V6, verifies all user functions
// revert with EnforcedPause, unpauses, verifies they work again. Re-pauses, verifies resume.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const REG_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')).abi;
const USDC_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, attempts = 15) {
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
    const v6 = new ethers.Contract(V6, ABI, owner);
    const reg = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, owner);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);

    log('=== PAUSE / UNPAUSE LIVE TEST ===');
    let initialPaused = await v6.paused();
    log('Initial paused state:', initialPaused);
    if (initialPaused) { log('FATAL: V6 already paused, aborting'); process.exit(1); }

    // Setup a borrower + lender for testing the gates
    const borrower = ethers.Wallet.createRandom().connect(provider);
    const lender = ethers.Wallet.createRandom().connect(provider);
    fs.writeFileSync('./forensics/output/regression-2026-05-07/66-pause-wallets.json', JSON.stringify({
        borrower: { addr: borrower.address, key: borrower.privateKey },
        lender: { addr: lender.address, key: lender.privateKey }
    }, null, 2));
    await withRetry(() => owner.sendTransaction({ to: borrower.address, value: ethers.parseEther('0.1') }).then(t => t.wait()));
    await withRetry(() => owner.sendTransaction({ to: lender.address, value: ethers.parseEther('0.1') }).then(t => t.wait()));
    await withRetry(() => usdc.transfer(borrower.address, ethers.parseUnits('100', 6)).then(t => t.wait()));
    await withRetry(() => usdc.transfer(lender.address, ethers.parseUnits('100', 6)).then(t => t.wait()));

    const regB = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, borrower);
    await withRetry(() => regB.register(`ipfs://pause-test-${Date.now()}`, []).then(t => t.wait()));
    const aid = Number(await reg.addressToAgentId(borrower.address));
    log(`Test borrower aid=${aid}`);

    const v6B = new ethers.Contract(V6, ABI, borrower);
    const v6L = new ethers.Contract(V6, ABI, lender);
    const usdcB = new ethers.Contract(ADDR.usdc, USDC_ABI, borrower);
    const usdcL = new ethers.Contract(ADDR.usdc, USDC_ABI, lender);
    await withRetry(() => usdcB.approve(V6, ethers.MaxUint256).then(t => t.wait()));
    await withRetry(() => usdcL.approve(V6, ethers.MaxUint256).then(t => t.wait()));
    await withRetry(() => v6B.createAgentPool().then(t => t.wait()));
    await withRetry(() => v6L.supplyLiquidity(aid, ethers.parseUnits('100', 6)).then(t => t.wait()));

    // === Phase 1: PAUSE ===
    log('\n[1] Owner pauses V6');
    await withRetry(() => v6.pause().then(t => t.wait()));
    log('  paused state now:', await v6.paused());

    // === Phase 2: verify user functions revert with EnforcedPause ===
    log('\n[2] Verify user functions revert when paused');
    const userFns = [
        ['supplyLiquidity', () => v6L.supplyLiquidity(aid, ethers.parseUnits('1', 6))],
        ['withdrawLiquidity', () => v6L.withdrawLiquidity(aid, ethers.parseUnits('1', 6))],
        ['requestLoan', () => v6B.requestLoan(ethers.parseUnits('1', 6), 7)],
        ['claimInterest', () => v6L.claimInterest(aid)]
    ];
    const results = [];
    for (const [name, fn] of userFns) {
        try {
            await fn();
            log(`  ✗ ${name}: did NOT revert (BUG?)`);
            results.push({ fn: name, paused: 'NO_REVERT' });
        } catch (e) {
            const m = (e.shortMessage || e.message || '').slice(0, 80);
            const isPause = m.toLowerCase().includes('enforcedpause') || m.toLowerCase().includes('pausable') || m.toLowerCase().includes('paused');
            log(`  ${isPause ? '✓' : '?'} ${name}: ${m}`);
            results.push({ fn: name, paused: isPause ? 'OK' : 'OTHER:' + m });
        }
    }

    // === Phase 3: liquidateLoan should still work paused (intentional — recovery path) ===
    log('\n[3] liquidateLoan should still work when paused (recovery path)');
    log('  (skipping live liquidate — would need an overdue loan)');

    // === Phase 4: unpause ===
    log('\n[4] Owner unpauses');
    await withRetry(() => v6.unpause().then(t => t.wait()));
    log('  paused state now:', await v6.paused());

    // === Phase 5: verify user functions work again ===
    log('\n[5] Verify user functions resume working');
    try {
        await withRetry(() => v6L.supplyLiquidity(aid, ethers.parseUnits('1', 6)).then(t => t.wait()));
        log('  ✓ supplyLiquidity works after unpause');
    } catch (e) {
        log('  ✗ supplyLiquidity broken after unpause:', (e.shortMessage || e.message).slice(0, 80));
    }

    // === Phase 6: re-pause/unpause to verify cycle resilience ===
    log('\n[6] Cycle test: pause → unpause → pause → unpause');
    for (const action of ['pause', 'unpause', 'pause', 'unpause']) {
        await withRetry(() => v6[action]().then(t => t.wait()));
        log(`  ${action} done. paused=${await v6.paused()}`);
    }

    // Cleanup
    try { const lp = await v6.positions(aid, lender.address); if (lp.amount > 0n) await (await v6L.withdrawLiquidity(aid, lp.amount)).wait(); } catch (e) {}
    try { await (await usdcL.transfer(owner.address, await usdc.balanceOf(lender.address))).wait(); } catch (e) {}
    try { await (await usdcB.transfer(owner.address, await usdc.balanceOf(borrower.address))).wait(); } catch (e) {}

    fs.writeFileSync('./forensics/output/regression-2026-05-07/66-pause-unpause.json', JSON.stringify({
        timestamp: new Date().toISOString(), agentId: aid, results
    }, null, 2));
    log('\nSaved.');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
