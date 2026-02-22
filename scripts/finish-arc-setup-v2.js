/**
 * Finish Arc setup - save addresses and check status
 */

const fs = require('fs');
const path = require('path');
const { ethers } = require('hardhat');

async function main() {
    console.log('\n✅ FINISHING ARC SETUP\n');

    const addresses = {
        agentRegistryV2: '0x741C03c0d95d2c15E479CE1c7E69B3196d86faD7',
        reputationManagerV3: '0x94F2fa47c4488202a46dAA9038Ed9C9c4c07467F',
        mockUSDC: '0xf2807051e292e945751A25616705a9aadfb39895',
        agentLiquidityMarketplace: '0xD1cf6E7864Bc4CbBE52aA94369dF08B106927559'
    };

    // Save addresses
    const configDir = path.join(__dirname, '..', 'src', 'config');
    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }

    const addressesPath = path.join(configDir, 'arc-testnet-addresses.json');
    fs.writeFileSync(addressesPath, JSON.stringify(addresses, null, 2));

    console.log('📁 Addresses saved!\n');

    // Check marketplace status
    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);

    try {
        const isPaused = await marketplace.paused();
        console.log(`Marketplace paused: ${isPaused}`);

        if (isPaused) {
            console.log('Unpausing marketplace...');
            await marketplace.unpause();
            console.log('✅ Marketplace is now active!\n');
        } else {
            console.log('✅ Marketplace is already active!\n');
        }
    } catch (error) {
        console.log(`Note: ${error.message}\n`);
    }

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 ARC DEPLOYMENT COMPLETE\n');
    console.log('Deployed Contracts:');
    console.log(`  AgentRegistryV2:            ${addresses.agentRegistryV2}`);
    console.log(`  ReputationManagerV3:        ${addresses.reputationManagerV3}`);
    console.log(`  MockUSDC:                   ${addresses.mockUSDC}`);
    console.log(`  AgentLiquidityMarketplace:  ${addresses.agentLiquidityMarketplace}\n`);

    console.log('🎯 NEXT:\n');
    console.log('Run: npx hardhat run scripts/arc-create-agents-v2.js --network arcTestnet\n');
}

main().catch(console.error);
