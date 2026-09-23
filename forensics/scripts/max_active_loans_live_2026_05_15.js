// MAX_ACTIVE_LOANS=10 cap enforcement live on V6.
// Single borrower: open 10 loans (without repaying), verify 11th is rejected,
// then repay one, verify a new loan succeeds. Captures §S5 counter behavior.

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

    log('=== V6 MAX_ACTIVE_LOANS=10 LIVE CAP TEST ===');

    const borrower = ethers.Wallet.createRandom().connect(provider);
    const lender = ethers.Wallet.createRandom().connect(provider);
    fs.writeFileSync('./forensics/output/regression-2026-05-07/70-cap-wallets.json', JSON.stringify({
        borrower: { addr: borrower.address, key: borrower.privateKey },
        lender: { addr: lender.address, key: lender.privateKey }
    }, null, 2));
    await withRetry(() => owner.sendTransaction({ to: borrower.address, value: ethers.parseEther('1.0') }).then(t => t.wait()));
    await withRetry(() => owner.sendTransaction({ to: lender.address, value: ethers.parseEther('0.2') }).then(t => t.wait()));
    await withRetry(() => usdc.transfer(borrower.address, ethers.parseUnits('500', 6)).then(t => t.wait()));
    await withRetry(() => usdc.transfer(lender.address, ethers.parseUnits('2000', 6)).then(t => t.wait()));

    const regB = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, borrower);
    await withRetry(() => regB.register(`ipfs://cap-test-${Date.now()}`, []).then(t => t.wait()));
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

    log('\n[1] Open 10 sequential loans (without repaying)');
    const loanIds = [];
    const gasOpened = [];
    for (let i = 0; i < 10; i++) {
        const t = await withRetry(() => v6B.requestLoan(ethers.parseUnits('5', 6), 7));
        const r = await withRetry(() => t.wait());
        const lid = (await v6.nextLoanId()) - 1n;
        loanIds.push(Number(lid));
        gasOpened.push(Number(r.gasUsed));
        const counter = Number(await v6.activeLoanCount(borrower.address));
        log(`  loan ${i + 1}: id=${lid}, gas=${r.gasUsed}, activeLoanCount=${counter} ${counter === i + 1 ? '✓' : '✗ MISMATCH'}`);
    }

    log('\n[2] Attempt 11th loan — expect rejection');
    let cap11Result;
    try {
        await (await v6B.requestLoan(ethers.parseUnits('5', 6), 7)).wait();
        cap11Result = 'ADMITTED — BUG!';
    } catch (e) {
        cap11Result = e.shortMessage || e.message;
    }
    const cap11Passed = cap11Result.toLowerCase().includes('too many active loans');
    log(`  ${cap11Passed ? '✓' : '✗'} 11th loan: ${cap11Result.slice(0, 100)}`);

    log('\n[3] Repay loan #5 → counter should drop, new loan should succeed');
    await withRetry(() => v6B.repayLoan(loanIds[4]).then(t => t.wait()));
    const counterAfterRepay = Number(await v6.activeLoanCount(borrower.address));
    log(`  after repay: activeLoanCount=${counterAfterRepay} ${counterAfterRepay === 9 ? '✓' : '✗'}`);
    let postRepayResult;
    try {
        const t = await withRetry(() => v6B.requestLoan(ethers.parseUnits('5', 6), 7));
        await withRetry(() => t.wait());
        postRepayResult = 'SUCCESS';
        const counter = Number(await v6.activeLoanCount(borrower.address));
        log(`  ✓ new loan accepted. activeLoanCount=${counter}`);
    } catch (e) {
        postRepayResult = 'FAILED: ' + (e.shortMessage || e.message).slice(0, 80);
        log(`  ✗ new loan rejected: ${postRepayResult}`);
    }

    log('\n[4] Repay remaining loans, verify counter drops to 0');
    for (let i = 0; i < loanIds.length; i++) {
        if (i === 4) continue; // already repaid
        try { await withRetry(() => v6B.repayLoan(loanIds[i]).then(t => t.wait())); } catch (e) { log(`  repay loan ${loanIds[i]} failed: ${(e.shortMessage || e.message).slice(0, 60)}`); }
    }
    // Repay the latest loan too
    const latestLid = (await v6.nextLoanId()) - 1n;
    try { await withRetry(() => v6B.repayLoan(latestLid).then(t => t.wait())); } catch (e) {}
    const finalCounter = Number(await v6.activeLoanCount(borrower.address));
    log(`  final activeLoanCount=${finalCounter} ${finalCounter === 0 ? '✓' : '✗ should be 0'}`);

    // Cleanup
    try { const lp = await v6.positions(aid, lender.address); if (lp.amount > 0n) { const pa = await v6.getAgentPool(aid); const w = lp.amount < pa[2] ? lp.amount : pa[2]; if (w > 0n) await (await v6L.withdrawLiquidity(aid, w)).wait(); } } catch (e) {}
    try { await (await usdcL.transfer(owner.address, await usdc.balanceOf(lender.address))).wait(); } catch (e) {}
    try { await (await usdcB.transfer(owner.address, await usdc.balanceOf(borrower.address))).wait(); } catch (e) {}

    fs.writeFileSync('./forensics/output/regression-2026-05-07/70-max-active-loans.json', JSON.stringify({
        timestamp: new Date().toISOString(), agentId: aid, gasOpened, cap11Result, cap11Passed, counterAfterRepay, postRepayResult, finalCounter
    }, null, 2));
    log('\nSaved.');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
