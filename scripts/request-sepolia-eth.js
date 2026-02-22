/**
 * Helper script to get your Sepolia address for faucets
 */

const { ethers } = require('hardhat');

async function main() {
    const [deployer] = await ethers.getSigners();

    console.log('\n💰 GET FREE SEPOLIA ETH\n');
    console.log('Your Address:', deployer.address);
    console.log('\n📋 Copy this address and use it at these faucets:\n');

    console.log('1. PoW Faucet (RECOMMENDED - no wallet needed):');
    console.log('   https://sepolia-faucet.pk910.de/');
    console.log('   → Paste your address, click Start Mining, wait 10-15 min\n');

    console.log('2. Infura Faucet (if available):');
    console.log('   https://www.infura.io/faucet/sepolia');
    console.log('   → Paste your address, get ETH\n');

    console.log('3. Alchemy Faucet:');
    console.log('   https://www.alchemy.com/faucets/ethereum-sepolia');
    console.log('   → Paste your address, complete captcha\n');

    console.log('After getting ETH, run:');
    console.log('   npx hardhat run scripts/check-balance.js --network sepolia');
    console.log('\nThen deploy with:');
    console.log('   npx hardhat run scripts/deploy-v2.js --network sepolia\n');
}

main().catch(console.error);
