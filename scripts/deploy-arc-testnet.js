/**
 * Deploy to Arc Testnet
 * Arc uses USDC as native gas - no ETH needed!
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🚀 DEPLOYING TO ARC TESTNET\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();

    console.log(`Deployer: ${deployer.address}`);

    // Check USDC balance (native gas on Arc)
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log(`USDC Balance: ${ethers.formatEther(balance)} USDC\n`);

    if (balance < ethers.parseEther('10')) {
        console.log('⚠️  Warning: Low USDC balance. Get more from https://faucet.circle.com\n');
    }

    // Deploy contracts
    console.log('📝 Deploying Contracts...\n');

    // 1. AgentRegistry
    console.log('1️⃣  Deploying AgentRegistry...');
    const AgentRegistry = await ethers.getContractFactory('AgentRegistry');
    const agentRegistry = await AgentRegistry.deploy();
    await agentRegistry.waitForDeployment();
    const agentRegistryAddress = await agentRegistry.getAddress();
    console.log(`   ✅ AgentRegistry: ${agentRegistryAddress}\n`);

    // 2. ReputationManagerV3
    console.log('2️⃣  Deploying ReputationManagerV3...');
    const ReputationManagerV3 = await ethers.getContractFactory('ReputationManagerV3');
    const reputationManager = await ReputationManagerV3.deploy(agentRegistryAddress);
    await reputationManager.waitForDeployment();
    const reputationManagerAddress = await reputationManager.getAddress();
    console.log(`   ✅ ReputationManagerV3: ${reputationManagerAddress}\n`);

    // 3. USDC Token (ERC20 for testing - Arc has native USDC but we need pool token)
    console.log('3️⃣  Deploying USDC Token (for pools)...');
    const MockUSDC = await ethers.getContractFactory('MockUSDC');
    const usdc = await MockUSDC.deploy();
    await usdc.waitForDeployment();
    const usdcAddress = await usdc.getAddress();
    console.log(`   ✅ USDC Token: ${usdcAddress}\n`);

    // Mint initial USDC to deployer
    console.log('   Minting 2,000,000 USDC to deployer...');
    await usdc.mint(deployer.address, ethers.parseUnits('2000000', 6));
    console.log(`   ✅ Minted\n`);

    // 4. AgentLiquidityMarketplace
    console.log('4️⃣  Deploying AgentLiquidityMarketplace...');
    const AgentLiquidityMarketplace = await ethers.getContractFactory('AgentLiquidityMarketplace');
    const marketplace = await AgentLiquidityMarketplace.deploy(
        agentRegistryAddress,
        reputationManagerAddress,
        usdcAddress
    );
    await marketplace.waitForDeployment();
    const marketplaceAddress = await marketplace.getAddress();
    console.log(`   ✅ AgentLiquidityMarketplace: ${marketplaceAddress}\n`);

    // 5. Grant permissions
    console.log('5️⃣  Setting up permissions...');
    await reputationManager.authorizePool(marketplaceAddress);
    console.log('   ✅ Marketplace authorized in ReputationManager\n');

    // 6. Unpause marketplace
    console.log('6️⃣  Unpausing marketplace...');
    await marketplace.unpause();
    console.log('   ✅ Marketplace is active!\n');

    // Save addresses
    const addresses = {
        agentRegistry: agentRegistryAddress,
        reputationManagerV3: reputationManagerAddress,
        mockUSDC: usdcAddress,
        agentLiquidityMarketplace: marketplaceAddress
    };

    const configDir = path.join(__dirname, '..', 'src', 'config');
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }

    const addressesPath = path.join(configDir, 'arc-testnet-addresses.json');
    fs.writeFileSync(addressesPath, JSON.stringify(addresses, null, 2));

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 DEPLOYMENT SUMMARY\n');
    console.log('Network: Arc Testnet');
    console.log(`Chain ID: 5042002\n`);
    console.log('Deployed Contracts:');
    console.log(`  AgentRegistry:              ${agentRegistryAddress}`);
    console.log(`  ReputationManagerV3:        ${reputationManagerAddress}`);
    console.log(`  MockUSDC:                   ${usdcAddress}`);
    console.log(`  AgentLiquidityMarketplace:  ${marketplaceAddress}\n`);

    console.log(`📁 Addresses saved to: ${addressesPath}\n`);

    console.log('🔍 View on Arcscan:');
    console.log(`   https://testnet.arcscan.app/address/${marketplaceAddress}\n`);

    console.log('💡 Special Note:');
    console.log('   Arc uses USDC as native gas - all gas fees are paid in USDC!');
    console.log('   This means predictable, dollar-denominated fees.\n');

    console.log('🎯 NEXT STEPS:\n');
    console.log('1. Create test agents');
    console.log('2. Set up agent pools');
    console.log('3. Test lending functionality\n');

    console.log('✅ Deployment complete! 🚀\n');
}

main().catch(error => {
    console.error('Deployment failed:', error);
    process.exit(1);
});
