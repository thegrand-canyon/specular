/**
 * Check Base Sepolia Setup
 */

const { ethers } = require('hardhat');

async function main() {
    console.log('\n🔍 CHECKING BASE SEPOLIA SETUP\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();

    console.log(`Deployer Address: ${deployer.address}`);

    const balance = await ethers.provider.getBalance(deployer.address);
    console.log(`Base Sepolia ETH Balance: ${ethers.formatEther(balance)} ETH\n`);

    if (balance === 0n) {
        console.log('❌ No Base Sepolia ETH found!\n');
        console.log('🔗 Get Base Sepolia ETH from:');
        console.log('   1. https://www.alchemy.com/faucets/base-sepolia');
        console.log('   2. https://docs.base.org/tools/network-faucets/\n');
        console.log('You need at least 0.01 ETH to deploy.\n');
    } else if (balance < ethers.parseEther('0.01')) {
        console.log('⚠️  Low balance! You have ETH but might need more.\n');
        console.log('🔗 Get more Base Sepolia ETH from:');
        console.log('   https://www.alchemy.com/faucets/base-sepolia\n');
    } else {
        console.log('✅ Sufficient Base Sepolia ETH for deployment!\n');
        console.log('Ready to deploy P2P Marketplace to Base Sepolia.\n');
    }

    // Check network
    const network = await ethers.provider.getNetwork();
    console.log(`Network: ${network.name} (Chain ID: ${network.chainId})`);

    if (network.chainId === 84532n) {
        console.log('✅ Connected to Base Sepolia\n');
    } else {
        console.log(`❌ Not connected to Base Sepolia (expected Chain ID: 84532)\n`);
    }
}

main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
