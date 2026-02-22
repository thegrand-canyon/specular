/**
 * Deploy Specular Protocol to Base Mainnet
 * Clean deployment script - no nonce issues
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC_URL = 'https://mainnet.base.org';
const DEPLOYER_KEY = process.env.PRIVATE_KEY;

// Production USDC on Base
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║    DEPLOY SPECULAR TO BASE MAINNET              ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);

    console.log(`🔑 Deployer: ${deployer.address}`);

    const balance = await provider.getBalance(deployer.address);
    console.log(`💰 Balance: ${ethers.formatEther(balance)} ETH\n`);

    if (balance < ethers.parseEther('0.015')) {
        throw new Error('Insufficient balance! Need at least 0.015 ETH');
    }

    // Verify network
    const network = await provider.getNetwork();
    console.log(`📡 Network: ${network.name} (Chain ID: ${network.chainId})`);

    if (network.chainId !== 8453n) {
        throw new Error(`Wrong network! Expected Base (8453), got ${network.chainId}`);
    }

    console.log('✅ Connected to Base Mainnet\n');
    console.log('⚠️  DEPLOYING TO PRODUCTION WITH REAL ETH\n');

    const deployedAddresses = {};
    const startTime = Date.now();

    // Helper function to deploy contract
    async function deployContract(name, constructorArgs = []) {
        console.log(`📦 Deploying ${name}...`);

        const artifactPath = path.join(__dirname, '../artifacts/contracts');
        let artifact;

        // Try different paths
        const paths = [
            `${artifactPath}/${name}.sol/${name}.json`,
            `${artifactPath}/core/${name}.sol/${name}.json`,
            `${artifactPath}/tokens/${name}.sol/${name}.json`,
        ];

        for (const p of paths) {
            try {
                artifact = JSON.parse(fs.readFileSync(p, 'utf8'));
                break;
            } catch {}
        }

        if (!artifact) {
            throw new Error(`Could not find artifact for ${name}`);
        }

        const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);

        // Get current nonce
        const nonce = await provider.getTransactionCount(deployer.address);
        console.log(`   Nonce: ${nonce}`);

        const contract = await factory.deploy(...constructorArgs, {
            nonce: nonce,
            gasLimit: 5000000
        });

        console.log(`   TX: ${contract.deploymentTransaction().hash}`);
        console.log(`   Waiting for confirmation...`);

        await contract.waitForDeployment();

        const address = await contract.getAddress();
        console.log(`   ✅ Deployed at: ${address}`);
        console.log(`   🔗 https://basescan.org/address/${address}\n`);

        deployedAddresses[name] = address;
        return contract;
    }

    console.log('═'.repeat(70));
    console.log('DEPLOYMENT SEQUENCE');
    console.log('═'.repeat(70) + '\n');

    // 1. Deploy AgentRegistryV2
    await deployContract('AgentRegistryV2');

    // 2. Deploy ReputationManagerV3
    await deployContract('ReputationManagerV3', [
        deployedAddresses.AgentRegistryV2
    ]);

    // 3. Deploy AgentLiquidityMarketplace (using production USDC)
    await deployContract('AgentLiquidityMarketplace', [
        deployedAddresses.AgentRegistryV2,
        deployedAddresses.ReputationManagerV3,
        USDC_ADDRESS
    ]);

    // 4. Deploy DepositRouter
    await deployContract('DepositRouter', [
        deployedAddresses.AgentLiquidityMarketplace,
        USDC_ADDRESS
    ]);

    // 5. Deploy ValidationRegistry
    await deployContract('ValidationRegistry');

    console.log('═'.repeat(70));
    console.log('POST-DEPLOYMENT CONFIGURATION');
    console.log('═'.repeat(70) + '\n');

    console.log('🔧 Setting marketplace as trusted caller...');
    const reputationManager = new ethers.Contract(
        deployedAddresses.ReputationManagerV3,
        JSON.parse(fs.readFileSync('./artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json', 'utf8')).abi,
        deployer
    );

    const setTrustedTx = await reputationManager.setTrustedCaller(
        deployedAddresses.AgentLiquidityMarketplace,
        true
    );
    await setTrustedTx.wait();
    console.log('   ✅ Marketplace authorized\n');

    // Save deployment info
    const deploymentInfo = {
        network: 'base',
        chainId: 8453,
        rpcUrl: RPC_URL,
        explorer: 'https://basescan.org',
        deployer: deployer.address,
        deployedAt: new Date().toISOString(),
        contracts: {
            agentRegistryV2: deployedAddresses.AgentRegistryV2,
            reputationManagerV3: deployedAddresses.ReputationManagerV3,
            usdc: USDC_ADDRESS,
            agentLiquidityMarketplace: deployedAddresses.AgentLiquidityMarketplace,
            depositRouter: deployedAddresses.DepositRouter,
            validationRegistry: deployedAddresses.ValidationRegistry
        }
    };

    const outputPath = path.join(__dirname, '../src/config/base-addresses.json');
    fs.writeFileSync(outputPath, JSON.stringify(deploymentInfo.contracts, null, 2));
    console.log(`💾 Saved addresses to: ${outputPath}\n`);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('═'.repeat(70));
    console.log('DEPLOYMENT SUMMARY');
    console.log('═'.repeat(70) + '\n');

    console.log(`⏱️  Total Time: ${elapsed}s\n`);

    console.log('📋 Deployed Contracts:\n');
    Object.entries(deployedAddresses).forEach(([name, address]) => {
        console.log(`   ${name}:`);
        console.log(`      ${address}`);
        console.log(`      https://basescan.org/address/${address}\n`);
    });

    console.log('💰 Production USDC:');
    console.log(`      ${USDC_ADDRESS}`);
    console.log(`      https://basescan.org/address/${USDC_ADDRESS}\n`);

    console.log('✅ DEPLOYMENT COMPLETE!\n');

    console.log('🔜 Next Steps:\n');
    console.log('   1. Verify contracts: npx hardhat verify --network base <ADDRESS>');
    console.log('   2. Register test agent');
    console.log('   3. Update API configuration');
    console.log('   4. Update dashboard\n');

    console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n❌ Deployment failed:', err.message);
    console.error(err);
    process.exit(1);
});
