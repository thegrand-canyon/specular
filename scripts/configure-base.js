/**
 * Configure Base Mainnet Deployment
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://mainnet.base.org';
const DEPLOYER_KEY = process.env.PRIVATE_KEY;
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const AGENT_REGISTRY = '0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb';
const REPUTATION_MANAGER = '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF';
const MARKETPLACE = '0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE';
const DEPOSIT_ROUTER = '0x771c293167AeD146EC4f56479056645Be46a0275';
const VALIDATION_REGISTRY = '0x5194D976F2f1B59C0500cDe1e54A362d9BB9124B';

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  CONFIGURE BASE MAINNET                          ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);

    console.log(`🔑 Deployer: ${deployer.address}\n`);

    // Configure ReputationManager
    console.log('🔧 Authorizing marketplace in ReputationManagerV3...');
    const rmAbi = JSON.parse(fs.readFileSync(
        './artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json',
        'utf8'
    )).abi;

    const rm = new ethers.Contract(REPUTATION_MANAGER, rmAbi, deployer);
    const tx = await rm.authorizePool(MARKETPLACE);
    console.log(`   TX: ${tx.hash}`);
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
            validationRegistry: VALIDATION_REGISTRY
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
    console.log(`   AgentRegistryV2:`);
    console.log(`      ${AGENT_REGISTRY}`);
    console.log(`      https://basescan.org/address/${AGENT_REGISTRY}\n`);

    console.log(`   ReputationManagerV3:`);
    console.log(`      ${REPUTATION_MANAGER}`);
    console.log(`      https://basescan.org/address/${REPUTATION_MANAGER}\n`);

    console.log(`   AgentLiquidityMarketplace:`);
    console.log(`      ${MARKETPLACE}`);
    console.log(`      https://basescan.org/address/${MARKETPLACE}\n`);

    console.log(`   DepositRouter:`);
    console.log(`      ${DEPOSIT_ROUTER}`);
    console.log(`      https://basescan.org/address/${DEPOSIT_ROUTER}\n`);

    console.log(`   ValidationRegistry:`);
    console.log(`      ${VALIDATION_REGISTRY}`);
    console.log(`      https://basescan.org/address/${VALIDATION_REGISTRY}\n`);

    console.log('💰 Production USDC:');
    console.log(`      ${USDC_ADDRESS}`);
    console.log(`      https://basescan.org/address/${USDC_ADDRESS}\n`);

    console.log('📝 Configuration saved to: ./src/config/base-addresses.json\n');
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    console.error(err);
    process.exit(1);
});
