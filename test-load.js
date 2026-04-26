#!/usr/bin/env node

/**
 * Comprehensive Load Testing for Specular Multi-Network API
 * Tests Arc Testnet and Base Mainnet under heavy concurrent load
 */

const API_URL = process.env.API_URL || 'https://specular-production.up.railway.app';
const CONCURRENCY = parseInt(process.env.CONCURRENCY) || 20;
const REQUESTS_PER_ENDPOINT = parseInt(process.env.REQUESTS) || 50;
const NETWORK = process.env.NETWORK || 'arc';

// ANSI colors for terminal output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

// Test configuration
const endpoints = [
    { name: 'Health', path: `/health?network=${NETWORK}` },
    { name: 'Stats', path: '/stats' },
    { name: 'Networks', path: '/networks' },
    { name: `Network Info (${NETWORK})`, path: `/network/${NETWORK}` },
    { name: `All Agents (${NETWORK})`, path: `/agents?network=${NETWORK}&limit=10` },
    { name: `Agent by ID (${NETWORK})`, path: `/agent/${NETWORK === 'arc' ? '43' : '1'}?network=${NETWORK}` },
    { name: `All Pools (${NETWORK})`, path: `/pools?network=${NETWORK}&limit=10` },
    { name: `Pool by ID (${NETWORK})`, path: `/pools/1?network=${NETWORK}` }
];

// Statistics tracking
const stats = {
    total: 0,
    success: 0,
    errors: 0,
    responseTimes: [],
    errorDetails: {},
    startTime: null,
    endTime: null
};

// Memory tracking
const memorySnapshots = [];

// Helper: Make HTTP request
async function makeRequest(url) {
    const startTime = Date.now();

    try {
        const response = await fetch(url);
        const endTime = Date.now();
        const responseTime = endTime - startTime;

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        return {
            success: true,
            responseTime,
            status: response.status,
            data
        };
    } catch (error) {
        const endTime = Date.now();
        const responseTime = endTime - startTime;

        return {
            success: false,
            responseTime,
            error: error.message
        };
    }
}

// Helper: Run concurrent requests
async function runConcurrentRequests(url, count, concurrency) {
    const results = [];
    const queue = Array.from({ length: count }, (_, i) => i);

    async function worker() {
        while (queue.length > 0) {
            queue.shift();
            const result = await makeRequest(url);
            results.push(result);

            // Update progress
            if (results.length % 10 === 0) {
                process.stdout.write(`\r   Progress: ${results.length}/${count} requests...`);
            }
        }
    }

    // Start workers
    const workers = Array.from({ length: concurrency }, () => worker());
    await Promise.all(workers);

    process.stdout.write('\r');
    return results;
}

// Helper: Calculate statistics
function calculateStats(results) {
    const responseTimes = results.map(r => r.responseTime);
    const successCount = results.filter(r => r.success).length;
    const errorCount = results.filter(r => !r.success).length;

    responseTimes.sort((a, b) => a - b);

    const p50 = responseTimes[Math.floor(responseTimes.length * 0.5)];
    const p95 = responseTimes[Math.floor(responseTimes.length * 0.95)];
    const p99 = responseTimes[Math.floor(responseTimes.length * 0.99)];
    const min = responseTimes[0];
    const max = responseTimes[responseTimes.length - 1];
    const avg = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;

    return {
        total: results.length,
        success: successCount,
        errors: errorCount,
        successRate: ((successCount / results.length) * 100).toFixed(2),
        responseTime: {
            min: min.toFixed(0),
            max: max.toFixed(0),
            avg: avg.toFixed(0),
            p50: p50.toFixed(0),
            p95: p95.toFixed(0),
            p99: p99.toFixed(0)
        }
    };
}

// Helper: Check memory usage
async function checkMemory() {
    try {
        const response = await fetch(`${API_URL}/stats`);
        const data = await response.json();

        return {
            timestamp: Date.now(),
            heapUsed: data.circuitBreaker.memory.heapUsed,
            heapLimit: data.circuitBreaker.memory.heapLimit,
            usagePercent: parseFloat(data.circuitBreaker.memory.usagePercent),
            circuitBreakerOpen: data.circuitBreaker.isOpen
        };
    } catch (error) {
        return null;
    }
}

