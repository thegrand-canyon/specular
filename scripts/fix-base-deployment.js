/**
 * Fix Base Mainnet Deployment Configuration Issues
 *
 * This script identifies that there are TWO separate Base Mainnet deployments:
 *
 * Deployment A (older, in base-addresses.json):
 *   - Registry: 0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa
 *   - Marketplace: 0x2f24Ca82Cac2a0034eEA2E128328BAdA94A5E4B6
 *   - Reputation: 0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF
 *   - Owner: 0x800e305A0caDdE6289dFDFEDF38218f45C06F72C
 *
 * Deployment B (newer, provided by user):
 *   - Registry: 0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb
 *   - Marketplace: 0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE
 *   - Reputation: ??? (marketplace points to 0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF)
 *   - Owner: 0x656086A21073272533c8A3f56A94c1f3D8BCFcE2
 *
 * Issue: Deployment B's Marketplace points to Deployment A's Reputation Manager,
 * and Deployment A's Reputation points to Deployment B's Registry - they're crossed!
 *
 * This script will:
 * 1. Fix authorization in Deployment A (authorize marketplace)
 * 2. Investigate Deployment B to determine correct configuration
 *
 * Usage:
 *   DEPLOYMENT=A node scripts/fix-base-deployment.js
 *   or
 *   DEPLOYMENT=B node scripts/fix-base-deployment.js
 */

const { ethers } = require('ethers');
require('dotenv').config();

const DEPLOYMENTS = {
    A: {
        name: 'Deployment A (base-addresses.json)',
        registry: '0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa',
        marketplace: '0x2f24Ca82Cac2a0034eEA2E128328BAdA94A5E4B6',
        reputation: '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF',
        owner: '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C'
    },
    B: {
        name: 'Deployment B (user-provided)',
        registry: '0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb',
        marketplace: '0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE',
        reputation: '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF', // what marketplace uses
        reputationExpected: '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF', // what user provided
        owner: '0x656086A21073272533c8A3f56A94c1f3D8BCFcE2'
    }
};

const REPUTATION_ABI = [
    'function owner() external view returns (address)',
    'function agentRegistry() external view returns (address)',
    'function authorizedPools(address) external view returns (bool)',
    'function authorizePool(address pool) external',
    'function revokePool(address pool) external'
];

const MARKETPLACE_ABI = [
    'function owner() external view returns (address)',
    'function agentRegistry() external view returns (address)',
    'function reputationManager() external view returns (address)',
    'function usdcToken() external view returns (address)'
];

async function main() {
    const deployment = process.env.DEPLOYMENT || 'A';

    if (!['A', 'B'].includes(deployment)) {
        console.error('Error: DEPLOYMENT must be A or B');
        process.exit(1);
    }

    const config = DEPLOYMENTS[deployment];
    console.log(`\n${'='.repeat(80)}`);
    console.log(`  FIXING ${config.name}`);
    console.log('='.repeat(80) + '\n');

    const rpcUrl = process.env.BASE_RPC_URL || 'https://base.gateway.tenderly.co';
    const provider = new ethers.JsonRpcProvider(rpcUrl);

    // Check if private key is available
    if (!process.env.PRIVATE_KEY || process.env.PRIVATE_KEY === '0x0000000000000000000000000000000000000000000000000000000000000000') {
        console.log('⚠️  Private key not available - showing READ-ONLY analysis\n');
        await analyzeDeployment(provider, config, deployment);
        return;
    }

    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    console.log(`Using wallet: ${wallet.address}\n`);

    if (wallet.address.toLowerCase() !== config.owner.toLowerCase()) {
        console.log(`⚠️  Wallet ${wallet.address} is not the owner (${config.owner})`);
        console.log('   Proceeding with read-only analysis...\n');
        await analyzeDeployment(provider, config, deployment);
        return;
    }

    // Perform fixes
    await fixDeployment(wallet, config, deployment);
}

