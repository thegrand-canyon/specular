/**
 * Verify Deployed Contracts on Block Explorers
 *
 * Usage:
 *   # Verify all contracts on a specific chain
 *   npx hardhat run scripts/verify-contracts.js --network base
 *
 *   # Verify specific contract
 *   VERIFY_CONTRACT=AgentRegistryV2 npx hardhat run scripts/verify-contracts.js --network base
 */

const { run, network } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function verifyContract(address, constructorArguments = [], contractName = '') {
    console.log(`\nVerifying ${contractName || 'contract'} at ${address}...`);

    try {
        await run('verify:verify', {
            address,
            constructorArguments
        });
        console.log(`✅ ${contractName} verified successfully`);
        return true;
    } catch (error) {
        if (error.message.includes('Already Verified')) {
            console.log(`ℹ️  ${contractName} already verified`);
            return true;
        }
        console.error(`❌ ${contractName} verification failed:`, error.message);
        return false;
    }
}

async function main() {
    console.log('\n' + '═'.repeat(80));
    console.log(`  VERIFYING CONTRACTS ON ${network.name.toUpperCase()}`);
    console.log('═'.repeat(80) + '\n');

    // Load deployment addresses
    const chainKey = network.name === 'arcTestnet' ? 'arc-testnet' : network.name;
    const addressFile = path.join(__dirname, '..', 'src', 'config', `${chainKey}-addresses.json`);

    if (!fs.existsSync(addressFile)) {
        console.error(`❌ No deployment found for ${chainKey}`);
        console.error(`   Expected file: ${addressFile}\n`);
        process.exit(1);
    }

    const addresses = JSON.parse(fs.readFileSync(addressFile, 'utf-8'));
    console.log(`Loaded addresses from: ${addressFile}`);
    console.log(`Network: ${addresses.network || chainKey}`);
    console.log(`Deployed at: ${addresses.deployedAt || 'unknown'}\n`);

    const specificContract = process.env.VERIFY_CONTRACT;

    if (specificContract) {
        console.log(`Verifying only: ${specificContract}\n`);
    }

    const results = [];
    let delay = 3000; // 3 second delay between verifications

    // Verify MockUSDC (testnet only)
    if (addresses.mockUSDC && (!specificContract || specificContract === 'MockUSDC')) {
        await new Promise(r => setTimeout(r, delay));
        const success = await verifyContract(
            addresses.mockUSDC,
            [],
            'MockUSDC'
        );
        results.push({ contract: 'MockUSDC', success });
    }

    // Verify AgentRegistryV2
    if (addresses.agentRegistryV2 && (!specificContract || specificContract === 'AgentRegistryV2')) {
        await new Promise(r => setTimeout(r, delay));
        const success = await verifyContract(
            addresses.agentRegistryV2,
            [],
            'AgentRegistryV2'
        );
        results.push({ contract: 'AgentRegistryV2', success });
    }

    // Verify ReputationManagerV3
    if (addresses.reputationManagerV3 && (!specificContract || specificContract === 'ReputationManagerV3')) {
        await new Promise(r => setTimeout(r, delay));
        const success = await verifyContract(
            addresses.reputationManagerV3,
            [addresses.agentRegistryV2],
            'ReputationManagerV3'
        );
        results.push({ contract: 'ReputationManagerV3', success });
    }

    // Verify AgentLiquidityMarketplace
    if (addresses.agentLiquidityMarketplace && (!specificContract || specificContract === 'AgentLiquidityMarketplace')) {
        await new Promise(r => setTimeout(r, delay));
        const usdcAddress = addresses.mockUSDC || addresses.usdc;
        const success = await verifyContract(
            addresses.agentLiquidityMarketplace,
            [
                addresses.agentRegistryV2,
                addresses.reputationManagerV3,
                usdcAddress
            ],
            'AgentLiquidityMarketplace'
        );
        results.push({ contract: 'AgentLiquidityMarketplace', success });
    }

    // Verify ValidationRegistry
    if (addresses.validationRegistry && (!specificContract || specificContract === 'ValidationRegistry')) {
        await new Promise(r => setTimeout(r, delay));
        const success = await verifyContract(
            addresses.validationRegistry,
            [],
            'ValidationRegistry'
        );
        results.push({ contract: 'ValidationRegistry', success });
    }

    // Summary
    console.log('\n' + '═'.repeat(80));
    console.log('  VERIFICATION SUMMARY');
    console.log('═'.repeat(80) + '\n');

    const successful = results.filter(r => r.success).length;
    const total = results.length;

    console.log(`Total Contracts: ${total}`);
    console.log(`Verified:        ${successful} ✅`);
    console.log(`Failed:          ${total - successful} ❌\n`);

    results.forEach(r => {
        const icon = r.success ? '✅' : '❌';
        console.log(`  ${icon} ${r.contract}`);
    });

    console.log('\n' + '═'.repeat(80));
    if (successful === total) {
        console.log('✅ ALL CONTRACTS VERIFIED');
    } else {
        console.log('⚠️  SOME VERIFICATIONS FAILED');
    }
    console.log('═'.repeat(80) + '\n');

    process.exit(successful === total ? 0 : 1);
}

main().catch(error => {
    console.error('\n❌ Verification script error:', error);
    process.exit(1);
});
