/**
 * Deploy CCTP Bridge on Base Sepolia Testnet
 * Enables deposits from Base Sepolia to Arc
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🔗 DEPLOYING CCTP BRIDGE ON BASE SEPOLIA\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();

    console.log(`Deployer: ${deployer.address}`);

    // Check ETH balance
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log(`ETH Balance: ${ethers.formatEther(balance)} ETH\n`);

    // Base Sepolia CCTP addresses
    const baseSepoliaConfig = {
        tokenMessenger: '0x877b8e8c1e4ec68d60b597e49c5d70E40b32E6Ff',
        messageTransmitter: '0x7865fAfC2db2093669d92c0F33AeEF291086BEFD',
        usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        domain: 6
    };

    // Arc addresses
    const arcConfig = {
        depositRouter: '0x5592AaFDdd1f73F5D7547e664f3513C409FB9796',
        marketplace: '0xD1cf6E7864Bc4CbBE52aA94369dF08B106927559'
    };

    console.log('Base Sepolia CCTP Configuration:');
    console.log(`  TokenMessenger:     ${baseSepoliaConfig.tokenMessenger}`);
    console.log(`  MessageTransmitter: ${baseSepoliaConfig.messageTransmitter}`);
    console.log(`  USDC:               ${baseSepoliaConfig.usdc}\n`);

    console.log('Arc Configuration:');
    console.log(`  DepositRouter: ${arcConfig.depositRouter}`);
    console.log(`  Marketplace:   ${arcConfig.marketplace}\n`);

    // Deploy CCTPBridge
    console.log('📝 Deploying CCTPBridge...\n');
    const CCTPBridge = await ethers.getContractFactory('CCTPBridge');
    const bridge = await CCTPBridge.deploy(
        baseSepoliaConfig.tokenMessenger,
        baseSepoliaConfig.messageTransmitter,
        baseSepoliaConfig.usdc,
        arcConfig.depositRouter,
        99 // Arc domain
    );

    await bridge.waitForDeployment();
    const bridgeAddress = await bridge.getAddress();

    console.log(`✅ CCTPBridge deployed: ${bridgeAddress}\n`);

    // Save configuration
    const bridgesPath = path.join(__dirname, '..', 'src', 'config', 'bridges.json');
    let bridges = {};
    try {
        bridges = JSON.parse(fs.readFileSync(bridgesPath, 'utf8'));
    } catch {}

    bridges.baseSepolia = {
        chainId: 84532,
        bridge: bridgeAddress,
        usdc: baseSepoliaConfig.usdc,
        tokenMessenger: baseSepoliaConfig.tokenMessenger,
        messageTransmitter: baseSepoliaConfig.messageTransmitter,
        domain: baseSepoliaConfig.domain,
        arcDepositRouter: arcConfig.depositRouter,
        arcMarketplace: arcConfig.marketplace
    };

    fs.writeFileSync(bridgesPath, JSON.stringify(bridges, null, 2));

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 BASE SEPOLIA BRIDGE DEPLOYMENT COMPLETE\n');
    console.log(`Bridge Address: ${bridgeAddress}\n`);

    console.log('Configuration saved to: src/config/bridges.json\n');

    console.log('🎯 NEXT STEPS:\n');
    console.log('1. Test bridge with:');
    console.log('   npx hardhat run scripts/test-sepolia-to-arc-bridge.js --network baseSepolia\n');
    console.log('2. Get Base Sepolia testnet USDC from:');
    console.log('   https://faucet.circle.com\n');

    console.log('✅ Deployment complete! 🚀\n');
}

main().catch(error => {
    console.error('Deployment failed:', error);
    process.exit(1);
});
