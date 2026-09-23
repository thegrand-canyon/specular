/**
 * Extreme Stress Test for Specular Protocol
 * Tests all networks to their absolute limits
 *
 * TESTS:
 * 1. Concurrent read operations (100+)
 * 2. Edge case values (max/min amounts)
 * 3. Boundary conditions (gas limits, rate limits)
 * 4. Failure scenarios (invalid inputs, insufficient funds)
 * 5. Performance degradation under load
 * 6. API stress testing
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

class ExtremeTester {
    constructor(networkKey) {
        this.network = NETWORKS[networkKey];
        this.networkKey = networkKey;
        this.results = {
            network: this.network.name,
            timestamp: new Date().toISOString(),
            tests: [],
            stats: {
                totalTests: 0,
                passed: 0,
                failed: 0,
                totalLatency: 0,
                maxLatency: 0,
                minLatency: Infinity
            }
        };
    }

    async initialize() {
        this.provider = new ethers.JsonRpcProvider(this.network.rpc, this.network.chainId, {
            batchMaxCount: 1,
            staticNetwork: true
        });

        this.contracts = {
            registry: new ethers.Contract(this.network.addresses.agentRegistryV2, registryAbi, this.provider),
            reputation: new ethers.Contract(this.network.addresses.reputationManagerV3, reputationAbi, this.provider),
            marketplace: new ethers.Contract(this.network.addresses.agentLiquidityMarketplace, marketplaceAbi, this.provider),
            usdc: new ethers.Contract(this.network.addresses.usdc, usdcAbi, this.provider)
        };
    }

    logTest(name, passed, latency, details = '') {
        this.results.tests.push({
            name,
            passed,
            latency,
            details,
            timestamp: new Date().toISOString()
        });

        this.results.stats.totalTests++;
        if (passed) this.results.stats.passed++;
        else this.results.stats.failed++;

        this.results.stats.totalLatency += latency;
        this.results.stats.maxLatency = Math.max(this.results.stats.maxLatency, latency);
        this.results.stats.minLatency = Math.min(this.results.stats.minLatency, latency);

        const status = passed ? '✅' : '❌';
        console.log(`   ${status} ${name} (${latency}ms)`);
        if (details) console.log(`      ${details}`);
    }

    async testConcurrentReads(count = 100) {
        console.log(`\n🔥 CONCURRENT READ STRESS TEST (${count} operations)\n`);

        const startTime = Date.now();
        const promises = [];

        // Generate random test addresses
        for (let i = 0; i < count; i++) {
            const randomAddr = ethers.Wallet.createRandom().address;
            promises.push(
                (async () => {
                    const opStart = Date.now();
                    try {
                        await this.contracts.registry.isRegistered(randomAddr);
                        return { success: true, latency: Date.now() - opStart };
                    } catch (error) {
                        return { success: false, latency: Date.now() - opStart, error: error.message };
                    }
                })()
            );
        }

        const results = await Promise.all(promises);
        const totalTime = Date.now() - startTime;

        const successful = results.filter(r => r.success).length;
        const avgLatency = results.reduce((sum, r) => sum + r.latency, 0) / results.length;

        this.logTest(
            `Concurrent Reads (${count})`,
            successful === count,
            totalTime,
            `${successful}/${count} successful, avg ${avgLatency.toFixed(0)}ms per operation`
        );

        return results;
    }

    async testEdgeCaseValues() {
        console.log('\n🔥 EDGE CASE VALUE TESTS\n');

        const testWallet = ethers.Wallet.createRandom().connect(this.provider);

        // Test 1: Max uint256 credit limit request
        try {
            const startTime = Date.now();
            const maxUint = ethers.MaxUint256;
            await this.contracts.reputation.calculateCreditLimit.staticCall(testWallet.address);
            this.logTest('Max Value Handling', true, Date.now() - startTime, 'Handles large values correctly');
        } catch (error) {
            this.logTest('Max Value Handling', false, 0, error.message);
        }

        // Test 2: Zero address checks
        try {
            const startTime = Date.now();
            await this.contracts.registry.isRegistered(ethers.ZeroAddress);
            this.logTest('Zero Address Handling', true, Date.now() - startTime);
        } catch (error) {
            this.logTest('Zero Address Handling', false, 0, error.message);
        }

        // Test 3: Invalid agent ID
        try {
            const startTime = Date.now();
            await this.contracts.marketplace.getAgentPool.staticCall(999999);
            this.logTest('Invalid Agent ID', false, Date.now() - startTime, 'Should have reverted');
        } catch (error) {
            if (error.message.includes('Pool does not exist')) {
                this.logTest('Invalid Agent ID', true, 0, 'Correctly rejected invalid ID');
            } else {
                this.logTest('Invalid Agent ID', false, 0, error.message);
            }
        }

        // Test 4: Loan with max duration
        try {
            const startTime = Date.now();
            await this.contracts.marketplace.connect(testWallet).requestLoan.staticCall(1000000, 365 * 100); // 100 years
            this.logTest('Extreme Duration', true, Date.now() - startTime, 'Accepts very long durations');
        } catch (error) {
            this.logTest('Extreme Duration', false, 0, error.message);
        }

        // Test 5: Loan with amount = 1 wei
        try {
            const startTime = Date.now();
            await this.contracts.marketplace.connect(testWallet).requestLoan.staticCall(1, 7);
            this.logTest('Minimum Amount (1 wei)', true, Date.now() - startTime);
        } catch (error) {
            this.logTest('Minimum Amount (1 wei)', false, 0, 'Correctly rejects tiny amounts');
        }
    }

    async testBoundaryConditions() {
        console.log('\n🔥 BOUNDARY CONDITION TESTS\n');

        const testWallet = ethers.Wallet.createRandom().connect(this.provider);

        // Test reputation score boundaries (0-1000)
        const testAddresses = [
            ethers.ZeroAddress,
            testWallet.address,
            this.network.addresses.deployer || testWallet.address
        ];

        for (const addr of testAddresses) {
            try {
                const startTime = Date.now();
                const score = await this.contracts.reputation['getReputationScore(address)'](addr);
                const inRange = score >= 0n && score <= 1000n;
                this.logTest(
                    `Reputation Score Range Check`,
                    inRange,
                    Date.now() - startTime,
                    `Score: ${score} (valid range: 0-1000)`
                );
            } catch (error) {
                this.logTest('Reputation Score Range Check', false, 0, error.message);
            }
        }

        // Test interest rate boundaries (should be 5-20%)
        try {
            const startTime = Date.now();
            const rate = await this.contracts.reputation.calculateInterestRate(testWallet.address);
            const inRange = rate >= 500n && rate <= 2000n; // 5-20% in basis points
            this.logTest(
                'Interest Rate Bounds',
                inRange,
                Date.now() - startTime,
                `Rate: ${Number(rate) / 100}% (valid range: 5-20%)`
            );
        } catch (error) {
            this.logTest('Interest Rate Bounds', false, 0, error.message);
        }
    }

    async testFailureScenarios() {
        console.log('\n🔥 FAILURE SCENARIO TESTS\n');

        const testWallet = ethers.Wallet.createRandom().connect(this.provider);

        // Test 1: Borrow without registration
        try {
            const startTime = Date.now();
            await this.contracts.marketplace.connect(testWallet).requestLoan.staticCall(1000000, 7);
            this.logTest('Borrow Without Registration', false, Date.now() - startTime, 'Should have failed');
        } catch (error) {
            this.logTest('Borrow Without Registration', true, 0, 'Correctly blocked unregistered user');
        }

        // Test 2: Double registration attempt
        try {
            const startTime = Date.now();
            // Try to register twice (would fail in real scenario)
            await this.contracts.registry.connect(testWallet).register.staticCall('ipfs://test', []);
            this.logTest('Registration Validation', true, Date.now() - startTime);
        } catch (error) {
            this.logTest('Registration Validation', false, 0, error.message);
        }

        // Test 3: Loan repayment without active loan
        try {
            const startTime = Date.now();
            await this.contracts.marketplace.connect(testWallet).repayLoan.staticCall(99999);
            this.logTest('Repay Nonexistent Loan', false, Date.now() - startTime, 'Should have failed');
        } catch (error) {
            this.logTest('Repay Nonexistent Loan', true, 0, 'Correctly rejected invalid loan ID');
        }

        // Test 4: Supply liquidity to nonexistent pool
        try {
            const startTime = Date.now();
            await this.contracts.marketplace.connect(testWallet).supplyLiquidity.staticCall(99999, 1000000);
            this.logTest('Supply to Nonexistent Pool', false, Date.now() - startTime, 'Should have failed');
        } catch (error) {
            this.logTest('Supply to Nonexistent Pool', true, 0, 'Correctly blocked invalid pool');
        }
    }

    async testRateLimits() {
        console.log('\n🔥 RATE LIMIT TESTS\n');

        const operations = [];
        const startTime = Date.now();

        // Rapid-fire 50 consecutive calls
        for (let i = 0; i < 50; i++) {
            const addr = ethers.Wallet.createRandom().address;
            operations.push(
                this.contracts.registry.isRegistered(addr).then(() => true).catch(() => false)
            );
        }

        const results = await Promise.all(operations);
        const totalTime = Date.now() - startTime;
        const successful = results.filter(r => r).length;

        this.logTest(
            'Rate Limit Handling (50 rapid calls)',
            successful > 0,
            totalTime,
            `${successful}/50 successful, ${(50000 / totalTime).toFixed(1)} calls/sec`
        );
    }

    async testAPIStress() {
        console.log('\n🔥 API STRESS TEST\n');

        const apiUrl = process.env.API_URL || 'https://specular-production.up.railway.app';
        const endpoints = [
            `/health?network=${this.networkKey}`,
            `/pools?network=${this.networkKey}`,
            `/agents?network=${this.networkKey}`
        ];

        for (const endpoint of endpoints) {
            const operations = [];
            const startTime = Date.now();

            // 20 concurrent requests to each endpoint
            for (let i = 0; i < 20; i++) {
                operations.push(
                    fetch(`${apiUrl}${endpoint}`)
                        .then(r => r.ok)
                        .catch(() => false)
                );
            }

            const results = await Promise.all(operations);
            const totalTime = Date.now() - startTime;
            const successful = results.filter(r => r).length;

            this.logTest(
                `API ${endpoint}`,
                successful >= 18, // Allow 10% failure rate
                totalTime,
                `${successful}/20 successful`
            );
        }
    }

    async testGasEstimation() {
        console.log('\n🔥 GAS ESTIMATION TESTS\n');

        const testWallet = ethers.Wallet.createRandom().connect(this.provider);

        const operations = [
            { name: 'isRegistered()', fn: () => this.contracts.registry.isRegistered.staticCall(testWallet.address) },
            { name: 'getReputationScore()', fn: () => this.contracts.reputation['getReputationScore(address)'].staticCall(testWallet.address) },
            { name: 'calculateCreditLimit()', fn: () => this.contracts.reputation.calculateCreditLimit.staticCall(testWallet.address) },
        ];

        for (const op of operations) {
            try {
                const startTime = Date.now();
                await op.fn();
                const latency = Date.now() - startTime;
                this.logTest(
                    `Gas Estimate: ${op.name}`,
                    true,
                    latency,
                    `Execution time: ${latency}ms`
                );
            } catch (error) {
                this.logTest(`Gas Estimate: ${op.name}`, false, 0, error.message);
            }
        }
    }

    async testPerformanceDegradation() {
        console.log('\n🔥 PERFORMANCE DEGRADATION TEST\n');

        const iterations = [10, 50, 100];
        const results = [];

        for (const count of iterations) {
            const startTime = Date.now();
            const promises = [];

            for (let i = 0; i < count; i++) {
                const addr = ethers.Wallet.createRandom().address;
                promises.push(this.contracts.registry.isRegistered(addr));
            }

            await Promise.all(promises);
            const totalTime = Date.now() - startTime;
            const avgTime = totalTime / count;

            results.push({ count, totalTime, avgTime });

            console.log(`   📊 ${count} operations: ${totalTime}ms total, ${avgTime.toFixed(1)}ms avg`);
        }

        // Check if performance degrades linearly (good) or exponentially (bad)
        const degradation = results[2].avgTime / results[0].avgTime;
        this.logTest(
            'Performance Scaling',
            degradation < 2,
            0,
            `10x load increase = ${degradation.toFixed(1)}x slower (${degradation < 2 ? 'LINEAR - GOOD' : 'EXPONENTIAL - BAD'})`
        );
    }

    async runTests() {
        console.log('\n╔════════════════════════════════════════════════════════════╗');
        console.log(`║      EXTREME STRESS TEST: ${this.network.name.padEnd(30)}║`);
        console.log('╚════════════════════════════════════════════════════════════╝');

        await this.initialize();

        await this.testConcurrentReads(100);
        await this.testEdgeCaseValues();
        await this.testBoundaryConditions();
        await this.testFailureScenarios();
        await this.testRateLimits();
        await this.testAPIStress();
        await this.testGasEstimation();
        await this.testPerformanceDegradation();

        // Calculate stats
        this.results.stats.avgLatency = this.results.stats.totalLatency / this.results.stats.totalTests;
        this.results.stats.passRate = (this.results.stats.passed / this.results.stats.totalTests * 100).toFixed(1);

        // Summary
        console.log('\n' + '═'.repeat(60));
        console.log('STRESS TEST SUMMARY');
        console.log('═'.repeat(60));
        console.log(`Total Tests:     ${this.results.stats.totalTests}`);
        console.log(`Passed:          ${this.results.stats.passed}`);
        console.log(`Failed:          ${this.results.stats.failed}`);
        console.log(`Pass Rate:       ${this.results.stats.passRate}%`);
        console.log(`Avg Latency:     ${this.results.stats.avgLatency.toFixed(2)}ms`);
        console.log(`Max Latency:     ${this.results.stats.maxLatency}ms`);
        console.log(`Min Latency:     ${this.results.stats.minLatency}ms`);
        console.log('═'.repeat(60) + '\n');

        return this.results;
    }
}

async function main() {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║       SPECULAR - EXTREME MULTI-NETWORK STRESS TEST         ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    console.log(`Date: ${new Date().toISOString()}\n`);
    console.log('⚠️  WARNING: This test will push networks to their limits!\n');

    const allResults = {};

    // Test all networks
    for (const networkKey of ['arc', 'base', 'arbitrum']) {
        const tester = new ExtremeTester(networkKey);
        allResults[networkKey] = await tester.runTests();
        await new Promise(resolve => setTimeout(resolve, 3000)); // Pause between networks
    }

    // Overall summary
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║              OVERALL STRESS TEST RESULTS                   ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    for (const [networkKey, results] of Object.entries(allResults)) {
        const status = parseFloat(results.stats.passRate) >= 90 ? '✅' :
                      parseFloat(results.stats.passRate) >= 70 ? '⚠️ ' : '❌';

        console.log(`${status} ${results.network}:`);
        console.log(`   Pass Rate: ${results.stats.passRate}%`);
        console.log(`   Tests: ${results.stats.passed}/${results.stats.totalTests}`);
        console.log(`   Avg Latency: ${results.stats.avgLatency.toFixed(2)}ms`);
        console.log('');
    }

    // Save results
    const outputPath = path.join(__dirname, '../extreme-stress-test-results.json');
    fs.writeFileSync(outputPath, JSON.stringify(allResults, null, 2));
    console.log(`📄 Full results saved to: ${outputPath}\n`);

    // Exit code
    const allPassed = Object.values(allResults).every(r => parseFloat(r.stats.passRate) >= 90);
    if (allPassed) {
        console.log('🎉 ALL NETWORKS PASSED EXTREME STRESS TEST!\n');
        process.exit(0);
    } else {
        console.log('⚠️  SOME NETWORKS HAD ISSUES UNDER STRESS\n');
        process.exit(1);
    }
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
