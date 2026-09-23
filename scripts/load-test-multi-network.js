/**
 * Comprehensive Load Test for Specular Protocol
 * Tests performance and stability across all networks under load
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
const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');
const usdcAbi = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256)', 'function transfer(address,uint256)'];

// Network configurations
const NETWORKS = {
    arc: {
        name: 'Arc Testnet',
        rpc: process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
        chainId: 5042002,
        addresses: require('../src/config/arc-testnet-addresses.json')
    },
    base: {
        name: 'Base Mainnet',
        rpc: 'https://mainnet.base.org',
        chainId: 8453,
        addresses: require('../src/config/base-addresses.json')
    },
    arbitrum: {
        name: 'Arbitrum One',
        rpc: 'https://arb1.arbitrum.io/rpc',
        chainId: 42161,
        addresses: require('../src/config/arbitrum-addresses.json')
    }
};

class LoadTest {
    constructor(networkKey, concurrency = 5, operations = 20) {
        this.network = NETWORKS[networkKey];
        this.networkKey = networkKey;
        this.concurrency = concurrency;
        this.totalOperations = operations;
        this.results = {
            network: this.network.name,
            timestamp: new Date().toISOString(),
            config: {
                concurrency,
                totalOperations: operations
            },
            operations: [],
            summary: {
                successful: 0,
                failed: 0,
                totalTime: 0,
                avgLatency: 0,
                throughput: 0
            }
        };
    }

    async initialize() {
        this.provider = new ethers.JsonRpcProvider(this.network.rpc, this.network.chainId, {
            batchMaxCount: 1,
            staticNetwork: true
        });

        this.registry = new ethers.Contract(this.network.addresses.agentRegistryV2, registryAbi, this.provider);
        this.marketplace = new ethers.Contract(this.network.addresses.agentLiquidityMarketplace, marketplaceAbi, this.provider);
        this.usdc = new ethers.Contract(this.network.addresses.usdc, usdcAbi, this.provider);
    }

    async createTestWallet() {
        const wallet = ethers.Wallet.createRandom().connect(this.provider);
        return wallet;
    }

    async measureOperation(name, operation) {
        const startTime = Date.now();
        try {
            const result = await operation();
            const endTime = Date.now();
            const latency = endTime - startTime;

            this.results.operations.push({
                name,
                status: 'SUCCESS',
                latency,
                timestamp: new Date().toISOString()
            });

            this.results.summary.successful++;
            return { success: true, latency };
        } catch (error) {
            const endTime = Date.now();
            const latency = endTime - startTime;

            this.results.operations.push({
                name,
                status: 'FAILED',
                latency,
                error: error.message,
                timestamp: new Date().toISOString()
            });

            this.results.summary.failed++;
            return { success: false, latency, error: error.message };
        }
    }

    async testRegistryReads(count = 10) {
        console.log(`  Testing ${count} concurrent registry reads...`);

        const operations = [];
        for (let i = 0; i < count; i++) {
            const testAddress = ethers.Wallet.createRandom().address;
            operations.push(
                this.measureOperation('RegistryRead', async () => {
                    return await this.registry.isRegistered(testAddress);
                })
            );
        }

        const results = await Promise.all(operations);
        const successful = results.filter(r => r.success).length;
        const avgLatency = results.reduce((sum, r) => sum + r.latency, 0) / results.length;

        console.log(`     ✅ ${successful}/${count} successful, avg ${avgLatency.toFixed(0)}ms`);
        return results;
    }

    async testMarketplaceReads(count = 10) {
        console.log(`  Testing ${count} concurrent marketplace reads...`);

        const operations = [];
        for (let i = 0; i < count; i++) {
            operations.push(
                this.measureOperation('MarketplaceRead', async () => {
                    return await this.marketplace.paused();
                })
            );
        }

        const results = await Promise.all(operations);
        const successful = results.filter(r => r.success).length;
        const avgLatency = results.reduce((sum, r) => sum + r.latency, 0) / results.length;

        console.log(`     ✅ ${successful}/${count} successful, avg ${avgLatency.toFixed(0)}ms`);
        return results;
    }

    async testConcurrentPoolQueries(count = 10) {
        console.log(`  Testing ${count} concurrent pool queries...`);

        const operations = [];
        for (let i = 1; i <= count; i++) {
            operations.push(
                this.measureOperation('PoolQuery', async () => {
                    try {
                        return await this.marketplace.getAgentPool(i);
                    } catch (e) {
                        // Pool might not exist, which is OK for load testing
                        if (e.message.includes('Pool does not exist')) {
                            return null;
                        }
                        throw e;
                    }
                })
            );
        }

        const results = await Promise.all(operations);
        const successful = results.filter(r => r.success).length;
        const avgLatency = results.reduce((sum, r) => sum + r.latency, 0) / results.length;

        console.log(`     ✅ ${successful}/${count} successful, avg ${avgLatency.toFixed(0)}ms`);
        return results;
    }

    async testAPIEndpoints(count = 10) {
        console.log(`  Testing ${count} concurrent API calls...`);

        const apiUrl = process.env.API_URL || 'https://specular-production.up.railway.app';
        const operations = [];

        for (let i = 0; i < count; i++) {
            operations.push(
                this.measureOperation('APIHealth', async () => {
                    const response = await fetch(`${apiUrl}/health?network=${this.networkKey}`);
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    return await response.json();
                })
            );
        }

        const results = await Promise.all(operations);
        const successful = results.filter(r => r.success).length;
        const avgLatency = results.reduce((sum, r) => sum + r.latency, 0) / results.length;

        console.log(`     ✅ ${successful}/${count} successful, avg ${avgLatency.toFixed(0)}ms`);
        return results;
    }

    async testMixedLoad(duration = 30000) {
        console.log(`  Running mixed load test for ${duration/1000}s...`);

        const startTime = Date.now();
        const operations = [];

        while (Date.now() - startTime < duration) {
            // Random mix of operations
            const rand = Math.random();

            if (rand < 0.4) {
                // 40% registry reads
                const addr = ethers.Wallet.createRandom().address;
                operations.push(
                    this.measureOperation('MixedRegistryRead', () =>
                        this.registry.isRegistered(addr)
                    )
                );
            } else if (rand < 0.7) {
                // 30% marketplace reads
                operations.push(
                    this.measureOperation('MixedMarketplaceRead', () =>
                        this.marketplace.paused()
                    )
                );
            } else {
                // 30% API calls
                const apiUrl = process.env.API_URL || 'https://specular-production.up.railway.app';
                operations.push(
                    this.measureOperation('MixedAPICall', async () => {
                        const response = await fetch(`${apiUrl}/health?network=${this.networkKey}`);
                        return await response.json();
                    })
                );
            }

            // Stagger operations slightly
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        const results = await Promise.all(operations);
        const successful = results.filter(r => r.success).length;
        const total = results.length;
        const avgLatency = results.reduce((sum, r) => sum + r.latency, 0) / results.length;

        console.log(`     ✅ ${successful}/${total} successful (${(successful/total*100).toFixed(1)}%), avg ${avgLatency.toFixed(0)}ms`);
        return results;
    }

    async runLoadTest() {
        console.log('\n╔════════════════════════════════════════════════════════════╗');
        console.log(`║           LOAD TEST: ${this.network.name.padEnd(34)}║`);
        console.log('╚════════════════════════════════════════════════════════════╝');
        console.log(`  Concurrency: ${this.concurrency}, Operations: ${this.totalOperations}\n`);

        await this.initialize();

        const overallStart = Date.now();

        // Test 1: Concurrent Registry Reads
        console.log('1️⃣  Registry Load Test');
        await this.testRegistryReads(this.totalOperations);

        // Test 2: Concurrent Marketplace Reads
        console.log('\n2️⃣  Marketplace Load Test');
        await this.testMarketplaceReads(this.totalOperations);

        // Test 3: Concurrent Pool Queries
        console.log('\n3️⃣  Pool Query Load Test');
        await this.testConcurrentPoolQueries(this.totalOperations);

        // Test 4: API Load Test
        console.log('\n4️⃣  API Endpoint Load Test');
        await this.testAPIEndpoints(this.totalOperations);

        // Test 5: Mixed Load Test
        console.log('\n5️⃣  Mixed Load Test (30s)');
        await this.testMixedLoad(30000);

        const overallEnd = Date.now();
        const totalTime = overallEnd - overallStart;

        // Calculate summary
        this.results.summary.totalTime = totalTime;
        this.results.summary.avgLatency =
            this.results.operations.reduce((sum, op) => sum + op.latency, 0) /
            this.results.operations.length;
        this.results.summary.throughput =
            (this.results.operations.length / totalTime) * 1000;

        // Print summary
        console.log('\n' + '═'.repeat(60));
        console.log('LOAD TEST SUMMARY');
        console.log('═'.repeat(60));
        console.log(`Total Operations:  ${this.results.operations.length}`);
        console.log(`Successful:        ${this.results.summary.successful} (${(this.results.summary.successful/this.results.operations.length*100).toFixed(1)}%)`);
        console.log(`Failed:            ${this.results.summary.failed} (${(this.results.summary.failed/this.results.operations.length*100).toFixed(1)}%)`);
        console.log(`Total Time:        ${(totalTime/1000).toFixed(2)}s`);
        console.log(`Avg Latency:       ${this.results.summary.avgLatency.toFixed(2)}ms`);
        console.log(`Throughput:        ${this.results.summary.throughput.toFixed(2)} ops/sec`);
        console.log('═'.repeat(60) + '\n');

        return this.results;
    }
}

async function main() {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║         SPECULAR - MULTI-NETWORK LOAD TEST                 ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    console.log(`Date: ${new Date().toISOString()}\n`);

    // Configuration
    const CONCURRENCY = parseInt(process.env.CONCURRENCY) || 5;
    const OPERATIONS = parseInt(process.env.OPERATIONS) || 20;

    const allResults = {};

    // Run load tests on all networks
    for (const networkKey of ['arc', 'base', 'arbitrum']) {
        const loadTest = new LoadTest(networkKey, CONCURRENCY, OPERATIONS);
        allResults[networkKey] = await loadTest.runLoadTest();
        await new Promise(resolve => setTimeout(resolve, 2000)); // Brief pause
    }

    // Overall summary
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║              OVERALL LOAD TEST SUMMARY                     ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    for (const [networkKey, results] of Object.entries(allResults)) {
        const successRate = (results.summary.successful / results.operations.length * 100).toFixed(1);
        const status = successRate >= 95 ? '✅' : successRate >= 80 ? '⚠️ ' : '❌';

        console.log(`${status} ${results.network}:`);
        console.log(`   Success Rate: ${successRate}%`);
        console.log(`   Avg Latency:  ${results.summary.avgLatency.toFixed(2)}ms`);
        console.log(`   Throughput:   ${results.summary.throughput.toFixed(2)} ops/sec`);
        console.log('');
    }

    // Save results
    const outputPath = path.join(__dirname, '../load-test-results.json');
    fs.writeFileSync(outputPath, JSON.stringify(allResults, null, 2));
    console.log(`📄 Full results saved to: ${outputPath}\n`);

    // Check if any network had < 80% success rate
    const anyFailed = Object.values(allResults).some(r =>
        (r.summary.successful / r.operations.length) < 0.8
    );

    if (!anyFailed) {
        console.log('🎉 ALL NETWORKS PASSED LOAD TEST!\n');
        process.exit(0);
    } else {
        console.log('❌ SOME NETWORKS FAILED LOAD TEST\n');
        process.exit(1);
    }
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
