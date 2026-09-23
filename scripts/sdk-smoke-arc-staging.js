/**
 * Exercise the JS SDK (SpecularQuickstart) against the FIXED V6 staging stack on
 * Arc testnet. Confirms the SDK's onboard/creditInfo/supply/borrow/repay/claim/
 * loans all work against the 2026-08-fixed contracts with the launch levers ON.
 *
 * The staging agents are FRESH (score 0 → 100% collateral), unlike the old
 * arc-testnet e2e which assumes score-1000 agents — so this drives the
 * collateralized-borrow path (exercising the D2 exact-approval logic) and the
 * levers (M-1 creator-only borrow, F-C min supply, M-2 min-hold → no rep yet).
 *
 * Uses the deployer wallet (native USDC for gas + owner of the fresh MockUSDC,
 * so it can mint). Requires PRIVATE_KEY + ARC_TESTNET_RPC_URL.
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { SpecularQuickstart } = require('../src/sdk/SpecularQuickstart.js');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'config', 'arc-testnet-v6-addresses.json'), 'utf8'));
const mockUsdcAbi = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', 'tokens', 'MockUSDC.sol', 'MockUSDC.json'), 'utf8')).abi;

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => { if (cond) { pass++; console.log(`  ✅ ${label} ${detail}`); } else { fail++; console.log(`  ❌ ${label} ${detail}`); } };

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC, 5042002, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const sdk = new SpecularQuickstart(wallet, 'arc-staging');
    ok('SDK targets the fixed staging marketplace', sdk.addresses.marketplace.toLowerCase() === cfg.agentLiquidityMarketplace_v6.toLowerCase());

    // Ensure the deployer holds the staging MockUSDC (mint if needed).
    const usdc = new ethers.Contract(cfg.usdc, mockUsdcAbi, wallet);
    if ((await usdc.balanceOf(wallet.address)) < ethers.parseUnits('50', 6)) {
        await (await usdc.mint(wallet.address, ethers.parseUnits('1000', 6))).wait();
    }

    console.log('\n=== SDK.onboard() ===');
    const out = await sdk.onboard();
    ok('onboard returns agentId', out.agentId != null, `(agentId ${out.agentId})`);
    ok('onboard emits no blanket approval (D2 exact-approval)', out.approveTx === null);

    console.log('\n=== SDK.creditInfo() ===');
    const info = await sdk.creditInfo();
    console.log(`     score=${info.score} limit=${info.creditLimit} collateral=${info.collateralPct}% rate=${info.interestRateAPR}%`);
    ok('creditInfo returns a score', typeof info.score === 'number');
    // Fresh staging agent: score 0 → 100% collateral tier.
    ok('fresh agent is 100% collateral (levers/fresh state)', info.collateralPct === 100);

    console.log('\n=== SDK.supply() (F-C: >= 1 USDC) ===');
    await sdk.supply(out.agentId, 50); // supply 50 to own pool for borrow liquidity
    ok('supplied 50 to pool', true);

    console.log('\n=== SDK.borrow() + repay() (collateralized path) ===');
    const { loanId } = await sdk.borrow(5, 7); // 5 USDC, 7d — 100% collateral auto-approved by SDK
    ok('borrow returned loanId', loanId != null, `(loanId ${loanId})`);
    const repayHash = await sdk.repay(loanId);
    ok('repay returned tx hash', typeof repayHash === 'string' && repayHash.startsWith('0x'));

    console.log('\n=== SDK.loans() ===');
    const loans = await sdk.loans();
    const thisLoan = loans.find(l => l.id === Number(loanId));
    ok('loan shows REPAID', thisLoan && thisLoan.state === 'REPAID');

    console.log('\n=== SDK.claim() ===');
    const claimHash = await sdk.claim(out.agentId);
    ok('claim returned tx hash', typeof claimHash === 'string' && claimHash.startsWith('0x'));

    console.log(`\n=== SDK-vs-staging: ${pass} passed, ${fail} failed ===`);
    if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
