// Reputation tier transitions: single borrower does 100 loan cycles on V6, log
// reputation score + creditLimit + collateralRate + interestRate every 5 cycles.
// Verifies tier-boundary transitions (300, 500, 700, 800).

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const REG_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')).abi;
const REP_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json')).abi;
const USDC_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'];
const fmt = v => Number(ethers.formatUnits(v, 6));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const N_LOANS = 100;
const LOAN_AMT = ethers.parseUnits('5', 6);

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
    const rep = new ethers.Contract(ADDR.reputationManagerV3, REP_ABI, owner);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);
    const v6 = new ethers.Contract(V6, ABI, owner);

    log('=== REPUTATION TIER TRANSITIONS ===');

    // Setup
    const borrower = ethers.Wallet.createRandom().connect(provider);
    const lender = ethers.Wallet.createRandom().connect(provider);
    fs.writeFileSync('./forensics/output/regression-2026-05-07/64-rep-wallets.json', JSON.stringify({
        borrower: { addr: borrower.address, key: borrower.privateKey },
        lender: { addr: lender.address, key: lender.privateKey }
    }, null, 2));
    await withRetry(() => owner.sendTransaction({ to: borrower.address, value: ethers.parseEther('5.0') }).then(t => t.wait()));
    await withRetry(() => owner.sendTransaction({ to: lender.address, value: ethers.parseEther('0.2') }).then(t => t.wait()));
    await withRetry(() => usdc.transfer(borrower.address, ethers.parseUnits('200', 6)).then(t => t.wait()));
    await withRetry(() => usdc.transfer(lender.address, ethers.parseUnits('5000', 6)).then(t => t.wait()));

    const regB = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, borrower);
    await withRetry(() => regB.register(`ipfs://reptier-${Date.now()}`, []).then(t => t.wait()));
    const aid = Number(await reg.addressToAgentId(borrower.address));
    log(`borrower=${borrower.address} agentId=${aid}`);

    const v6B = new ethers.Contract(V6, ABI, borrower);
    const v6L = new ethers.Contract(V6, ABI, lender);
    const usdcB = new ethers.Contract(ADDR.usdc, USDC_ABI, borrower);
    const usdcL = new ethers.Contract(ADDR.usdc, USDC_ABI, lender);
    await withRetry(() => v6B.createAgentPool().then(t => t.wait()));
    await withRetry(() => usdcB.approve(V6, ethers.MaxUint256).then(t => t.wait()));
    await withRetry(() => usdcL.approve(V6, ethers.MaxUint256).then(t => t.wait()));
    await withRetry(() => v6L.supplyLiquidity(aid, ethers.parseUnits('5000', 6)).then(t => t.wait()));

    async function snapshot(label) {
        const score = Number(await rep['getReputationScore(address)'](borrower.address));
        const creditLimit = await rep.calculateCreditLimit(borrower.address);
        const collRate = Number(await rep.calculateCollateralRequirement(borrower.address));
        const intRate = Number(await rep.calculateInterestRate(borrower.address));
        log(`  ${label}: score=${score}, creditLimit=${fmt(creditLimit)} USDC, collateralRate=${collRate}%, interestRate=${intRate / 100}% APR`);
        return { label, score, creditLimit: creditLimit.toString(), collRate, intRate };
    }

    const snapshots = [];
    snapshots.push(await snapshot('initial'));
    let lastTier = -1;
    for (let i = 0; i < N_LOANS; i++) {
        const t1 = await withRetry(() => v6B.requestLoan(LOAN_AMT, 7));
        await withRetry(() => t1.wait());
        const lid = (await v6.nextLoanId()) - 1n;
        await sleep(100);
        const t2 = await withRetry(() => v6B.repayLoan(lid));
        await withRetry(() => t2.wait());
        await sleep(150);

        if ((i + 1) % 5 === 0 || i === 0 || i === N_LOANS - 1) {
            snapshots.push(await snapshot(`cycle-${i + 1}`));
        }
        // Tier-transition detection (per CLAUDE.md table)
        const score = Number(await rep['getReputationScore(address)'](borrower.address));
        const tier = score >= 800 ? 4 : score >= 600 ? 3 : score >= 500 ? 2 : score >= 300 ? 1 : 0;
        if (tier !== lastTier) {
            log(`  *** TIER TRANSITION at cycle ${i + 1}: score=${score}, new tier=${tier}`);
            lastTier = tier;
        }
    }

    fs.writeFileSync('./forensics/output/regression-2026-05-07/64-reputation-tiers.json', JSON.stringify({
        timestamp: new Date().toISOString(), agentId: aid, borrower: borrower.address, snapshots
    }, null, 2));

    // Cleanup
    try { await (await usdcB.transfer(owner.address, await usdc.balanceOf(borrower.address))).wait(); } catch (e) {}
    try { const lp = await v6.positions(aid, lender.address); if (lp.amount > 0n) { const pa = await v6.getAgentPool(aid); const w = lp.amount < pa[2] ? lp.amount : pa[2]; if (w > 0n) await (await v6L.withdrawLiquidity(aid, w)).wait(); } } catch (e) {}
    try { await (await usdcL.transfer(owner.address, await usdc.balanceOf(lender.address))).wait(); } catch (e) {}

    log('Saved.');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
