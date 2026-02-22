/**
 * Deploy CCTP Bridge on Optimism Sepolia Testnet
 * Enables deposits from Optimism Sepolia to Arc
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🔗 DEPLOYING CCTP BRIDGE ON OPTIMISM SEPOLIA\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();

    console.log(`Deployer: ${deployer.address}`);

    // Check ETH balance
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log(`ETH Balance: ${ethers.formatEther(balance)} ETH\n`);

    // Optimism Sepolia CCTP addresses
    const optimismSepoliaConfig = {
        tokenMessenger: '0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5',
        messageTransmitter: '0x7865fAfC2db2093669d92c0F33AeEF291086BEFD',
        usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
        domain: 2
    };

    // Arc addresses
    const arcConfig = {
        depositRouter: '0x5592AaFDdd1f73F5D7547e664f3513C409FB9796'
    };

    console.log('Optimism Sepolia CCTP Configuration:');
    console.log(`  TokenMessenger:     ${optimismSepoliaConfig.tokenMessenger}`);
    console.log(`  MessageTransmitter: ${optimismSepoliaConfig.messageTransmitter}`);
    console.log(`  USDC:               ${optimismSepoliaConfig.usdc}\n`);

    console.log('Arc Configuration:');
    console.log(`  DepositRouter: ${arcConfig.depositRouter}\n`);

    // Deploy CCTPBridge
    console.log('📝 Deploying CCTPBridge...\n');
    const CCTPBridge = await ethers.getContractFactory('CCTPBridge');
    const bridge = await CCTPBridge.deploy(
        optimismSepoliaConfig.tokenMessenger,
        optimismSepoliaConfig.messageTransmitter,
        optimismSepoliaConfig.usdc,
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

    bridges.optimismSepolia = {
        chainId: 11155420,
        bridge: bridgeAddress,
        usdc: optimismSepoliaConfig.usdc,
        tokenMessenger: optimismSepoliaConfig.tokenMessenger,
        messageTransmitter: optimismSepoliaConfig.messageTransmitter,
        domain: optimismSepoliaConfig.domain,
        arcDepositRouter: arcConfig.depositRouter
    };

    fs.writeFileSync(bridgesPath, JSON.stringify(bridges, null, 2));

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 OPTIMISM SEPOLIA BRIDGE DEPLOYMENT COMPLETE\n');
    console.log(`Bridge Address: ${bridgeAddress}\n`);

    console.log('Configuration saved to: src/config/bridges.json\n');

    console.log('🎯 NEXT STEPS:\n');
    console.log('1. Test bridge with:');
    console.log('   npx hardhat run scripts/test-sepolia-to-arc-bridge.js --network optimismSepolia\n');
    console.log('2. Get Optimism Sepolia testnet USDC from:');
    console.log('   https://faucet.circle.com\n');

    console.log('✅ Deployment complete! 🚀\n');
}

main().catch(error => {
    console.error('Deployment failed:', error);
    process.exit(1);
});
