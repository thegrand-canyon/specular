/**
 * Check Deployer Balances on All Testnets
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
    console.log('\n' + '═'.repeat(70));
    console.log('  TESTNET BALANCE CHECK');
    console.log('═'.repeat(70));
    console.log(`\nDeployer Address: ${wallet.address}\n`);

    const chainKeys = ['baseSepolia', 'arbitrumSepolia', 'optimismSepolia', 'polygonAmoy'];
    let totalReady = 0;

    for (const key of chainKeys) {
        const chain = chains[key];
        try {
            const provider = new ethers.JsonRpcProvider(chain.rpc, undefined, { batchMaxCount: 1 });
            const balance = await provider.getBalance(wallet.address);
            const formatted = parseFloat(ethers.formatEther(balance)).toFixed(6);
            const hasEnough = parseFloat(formatted) >= 0.01;
            const icon = hasEnough ? '✅' : '❌';

            const token = key === 'polygonAmoy' ? 'MATIC' : 'ETH';
            console.log(`${icon} ${chain.name.padEnd(22)} ${formatted.padStart(12)} ${token}`);

            if (hasEnough) totalReady++;
        } catch (err) {
            console.log(`⚠️  ${chain.name.padEnd(22)} Failed: ${err.message.slice(0, 30)}`);
        }

        // Small delay to avoid rate limits
        await new Promise(r => setTimeout(r, 500));
    }

    console.log('\n' + '-'.repeat(70));
    console.log(`Testnets Ready: ${totalReady}/4`);
    console.log(`Minimum recommended: 0.01 per chain (FREE from faucets)\n`);

    if (totalReady === 4) {
        console.log('✅ All testnets funded and ready!\n');
    } else {
        console.log('⚠️  Some testnets need tokens (get FREE from faucets)\n');
        console.log('🚰 Testnet Faucets:\n');
        console.log('  Base Sepolia:     https://portal.cdp.coinbase.com/products/faucet');
        console.log('  Arbitrum Sepolia: https://faucet.quicknode.com/arbitrum/sepolia');
        console.log('  Optimism Sepolia: https://app.optimism.io/faucet');
        console.log('  Polygon Amoy:     https://faucet.polygon.technology\n');
    }

    console.log('═'.repeat(70) + '\n');

    return totalReady === 4;
}

checkBalances()
    .then(ready => process.exit(ready ? 0 : 1))
    .catch(error => {
        console.error('Error:', error);
        process.exit(1);
    });
