// Edge-case bombardment on Arc V6.
// All static-call where possible to avoid spending gas on every test.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const fmt = v => Number(ethers.formatUnits(v, 6));
const OUT = './forensics/output/regression-2026-05-07';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, attempts = 5) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const m = e.shortMessage || e.message || '';
            const isRate = m.includes('rate') || m.includes('408') || m.includes('410') || m.includes('429') || m.includes('-32016') || m.includes('timeout');
            if (i === attempts - 1 || !isRate) throw e;
            await sleep(2000 * Math.pow(2, i));
        }
    }
}

const cases = [];
const log = (...a) => console.log(...a);

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const v6 = new ethers.Contract(V6, ABI, owner);
    const SECURE = owner.address;
    const SELF_AGENT = 49n;

    log('=== V6 EDGE-CASE BOMBARDMENT ===');
    log(`from: ${SECURE}`);

    async function tryCase(name, fn) {
        try {
            const result = await fn();
            cases.push({ name, result: 'OK', detail: result });
            log(`  ✓ ${name}: OK ${result ? `(${result})` : ''}`);
        } catch (e) {
            const msg = (e.shortMessage || e.message).slice(0, 100);
            cases.push({ name, result: 'REVERT', message: msg });
            log(`  ✗ ${name}: ${msg}`);
        }
    }

    // === SUPPLY edge cases ===
    log('\n--- supplyLiquidity ---');
    await tryCase('supply 0 amount', async () => {
        await v6.supplyLiquidity.staticCall(SELF_AGENT, 0);
        return 'WOULD SUCCEED';
    });
    await tryCase('supply to non-existent agent (id=999)', async () => {
        await v6.supplyLiquidity.staticCall(999n, ethers.parseUnits('1', 6));
        return 'WOULD SUCCEED';
    });
    await tryCase('supply 1 base unit', async () => {
        await v6.supplyLiquidity.staticCall(SELF_AGENT, 1n);
        return 'WOULD SUCCEED';
    });

    // === WITHDRAW edge cases ===
    log('\n--- withdrawLiquidity ---');
    await tryCase('withdraw 0 amount', async () => {
        await v6.withdrawLiquidity.staticCall(SELF_AGENT, 0);
        return 'WOULD SUCCEED';
    });
    await tryCase('withdraw more than position', async () => {
        await v6.withdrawLiquidity.staticCall(SELF_AGENT, ethers.parseUnits('1000000', 6));
        return 'WOULD SUCCEED';
    });
    await tryCase('withdraw from agent with no position', async () => {
        await v6.withdrawLiquidity.staticCall(999n, ethers.parseUnits('1', 6));
        return 'WOULD SUCCEED';
    });

    // === REQUEST LOAN edge cases ===
    log('\n--- requestLoan ---');
    await tryCase('request 0 amount', async () => {
        await v6.requestLoan.staticCall(0, 7);
        return 'WOULD SUCCEED';
    });
    await tryCase('request loan, durationDays = 0', async () => {
        await v6.requestLoan.staticCall(ethers.parseUnits('0.1', 6), 0);
        return 'WOULD SUCCEED';
    });
    await tryCase('request loan, durationDays = 6', async () => {
        await v6.requestLoan.staticCall(ethers.parseUnits('0.1', 6), 6);
        return 'WOULD SUCCEED';
    });
    await tryCase('request loan, durationDays = 7 (MIN)', async () => {
        await v6.requestLoan.staticCall(ethers.parseUnits('0.1', 6), 7);
        return 'WOULD SUCCEED';
    });
    await tryCase('request loan, durationDays = 365 (MAX)', async () => {
        await v6.requestLoan.staticCall(ethers.parseUnits('0.1', 6), 365);
        return 'WOULD SUCCEED';
    });
    await tryCase('request loan, durationDays = 366', async () => {
        await v6.requestLoan.staticCall(ethers.parseUnits('0.1', 6), 366);
        return 'WOULD SUCCEED';
    });
    await tryCase('request loan, durationDays = 604800 (seconds shape)', async () => {
        await v6.requestLoan.staticCall(ethers.parseUnits('0.1', 6), 604800);
        return 'WOULD SUCCEED';
    });
    await tryCase('request loan, durationDays = 2^256-1 (max uint)', async () => {
        await v6.requestLoan.staticCall(ethers.parseUnits('0.1', 6), ethers.MaxUint256);
        return 'WOULD SUCCEED';
    });
    await tryCase('request amount > credit limit (1001 USDC, limit is 1000)', async () => {
        await v6.requestLoan.staticCall(ethers.parseUnits('1001', 6), 30);
        return 'WOULD SUCCEED';
    });
    await tryCase('request loan, agent has no pool', async () => {
        // Use a different signer that doesn't have a pool
        const fresh = ethers.Wallet.createRandom().connect(provider);
        const v6Fresh = new ethers.Contract(V6, ABI, fresh);
        await v6Fresh.requestLoan.staticCall(ethers.parseUnits('0.1', 6), 7, { from: fresh.address });
        return 'WOULD SUCCEED';
    });

    // === REPAY edge cases ===
    log('\n--- repayLoan ---');
    await tryCase('repay non-existent loan (id=99999)', async () => {
        await v6.repayLoan.staticCall(99999n);
        return 'WOULD SUCCEED';
    });
    await tryCase('repay loanId = 0', async () => {
        await v6.repayLoan.staticCall(0n);
        return 'WOULD SUCCEED';
    });

    // === CLAIM edge cases ===
    log('\n--- claimInterest ---');
    await tryCase('claim on agent with no position', async () => {
        await v6.claimInterest.staticCall(999n);
        return 'WOULD SUCCEED';
    });
    await tryCase('claim on own pool with 0 earned', async () => {
        await v6.claimInterest.staticCall(SELF_AGENT);
        return 'WOULD SUCCEED';
    });

    // === AGENT POOL ===
    log('\n--- createAgentPool ---');
    await tryCase('create pool when agent has none (using fresh signer)', async () => {
        const fresh = ethers.Wallet.createRandom().connect(provider);
        const v6Fresh = new ethers.Contract(V6, ABI, fresh);
        await v6Fresh.createAgentPool.staticCall({ from: fresh.address });
        return 'WOULD SUCCEED';
    });
    await tryCase('create pool that already exists (agent #49)', async () => {
        await v6.createAgentPool.staticCall();
        return 'WOULD SUCCEED';
    });

    // === OWNER FUNCTIONS — non-owner attempts ===
    log('\n--- onlyOwner protections ---');
    await tryCase('non-owner pause()', async () => {
        const fresh = ethers.Wallet.createRandom().connect(provider);
        const v6Fresh = new ethers.Contract(V6, ABI, fresh);
        await v6Fresh.pause.staticCall({ from: fresh.address });
        return 'WOULD SUCCEED';
    });
    await tryCase('non-owner seedPool()', async () => {
        const fresh = ethers.Wallet.createRandom().connect(provider);
        const v6Fresh = new ethers.Contract(V6, ABI, fresh);
        await v6Fresh.seedPool.staticCall(101n, fresh.address, 0, 0, 0, { from: fresh.address });
        return 'WOULD SUCCEED';
    });
    await tryCase('non-owner setMigrationFinalized()', async () => {
        const fresh = ethers.Wallet.createRandom().connect(provider);
        const v6Fresh = new ethers.Contract(V6, ABI, fresh);
        await v6Fresh.setMigrationFinalized.staticCall({ from: fresh.address });
        return 'WOULD SUCCEED';
    });
    await tryCase('non-owner withdrawFees(1)', async () => {
        const fresh = ethers.Wallet.createRandom().connect(provider);
        const v6Fresh = new ethers.Contract(V6, ABI, fresh);
        await v6Fresh.withdrawFees.staticCall(1, { from: fresh.address });
        return 'WOULD SUCCEED';
    });

    // === Summary ===
    log('\n=== SUMMARY ===');
    log(`Total cases: ${cases.length}`);
    log(`Reverted (expected for edge cases): ${cases.filter(c => c.result === 'REVERT').length}`);
    log(`Would succeed: ${cases.filter(c => c.result === 'OK').length}`);

    fs.writeFileSync(path.join(OUT, '35-edge-cases.json'), JSON.stringify({ cases }, null, 2));
    log('\nSaved.');
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
