/**
 * Check Deployer Balances on All Chains
 */

const { ethers } = require('ethers');
const chains = require('../src/config/chains.json');

async function checkBalances() {
    const privateKey = process.env.PRIVATE_KEY;

    if (!privateKey || privateKey === '0x0000000000000000000000000000000000000000000000000000000000000000') {
        console.log('\n❌ PRIVATE_KEY not set in environment\n');
        console.log('Set it with: export PRIVATE_KEY=0x...\n');
        process.exit(1);
    }

    const wallet = new ethers.Wallet(privateKey);
    console.log('\n' + '═'.repeat(60));
    console.log('  DEPLOYER BALANCE CHECK');
    console.log('═'.repeat(60));
    console.log(`\nDeployer Address: ${wallet.address}\n`);

    const chainKeys = ['base', 'arbitrum', 'optimism', 'polygon'];
    let totalReady = 0;

    for (const key of chainKeys) {
        const chain = chains[key];
        try {
            const provider = new ethers.JsonRpcProvider(chain.rpc, undefined, { batchMaxCount: 1 });
            const balance = await provider.getBalance(wallet.address);
            const formatted = parseFloat(ethers.formatEther(balance)).toFixed(6);
            const hasEnough = parseFloat(formatted) >= 0.01;
            const icon = hasEnough ? '✅' : '❌';

            console.log(`${icon} ${chain.name.padEnd(18)} ${formatted.padStart(12)} ${key === 'polygon' ? 'MATIC' : 'ETH'}`);

            if (hasEnough) totalReady++;
        } catch (err) {
            console.log(`⚠️  ${chain.name.padEnd(18)} Failed: ${err.message.slice(0, 40)}`);
        }

        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 500));
    }

    console.log('\n' + '-'.repeat(60));
    console.log(`Chains Ready: ${totalReady}/4`);
    console.log(`Minimum recommended: 0.01 per chain (0.04 total)`);
    console.log(`Estimated deployment cost: $60-100 total\n`);

    if (totalReady === 4) {
        console.log('✅ All chains funded and ready for deployment!\n');
    } else {
        console.log('⚠️  Some chains need funding before deployment\n');
        console.log('Fund addresses at:');
        console.log('  Base:     https://bridge.base.org');
        console.log('  Arbitrum: https://bridge.arbitrum.io');
        console.log('  Optimism: https://app.optimism.io/bridge');
        console.log('  Polygon:  https://wallet.polygon.technology/bridge\n');
    }

    console.log('═'.repeat(60) + '\n');

    return totalReady === 4;
}

checkBalances()
    .then(ready => process.exit(ready ? 0 : 1))
    .catch(error => {
        console.error('Error:', error);
        process.exit(1);
    });
