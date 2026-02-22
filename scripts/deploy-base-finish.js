/**
 * Finish Base Mainnet Deployment
 * Already deployed:
 * - AgentRegistryV2: 0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb
 * - ReputationManagerV3: 0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF
 * - AgentLiquidityMarketplace: 0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC_URL = 'https://mainnet.base.org';
const DEPLOYER_KEY = process.env.PRIVATE_KEY;
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Already deployed
const AGENT_REGISTRY = '0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb';
const REPUTATION_MANAGER = '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF';
const MARKETPLACE = '0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE';

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  FINISH BASE MAINNET DEPLOYMENT                  ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);

    console.log(`🔑 Deployer: ${deployer.address}`);
    console.log(`✅ AgentRegistryV2: ${AGENT_REGISTRY}`);
    console.log(`✅ ReputationManagerV3: ${REPUTATION_MANAGER}`);
    console.log(`✅ AgentLiquidityMarketplace: ${MARKETPLACE}\n`);

    const deployedAddresses = {
        'AgentRegistryV2': AGENT_REGISTRY,
        'ReputationManagerV3': REPUTATION_MANAGER,
        'AgentLiquidityMarketplace': MARKETPLACE
    };

    async function deployContract(name, constructorArgs = []) {
        console.log(`📦 Deploying ${name}...`);

        const artifactPath = path.join(__dirname, '../artifacts/contracts');
        let artifact;

        const paths = [
            `${artifactPath}/${name}.sol/${name}.json`,
            `${artifactPath}/core/${name}.sol/${name}.json`,
            `${artifactPath}/tokens/${name}.sol/${name}.json`,
            `${artifactPath}/bridge/${name}.sol/${name}.json`,
        ];

        for (const p of paths) {
            try {
                artifact = JSON.parse(fs.readFileSync(p, 'utf8'));
                break;
            } catch {}
        }

        if (!artifact) throw new Error(`Could not find artifact for ${name}`);

        const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);

        // Get fresh nonce
        const nonce = await provider.getTransactionCount(deployer.address, 'latest');
        console.log(`   Nonce: ${nonce}`);

        const contract = await factory.deploy(...constructorArgs, {
            nonce,
            gasLimit: 3000000
        });

        console.log(`   TX: ${contract.deploymentTransaction().hash}`);
        await contract.waitForDeployment();

        const address = await contract.getAddress();
        console.log(`   ✅ Deployed: ${address}\n`);

        deployedAddresses[name] = address;

        // Wait between deployments
        await new Promise(r => setTimeout(r, 3000));
        return contract;
    }

    // 4. Deploy DepositRouter
    await deployContract('DepositRouter', [
        MARKETPLACE,
        USDC_ADDRESS
    ]);

    // 5. Deploy ValidationRegistry
    await deployContract('ValidationRegistry', [AGENT_REGISTRY]);

    // Configure
    console.log('🔧 Configuring...');
    const rmAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json', 'utf8')).abi;
    const rm = new ethers.Contract(REPUTATION_MANAGER, rmAbi, deployer);
    const tx = await rm.setTrustedCaller(MARKETPLACE, true);
    await tx.wait();
    console.log('   ✅ Marketplace authorized as trusted caller\n');

    // Save
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
            depositRouter: deployedAddresses.DepositRouter,
            validationRegistry: deployedAddresses.ValidationRegistry
        }
    };

    fs.writeFileSync('./src/config/base-addresses.json', JSON.stringify(deployment.contracts, null, 2));

    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  ✅ BASE MAINNET DEPLOYMENT COMPLETE!             ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    console.log('📋 All Contracts:\n');
    Object.entries(deployedAddresses).forEach(([name, addr]) => {
        console.log(`   ${name}:`);
        console.log(`      ${addr}`);
        console.log(`      https://basescan.org/address/${addr}\n`);
    });

    console.log('💰 Production USDC:');
    console.log(`      ${USDC_ADDRESS}`);
    console.log(`      https://basescan.org/address/${USDC_ADDRESS}\n`);
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
