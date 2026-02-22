'use strict';
/**
 * Specular Two-Agent Demo
 *
 * Runs a borrower agent and a lender agent in parallel:
 *
 *   BORROWER (Alice / Agent #5)
 *     → Borrow → x402 credit check → market report → repay → reputation grows
 *     → Crosses UNRATED → HIGH_RISK tier, loan size auto-scales up
 *
 *   LENDER (Bob / Agent #6)
 *     → Supply USDC to Alice's pool → monitor earnings as Alice borrows/repays
 *
 * Required env vars:
 *   BORROWER_KEY    - Borrower private key  (Alice)
 *   LENDER_KEY      - Lender private key    (Bob)
 *   FEE_RECIPIENT   - Address for x402 credit-check fees
 *   ARC_TESTNET_RPC_URL
 *
 * Optional:
 *   AGENT_CYCLES    - Borrower cycles (default 3)
 *   AGENT_LOAN_USDC - Starting loan USDC (default 15)
 *   LENDER_SUPPLY   - USDC Bob supplies (default 500)
 *   LENDER_POOL_ID  - Pool ID to supply (auto-detected from borrower registry if omitted)
 *   PORT            - API port (default 3001)
 *   XMTP_ENV        - 'dev' (default) | 'production'
 */

require('dotenv').config();

const { ethers }          = require('ethers');
const { AutonomousAgent } = require('./AutonomousAgent');
const { LenderAgent }     = require('./LenderAgent');
const { start: startApi } = require('../api/SpecularAgentAPI');

// ── Config ────────────────────────────────────────────────────────────────────

const RPC_URL      = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const BORROWER_KEY = process.env.BORROWER_KEY || process.env.PRIVATE_KEY;
const LENDER_KEY   = process.env.LENDER_KEY;
const PORT         = process.env.PORT || 3001;
const API_URL      = `http://localhost:${PORT}`;

if (!BORROWER_KEY) {
    console.error('BORROWER_KEY (or PRIVATE_KEY) env var required');
    process.exit(1);
}
if (!LENDER_KEY) {
    console.error('LENDER_KEY env var required');
    process.exit(1);
}

if (!process.env.FEE_RECIPIENT) {
    process.env.FEE_RECIPIENT = new ethers.Wallet(BORROWER_KEY).address;
    console.log(`[run-agents] FEE_RECIPIENT defaulting to borrower wallet: ${process.env.FEE_RECIPIENT}`);
}

const borrowerCycles  = parseInt(process.env.AGENT_CYCLES    ?? '3');
const startLoanUsdc   = parseInt(process.env.AGENT_LOAN_USDC ?? '15');
const lenderSupply    = parseInt(process.env.LENDER_SUPPLY   ?? '500');
const workMs          = parseInt(process.env.AGENT_WORK_MS   ?? '2000');
const restMs          = parseInt(process.env.AGENT_REST_MS   ?? '8000');
const lenderPoolIdEnv = process.env.LENDER_POOL_ID ? parseInt(process.env.LENDER_POOL_ID) : null;

// Lender runs for the full borrower session plus a bit of buffer
const lenderDurationMs = borrowerCycles * (60000 + restMs) + 30000;

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n' + '═'.repeat(60));
    console.log('  Specular Two-Agent Demo');
    console.log('═'.repeat(60));

    // 1. Start embedded API
    console.log('\n[run-agents] Starting Specular Agent API...');
    const server = startApi();
    await sleep(1500);

    // 2. Build wallets
    const provider      = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const borrowerWallet = new ethers.Wallet(BORROWER_KEY, provider);
    const lenderWallet   = new ethers.Wallet(LENDER_KEY,   provider);

    const xmtpEnv = process.env.XMTP_ENV ?? 'dev';

    // Auto-detect borrower's pool ID from registry (or use LENDER_POOL_ID override)
    let targetPoolId = lenderPoolIdEnv;
    if (!targetPoolId) {
        try {
            const ADDRESSES = require('../config/arc-testnet-addresses.json');
            const regAbi = ['function addressToAgentId(address) view returns (uint256)'];
            const reg = new ethers.Contract(ADDRESSES.agentRegistryV2, regAbi, provider);
            const id = await reg.addressToAgentId(borrowerWallet.address);
            targetPoolId = Number(id);
            console.log(`[run-agents] Auto-detected borrower pool ID: #${targetPoolId}`);
        } catch {
            targetPoolId = 5;
            console.log(`[run-agents] Could not detect borrower pool ID — defaulting to #5`);
        }
    }

    console.log(`\n[run-agents] Borrower: ${borrowerWallet.address}`);
    console.log(`[run-agents] Lender:   ${lenderWallet.address}`);
    console.log(`[run-agents] Borrower cycles: ${borrowerCycles} | Loan: ${startLoanUsdc} USDC start`);
    console.log(`[run-agents] Lender supply:   ${lenderSupply} USDC → pool #${targetPoolId}`);
    console.log(`[run-agents] XMTP env:        ${xmtpEnv} (set XMTP_ENV=production for mainnet)`);

    // 3. Build agents — pass each other's address for XMTP cross-notifications
    const borrower = new AutonomousAgent({
        wallet:         borrowerWallet,
        apiUrl:         API_URL,
        lenderAddress:  lenderWallet.address,   // notify lender on borrow/repay/promotion
        xmtpEnv,
        config: {
            maxCycles:        borrowerCycles,
            startLoanUsdc,
            workMs,
            restMs,
            loanDurationDays: 7,
            maxLoanUsdc:      500,
        },
    });

    const lender = new LenderAgent({
        wallet:           lenderWallet,
        apiUrl:           API_URL,
        borrowerAddress:  borrowerWallet.address, // notify borrower on supply; read their messages
        xmtpEnv,
        config: {
            targetPoolId,
            supplyUsdc:      lenderSupply,
            pollIntervalMs:  15000,        // check earnings every 15s
            totalDurationMs: lenderDurationMs,
        },
    });

    // 4. Run both in parallel
    console.log('\n' + '─'.repeat(60));
    console.log('  Starting agents in parallel...');
    console.log('─'.repeat(60) + '\n');

    const [borrowerResult, lenderResult] = await Promise.allSettled([
        borrower.run(),
        lender.run(),
    ]);

    if (borrowerResult.status === 'rejected') {
        console.error('\n[run-agents] Borrower error:', borrowerResult.reason?.message);
    }
    if (lenderResult.status === 'rejected') {
        console.error('\n[run-agents] Lender error:', lenderResult.reason?.message);
    }

    // 5. Graceful shutdown
    server.close(() => {
        console.log('\n[run-agents] API server stopped. Demo complete.');
        process.exit(0);
    });
    setTimeout(() => process.exit(0), 5000).unref();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
    console.error('[run-agents] Fatal:', err.message);
    process.exit(1);
});
