/**
 * On-chain verification + smoke test of the Arc-testnet STAGING stack.
 * Reads back the deployed config/levers, then drives register → createPool →
 * supply → borrow → repay → claim + a faucet claim, all live on-chain, asserting
 * the results. Read-mostly except the lifecycle it deliberately exercises.
 *
 * `--read-only` (or SMOKE_READ_ONLY=1) runs ONLY section 1 — the lever/config read-back —
 * and sends nothing. Use that to check for config drift without minting or borrowing.
 *
 * Staging has moved generation twice since this file was written (V6.0 → V6.1 → V6.2 +
 * ReputationManagerV4, 2026-09-22). The lever expectations below are therefore NOT
 * hardcoded to a generation: they are the values read live from the chain on 2026-09-24,
 * kept in one place and overridable by env, so a drift shows up as a named failing
 * assertion rather than as a stale constant nobody notices.
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// rpc.testnet.arc.io, not arc-testnet.drpc.org: dRPC rate-limits this host (CLAUDE.md),
// and it is what the monitor and every other tool already default to.
const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://rpc.testnet.arc.io';
const CHAIN_ID = 5042002;
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'arc-testnet-v6-addresses.json'), 'utf8'));
const load = (rel) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', rel), 'utf8')).abi;
const READ_ONLY = process.argv.includes('--read-only') || process.env.SMOKE_READ_ONLY === '1';

// Expected levers — read live from Arc staging 2026-09-24.
const EXPECT = {
    minSupply: BigInt(process.env.SPECULAR_MIN_SUPPLY ?? '10000000'),        // 10 USDC
    minHold: BigInt(process.env.SPECULAR_MIN_HOLD_SECONDS ?? '86400'),
    feeBps: BigInt(process.env.SPECULAR_PLATFORM_FEE_BPS ?? '100'),
    repRateMax: BigInt(process.env.SPECULAR_REP_RATE_MAX ?? '5'),
    faucetCohort: BigInt(process.env.SPECULAR_FAUCET_COHORT ?? '100'),
};

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✅ ${label} ${detail}`); } else { fail++; console.log(`  ❌ ${label} ${detail}`); } };

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { batchMaxCount: 1, cacheTimeout: -1 });
    const wallet = READ_ONLY
        ? new ethers.Wallet(process.env.PRIVATE_KEY || ethers.Wallet.createRandom().privateKey, provider)
        : new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const USDC = (n) => ethers.parseUnits(String(n), 6);

    const usdc = new ethers.Contract(cfg.usdc, load('tokens/MockUSDC.sol/MockUSDC.json'), wallet);
    const registry = new ethers.Contract(cfg.agentRegistryV2, load('core/AgentRegistryV2.sol/AgentRegistryV2.json'), wallet);
    // `reputationManagerV3` is the CANONICAL POINTER, not a generation claim — on staging
    // and mainnet it names ReputationManagerV4. Load the V4 ABI, which is a superset of the
    // views used here; probe VERSION() rather than assuming.
    const reputation = new ethers.Contract(cfg.reputationManagerV3, load('core/ReputationManagerV4.sol/ReputationManagerV4.json'), wallet);
    const mp = new ethers.Contract(cfg.agentLiquidityMarketplace_v6, load('core/AgentLiquidityMarketplaceV62.sol/AgentLiquidityMarketplaceV62.json'), wallet);
    const faucet = new ethers.Contract(cfg.agentCreditFaucet, load('core/AgentCreditFaucet.sol/AgentCreditFaucet.json'), wallet);

    console.log('=== 1. Config / levers read-back ===');
    console.log(`  marketplace ${await mp.VERSION().catch(() => 'V6')} · reputation ${await reputation.VERSION().catch(() => 'V3')} · rpc ${RPC_URL}`);
    check('marketplace owner = configured deployer', (await mp.owner()).toLowerCase() === String(cfg.deployer).toLowerCase(), `(${await mp.owner()})`);
    check('reputation authorized marketplace', await reputation.authorizedPools(cfg.agentLiquidityMarketplace_v6));
    check('not paused', (await mp.paused()) === false);
    check('M-1 bindBorrowToPoolCreator', (await mp.bindBorrowToPoolCreator()) === true);
    check(`M-2 minHold = ${EXPECT.minHold}`, (await mp.minHoldForReputationReward()) === EXPECT.minHold);
    check(`F-C minSupplyAmount = ${ethers.formatUnits(EXPECT.minSupply, 6)} USDC`, (await mp.minSupplyAmount()) === EXPECT.minSupply, `(${ethers.formatUnits(await mp.minSupplyAmount(), 6)})`);
    check(`D1 platformFeeRate = ${EXPECT.feeBps} bps`, (await mp.platformFeeRate()) === EXPECT.feeBps);
    check(`D1 rate limit = ${EXPECT.repRateMax}`, (await reputation.maxReputationGainPerWindow()) === EXPECT.repRateMax, `(${await reputation.maxReputationGainPerWindow()})`);
    check(`faucet maxEligibleAgentId = ${EXPECT.faucetCohort}`, (await faucet.maxEligibleAgentId()) === EXPECT.faucetCohort);

    // Superseded staging stacks are left running on purpose and still hold test lender
    // funds. Report them here so "which contracts still need a monitor" is answerable from
    // the smoke test rather than from memory.
    const bal = new ethers.Contract(cfg.usdc, ['function balanceOf(address) view returns (uint256)'], provider);
    for (const d of cfg.supersededDeployments || []) {
        console.log(`  superseded ${d.marketplace} (${d.version}) holds ${ethers.formatUnits(await bal.balanceOf(d.marketplace), 6)} USDC — needs its own monitor job`);
    }

    if (READ_ONLY) {
        console.log(`\n=== READ-ONLY: ${pass} passed, ${fail} failed (no transactions sent) ===`);
        if (fail > 0) process.exit(1);
        return;
    }

    console.log('\n=== 2. Fund + onboard ===');
    await (await usdc.mint(wallet.address, USDC(10000))).wait();
    await (await usdc.approve(cfg.agentLiquidityMarketplace_v6, ethers.MaxUint256)).wait();
    let agentId = await registry.addressToAgentId(wallet.address);
    if (agentId === 0n) {
        await (await registry.register('ipfs://staging-smoke', [])).wait();
        agentId = await registry.addressToAgentId(wallet.address);
    }
    check('registered, agentId != 0', agentId !== 0n, `(agentId ${agentId})`);
    const pool = await mp.agentPools(agentId);
    if (!pool.isActive) await (await mp.createAgentPool()).wait();
    check('pool active', (await mp.agentPools(agentId)).isActive);

    console.log('\n=== 3. F-C lever live: sub-minimum supply reverts (new slot only) ===');
    if (await mp.isInPoolLenders(agentId, wallet.address)) {
        console.log('  (skipped: wallet already holds a lender slot; F-C only gates NEW slots)');
    } else {
        let reverted = false;
        try { await (await mp.supplyLiquidity(agentId, USDC('0.5'))).wait(); } catch { reverted = true; }
        check('supply < 1 USDC reverts on-chain', reverted);
    }

    console.log('\n=== 4. supply → borrow → repay → claim (live lifecycle) ===');
    await (await mp.supplyLiquidity(agentId, USDC(100))).wait();
    check('supplied 100', ((await mp.positions(agentId, wallet.address)).amount) >= USDC(100));

    const tx = await mp.requestLoan(USDC(10), 7); // fresh agent → 100% collateral pulled
    const r = await tx.wait();
    let loanId;
    for (const lg of r.logs) { try { const p = mp.interface.parseLog(lg); if (p?.name === 'LoanRequested') { loanId = p.args.loanId; break; } } catch {} }
    check('loan created', loanId != null, `(loanId ${loanId})`);
    check('loan ACTIVE', Number((await mp.loans(loanId)).state) === 1);

    await (await mp.repayLoan(loanId)).wait();
    check('loan REPAID', Number((await mp.loans(loanId)).state) === 2);

    const earned = (await mp.positions(agentId, wallet.address)).earnedInterest;
    check('lender earned interest > 0', earned > 0n, `(${ethers.formatUnits(earned, 6)} USDC)`);
    await (await mp.claimInterest(agentId)).wait();
    check('interest claimed (earnedInterest → 0)', ((await mp.positions(agentId, wallet.address)).earnedInterest) === 0n);

    console.log('\n=== 5. faucet claim (fund + claim once) ===');
    await (await usdc.mint(cfg.agentCreditFaucet, USDC(1000))).wait();
    const before = await usdc.balanceOf(wallet.address);
    await (await faucet.claim()).wait();
    check('faucet granted claimAmount', (await usdc.balanceOf(wallet.address)) > before);
    let doubleReverted = false;
    try { await (await faucet.claim()).wait(); } catch { doubleReverted = true; }
    check('second claim reverts (dedup)', doubleReverted);

    console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
    if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
