// §S5 extreme: one borrower does 500 sequential loans on V6, gas tracked per cycle.
// If §S5 fix works, gas stays flat (O(1) activeLoanCount counter).
// On v4 this would scale linearly and DoS the agent.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const REG_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')).abi;
const USDC_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];

const N_LOANS = 500;
const LOAN_AMT = ethers.parseUnits('5', 6);
const DURATION = 7;
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

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const reg = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, owner);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);
    const v6 = new ethers.Contract(V6, ABI, owner);

    log('=== §S5 EXTREME: 500 sequential loans on V6, single agent ===');

    // Setup borrower + lender
    const borrower = ethers.Wallet.createRandom().connect(provider);
    const lender = ethers.Wallet.createRandom().connect(provider);
    fs.writeFileSync('./forensics/output/regression-2026-05-07/59-s5-extreme-wallets.json',
        JSON.stringify({ borrower: { addr: borrower.address, key: borrower.privateKey }, lender: { addr: lender.address, key: lender.privateKey } }, null, 2));

    await withRetry(() => owner.sendTransaction({ to: borrower.address, value: ethers.parseEther('5.0') }).then(t => t.wait()));
    await withRetry(() => owner.sendTransaction({ to: lender.address, value: ethers.parseEther('0.5') }).then(t => t.wait()));
    await withRetry(() => usdc.transfer(borrower.address, ethers.parseUnits('200', 6)).then(t => t.wait()));
    await withRetry(() => usdc.transfer(lender.address, ethers.parseUnits('10000', 6)).then(t => t.wait()));

    const regB = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, borrower);
    await withRetry(() => regB.register(`ipfs://s5-extreme-${Date.now()}`, []).then(t => t.wait()));
    const aid = Number(await reg.addressToAgentId(borrower.address));
    log(`borrower=${borrower.address} agentId=${aid}`);

    const v6B = new ethers.Contract(V6, ABI, borrower);
    const v6L = new ethers.Contract(V6, ABI, lender);
    const usdcB = new ethers.Contract(ADDR.usdc, USDC_ABI, borrower);
    const usdcL = new ethers.Contract(ADDR.usdc, USDC_ABI, lender);
    await withRetry(() => v6B.createAgentPool().then(t => t.wait()));
    await withRetry(() => usdcB.approve(V6, ethers.MaxUint256).then(t => t.wait()));
    await withRetry(() => usdcL.approve(V6, ethers.MaxUint256).then(t => t.wait()));
    await withRetry(() => v6L.supplyLiquidity(aid, ethers.parseUnits('10000', 6)).then(t => t.wait()));
    log('Pool funded with 10000 USDC liquidity');

    const gasPerLoan = [];
    const t0 = Date.now();
    for (let i = 0; i < N_LOANS; i++) {
        try {
            const t1 = await withRetry(() => v6B.requestLoan(LOAN_AMT, DURATION));
            const r1 = await withRetry(() => t1.wait());
            gasPerLoan.push(Number(r1.gasUsed));
            const lid = (await withRetry(() => v6.nextLoanId())) - 1n;
            await sleep(100);
            const t2 = await withRetry(() => v6B.repayLoan(lid));
            await withRetry(() => t2.wait());
        } catch (e) {
            log(`  loan ${i + 1} failed: ${(e.shortMessage || e.message).slice(0, 80)}`);
            break;
        }
        if ((i + 1) % 25 === 0) {
            const recent = gasPerLoan.slice(-10);
            const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
            const first10avg = gasPerLoan.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
            log(`  loan ${i + 1}/${N_LOANS}: avg gas (last 10) = ${avg.toFixed(0)}, ratio vs first10 = ${(avg / first10avg).toFixed(4)}`);
        }
        await sleep(100);
    }

    const f10 = gasPerLoan.slice(0, 10).reduce((a, b) => a + b, 0) / 10;
    const l10 = gasPerLoan.slice(-10).reduce((a, b) => a + b, 0) / 10;
    const ratio = l10 / f10;
    log(`\n=== §S5 RESULT ===`);
    log(`Loans completed: ${gasPerLoan.length}/${N_LOANS}`);
    log(`First 10 avg gas: ${f10.toFixed(0)}`);
    log(`Last 10 avg gas:  ${l10.toFixed(0)}`);
    log(`Ratio: ${ratio.toFixed(4)} ${ratio <= 1.10 ? '✅ FLAT (§S5 fix working)' : '❌ SCALING (§S5 fix broken)'}`);
    log(`Duration: ${((Date.now() - t0) / 60000).toFixed(1)} min`);

    // Cleanup borrower + lender
    try { await (await usdcB.transfer(owner.address, await usdc.balanceOf(borrower.address))).wait(); } catch (e) {}
    try { await v6L.withdrawLiquidity(aid, (await v6.positions(aid, lender.address)).amount).then(t => t.wait()); } catch (e) {}
    try { await (await usdcL.transfer(owner.address, await usdc.balanceOf(lender.address))).wait(); } catch (e) {}

    fs.writeFileSync('./forensics/output/regression-2026-05-07/59-s5-extreme.json', JSON.stringify({
        timestamp: new Date().toISOString(), agentId: aid, loansCompleted: gasPerLoan.length,
        first10AvgGas: f10, last10AvgGas: l10, ratio,
        gasPerLoan, success: ratio <= 1.10
    }, null, 2));
    log('Saved.');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
