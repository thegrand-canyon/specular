/**
 * Deploy Fresh ReputationManagerV3 on Base Mainnet
 * Fixes the authorization issue by deploying with correct ownership
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Load configuration
const baseConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../src/config/base-addresses.json'), 'utf8')
);

// Load ABIs
function loadAbi(name) {
    const abiPath = path.join(__dirname, '../abis', `${name}.json`);
    const abiFile = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
    return Array.isArray(abiFile) ? abiFile : abiFile.abi;
}

// Load contract artifacts
function loadArtifact(name) {
    const artifactPath = path.join(__dirname, `../artifacts/contracts/core/${name}.sol/${name}.json`);
    return JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
}

const reputationArtifact = loadArtifact('ReputationManagerV3');
const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');
const registryAbi = loadAbi('AgentRegistryV2');

async function deployNewReputationManager() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  Deploy New ReputationManagerV3 - Base Mainnet  ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    // Check for private key
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
        console.error('❌ Error: PRIVATE_KEY environment variable not set');
        console.log('\nUsage: PRIVATE_KEY=0x... node scripts/deploy-new-reputation-base.js');
        process.exit(1);
    }

    // Setup provider and wallet
    const provider = new ethers.JsonRpcProvider('https://mainnet.base.org', 8453, {
        batchMaxCount: 1
    });
    const wallet = new ethers.Wallet(privateKey, provider);

    console.log('Deployer Wallet:', wallet.address);
    console.log('Network: Base Mainnet (Chain ID: 8453)');
    console.log('');

    // Check balance
    const balance = await provider.getBalance(wallet.address);
    console.log('Balance:', ethers.formatEther(balance), 'ETH');

    if (balance < ethers.parseEther('0.0005')) {
        console.error('❌ Insufficient ETH for deployment');
        console.log('   Need at least 0.0005 ETH (~$1-2)');
        process.exit(1);
    }
    console.log('✅ Sufficient balance for deployment');
    console.log('');

    // Load existing contracts
    const marketplace = new ethers.Contract(
        baseConfig.agentLiquidityMarketplace,
        marketplaceAbi,
        wallet
    );
    const registry = new ethers.Contract(
        baseConfig.agentRegistryV2,
        registryAbi,
        wallet
    );

    console.log('Existing Contracts:');
    console.log('  Registry:', baseConfig.agentRegistryV2);
    console.log('  Old ReputationManager:', baseConfig.reputationManagerV3);
    console.log('  Marketplace:', baseConfig.agentLiquidityMarketplace);
    console.log('');

    // Step 1: Deploy new ReputationManagerV3
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 1: Deploying New ReputationManagerV3');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    const ReputationFactory = new ethers.ContractFactory(
        reputationArtifact.abi,
        reputationArtifact.bytecode,
        wallet
    );

    console.log('Constructor parameters:');
    console.log('  _agentRegistry:', baseConfig.agentRegistryV2);
    console.log('');

    console.log('Deploying contract...');
    const newReputation = await ReputationFactory.deploy(
        baseConfig.agentRegistryV2
    );

    console.log('✅ Deployment transaction sent!');
    console.log('   TX Hash:', newReputation.deploymentTransaction().hash);
    console.log('   Waiting for confirmation...');
    console.log('');

    await newReputation.waitForDeployment();
    const newReputationAddress = await newReputation.getAddress();

    console.log('✅ ReputationManagerV3 deployed!');
    console.log('   Address:', newReputationAddress);
    console.log('   Block:', await provider.getBlockNumber());
    console.log('');

    // Verify ownership
    const owner = await newReputation.owner();
    console.log('Contract Owner:', owner);
    console.log('Deployer Wallet:', wallet.address);
    console.log('Match:', owner.toLowerCase() === wallet.address.toLowerCase() ? '✅ YES' : '❌ NO');
    console.log('');

    // Step 2: Update Marketplace
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 2: Updating Marketplace');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('Calling marketplace.updateReputationManager()...');
    const updateMarketplaceTx = await marketplace.updateReputationManager(newReputationAddress);
    console.log('✅ Transaction sent:', updateMarketplaceTx.hash);
    await updateMarketplaceTx.wait();
    console.log('✅ Marketplace updated!');
    console.log('');

    // Step 3: Update Registry
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 3: Updating Registry');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('Calling registry.updateReputationManager()...');
    const updateRegistryTx = await registry.updateReputationManager(newReputationAddress);
    console.log('✅ Transaction sent:', updateRegistryTx.hash);
    await updateRegistryTx.wait();
    console.log('✅ Registry updated!');
    console.log('');

    // Step 4: Authorize Marketplace
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 4: Authorizing Marketplace');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('Calling newReputation.authorizePool()...');
    const authorizeTx = await newReputation.authorizePool(baseConfig.agentLiquidityMarketplace);
    console.log('✅ Transaction sent:', authorizeTx.hash);
    await authorizeTx.wait();
    console.log('✅ Marketplace authorized!');
    console.log('');

    // Verify authorization
    const isAuthorized = await newReputation.authorizedPools(baseConfig.agentLiquidityMarketplace);
    console.log('Authorization Status:', isAuthorized ? '✅ Authorized' : '❌ Not Authorized');
    console.log('');

    // Step 5: Summary
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🎉 Deployment Complete!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    console.log('New ReputationManagerV3:', newReputationAddress);
    console.log('Owner:', owner);
    console.log('Marketplace Authorized:', isAuthorized ? 'YES' : 'NO');
    console.log('');

    console.log('📝 Update Required:');
    console.log('Update src/config/base-addresses.json:');
    console.log('');
    console.log('{');
    console.log('  "reputationManagerV3":', `"${newReputationAddress}",`);
    console.log('  ...');
    console.log('}');
    console.log('');

    console.log('✅ All contracts now owned by:', wallet.address);
    console.log('✅ Marketplace authorized');
    console.log('✅ Ready for use!');
    console.log('');

    // Save deployment info
    const deploymentInfo = {
        network: 'base',
        timestamp: new Date().toISOString(),
        deployer: wallet.address,
        contracts: {
            reputationManagerV3: newReputationAddress,
            agentRegistryV2: baseConfig.agentRegistryV2,
            agentLiquidityMarketplace: baseConfig.agentLiquidityMarketplace
        },
        transactions: {
            deploy: newReputation.deploymentTransaction().hash,
            updateMarketplace: updateMarketplaceTx.hash,
            updateRegistry: updateRegistryTx.hash,
            authorize: authorizeTx.hash
        }
    };

    fs.writeFileSync(
        path.join(__dirname, '../base-reputation-deployment.json'),
        JSON.stringify(deploymentInfo, null, 2)
    );

    console.log('Deployment info saved to: base-reputation-deployment.json');
    console.log('');

    return newReputationAddress;
}

deployNewReputationManager()
    .then((address) => {
        console.log('New ReputationManager Address:', address);
        process.exit(0);
    })
    .catch((error) => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
