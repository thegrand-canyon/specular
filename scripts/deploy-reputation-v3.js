/**
 * Deploy ReputationManagerV3 with Multi-Pool Support
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🚀 Deploying ReputationManagerV3\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();
    console.log('Deployer:', deployer.address);

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    console.log('Using AgentRegistry:', addresses.agentRegistry);
    console.log('');

    console.log('⏳ Deploying ReputationManagerV3...');
    const ReputationManagerV3 = await ethers.getContractFactory('ReputationManagerV3');
    const repManagerV3 = await ReputationManagerV3.deploy(addresses.agentRegistry);
    await repManagerV3.waitForDeployment();

    const repV3Address = await repManagerV3.getAddress();
    console.log('✅ ReputationManagerV3 deployed to:', repV3Address);
    console.log('');

    // Authorize both V2 and V3 lending pools
    console.log('⚙️  Authorizing lending pools...');

    if (addresses.lendingPoolV2) {
        console.log('  Authorizing V2:', addresses.lendingPoolV2);
        const authV2Tx = await repManagerV3.authorizePool(addresses.lendingPoolV2);
        await authV2Tx.wait();
        console.log('  ✅ V2 authorized');
    }

    console.log('  Authorizing V3:', addresses.lendingPool);
    const authV3Tx = await repManagerV3.authorizePool(addresses.lendingPool);
    await authV3Tx.wait();
    console.log('  ✅ V3 authorized');
    console.log('');

    // Save address
    addresses.reputationManagerV2 = addresses.reputationManager; // Backup old one
    addresses.reputationManagerV3 = repV3Address; // New V3

    fs.writeFileSync(addressesPath, JSON.stringify(addresses, null, 2));

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('✅ Deployment Complete!\n');
    console.log('📋 Updated Contract Addresses:');
    console.log('   AgentRegistry:           ', addresses.agentRegistry);
    console.log('   ReputationManagerV2:     ', addresses.reputationManagerV2, '(old)');
    console.log('   ReputationManagerV3:     ', repV3Address, '⭐ NEW');
    console.log('   LendingPoolV2:           ', addresses.lendingPoolV2);
    console.log('   LendingPoolV3:           ', addresses.lendingPool);
    console.log('');

    console.log('🎯 Next Steps:');
    console.log('1. Update V3 to use new ReputationManager:');
    console.log('   npx hardhat run scripts/connect-v3-to-rep-v3.js --network sepolia');
    console.log('');
    console.log('2. Migrate existing agent reputations:');
    console.log('   npx hardhat run scripts/migrate-reputations.js --network sepolia\n');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
