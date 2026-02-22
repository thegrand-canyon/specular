/**
 * Finish Arc Testnet Setup
 * Complete the authorization and unpause steps for already-deployed contracts
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🔧 FINISHING ARC TESTNET SETUP\n');
    console.log('═══════════════════════════════════════════════════════\n');

    // Use the addresses from your deployment
    const addresses = {
        agentRegistry: '0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb',
        reputationManagerV3: '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF',
        mockUSDC: '0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE',
        agentLiquidityMarketplace: '0x5194D976F2f1B59C0500cDe1e54A362d9BB9124B'
    };

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);

    console.log('Deployed Contracts:');
    console.log(`  Marketplace: ${addresses.agentLiquidityMarketplace}`);
    console.log(`  ReputationManager: ${addresses.reputationManagerV3}\n`);

    // 1. Authorize marketplace in reputation manager
    console.log('1️⃣  Authorizing marketplace...');
    try {
        const tx1 = await reputationManager.authorizePool(addresses.agentLiquidityMarketplace);
        await tx1.wait();
        console.log('   ✅ Marketplace authorized in ReputationManager\n');
    } catch (error) {
        console.log(`   ⚠️  ${error.message}\n`);
    }

    // 2. Unpause marketplace
    console.log('2️⃣  Unpausing marketplace...');
    try {
        const tx2 = await marketplace.unpause();
        await tx2.wait();
        console.log('   ✅ Marketplace is active!\n');
    } catch (error) {
        console.log(`   ⚠️  ${error.message}\n`);
    }

    // 3. Verify everything is set up
    console.log('3️⃣  Verifying setup...');
    const isPaused = await marketplace.paused();
    const isAuthorized = await reputationManager.authorizedPools(addresses.agentLiquidityMarketplace);

    console.log(`   Marketplace paused: ${isPaused ? '❌ Yes (needs unpause)' : '✅ No (active)'}`);
    console.log(`   Marketplace authorized: ${isAuthorized ? '✅ Yes' : '❌ No'}\n`);

    // Save addresses
    const configDir = path.join(__dirname, '..', 'src', 'config');
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }

    const addressesPath = path.join(configDir, 'arc-testnet-addresses.json');
    fs.writeFileSync(addressesPath, JSON.stringify(addresses, null, 2));

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 ARC TESTNET DEPLOYMENT COMPLETE!\n');
    console.log('Network: Arc Testnet');
    console.log(`Chain ID: 5042002\n`);
    console.log('Contracts:');
    console.log(`  AgentRegistry:              ${addresses.agentRegistry}`);
    console.log(`  ReputationManagerV3:        ${addresses.reputationManagerV3}`);
    console.log(`  MockUSDC:                   ${addresses.mockUSDC}`);
    console.log(`  AgentLiquidityMarketplace:  ${addresses.agentLiquidityMarketplace}\n`);

    console.log(`📁 Addresses saved to: ${addressesPath}\n`);

    console.log('🔍 View on Arcscan:');
    console.log(`   https://testnet.arcscan.app/address/${addresses.agentLiquidityMarketplace}\n`);

    console.log('✅ Setup complete! Ready to test on Arc! 🚀\n');
}

main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