// Main test runner
async function runLoadTest() {
    console.log(`${colors.bright}${colors.cyan}`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  SPECULAR API - COMPREHENSIVE LOAD TEST');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(colors.reset);

    console.log(`${colors.blue}Configuration:${colors.reset}`);
    console.log(`  API URL: ${API_URL}`);
    console.log(`  Network: ${NETWORK.toUpperCase()}`);
    console.log(`  Concurrency: ${CONCURRENCY} parallel requests`);
    console.log(`  Requests per endpoint: ${REQUESTS_PER_ENDPOINT}`);
    console.log(`  Total endpoints: ${endpoints.length}`);
    console.log(`  Total requests: ${endpoints.length * REQUESTS_PER_ENDPOINT}`);
    console.log('');

    // Get initial memory
    const initialMemory = await checkMemory();
    if (initialMemory) {
        console.log(`${colors.blue}Initial Memory:${colors.reset}`);
        console.log(`  Heap Used: ${initialMemory.heapUsed} MB / ${initialMemory.heapLimit} MB`);
        console.log(`  Usage: ${initialMemory.usagePercent}%`);
        console.log(`  Circuit Breaker: ${initialMemory.circuitBreakerOpen ? colors.red + 'OPEN' : colors.green + 'CLOSED'}${colors.reset}`);
        console.log('');
        memorySnapshots.push(initialMemory);
    }

    stats.startTime = Date.now();

    // Run tests for each endpoint
    for (const endpoint of endpoints) {
        console.log(`${colors.yellow}Testing: ${endpoint.name}${colors.reset}`);

        const url = `${API_URL}${endpoint.path}`;
        const results = await runConcurrentRequests(url, REQUESTS_PER_ENDPOINT, CONCURRENCY);

        const endpointStats = calculateStats(results);

        // Update global stats
        stats.total += endpointStats.total;
        stats.success += endpointStats.success;
        stats.errors += endpointStats.errors;
        stats.responseTimes.push(...results.map(r => r.responseTime));

        // Track errors
        results.filter(r => !r.success).forEach(r => {
            const key = r.error;
            stats.errorDetails[key] = (stats.errorDetails[key] || 0) + 1;
        });

        // Print endpoint results
        const statusColor = endpointStats.errors > 0 ? colors.red : colors.green;
        console.log(`   ${statusColor}✓${colors.reset} ${endpointStats.success}/${endpointStats.total} succeeded (${endpointStats.successRate}%)`);
        console.log(`   Response Times: min=${endpointStats.responseTime.min}ms, avg=${endpointStats.responseTime.avg}ms, p95=${endpointStats.responseTime.p95}ms, max=${endpointStats.responseTime.max}ms`);

        if (endpointStats.errors > 0) {
            console.log(`   ${colors.red}Errors: ${endpointStats.errors}${colors.reset}`);
        }

        console.log('');

        // Check memory every few endpoints
        const memory = await checkMemory();
        if (memory) {
            memorySnapshots.push(memory);
        }
    }

    stats.endTime = Date.now();

    // Get final memory
    const finalMemory = await checkMemory();
    if (finalMemory) {
        memorySnapshots.push(finalMemory);
    }

    // Print summary
    printSummary();
}

// Print summary
function printSummary() {
    const duration = ((stats.endTime - stats.startTime) / 1000).toFixed(2);
    const rps = (stats.total / (stats.endTime - stats.startTime) * 1000).toFixed(2);

    console.log(`${colors.bright}${colors.cyan}`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  LOAD TEST RESULTS');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(colors.reset);

    // Overall stats
    console.log(`${colors.blue}Overall Performance:${colors.reset}`);
    console.log(`  Total Requests: ${stats.total}`);
    console.log(`  Successful: ${colors.green}${stats.success}${colors.reset}`);
    console.log(`  Failed: ${stats.errors > 0 ? colors.red : colors.green}${stats.errors}${colors.reset}`);
    console.log(`  Success Rate: ${stats.errors > 0 ? colors.yellow : colors.green}${((stats.success / stats.total) * 100).toFixed(2)}%${colors.reset}`);
    console.log(`  Duration: ${duration}s`);
    console.log(`  Throughput: ${rps} requests/second`);
    console.log('');

    // Response time stats
    const sortedTimes = stats.responseTimes.sort((a, b) => a - b);
    const globalStats = {
        min: sortedTimes[0],
        max: sortedTimes[sortedTimes.length - 1],
        avg: sortedTimes.reduce((a, b) => a + b, 0) / sortedTimes.length,
        p50: sortedTimes[Math.floor(sortedTimes.length * 0.5)],
        p95: sortedTimes[Math.floor(sortedTimes.length * 0.95)],
        p99: sortedTimes[Math.floor(sortedTimes.length * 0.99)]
    };

    console.log(`${colors.blue}Response Times (all endpoints):${colors.reset}`);
    console.log(`  Min: ${globalStats.min.toFixed(0)}ms`);
    console.log(`  Max: ${globalStats.max.toFixed(0)}ms`);
    console.log(`  Average: ${globalStats.avg.toFixed(0)}ms`);
    console.log(`  Median (p50): ${globalStats.p50.toFixed(0)}ms`);
    console.log(`  p95: ${globalStats.p95.toFixed(0)}ms`);
    console.log(`  p99: ${globalStats.p99.toFixed(0)}ms`);
    console.log('');

    // Memory stats
    if (memorySnapshots.length > 0) {
        const initialMem = memorySnapshots[0];
        const finalMem = memorySnapshots[memorySnapshots.length - 1];
        const peakMem = memorySnapshots.reduce((max, snap) =>
            snap.heapUsed > max.heapUsed ? snap : max
        );

        console.log(`${colors.blue}Memory Usage:${colors.reset}`);
        console.log(`  Initial: ${initialMem.heapUsed} MB (${initialMem.usagePercent}%)`);
        console.log(`  Peak: ${peakMem.heapUsed} MB (${peakMem.usagePercent}%)`);
        console.log(`  Final: ${finalMem.heapUsed} MB (${finalMem.usagePercent}%)`);
        console.log(`  Heap Limit: ${finalMem.heapLimit} MB`);
        console.log(`  Circuit Breaker Triggered: ${memorySnapshots.some(s => s.circuitBreakerOpen) ? colors.red + 'YES' : colors.green + 'NO'}${colors.reset}`);
        console.log('');
    }

    // Error details
    if (Object.keys(stats.errorDetails).length > 0) {
        console.log(`${colors.red}Error Details:${colors.reset}`);
        Object.entries(stats.errorDetails).forEach(([error, count]) => {
            console.log(`  ${error}: ${count} occurrences`);
        });
        console.log('');
    }

    // Pass/Fail
    const passed = stats.errors === 0 && !memorySnapshots.some(s => s.circuitBreakerOpen);
    console.log(`${colors.bright}Test Result: ${passed ? colors.green + '✅ PASSED' : colors.red + '❌ FAILED'}${colors.reset}`);
    console.log('');
}

// Run the test
runLoadTest().catch(error => {
    console.error(`${colors.red}Fatal error:${colors.reset}`, error);
    process.exit(1);
});
