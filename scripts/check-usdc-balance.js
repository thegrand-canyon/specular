const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);
    const [deployer] = await ethers.getSigners();

    const balance = await usdc.balanceOf(deployer.address);
    console.log(`\nDeployer: ${deployer.address}`);
    console.log(`USDC Balance: ${ethers.formatUnits(balance, 6)} USDC\n`);
}

main().catch(console.error);
