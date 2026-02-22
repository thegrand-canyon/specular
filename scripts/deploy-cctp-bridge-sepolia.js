/**
 * Deploy CCTP Bridge on Sepolia Testnet
 * Enables deposits from Sepolia to Arc
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🔗 DEPLOYING CCTP BRIDGE ON SEPOLIA\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();

    console.log(`Deployer: ${deployer.address}`);

    // Check ETH balance
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log(`ETH Balance: ${ethers.formatEther(balance)} ETH\n`);

    // Load Arc addresses
    const arcAddressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const arcAddresses = JSON.parse(fs.readFileSync(arcAddressesPath, 'utf8'));

    // Sepolia CCTP addresses
    const sepoliaConfig = {
        tokenMessenger: '0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5',
        messageTransmitter: '0x7865fAfC2db2093669d92c0F33AeEF291086BEFD',
        usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        domain: 0
    };

    console.log('Sepolia CCTP Configuration:');
    console.log(`  TokenMessenger:     ${sepoliaConfig.tokenMessenger}`);
    console.log(`  MessageTransmitter: ${sepoliaConfig.messageTransmitter}`);
    console.log(`  USDC:               ${sepoliaConfig.usdc}\n`);

    console.log('Arc Configuration:');
    console.log(`  DepositRouter: ${arcAddresses.depositRouter}`);
    console.log(`  Marketplace:   ${arcAddresses.agentLiquidityMarketplace}\n`);

    // Deploy CCTPBridge
    console.log('📝 Deploying CCTPBridge...\n');
    const CCTPBridge = await ethers.getContractFactory('CCTPBridge');
    const bridge = await CCTPBridge.deploy(
        sepoliaConfig.tokenMessenger,
        sepoliaConfig.messageTransmitter,
        sepoliaConfig.usdc,
        arcAddresses.depositRouter,
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

    bridges.sepolia = {
        chainId: 11155111,
        bridge: bridgeAddress,
        usdc: sepoliaConfig.usdc,
        tokenMessenger: sepoliaConfig.tokenMessenger,
        messageTransmitter: sepoliaConfig.messageTransmitter,
        domain: sepoliaConfig.domain,
        arcDepositRouter: arcAddresses.depositRouter,
        arcMarketplace: arcAddresses.agentLiquidityMarketplace
    };

    fs.writeFileSync(bridgesPath, JSON.stringify(bridges, null, 2));

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 SEPOLIA BRIDGE DEPLOYMENT COMPLETE\n');
    console.log(`Bridge Address: ${bridgeAddress}\n`);

    console.log('Configuration saved to: src/config/bridges.json\n');

    console.log('🎯 NEXT STEPS:\n');
    console.log('1. Test bridge with:');
    console.log('   npx hardhat run scripts/test-sepolia-to-arc-bridge.js --network sepolia\n');
    console.log('2. Get Sepolia testnet USDC from:');
    console.log('   https://faucet.circle.com\n');

    console.log('✅ Deployment complete! 🚀\n');
}

main().catch(error => {
    console.error('Deployment failed:', error);
    process.exit(1);
});
