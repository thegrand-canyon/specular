/**
 * x402 Credit Check Demo
 *
 * Demonstrates the full x402 payment flow:
 *   1. Agent bot hits /credit/:address → receives 402
 *   2. Bot signs EIP-3009 authorization and retries with X-PAYMENT header
 *   3. Server verifies payment, returns credit assessment from on-chain data
 *
 * Run:
 *   FEE_RECIPIENT=0xYOUR_ADDRESS node src/x402/demo-credit-check.js
 */

'use strict';

require('dotenv').config();

const { ethers }             = require('ethers');
const CreditAssessmentServer = require('./CreditAssessmentServer');
const x402Client             = require('./x402Client');

const RPC_URL   = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const CHAIN_ID  = 5042002;

// Use deployer key as fee recipient in demo
const PRIVATE_KEY    = process.env.PRIVATE_KEY;
const FEE_RECIPIENT  = process.env.FEE_RECIPIENT || (PRIVATE_KEY
    ? new ethers.Wallet(PRIVATE_KEY).address
    : null);

// Agent to assess (can be any registered agent)
const AGENT_ADDRESS = process.env.AGENT_ADDRESS
    || '0x741C03c0d95d2c15E479CE1c7E69B3196d86faD7';  // default: AgentRegistryV2

async function main() {
    if (!FEE_RECIPIENT) {
        console.error('Set FEE_RECIPIENT or PRIVATE_KEY env var');
        process.exit(1);
    }

    // ── Start server ─────────────────────────────────────────────────────────
    console.log('='.repeat(60));
    console.log('  Specular x402 Credit Assessment Demo');
    console.log('='.repeat(60));

    const server = new CreditAssessmentServer({
        port:         3402,
        feeRecipient: FEE_RECIPIENT,
        feeAmount:    '1000000',  // 1 USDC for demo
    });

    await server.start();

    // ── Demo: unauthenticated request (expect 402) ───────────────────────────
    console.log('\n--- Step 1: Unauthenticated request ---');
    console.log(`GET http://localhost:3402/credit/${AGENT_ADDRESS}`);

    const rawResult = await rawGet(`http://localhost:3402/credit/${AGENT_ADDRESS}`);
    console.log(`Response status: ${rawResult.status}`);
    if (rawResult.status === 402) {
        console.log('Got 402 Payment Required');
        console.log('Payment requirements:', JSON.stringify(rawResult.body.accepts?.[0], null, 2));
    }

    // ── Demo: x402 client with wallet ────────────────────────────────────────
    console.log('\n--- Step 2: x402 Client auto-payment ---');

    let provider, agentWallet;

    if (PRIVATE_KEY) {
        provider    = new ethers.JsonRpcProvider(RPC_URL);
        agentWallet = new ethers.Wallet(PRIVATE_KEY, provider);
        console.log(`Agent wallet: ${agentWallet.address}`);
    } else {
        // Generate ephemeral wallet for demo (will fail signature verification
        // unless MockUSDC has lenient auth — dev mode still shows the flow)
        agentWallet = ethers.Wallet.createRandom();
        console.log(`Ephemeral wallet (dev mode): ${agentWallet.address}`);
    }

    const client = new x402Client(agentWallet, { verbose: true });

    try {
        console.log('\nCalling client.get() — will auto-handle 402...');
        const assessment = await client.get(`http://localhost:3402/credit/${AGENT_ADDRESS}`);

        console.log('\n' + '='.repeat(60));
        console.log('  CREDIT ASSESSMENT RESULT');
        console.log('='.repeat(60));
        console.log(`Agent:          ${assessment.agentAddress}`);
        console.log(`Credit Score:   ${assessment.creditScore} / 1000`);
        console.log(`Tier:           ${assessment.tier}`);
        console.log(`Credit Limit:   ${assessment.creditLimit}`);
        console.log(`Interest Rate:  ${assessment.interestRate}`);
        console.log(`Collateral Req: ${assessment.collateralRequired}`);
        console.log(`Recommendation: ${assessment.recommendation}`);
        console.log(`Auto-Approve:   ${assessment.loanTerms.autoApproveEligible}`);
        console.log(`Assessed At:    ${assessment.assessedAt}`);
        console.log('\nTotal USDC spent on credit checks:', client.totalSpentUsdc.toFixed(6));

    } catch (err) {
        console.error('\nClient error:', err.message);
        console.log('\n(Expected if running without a funded wallet or real USDC)');
        console.log('The server correctly required x402 payment before serving data.');
    }

    // ── Health check ─────────────────────────────────────────────────────────
    console.log('\n--- Step 3: Health check ---');
    const health = await rawGet('http://localhost:3402/health');
    console.log('Health:', health.body);

    await server.stop();
    console.log('\n[x402] Server stopped. Demo complete.');
}

function rawGet(url) {
    const http = require('http');
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let raw = '';
            res.on('data', c => raw += c);
            res.on('end', () => {
                let body;
                try { body = JSON.parse(raw); } catch { body = raw; }
                resolve({ status: res.statusCode, body });
            });
        }).on('error', reject);
    });
}

main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
