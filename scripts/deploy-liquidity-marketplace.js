/**
 * Deploy AgentLiquidityMarketplace Contract
 * Allows P2P lending where users supply liquidity to specific agents
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🚀 Deploying Agent Liquidity Marketplace\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();
    console.log('Deployer:', deployer.address);

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    console.log('Using:');
    console.log('  AgentRegistry:', addresses.agentRegistry);
    console.log('  ReputationManagerV3:', addresses.reputationManagerV3);
    console.log('  MockUSDC:', addresses.mockUSDC);
    console.log('');

    // Deploy AgentLiquidityMarketplace
    console.log('⏳ Deploying AgentLiquidityMarketplace...');
    const AgentLiquidityMarketplace = await ethers.getContractFactory('AgentLiquidityMarketplace');
    const marketplace = await AgentLiquidityMarketplace.deploy(
        addresses.agentRegistry,
        addresses.reputationManagerV3,
        addresses.mockUSDC
    );
    await marketplace.waitForDeployment();

    const marketplaceAddress = await marketplace.getAddress();
    console.log('✅ AgentLiquidityMarketplace deployed to:', marketplaceAddress);
    console.log('');

    // Authorize marketplace in ReputationManagerV3
    console.log('⚙️  Authorizing marketplace in ReputationManagerV3...');
    const repManagerV3 = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);
    const authTx = await repManagerV3.authorizePool(marketplaceAddress);
    await authTx.wait();
    console.log('✅ Marketplace authorized');
    console.log('');

    // Save address
    addresses.agentLiquidityMarketplace = marketplaceAddress;
    fs.writeFileSync(addressesPath, JSON.stringify(addresses, null, 2));

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('✅ Deployment Complete!\n');
    console.log('📋 Contract Addresses:');
    console.log('   AgentLiquidityMarketplace:', marketplaceAddress, '⭐ NEW');
    console.log('   AgentRegistry:           ', addresses.agentRegistry);
    console.log('   ReputationManagerV3:     ', addresses.reputationManagerV3);
    console.log('   MockUSDC:                ', addresses.mockUSDC);
    console.log('');

    console.log('🎯 Next Steps:');
    console.log('1. Create agent pools:');
    console.log('   npx hardhat run scripts/create-agent-pools.js --network sepolia');
    console.log('');
    console.log('2. Test P2P lending:');
    console.log('   npx hardhat run scripts/test-p2p-lending.js --network sepolia\n');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
