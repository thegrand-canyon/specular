const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🔓 UNPAUSING CONTRACT\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);

    console.log('Checking current state...');
    const paused = await marketplace.paused();
    console.log(`Currently paused: ${paused}\n`);

    if (paused) {
        console.log('Unpausing contract...');
        const tx = await marketplace.unpause();
        await tx.wait();
        console.log('✅ Contract unpaused!\n');

        const newState = await marketplace.paused();
        console.log(`New state - Paused: ${newState}\n`);
    } else {
        console.log('✅ Contract is already unpaused!\n');
    }
}

main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
