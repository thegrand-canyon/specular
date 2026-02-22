/**
 * Deploy Specular Protocol to Base Sepolia
 *
 * Network: Base Sepolia (Chain ID: 84532)
 * RPC: https://sepolia.base.org
 * Explorer: https://sepolia.basescan.org
 *
 * Deployment order:
 * 1. AgentRegistryV2
 * 2. ReputationManagerV3
 * 3. MockUSDC
 * 4. AgentLiquidityMarketplace
 * 5. DepositRouter
 * 6. ValidationRegistry
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC_URL = 'https://sepolia.base.org';
const DEPLOYER_KEY = process.env.PRIVATE_KEY;

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║    DEPLOY SPECULAR TO BASE SEPOLIA              ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);

    console.log(`🔑 Deployer: ${deployer.address}`);

    const balance = await provider.getBalance(deployer.address);
    console.log(`💰 Balance: ${ethers.formatEther(balance)} ETH\n`);

    if (balance < ethers.parseEther('0.005')) {
        throw new Error('Insufficient balance! Need at least 0.005 ETH');
    }

    const deployedAddresses = {};
    const startTime = Date.now();

    // Helper function to deploy contract
    async function deployContract(name, constructorArgs = []) {
        console.log(`📦 Deploying ${name}...`);

        const artifactPath = path.join(__dirname, '../artifacts/contracts', `${name}.sol/${name}.json`);
        let artifact;

        try {
            artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        } catch (err) {
            // Try alternative paths
            const altPaths = [
                path.join(__dirname, '../artifacts/contracts/core', `${name}.sol/${name}.json`),
                path.join(__dirname, '../artifacts/contracts/tokens', `${name}.sol/${name}.json`),
            ];

            for (const altPath of altPaths) {
                try {
                    artifact = JSON.parse(fs.readFileSync(altPath, 'utf8'));
                    break;
                } catch {
                    continue;
                }
            }

            if (!artifact) {
                throw new Error(`Could not find artifact for ${name}`);
            }
        }

        const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
        const contract = await factory.deploy(...constructorArgs);
        await contract.waitForDeployment();

        const address = await contract.getAddress();
        console.log(`   ✅ Deployed at: ${address}`);
        console.log(`   🔗 https://sepolia.basescan.org/address/${address}\n`);

        deployedAddresses[name] = address;
        return contract;
    }

    // ========================================================================
    // DEPLOYMENT SEQUENCE
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('DEPLOYMENT SEQUENCE');
    console.log('═'.repeat(70) + '\n');

    // 1. Deploy AgentRegistryV2
    const agentRegistry = await deployContract('AgentRegistryV2');

    // 2. Deploy ReputationManagerV3
    const reputationManager = await deployContract('ReputationManagerV3', [
        deployedAddresses.AgentRegistryV2
    ]);

    // 3. Deploy MockUSDC
    const mockUSDC = await deployContract('MockUSDC');

    // 4. Deploy AgentLiquidityMarketplace
    const marketplace = await deployContract('AgentLiquidityMarketplace', [
        deployedAddresses.AgentRegistryV2,
        deployedAddresses.ReputationManagerV3,
        deployedAddresses.MockUSDC
    ]);

    // 5. Deploy DepositRouter
    const depositRouter = await deployContract('DepositRouter', [
        deployedAddresses.AgentLiquidityMarketplace,
        deployedAddresses.MockUSDC
    ]);

    // 6. Deploy ValidationRegistry
    const validationRegistry = await deployContract('ValidationRegistry');

    // ========================================================================
    // POST-DEPLOYMENT CONFIGURATION
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('POST-DEPLOYMENT CONFIGURATION');
    console.log('═'.repeat(70) + '\n');

    console.log('🔧 Setting marketplace as trusted caller...');
    const setTrustedTx = await reputationManager.setTrustedCaller(
        deployedAddresses.AgentLiquidityMarketplace,
        true
    );
    await setTrustedTx.wait();
    console.log('   ✅ Marketplace authorized\n');

    // ========================================================================
    // SAVE DEPLOYMENT INFO
    // ========================================================================

    const deploymentInfo = {
        network: 'base-sepolia',
        chainId: 84532,
        rpcUrl: RPC_URL,
        explorer: 'https://sepolia.basescan.org',
        deployer: deployer.address,
        deployedAt: new Date().toISOString(),
        gasUsed: 'TBD', // Would need to track all tx receipts
        contracts: {
            agentRegistryV2: deployedAddresses.AgentRegistryV2,
            reputationManagerV3: deployedAddresses.ReputationManagerV3,
            mockUSDC: deployedAddresses.MockUSDC,
            agentLiquidityMarketplace: deployedAddresses.AgentLiquidityMarketplace,
            depositRouter: deployedAddresses.DepositRouter,
            validationRegistry: deployedAddresses.ValidationRegistry
        }
    };

    const outputPath = path.join(__dirname, '../src/config/base-sepolia-addresses.json');
    fs.writeFileSync(outputPath, JSON.stringify(deploymentInfo.contracts, null, 2));
    console.log(`💾 Saved addresses to: ${outputPath}\n`);

    // ========================================================================
    // SUMMARY
    // ========================================================================

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

    console.log('═'.repeat(70));
    console.log('DEPLOYMENT SUMMARY');
    console.log('═'.repeat(70) + '\n');

    console.log(`⏱️  Total Time: ${elapsed}s\n`);

    console.log('📋 Deployed Contracts:\n');
    Object.entries(deployedAddresses).forEach(([name, address]) => {
        console.log(`   ${name}:`);
        console.log(`      ${address}`);
        console.log(`      https://sepolia.basescan.org/address/${address}\n`);
    });

    console.log('✅ DEPLOYMENT COMPLETE!\n');

    console.log('🔜 Next Steps:\n');
    console.log('   1. Verify contracts on BaseScan');
    console.log('   2. Mint test USDC');
    console.log('   3. Register test agent');
    console.log('   4. Create liquidity pool');
    console.log('   5. Run comprehensive test suite\n');

    console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n❌ Deployment failed:', err.message);
    console.error(err);
    process.exit(1);
});
