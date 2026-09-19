/**
 * Example: Running the Webhook Server
 *
 * This server monitors blockchain events and notifies subscribed agents
 */

const { WebhookServer } = require('./WebhookServer');

async function main() {
    const server = new WebhookServer({
        port: 3002,
        rpcUrl: process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
        contracts: {
            marketplace: '0x048363A325A5B188b7FF157d725C5e329f0171D3',
            reputation: '0x94F2fa47c4488202a46dAA9038Ed9C9c4c07467F',
            registry: '0xE8c2c5c23E2fcbf67936f0E0F4eb8654A00bF1D0'
        },
        secretKey: process.env.WEBHOOK_SECRET || undefined
    });

    await server.start();

    console.log('\n📡 Webhook Server Running');
    console.log('========================\n');
    console.log('Endpoints:');
    console.log('  POST   /subscribe       - Subscribe to events');
    console.log('  GET    /subscribe       - Get your subscription');
    console.log('  DELETE /subscribe       - Unsubscribe');
    console.log('  GET    /events          - List available events');
    console.log('  GET    /subscriptions   - List all subscriptions');
    console.log('  GET    /health          - Health check\n');
    console.log('Available Events:');
    console.log('  - loan.requested');
    console.log('  - loan.approved');
    console.log('  - loan.repaid');
    console.log('  - loan.defaulted');
    console.log('  - loan.due_soon');
    console.log('  - reputation.updated');
    console.log('  - credit.limit_changed');
    console.log('  - agent.registered');
    console.log('  - pool.created');
    console.log('  - pool.liquidity_low\n');
}

main().catch((error) => {
    console.error('❌ Server error:', error);
    process.exit(1);
});
