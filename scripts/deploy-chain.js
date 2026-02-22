/**
 * Deploy Specular Protocol to a Single Chain
 *
 * Usage:
 *   npx hardhat run scripts/deploy-chain.js --network base
 *   npx hardhat run scripts/deploy-chain.js --network arbitrum
 *   npx hardhat run scripts/deploy-chain.js --network optimism
 *   npx hardhat run scripts/deploy-chain.js --network polygon
 */

const { ethers, network } = require('hardhat');
const fs = require('fs');
const path = require('path');

// Load chain configurations
const chains = require('../src/config/chains.json');

async function main() {
    console.log('\n' + '═'.repeat(80));
    console.log(`  DEPLOYING SPECULAR PROTOCOL TO ${network.name.toUpperCase()}`);
    console.log('═'.repeat(80) + '\n');

    // Get deployer
    const [deployer] = await ethers.getSigners();
    console.log(`Deployer: ${deployer.address}`);

    const balance = await ethers.provider.getBalance(deployer.address);
    console.log(`Balance: ${ethers.formatEther(balance)} ETH\n`);

    // Get chain config
    const chainKey = network.name === 'arcTestnet' ? 'arc-testnet' : network.name;
    const chainConfig = chains[chainKey];

    if (!chainConfig) {
        throw new Error(`Chain configuration not found for ${chainKey}`);
    }

    console.log(`Chain: ${chainConfig.name} (chainId: ${chainConfig.chainId})`);
    console.log(`USDC: ${chainConfig.usdc.address} (${chainConfig.usdc.type})`);
    console.log(`Explorer: ${chainConfig.explorer}\n`);

    const deployedContracts = {};
    const startTime = Date.now();

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Deploy or Use Existing USDC
    // ─────────────────────────────────────────────────────────────────────────

    console.log('─'.repeat(80));
    console.log('1. USDC Token');
    console.log('─'.repeat(80));

    if (chainConfig.usdc.type === 'mock') {
        // Deploy MockUSDC for testnets
        console.log('Deploying MockUSDC...');
        const MockUSDC = await ethers.getContractFactory('MockUSDC');
        const usdc = await MockUSDC.deploy();
        await usdc.waitForDeployment();

        deployedContracts.mockUSDC = await usdc.getAddress();
        console.log(`✓ MockUSDC deployed: ${deployedContracts.mockUSDC}\n`);
    } else {
        // Use existing USDC for mainnets
        deployedContracts.usdc = chainConfig.usdc.address;
        console.log(`✓ Using native USDC: ${deployedContracts.usdc}\n`);
    }

    const usdcAddress = deployedContracts.mockUSDC || deployedContracts.usdc;

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Deploy AgentRegistryV2
    // ─────────────────────────────────────────────────────────────────────────

    console.log('─'.repeat(80));
    console.log('2. AgentRegistryV2');
    console.log('─'.repeat(80));
    console.log('Deploying AgentRegistryV2...');

    const AgentRegistryV2 = await ethers.getContractFactory('AgentRegistryV2');
    const registry = await AgentRegistryV2.deploy();
    await registry.waitForDeployment();

    deployedContracts.agentRegistryV2 = await registry.getAddress();
    console.log(`✓ AgentRegistryV2 deployed: ${deployedContracts.agentRegistryV2}\n`);

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Deploy ReputationManagerV3
    // ─────────────────────────────────────────────────────────────────────────

    console.log('─'.repeat(80));
    console.log('3. ReputationManagerV3');
    console.log('─'.repeat(80));
    console.log('Deploying ReputationManagerV3...');

    const ReputationManagerV3 = await ethers.getContractFactory('ReputationManagerV3');
    const reputation = await ReputationManagerV3.deploy(deployedContracts.agentRegistryV2);
    await reputation.waitForDeployment();

    deployedContracts.reputationManagerV3 = await reputation.getAddress();
    console.log(`✓ ReputationManagerV3 deployed: ${deployedContracts.reputationManagerV3}\n`);

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Deploy AgentLiquidityMarketplace
    // ─────────────────────────────────────────────────────────────────────────

    console.log('─'.repeat(80));
    console.log('4. AgentLiquidityMarketplace');
    console.log('─'.repeat(80));
    console.log('Deploying AgentLiquidityMarketplace...');

    const Marketplace = await ethers.getContractFactory('AgentLiquidityMarketplace');
    const marketplace = await Marketplace.deploy(
        deployedContracts.agentRegistryV2,
        deployedContracts.reputationManagerV3,
        usdcAddress
    );
    await marketplace.waitForDeployment();

    deployedContracts.agentLiquidityMarketplace = await marketplace.getAddress();
    console.log(`✓ AgentLiquidityMarketplace deployed: ${deployedContracts.agentLiquidityMarketplace}\n`);

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Deploy ValidationRegistry (Optional)
    // ─────────────────────────────────────────────────────────────────────────

    console.log('─'.repeat(80));
    console.log('5. ValidationRegistry');
    console.log('─'.repeat(80));
    console.log('Deploying ValidationRegistry...');

    const ValidationRegistry = await ethers.getContractFactory('ValidationRegistry');
    const validationRegistry = await ValidationRegistry.deploy();
    await validationRegistry.waitForDeployment();

    deployedContracts.validationRegistry = await validationRegistry.getAddress();
    console.log(`✓ ValidationRegistry deployed: ${deployedContracts.validationRegistry}\n`);

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Setup Permissions
    // ─────────────────────────────────────────────────────────────────────────

    console.log('─'.repeat(80));
    console.log('6. Setup Permissions');
    console.log('─'.repeat(80));
    console.log('Authorizing marketplace in ReputationManager...');

    const authTx = await reputation.authorizePool(deployedContracts.agentLiquidityMarketplace);
    await authTx.wait();
    console.log(`✓ Marketplace authorized\n`);

    // ─────────────────────────────────────────────────────────────────────────
    // 7. Save Deployment Info
    // ─────────────────────────────────────────────────────────────────────────

    const deploymentInfo = {
        ...deployedContracts,
        network: chainConfig.name,
        chainId: chainConfig.chainId,
        deployer: deployer.address,
        deployedAt: new Date().toISOString(),
        blockNumber: await ethers.provider.getBlockNumber(),
        deploymentTime: `${((Date.now() - startTime) / 1000).toFixed(2)}s`
    };

    // Save to chain-specific file
    const configDir = path.join(__dirname, '..', 'src', 'config');
    const outputFile = path.join(configDir, `${chainKey}-addresses.json`);

    fs.writeFileSync(outputFile, JSON.stringify(deploymentInfo, null, 2));
    console.log('─'.repeat(80));
    console.log('7. Deployment Complete');
    console.log('─'.repeat(80));
    console.log(`✓ Addresses saved to: ${outputFile}\n`);

    // ─────────────────────────────────────────────────────────────────────────
    // Summary
    // ─────────────────────────────────────────────────────────────────────────

    console.log('═'.repeat(80));
    console.log('  DEPLOYMENT SUMMARY');
    console.log('═'.repeat(80));
    console.log(`\nNetwork:        ${chainConfig.name}`);
    console.log(`Chain ID:       ${chainConfig.chainId}`);
    console.log(`Deployer:       ${deployer.address}`);
    console.log(`Block:          ${deploymentInfo.blockNumber}`);
    console.log(`Time:           ${deploymentInfo.deploymentTime}\n`);

    console.log('Contracts Deployed:');
    if (deployedContracts.mockUSDC) {
        console.log(`  MockUSDC:                   ${deployedContracts.mockUSDC}`);
    } else {
        console.log(`  USDC (native):              ${deployedContracts.usdc}`);
    }
    console.log(`  AgentRegistryV2:            ${deployedContracts.agentRegistryV2}`);
    console.log(`  ReputationManagerV3:        ${deployedContracts.reputationManagerV3}`);
    console.log(`  AgentLiquidityMarketplace:  ${deployedContracts.agentLiquidityMarketplace}`);
    console.log(`  ValidationRegistry:         ${deployedContracts.validationRegistry}\n`);

    console.log(`Explorer: ${chainConfig.explorer}`);
    console.log(`\nVerify contracts with:`);
    console.log(`  npx hardhat verify --network ${network.name} <address> <constructor-args>\n`);

    console.log('═'.repeat(80));
    console.log('✅ DEPLOYMENT SUCCESSFUL!');
    console.log('═'.repeat(80) + '\n');

    return deploymentInfo;
}

// Execute deployment
main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error('\n❌ Deployment failed:', error);
        process.exit(1);
    });

module.exports = { main };
