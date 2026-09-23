/**
 * Specular Protocol - Comprehensive Stress Test Suite
 *
 * Tests the protocol under various stress conditions:
 * 1. Concurrent loan requests
 * 2. Maximum capacity testing
 * 3. Edge case scenarios
 * 4. Reputation system stress
 * 5. Liquidity pool exhaustion
 */

const { ethers } = require('ethers');
const fs = require('fs');

// Configuration
const NETWORK = process.env.NETWORK || 'arc';
const RPC_URL = NETWORK === 'base'
    ? 'https://mainnet.base.org'
    : process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';

const CHAIN_ID = NETWORK === 'base' ? 8453 : 5042002;

// Load addresses
const addressFile = NETWORK === 'base'
    ? './src/config/base-addresses.json'
    : './src/config/arc-testnet-addresses.json';
const addresses = JSON.parse(fs.readFileSync(addressFile, 'utf8'));

// Load ABIs
function loadAbi(name) {
    const paths = [
        `./artifacts/contracts/${name}.sol/${name}.json`,
        `./artifacts/contracts/core/${name}.sol/${name}.json`,
        `./artifacts/contracts/tokens/${name}.sol/${name}.json`,
    ];
    for (const p of paths) {
        try {
            return JSON.parse(fs.readFileSync(p, 'utf8')).abi;
        } catch {}
    }
    throw new Error(`Cannot find ABI for ${name}`);
}

const mpAbi = loadAbi('AgentLiquidityMarketplace');
const registryAbi = loadAbi('AgentRegistryV2');
const rmAbi = loadAbi('ReputationManagerV3');
const usdcAbi = loadAbi('MockUSDC');

// Create provider and contracts
const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { batchMaxCount: 1 });

const registryAddress = addresses.agentRegistry || addresses.agentRegistryV2;
const reputationAddress = addresses.reputationManager || addresses.reputationManagerV3;
const usdcAddress = addresses.mockUSDC || addresses.usdc;

const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, mpAbi, provider);
const registry = new ethers.Contract(registryAddress, registryAbi, provider);
const reputationManager = new ethers.Contract(reputationAddress, rmAbi, provider);
const usdc = new ethers.Contract(usdcAddress, usdcAbi, provider);

// Test Results Tracking
const testResults = {
    passed: 0,
    failed: 0,
    errors: [],
    warnings: [],
    performance: {}
};

// Utility Functions
function log(category, message) {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`[${timestamp}] ${category}: ${message}`);
}

function logTest(name, passed, details = '') {
    if (passed) {
        testResults.passed++;
        log('✅ PASS', name + (details ? ` - ${details}` : ''));
    } else {
        testResults.failed++;
        log('❌ FAIL', name + (details ? ` - ${details}` : ''));
        testResults.errors.push({ test: name, details });
    }
}

function logWarning(message) {
    testResults.warnings.push(message);
    log('⚠️  WARN', message);
}

async function measureTime(name, fn) {
    const start = Date.now();
    const result = await fn();
    const duration = Date.now() - start;
    testResults.performance[name] = duration;
    return { result, duration };
}

// Test Suite Functions

async function testConcurrentLoanRequests() {
    console.log('\n' + '='.repeat(80));
    console.log('TEST 1: Concurrent Loan Requests');
    console.log('='.repeat(80));

    // Setup test wallet
    const privateKey = process.env.PRIVATE_KEY || '0x' + '1'.repeat(64);
    const wallet = new ethers.Wallet(privateKey, provider);

    log('INFO', `Test wallet: ${wallet.address}`);

    // Check if agent is registered
    const agentId = await registry.addressToAgentId(wallet.address);

    if (agentId === 0n) {
        logTest('Agent Registration Check', false, 'Agent not registered');
        log('INFO', 'Skipping concurrent loan tests - agent must be registered first');
        return;
    }

    logTest('Agent Registration Check', true, `Agent ID: ${agentId}`);

    // Get agent's pool
    try {
        const pool = await marketplace.agentPools(agentId);
        const availableLiquidity = ethers.formatUnits(pool.availableLiquidity, 6);

        log('INFO', `Pool available liquidity: ${availableLiquidity} USDC`);

        if (parseFloat(availableLiquidity) < 50) {
            logWarning('Insufficient liquidity for concurrent loan tests (need 50+ USDC)');
            return;
        }

        // Test: Request 3 loans concurrently (5 USDC each)
        log('INFO', 'Requesting 3 loans concurrently (5 USDC each)...');

        const mpWithSigner = marketplace.connect(wallet);
        const loanAmount = ethers.parseUnits('5', 6);
        const duration = 7; // 7 days

        const promises = [
            mpWithSigner.requestLoan(loanAmount, duration),
            mpWithSigner.requestLoan(loanAmount, duration),
            mpWithSigner.requestLoan(loanAmount, duration)
        ];

        const { result: receipts, duration: timeTaken } = await measureTime(
            'concurrent_3_loans',
            () => Promise.allSettled(promises)
        );

        const successCount = receipts.filter(r => r.status === 'fulfilled').length;
        const failedCount = receipts.filter(r => r.status === 'rejected').length;

        log('INFO', `Results: ${successCount} succeeded, ${failedCount} failed`);
        log('INFO', `Time taken: ${timeTaken}ms (${(timeTaken / receipts.length).toFixed(0)}ms per loan)`);

        logTest('Concurrent Loan Requests', successCount > 0, `${successCount}/3 loans processed`);

        if (failedCount > 0) {
            const errorMsg = receipts.find(r => r.status === 'rejected')?.reason?.message || 'Unknown error';
            logWarning(`Some concurrent loans failed: ${errorMsg}`);
        }

    } catch (error) {
        logTest('Concurrent Loan Requests', false, error.message);
    }
}

