/**
 * Check Deployer Balance on Sepolia
 */

const { ethers } = require('hardhat');

async function main() {
    const [deployer] = await ethers.getSigners();
    const balance = await ethers.provider.getBalance(deployer.address);

    console.log('\n💰 Wallet Status:');
    console.log(`Address: ${deployer.address}`);
    console.log(`Balance: ${ethers.formatEther(balance)} ETH`);
    console.log(`Network: ${(await ethers.provider.getNetwork()).name}`);

    if (balance < ethers.parseEther('0.05')) {
        console.log('\n⚠️  Warning: You need at least 0.05 ETH for deployment');
        console.log('Get more from: https://www.alchemy.com/faucets/ethereum-sepolia');
    } else {
        console.log('\n✅ You have enough ETH for deployment!');
    }
    console.log('');
}

main().catch(console.error);
