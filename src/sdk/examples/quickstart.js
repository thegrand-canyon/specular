const { ethers } = require('ethers');
const SpecularSDK = require('../SpecularSDK');

async function main() {
    console.log('\n🚀 Specular SDK Quickstart\n');

    const provider = new ethers.JsonRpcProvider(
        process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org'
    );
    
    const privateKey = process.env.PRIVATE_KEY || '0x4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac';
    const wallet = new ethers.Wallet(privateKey, provider);

    const sdk = new SpecularSDK({
        apiUrl: 'http://localhost:3001',
        wallet
    });

    console.log('Agent address: ' + wallet.address + '\n');

    console.log('Discovering Specular protocol...');
    const manifest = await sdk.discover();
    console.log('Protocol: ' + manifest.protocol + ' v' + manifest.version);
    console.log('Network: ' + manifest.network + '\n');

    console.log('Protocol Status:');
    const status = await sdk.getStatus();
    console.log('Total Pools: ' + status.totalPools + '\n');

    console.log('Your Agent Profile:');
    const profile = await sdk.getMyProfile();
    
    if (!profile.registered) {
        console.log('Not registered yet');
        console.log('Call sdk.register() to register\n');
    } else {
        console.log('Registered (Agent ID: ' + profile.agentId + ')');
        console.log('Reputation: ' + profile.reputationScore + '/1000');
        console.log('Credit Limit: ' + profile.creditLimit + '\n');
    }

    console.log('Available Liquidity Pools:');
    const pools = await sdk.getPools({ minLiquidity: 100 });
    console.log('Found ' + pools.activePools + ' pools\n');
    
    if (pools.pools.length > 0) {
        console.log('Top pools:');
        for (let j = 0; j < Math.min(3, pools.pools.length); j++) {
            const pool = pools.pools[j];
            console.log('  Agent ' + pool.agentId + ': ' + pool.availableLiquidity + ' USDC');
        }
    }

    console.log('\n✨ Quickstart complete!\n');
}

main().catch(console.error);
