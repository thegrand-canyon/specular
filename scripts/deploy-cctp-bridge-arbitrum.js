/**
 * Deploy CCTP Bridge on Arbitrum Sepolia Testnet
 * Enables deposits from Arbitrum Sepolia to Arc
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🔗 DEPLOYING CCTP BRIDGE ON ARBITRUM SEPOLIA\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();

    console.log(`Deployer: ${deployer.address}`);

    // Check ETH balance
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log(`ETH Balance: ${ethers.formatEther(balance)} ETH\n`);

    // Arbitrum Sepolia CCTP addresses
    const arbitrumSepoliaConfig = {
        tokenMessenger: '0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5',
        messageTransmitter: '0xaCF1ceeF35caAc005e15888dDb8A3515C41B4872',
        usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
        domain: 3
    };

    // Arc addresses
    const arcConfig = {
        depositRouter: '0x5592AaFDdd1f73F5D7547e664f3513C409FB9796'
    };

    console.log('Arbitrum Sepolia CCTP Configuration:');
    console.log(`  TokenMessenger:     ${arbitrumSepoliaConfig.tokenMessenger}`);
    console.log(`  MessageTransmitter: ${arbitrumSepoliaConfig.messageTransmitter}`);
    console.log(`  USDC:               ${arbitrumSepoliaConfig.usdc}\n`);

    console.log('Arc Configuration:');
    console.log(`  DepositRouter: ${arcConfig.depositRouter}\n`);

    // Deploy CCTPBridge
    console.log('📝 Deploying CCTPBridge...\n');
    const CCTPBridge = await ethers.getContractFactory('CCTPBridge');
    const bridge = await CCTPBridge.deploy(
        arbitrumSepoliaConfig.tokenMessenger,
        arbitrumSepoliaConfig.messageTransmitter,
        arbitrumSepoliaConfig.usdc,
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

    bridges.arbitrumSepolia = {
        chainId: 421614,
        bridge: bridgeAddress,
        usdc: arbitrumSepoliaConfig.usdc,
        tokenMessenger: arbitrumSepoliaConfig.tokenMessenger,
        messageTransmitter: arbitrumSepoliaConfig.messageTransmitter,
        domain: arbitrumSepoliaConfig.domain,
        arcDepositRouter: arcConfig.depositRouter
    };

    fs.writeFileSync(bridgesPath, JSON.stringify(bridges, null, 2));

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 ARBITRUM SEPOLIA BRIDGE DEPLOYMENT COMPLETE\n');
    console.log(`Bridge Address: ${bridgeAddress}\n`);

    console.log('Configuration saved to: src/config/bridges.json\n');

    console.log('🎯 NEXT STEPS:\n');
    console.log('1. Test bridge with:');
    console.log('   npx hardhat run scripts/test-sepolia-to-arc-bridge.js --network arbitrumSepolia\n');
    console.log('2. Get Arbitrum Sepolia testnet USDC from:');
    console.log('   https://faucet.circle.com\n');

    console.log('✅ Deployment complete! 🚀\n');
}

main().catch(error => {
    console.error('Deployment failed:', error);
    process.exit(1);
});
