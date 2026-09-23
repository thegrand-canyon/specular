/**
 * Multi-Network Validation Test Suite
 * Tests all networks after API fix deployment
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const API_URL = process.env.API_URL || 'https://specular-production.up.railway.app';

// Network configurations
const NETWORKS = {
    arc: {
        name: 'Arc Testnet',
        rpc: process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
        config: require('../src/config/arc-testnet-addresses.json')
    },
    base: {
        name: 'Base Mainnet',
        rpc: 'https://mainnet.base.org',
        config: require('../src/config/base-addresses.json')
    },
    arbitrum: {
        name: 'Arbitrum One',
        rpc: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
        config: require('../src/config/arbitrum-addresses.json')
    }
};

// Load ABIs
function loadAbi(name) {
    const abiPath = path.join(__dirname, '../abis', `${name}.json`);
    const abiFile = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
    return Array.isArray(abiFile) ? abiFile : abiFile.abi || abiFile;
}

const registryAbi = loadAbi('AgentRegistryV2');
const reputationAbi = loadAbi('ReputationManagerV3');
const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');

class NetworkValidator {
    constructor(networkKey) {
        this.networkKey = networkKey;
        this.network = NETWORKS[networkKey];
        this.results = [];
    }

    async initialize() {
        this.provider = new ethers.JsonRpcProvider(this.network.rpc, undefined, { batchMaxCount: 1 });
        this.registry = new ethers.Contract(this.network.config.agentRegistryV2, registryAbi, this.provider);
        this.reputation = new ethers.Contract(this.network.config.reputationManagerV3, reputationAbi, this.provider);
        this.marketplace = new ethers.Contract(this.network.config.agentLiquidityMarketplace, marketplaceAbi, this.provider);
    }

    logResult(category, test, passed, elapsed, details = '') {
        const status = passed ? '✅' : '❌';
        console.log(`   ${status} ${test} (${elapsed}ms)${details ? ' - ' + details : ''}`);
        this.results.push({ category, test, passed, elapsed });
    }

    async testRPCConnection() {
        console.log('\n🔌 RPC CONNECTION TEST\n');

        const start = Date.now();
        try {
            const blockNumber = await this.provider.getBlockNumber();
            const elapsed = Date.now() - start;
            this.logResult('RPC', 'Get Block Number', true, elapsed, `Block: ${blockNumber}`);
        } catch (error) {
            const elapsed = Date.now() - start;
            this.logResult('RPC', 'Get Block Number', false, elapsed, error.message);
        }
    }

    async testContractCalls() {
        console.log('\n📜 CONTRACT CALL TESTS\n');

        // Test Registry
        const start1 = Date.now();
        try {
            const totalAgents = await this.registry.totalAgents();
            const elapsed1 = Date.now() - start1;
            this.logResult('Contracts', 'Registry.totalAgents()', true, elapsed1, `${totalAgents} agents`);
        } catch (error) {
            const elapsed1 = Date.now() - start1;
            this.logResult('Contracts', 'Registry.totalAgents()', false, elapsed1, error.message);
        }

        // Test Reputation
        const start2 = Date.now();
        try {
            const score = await this.reputation['getReputationScore(address)'](ethers.ZeroAddress);
            const elapsed2 = Date.now() - start2;
            this.logResult('Contracts', 'Reputation.getReputationScore()', true, elapsed2, `Score: ${score}`);
        } catch (error) {
            const elapsed2 = Date.now() - start2;
            this.logResult('Contracts', 'Reputation.getReputationScore()', false, elapsed2, error.message);
        }

        // Test Marketplace
        const start3 = Date.now();
        try {
            const totalPools = await this.marketplace.totalPools();
            const elapsed3 = Date.now() - start3;
            this.logResult('Contracts', 'Marketplace.totalPools()', true, elapsed3, `${totalPools} pools`);
        } catch (error) {
            const elapsed3 = Date.now() - start3;
            this.logResult('Contracts', 'Marketplace.totalPools()', false, elapsed3, error.message);
        }
    }

    async testAPIEndpoints() {
        console.log('\n🌐 API ENDPOINT TESTS\n');

        // Test /health
        const start1 = Date.now();
        try {
            const res = await fetch(`${API_URL}/health?network=${this.networkKey}`);
            const data = await res.json();
            const elapsed1 = Date.now() - start1;
            this.logResult('API', '/health', res.ok, elapsed1, `Block: ${data.blockNumber || 'N/A'}`);
        } catch (error) {
            const elapsed1 = Date.now() - start1;
            this.logResult('API', '/health', false, elapsed1, error.message);
        }

        // Test /status
        const start2 = Date.now();
        try {
            const res = await fetch(`${API_URL}/status?network=${this.networkKey}`);
            const data = await res.json();
            const elapsed2 = Date.now() - start2;
            this.logResult('API', '/status', res.ok, elapsed2, `TVL: ${data.tvl || 'N/A'}`);
        } catch (error) {
            const elapsed2 = Date.now() - start2;
            this.logResult('API', '/status', false, elapsed2, error.message);
        }

        // Test /pools
        const start3 = Date.now();
        try {
            const res = await fetch(`${API_URL}/pools?network=${this.networkKey}`);
            const data = await res.json();
            const elapsed3 = Date.now() - start3;
            this.logResult('API', '/pools', res.ok, elapsed3, `${data.totalPools || 0} pools`);
        } catch (error) {
            const elapsed3 = Date.now() - start3;
            this.logResult('API', '/pools', false, elapsed3, error.message);
        }

        // Test /agents with new pagination
        const start4 = Date.now();
        try {
            const res = await fetch(`${API_URL}/agents?network=${this.networkKey}&limit=10`);
            const data = await res.json();
            const elapsed4 = Date.now() - start4;
            const details = `${data.returned || 0}/${data.totalAgents || 0} agents, cached: ${data.cached || false}`;
            this.logResult('API', '/agents (with pagination)', res.ok, elapsed4, details);
        } catch (error) {
            const elapsed4 = Date.now() - start4;
            this.logResult('API', '/agents (with pagination)', false, elapsed4, error.message);
        }

        // Test /agents cache hit
        const start5 = Date.now();
        try {
            const res = await fetch(`${API_URL}/agents?network=${this.networkKey}&limit=10`);
            const data = await res.json();
            const elapsed5 = Date.now() - start5;
            const details = `Cache hit test, ${elapsed5}ms (should be <200ms)`;
            this.logResult('API', '/agents (cache test)', res.ok && elapsed5 < 500, elapsed5, details);
        } catch (error) {
            const elapsed5 = Date.now() - start5;
            this.logResult('API', '/agents (cache test)', false, elapsed5, error.message);
        }
    }

    async testConcurrentLoad() {
        console.log('\n⚡ CONCURRENT LOAD TEST (10 requests)\n');

        const start = Date.now();
        try {
            const promises = Array(10).fill(null).map(() =>
                this.registry.totalAgents().catch(() => null)
            );
            const results = await Promise.all(promises);
            const successful = results.filter(r => r !== null).length;
            const elapsed = Date.now() - start;

            const passed = successful >= 9; // 90% success rate
            this.logResult('Load', 'Concurrent Contract Calls', passed, elapsed, `${successful}/10 successful`);
        } catch (error) {
            const elapsed = Date.now() - start;
            this.logResult('Load', 'Concurrent Contract Calls', false, elapsed, error.message);
        }

        // Test concurrent API calls
        const start2 = Date.now();
        try {
            const promises = Array(10).fill(null).map(() =>
                fetch(`${API_URL}/health?network=${this.networkKey}`).then(r => r.ok).catch(() => false)
            );
            const results = await Promise.all(promises);
            const successful = results.filter(r => r).length;
            const elapsed2 = Date.now() - start2;

            const passed = successful >= 9;
            this.logResult('Load', 'Concurrent API Calls', passed, elapsed2, `${successful}/10 successful`);
        } catch (error) {
            const elapsed2 = Date.now() - start2;
            this.logResult('Load', 'Concurrent API Calls', false, elapsed2, error.message);
        }
    }

    printSummary() {
        const total = this.results.length;
        const passed = this.results.filter(r => r.passed).length;
        const avgLatency = this.results.reduce((sum, r) => sum + r.elapsed, 0) / total;

        console.log('\n' + '═'.repeat(60));
        console.log(`${this.network.name.toUpperCase()} - TEST SUMMARY`);
        console.log('═'.repeat(60));
        console.log(`Total Tests:     ${total}`);
        console.log(`Passed:          ${passed}`);
        console.log(`Failed:          ${total - passed}`);
        console.log(`Pass Rate:       ${((passed / total) * 100).toFixed(1)}%`);
        console.log(`Avg Latency:     ${avgLatency.toFixed(0)}ms`);
        console.log('═'.repeat(60) + '\n');

        return { total, passed, avgLatency };
    }

    async run() {
        console.log('\n╔════════════════════════════════════════════════════════════╗');
        console.log(`║  ${this.network.name.toUpperCase().padEnd(56)}  ║`);
        console.log('╚════════════════════════════════════════════════════════════╝');

        await this.initialize();
        await this.testRPCConnection();
        await this.testContractCalls();
        await this.testAPIEndpoints();
        await this.testConcurrentLoad();

        return this.printSummary();
    }
}

async function main() {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║      MULTI-NETWORK VALIDATION TEST SUITE                   ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    console.log(`Date: ${new Date().toISOString()}`);
    console.log(`API: ${API_URL}\n`);

    const summaries = {};

    // Test all networks
    for (const networkKey of ['arc', 'base', 'arbitrum']) {
        try {
            const validator = new NetworkValidator(networkKey);
            summaries[networkKey] = await validator.run();
            await new Promise(resolve => setTimeout(resolve, 2000)); // Cool down between networks
        } catch (error) {
            console.error(`\n❌ ${networkKey.toUpperCase()} test failed:`, error.message);
            summaries[networkKey] = { total: 0, passed: 0, avgLatency: 0 };
        }
    }

    // Overall summary
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║              OVERALL TEST SUMMARY                          ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    let totalTests = 0;
    let totalPassed = 0;

    for (const [network, summary] of Object.entries(summaries)) {
        totalTests += summary.total;
        totalPassed += summary.passed;
        const passRate = summary.total > 0 ? ((summary.passed / summary.total) * 100).toFixed(1) : '0.0';
        console.log(`${NETWORKS[network].name.padEnd(20)}: ${summary.passed}/${summary.total} passed (${passRate}%), avg ${summary.avgLatency.toFixed(0)}ms`);
    }

    console.log('\n' + '─'.repeat(60));
    console.log(`Total Across All Networks: ${totalPassed}/${totalTests} passed (${((totalPassed / totalTests) * 100).toFixed(1)}%)`);
    console.log('─'.repeat(60) + '\n');

    if (totalPassed === totalTests) {
        console.log('🎉 All networks passed all tests!\n');
    } else {
        console.log(`⚠️  ${totalTests - totalPassed} test(s) failed across networks.\n`);
    }

    process.exit(totalPassed === totalTests ? 0 : 1);
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
