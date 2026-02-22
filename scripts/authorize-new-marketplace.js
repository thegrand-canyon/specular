/**
 * Authorize new AgentLiquidityMarketplace in ReputationManagerV3
 * Run after upgrading marketplace
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🔐 AUTHORIZING NEW MARKETPLACE\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();

    // Load Arc Testnet addresses
    const arcAddressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const arcAddresses = JSON.parse(fs.readFileSync(arcAddressesPath, 'utf8'));

    console.log(`ReputationManagerV3: ${arcAddresses.reputationManagerV3}`);
    console.log(`New Marketplace: ${arcAddresses.agentLiquidityMarketplace}\n`);

    const reputationManager = await ethers.getContractAt(
        'ReputationManagerV3',
        arcAddresses.reputationManagerV3
    );

    // Check if already authorized
    const isAuthorized = await reputationManager.authorizedPools(arcAddresses.agentLiquidityMarketplace);

    if (isAuthorized) {
        console.log('✓ Marketplace already authorized\n');
    } else {
        console.log('⏳ Authorizing new marketplace...\n');

        const tx = await reputationManager.authorizePool(arcAddresses.agentLiquidityMarketplace);
        const receipt = await tx.wait();

        console.log('✅ Marketplace Authorized!\n');
        console.log(`   Transaction: ${receipt.hash}`);
        console.log(`   Block: ${receipt.blockNumber}\n`);
    }

    // Verify authorization
    const verifyAuthorized = await reputationManager.authorizedPools(arcAddresses.agentLiquidityMarketplace);
    console.log(`✓ Authorization Status: ${verifyAuthorized}\n`);

    // If old marketplace exists, optionally revoke it
    if (arcAddresses.agentLiquidityMarketplace_old) {
        console.log('⚠️  Old Marketplace Still Authorized:\n');
        console.log(`   Address: ${arcAddresses.agentLiquidityMarketplace_old}\n`);
        console.log('   To revoke old marketplace authorization, run:');
        console.log(`   await reputationManager.revokePool("${arcAddresses.agentLiquidityMarketplace_old}")\n`);
    }

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('✅ AUTHORIZATION COMPLETE!\n');
}

main().catch(error => {
    console.error('\n❌ Authorization failed:', error.message);
    process.exit(1);
});
