// Live §B1 panic differential: same scenario on Arc v4 (panics) vs Arc V6 (succeeds)
//
// The §B1 mechanism: lender does supply(A) → withdraw(full) → supply(A) again, creating
// duplicate poolLenders[] entries. When _distributeInterest runs on a loan with interest,
// it tries to credit the lender twice → Panic(0x11) underflow on `dust = totalInterest - distributed`.
//
// V6's isInPoolLenders flag prevents the duplicate. So same script:
//   - on v4: setup, then repayLoan with interest → REVERT Panic(0x11)
//   - on V6: setup, then repayLoan with interest → SUCCESS

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V4 = ADDR.agentLiquidityMarketplace;
const V6 = ADDR.agentLiquidityMarketplace_v6;
const V4_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;
const V6_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
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

async function runScenario(label, mpAddress, mpAbi, owner, provider, usdc, reg) {
    log(`\n=== ${label} (${mpAddress}) ===`);
    const borrower = ethers.Wallet.createRandom().connect(provider);
    const lender = ethers.Wallet.createRandom().connect(provider);
    fs.appendFileSync('./forensics/output/regression-2026-05-07/58-b1-differential-wallets.json',
        JSON.stringify({ label, borrower: { addr: borrower.address, key: borrower.privateKey }, lender: { addr: lender.address, key: lender.privateKey } }) + '\n');

    // Fund borrower + lender
    await withRetry(() => owner.sendTransaction({ to: borrower.address, value: ethers.parseEther('0.1') }).then(t => t.wait()));
    await withRetry(() => owner.sendTransaction({ to: lender.address, value: ethers.parseEther('0.1') }).then(t => t.wait()));
    await withRetry(() => usdc.transfer(borrower.address, ethers.parseUnits('200', 6)).then(t => t.wait()));
    await withRetry(() => usdc.transfer(lender.address, ethers.parseUnits('500', 6)).then(t => t.wait()));

    // Register borrower + create pool
    const regB = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, borrower);
    await withRetry(() => regB.register(`ipfs://b1diff-${label}-${Date.now()}`, []).then(t => t.wait()));
    const aid = Number(await reg.addressToAgentId(borrower.address));
    log(`  borrower=${borrower.address} agentId=${aid}`);
    log(`  lender=${lender.address}`);

    const mpB = new ethers.Contract(mpAddress, mpAbi, borrower);
    const mpL = new ethers.Contract(mpAddress, mpAbi, lender);
    const usdcB = new ethers.Contract(ADDR.usdc, USDC_ABI, borrower);
    const usdcL = new ethers.Contract(ADDR.usdc, USDC_ABI, lender);
    await withRetry(() => usdcB.approve(mpAddress, ethers.MaxUint256).then(t => t.wait()));
    await withRetry(() => usdcL.approve(mpAddress, ethers.MaxUint256).then(t => t.wait()));
    await withRetry(() => mpB.createAgentPool().then(t => t.wait()));

    // §B1 setup: lender supplies → fully withdraws → supplies again
    log('  step 1: lender supplies 200 USDC');
    await withRetry(() => mpL.supplyLiquidity(aid, ethers.parseUnits('200', 6)).then(t => t.wait()));
    log('  step 2: lender FULLY withdraws (triggers stale poolLenders entry on v4)');
    await withRetry(() => mpL.withdrawLiquidity(aid, ethers.parseUnits('200', 6)).then(t => t.wait()));
    log('  step 3: lender re-supplies 200 USDC');
    await withRetry(() => mpL.supplyLiquidity(aid, ethers.parseUnits('200', 6)).then(t => t.wait()));

    // Inspect poolLenders state
    const pool = await mpB.getAgentPool(aid);
    const lc = Number(pool[6]);
    const lenders = [];
    for (let i = 0; i < lc; i++) {
        const w = await new ethers.Contract(mpAddress, mpAbi, provider).poolLenders(aid, i);
        lenders.push(w.toLowerCase());
    }
    const uniqueCount = new Set(lenders).size;
    log(`  poolLenders state: count=${lc}, unique=${uniqueCount} ${lc === uniqueCount ? '(no dup, §B1 fix working)' : '(DUPLICATE — §B1 panic primed)'}`);

    // Borrower requests + repays a loan with interest
    log('  step 4: borrower requestLoan(10 USDC, 7d)');
    await withRetry(() => mpB.requestLoan(ethers.parseUnits('10', 6), 7).then(t => t.wait()));
    const loanId = (await mpB.nextLoanId()) - 1n;
    log('  step 5: borrower repayLoan — this is where v4 PANICS, V6 SUCCEEDS');
    let repayResult;
    try {
        await withRetry(() => mpB.repayLoan(loanId).then(t => t.wait()), 5);
        repayResult = 'SUCCESS';
        log(`  ✓ repayLoan SUCCEEDED on ${label}`);
    } catch (e) {
        repayResult = 'PANIC';
        const msg = (e.shortMessage || e.message || '').slice(0, 200);
        log(`  ✗ repayLoan REVERTED on ${label}: ${msg}`);
    }

    return { label, mpAddress, agentId: aid, borrower: borrower.address, lender: lender.address, lc, uniqueCount, hasDup: lc !== uniqueCount, repayResult };
}

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);
    const reg = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, owner);
    // Clear prior wallets log
    if (fs.existsSync('./forensics/output/regression-2026-05-07/58-b1-differential-wallets.json'))
        fs.unlinkSync('./forensics/output/regression-2026-05-07/58-b1-differential-wallets.json');

    log('================================================================');
    log('   §B1 PANIC DIFFERENTIAL — v4 panics, V6 succeeds');
    log('================================================================');

    const v4Result = await runScenario('V4', V4, V4_ABI, owner, provider, usdc, reg);
    await sleep(2000);
    const v6Result = await runScenario('V6', V6, V6_ABI, owner, provider, usdc, reg);

    log('\n================================================================');
    log('   RESULTS');
    log('================================================================');
    log('| Contract | poolLenders | unique | has dup | repayLoan |');
    log('|----------|-------------|--------|---------|-----------|');
    log(`| v4       | ${v4Result.lc} | ${v4Result.uniqueCount} | ${v4Result.hasDup ? 'YES' : 'no'}   | ${v4Result.repayResult} |`);
    log(`| V6       | ${v6Result.lc} | ${v6Result.uniqueCount} | ${v6Result.hasDup ? 'YES' : 'no'}   | ${v6Result.repayResult} |`);
    const definitive = v4Result.hasDup && !v6Result.hasDup && v4Result.repayResult === 'PANIC' && v6Result.repayResult === 'SUCCESS';
    log(`\n${definitive ? '✅ DEFINITIVE: §B1 fix proven live — v4 still vulnerable, V6 immune.' : '⚠️  Inconclusive — investigate.'}`);

    fs.writeFileSync('./forensics/output/regression-2026-05-07/58-b1-differential.json', JSON.stringify({
        timestamp: new Date().toISOString(), v4: v4Result, v6: v6Result, definitive
    }, null, 2));
    log('\nSaved.');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
