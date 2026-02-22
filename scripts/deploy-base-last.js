/**
 * Deploy Last Contract and Configure
 * Already deployed:
 * - AgentRegistryV2: 0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb
 * - ReputationManagerV3: 0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF
 * - AgentLiquidityMarketplace: 0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE
 * - DepositRouter: 0x771c293167AeD146EC4f56479056645Be46a0275
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC_URL = 'https://mainnet.base.org';
const DEPLOYER_KEY = process.env.PRIVATE_KEY;
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const AGENT_REGISTRY = '0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb';
const REPUTATION_MANAGER = '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF';
const MARKETPLACE = '0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE';
const DEPOSIT_ROUTER = '0x771c293167AeD146EC4f56479056645Be46a0275';

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  DEPLOY LAST CONTRACT & CONFIGURE                ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);

    console.log(`🔑 Deployer: ${deployer.address}\n`);

    // Deploy ValidationRegistry
    console.log('📦 Deploying ValidationRegistry...');
    const artifact = JSON.parse(fs.readFileSync(
        './artifacts/contracts/core/ValidationRegistry.sol/ValidationRegistry.json',
        'utf8'
    ));

    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
    const nonce = await provider.getTransactionCount(deployer.address, 'latest');
    console.log(`   Nonce: ${nonce}`);

    const validationRegistry = await factory.deploy(AGENT_REGISTRY, {
        nonce,
        gasLimit: 2000000
    });

    console.log(`   TX: ${validationRegistry.deploymentTransaction().hash}`);
    await validationRegistry.waitForDeployment();

    const vrAddress = await validationRegistry.getAddress();
    console.log(`   ✅ Deployed: ${vrAddress}\n`);

    // Wait a bit
    await new Promise(r => setTimeout(r, 3000));

    // Configure
    console.log('🔧 Configuring ReputationManagerV3...');
    const rmAbi = JSON.parse(fs.readFileSync(
        './artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json',
        'utf8'
    )).abi;

    const rm = new ethers.Contract(REPUTATION_MANAGER, rmAbi, deployer);
    const tx = await rm.setTrustedCaller(MARKETPLACE, true);
    await tx.wait();
    console.log('   ✅ Marketplace authorized\n');

    // Save deployment
    const deployment = {
        network: 'base',
        chainId: 8453,
        deployedAt: new Date().toISOString(),
        deployer: deployer.address,
        contracts: {
            agentRegistryV2: AGENT_REGISTRY,
            reputationManagerV3: REPUTATION_MANAGER,
            usdc: USDC_ADDRESS,
            agentLiquidityMarketplace: MARKETPLACE,
            depositRouter: DEPOSIT_ROUTER,
            validationRegistry: vrAddress
        }
    };

    fs.writeFileSync(
        './src/config/base-addresses.json',
        JSON.stringify(deployment.contracts, null, 2)
    );

    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  ✅ BASE MAINNET DEPLOYMENT COMPLETE!             ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    console.log('📋 All Contracts:\n');
    console.log(`   AgentRegistryV2: ${AGENT_REGISTRY}`);
    console.log(`   https://basescan.org/address/${AGENT_REGISTRY}\n`);

    console.log(`   ReputationManagerV3: ${REPUTATION_MANAGER}`);
    console.log(`   https://basescan.org/address/${REPUTATION_MANAGER}\n`);

    console.log(`   AgentLiquidityMarketplace: ${MARKETPLACE}`);
    console.log(`   https://basescan.org/address/${MARKETPLACE}\n`);

    console.log(`   DepositRouter: ${DEPOSIT_ROUTER}`);
    console.log(`   https://basescan.org/address/${DEPOSIT_ROUTER}\n`);

    console.log(`   ValidationRegistry: ${vrAddress}`);
    console.log(`   https://basescan.org/address/${vrAddress}\n`);

    console.log('💰 Production USDC:');
    console.log(`   ${USDC_ADDRESS}`);
    console.log(`   https://basescan.org/address/${USDC_ADDRESS}\n`);

    console.log('📝 Config saved to: ./src/config/base-addresses.json\n');
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