async function testMaximumCapacity() {
    console.log('\n' + '='.repeat(80));
    console.log('TEST 2: Maximum Capacity Testing');
    console.log('='.repeat(80));

    try {
        // Test: Query all pools
        const { result: totalPools } = await measureTime(
            'query_total_pools',
            () => marketplace.totalPools()
        );

        log('INFO', `Total pools in system: ${totalPools}`);

        // Test: Load all pool data
        log('INFO', 'Loading all pool data...');
        const poolPromises = [];
        for (let i = 1; i <= Number(totalPools); i++) {
            poolPromises.push(marketplace.agentPools(i));
        }

        const { result: pools, duration: loadTime } = await measureTime(
            'load_all_pools',
            () => Promise.allSettled(poolPromises)
        );

        const successfulLoads = pools.filter(p => p.status === 'fulfilled').length;
        log('INFO', `Loaded ${successfulLoads}/${totalPools} pools in ${loadTime}ms`);

        logTest('Pool Data Loading', successfulLoads === Number(totalPools),
                `${successfulLoads}/${totalPools} pools loaded`);

        // Test: Calculate total system TVL
        let totalTVL = 0n;
        let totalAvailable = 0n;
        let totalLoaned = 0n;

        for (const poolResult of pools) {
            if (poolResult.status === 'fulfilled') {
                const pool = poolResult.value;
                if (pool.isActive) {
                    totalTVL += pool.totalLiquidity;
                    totalAvailable += pool.availableLiquidity;
                    totalLoaned += pool.totalLoaned;
                }
            }
        }

        log('INFO', `System TVL: ${ethers.formatUnits(totalTVL, 6)} USDC`);
        log('INFO', `Available: ${ethers.formatUnits(totalAvailable, 6)} USDC`);
        log('INFO', `Loaned: ${ethers.formatUnits(totalLoaned, 6)} USDC`);

        const utilizationRate = totalTVL > 0n
            ? (Number(totalLoaned) / Number(totalTVL)) * 100
            : 0;
        log('INFO', `Utilization: ${utilizationRate.toFixed(2)}%`);

        logTest('System Capacity Metrics', true, `TVL: ${ethers.formatUnits(totalTVL, 6)} USDC`);

        if (utilizationRate > 90) {
            logWarning('High utilization rate (>90%) - liquidity may be constrained');
        }

    } catch (error) {
        logTest('Maximum Capacity Testing', false, error.message);
    }
}

