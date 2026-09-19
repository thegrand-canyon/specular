/**
 * Example: Agent Subscribing to Webhooks
 *
 * Shows how an agent can subscribe to Specular events
 * and receive real-time notifications
 */

const { ethers } = require('ethers');
const { WebhookClient } = require('./WebhookClient');
const express = require('express');

async function main() {
    // Setup wallet
    const provider = new ethers.JsonRpcProvider(
        process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org'
    );
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    // Create webhook client
    const client = new WebhookClient({
        webhookServerUrl: 'http://localhost:3002',
        wallet
    });

    console.log('🤖 Agent:', wallet.address);
    console.log('');

    // Step 1: Check available events
    console.log('Step 1: Checking available events...\n');
    const availableEvents = await client.getAvailableEvents();
    console.log('Available Events:');
    Object.entries(availableEvents.description).forEach(([event, desc]) => {
        console.log(`  - ${event}: ${desc}`);
    });
    console.log('');

    // Step 2: Start webhook receiver
    console.log('Step 2: Starting webhook receiver on port 3003...\n');

    const secret = 'my-webhook-secret';

    const app = WebhookClient.createReceiver(secret, {
        'loan.requested': (data) => {
            console.log('📢 WEBHOOK: Loan requested!');
            console.log(`   Loan ID: ${data.data.loanId}`);
            console.log(`   Amount: ${data.data.amount} USDC`);
            console.log(`   Duration: ${data.data.durationDays} days\n`);
        },

        'loan.repaid': (data) => {
            console.log('📢 WEBHOOK: Loan repaid!');
            console.log(`   Loan ID: ${data.data.loanId}`);
            console.log(`   Amount: ${data.data.amount} USDC`);
            console.log(`   Interest: ${data.data.interest} USDC\n`);
        },

        'reputation.updated': (data) => {
            console.log('📢 WEBHOOK: Reputation updated!');
            console.log(`   Agent: ${data.data.agent}`);
            console.log(`   Score Change: ${data.data.scoreChange}`);
            console.log(`   New Score: ${data.data.newScore}\n`);
        },

        'credit.limit_changed': (data) => {
            console.log('📢 WEBHOOK: Credit limit changed!');
            console.log(`   Agent: ${data.data.agent}`);
            console.log(`   Old Limit: ${data.data.oldLimit} USDC`);
            console.log(`   New Limit: ${data.data.newLimit} USDC\n`);
        },

        'loan.due_soon': (data) => {
            console.log('📢 WEBHOOK: Loan due soon!');
            console.log(`   Loan ID: ${data.data.loanId}`);
            console.log(`   Due Date: ${data.data.dueDate}`);
            console.log(`   Amount Due: ${data.data.totalDue} USDC\n`);
        },

        'agent.registered': (data) => {
            console.log('📢 WEBHOOK: Agent registered!');
            console.log(`   Agent ID: ${data.data.agentId}`);
            console.log(`   Address: ${data.data.agentAddress}\n`);
        },

        'pool.created': (data) => {
            console.log('📢 WEBHOOK: Pool created!');
            console.log(`   Pool ID: ${data.data.poolId}`);
            console.log(`   Agent ID: ${data.data.agentId}`);
            console.log(`   Lender: ${data.data.lender}\n`);
        },

        'liquidity.supplied': (data) => {
            console.log('📢 WEBHOOK: Liquidity supplied!');
            console.log(`   Pool ID: ${data.data.poolId}`);
            console.log(`   Lender: ${data.data.lender}`);
            console.log(`   Amount: ${data.data.amount} USDC\n`);
        },

        'liquidity.withdrawn': (data) => {
            console.log('📢 WEBHOOK: Liquidity withdrawn!');
            console.log(`   Pool ID: ${data.data.poolId}`);
            console.log(`   Lender: ${data.data.lender}`);
            console.log(`   Amount: ${data.data.amount} USDC`);
            console.log(`   Interest: ${data.data.interest} USDC`);
            console.log(`   Total: ${data.data.total} USDC\n`);
        }
    });

    const webhookServer = app.listen(3003, () => {
        console.log('✅ Webhook receiver running on http://localhost:3003/webhook\n');
    });

    // Step 3: Subscribe to events
    console.log('Step 3: Subscribing to events...\n');

    const events = [
        'loan.requested',
        'loan.repaid',
        'reputation.updated',
        'credit.limit_changed',
        'loan.due_soon',
        'agent.registered',
        'pool.created'
    ];

    try {
        const subscription = await client.subscribe(
            'http://localhost:3003/webhook',
            events,
            secret
        );

        console.log('✅ Subscription successful!\n');
        console.log('Subscribed to events:');
        subscription.events.forEach(e => console.log(`  - ${e}`));
        console.log('');
        console.log('Webhook URL:', subscription.webhookUrl);
        console.log('Secret:', subscription.secret);
        console.log('');
    } catch (error) {
        console.error('❌ Subscription failed:', error.message);
        process.exit(1);
    }

    // Step 4: Wait for events
    console.log('🎣 Listening for events...');
    console.log('Press Ctrl+C to stop\n');

    // Graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\n\n🛑 Shutting down...');

        try {
            await client.unsubscribe();
            console.log('✅ Unsubscribed from webhooks');
        } catch (error) {
            console.error('❌ Unsubscribe error:', error.message);
        }

        webhookServer.close(() => {
            console.log('✅ Webhook receiver stopped');
            process.exit(0);
        });
    });
}

main().catch((error) => {
    console.error('❌ Error:', error);
    process.exit(1);
});
