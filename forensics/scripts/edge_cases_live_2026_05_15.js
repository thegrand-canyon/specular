// Edge case bombardment on V6 live: boundary values, exact-equals, off-by-one.
// Tests:
//   - amount=1 (smallest valid)
//   - amount=0 (already-rejected per fix 3)
//   - amount=creditLimit exactly
//   - amount=creditLimit+1 (should reject)
//   - duration=MIN_LOAN_DURATION (7d)
//   - duration=MIN-1 (should reject)
//   - duration=MAX_LOAN_DURATION (365d)
//   - duration=MAX+1 (should reject)
//   - withdraw=0 (fix 4)
//   - withdraw=position exactly
//   - withdraw=position+1 (should reject)
//   - liquidate active loan before endTime (should reject)
//   - claim with zero interest (should reject)

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
    const reg = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, owner);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);
    const v6 = new ethers.Contract(V6, ABI, owner);

    log('=== V6 EDGE CASE BOMBARDMENT (live) ===');
    const results = [];
    const test = async (name, fn, expectRevert = null) => {
        try {
            const r = await fn();
            const outcome = { name, passed: !expectRevert, result: 'SUCCESS', detail: r?.toString?.() || '' };
            results.push(outcome);
            log(`  ${expectRevert ? '✗' : '✓'} ${name}: SUCCESS${expectRevert ? ' (expected REVERT!)' : ''}`);
        } catch (e) {
            const m = (e.shortMessage || e.message || '').slice(0, 100);
            const isExpected = expectRevert && m.toLowerCase().includes(expectRevert.toLowerCase());
            results.push({ name, passed: !!expectRevert && isExpected, result: 'REVERT', detail: m });
            log(`  ${expectRevert ? (isExpected ? '✓' : '?') : '✗'} ${name}: REVERT "${m}" ${expectRevert ? '(expected: ' + expectRevert + ')' : ''}`);
        }
    };

    // Setup
    const borrower = ethers.Wallet.createRandom().connect(provider);
    const lender = ethers.Wallet.createRandom().connect(provider);
    fs.writeFileSync('./forensics/output/regression-2026-05-07/69-edge-wallets.json', JSON.stringify({
        borrower: { addr: borrower.address, key: borrower.privateKey },
        lender: { addr: lender.address, key: lender.privateKey }
    }, null, 2));
    await withRetry(() => owner.sendTransaction({ to: borrower.address, value: ethers.parseEther('1.0') }).then(t => t.wait()));
    await withRetry(() => owner.sendTransaction({ to: lender.address, value: ethers.parseEther('0.5') }).then(t => t.wait()));
    await withRetry(() => usdc.transfer(borrower.address, ethers.parseUnits('5000', 6)).then(t => t.wait()));
    await withRetry(() => usdc.transfer(lender.address, ethers.parseUnits('5000', 6)).then(t => t.wait()));
    const regB = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, borrower);
    await withRetry(() => regB.register(`ipfs://edge-${Date.now()}`, []).then(t => t.wait()));
    const aid = Number(await reg.addressToAgentId(borrower.address));
    log(`borrower aid=${aid}`);

    const v6B = new ethers.Contract(V6, ABI, borrower);
    const v6L = new ethers.Contract(V6, ABI, lender);
    const usdcB = new ethers.Contract(ADDR.usdc, USDC_ABI, borrower);
    const usdcL = new ethers.Contract(ADDR.usdc, USDC_ABI, lender);
    await withRetry(() => usdcB.approve(V6, ethers.MaxUint256).then(t => t.wait()));
    await withRetry(() => usdcL.approve(V6, ethers.MaxUint256).then(t => t.wait()));
    await withRetry(() => v6B.createAgentPool().then(t => t.wait()));
    await withRetry(() => v6L.supplyLiquidity(aid, ethers.parseUnits('2000', 6)).then(t => t.wait()));

    log('\n[1] Loan amount edge cases');
    await test('requestLoan(amount=0)', () => v6B.requestLoan(0, 7), 'Amount must be > 0');
    await test('requestLoan(amount=1 wei)', async () => { const t = await v6B.requestLoan(1, 7); const r = await t.wait(); const lid = (await v6.nextLoanId()) - 1n; await (await v6B.repayLoan(lid)).wait(); return r.gasUsed; });
    // amount=1000 is current creditLimit (score 0 → 1k). Try exact.
    await test('requestLoan(amount=creditLimit=1000)', async () => { const t = await v6B.requestLoan(ethers.parseUnits('1000', 6), 7); const r = await t.wait(); const lid = (await v6.nextLoanId()) - 1n; await (await v6B.repayLoan(lid)).wait(); return r.gasUsed; });
    await test('requestLoan(amount=creditLimit+1=1000.000001)', () => v6B.requestLoan(ethers.parseUnits('1000', 6) + 1n, 7), 'Exceeds credit limit');

    log('\n[2] Duration edge cases');
    await test('requestLoan(duration=7=MIN)', async () => { const t = await v6B.requestLoan(ethers.parseUnits('5', 6), 7); const r = await t.wait(); const lid = (await v6.nextLoanId()) - 1n; await (await v6B.repayLoan(lid)).wait(); return r.gasUsed; });
    await test('requestLoan(duration=6=MIN-1)', () => v6B.requestLoan(ethers.parseUnits('5', 6), 6), 'Invalid duration');
    await test('requestLoan(duration=365=MAX)', async () => { const t = await v6B.requestLoan(ethers.parseUnits('5', 6), 365); const r = await t.wait(); const lid = (await v6.nextLoanId()) - 1n; await (await v6B.repayLoan(lid)).wait(); return r.gasUsed; });
    await test('requestLoan(duration=366=MAX+1)', () => v6B.requestLoan(ethers.parseUnits('5', 6), 366), 'Invalid duration');

    log('\n[3] Withdraw edge cases');
    const lenderPos = await v6.positions(aid, lender.address);
    await test('withdrawLiquidity(amount=0)', () => v6L.withdrawLiquidity(aid, 0), 'Amount must be > 0');
    await test('withdrawLiquidity(amount=position+1)', () => v6L.withdrawLiquidity(aid, lenderPos.amount + 1n), 'Insufficient balance');

    log('\n[4] Liquidation edge cases');
    const t = await v6B.requestLoan(ethers.parseUnits('5', 6), 7);
    await t.wait();
    const activeLoanId = (await v6.nextLoanId()) - 1n;
    await test('liquidateLoan(active, not overdue)', () => v6.liquidateLoan(activeLoanId), 'Loan not overdue');
    await (await v6B.repayLoan(activeLoanId)).wait();

    log('\n[5] Claim edge cases');
    await test('claimInterest(no interest)', () => v6L.claimInterest(aid), 'No interest to claim');

    log('\n[6] Permission edges');
    await test('non-owner pause', () => v6B.pause(), 'OwnableUnauthorizedAccount');
    await test('non-owner liquidateLoan', () => v6B.liquidateLoan(activeLoanId), 'Loan not active');
    await test('non-owner setMigrationFinalized', () => v6B.setMigrationFinalized(), 'OwnableUnauthorizedAccount');

    log('\n[7] Migration helper edges (seedPool requires registry match — fix 1)');
    const randomAddr = ethers.Wallet.createRandom().address;
    await test('seedPool with random agentAddress', () => v6.seedPool(99999, randomAddr, 0, 0, 0), 'agentAddress/agentId mismatch');
    await test('seedPool with agentId=0', () => v6.seedPool(0, owner.address, 0, 0, 0), 'Invalid agentId');

    // Cleanup
    try { const p = await v6.positions(aid, lender.address); if (p.amount > 0n) { const pa = await v6.getAgentPool(aid); const w = p.amount < pa[2] ? p.amount : pa[2]; if (w > 0n) await (await v6L.withdrawLiquidity(aid, w)).wait(); } } catch (e) {}
    try { await (await usdcL.transfer(owner.address, await usdc.balanceOf(lender.address))).wait(); } catch (e) {}
    try { await (await usdcB.transfer(owner.address, await usdc.balanceOf(borrower.address))).wait(); } catch (e) {}

    const passed = results.filter(r => r.passed).length;
    log(`\n=== ${passed}/${results.length} edge cases behave as expected ===`);
    fs.writeFileSync('./forensics/output/regression-2026-05-07/69-edge-cases.json', JSON.stringify({
        timestamp: new Date().toISOString(), agentId: aid, results, passed, total: results.length
    }, null, 2));
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
