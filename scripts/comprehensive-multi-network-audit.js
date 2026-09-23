/**
 * Comprehensive Multi-Network Audit
 * Tests Arc Testnet, Base Mainnet, and Arbitrum One
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Load ABIs
function loadAbi(name) {
    const abiPath = path.join(__dirname, '../abis', `${name}.json`);
    const abiFile = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
    return Array.isArray(abiFile) ? abiFile : abiFile.abi || abiFile;
}

const registryAbi = loadAbi('AgentRegistryV2');
const reputationAbi = loadAbi('ReputationManagerV3');
const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');
const usdcAbi = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];

// Network configurations
const NETWORKS = {
    arc: {
        name: 'Arc Testnet',
        chainId: 5042002,
        rpc: process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
        explorer: 'https://arc-testnet.explorer.com',
        addresses: require('../src/config/arc-testnet-addresses.json')
    },
    base: {
        name: 'Base Mainnet',
        chainId: 8453,
        rpc: 'https://mainnet.base.org',
        explorer: 'https://basescan.org',
        addresses: require('../src/config/base-addresses.json')
    },
    arbitrum: {
        name: 'Arbitrum One',
        chainId: 42161,
        rpc: 'https://arb1.arbitrum.io/rpc',
        explorer: 'https://arbiscan.io',
        addresses: require('../src/config/arbitrum-addresses.json')
    }
};

async function auditNetwork(networkKey) {
    const network = NETWORKS[networkKey];
    console.log(`\n${'='.repeat(60)}`);
    console.log(`🔍 AUDITING: ${network.name}`);
    console.log(`${'='.repeat(60)}\n`);

    const provider = new ethers.JsonRpcProvider(network.rpc, undefined, { batchMaxCount: 1 });
    const results = {
        network: network.name,
        chainId: network.chainId,
        timestamp: new Date().toISOString(),
        checks: []
    };

    try {
        // 1. Check RPC connection
        console.log('1️⃣  Testing RPC Connection...');
        const blockNumber = await provider.getBlockNumber();
        results.checks.push({
            name: 'RPC Connection',
            status: 'PASS',
            details: `Block ${blockNumber}`
        });
        console.log(`   ✅ Connected - Block: ${blockNumber}\n`);

        // 2. Verify contract deployments
        console.log('2️⃣  Verifying Contract Deployments...');
        const contracts = {
            Registry: new ethers.Contract(network.addresses.agentRegistryV2, registryAbi, provider),
            Reputation: new ethers.Contract(network.addresses.reputationManagerV3, reputationAbi, provider),
            Marketplace: new ethers.Contract(network.addresses.agentLiquidityMarketplace, marketplaceAbi, provider),
            USDC: new ethers.Contract(network.addresses.usdc, usdcAbi, provider)
        };

        for (const [name, contract] of Object.entries(contracts)) {
            try {
                const code = await provider.getCode(contract.target);
                if (code === '0x') {
                    throw new Error('No contract code at address');
                }
                results.checks.push({
                    name: `${name} Deployment`,
                    status: 'PASS',
                    details: contract.target
                });
                console.log(`   ✅ ${name}: ${contract.target}`);
            } catch (error) {
                results.checks.push({
                    name: `${name} Deployment`,
                    status: 'FAIL',
                    details: error.message
                });
                console.log(`   ❌ ${name}: ${error.message}`);
            }
        }
        console.log('');

        // 3. Check contract ownership
        console.log('3️⃣  Checking Contract Ownership...');
        try {
            const [regOwner, repOwner, mktOwner] = await Promise.all([
                contracts.Registry.owner(),
                contracts.Reputation.owner(),
                contracts.Marketplace.owner()
            ]);

            const allSame = regOwner === repOwner && repOwner === mktOwner;
            results.checks.push({
                name: 'Contract Ownership',
                status: allSame ? 'PASS' : 'WARN',
                details: {
                    registry: regOwner,
                    reputation: repOwner,
                    marketplace: mktOwner,
                    consistent: allSame
                }
            });

            console.log(`   Registry Owner:    ${regOwner}`);
            console.log(`   Reputation Owner:  ${repOwner}`);
            console.log(`   Marketplace Owner: ${mktOwner}`);
            console.log(`   ${allSame ? '✅' : '⚠️ '} Ownership ${allSame ? 'consistent' : 'INCONSISTENT'}\n`);
        } catch (error) {
            results.checks.push({
                name: 'Contract Ownership',
                status: 'FAIL',
                details: error.message
            });
            console.log(`   ❌ ${error.message}\n`);
        }

        // 4. Check marketplace authorization
        console.log('4️⃣  Checking Marketplace Authorization...');
        try {
            const isAuthorized = await contracts.Reputation.authorizedPools(network.addresses.agentLiquidityMarketplace);
            results.checks.push({
                name: 'Marketplace Authorization',
                status: isAuthorized ? 'PASS' : 'FAIL',
                details: `Marketplace ${isAuthorized ? 'IS' : 'NOT'} authorized in ReputationManager`
            });
            console.log(`   ${isAuthorized ? '✅' : '❌'} Marketplace ${isAuthorized ? 'IS' : 'NOT'} authorized\n`);
        } catch (error) {
            results.checks.push({
                name: 'Marketplace Authorization',
                status: 'FAIL',
                details: error.message
            });
            console.log(`   ❌ ${error.message}\n`);
        }

        // 5. Check agent counts
        console.log('5️⃣  Checking Agent Statistics...');
        try {
            const agentCount = await contracts.Registry.agentCount();
            results.checks.push({
                name: 'Agent Count',
                status: 'PASS',
                details: `${agentCount.toString()} agents registered`
            });
            console.log(`   ✅ Total Agents: ${agentCount}\n`);
        } catch (error) {
            results.checks.push({
                name: 'Agent Count',
                status: 'FAIL',
                details: error.message
            });
            console.log(`   ❌ ${error.message}\n`);
        }

        // 6. Test API endpoint
        console.log('6️⃣  Testing API Endpoint...');
        try {
            const apiUrl = process.env.API_URL || 'https://specular-production.up.railway.app';
            const response = await fetch(`${apiUrl}/health?network=${networkKey}`);
            const data = await response.json();

            if (data.ok && data.network === networkKey) {
                results.checks.push({
                    name: 'API Endpoint',
                    status: 'PASS',
                    details: `${apiUrl}/health?network=${networkKey}`
                });
                console.log(`   ✅ API responding correctly`);
                console.log(`   Block: ${data.blockNumber}\n`);
            } else {
                throw new Error('API returned unexpected response');
            }
        } catch (error) {
            results.checks.push({
                name: 'API Endpoint',
                status: 'FAIL',
                details: error.message
            });
            console.log(`   ❌ ${error.message}\n`);
        }

        // 7. USDC checks
        console.log('7️⃣  Checking USDC Contract...');
        try {
            const decimals = await contracts.USDC.decimals();
            if (decimals !== 6n) {
                throw new Error(`Invalid USDC decimals: ${decimals} (expected 6)`);
            }
            results.checks.push({
                name: 'USDC Contract',
                status: 'PASS',
                details: `Decimals: ${decimals}`
            });
            console.log(`   ✅ USDC Contract: ${network.addresses.usdc}`);
            console.log(`   Decimals: ${decimals}\n`);
        } catch (error) {
            results.checks.push({
                name: 'USDC Contract',
                status: 'FAIL',
                details: error.message
            });
            console.log(`   ❌ ${error.message}\n`);
        }

    } catch (error) {
        console.error(`❌ Network audit failed: ${error.message}\n`);
        results.error = error.message;
    }

    // Summary
    const passed = results.checks.filter(c => c.status === 'PASS').length;
    const failed = results.checks.filter(c => c.status === 'FAIL').length;
    const warned = results.checks.filter(c => c.status === 'WARN').length;
    const total = results.checks.length;

    console.log(`${'─'.repeat(60)}`);
    console.log(`📊 SUMMARY: ${network.name}`);
    console.log(`${'─'.repeat(60)}`);
    console.log(`   ✅ Passed: ${passed}/${total}`);
    if (warned > 0) console.log(`   ⚠️  Warnings: ${warned}/${total}`);
    if (failed > 0) console.log(`   ❌ Failed: ${failed}/${total}`);
    console.log(`${'─'.repeat(60)}\n`);

    results.summary = { passed, failed, warned, total };
    return results;
}

async function main() {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║     SPECULAR MULTI-NETWORK COMPREHENSIVE AUDIT             ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    console.log(`Date: ${new Date().toISOString()}\n`);

    const allResults = {};

    // Audit all networks
    for (const networkKey of ['arc', 'base', 'arbitrum']) {
        allResults[networkKey] = await auditNetwork(networkKey);
        await new Promise(resolve => setTimeout(resolve, 2000)); // Brief pause between networks
    }

    // Overall summary
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                    OVERALL SUMMARY                         ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    for (const [networkKey, results] of Object.entries(allResults)) {
        const { passed, failed, warned, total } = results.summary;
        const status = failed === 0 ? '✅' : '❌';
        console.log(`${status} ${results.network}: ${passed}/${total} passed${failed > 0 ? `, ${failed} failed` : ''}${warned > 0 ? `, ${warned} warnings` : ''}`);
    }

    // Save results
    const outputPath = path.join(__dirname, '../multi-network-audit-results.json');
    fs.writeFileSync(outputPath, JSON.stringify(allResults, null, 2));
    console.log(`\n📄 Full results saved to: ${outputPath}\n`);

    // Exit with error if any network failed
    const anyFailed = Object.values(allResults).some(r => r.summary.failed > 0);
    process.exit(anyFailed ? 1 : 0);
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
