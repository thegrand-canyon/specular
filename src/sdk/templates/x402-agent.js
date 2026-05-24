/**
 * Template: x402-aware agent with auto-borrow from Specular.
 *
 * The agent attempts to call an x402-gated API. If the API requires payment
 * and the agent's USDC balance is insufficient, Specular auto-borrows the
 * gap. After the API call returns its result, the agent can repay later
 * (when revenue arrives).
 *
 * Two ways to run:
 *
 *  A) Against a public x402 endpoint (production):
 *       node src/sdk/templates/x402-agent.js https://some-x402-api.example.com/endpoint
 *
 *  B) Against the bundled stub server (demo, runs locally):
 *       Terminal 1:  node src/sdk/templates/x402-stub-server.js
 *       Terminal 2:  node src/sdk/templates/x402-agent.js http://localhost:4040/transcribe
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { SpecularX402Client } = require('../x402/SpecularX402Client');

(async () => {
    const url = process.argv[2];
    if (!url) {
        console.error('Usage: node x402-agent.js <x402-endpoint-url>');
        process.exit(1);
    }
    const network = process.env.SPECULAR_NETWORK || 'arc';
    const key = process.env.AGENT_KEY || process.env.PRIVATE_KEY;
    if (!key) { console.error('Set AGENT_KEY or PRIVATE_KEY'); process.exit(1); }

    console.log(`=== x402 agent (network=${network}, target=${url}) ===`);

    const x402 = new SpecularX402Client(key, network, {
        maxPayment: ethers.parseUnits('1', 6) // willing to pay up to 1 USDC per call
    });
    console.log('Agent wallet:', x402.wallet.address);

    const before = await x402._usdcBalance();
    console.log('USDC before:', ethers.formatUnits(before, 6));

    // Make the call. x402-fetch handles 402 dance; SpecularX402Client handles auto-borrow.
    console.log('\n[CALL] →', url);
    const t0 = Date.now();
    const res = await x402.fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ task: 'demo' })
    });
    const dt = Date.now() - t0;
    console.log(`[CALL] ← HTTP ${res.status} in ${dt}ms`);

    const text = await res.text();
    console.log('Response body (first 200 chars):', text.slice(0, 200));

    const after = await x402._usdcBalance();
    console.log('USDC after:', ethers.formatUnits(after, 6),
        '(spent:', ethers.formatUnits(before - after, 6), 'USDC)');

    const loans = await x402.outstandingLoans();
    if (loans.length > 0) {
        console.log('\nOutstanding loans (repay after revenue comes in):');
        for (const l of loans) {
            console.log(`  #${l.loanId}: ${l.amount_usdc || l.amount} USDC @ ${l.interestRate / 100}% APR`);
        }
    }

    console.log('\n✅ x402 + Specular agent flow complete');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
