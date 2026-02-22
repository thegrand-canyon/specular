/**
 * Final Base Mainnet Deployment
 * Already deployed:
 * - AgentRegistryV2: 0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb
 * - ReputationManagerV3: 0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF
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

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  FINAL BASE MAINNET DEPLOYMENT                   ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);

    console.log(`🔑 Deployer: ${deployer.address}`);
    console.log(`✅ AgentRegistryV2: ${AGENT_REGISTRY}`);
    console.log(`✅ ReputationManagerV3: ${REPUTATION_MANAGER}\n`);

    const deployedAddresses = {
        'AgentRegistryV2': AGENT_REGISTRY,
        'ReputationManagerV3': REPUTATION_MANAGER
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
            gasLimit: 5000000
        });

        console.log(`   TX: ${contract.deploymentTransaction().hash}`);
        await contract.waitForDeployment();

        const address = await contract.getAddress();
        console.log(`   ✅ Deployed: ${address}\n`);

        deployedAddresses[name] = address;

        // Wait a bit between deployments
        await new Promise(r => setTimeout(r, 3000));
        return contract;
    }

    // 3. Deploy AgentLiquidityMarketplace
    await deployContract('AgentLiquidityMarketplace', [
        AGENT_REGISTRY,
        REPUTATION_MANAGER,
        USDC_ADDRESS
    ]);

    // 4. Deploy DepositRouter
    await deployContract('DepositRouter', [
        deployedAddresses.AgentLiquidityMarketplace,
        USDC_ADDRESS
    ]);

    // 5. Deploy ValidationRegistry
    await deployContract('ValidationRegistry');

    // Configure
    console.log('🔧 Configuring...');
    const rmAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json', 'utf8')).abi;
    const rm = new ethers.Contract(REPUTATION_MANAGER, rmAbi, deployer);
    const tx = await rm.setTrustedCaller(deployedAddresses.AgentLiquidityMarketplace, true);
    await tx.wait();
    console.log('   ✅ Configured\n');

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
            agentLiquidityMarketplace: deployedAddresses.AgentLiquidityMarketplace,
            depositRouter: deployedAddresses.DepositRouter,
            validationRegistry: deployedAddresses.ValidationRegistry
        }
    };

    fs.writeFileSync('./src/config/base-addresses.json', JSON.stringify(deployment.contracts, null, 2));

    console.log('✅ DEPLOYMENT COMPLETE!\n');
    console.log('📋 Contracts:\n');
    Object.entries(deployedAddresses).forEach(([name, addr]) => {
        console.log(`   ${name}: ${addr}`);
        console.log(`   https://basescan.org/address/${addr}\n`);
    });
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
