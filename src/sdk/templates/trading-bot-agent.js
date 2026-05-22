/**
 * Template: Trading-Bot Agent
 *
 * An agent that runs a simple arbitrage / market-making strategy. Borrows
 * USDC for the position, executes trades, profits, repays loan, keeps
 * margin. Higher reputation → bigger position size.
 *
 * Substitute executeStrategy() for your real trading logic (DEX swap,
 * MEV searcher, lending arbitrage, etc.).
 *
 * Run:
 *   AGENT_KEY=0x... node src/sdk/templates/trading-bot-agent.js
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { SpecularQuickstart } = require('../SpecularQuickstart');

const NETWORK = 'arc';
const POSITION_USDC = 10;                  // size to borrow per trade
const EXPECTED_RETURN_PCT = 1.5;           // % return per cycle (demo only)

async function executeStrategy(usdc) {
    console.log(`  [DEX] Opening position with ${usdc} USDC…`);
    await new Promise(r => setTimeout(r, 500));
    // Simulate: return EXPECTED_RETURN_PCT * USDC profit (could also be a loss)
    const profit = (usdc * EXPECTED_RETURN_PCT) / 100;
    console.log(`  [DEX] Closed position. Profit: ${profit} USDC`);
    return profit;
}

(async () => {
    const provider = new ethers.JsonRpcProvider(process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org');
    const wallet = new ethers.Wallet(process.env.AGENT_KEY || process.env.PRIVATE_KEY, provider);
    const sdk = new SpecularQuickstart(wallet, NETWORK);

    const onb = await sdk.onboard();
    const info = await sdk.creditInfo();
    console.log('Bot reputation:', info.score, '/ Credit:', info.creditLimit, 'USDC @', info.interestRateAPR + '% APR');

    // Pick position size: don't exceed credit limit
    const size = Math.min(POSITION_USDC, parseFloat(info.creditLimit) * 0.5); // keep half credit free

    // Demo: self-supply liquidity if pool is empty. Remove in production.
    const pool = await sdk.marketplace.getAgentPool(onb.agentId);
    if (pool.availableLiquidity < ethers.parseUnits(String(size * 2), 6)) {
        console.log(`Pool empty — self-supplying ${size * 2} USDC for demo`);
        await sdk.supply(onb.agentId, size * 2);
    }

    console.log(`\nBorrowing ${size} USDC for trade position…`);
    const loan = await sdk.borrow(size, 7);

    const profit = await executeStrategy(size);

    // Calculate breakeven: profit must exceed loan interest
    const interestOwed = size * info.interestRateAPR / 100 * (7 / 365);
    console.log(`\nInterest owed on loan: ${interestOwed.toFixed(4)} USDC. Profit: ${profit} USDC. Margin: ${(profit - interestOwed).toFixed(4)}`);

    const repayTx = await sdk.repay(loan.loanId);
    console.log('Repaid:', sdk.explorerUrl(repayTx));

    const after = await sdk.creditInfo();
    console.log(`Reputation ${info.score} → ${after.score}.`);
})().catch(e => { console.error(e); process.exit(1); });
