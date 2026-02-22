/**
 * Deploy only LendingPoolV2 (for when other contracts are already deployed)
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🏦 Deploying LendingPoolV2...\n');

    const [deployer] = await ethers.getSigners();
    console.log('Deploying with account:', deployer.address);

    // These were already deployed
    const addresses = {
        agentRegistry: '0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb',
        reputationManager: '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF',
        validationRegistry: '0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE',
        mockUSDC: '0x771c293167AeD146EC4f56479056645Be46a0275'
    };

    // Deploy LendingPoolV2
    const LendingPoolV2 = await ethers.getContractFactory('LendingPoolV2');
    const lendingPool = await LendingPoolV2.deploy(
        addresses.agentRegistry,
        addresses.reputationManager,
        addresses.mockUSDC
    );
    await lendingPool.waitForDeployment();
    addresses.lendingPool = await lendingPool.getAddress();

    console.log('✅ LendingPoolV2 deployed to:', addresses.lendingPool);

    // Set lending pool in ReputationManager
    console.log('\n⚙️  Setting up permissions...');
    const reputationManager = await ethers.getContractAt('ReputationManagerV2', addresses.reputationManager);
    const tx = await reputationManager.setLendingPool(addresses.lendingPool);
    await tx.wait();
    console.log('✅ LendingPool authorized in ReputationManager');

    // Save addresses
    const configDir = path.join(__dirname, '..', 'src', 'config');
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }
    fs.writeFileSync(
        path.join(configDir, 'sepolia-addresses.json'),
        JSON.stringify(addresses, null, 2)
    );

    console.log('\n✅ Deployment complete!');
    console.log('\n📋 All Contract Addresses:');
    console.log('   AgentRegistryV2:      ', addresses.agentRegistry);
    console.log('   ReputationManagerV2:  ', addresses.reputationManager);
    console.log('   ValidationRegistry:   ', addresses.validationRegistry);
    console.log('   MockUSDC:             ', addresses.mockUSDC);
    console.log('   LendingPoolV2:        ', addresses.lendingPool);
    console.log('\n📁 Saved to: src/config/sepolia-addresses.json\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
