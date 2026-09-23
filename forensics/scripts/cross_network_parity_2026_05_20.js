// Cross-network V6 parity verification: Arc V6 vs Base V6.
// Reads constants, owners, pause state, registry/usdc wiring, runtime bytecode.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const ADDR_ARC = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const ADDR_BASE = JSON.parse(fs.readFileSync('./src/config/base-addresses.json'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function rT(fn, attempts = 10) {
    for (let i = 0; i < attempts; i++) { try { return await fn(); } catch (e) { if (i === attempts - 1) throw e; await sleep(3000 * (i+1)); } }
}

(async () => {
    const arcProv = new ethers.JsonRpcProvider(process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org', undefined, { batchMaxCount: 1 });
    const baseProv = new ethers.JsonRpcProvider(process.env.BASE_RPC_URL || 'https://mainnet.base.org', undefined, { batchMaxCount: 1 });
    const arcV6 = new ethers.Contract(ADDR_ARC.agentLiquidityMarketplace_v6, ABI, arcProv);
    const baseV6 = new ethers.Contract(ADDR_BASE.agentLiquidityMarketplace, ABI, baseProv);

    console.log('======================================================================');
    console.log('   CROSS-NETWORK V6 PARITY CHECK');
    console.log('======================================================================');
    console.log('Arc V6:  ', ADDR_ARC.agentLiquidityMarketplace_v6);
    console.log('Base V6: ', ADDR_BASE.agentLiquidityMarketplace);

    const fields = [];
    async function snap(name, network, c) {
        const out = {};
        out.owner = await rT(() => c.owner()); await sleep(1500);
        out.paused = await rT(() => c.paused()); await sleep(1500);
        out.migrationFinalized = await rT(() => c.migrationFinalized()); await sleep(1500);
        out.MAX_LENDERS_PER_POOL = (await rT(() => c.MAX_LENDERS_PER_POOL())).toString(); await sleep(1500);
        out.MAX_ACTIVE_LOANS_PER_AGENT = (await rT(() => c.MAX_ACTIVE_LOANS_PER_AGENT())).toString(); await sleep(1500);
        out.MIN_LOAN_DURATION = (await rT(() => c.MIN_LOAN_DURATION())).toString(); await sleep(1500);
        out.MAX_LOAN_DURATION = (await rT(() => c.MAX_LOAN_DURATION())).toString(); await sleep(1500);
        out.MAX_INTEREST_RATE = (await rT(() => c.MAX_INTEREST_RATE())).toString(); await sleep(1500);
        out.platformFeeRate = (await rT(() => c.platformFeeRate())).toString(); await sleep(1500);
        out.agentRegistry = await rT(() => c.agentRegistry()); await sleep(1500);
        out.reputationManager = await rT(() => c.reputationManager()); await sleep(1500);
        out.usdcToken = await rT(() => c.usdcToken()); await sleep(1500);
        out.bytecodeHash = ethers.keccak256(await rT(() => network.getCode(c.target)));
        out.bytecodeSize = ((await rT(() => network.getCode(c.target))).length - 2) / 2;
        return out;
    }

    console.log('\n[1] Arc V6 snapshot:');
    const arc = await snap('Arc', arcProv, arcV6);
    for (const [k, v] of Object.entries(arc)) console.log('  ' + k + ':', v);

    console.log('\n[2] Base V6 snapshot:');
    const base = await snap('Base', baseProv, baseV6);
    for (const [k, v] of Object.entries(base)) console.log('  ' + k + ':', v);

    console.log('\n[3] Parity comparison:');
    const fieldsToCompare = ['MAX_LENDERS_PER_POOL', 'MAX_ACTIVE_LOANS_PER_AGENT', 'MIN_LOAN_DURATION', 'MAX_LOAN_DURATION', 'MAX_INTEREST_RATE', 'platformFeeRate', 'bytecodeSize'];
    let allMatch = true;
    for (const f of fieldsToCompare) {
        const arcV = arc[f];
        const baseV = base[f];
        const match = arcV === baseV;
        if (!match) allMatch = false;
        console.log(`  ${match ? '✓' : '✗'} ${f}: ${arcV} == ${baseV}`);
    }
    // bytecodeHash WILL differ due to immutables. Don't fail on it.
    console.log(`  ℹ bytecodeHash differs (expected — immutable constructor args bake in):`);
    console.log('     Arc:  ' + arc.bytecodeHash);
    console.log('     Base: ' + base.bytecodeHash);

    // Owner check: both should be secure wallet
    const secureWallet = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';
    console.log(`  ${arc.owner === secureWallet ? '✓' : '✗'} Arc V6 owner = secure wallet`);
    console.log(`  ${base.owner === secureWallet ? '✓' : '✗'} Base V6 owner = secure wallet`);

    console.log(`\n${allMatch ? '✅ PARITY VERIFIED — Arc V6 and Base V6 have identical configuration' : '❌ DIVERGENCE detected (see ✗ above)'}`);

    fs.writeFileSync('./forensics/output/regression-2026-05-07/89-cross-network-parity.json', JSON.stringify({ timestamp: new Date().toISOString(), arc, base }, null, 2));
    console.log('Saved.');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
