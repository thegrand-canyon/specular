'use strict';
/**
 * Specular Autonomous Agent — Runner
 *
 * Starts an embedded Specular Agent API server, then runs the
 * autonomous agent loop for N cycles.
 *
 * Required env vars:
 *   PRIVATE_KEY            - Agent wallet private key
 *   ARC_TESTNET_RPC_URL    - RPC endpoint (default: https://arc-testnet.drpc.org)
 *   FEE_RECIPIENT          - Address that receives x402 credit-check fees
 *                            (can be same as agent wallet for testing)
 *
 * Optional env vars:
 *   AGENT_CYCLES           - Number of borrow cycles (default: 3)
 *   AGENT_LOAN_USDC        - Starting loan amount in USDC (default: 10)
 *   AGENT_WORK_MS          - Work simulation duration in ms (default: 3000)
 *   AGENT_REST_MS          - Rest between cycles in ms (default: 5000)
 *   PORT                   - API server port (default: 3001)
 *
 * Usage:
 *   node src/agents/run-agent.js
 *   # or via npm:
 *   npm run agent
 */

require('dotenv').config();

const { ethers }          = require('ethers');
const { AutonomousAgent } = require('./AutonomousAgent');
const { start: startApi } = require('../api/SpecularAgentAPI');

// ── Validate env ──────────────────────────────────────────────────────────────

const PRIVATE_KEY   = process.env.PRIVATE_KEY;
const RPC_URL       = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const FEE_RECIPIENT = process.env.FEE_RECIPIENT;
const PORT          = process.env.PORT || 3001;
const API_URL       = `http://localhost:${PORT}`;

if (!PRIVATE_KEY) {
    console.error('\n[run-agent] PRIVATE_KEY env var is required.\n');
    console.error('  Example: PRIVATE_KEY=0x... node src/agents/run-agent.js\n');
    process.exit(1);
}

if (!FEE_RECIPIENT) {
    // Default to the agent wallet itself for local testing
    const wallet = new ethers.Wallet(PRIVATE_KEY);
    process.env.FEE_RECIPIENT = wallet.address;
    console.log(`[run-agent] FEE_RECIPIENT not set — defaulting to agent wallet: ${wallet.address}`);
}

// ── Parse agent config ────────────────────────────────────────────────────────

const agentConfig = {
    maxCycles:        parseInt(process.env.AGENT_CYCLES    ?? '3'),
    startLoanUsdc:    parseInt(process.env.AGENT_LOAN_USDC ?? '10'),
    workMs:           parseInt(process.env.AGENT_WORK_MS   ?? '3000'),
    restMs:           parseInt(process.env.AGENT_REST_MS   ?? '5000'),
    loanDurationDays: 7,   // minimum
    maxLoanUsdc:      500,
};

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    // 1. Start embedded API server
    console.log('\n[run-agent] Starting embedded Specular Agent API...');
    const server = startApi();

    // Give the server a moment to bind before the agent hits it
    await sleep(1000);

    // 2. Build wallet
    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const wallet   = new ethers.Wallet(PRIVATE_KEY, provider);

    console.log(`[run-agent] Wallet: ${wallet.address}`);
    console.log(`[run-agent] Config: ${JSON.stringify(agentConfig)}\n`);

    // 3. Create and run agent
    const agent = new AutonomousAgent({
        wallet,
        apiUrl: API_URL,
        config: agentConfig,
    });

    try {
        await agent.run();
    } catch (err) {
        console.error('\n[run-agent] Fatal agent error:', err.message);
        console.error(err.stack);
        process.exitCode = 1;
    } finally {
        // Graceful shutdown
        server.close(() => {
            console.log('\n[run-agent] API server stopped.');
            process.exit(process.exitCode ?? 0);
        });
        // Force exit after 5s if server hangs
        setTimeout(() => process.exit(process.exitCode ?? 0), 5000).unref();
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

main().catch(err => {
    console.error('[run-agent] Startup error:', err.message);
    process.exit(1);
});
