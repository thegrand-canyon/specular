/**
 * Deploy Specular Protocol to Arbitrum Mainnet
 *
 * This script deploys all Specular contracts to Arbitrum and configures them.
 *
 * Usage:
 *   DEPLOYER_KEY=0x... npx hardhat run scripts/deploy-arbitrum.js --network arbitrum
 */

const hre = require("hardhat");
const { ethers } = require("hardhat");
const fs = require('fs');
const path = require('path');

// Arbitrum Mainnet configuration
const ARBITRUM_CONFIG = {
  chainId: 42161,
  usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', // Native USDC on Arbitrum
  feeRecipient: '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C'
};

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║    Specular Protocol - Arbitrum Deployment           ║');
  console.log('╚═══════════════════════════════════════════════════════╝\n');

  const [deployer] = await ethers.getSigners();

  console.log('🔷 Network: Arbitrum One (Chain ID: 42161)');
  console.log('👤 Deployer:', deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log('💰 Balance:', ethers.formatEther(balance), 'ETH\n');

  if (balance < ethers.parseEther('0.005')) {
    console.log('⚠️  Warning: Low ETH balance. Deployment may require ~0.005 ETH');
    console.log('   Bridge ETH to Arbitrum: https://bridge.arbitrum.io/\n');
  }

  // Deployment tracking
  const deploymentData = {
    network: 'arbitrum',
    chainId: ARBITRUM_CONFIG.chainId,
    deployedAt: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {},
    gasUsed: {}
  };

  let totalGasUsed = 0n;

  console.log('═'.repeat(60));
  console.log('STEP 1: Deploy AgentRegistryV2\n');

  const AgentRegistryV2 = await ethers.getContractFactory("AgentRegistryV2");
  console.log('Deploying AgentRegistryV2...');

  const registry = await AgentRegistryV2.deploy();
  await registry.waitForDeployment();

  const registryAddress = await registry.getAddress();
  const registryReceipt = await ethers.provider.getTransactionReceipt(registry.deploymentTransaction().hash);
  totalGasUsed += registryReceipt.gasUsed;

  console.log('✅ AgentRegistryV2 deployed:', registryAddress);
  console.log('   Gas used:', registryReceipt.gasUsed.toString());
  console.log('   TX:', registry.deploymentTransaction().hash, '\n');

  deploymentData.contracts.AgentRegistryV2 = registryAddress;
  deploymentData.gasUsed.AgentRegistryV2 = registryReceipt.gasUsed.toString();

  console.log('═'.repeat(60));
  console.log('STEP 2: Deploy ReputationManagerV3\n');

  const ReputationManagerV3 = await ethers.getContractFactory("ReputationManagerV3");
  console.log('Deploying ReputationManagerV3...');
  console.log('Constructor args:');
  console.log('  Registry:', registryAddress);

  const reputation = await ReputationManagerV3.deploy(registryAddress);
  await reputation.waitForDeployment();

  const reputationAddress = await reputation.getAddress();
  const reputationReceipt = await ethers.provider.getTransactionReceipt(reputation.deploymentTransaction().hash);
  totalGasUsed += reputationReceipt.gasUsed;

  console.log('✅ ReputationManagerV3 deployed:', reputationAddress);
  console.log('   Gas used:', reputationReceipt.gasUsed.toString());
  console.log('   TX:', reputation.deploymentTransaction().hash, '\n');

  deploymentData.contracts.ReputationManagerV3 = reputationAddress;
  deploymentData.gasUsed.ReputationManagerV3 = reputationReceipt.gasUsed.toString();

  console.log('═'.repeat(60));
  console.log('STEP 3: Deploy AgentLiquidityMarketplace\n');

  const AgentLiquidityMarketplace = await ethers.getContractFactory("AgentLiquidityMarketplace");
  console.log('Deploying AgentLiquidityMarketplace...');
  console.log('Constructor args:');
  console.log('  Registry:', registryAddress);
  console.log('  Reputation:', reputationAddress);
  console.log('  USDC:', ARBITRUM_CONFIG.usdc);

  const marketplace = await AgentLiquidityMarketplace.deploy(
    registryAddress,
    reputationAddress,
    ARBITRUM_CONFIG.usdc
  );
  await marketplace.waitForDeployment();

  const marketplaceAddress = await marketplace.getAddress();
  const marketplaceReceipt = await ethers.provider.getTransactionReceipt(marketplace.deploymentTransaction().hash);
  totalGasUsed += marketplaceReceipt.gasUsed;

  console.log('✅ AgentLiquidityMarketplace deployed:', marketplaceAddress);
  console.log('   Gas used:', marketplaceReceipt.gasUsed.toString());
  console.log('   TX:', marketplace.deploymentTransaction().hash, '\n');

  deploymentData.contracts.AgentLiquidityMarketplace = marketplaceAddress;
  deploymentData.gasUsed.AgentLiquidityMarketplace = marketplaceReceipt.gasUsed.toString();

  console.log('═'.repeat(60));
  console.log('STEP 4: Initialize Contracts\n');

  console.log('Authorizing marketplace in ReputationManager...');
  const authTx = await reputation.authorizePool(marketplaceAddress);
  const authReceipt = await authTx.wait();
  totalGasUsed += authReceipt.gasUsed;

  console.log('✅ Marketplace authorized');
  console.log('   Gas used:', authReceipt.gasUsed.toString());
  console.log('   TX:', authTx.hash, '\n');

  console.log('═'.repeat(60));
  console.log('STEP 5: Verify Deployment\n');

  // Verify all contracts are operational
  console.log('Checking AgentRegistryV2...');
  const registryName = await registry.name();
  const registrySymbol = await registry.symbol();
  console.log('  Name:', registryName);
  console.log('  Symbol:', registrySymbol);

  console.log('\nChecking ReputationManagerV3...');
  const isAuthorized = await reputation.authorizedPools(marketplaceAddress);
  console.log('  Marketplace authorized:', isAuthorized ? '✅ Yes' : '❌ No');

  console.log('\nChecking AgentLiquidityMarketplace...');
  const marketplaceRegistry = await marketplace.agentRegistry();
  const marketplaceReputation = await marketplace.reputationManager();
  const marketplaceUSDC = await marketplace.lendingToken();
  console.log('  Registry:', marketplaceRegistry === registryAddress ? '✅' : '❌', marketplaceRegistry);
  console.log('  Reputation:', marketplaceReputation === reputationAddress ? '✅' : '❌', marketplaceReputation);
  console.log('  USDC:', marketplaceUSDC === ARBITRUM_CONFIG.usdc ? '✅' : '❌', marketplaceUSDC);

  console.log('\n');
  console.log('═'.repeat(60));
  console.log('DEPLOYMENT SUMMARY\n');

  console.log('✅ All contracts deployed successfully!\n');

  console.log('Contract Addresses:');
  console.log('  AgentRegistryV2:', registryAddress);
  console.log('  ReputationManagerV3:', reputationAddress);
  console.log('  AgentLiquidityMarketplace:', marketplaceAddress);
  console.log('  USDC:', ARBITRUM_CONFIG.usdc, '(native)\n');

  const totalGasEth = ethers.formatEther(totalGasUsed * ethers.parseUnits('0.1', 'gwei')); // Estimate with 0.1 gwei
  console.log('Gas Usage:');
  console.log('  Total gas:', totalGasUsed.toString());
  console.log('  Estimated cost:', totalGasEth, 'ETH (~$' + (parseFloat(totalGasEth) * 3000).toFixed(2) + ')\n');

  deploymentData.tokens = {
    USDC: ARBITRUM_CONFIG.usdc
  };
  deploymentData.totalGasUsed = totalGasUsed.toString();

  // Save deployment data
  const outputPath = path.join(__dirname, '../deployments/arbitrum.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(deploymentData, null, 2));

  console.log('📄 Deployment data saved to:', outputPath, '\n');

  console.log('═'.repeat(60));
  console.log('NEXT STEPS\n');

  console.log('1. Verify contracts on Arbiscan:');
  console.log('   npx hardhat verify --network arbitrum', registryAddress);
  console.log('   npx hardhat verify --network arbitrum', reputationAddress, registryAddress);
  console.log('   npx hardhat verify --network arbitrum', marketplaceAddress, registryAddress, reputationAddress, ARBITRUM_CONFIG.usdc);
  console.log('');

  console.log('2. Update API configuration:');
  console.log('   Add Arbitrum network to src/config/networks.js');
  console.log('   Registry:', registryAddress);
  console.log('   Reputation:', reputationAddress);
  console.log('   Marketplace:', marketplaceAddress);
  console.log('');

  console.log('3. Update frontend:');
  console.log('   Add Arbitrum to network selector');
  console.log('   Update contract addresses');
  console.log('');

  console.log('4. Apply for Arbitrum Trailblazer AI Grant:');
  console.log('   https://arbitrumfoundation.io/grants');
  console.log('   Use deployment addresses in application');
  console.log('');

  console.log('═'.repeat(60));
  console.log('✅ Arbitrum deployment complete!\n');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('\n❌ Deployment failed:\n', error);
    process.exit(1);
  });
