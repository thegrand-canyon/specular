/**
 * On-chain verification + smoke test of the fixed V6 staging stack on Arc testnet.
 * Reads back the deployed config/levers, then drives register → createPool →
 * supply → borrow → repay → claim + a faucet claim, all live on-chain, asserting
 * the results. Read-mostly except the lifecycle it deliberately exercises.
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const CHAIN_ID = 5042002;
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'arc-testnet-v6-addresses.json'), 'utf8'));
const load = (rel) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', rel), 'utf8')).abi;

let pass = 0, fail = 0;
const check = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✅ ${label} ${detail}`); } else { fail++; console.log(`  ❌ ${label} ${detail}`); } };

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const USDC = (n) => ethers.parseUnits(String(n), 6);

    const usdc = new ethers.Contract(cfg.usdc, load('tokens/MockUSDC.sol/MockUSDC.json'), wallet);
    const registry = new ethers.Contract(cfg.agentRegistryV2, load('core/AgentRegistryV2.sol/AgentRegistryV2.json'), wallet);
    const reputation = new ethers.Contract(cfg.reputationManagerV3, load('core/ReputationManagerV3.sol/ReputationManagerV3.json'), wallet);
    const mp = new ethers.Contract(cfg.agentLiquidityMarketplace_v6, load('core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json'), wallet);
    const faucet = new ethers.Contract(cfg.agentCreditFaucet, load('core/AgentCreditFaucet.sol/AgentCreditFaucet.json'), wallet);

    console.log('=== 1. Config / levers read-back ===');
    check('marketplace owner = deployer', (await mp.owner()) === wallet.address);
    check('reputation authorized marketplace', await reputation.authorizedPools(cfg.agentLiquidityMarketplace_v6));
    check('M-1 bindBorrowToPoolCreator', (await mp.bindBorrowToPoolCreator()) === true);
    check('M-2 minHold = 86400', (await mp.minHoldForReputationReward()) === 86400n);
    check('F-C minSupplyAmount = 1 USDC', (await mp.minSupplyAmount()) === USDC(1));
    check('D1 platformFeeRate = 100 bps', (await mp.platformFeeRate()) === 100n);
    check('D1 rate limit = 20', (await reputation.maxReputationGainPerWindow()) === 20n);
    check('faucet maxEligibleAgentId = 100', (await faucet.maxEligibleAgentId()) === 100n);

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