async function analyzeDeployment(provider, config, deploymentKey) {
    console.log('📊 Analyzing deployment...\n');

    // Check marketplace
    const marketplace = new ethers.Contract(config.marketplace, MARKETPLACE_ABI, provider);

    try {
        const linkedRegistry = await marketplace.agentRegistry();
        const linkedReputation = await marketplace.reputationManager();
        const linkedUsdc = await marketplace.usdcToken();
        const owner = await marketplace.owner();

        console.log('Marketplace Configuration:');
        console.log(`  Address: ${config.marketplace}`);
        console.log(`  Owner: ${owner}`);
        console.log(`  Linked Registry: ${linkedRegistry}`);
        console.log(`  Linked Reputation: ${linkedReputation}`);
        console.log(`  Linked USDC: ${linkedUsdc}`);

        // Check if links match config
        const registryMatch = linkedRegistry.toLowerCase() === config.registry.toLowerCase();
        const reputationMatch = linkedReputation.toLowerCase() === config.reputation.toLowerCase();

        console.log(`\n  Registry Match: ${registryMatch ? '✅' : '❌'}`);
        console.log(`  Reputation Match: ${reputationMatch ? '✅' : '❌'}`);

        if (!registryMatch) {
            console.log(`    Expected: ${config.registry}`);
            console.log(`    Actual: ${linkedRegistry}`);
        }
        if (!reputationMatch) {
            console.log(`    Expected: ${config.reputation}`);
            console.log(`    Actual: ${linkedReputation}`);
        }

    } catch (error) {
        console.log(`  ❌ Error reading marketplace: ${error.message}`);
    }

    // Check reputation manager
    console.log('\n─────────────────────────────────────────────\n');
    const reputation = new ethers.Contract(config.reputation, REPUTATION_ABI, provider);

    try {
        const linkedRegistry = await reputation.agentRegistry();
        const isMarketplaceAuthorized = await reputation.authorizedPools(config.marketplace);
        const owner = await reputation.owner();

        console.log('Reputation Manager Configuration:');
        console.log(`  Address: ${config.reputation}`);
        console.log(`  Owner: ${owner}`);
        console.log(`  Linked Registry: ${linkedRegistry}`);
        console.log(`  Marketplace Authorized: ${isMarketplaceAuthorized}`);

        const registryMatch = linkedRegistry.toLowerCase() === config.registry.toLowerCase();
        console.log(`\n  Registry Match: ${registryMatch ? '✅' : '❌'}`);
        console.log(`  Marketplace Authorized: ${isMarketplaceAuthorized ? '✅' : '❌'}`);

        if (!registryMatch) {
            console.log(`    Expected: ${config.registry}`);
            console.log(`    Actual: ${linkedRegistry}`);
        }

    } catch (error) {
        console.log(`  ❌ Error reading reputation: ${error.message}`);
    }

    // Recommendations
    console.log('\n' + '='.repeat(80));
    console.log('  RECOMMENDATIONS');
    console.log('='.repeat(80) + '\n');

    if (deploymentKey === 'A') {
        console.log('Deployment A appears to be correctly configured but needs:');
        console.log('  1. ✅ Registry and Reputation are correctly linked');
        console.log('  2. ❌ Marketplace needs to be authorized in Reputation Manager');
        console.log('\nTo fix:');
        console.log('  DEPLOYMENT=A PRIVATE_KEY=<owner_key> node scripts/fix-base-deployment.js');
    } else {
        console.log('Deployment B has cross-deployment issues:');
        console.log('  - Marketplace points to Deployment A\'s Reputation Manager');
        console.log('  - This is causing the integration failures');
        console.log('\nOptions:');
        console.log('  1. Use Deployment A instead (it\'s properly configured)');
        console.log('  2. Redeploy Marketplace B with correct Reputation Manager address');
        console.log('  3. Deploy a new Reputation Manager for Deployment B');
    }

    console.log('\n' + '='.repeat(80) + '\n');
}

async function fixDeployment(wallet, config, deploymentKey) {
    console.log('🔧 Fixing deployment...\n');

    const reputation = new ethers.Contract(config.reputation, REPUTATION_ABI, wallet);

    // Check current status
    const isAuthorized = await reputation.authorizedPools(config.marketplace);
    console.log(`Marketplace currently authorized: ${isAuthorized}\n`);

    if (isAuthorized) {
        console.log('✅ Marketplace is already authorized. No action needed.\n');
        return;
    }

    // Authorize marketplace
    console.log('Authorizing marketplace in reputation manager...');
    try {
        const tx = await reputation.authorizePool(config.marketplace);
        console.log(`Transaction sent: ${tx.hash}`);
        console.log('Waiting for confirmation...');

        await tx.wait();
        console.log('✅ Marketplace authorized successfully!\n');

        // Verify
        const isNowAuthorized = await reputation.authorizedPools(config.marketplace);
        console.log(`Verification: ${isNowAuthorized ? '✅ CONFIRMED' : '❌ FAILED'}\n`);

    } catch (error) {
        console.log(`❌ Error authorizing marketplace: ${error.message}\n`);
    }
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error('\n❌ Fatal error:', error);
        process.exit(1);
    });
