/**
 * Deploy LendingPoolV3 with Auto-Approve
 *
 * This script deploys V3 to Sepolia using existing V2 infrastructure
 *
 * Usage: npx hardhat run scripts/deploy-v3.js --network sepolia
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🚀 Deploying LendingPoolV3 (Auto-Approve Upgrade)...\n');

    const [deployer] = await ethers.getSigners();
    console.log('Deploying with account:', deployer.address);

    const balance = await ethers.provider.getBalance(deployer.address);
    console.log('Account balance:', ethers.formatEther(balance), 'ETH\n');

    // Load existing V2 addresses
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    console.log('📋 Using existing contracts:');
    console.log('   AgentRegistry:', addresses.agentRegistry);
    console.log('   ReputationManager:', addresses.reputationManager);
    console.log('   MockUSDC:', addresses.mockUSDC);
    console.log('');

    // Deploy LendingPoolV3
    console.log('⏳ Deploying LendingPoolV3...');

    const LendingPoolV3 = await ethers.getContractFactory('LendingPoolV3');
    const lendingPoolV3 = await LendingPoolV3.deploy(
        addresses.agentRegistry,
        addresses.reputationManager,
        addresses.mockUSDC
    );

    await lendingPoolV3.waitForDeployment();
    const lendingPoolV3Address = await lendingPoolV3.getAddress();

    console.log('✅ LendingPoolV3 deployed to:', lendingPoolV3Address);

    // Note: ReputationManager can only be set once (security feature)
    // For V3 to work with reputation, we need a new ReputationManager or keep using V2
    console.log('\n⚠️  Note: ReputationManager is locked to V2');
    console.log('   V3 deployed as standalone pool for testing');
    console.log('   To use V3 with reputation, deploy new ReputationManager');
    console.log('   Or use V3 for new agents while V2 handles existing ones');

    // Configure auto-approve settings
    console.log('\n⚙️  Configuring auto-approve settings...');
    const configTx = await lendingPoolV3.setAutoApproveConfig(
        true, // enabled
        ethers.parseUnits('50000', 6), // max 50k USDC auto-approve
        100 // min 100 reputation
    );
    await configTx.wait();
    console.log('✅ Auto-approve configured:');
    console.log('   Enabled: true');
    console.log('   Max Amount: 50,000 USDC');
    console.log('   Min Reputation: 100');

    // Migrate liquidity from V2 (if desired)
    console.log('\n💧 Liquidity Migration Options:');
    console.log('   Option 1: Withdraw from V2, deposit to V3');
    console.log('   Option 2: Keep both pools running');
    console.log('   Option 3: Gradually migrate as V2 loans are repaid');
    console.log('\n   To migrate now, run:');
    console.log('   npx hardhat run scripts/migrate-liquidity-v2-to-v3.js --network sepolia');

    // Save V3 addresses
    addresses.lendingPoolV2 = addresses.lendingPool; // Backup V2 address
    addresses.lendingPool = lendingPoolV3Address; // V3 is now primary

    fs.writeFileSync(addressesPath, JSON.stringify(addresses, null, 2));

    console.log('\n✅ Deployment Complete!');
    console.log('\n📋 Updated Contract Addresses:');
    console.log('   AgentRegistry:      ', addresses.agentRegistry);
    console.log('   ReputationManager:  ', addresses.reputationManager);
    console.log('   ValidationRegistry: ', addresses.validationRegistry);
    console.log('   MockUSDC:           ', addresses.mockUSDC);
    console.log('   LendingPoolV2:      ', addresses.lendingPoolV2);
    console.log('   LendingPoolV3:      ', lendingPoolV3Address, '⭐ NEW');

    console.log('\n🎯 Next Steps:');
    console.log('1. Migrate liquidity:');
    console.log('   npx hardhat run scripts/migrate-liquidity-v2-to-v3.js --network sepolia');
    console.log('\n2. Test auto-approve:');
    console.log('   npx hardhat run scripts/test-auto-approve.js --network sepolia');
    console.log('\n3. Update website with new V3 address\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
