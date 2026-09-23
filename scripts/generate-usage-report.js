/**
 * Generate Comprehensive Usage Report
 * Combines data from both networks and creates a detailed report
 */

const { ethers } = require('ethers');
const fs = require('fs');

const NETWORKS = {
    base: {
        name: 'Base Mainnet',
        rpc: 'https://mainnet.base.org',
        chainId: 8453,
        contracts: {
            registry: '0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb',
            marketplace: '0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE',
            reputation: '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF',
            usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
        }
    },
    arc: {
        name: 'Arc Testnet',
        rpc: 'https://arc-testnet.drpc.org',
        chainId: 5042002,
        contracts: {
            registry: '0x741C03c0d95d2c15E479CE1c7E69B3196d86faD7',
            marketplace: '0x048363A325A5B188b7FF157d725C5e329f0171D3',
            reputation: '0x94F2fa47c4488202a46dAA9038Ed9C9c4c07467F',
            usdc: '0xf2807051e292e945751A25616705a9aadfb39895'
        }
    }
};

async function getNetworkData(network) {
    const config = NETWORKS[network];
    const provider = new ethers.JsonRpcProvider(config.rpc, config.chainId, { batchMaxCount: 1 });

    // Simple ABIs for what we need
    const registry = new ethers.Contract(config.contracts.registry, [
        'function totalAgents() view returns (uint256)'
    ], provider);

    const marketplace = new ethers.Contract(config.contracts.marketplace, [
        'function getTotalValueLocked() view returns (uint256)'
    ], provider);

    try {
        const [totalAgents, tvl] = await Promise.all([
            registry.totalAgents(),
            marketplace.getTotalValueLocked()
        ]);

        return {
            network,
            networkName: config.name,
            chainId: config.chainId,
            totalAgents: Number(totalAgents),
            tvl: Number(ethers.formatUnits(tvl, 6)),
            contracts: config.contracts,
            timestamp: new Date().toISOString()
        };
    } catch (error) {
        console.error(`Error fetching ${config.name} data:`, error.message);
        return {
            network,
            networkName: config.name,
            error: error.message
        };
    }
}

async function main() {
    console.log('\n' + '='.repeat(80));
    console.log('  SPECULAR PROTOCOL - COMPREHENSIVE USAGE REPORT');
    console.log('  ' + new Date().toISOString().split('T')[0]);
    console.log('='.repeat(80) + '\n');

    console.log('Fetching data from both networks...\n');

    const [arcData, baseData] = await Promise.all([
        getNetworkData('arc'),
        getNetworkData('base')
    ]);

    // Combined statistics
    const totalAgents = (arcData.totalAgents || 0) + (baseData.totalAgents || 0);
    const totalTVL = (arcData.tvl || 0) + (baseData.tvl || 0);

    // Print report
    console.log('─'.repeat(80));
    console.log('  ARC TESTNET');
    console.log('─'.repeat(80));
    console.log(`  Total Agents:     ${arcData.totalAgents || 'N/A'}`);
    console.log(`  TVL:              $${(arcData.tvl || 0).toLocaleString()} USDC`);
    console.log(`  Chain ID:         ${arcData.chainId}`);
    console.log(`  Registry:         ${arcData.contracts?.registry || 'N/A'}`);
    console.log(`  Marketplace:      ${arcData.contracts?.marketplace || 'N/A'}`);

    console.log('\n' + '─'.repeat(80));
    console.log('  BASE MAINNET');
    console.log('─'.repeat(80));
    console.log(`  Total Agents:     ${baseData.totalAgents || 'N/A'}`);
    console.log(`  TVL:              $${(baseData.tvl || 0).toLocaleString()} USDC`);
    console.log(`  Chain ID:         ${baseData.chainId}`);
    console.log(`  Registry:         ${baseData.contracts?.registry || 'N/A'}`);
    console.log(`  Marketplace:      ${baseData.contracts?.marketplace || 'N/A'}`);

    console.log('\n' + '─'.repeat(80));
    console.log('  COMBINED TOTALS');
    console.log('─'.repeat(80));
    console.log(`  Total Agents:     ${totalAgents}`);
    console.log(`  Combined TVL:     $${totalTVL.toLocaleString()} USDC`);
    console.log(`  Networks:         2 (Arc Testnet + Base Mainnet)`);

    console.log('\n' + '='.repeat(80) + '\n');

    // Save full report
    const report = {
        generatedAt: new Date().toISOString(),
        summary: {
            totalAgents,
            combinedTVL: totalTVL,
            networks: 2
        },
        networks: {
            arc: arcData,
            base: baseData
        }
    };

    const filename = `usage-report-${Date.now()}.json`;
    fs.writeFileSync(filename, JSON.stringify(report, null, 2));
    console.log(`📄 Full report saved to: ${filename}\n`);

    return report;
}

if (require.main === module) {
    main().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { main };
