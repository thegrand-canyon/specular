const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);

    console.log('\n📊 CONTRACT STATE CHECK\n');

    try {
        const paused = await marketplace.paused();
        console.log(`Paused: ${paused}`);
    } catch (e) {
        console.log(`Paused check failed: ${e.message}`);
    }

    try {
        const owner = await marketplace.owner();
        console.log(`Owner: ${owner}`);
    } catch (e) {
        console.log(`Owner check failed: ${e.message}`);
    }

    const [deployer] = await ethers.getSigners();
    console.log(`Deployer: ${deployer.address}`);
    console.log('');
}

main().catch(console.error);
