/**
 * Fix Base Mainnet Authorization Issue
 * Authorizes the marketplace in the ReputationManager
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Load configuration
const baseConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../src/config/base-addresses.json'), 'utf8')
);

// Load ABI
function loadAbi(name) {
    const abiPath = path.join(__dirname, '../abis', `${name}.json`);
    const abiFile = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
    return Array.isArray(abiFile) ? abiFile : abiFile.abi;
}

const reputationAbi = loadAbi('ReputationManagerV3');

async function fixAuthorization() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  Fix Base Mainnet Authorization Issue           ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    // Check for private key
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
        console.error('❌ Error: PRIVATE_KEY environment variable not set');
        console.log('\nThis script must be run by the contract owner.');
        console.log('Usage: PRIVATE_KEY=0x... node scripts/fix-base-authorization.js');
        process.exit(1);
    }

    // Setup provider and wallet
    const provider = new ethers.JsonRpcProvider('https://mainnet.base.org', 8453, {
        batchMaxCount: 1
    });
    const wallet = new ethers.Wallet(privateKey, provider);

    console.log('Wallet:', wallet.address);
    console.log('Network: Base Mainnet');
    console.log('');

    // Load contracts
    const reputation = new ethers.Contract(
        baseConfig.reputationManagerV3,
        reputationAbi,
        wallet
    );

    console.log('Contract Addresses:');
    console.log('  ReputationManager:', baseConfig.reputationManagerV3);
    console.log('  Marketplace:', baseConfig.agentLiquidityMarketplace);
    console.log('');

    // Step 1: Check current authorization
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 1: Checking Current Authorization');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    try {
        const isAuthorized = await reputation.authorizedPools(baseConfig.agentLiquidityMarketplace);
        console.log('Current Status:', isAuthorized ? '✅ Authorized' : '❌ Not Authorized');

        if (isAuthorized) {
            console.log('\n✅ Marketplace is already authorized!');
            console.log('No action needed.');
            return;
        }
    } catch (error) {
        console.error('❌ Error checking authorization:', error.message);
        process.exit(1);
    }

    // Step 2: Check ownership
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 2: Verifying Ownership');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    try {
        const owner = await reputation.owner();
        console.log('Contract Owner:', owner);
        console.log('Your Wallet:', wallet.address);

        if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
            console.error('\n❌ Error: You are not the contract owner!');
            console.log(`\nThe contract owner is: ${owner}`);
            console.log('Only the owner can authorize pools.');
            console.log('\nPlease use the owner\'s private key to run this script.');
            process.exit(1);
        }

        console.log('✅ Ownership verified');
    } catch (error) {
        console.error('❌ Error checking ownership:', error.message);
        process.exit(1);
    }

    // Step 3: Authorize marketplace
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Step 3: Authorizing Marketplace');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    try {
        // Estimate gas first
        console.log('Estimating gas...');
        const gasEstimate = await reputation.authorizePool.estimateGas(
            baseConfig.agentLiquidityMarketplace
        );
        console.log('✅ Gas estimate:', gasEstimate.toString());
        console.log('');

        // Send transaction
        console.log('Sending authorization transaction...');
        const tx = await reputation.authorizePool(baseConfig.agentLiquidityMarketplace);

        console.log('✅ Transaction sent!');
        console.log('   Tx Hash:', tx.hash);
        console.log('   View on BaseScan:', `https://basescan.org/tx/${tx.hash}`);
        console.log('');

        // Wait for confirmation
        console.log('Waiting for confirmation...');
        const receipt = await tx.wait();

        console.log('✅ Transaction confirmed!');
        console.log('   Block:', receipt.blockNumber);
        console.log('   Gas Used:', receipt.gasUsed.toString());
        console.log('');

        // Verify authorization
        const isNowAuthorized = await reputation.authorizedPools(
            baseConfig.agentLiquidityMarketplace
        );

        if (isNowAuthorized) {
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log('🎉 SUCCESS! Marketplace is now authorized!');
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        } else {
            console.error('\n❌ Warning: Authorization transaction succeeded but verification failed');
            console.error('This may be a temporary issue. Please verify manually.');
        }
    } catch (error) {
        console.error('\n❌ Error authorizing marketplace:', error.message);

        if (error.data) {
            console.error('Error Data:', error.data);
        }

        if (error.reason) {
            console.error('Reason:', error.reason);
        }

        console.log('\n💡 Troubleshooting:');
        console.log('   1. Ensure you have enough ETH for gas');
        console.log('   2. Verify you are the contract owner');
        console.log('   3. Check if authorization is already pending');
        console.log('   4. Try again with higher gas price');

        process.exit(1);
    }
}

fixAuthorization()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
