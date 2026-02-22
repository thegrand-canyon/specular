/**
 * Update bridges.json with all CCTP Bridge deployment addresses
 * Merges live deployed addresses with static chain/CCTP configuration
 * and writes a unified src/config/bridges.json
 */

const fs = require('fs');
const path = require('path');

// Static CCTP configuration per chain (addresses that never change)
const CHAIN_CONFIG = {
    sepolia: {
        chainId: 11155111,
        domain: 0,
        usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
        tokenMessenger: '0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5',
        messageTransmitter: '0x7865fAfC2db2093669d92c0F33AeEF291086BEFD',
        arcDepositRouter: '0x5592AaFDdd1f73F5D7547e664f3513C409FB9796',
        arcMarketplace: '0xD1cf6E7864Bc4CbBE52aA94369dF08B106927559',
        // Pre-deployed bridge address
        bridge: '0x633e03c71aE37bD620d4482917aEC06D7C131AD5'
    },
    baseSepolia: {
        chainId: 84532,
        domain: 6,
        usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        tokenMessenger: '0x877b8e8c1e4ec68d60b597e49c5d70E40b32E6Ff',
        messageTransmitter: '0x7865fAfC2db2093669d92c0F33AeEF291086BEFD',
        arcDepositRouter: '0x5592AaFDdd1f73F5D7547e664f3513C409FB9796',
        arcMarketplace: '0xD1cf6E7864Bc4CbBE52aA94369dF08B106927559'
    },
    arbitrumSepolia: {
        chainId: 421614,
        domain: 3,
        usdc: '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d',
        tokenMessenger: '0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5',
        messageTransmitter: '0xaCF1ceeF35caAc005e15888dDb8A3515C41B4872',
        arcDepositRouter: '0x5592AaFDdd1f73F5D7547e664f3513C409FB9796'
    },
    optimismSepolia: {
        chainId: 11155420,
        domain: 2,
        usdc: '0x5fd84259d66Cd46123540766Be93DFE6D43130D7',
        tokenMessenger: '0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5',
        messageTransmitter: '0x7865fAfC2db2093669d92c0F33AeEF291086BEFD',
        arcDepositRouter: '0x5592AaFDdd1f73F5D7547e664f3513C409FB9796'
    },
    polygonAmoy: {
        chainId: 80002,
        domain: 7,
        usdc: '0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582',
        tokenMessenger: '0x9f3B8679c73C2Fef8b59B4f3444d4e156fb70AA5',
        messageTransmitter: '0x7865fAfC2db2093669d92c0F33AeEF291086BEFD',
        arcDepositRouter: '0x5592AaFDdd1f73F5D7547e664f3513C409FB9796'
    }
};

function main() {
    console.log('\n📝 UPDATING BRIDGES CONFIGURATION\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const bridgesPath = path.join(__dirname, '..', 'src', 'config', 'bridges.json');

    // Load existing bridges.json (may contain live deployed addresses from prior runs)
    let existingBridges = {};
    try {
        existingBridges = JSON.parse(fs.readFileSync(bridgesPath, 'utf8'));
        console.log('Loaded existing bridges.json\n');
    } catch {
        console.log('No existing bridges.json found — starting fresh\n');
    }

    // Merge: static config is the base; deployed bridge addresses override/extend it
    const merged = {};

    for (const [network, staticCfg] of Object.entries(CHAIN_CONFIG)) {
        const deployed = existingBridges[network] || {};

        merged[network] = {
            chainId: staticCfg.chainId,
            domain: staticCfg.domain,
            // Prefer the live deployed address; fall back to static (Sepolia pre-deployed)
            bridge: deployed.bridge || staticCfg.bridge || null,
            usdc: staticCfg.usdc,
            tokenMessenger: staticCfg.tokenMessenger,
            messageTransmitter: staticCfg.messageTransmitter,
            arcDepositRouter: staticCfg.arcDepositRouter,
            ...(staticCfg.arcMarketplace ? { arcMarketplace: staticCfg.arcMarketplace } : {})
        };
    }

    fs.writeFileSync(bridgesPath, JSON.stringify(merged, null, 2));

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 BRIDGES CONFIGURATION SUMMARY\n');
    console.log(`${'Network'.padEnd(20)} ${'Chain ID'.padEnd(12)} ${'Domain'.padEnd(8)} Bridge Address`);
    console.log(`${'-'.repeat(20)} ${'-'.repeat(12)} ${'-'.repeat(8)} ${'-'.repeat(42)}`);

    for (const [network, cfg] of Object.entries(merged)) {
        const bridgeAddr = cfg.bridge || '(not deployed)';
        console.log(`${network.padEnd(20)} ${String(cfg.chainId).padEnd(12)} ${String(cfg.domain).padEnd(8)} ${bridgeAddr}`);
    }

    console.log('\nConfiguration written to: src/config/bridges.json\n');
    console.log('✅ Done!\n');
}

main();
