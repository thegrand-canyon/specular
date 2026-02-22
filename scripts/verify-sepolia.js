/**
 * Verify Deployed Contracts on Sepolia Etherscan
 *
 * Usage:
 *   npx hardhat run scripts/verify-sepolia.js --network sepolia
 *
 * Prerequisites:
 *   - ETHERSCAN_API_KEY in .env
 *   - Contracts already deployed
 *   - Contract addresses in src/config/sepolia-addresses.json
 */

const hre = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🔍 Verifying contracts on Sepolia Etherscan...\n');

    // Load deployed addresses
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');

    if (!fs.existsSync(addressesPath)) {
        console.error('❌ Error: Sepolia addresses file not found!');
        console.error('Please deploy contracts first with: npx hardhat run scripts/deploy-v2.js --network sepolia');
        process.exit(1);
    }

    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    console.log('Contract Addresses:');
    console.log(`- AgentRegistryV2: ${addresses.agentRegistry}`);
    console.log(`- ReputationManagerV2: ${addresses.reputationManager}`);
    console.log(`- ValidationRegistry: ${addresses.validationRegistry}`);
    console.log(`- MockUSDC: ${addresses.mockUSDC}`);
    console.log(`- LendingPoolV2: ${addresses.lendingPool}\n`);

    // Verify each contract
    const verifications = [];

    // 1. Verify AgentRegistryV2 (no constructor args)
    verifications.push({
        name: 'AgentRegistryV2',
        address: addresses.agentRegistry,
        constructorArguments: []
    });

    // 2. Verify ReputationManagerV2 (constructor: agentRegistry address)
    verifications.push({
        name: 'ReputationManagerV2',
        address: addresses.reputationManager,
        constructorArguments: [addresses.agentRegistry]
    });

    // 3. Verify ValidationRegistry (constructor: agentRegistry address)
    verifications.push({
        name: 'ValidationRegistry',
        address: addresses.validationRegistry,
        constructorArguments: [addresses.agentRegistry]
    });

    // 4. Verify MockUSDC (no constructor args)
    verifications.push({
        name: 'MockUSDC',
        address: addresses.mockUSDC,
        constructorArguments: []
    });

    // 5. Verify LendingPoolV2 (constructor: agentRegistry, reputationManager, usdc)
    verifications.push({
        name: 'LendingPoolV2',
        address: addresses.lendingPool,
        constructorArguments: [
            addresses.agentRegistry,
            addresses.reputationManager,
            addresses.mockUSDC
        ]
    });

    // Verify each contract
    for (const contract of verifications) {
        console.log(`\n📝 Verifying ${contract.name}...`);
        console.log(`Address: ${contract.address}`);

        try {
            await hre.run('verify:verify', {
                address: contract.address,
                constructorArguments: contract.constructorArguments
            });

            console.log(`✅ ${contract.name} verified successfully!`);
            console.log(`   View at: https://sepolia.etherscan.io/address/${contract.address}#code`);
        } catch (error) {
            if (error.message.includes('Already Verified')) {
                console.log(`✓ ${contract.name} already verified`);
                console.log(`  View at: https://sepolia.etherscan.io/address/${contract.address}#code`);
            } else {
                console.error(`❌ Error verifying ${contract.name}:`);
                console.error(error.message);
            }
        }

        // Add delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    console.log('\n✅ Verification process complete!\n');
    console.log('View all contracts on Etherscan:');
    for (const contract of verifications) {
        console.log(`- ${contract.name}: https://sepolia.etherscan.io/address/${contract.address}`);
    }
    console.log('');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
