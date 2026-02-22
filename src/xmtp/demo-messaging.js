/**
 * XMTP Messaging Demo
 *
 * Shows the full XMTP messaging flow for Specular Protocol:
 *   - Agent registers XMTP identity
 *   - Lender registers XMTP identity
 *   - Simulated loan events trigger wallet-to-wallet messages
 *
 * Run:
 *   PRIVATE_KEY=0x... LENDER_KEY=0x... node src/xmtp/demo-messaging.js
 *
 * Without keys, runs in simulation mode (shows message templates).
 */

'use strict';

require('dotenv').config();

const { ethers } = require('ethers');

// XMTP message templates (same as service)
const TEMPLATES = {
    loanApproved: (loanId, amount, rate) =>
        `✅ Specular Protocol: Loan Approved\n\n` +
        `Your loan request has been auto-approved!\n` +
        `• Loan ID: #${loanId}\n` +
        `• Amount: ${(amount / 1e6).toFixed(2)} USDC\n` +
        `• Interest rate: ${(rate / 100).toFixed(2)}% APR\n\n` +
        `Funds have been transferred to your wallet. Repay on time to build your reputation score.`,

    loanRepaid: (loanId, total) =>
        `💸 Specular Protocol: Loan Repaid\n\n` +
        `Loan #${loanId} repayment received: ${(total / 1e6).toFixed(2)} USDC\n` +
        `Your lender position has been credited with your share of interest earnings.`,

    dueSoon: (loanId, days) =>
        `⏰ Specular Protocol: Payment Reminder\n\n` +
        `Loan #${loanId} is due in ${days} day(s). Make sure your wallet has enough USDC.`,
};

async function main() {
    const PRIVATE_KEY  = process.env.PRIVATE_KEY;
    const LENDER_KEY   = process.env.LENDER_KEY;
    const USE_XMTP_DEV = process.env.XMTP_ENV !== 'production';

    console.log('='.repeat(60));
    console.log('  Specular XMTP Messaging Demo');
    console.log('='.repeat(60));

    // Check if XMTP is available
    let Client;
    try {
        ({ Client } = require('@xmtp/xmtp-js'));
        console.log('XMTP SDK found — running live demo\n');
    } catch {
        console.log('Note: @xmtp/xmtp-js not installed (npm install @xmtp/xmtp-js)');
        console.log('Running in simulation mode — showing message templates only\n');
        return simulationMode();
    }

    if (!PRIVATE_KEY || !LENDER_KEY) {
        console.log('No PRIVATE_KEY/LENDER_KEY env vars — running simulation mode\n');
        return simulationMode();
    }

    // ── Live XMTP demo ────────────────────────────────────────────────────────

    const provider    = new ethers.JsonRpcProvider(process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org');
    const agentWallet  = new ethers.Wallet(PRIVATE_KEY, provider);
    const lenderWallet = new ethers.Wallet(LENDER_KEY, provider);

    console.log(`Agent wallet:  ${agentWallet.address}`);
    console.log(`Lender wallet: ${lenderWallet.address}`);
    console.log(`XMTP env:      ${USE_XMTP_DEV ? 'dev' : 'production'}\n`);

    // Create XMTP clients for both parties
    console.log('--- Step 1: Creating XMTP identities ---');
    const [agentXmtp, lenderXmtp] = await Promise.all([
        Client.create(agentWallet,  { env: USE_XMTP_DEV ? 'dev' : 'production' }),
        Client.create(lenderWallet, { env: USE_XMTP_DEV ? 'dev' : 'production' }),
    ]);
    console.log('XMTP identities created for both parties');

    // Check if each can message the other
    console.log('\n--- Step 2: Checking messaging capability ---');
    const agentCanMsg  = await agentXmtp.canMessage(lenderWallet.address);
    const lenderCanMsg = await lenderXmtp.canMessage(agentWallet.address);
    console.log(`Agent  → Lender: ${agentCanMsg  ? 'Can message ✓' : 'No XMTP identity'}`);
    console.log(`Lender → Agent:  ${lenderCanMsg ? 'Can message ✓' : 'No XMTP identity'}`);

    if (!agentCanMsg || !lenderCanMsg) {
        console.log('One party lacks XMTP identity — using self-messaging for demo');
    }

    // Simulate loan lifecycle events with XMTP notifications
    console.log('\n--- Step 3: Simulated loan lifecycle messages ---');

    // Protocol → Lender: "New loan in your pool"
    await sendMessage(lenderXmtp, lenderWallet.address,
        TEMPLATES.loanApproved(42, 5_000_000, 700),
        'Protocol → Lender: loan approved notification'
    );

    // Protocol → Agent: "Repayment reminder"
    await sendMessage(agentXmtp, agentWallet.address,
        TEMPLATES.dueSoon(42, 3),
        'Protocol → Agent: due-soon reminder'
    );

    // Agent → Lender: "I repaid"
    const lenderTarget = agentCanMsg ? lenderWallet.address : agentWallet.address;
    await sendMessage(agentXmtp, lenderTarget,
        TEMPLATES.loanRepaid(42, 5_035_000),
        'Agent → Lender: repayment confirmation'
    );

    // Read messages from lender's perspective
    console.log('\n--- Step 4: Lender reads received messages ---');
    const convs = await lenderXmtp.conversations.list();
    for (const conv of convs.slice(0, 3)) {
        const messages = await conv.messages({ limit: 5 });
        if (messages.length > 0) {
            console.log(`\nConversation with ${conv.peerAddress.slice(0,8)}...:`);
            for (const msg of messages) {
                console.log(`  [${new Date(msg.sent).toISOString()}] ${msg.content.slice(0, 80)}...`);
            }
        }
    }

    console.log('\nXMTP demo complete.');
}

async function sendMessage(xmtpClient, toAddress, content, label) {
    try {
        const conv = await xmtpClient.conversations.newConversation(toAddress);
        await conv.send(content);
        console.log(`✓ Sent: "${label}"`);
    } catch (err) {
        console.log(`✗ Failed "${label}": ${err.message}`);
    }
}

function simulationMode() {
    console.log('=== SIMULATION MODE ===');
    console.log('The following messages would be sent via XMTP:\n');

    const mockLoan = { id: 42, amount: 5_000_000, rate: 700, days: 30 };

    console.log('1. Lender Notification (loan auto-approved):');
    console.log('─'.repeat(50));
    console.log(TEMPLATES.loanApproved(mockLoan.id, mockLoan.amount, mockLoan.rate));

    console.log('\n2. Agent Reminder (3 days before due):');
    console.log('─'.repeat(50));
    console.log(TEMPLATES.dueSoon(mockLoan.id, 3));

    console.log('\n3. Lender Confirmation (loan repaid):');
    console.log('─'.repeat(50));
    console.log(TEMPLATES.loanRepaid(mockLoan.id, 5_035_000));

    console.log('\n=== Integration Points ===');
    console.log('• LoanNotificationService listens to on-chain events');
    console.log('• Auto-sends XMTP messages to affected parties');
    console.log('• No centralized server — messages stored on XMTP network');
    console.log('• E2E encrypted, wallet-native communication');
    console.log('\nTo enable live XMTP:');
    console.log('  npm install @xmtp/xmtp-js');
    console.log('  PRIVATE_KEY=0x... LENDER_KEY=0x... node src/xmtp/demo-messaging.js');
}

main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
