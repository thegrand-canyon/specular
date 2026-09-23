require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://mainnet.base.org';
const CHAIN_ID = 8453;

async function main() {
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║  DEPLOYING SPECULAR TO BASE MAINNET (FRESH DEPLOYMENT)  ║');
    console.log('║  With NEW Secure Wallet as Owner                        ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
    
    const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    console.log('Deployer (New Secure Wallet):', wallet.address);
    console.log('Network: Base Mainnet');
    console.log('Chain ID:', CHAIN_ID);
    console.log('');
    
    // Check balance
    const balance = await provider.getBalance(wallet.address);
    console.log('ETH Balance:', ethers.formatEther(balance));
    
    if (balance < ethers.parseEther('0.002')) {
        console.error('');
        console.error('❌ Insufficient ETH for deployment');
        console.error('   Need at least 0.002 ETH for gas fees');
        process.exit(1);
    }
    
    console.log('');
    console.log('════════════════════════════════════════════════════════════');
    console.log('DEPLOYMENT PLAN:');
    console.log('════════════════════════════════════════════════════════════');
    console.log('1. AgentRegistryV2');
    console.log('2. ReputationManagerV3');
    console.log('3. AgentLiquidityMarketplace');
    console.log('4. DepositRouter');
    console.log('5. ValidationRegistry');
    console.log('');
    console.log('All contracts will be owned by:', wallet.address);
    console.log('All fees will accrue to:', wallet.address);
    console.log('');
    console.log('Press Ctrl+C to cancel, or wait 5 seconds to proceed...');
    
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    console.log('');
    console.log('Starting deployment...');
    console.log('');
    
    // Load ABIs and bytecode
    const AgentRegistryV2 = JSON.parse(fs.readFileSync('artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json'));
    const ReputationManagerV3 = JSON.parse(fs.readFileSync('artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json'));
    const AgentLiquidityMarketplace = JSON.parse(fs.readFileSync('artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json'));
    
    // 1. Deploy AgentRegistryV2
    console.log('1️⃣  Deploying AgentRegistryV2...');
    const RegistryFactory = new ethers.ContractFactory(AgentRegistryV2.abi, AgentRegistryV2.bytecode, wallet);
    const registry = await RegistryFactory.deploy();
    await registry.waitForDeployment();
    const registryAddr = await registry.getAddress();
    console.log('   ✅ Deployed at:', registryAddr);
    
    // 2. Deploy ReputationManagerV3
    console.log('');
    console.log('2️⃣  Deploying ReputationManagerV3...');
    const ReputationFactory = new ethers.ContractFactory(ReputationManagerV3.abi, ReputationManagerV3.bytecode, wallet);
    const reputation = await ReputationFactory.deploy(registryAddr);
    await reputation.waitForDeployment();
    const reputationAddr = await reputation.getAddress();
    console.log('   ✅ Deployed at:', reputationAddr);
    
    // 3. Deploy AgentLiquidityMarketplace
    console.log('');
    console.log('3️⃣  Deploying AgentLiquidityMarketplace...');
    const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Production USDC on Base
    const MarketplaceFactory = new ethers.ContractFactory(AgentLiquidityMarketplace.abi, AgentLiquidityMarketplace.bytecode, wallet);
    const marketplace = await MarketplaceFactory.deploy(
        registryAddr,
        reputationAddr,
        USDC_BASE
    );
    await marketplace.waitForDeployment();
    const marketplaceAddr = await marketplace.getAddress();
    console.log('   ✅ Deployed at:', marketplaceAddr);
    
    // 4. Authorize marketplace in ReputationManager
    console.log('');
    console.log('4️⃣  Authorizing marketplace in ReputationManager...');
    const authTx = await reputation.authorizeContract(marketplaceAddr);
    await authTx.wait();
    console.log('   ✅ Authorized');
    
    // 5. Verify owner
    console.log('');
    console.log('5️⃣  Verifying ownership...');
    const registryOwner = await registry.owner();
    const reputationOwner = await reputation.owner();
    const marketplaceOwner = await marketplace.owner();
    
    console.log('   Registry owner:', registryOwner);
    console.log('   Reputation owner:', reputationOwner);
    console.log('   Marketplace owner:', marketplaceOwner);
    
    if (registryOwner === wallet.address && 
        reputationOwner === wallet.address && 
        marketplaceOwner === wallet.address) {
        console.log('   ✅ All contracts owned by deployer');
    } else {
        console.log('   ❌ Ownership mismatch!');
    }
    
    // Save addresses
    const addresses = {
        agentRegistryV2: registryAddr,
        reputationManagerV3: reputationAddr,
        usdc: USDC_BASE,
        agentLiquidityMarketplace: marketplaceAddr,
        deployer: wallet.address,
        deployedAt: new Date().toISOString(),
        network: 'base-mainnet',
        chainId: CHAIN_ID
    };
    
    fs.writeFileSync(
        'src/config/base-addresses.json',
        JSON.stringify(addresses, null, 2)
    );
    
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║  ✅ DEPLOYMENT SUCCESSFUL!                               ║');
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('');
    console.log('Contract Addresses:');
    console.log('  AgentRegistryV2:', registryAddr);
    console.log('  ReputationManagerV3:', reputationAddr);
    console.log('  AgentLiquidityMarketplace:', marketplaceAddr);
    console.log('  USDC:', USDC_BASE);
    console.log('');
    console.log('Owner/Fee Recipient:', wallet.address);
    console.log('');
    console.log('Saved to: src/config/base-addresses.json');
    console.log('');
    console.log('Next steps:');
    console.log('1. Verify contracts on BaseScan');
    console.log('2. Register as an agent');
    console.log('3. Add liquidity');
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error('\n❌ Deployment failed:', error);
        process.exit(1);
    });
