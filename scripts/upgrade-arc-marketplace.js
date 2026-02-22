/**
 * Upgrade Arc Testnet Marketplace
 *
 * Deploys new marketplace with resetPoolAccounting function
 */

const { ethers } = require('hardhat');
const fs = require('fs');

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║    UPGRADE ARC MARKETPLACE CONTRACT             ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const [deployer] = await ethers.getSigners();
    console.log(`Deployer: ${deployer.address}\n`);

    // Load existing addresses
    const addresses = JSON.parse(
        fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8')
    );

    console.log('Existing contracts:');
    console.log(`  AgentRegistryV2: ${addresses.agentRegistryV2}`);
    console.log(`  ReputationManagerV3: ${addresses.reputationManagerV3}`);
    console.log(`  MockUSDC: ${addresses.mockUSDC}`);
    console.log(`  OLD Marketplace: ${addresses.agentLiquidityMarketplace}\n`);

    // Deploy new marketplace
    console.log('Deploying upgraded AgentLiquidityMarketplace...\n');

    const AgentLiquidityMarketplace = await ethers.getContractFactory('AgentLiquidityMarketplace');
    const marketplace = await AgentLiquidityMarketplace.deploy(
        addresses.agentRegistryV2,
        addresses.reputationManagerV3,
        addresses.mockUSDC
    );

    await marketplace.waitForDeployment();
    const marketplaceAddress = await marketplace.getAddress();

    console.log(`✅ New Marketplace deployed: ${marketplaceAddress}\n`);

    // Update config
    const updatedConfig = {
        ...addresses,
        agentLiquidityMarketplace_v2: addresses.agentLiquidityMarketplace,
        agentLiquidityMarketplace_v2_note: "Backed up before resetPoolAccounting upgrade",
        agentLiquidityMarketplace: marketplaceAddress,
        upgradedAt_v3: new Date().toISOString(),
        upgradeReason_v3: "Added resetPoolAccounting emergency function",
    };

    fs.writeFileSync(
        './src/config/arc-testnet-addresses.json',
        JSON.stringify(updatedConfig, null, 2)
    );

    console.log('✅ Config updated\n');

    // Grant marketplace permission in ReputationManager
    console.log('Granting marketplace permission in ReputationManager...\n');

    const ReputationManager = await ethers.getContractFactory('ReputationManagerV3');
    const reputationManager = ReputationManager.attach(addresses.reputationManagerV3);

    try {
        const grantTx = await reputationManager.grantRole(
            ethers.keccak256(ethers.toUtf8Bytes('MARKETPLACE_ROLE')),
            marketplaceAddress
        );
        await grantTx.wait();
        console.log('✅ Marketplace role granted\n');
    } catch (e) {
        console.log(`⚠️  Role grant may have failed: ${e.message}\n`);
    }

    // Summary
    console.log('═'.repeat(70));
    console.log('DEPLOYMENT SUMMARY');
    console.log('═'.repeat(70) + '\n');

    console.log('New Marketplace:');
    console.log(`  Address: ${marketplaceAddress}`);
    console.log(`  Features: resetPoolAccounting() emergency function`);
    console.log(`  Status: Ready to use\n`);

    console.log('Next Steps:');
    console.log('  1. Create new agent pool in new marketplace');
    console.log('  2. Supply liquidity to new pool');
    console.log('  3. Test loan cycle to verify fix\n');

    console.log('═'.repeat(70) + '\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
