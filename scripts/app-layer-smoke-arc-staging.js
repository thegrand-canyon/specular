/**
 * Validate the app layers ABOVE the base SDK against the FIXED V6 staging stack
 * on Arc testnet:
 *   1. the LLM tool wrappers (OpenAI / Anthropic / LangChain) route correctly to
 *      the fixed contracts, and
 *   2. the x402 auto-supply loop (SpecularX402Server) flushes revenue into the
 *      fixed staging pool.
 * Uses the deployer wallet (already onboarded on staging, holds staging MockUSDC).
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { SpecularQuickstart } = require('../src/sdk/SpecularQuickstart.js');
const { executeSpecularFunction } = require('../src/sdk/openai/SpecularFunctions.js');
const { executeSpecularAnthropicTool } = require('../src/sdk/anthropic/SpecularTools.js');
const { specularTools } = require('../src/sdk/langchain/SpecularTools.js');
const { SpecularX402Server } = require('../src/sdk/x402/SpecularX402Server.js');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'arc-testnet-v6-addresses.json'), 'utf8'));
const mockUsdcAbi = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', 'tokens', 'MockUSDC.sol', 'MockUSDC.json'), 'utf8')).abi;

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✅ ${label} ${detail}`); } else { fail++; console.log(`  ❌ ${label} ${detail}`); } };

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC, 5042002, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const usdc = new ethers.Contract(cfg.usdc, mockUsdcAbi, wallet);
    if ((await usdc.balanceOf(wallet.address)) < ethers.parseUnits('20', 6)) {
        await (await usdc.mint(wallet.address, ethers.parseUnits('500', 6))).wait();
    }

    // ── 1. LLM tool wrappers (all route through SpecularQuickstart('arc-staging')) ──
    console.log('=== OpenAI Functions wrapper ===');
    const sdk = new SpecularQuickstart(wallet, 'arc-staging');
    const ociRaw = await executeSpecularFunction(sdk, 'specular_credit_info', {});
    const oci = JSON.parse(ociRaw);
    ok('openai credit_info returns score', typeof oci.score === 'number', `(score ${oci.score})`);
    const obRaw = await executeSpecularFunction(sdk, 'specular_borrow', { amount: 2, duration_days: 7 });
    const ob = JSON.parse(obRaw);
    ok('openai borrow returns loanId', ob.loanId != null, `(loanId ${ob.loanId})`);
    const orRaw = await executeSpecularFunction(sdk, 'specular_repay', { loan_id: ob.loanId });
    ok('openai repay returns txHash', JSON.parse(orRaw).txHash?.startsWith('0x'));

    console.log('\n=== Anthropic Tools wrapper ===');
    const aci = JSON.parse(await executeSpecularAnthropicTool(sdk, 'specular_credit_info', {}));
    ok('anthropic credit_info returns score', typeof aci.score === 'number', `(score ${aci.score})`);
    const ab = JSON.parse(await executeSpecularAnthropicTool(sdk, 'specular_borrow', { amount: 2, duration_days: 7 }));
    ok('anthropic borrow returns loanId', ab.loanId != null, `(loanId ${ab.loanId})`);
    ok('anthropic repay ok', JSON.parse(await executeSpecularAnthropicTool(sdk, 'specular_repay', { loan_id: ab.loanId })).txHash?.startsWith('0x'));

    console.log('\n=== LangChain tools wrapper ===');
    const tools = specularTools(wallet, 'arc-staging');
    const lci = tools.find(t => t.name === 'specular_credit_info');
    const lciRes = JSON.parse(await lci.invoke({}));
    ok('langchain credit_info returns score', typeof lciRes.score === 'number', `(score ${lciRes.score})`);

    // ── 2. x402 auto-supply loop → fixed staging pool (agentId 1) ──
    console.log('\n=== x402 auto-supply loop (stub) → staging pool 1 ===');
    const server = new SpecularX402Server({
        network: 'arc-staging',
        privateKey: process.env.PRIVATE_KEY,
        rpcUrl: RPC,
        mode: 'stub',
        allowStub: true,
        poolAgentId: 1,
        autoFlushThresholdUsdc: 0.4,
    });
    const mpForRead = new ethers.Contract(cfg.agentLiquidityMarketplace_v6,
        JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', 'core', 'AgentLiquidityMarketplaceV6.sol', 'AgentLiquidityMarketplaceV6.json'), 'utf8')).abi, provider);
    const before = (await mpForRead.getAgentPool(1)).totalLiquidity;
    // Simulate three 0.2-USDC micro-payments → crosses the 0.4 threshold → auto-flush.
    for (let i = 0; i < 3; i++) server._recordRevenue(ethers.parseUnits('0.2', 6));
    // wait for the async auto-flush to settle
    for (let i = 0; i < 30 && server._earned > 0n; i++) await new Promise(r => setTimeout(r, 1000));
    const after = (await mpForRead.getAgentPool(1)).totalLiquidity;
    ok('x402 revenue flushed into the fixed staging pool', after > before,
        `(pool totalLiquidity ${ethers.formatUnits(before, 6)} → ${ethers.formatUnits(after, 6)})`);

    console.log(`\n=== App-layer vs staging: ${pass} passed, ${fail} failed ===`);
    if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
