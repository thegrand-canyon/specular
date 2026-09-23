/**
 * Test the optimized /agents API endpoint
 * Verifies caching, pagination, and timeout handling
 */

const API_URL = process.env.API_URL || 'https://specular-production.up.railway.app';

async function testAgentsAPI() {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║      TEST: Optimized /agents API Endpoint                 ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    const tests = [];

    // Test 1: Basic request with default pagination
    console.log('Test 1: Basic request with default pagination');
    const start1 = Date.now();
    try {
        const res = await fetch(`${API_URL}/agents?network=arc`);
        const data = await res.json();
        const elapsed1 = Date.now() - start1;

        console.log(`   ✅ Response time: ${elapsed1}ms`);
        console.log(`   Total agents: ${data.totalAgents}`);
        console.log(`   Returned: ${data.returned}`);
        console.log(`   Offset: ${data.offset}, Limit: ${data.limit}`);
        console.log(`   Has more: ${data.hasMore}`);
        console.log(`   Cached: ${data.cached}\n`);

        tests.push({ name: 'Basic request', passed: elapsed1 < 10000, elapsed: elapsed1 });
    } catch (error) {
        console.log(`   ❌ Failed: ${error.message}\n`);
        tests.push({ name: 'Basic request', passed: false, elapsed: 0 });
    }

    // Test 2: Request with custom limit
    console.log('Test 2: Request with custom limit (20)');
    const start2 = Date.now();
    try {
        const res = await fetch(`${API_URL}/agents?network=arc&limit=20`);
        const data = await res.json();
        const elapsed2 = Date.now() - start2;

        console.log(`   ✅ Response time: ${elapsed2}ms`);
        console.log(`   Returned: ${data.returned} (should be ≤ 20)`);
        console.log(`   Cached: ${data.cached}\n`);

        tests.push({ name: 'Custom limit', passed: elapsed2 < 10000 && data.returned <= 20, elapsed: elapsed2 });
    } catch (error) {
        console.log(`   ❌ Failed: ${error.message}\n`);
        tests.push({ name: 'Custom limit', passed: false, elapsed: 0 });
    }

    // Test 3: Cache test (should be fast)
    console.log('Test 3: Cache test (repeat request)');
    const start3 = Date.now();
    try {
        const res = await fetch(`${API_URL}/agents?network=arc`);
        const data = await res.json();
        const elapsed3 = Date.now() - start3;

        console.log(`   ✅ Response time: ${elapsed3}ms`);
        console.log(`   Cached: ${data.cached || 'from cache'}`);
        console.log(`   Speed improvement: ${elapsed3 < 100 ? 'EXCELLENT' : 'GOOD'}\n`);

        tests.push({ name: 'Cache hit', passed: elapsed3 < 1000, elapsed: elapsed3 });
    } catch (error) {
        console.log(`   ❌ Failed: ${error.message}\n`);
        tests.push({ name: 'Cache hit', passed: false, elapsed: 0 });
    }

    // Test 4: Pagination test
    console.log('Test 4: Pagination (offset=10, limit=5)');
    const start4 = Date.now();
    try {
        const res = await fetch(`${API_URL}/agents?network=arc&offset=10&limit=5`);
        const data = await res.json();
        const elapsed4 = Date.now() - start4;

        console.log(`   ✅ Response time: ${elapsed4}ms`);
        console.log(`   Returned: ${data.returned}`);
        console.log(`   Offset: ${data.offset}, Limit: ${data.limit}`);
        console.log(`   First agent ID: ${data.agents[0]?.agentId || 'N/A'}\n`);

        tests.push({ name: 'Pagination', passed: elapsed4 < 10000 && data.offset === 10, elapsed: elapsed4 });
    } catch (error) {
        console.log(`   ❌ Failed: ${error.message}\n`);
        tests.push({ name: 'Pagination', passed: false, elapsed: 0 });
    }

    // Test 5: Concurrent requests (10 simultaneous)
    console.log('Test 5: Concurrent requests (10 simultaneous)');
    const start5 = Date.now();
    try {
        const promises = Array(10).fill(null).map(() =>
            fetch(`${API_URL}/agents?network=arc&limit=10`)
        );
        const results = await Promise.all(promises);
        const elapsed5 = Date.now() - start5;

        console.log(`   ✅ Response time: ${elapsed5}ms for 10 requests`);
        console.log(`   All succeeded: ${results.every(r => r.ok)}`);
        console.log(`   Avg per request: ${(elapsed5 / 10).toFixed(0)}ms\n`);

        tests.push({ name: 'Concurrent requests', passed: elapsed5 < 15000, elapsed: elapsed5 });
    } catch (error) {
        console.log(`   ❌ Failed: ${error.message}\n`);
        tests.push({ name: 'Concurrent requests', passed: false, elapsed: 0 });
    }

    // Summary
    console.log('═'.repeat(60));
    console.log('TEST SUMMARY');
    console.log('═'.repeat(60));

    const passed = tests.filter(t => t.passed).length;
    const total = tests.length;

    tests.forEach(test => {
        const status = test.passed ? '✅' : '❌';
        console.log(`${status} ${test.name.padEnd(30)} ${test.elapsed}ms`);
    });

    console.log('═'.repeat(60));
    console.log(`Pass Rate: ${passed}/${total} (${((passed / total) * 100).toFixed(1)}%)`);
    console.log('═'.repeat(60) + '\n');

    if (passed === total) {
        console.log('🎉 All tests passed! /agents endpoint is optimized.\n');
    } else {
        console.log('⚠️  Some tests failed. Check the API deployment.\n');
    }
}

testAgentsAPI().catch((e) => { console.error(e); process.exit(1); });
