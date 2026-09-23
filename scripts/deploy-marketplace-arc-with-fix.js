/**
 * Deploy AgentLiquidityMarketplace with MAX_LENDERS_PER_POOL=50 fix to Arc Testnet
 *
 * This deployment includes the H-04 security fix that reduces the maximum
 * number of lenders per pool from 200 to 50 to prevent gas limit issues.
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🚀 DEPLOYING MARKETPLACE WITH SECURITY FIX TO ARC TESTNET\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();
    const balance = await ethers.provider.getBalance(deployer.address);

    console.log(`Deployer: ${deployer.address}`);
    console.log(`Balance: ${ethers.formatEther(balance)} ETH\n`);

    if (balance < ethers.parseEther('0.001')) {
        console.log('❌ Insufficient balance for deployment (need at least 0.001 ETH)\n');
        process.exit(1);
    }

    // Load Arc Testnet addresses for dependencies
    const arcAddressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const arcAddresses = JSON.parse(fs.readFileSync(arcAddressesPath, 'utf8'));

    console.log('📋 Using Arc Testnet Contract Addresses:\n');
    console.log(`   AgentRegistryV2: ${arcAddresses.agentRegistryV2}`);
    console.log(`   ReputationManagerV3: ${arcAddresses.reputationManagerV3}`);
    console.log(`   MockUSDC: ${arcAddresses.mockUSDC}\n`);

    console.log('🔧 Security Fix Details:\n');
    console.log('   MAX_LENDERS_PER_POOL: 200 → 50');
    console.log('   Reason: Prevent gas limit issues in _distributeInterest\n');

    console.log('⏳ Deploying AgentLiquidityMarketplace...\n');

    const AgentLiquidityMarketplace = await ethers.getContractFactory('AgentLiquidityMarketplace');

    const marketplace = await AgentLiquidityMarketplace.deploy(
        arcAddresses.agentRegistryV2,
        arcAddresses.reputationManagerV3,
        arcAddresses.mockUSDC
    );

    await marketplace.waitForDeployment();

    const marketplaceAddress = await marketplace.getAddress();
    const deploymentTx = marketplace.deploymentTransaction();

    if (deploymentTx) {
        const receipt = await deploymentTx.wait();

        console.log('✅ AgentLiquidityMarketplace Deployed!\n');
        console.log(`   Address: ${marketplaceAddress}`);
        console.log(`   Gas Used: ${receipt.gasUsed.toLocaleString()}`);
        console.log(`   Gas Price: ${ethers.formatUnits(receipt.gasPrice, 'gwei')} gwei`);

        const cost = receipt.gasUsed * receipt.gasPrice;
        console.log(`   Cost: ${ethers.formatEther(cost)} ETH\n`);

        // Verify the fix is in place
        console.log('🔍 Verifying Security Fix...\n');
        const maxLenders = await marketplace.MAX_LENDERS_PER_POOL();
        console.log(`   MAX_LENDERS_PER_POOL: ${maxLenders}`);

        if (maxLenders === 50n) {
            console.log('   ✅ Security fix verified!\n');
        } else {
            console.log(`   ⚠️  Warning: Expected 50, got ${maxLenders}\n`);
        }

        // Update Arc Testnet addresses file
        arcAddresses.agentLiquidityMarketplace_v4_note = 'Backed up before H-04 security fix deployment';
        arcAddresses.agentLiquidityMarketplace_v4 = arcAddresses.agentLiquidityMarketplace;
        arcAddresses.agentLiquidityMarketplace = marketplaceAddress;
        arcAddresses.upgradedAt_v5 = new Date().toISOString();
        arcAddresses.upgradeReason_v5 = '[H-04 FIX] MAX_LENDERS_PER_POOL reduced from 200 to 50';
        arcAddresses.deployerForUpgrade_v5 = deployer.address;

        fs.writeFileSync(arcAddressesPath, JSON.stringify(arcAddresses, null, 2));

        console.log('📁 Addresses saved to: src/config/arc-testnet-addresses.json\n');

        const remainingBalance = await ethers.provider.getBalance(deployer.address);
        console.log(`💰 Remaining Balance: ${ethers.formatEther(remainingBalance)} ETH\n`);

        console.log('═══════════════════════════════════════════════════════\n');
        console.log('✅ DEPLOYMENT COMPLETE!\n');
        console.log('🎉 Marketplace with security fix deployed to Arc Testnet!\n');
        console.log('⚠️  NEXT STEPS:\n');
        console.log('   1. Authorize marketplace in ReputationManagerV3');
        console.log('   2. Update API server config');
        console.log('   3. Test with integration tests');
        console.log('   4. Consider transferring ownership to secure wallet\n');

        console.log('📝 Authorization Command:\n');
        console.log(`   Use scripts/authorize-new-marketplace.js\n`);
    }
}

main().catch(error => {
    console.error('\n❌ Deployment failed:', error.message);
    console.error(error);
    process.exit(1);
});
