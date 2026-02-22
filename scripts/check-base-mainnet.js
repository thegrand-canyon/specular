/**
 * Check Base Mainnet Setup
 */

const { ethers } = require('hardhat');

async function main() {
    console.log('\n🔍 CHECKING BASE MAINNET SETUP\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();

    console.log(`Deployer Address: ${deployer.address}`);

    const balance = await ethers.provider.getBalance(deployer.address);
    console.log(`Base Mainnet ETH Balance: ${ethers.formatEther(balance)} ETH\n`);

    // Get ETH price (approximate)
    const ethPriceUSD = 3000; // Approximate
    const balanceUSD = parseFloat(ethers.formatEther(balance)) * ethPriceUSD;
    console.log(`Approximate USD Value: $${balanceUSD.toFixed(2)}\n`);

    if (balance === 0n) {
        console.log('❌ No Base Mainnet ETH found!\n');
        console.log('🔗 You need to bridge ETH to Base Mainnet:');
        console.log('   1. https://bridge.base.org/');
        console.log('   2. Or use Coinbase (if you have an account)\n');
        console.log('You need at least 0.002 ETH (~$6) to deploy.\n');
    } else if (balance < ethers.parseEther('0.002')) {
        console.log('⚠️  Low balance! You have ETH but might need more.\n');
        console.log(`   Current: ${ethers.formatEther(balance)} ETH`);
        console.log(`   Recommended: 0.005 ETH (~$15) for safe deployment\n`);
    } else {
        console.log('✅ Sufficient Base Mainnet ETH for deployment!\n');
        console.log(`   Estimated deployment cost: 0.001-0.002 ETH (~$3-6)\n`);
        console.log('🚨 IMPORTANT: This is REAL MONEY on MAINNET!\n');
        console.log('   - Deploying to production blockchain');
        console.log('   - Costs real ETH');
        console.log('   - Contract will be permanent and public\n');
    }

    // Check network
    const network = await ethers.provider.getNetwork();
    console.log(`Network: ${network.name} (Chain ID: ${network.chainId})`);

    if (network.chainId === 8453n) {
        console.log('✅ Connected to Base Mainnet\n');
        console.log('🚨 WARNING: YOU ARE ON MAINNET - REAL MONEY! 🚨\n');
    } else {
        console.log(`❌ Not connected to Base Mainnet (expected Chain ID: 8453)\n`);
    }
}

main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
