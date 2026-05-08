// Gas comparison: Arc v4 / Arc V6 / Base v4 — same operations on each.
// Read-only via estimateGas + bytecode size + on-chain gasUsed from past txs.
// Quantifies §S5 cost savings for high-volume agents (most important for Arc agent #43).

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const ARC_RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const BASE_RPC = process.env.BASE_RPC_URL || 'https://base.publicnode.com';
const ARC_ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const BASE_ADDR = JSON.parse(fs.readFileSync('./src/config/base-addresses.json'));
const V4_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;
const V6_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;

const OUT = './forensics/output/regression-2026-05-07';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, label, attempts = 5) {
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

const SECURE = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';
const HIGH_VOL = '0x656086A21073272533c8A3f56A94c1f3D8BCFcE2'; // Arc agent #43, 777 loans

const out = { generatedAt: new Date().toISOString(), networks: {} };

(async () => {
    // === Arc v4 ===
    console.log('\n===== Arc v4 (canonical) =====');
    const arcProv = new ethers.JsonRpcProvider(ARC_RPC, undefined, { batchMaxCount: 1 });
    const arcV4 = new ethers.Contract(ARC_ADDR.agentLiquidityMarketplace, V4_ABI, arcProv);
    const arcV4Code = await withRetry(() => arcProv.getCode(ARC_ADDR.agentLiquidityMarketplace), 'arcV4Code');
    const arcV4Size = (arcV4Code.length - 2) / 2;

    // requestLoan estimate for fresh agent (#49)
    let arcV4FreshGas = null;
    try {
        arcV4FreshGas = await withRetry(() =>
            arcV4.requestLoan.estimateGas(ethers.parseUnits('1', 6), 7, { from: SECURE }), 'arcV4Fresh');
    } catch (e) { arcV4FreshGas = `revert: ${(e.shortMessage || e.message).slice(0, 50)}`; }

    // requestLoan estimate for high-vol agent (#43, 777 loans)
    let arcV4HighVolGas = null;
    try {
        arcV4HighVolGas = await withRetry(() =>
            arcV4.requestLoan.estimateGas(ethers.parseUnits('1', 6), 7, { from: HIGH_VOL }), 'arcV4HighVol');
    } catch (e) { arcV4HighVolGas = `revert: ${(e.shortMessage || e.message).slice(0, 50)}`; }

    out.networks.arc_v4 = {
        address: ARC_ADDR.agentLiquidityMarketplace,
        bytecodeSize: arcV4Size,
        requestLoan_freshAgent_gas: arcV4FreshGas?.toString() || arcV4FreshGas,
        requestLoan_777loanAgent_gas: arcV4HighVolGas?.toString() || arcV4HighVolGas,
    };
    console.log(`bytecode size: ${arcV4Size} bytes`);
    console.log(`requestLoan gas (fresh agent #49):       ${arcV4FreshGas}`);
    console.log(`requestLoan gas (777-loan agent #43):    ${arcV4HighVolGas}`);

    // === Arc V6 ===
    console.log('\n===== Arc V6 (deployed) =====');
    const arcV6 = new ethers.Contract(ARC_ADDR.agentLiquidityMarketplace_v6, V6_ABI, arcProv);
    const arcV6Code = await withRetry(() => arcProv.getCode(ARC_ADDR.agentLiquidityMarketplace_v6), 'arcV6Code');
    const arcV6Size = (arcV6Code.length - 2) / 2;

    let arcV6FreshGas = null;
    try {
        arcV6FreshGas = await withRetry(() =>
            arcV6.requestLoan.estimateGas(ethers.parseUnits('0.1', 6), 7, { from: SECURE }), 'arcV6Fresh');
    } catch (e) { arcV6FreshGas = `revert: ${(e.shortMessage || e.message).slice(0, 50)}`; }

    out.networks.arc_v6 = {
        address: ARC_ADDR.agentLiquidityMarketplace_v6,
        bytecodeSize: arcV6Size,
        requestLoan_freshAgent_gas: arcV6FreshGas?.toString() || arcV6FreshGas,
        // Note: no 777-loan agent on V6 yet
        note: 'V6 has agent #49 with no historical loans on V6 (separate state from v4)',
    };
    console.log(`bytecode size: ${arcV6Size} bytes`);
    console.log(`requestLoan gas (fresh agent #49):       ${arcV6FreshGas}`);

    // === Base v4 ===
    console.log('\n===== Base v4 (canonical) =====');
    const baseProv = new ethers.JsonRpcProvider(BASE_RPC);
    const baseV4 = new ethers.Contract(BASE_ADDR.agentLiquidityMarketplace, V4_ABI, baseProv);
    const baseV4Code = await withRetry(() => baseProv.getCode(BASE_ADDR.agentLiquidityMarketplace), 'baseV4Code');
    const baseV4Size = (baseV4Code.length - 2) / 2;

    let baseV4Gas = null;
    try {
        baseV4Gas = await withRetry(() =>
            baseV4.requestLoan.estimateGas(ethers.parseUnits('0.01', 6), 7, { from: SECURE }), 'baseV4');
    } catch (e) { baseV4Gas = `revert: ${(e.shortMessage || e.message).slice(0, 50)}`; }

    out.networks.base_v4 = {
        address: BASE_ADDR.agentLiquidityMarketplace,
        bytecodeSize: baseV4Size,
        requestLoan_gas: baseV4Gas?.toString() || baseV4Gas,
        note: 'Base has agent #1 (secure wallet) with prior loans + duplicate poolLenders + 3 stuck active loans',
    };
    console.log(`bytecode size: ${baseV4Size} bytes`);
    console.log(`requestLoan gas: ${baseV4Gas}`);

    // === Comparison summary ===
    console.log('\n===== COMPARISON =====');
    console.log('Bytecode sizes:');
    console.log(`  Arc v4:  ${arcV4Size} bytes`);
    console.log(`  Arc V6:  ${arcV6Size} bytes (Δ +${arcV6Size - arcV4Size}, ${((arcV6Size - arcV4Size) / arcV4Size * 100).toFixed(1)}%)`);
    console.log(`  Base v4: ${baseV4Size} bytes`);

    console.log('\nrequestLoan gas:');
    if (typeof arcV4FreshGas === 'bigint' && typeof arcV6FreshGas === 'bigint') {
        const v4n = Number(arcV4FreshGas);
        const v6n = Number(arcV6FreshGas);
        console.log(`  Arc v4 fresh:    ${v4n}`);
        console.log(`  Arc V6 fresh:    ${v6n} (Δ ${v6n > v4n ? '+' : ''}${v6n - v4n}, ${((v6n - v4n) / v4n * 100).toFixed(1)}%)`);
    }
    if (typeof arcV4HighVolGas === 'bigint') {
        const hv = Number(arcV4HighVolGas);
        console.log(`  Arc v4 (#43, 777 loans): ${hv}`);
        if (typeof arcV6FreshGas === 'bigint') {
            console.log(`  → §S5 fix savings: ${hv - Number(arcV6FreshGas)} gas (${((hv - Number(arcV6FreshGas)) / hv * 100).toFixed(1)}% reduction)`);
        }
    }

    out.summary = {
        bytecode_growth: arcV6Size - arcV4Size,
        bytecode_growth_pct: ((arcV6Size - arcV4Size) / arcV4Size * 100).toFixed(1) + '%',
    };
    if (typeof arcV4HighVolGas === 'bigint' && typeof arcV6FreshGas === 'bigint') {
        out.summary.s5_savings_gas = Number(arcV4HighVolGas) - Number(arcV6FreshGas);
        out.summary.s5_savings_pct = ((Number(arcV4HighVolGas) - Number(arcV6FreshGas)) / Number(arcV4HighVolGas) * 100).toFixed(1) + '%';
    }

    fs.writeFileSync(path.join(OUT, '24-gas-comparison.json'), JSON.stringify(out, null, 2));
    console.log(`\nSaved: ${OUT}/24-gas-comparison.json`);
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
