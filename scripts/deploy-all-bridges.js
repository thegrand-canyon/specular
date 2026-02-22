/**
 * Master orchestrator: Deploy CCTPBridge on all supported testnets
 * Runs each chain deployment in sequence and prints a summary table
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CHAINS = [
    { name: 'Base Sepolia',      network: 'baseSepolia',      script: 'deploy-cctp-bridge-base.js' },
    { name: 'Arbitrum Sepolia',  network: 'arbitrumSepolia',  script: 'deploy-cctp-bridge-arbitrum.js' },
    { name: 'Optimism Sepolia',  network: 'optimismSepolia',  script: 'deploy-cctp-bridge-optimism.js' },
    { name: 'Polygon Amoy',      network: 'polygonAmoy',      script: 'deploy-cctp-bridge-polygon.js' },
];

async function deployChain(chain) {
    const scriptPath = path.join(__dirname, chain.script);
    const cmd = `npx hardhat run ${scriptPath} --network ${chain.network}`;

    console.log(`\n${'═'.repeat(55)}`);
    console.log(`🚀 Starting deployment: ${chain.name}`);
    console.log(`   Network: ${chain.network}`);
    console.log(`   Script:  ${chain.script}`);
    console.log(`${'═'.repeat(55)}\n`);

    execSync(cmd, { stdio: 'inherit', cwd: path.join(__dirname, '..') });

    console.log(`\n✅ ${chain.name} deployment finished.\n`);
}

async function main() {
    console.log('\n🌐 DEPLOYING CCTP BRIDGES ON ALL CHAINS\n');
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('Chains to deploy:');
    CHAINS.forEach(c => console.log(`  • ${c.name} (${c.network})`));
    console.log();

    const results = [];

    for (const chain of CHAINS) {
        try {
            await deployChain(chain);
            results.push({ chain: chain.name, network: chain.network, status: 'SUCCESS', error: null });
        } catch (err) {
            console.error(`\n❌ Deployment failed for ${chain.name}:`);
            console.error(`   ${err.message}\n`);
            results.push({ chain: chain.name, network: chain.network, status: 'FAILED', error: err.message });
        }
    }

    // Run update-bridges-config to sync the final JSON
    console.log('\n📝 Updating bridges.json with all deployed addresses...\n');
    try {
        const updateScript = path.join(__dirname, 'update-bridges-config.js');
        execSync(`node ${updateScript}`, { stdio: 'inherit', cwd: path.join(__dirname, '..') });
    } catch (err) {
        console.error('⚠️  Could not run update-bridges-config.js:', err.message);
    }

    // Read final bridges.json for summary
    const bridgesPath = path.join(__dirname, '..', 'src', 'config', 'bridges.json');
    let bridges = {};
    try {
        bridges = JSON.parse(fs.readFileSync(bridgesPath, 'utf8'));
    } catch {}

    // Print summary table
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('📊 DEPLOYMENT SUMMARY\n');
    console.log(`${'Chain'.padEnd(22)} ${'Status'.padEnd(10)} Bridge Address`);
    console.log(`${'-'.repeat(22)} ${'-'.repeat(10)} ${'-'.repeat(42)}`);

    // Always include Sepolia (pre-deployed)
    const sepoliaBridge = bridges.sepolia?.bridge || '0x633e03c71aE37bD620d4482917aEC06D7C131AD5';
    console.log(`${'Sepolia (existing)'.padEnd(22)} ${'OK'.padEnd(10)} ${sepoliaBridge}`);

    for (const result of results) {
        const networkKey = result.network;
        const bridgeAddress = bridges[networkKey]?.bridge || 'N/A';
        const statusLabel = result.status === 'SUCCESS' ? 'OK' : 'FAILED';
        console.log(`${result.chain.padEnd(22)} ${statusLabel.padEnd(10)} ${bridgeAddress}`);
    }

    console.log('\nConfiguration saved to: src/config/bridges.json\n');

    const failed = results.filter(r => r.status === 'FAILED');
    if (failed.length > 0) {
        console.log('⚠️  FAILED CHAINS:\n');
        failed.forEach(r => {
            console.log(`  • ${r.chain} (${r.network})`);
            console.log(`    Reason: ${r.error}\n`);
        });
        console.log(`${failed.length} chain(s) failed. Review errors above and re-run individual scripts.\n`);
        process.exit(1);
    }

    console.log('✅ All bridge deployments complete! 🚀\n');
}

main().catch(error => {
    console.error('Orchestrator failed:', error);
    process.exit(1);
});
