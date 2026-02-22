/**
 * Deploy Only AgentLiquidityMarketplace to Base Sepolia
 * Uses existing Sepolia contract addresses for dependencies
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🚀 DEPLOYING P2P MARKETPLACE TO BASE SEPOLIA\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();
    const balance = await ethers.provider.getBalance(deployer.address);

    console.log(`Deployer: ${deployer.address}`);
    console.log(`Balance: ${ethers.formatEther(balance)} ETH\n`);

    if (balance < ethers.parseEther('0.0001')) {
        console.log('❌ Insufficient balance for deployment\n');
        process.exit(1);
    }

    // Load Sepolia addresses for dependencies
    const sepoliaAddressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const sepoliaAddresses = JSON.parse(fs.readFileSync(sepoliaAddressesPath, 'utf8'));

    console.log('📋 Using Sepolia Contract Addresses for Dependencies:\n');
    console.log(`   AgentRegistry: ${sepoliaAddresses.agentRegistry}`);
    console.log(`   ReputationManagerV3: ${sepoliaAddresses.reputationManagerV3}`);
    console.log(`   MockUSDC: ${sepoliaAddresses.mockUSDC}\n`);

    console.log('⚠️  NOTE: These contracts exist on Sepolia, not Base Sepolia.');
    console.log('   This deployment is for TESTING the marketplace contract only.\n');

    console.log('⏳ Deploying AgentLiquidityMarketplace...\n');

    const AgentLiquidityMarketplace = await ethers.getContractFactory('AgentLiquidityMarketplace');

    const marketplace = await AgentLiquidityMarketplace.deploy(
        sepoliaAddresses.agentRegistry,
        sepoliaAddresses.reputationManagerV3,
        sepoliaAddresses.mockUSDC
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

        // Save to Base Sepolia addresses file
        const baseSepoliaAddresses = {
            agentLiquidityMarketplace: marketplaceAddress,
            deployedAt: new Date().toISOString(),
            deployer: deployer.address,
            network: 'baseSepolia',
            chainId: 84532,
            note: 'Dependencies reference Sepolia contracts - for testing only'
        };

        const baseSepoliaPath = path.join(__dirname, '..', 'src', 'config', 'base-sepolia-addresses.json');
        fs.writeFileSync(baseSepoliaPath, JSON.stringify(baseSepoliaAddresses, null, 2));

        console.log('📁 Addresses saved to: src/config/base-sepolia-addresses.json\n');

        const remainingBalance = await ethers.provider.getBalance(deployer.address);
        console.log(`💰 Remaining Balance: ${ethers.formatEther(remainingBalance)} ETH\n`);

        console.log('═══════════════════════════════════════════════════════\n');
        console.log('✅ DEPLOYMENT COMPLETE!\n');
        console.log('🎉 P2P Marketplace successfully deployed to Base Sepolia!\n');
        console.log('⚠️  Note: Full functionality requires deploying other contracts');
        console.log('   or bridging Sepolia contracts to Base Sepolia.\n');
    }
}

main().catch(error => {
    console.error('\n❌ Deployment failed:', error.message);
    process.exit(1);
});
