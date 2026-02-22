/**
 * Quick Sepolia Balance Check
 */

const { ethers } = require('hardhat');

async function main() {
    const [deployer] = await ethers.getSigners();
    const balance = await ethers.provider.getBalance(deployer.address);

    console.log('\n💰 SEPOLIA ETH BALANCE\n');
    console.log(`Address: ${deployer.address}`);
    console.log(`Balance: ${ethers.formatEther(balance)} ETH\n`);

    if (balance < ethers.parseEther('0.05')) {
        console.log('⚠️  Low ETH! Need ~0.5 ETH to create 10 agents.\n');
    } else {
        console.log('✅ Sufficient ETH\n');
    }
}

main().catch(console.error);
