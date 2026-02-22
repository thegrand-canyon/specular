/**
 * Upgrade AgentLiquidityMarketplace on Arc Testnet
 * Deploys new marketplace with concurrent loan limits fix [SECURITY-01]
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🔄 UPGRADING MARKETPLACE ON ARC TESTNET\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();
    const balance = await ethers.provider.getBalance(deployer.address);

    console.log(`Deployer: ${deployer.address}`);
    console.log(`Balance: ${ethers.formatEther(balance)} ETH\n`);

    // Load Arc Testnet addresses for dependencies
    const arcAddressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const arcAddresses = JSON.parse(fs.readFileSync(arcAddressesPath, 'utf8'));

    console.log('📋 Using Arc Testnet Contract Addresses:\n');
    console.log(`   AgentRegistryV2: ${arcAddresses.agentRegistryV2}`);
    console.log(`   ReputationManagerV3: ${arcAddresses.reputationManagerV3}`);
    console.log(`   MockUSDC: ${arcAddresses.mockUSDC}`);
    console.log(`   Current Marketplace: ${arcAddresses.agentLiquidityMarketplace}\n`);

    console.log('🔍 Deploying NEW AgentLiquidityMarketplace with [SECURITY-01] fix...\n');
    console.log('   - MAX_ACTIVE_LOANS_PER_AGENT = 10');
    console.log('   - Prevents credit limit bypass via loan fragmentation\n');

    const AgentLiquidityMarketplace = await ethers.getContractFactory('AgentLiquidityMarketplace');

    const newMarketplace = await AgentLiquidityMarketplace.deploy(
        arcAddresses.agentRegistryV2,
        arcAddresses.reputationManagerV3,
        arcAddresses.mockUSDC
    );

    await newMarketplace.waitForDeployment();

    const newMarketplaceAddress = await newMarketplace.getAddress();
    const deploymentTx = newMarketplace.deploymentTransaction();

    if (deploymentTx) {
        const receipt = await deploymentTx.wait();

        console.log('✅ New AgentLiquidityMarketplace Deployed!\n');
        console.log(`   Address: ${newMarketplaceAddress}`);
        console.log(`   Gas Used: ${receipt.gasUsed.toLocaleString()}`);
        console.log(`   Block: ${receipt.blockNumber}\n`);

        // Verify the constant is set correctly
        const maxActiveLoans = await newMarketplace.MAX_ACTIVE_LOANS_PER_AGENT();
        console.log(`✓ MAX_ACTIVE_LOANS_PER_AGENT: ${maxActiveLoans}\n`);

        console.log('⚙️  Post-Deployment Steps Required:\n');
        console.log('   1. Authorize new marketplace in ReputationManagerV3:');
        console.log(`      await reputationManager.authorizePool("${newMarketplaceAddress}")\n`);
        console.log('   2. Update frontend/SDK to use new marketplace address\n');
        console.log('   3. Optionally pause old marketplace:\n');
        console.log(`      await oldMarketplace.pause()\n`);
        console.log('   4. Test with a small loan on new marketplace\n');
        console.log('   5. Update arc-testnet-addresses.json\n');

        // Backup old addresses
        const backup = {
            ...arcAddresses,
            agentLiquidityMarketplace_old: arcAddresses.agentLiquidityMarketplace,
            agentLiquidityMarketplace_old_note: 'Backed up before [SECURITY-01] upgrade',
            agentLiquidityMarketplace: newMarketplaceAddress,
            upgradedAt: new Date().toISOString(),
            upgradeReason: '[SECURITY-01] Added concurrent loan limits',
            deployerForUpgrade: deployer.address
        };

        const backupPath = path.join(__dirname, '..', 'src', 'config', `arc-testnet-addresses-backup-${Date.now()}.json`);
        fs.writeFileSync(backupPath, JSON.stringify(arcAddresses, null, 2));
        console.log(`📁 Old addresses backed up to: ${backupPath}\n`);

        // Update main addresses file
        fs.writeFileSync(arcAddressesPath, JSON.stringify(backup, null, 2));
        console.log(`📁 Updated: src/config/arc-testnet-addresses.json\n`);

        const remainingBalance = await ethers.provider.getBalance(deployer.address);
        console.log(`💰 Remaining Balance: ${ethers.formatEther(remainingBalance)} ETH\n`);

        console.log('═══════════════════════════════════════════════════════\n');
        console.log('✅ UPGRADE DEPLOYMENT COMPLETE!\n');
        console.log('⚠️  MANUAL STEPS REQUIRED (see above)\n');
        console.log('📊 To authorize the new marketplace, run:');
        console.log(`   npx hardhat run scripts/authorize-new-marketplace.js --network arcTestnet\n`);
    }
}

main().catch(error => {
    console.error('\n❌ Deployment failed:', error.message);
    process.exit(1);
});