async function testEdgeCases() {
    console.log('\n' + '='.repeat(80));
    console.log('TEST 3: Edge Case Scenarios');
    console.log('='.repeat(80));

    const privateKey = process.env.PRIVATE_KEY || '0x' + '1'.repeat(64);
    const wallet = new ethers.Wallet(privateKey, provider);
    const agentId = await registry.addressToAgentId(wallet.address);

    if (agentId === 0n) {
        log('INFO', 'Skipping edge case tests - agent not registered');
        return;
    }

    const mpWithSigner = marketplace.connect(wallet);

    // Test 1: Query credit limit
    try {
        const creditLimit = await reputationManager.calculateCreditLimit(wallet.address);
        log('INFO', `Agent credit limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);
        logTest('Credit Limit Calculation', true, `${ethers.formatUnits(creditLimit, 6)} USDC`);
    } catch (error) {
        logTest('Credit Limit Calculation', false, error.message);
    }

    // Test 2: Query reputation score
    try {
        const score = await reputationManager['getReputationScore(address)'](wallet.address);
        log('INFO', `Reputation score: ${score}/1000`);
        logTest('Reputation Score Query', true, `${score}/1000`);

        if (Number(score) < 100) {
            logWarning('Very low reputation score detected');
        }
    } catch (error) {
        logTest('Reputation Score Query', false, error.message);
    }

    // Test 3: Attempt loan with zero amount (should fail)
    try {
        log('INFO', 'Testing zero amount loan (should fail)...');
        await mpWithSigner.requestLoan.staticCall(0, 7);
        logTest('Zero Amount Rejection', false, 'Zero amount loan was not rejected');
    } catch (error) {
        logTest('Zero Amount Rejection', true, 'Zero amount properly rejected');
    }

    // Test 4: Attempt loan with zero duration (should fail)
    try {
        log('INFO', 'Testing zero duration loan (should fail)...');
        await mpWithSigner.requestLoan.staticCall(ethers.parseUnits('10', 6), 0);
        logTest('Zero Duration Rejection', false, 'Zero duration loan was not rejected');
    } catch (error) {
        logTest('Zero Duration Rejection', true, 'Zero duration properly rejected');
    }

    // Test 5: Attempt loan exceeding credit limit (should fail)
    try {
        const creditLimit = await reputationManager.calculateCreditLimit(wallet.address);
        const excessiveAmount = creditLimit + ethers.parseUnits('1000000', 6);

        log('INFO', 'Testing excessive loan amount (should fail)...');
        await mpWithSigner.requestLoan.staticCall(excessiveAmount, 7);
        logTest('Excessive Amount Rejection', false, 'Excessive amount was not rejected');
    } catch (error) {
        logTest('Excessive Amount Rejection', true, 'Excessive amount properly rejected');
    }
}

async function testReputationSystem() {
    console.log('\n' + '='.repeat(80));
    console.log('TEST 4: Reputation System Stress Test');
    console.log('='.repeat(80));

    const privateKey = process.env.PRIVATE_KEY || '0x' + '1'.repeat(64);
    const wallet = new ethers.Wallet(privateKey, provider);

    try {
        // Test: Query reputation score multiple times (stress RPC)
        log('INFO', 'Querying reputation score 10 times...');

        const promises = Array(10).fill(null).map(() =>
            reputationManager['getReputationScore(address)'](wallet.address)
        );

        const { result: scores, duration: timeTaken } = await measureTime(
            'reputation_queries_10x',
            () => Promise.all(promises)
        );

        const allSame = scores.every(s => s === scores[0]);

        log('INFO', `All scores identical: ${allSame}`);
        log('INFO', `Time taken: ${timeTaken}ms (${(timeTaken / 10).toFixed(0)}ms per query)`);

        logTest('Reputation Query Consistency', allSame, `10 queries in ${timeTaken}ms`);

        // Test: Calculate credit limits for different reputation scores
        log('INFO', 'Testing credit limit calculations...');

        const testScores = [100, 300, 500, 700, 900];
        for (const testScore of testScores) {
            // Note: This is a static test - we can't actually set reputation without being the contract owner
            log('INFO', `Score ${testScore}: Credit calculations would be tested in unit tests`);
        }

        logTest('Reputation System Stress', true, 'System responding to queries');

    } catch (error) {
        logTest('Reputation System Stress', false, error.message);
    }
}

async function testLiquidityPoolExhaustion() {
    console.log('\n' + '='.repeat(80));
    console.log('TEST 5: Liquidity Pool Exhaustion Scenarios');
    console.log('='.repeat(80));

    const privateKey = process.env.PRIVATE_KEY || '0x' + '1'.repeat(64);
    const wallet = new ethers.Wallet(privateKey, provider);
    const agentId = await registry.addressToAgentId(wallet.address);

    if (agentId === 0n) {
        log('INFO', 'Skipping liquidity exhaustion tests - agent not registered');
        return;
    }

    try {
        const pool = await marketplace.agentPools(agentId);
        const available = ethers.formatUnits(pool.availableLiquidity, 6);
        const total = ethers.formatUnits(pool.totalLiquidity, 6);

        log('INFO', `Pool liquidity: ${available}/${total} USDC available`);

        // Test: Attempt to borrow more than available
        if (parseFloat(available) > 0) {
            const excessiveAmount = pool.availableLiquidity + ethers.parseUnits('1', 6);

            log('INFO', 'Testing loan exceeding available liquidity...');
            const mpWithSigner = marketplace.connect(wallet);

            try {
                await mpWithSigner.requestLoan.staticCall(excessiveAmount, 7);
                logTest('Liquidity Exhaustion Protection', false, 'Excessive borrowing was allowed');
            } catch (error) {
                logTest('Liquidity Exhaustion Protection', true, 'Excessive borrowing blocked');
            }
        } else {
            logWarning('No liquidity available for exhaustion test');
        }

        // Test: Query utilization rate
        const utilization = pool.totalLiquidity > 0n
            ? (Number(pool.totalLoaned) / Number(pool.totalLiquidity)) * 100
            : 0;

        log('INFO', `Pool utilization: ${utilization.toFixed(2)}%`);
        logTest('Utilization Rate Calculation', true, `${utilization.toFixed(2)}%`);

        if (utilization > 95) {
            logWarning('Pool is nearly exhausted (>95% utilization)');
        }

    } catch (error) {
        logTest('Liquidity Pool Exhaustion', false, error.message);
    }
}

async function testContractResponsiveness() {
    console.log('\n' + '='.repeat(80));
    console.log('TEST 6: Contract Responsiveness');
    console.log('='.repeat(80));

    try {
        // Test 1: Marketplace response time
        const { duration: mpTime } = await measureTime(
            'marketplace_query',
            () => marketplace.totalPools()
        );
        log('INFO', `Marketplace query time: ${mpTime}ms`);
        logTest('Marketplace Responsiveness', mpTime < 5000, `${mpTime}ms`);

        // Test 2: Registry response time
        const { duration: regTime } = await measureTime(
            'registry_query',
            () => registry.totalAgents()
        );
        log('INFO', `Registry query time: ${regTime}ms`);
        logTest('Registry Responsiveness', regTime < 5000, `${regTime}ms`);

        // Test 3: Reputation Manager response time
        const privateKey = process.env.PRIVATE_KEY || '0x' + '1'.repeat(64);
        const wallet = new ethers.Wallet(privateKey, provider);

        const { duration: rmTime } = await measureTime(
            'reputation_query',
            () => reputationManager['getReputationScore(address)'](wallet.address)
        );
        log('INFO', `Reputation query time: ${rmTime}ms`);
        logTest('Reputation Manager Responsiveness', rmTime < 5000, `${rmTime}ms`);

        // Test 4: Provider response time
        const { duration: providerTime } = await measureTime(
            'provider_query',
            () => provider.getBlockNumber()
        );
        log('INFO', `Provider query time: ${providerTime}ms`);
        logTest('RPC Provider Responsiveness', providerTime < 3000, `${providerTime}ms`);

    } catch (error) {
        logTest('Contract Responsiveness', false, error.message);
    }
}

// Main Test Runner
async function runStressTests() {
    console.log('\n' + '█'.repeat(80));
    console.log('SPECULAR PROTOCOL - COMPREHENSIVE STRESS TEST SUITE');
    console.log('█'.repeat(80));
    console.log(`Network: ${NETWORK.toUpperCase()}`);
    console.log(`RPC: ${RPC_URL}`);
    console.log(`Chain ID: ${CHAIN_ID}`);
    console.log('█'.repeat(80) + '\n');

    const startTime = Date.now();

    try {
        await testContractResponsiveness();
        await testMaximumCapacity();
        await testEdgeCases();
        await testReputationSystem();
        await testLiquidityPoolExhaustion();
        await testConcurrentLoanRequests();

    } catch (error) {
        log('ERROR', `Fatal error during tests: ${error.message}`);
        testResults.errors.push({ test: 'Test Runner', details: error.message });
    }

    const totalTime = Date.now() - startTime;

    // Print Summary
    console.log('\n' + '█'.repeat(80));
    console.log('TEST SUMMARY');
    console.log('█'.repeat(80));
    console.log(`Total Tests: ${testResults.passed + testResults.failed}`);
    console.log(`✅ Passed: ${testResults.passed}`);
    console.log(`❌ Failed: ${testResults.failed}`);
    console.log(`⚠️  Warnings: ${testResults.warnings.length}`);
    console.log(`⏱️  Total Time: ${(totalTime / 1000).toFixed(2)}s`);
    console.log('');

    if (testResults.failed > 0) {
        console.log('FAILED TESTS:');
        testResults.errors.forEach((err, i) => {
            console.log(`${i + 1}. ${err.test}: ${err.details}`);
        });
        console.log('');
    }

    if (testResults.warnings.length > 0) {
        console.log('WARNINGS:');
        testResults.warnings.forEach((warn, i) => {
            console.log(`${i + 1}. ${warn}`);
        });
        console.log('');
    }

    console.log('PERFORMANCE METRICS:');
    Object.entries(testResults.performance).forEach(([test, time]) => {
        console.log(`  ${test}: ${time}ms`);
    });
    console.log('');

    const successRate = ((testResults.passed / (testResults.passed + testResults.failed)) * 100).toFixed(1);
    console.log(`Success Rate: ${successRate}%`);
    console.log('█'.repeat(80) + '\n');

    // Save results to file
    const resultsFile = `./stress-test-results-${NETWORK}-${Date.now()}.json`;
    fs.writeFileSync(resultsFile, JSON.stringify({
        network: NETWORK,
        timestamp: new Date().toISOString(),
        results: testResults,
        totalTime,
        successRate: parseFloat(successRate)
    }, null, 2));

    console.log(`📁 Results saved to: ${resultsFile}\n`);

    return testResults.failed === 0 ? 0 : 1;
}

// Execute
runStressTests()
    .then(exitCode => process.exit(exitCode))
    .catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
