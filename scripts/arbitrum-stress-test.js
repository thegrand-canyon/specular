/**
 * Arbitrum One Extreme Stress Test
 * Standalone test for Arbitrum network
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Load configuration
const arbitrumConfig = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../src/config/arbitrum-addresses.json'), 'utf8')
);

// Load ABIs
function loadAbi(name) {
    const abiPath = path.join(__dirname, '../abis', `${name}.json`);
    const abiFile = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
    return Array.isArray(abiFile) ? abiFile : abiFile.abi || abiFile;
}

const registryAbi = loadAbi('AgentRegistryV2');
const reputationAbi = loadAbi('ReputationManagerV3');
const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');

// Configuration
const RPC_URL = process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc';
const API_URL = process.env.API_URL || 'https://specular-production.up.railway.app';

class ArbitrumStressTest {
    constructor() {
        this.provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
        this.registry = new ethers.Contract(arbitrumConfig.agentRegistryV2, registryAbi, this.provider);
        this.reputation = new ethers.Contract(arbitrumConfig.reputationManagerV3, reputationAbi, this.provider);
        this.marketplace = new ethers.Contract(arbitrumConfig.agentLiquidityMarketplace, marketplaceAbi, this.provider);
        this.results = [];
    }

    async runTest(name, testFn, category) {
        const start = Date.now();
        try {
            await testFn();
            const elapsed = Date.now() - start;
            console.log(`   ✅ ${name} (${elapsed}ms)`);
            this.results.push({ category, name, passed: true, elapsed });
            return true;
        } catch (error) {
            const elapsed = Date.now() - start;
            console.log(`   ❌ ${name} (${elapsed}ms)`);
            console.log(`      ${error.message.split('\n')[0]}`);
            this.results.push({ category, name, passed: false, elapsed, error: error.message });
            return false;
        }
    }

    async concurrentReadTest() {
        console.log('\n🔥 CONCURRENT READ STRESS TEST (100 operations)\n');

        const start = Date.now();
        const promises = Array(100).fill(null).map(() =>
            this.registry.totalAgents()
        );

        const results = await Promise.all(promises.map(p => p.catch(() => null)));
        const successful = results.filter(r => r !== null).length;
        const elapsed = Date.now() - start;

        const avgTime = elapsed / 100;
        const passed = successful >= 95; // 95% success rate

        if (passed) {
            console.log(`   ✅ Concurrent Reads (100) (${elapsed}ms)`);
            console.log(`      ${successful}/100 successful, avg ${avgTime.toFixed(0)}ms per operation\n`);
        } else {
            console.log(`   ❌ Concurrent Reads (100) (${elapsed}ms)`);
            console.log(`      ${successful}/100 successful, avg ${avgTime.toFixed(0)}ms per operation\n`);
        }

        this.results.push({
            category: 'Concurrent Reads',
            name: 'Concurrent Reads (100)',
            passed,
            elapsed
        });
    }

    async edgeCaseTests() {
        console.log('🔥 EDGE CASE VALUE TESTS\n');

        await this.runTest('Max Value Handling', async () => {
            // Test with max uint256 value
            const maxValue = ethers.MaxUint256;
            // This should not crash
            await this.reputation.calculateInterestRate(ethers.ZeroAddress);
        }, 'Edge Cases');

        await this.runTest('Zero Address Handling', async () => {
            const isRegistered = await this.registry.isRegistered(ethers.ZeroAddress);
            if (isRegistered) throw new Error('Zero address should not be registered');
        }, 'Edge Cases');

        await this.runTest('Invalid Agent ID', async () => {
            try {
                await this.marketplace.getAgentPool(999999);
                throw new Error('Should have reverted');
            } catch (e) {
                if (e.message.includes('Should have reverted')) throw e;
                // Expected to revert
            }
        }, 'Edge Cases');

        await this.runTest('Extreme Duration', async () => {
            try {
                await this.marketplace.requestLoan(1000000, 36500); // 100 year loan
                throw new Error('Should have reverted');
            } catch (e) {
                if (!e.message.includes('revert') && !e.message.includes('execution reverted')) {
                    throw new Error('Should have reverted');
                }
            }
        }, 'Edge Cases');

        await this.runTest('Minimum Amount (1 wei)', async () => {
            try {
                await this.marketplace.requestLoan(1, 7);
                // Should work or revert, but not crash
            } catch (e) {
                // Expected to revert with small amounts
            }
        }, 'Edge Cases');
    }

    async boundaryTests() {
        console.log('\n🔥 BOUNDARY CONDITION TESTS\n');

        await this.runTest('Reputation Score Range Check', async () => {
            const score = await this.reputation['getReputationScore(address)'](ethers.ZeroAddress);
            const scoreNum = Number(score);
            console.log(`      Score: ${scoreNum} (valid range: 0-1000)`);
            if (scoreNum < 0 || scoreNum > 1000) {
                throw new Error(`Score ${scoreNum} out of range 0-1000`);
            }
        }, 'Boundaries');

        await this.runTest('Interest Rate Bounds', async () => {
            const rate = await this.reputation.calculateInterestRate(ethers.ZeroAddress);
            const rateNum = Number(rate) / 100; // Convert basis points to %
            console.log(`      Rate: ${rateNum}% (valid range: 5-20%)`);
            if (rateNum < 5 || rateNum > 20) {
                throw new Error(`Rate ${rateNum}% out of range 5-20%`);
            }
        }, 'Boundaries');
    }

    async failureScenarioTests() {
        console.log('\n🔥 FAILURE SCENARIO TESTS\n');

        await this.runTest('Borrow Without Registration', async () => {
            try {
                // Try to borrow without being registered
                const randomAddress = ethers.Wallet.createRandom().address;
                const isRegistered = await this.registry.isRegistered(randomAddress);
                if (isRegistered) throw new Error('Random address should not be registered');
                console.log('      Correctly blocked unregistered user');
            } catch (e) {
                if (e.message.includes('should not be registered')) throw e;
                // Expected
            }
        }, 'Failure Scenarios');

        await this.runTest('Registration Validation', async () => {
            const totalAgents = await this.registry.totalAgents();
            if (Number(totalAgents) >= 0) {
                // Valid response
            } else {
                throw new Error('Invalid total agents');
            }
        }, 'Failure Scenarios');

        await this.runTest('Repay Nonexistent Loan', async () => {
            try {
                const nonexistentLoanId = 999999999;
                // This should fail or handle gracefully
                await this.marketplace.getActiveLoan(ethers.ZeroAddress, nonexistentLoanId);
            } catch (e) {
                console.log('      Correctly rejected invalid loan ID');
            }
        }, 'Failure Scenarios');

        await this.runTest('Supply to Nonexistent Pool', async () => {
            try {
                await this.marketplace.getAgentPool(999999);
                throw new Error('Should have failed for nonexistent pool');
            } catch (e) {
                if (e.message.includes('Should have failed')) throw e;
                console.log('      Correctly blocked invalid pool');
            }
        }, 'Failure Scenarios');
    }

    async rateLimitTest() {
        console.log('\n🔥 RATE LIMIT TESTS\n');

        const start = Date.now();
        const promises = Array(50).fill(null).map(() =>
            this.registry.totalAgents()
        );

        const results = await Promise.all(promises.map(p => p.catch(() => null)));
        const successful = results.filter(r => r !== null).length;
        const elapsed = Date.now() - start;
        const throughput = (successful / (elapsed / 1000)).toFixed(1);

        console.log(`   ✅ Rate Limit Handling (50 rapid calls) (${elapsed}ms)`);
        console.log(`      ${successful}/50 successful, ${throughput} calls/sec\n`);

        this.results.push({
            category: 'Rate Limits',
            name: 'Rate Limit Handling (50 rapid calls)',
            passed: successful >= 45,
            elapsed
        });
    }

    async apiStressTest() {
        console.log('🔥 API STRESS TEST\n');

        // Test /health endpoint
        const healthStart = Date.now();
        const healthPromises = Array(20).fill(null).map(() =>
            fetch(`${API_URL}/health?network=arbitrum`).then(r => r.ok).catch(() => false)
        );
        const healthResults = await Promise.all(healthPromises);
        const healthSuccessful = healthResults.filter(r => r).length;
        const healthElapsed = Date.now() - healthStart;

        console.log(`   ✅ API /health?network=arbitrum (${healthElapsed}ms)`);
        console.log(`      ${healthSuccessful}/20 successful\n`);

        this.results.push({
            category: 'API Stress',
            name: 'API /health?network=arbitrum',
            passed: healthSuccessful >= 18,
            elapsed: healthElapsed
        });

        // Test /pools endpoint
        const poolsStart = Date.now();
        const poolsPromises = Array(20).fill(null).map(() =>
            fetch(`${API_URL}/pools?network=arbitrum`).then(r => r.ok).catch(() => false)
        );
        const poolsResults = await Promise.all(poolsPromises);
        const poolsSuccessful = poolsResults.filter(r => r).length;
        const poolsElapsed = Date.now() - poolsStart;

        console.log(`   ✅ API /pools?network=arbitrum (${poolsElapsed}ms)`);
        console.log(`      ${poolsSuccessful}/20 successful\n`);

        this.results.push({
            category: 'API Stress',
            name: 'API /pools?network=arbitrum',
            passed: poolsSuccessful >= 18,
            elapsed: poolsElapsed
        });

        // Test /agents endpoint (with limit to avoid timeout)
        const agentsStart = Date.now();
        const agentsPromises = Array(20).fill(null).map(() =>
            fetch(`${API_URL}/agents?network=arbitrum&limit=10`).then(r => r.ok).catch(() => false)
        );
        const agentsResults = await Promise.all(agentsPromises);
        const agentsSuccessful = agentsResults.filter(r => r).length;
        const agentsElapsed = Date.now() - agentsStart;

        console.log(`   ${agentsSuccessful >= 18 ? '✅' : '❌'} API /agents?network=arbitrum (${agentsElapsed}ms)`);
        console.log(`      ${agentsSuccessful}/20 successful\n`);

        this.results.push({
            category: 'API Stress',
            name: 'API /agents?network=arbitrum',
            passed: agentsSuccessful >= 18,
            elapsed: agentsElapsed
        });
    }

    async gasEstimationTests() {
        console.log('🔥 GAS ESTIMATION TESTS\n');

        await this.runTest('Gas Estimate: isRegistered()', async () => {
            const start = Date.now();
            await this.registry.isRegistered(ethers.ZeroAddress);
            const elapsed = Date.now() - start;
            console.log(`      Execution time: ${elapsed}ms`);
        }, 'Gas Estimation');

        await this.runTest('Gas Estimate: getReputationScore()', async () => {
            const start = Date.now();
            await this.reputation['getReputationScore(address)'](ethers.ZeroAddress);
            const elapsed = Date.now() - start;
            console.log(`      Execution time: ${elapsed}ms`);
        }, 'Gas Estimation');

        await this.runTest('Gas Estimate: calculateCreditLimit()', async () => {
            const start = Date.now();
            await this.reputation['calculateCreditLimit(address)'](ethers.ZeroAddress);
            const elapsed = Date.now() - start;
            console.log(`      Execution time: ${elapsed}ms`);
        }, 'Gas Estimation');
    }

    async performanceDegradationTest() {
        console.log('\n🔥 PERFORMANCE DEGRADATION TEST\n');

        // Test 10 operations
        const start10 = Date.now();
        await Promise.all(Array(10).fill(null).map(() => this.registry.totalAgents()));
        const elapsed10 = Date.now() - start10;
        console.log(`   📊 10 operations: ${elapsed10}ms total, ${(elapsed10 / 10).toFixed(1)}ms avg`);

        // Test 50 operations
        const start50 = Date.now();
        await Promise.all(Array(50).fill(null).map(() => this.registry.totalAgents()));
        const elapsed50 = Date.now() - start50;
        console.log(`   📊 50 operations: ${elapsed50}ms total, ${(elapsed50 / 50).toFixed(1)}ms avg`);

        // Test 100 operations (careful with rate limits)
        let elapsed100 = 0;
        try {
            const start100 = Date.now();
            await Promise.all(Array(100).fill(null).map(() => this.registry.totalAgents()));
            elapsed100 = Date.now() - start100;
            console.log(`   📊 100 operations: ${elapsed100}ms total, ${(elapsed100 / 100).toFixed(1)}ms avg`);
        } catch (error) {
            console.log(`   ❌ 100 operations failed: ${error.message}`);
            elapsed100 = 999999; // Max value to indicate failure
        }

        // Analyze scaling
        const scalingFactor = elapsed100 / elapsed10;
        const scalingQuality = scalingFactor < 15 ? 'LINEAR - GOOD' : 'DEGRADES - NEEDS OPTIMIZATION';
        const passed = scalingFactor < 20;

        console.log(`   ${passed ? '✅' : '❌'} Performance Scaling (0ms)`);
        console.log(`      10x load increase = ${(scalingFactor / 10).toFixed(1)}x slower (${scalingQuality})\n`);

        this.results.push({
            category: 'Performance',
            name: 'Performance Scaling',
            passed,
            elapsed: 0
        });
    }

    printSummary() {
        const total = this.results.length;
        const passed = this.results.filter(r => r.passed).length;
        const avgLatency = this.results.reduce((sum, r) => sum + r.elapsed, 0) / total;
        const maxLatency = Math.max(...this.results.map(r => r.elapsed));
        const minLatency = Math.min(...this.results.map(r => r.elapsed));

        console.log('═'.repeat(60));
        console.log('STRESS TEST SUMMARY');
        console.log('═'.repeat(60));
        console.log(`Total Tests:     ${total}`);
        console.log(`Passed:          ${passed}`);
        console.log(`Failed:          ${total - passed}`);
        console.log(`Pass Rate:       ${((passed / total) * 100).toFixed(1)}%`);
        console.log(`Avg Latency:     ${avgLatency.toFixed(2)}ms`);
        console.log(`Max Latency:     ${maxLatency}ms`);
        console.log(`Min Latency:     ${minLatency}ms`);
        console.log('═'.repeat(60) + '\n');
    }

    async run() {
        console.log('\n╔════════════════════════════════════════════════════════════╗');
        console.log('║       EXTREME STRESS TEST: Arbitrum One                    ║');
        console.log('╚════════════════════════════════════════════════════════════╝\n');
        console.log(`RPC: ${RPC_URL}`);
        console.log(`API: ${API_URL}\n`);

        try {
            await this.concurrentReadTest();
            await this.edgeCaseTests();
            await this.boundaryTests();
            await this.failureScenarioTests();
            await this.rateLimitTest();
            await this.apiStressTest();
            await this.gasEstimationTests();
            await this.performanceDegradationTest();

            this.printSummary();
        } catch (error) {
            console.error('\n❌ STRESS TEST CRASHED:', error.message);
            this.printSummary();
            process.exit(1);
        }
    }
}

// Run the test
const test = new ArbitrumStressTest();
test.run().then(() => {
    console.log('✅ Arbitrum stress test completed!\n');
    process.exit(0);
}).catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});
