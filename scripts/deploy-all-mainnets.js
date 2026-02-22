/**
 * Deploy Specular Protocol to All Production Chains
 *
 * Usage:
 *   # Deploy to all chains sequentially
 *   node scripts/deploy-all-mainnets.js
 *
 *   # Dry run
 *   node scripts/deploy-all-mainnets.js --dry-run
 *
 *   # Deploy to specific chains only
 *   CHAINS=base,arbitrum node scripts/deploy-all-mainnets.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Load chain configurations
const chains = require('../src/config/chains.json');

// Parse arguments
const isDryRun = process.argv.includes('--dry-run');
const chainsToDeployEnv = process.env.CHAINS;

// Define production chains
const PRODUCTION_CHAINS = ['base', 'arbitrum', 'optimism', 'polygon'];

async function deployToChain(chainKey) {
    const chainConfig = chains[chainKey];
    if (!chainConfig) {
        throw new Error(`Chain configuration not found for ${chainKey}`);
    }

    const networkName = chainKey === 'arc-testnet' ? 'arcTestnet' : chainKey;

    console.log('\n' + '═'.repeat(80));
    console.log(`  DEPLOYING TO ${chainConfig.name.toUpperCase()}`);
    console.log('═'.repeat(80) + '\n');

    if (isDryRun) {
        console.log('🧪 DRY RUN - Would deploy to:');
        console.log(`   Network: ${networkName}`);
        console.log(`   Chain ID: ${chainConfig.chainId}`);
        console.log(`   RPC: ${chainConfig.rpc}`);
        console.log(`   USDC: ${chainConfig.usdc.address} (${chainConfig.usdc.type})\n`);
        return { success: true, chain: chainKey, dryRun: true };
    }

    try {
        const startTime = Date.now();

        // Execute hardhat deployment
        console.log(`📦 Running deployment for ${chainConfig.name}...`);
        execSync(
            `npx hardhat run scripts/deploy-chain.js --network ${networkName}`,
            { encoding: 'utf-8', stdio: 'inherit' }
        );

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`\n✅ ${chainConfig.name} deployment complete in ${duration}s\n`);

        return {
            success: true,
            chain: chainKey,
            network: chainConfig.name,
            duration
        };

    } catch (error) {
        console.error(`\n❌ ${chainConfig.name} deployment failed:`, error.message);
        return {
            success: false,
            chain: chainKey,
            network: chainConfig.name,
            error: error.message
        };
    }
}

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   Specular Protocol - Mainnet Deployments       ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    // Determine which chains to deploy to
    let chainsToDeploy = PRODUCTION_CHAINS;

    if (chainsToDeployEnv) {
        chainsToDeploy = chainsToDeployEnv.split(',').map(c => c.trim());
        console.log(`📋 Deploying to selected chains: ${chainsToDeploy.join(', ')}\n`);
    } else {
        console.log('📋 Deploying to ALL production chains:\n');
    }

    // Display deployment plan
    chainsToDeploy.forEach((chain, i) => {
        const config = chains[chain];
        if (config) {
            console.log(`  ${i + 1}. ${config.name.padEnd(20)} (chainId: ${config.chainId})`);
        }
    });

    console.log('');

    if (isDryRun) {
        console.log('🧪 DRY RUN MODE - No actual deployments\n');
    } else {
        console.log('⚠️  WARNING: Deploying to production chains!');
        console.log('Press Ctrl+C to cancel, or wait 5 seconds...\n');
        await new Promise(resolve => setTimeout(resolve, 5000));
    }

    const startTime = Date.now();
    const results = [];

    // Deploy sequentially
    for (const chain of chainsToDeploy) {
        const result = await deployToChain(chain);
        results.push(result);

        // Stop on first failure (unless dry run)
        if (!result.success && !isDryRun) {
            console.log('\n⚠️  Stopping due to failure.\n');
            break;
        }
    }

    const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);

    // Summary
    console.log('\n' + '═'.repeat(80));
    console.log('  DEPLOYMENT SUMMARY');
    console.log('═'.repeat(80) + '\n');

    const successful = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);

    console.log(`Total Chains: ${results.length}`);
    console.log(`Successful:   ${successful.length} ✅`);
    console.log(`Failed:       ${failed.length} ❌`);
    console.log(`Total Time:   ${totalDuration}s\n`);

    if (successful.length > 0) {
        console.log('✅ Successful Deployments:\n');
        successful.forEach(r => {
            console.log(`  • ${r.network || r.chain}${!r.dryRun && r.duration ? ` (${r.duration}s)` : ''}`);
        });
        console.log('');
    }

    if (failed.length > 0) {
        console.log('❌ Failed Deployments:\n');
        failed.forEach(r => {
            console.log(`  • ${r.network || r.chain}`);
            console.log(`    ${r.error}`);
        });
        console.log('');
    }

    // Create unified addresses file
    if (successful.length > 0 && !isDryRun) {
        console.log('📝 Creating unified addresses file...\n');
        const unifiedAddresses = {};

        successful.forEach(r => {
            const addressFile = path.join(__dirname, '..', 'src', 'config', `${r.chain}-addresses.json`);
            if (fs.existsSync(addressFile)) {
                const addresses = JSON.parse(fs.readFileSync(addressFile, 'utf-8'));
                unifiedAddresses[r.chain] = addresses;
            }
        });

        const unifiedPath = path.join(__dirname, '..', 'src', 'config', 'all-chains-addresses.json');
        fs.writeFileSync(unifiedPath, JSON.stringify(unifiedAddresses, null, 2));
        console.log(`✓ Saved to: ${unifiedPath}\n`);
    }

    // Final status
    console.log('═'.repeat(80));
    if (failed.length === 0) {
        console.log('✅ ALL DEPLOYMENTS SUCCESSFUL!');
    } else if (successful.length > 0) {
        console.log('⚠️  PARTIAL SUCCESS');
    } else {
        console.log('❌ ALL DEPLOYMENTS FAILED');
    }
    console.log('═'.repeat(80) + '\n');

    process.exit(failed.length > 0 ? 1 : 0);
}

main().catch(error => {
    console.error('\n❌ Error:', error);
    process.exit(1);
});
