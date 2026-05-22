/**
 * Template: API-Payer Agent
 *
 * An agent that needs to pay an external API in USDC but doesn't always
 * have funds. Borrows from Specular as needed, does the paid work, then
 * repays. Over time, reputation grows and the agent unlocks better terms.
 *
 * Adapt the simulateApiCall() and earnRevenue() functions for your real
 * use case (OpenAI, Anthropic, Replicate, vast.ai, Akash, etc.).
 *
 * Run:
 *   AGENT_KEY=0x... node src/sdk/templates/api-payer-agent.js
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { SpecularQuickstart } = require('../SpecularQuickstart');

// === Configure your use case ===
const NETWORK = 'arc';                       // 'base' for production, 'arc' for testnet
const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const API_COST_USDC = 1;                     // cost of one API call
const REVENUE_PER_TASK_USDC = 2.5;           // what your agent earns per completed task

async function simulateApiCall(amount) {
    // In production: actually call the API and pay (e.g., via x402, Stripe, etc.)
    console.log(`  [API] Paying ${amount} USDC for API call...`);
    await new Promise(r => setTimeout(r, 500));
    return { ok: true };
}

async function earnRevenue(amount) {
    // In production: receive payment from client (e.g., webhook + bank/USDC transfer)
    console.log(`  [Client] Earned ${amount} USDC from completed task`);
    return amount;
}

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC);
    const wallet = new ethers.Wallet(process.env.AGENT_KEY || process.env.PRIVATE_KEY, provider);
    const sdk = new SpecularQuickstart(wallet, NETWORK);
    console.log('Agent:', wallet.address);

    // Phase 1: ensure ready to operate
    const onb = await sdk.onboard();
    const info = await sdk.creditInfo();
    console.log('Reputation:', info.score, '/ Credit:', info.creditLimit, 'USDC @', info.interestRateAPR + '% APR');

    // Ensure pool has liquidity. For demo, self-supply if empty.
    // In production an external lender supplies; remove this block for live agents.
    const pool = await sdk.marketplace.getAgentPool(onb.agentId);
    if (pool.availableLiquidity < ethers.parseUnits(String(API_COST_USDC * 2), 6)) {
        console.log(`Pool empty — self-supplying ${API_COST_USDC * 2} USDC for demo`);
        await sdk.supply(onb.agentId, API_COST_USDC * 2);
    }

    // Phase 2: borrow + work + repay
    console.log(`\nNeed ${API_COST_USDC} USDC to pay API. Borrowing.`);
    const loan = await sdk.borrow(API_COST_USDC, 7);
    console.log('Loan acquired: id=' + loan.loanId);

    await simulateApiCall(API_COST_USDC);
    const earned = await earnRevenue(REVENUE_PER_TASK_USDC);

    console.log(`\nRevenue earned ${earned} USDC. Repaying ${API_COST_USDC} + interest.`);
    const repayTx = await sdk.repay(loan.loanId);
    console.log('Repaid:', sdk.explorerUrl(repayTx));

    const newInfo = await sdk.creditInfo();
    console.log(`\nReputation: ${info.score} → ${newInfo.score} (+${newInfo.score - info.score})`);
    console.log(`Net profit this cycle: ${earned - API_COST_USDC} USDC (minus tiny on-chain interest)`);
})().catch(e => { console.error(e); process.exit(1); });
