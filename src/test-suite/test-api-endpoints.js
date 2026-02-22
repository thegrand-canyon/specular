/**
 * Comprehensive API Endpoint Testing
 * Tests all Specular Agent API endpoints
 */

const API_BASE = 'http://localhost:3001';

async function testEndpoint(name, url, options = {}) {
    try {
        const response = await fetch(url, options);
        const data = await response.json();

        console.log(`\n${'='.repeat(70)}`);
        console.log(`✅ ${name}`);
        console.log(`   URL: ${url}`);
        console.log(`   Status: ${response.status}`);
        console.log(`   Response:`, JSON.stringify(data, null, 2).split('\n').slice(0, 15).join('\n'));

        return { success: true, data };
    } catch (error) {
        console.log(`\n${'='.repeat(70)}`);
        console.log(`❌ ${name}`);
        console.log(`   URL: ${url}`);
        console.log(`   Error: ${error.message}`);
        return { success: false, error: error.message };
    }
}

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║     Specular Agent API - Endpoint Tests         ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const results = [];

    // 1. Discovery Endpoints
    console.log('\n📋 DISCOVERY ENDPOINTS\n');
    results.push(await testEndpoint('Root Endpoint', `${API_BASE}/`));
    results.push(await testEndpoint('Well-Known', `${API_BASE}/.well-known/specular.json`));
    results.push(await testEndpoint('OpenAPI Spec', `${API_BASE}/openapi.json`));

    // 2. Status Endpoints
    console.log('\n\n📊 STATUS ENDPOINTS\n');
    results.push(await testEndpoint('Health Check', `${API_BASE}/health`));
    results.push(await testEndpoint('Protocol Status', `${API_BASE}/status`));

    // 3. Agent Data Endpoints
    console.log('\n\n👤 AGENT DATA ENDPOINTS\n');

    // Test with a known registered agent (agent #43)
    const testAgent = '0x656086A21073272533c8A3f56A94c1f3D8BCFcE2';
    results.push(await testEndpoint('Agent Profile (Registered)', `${API_BASE}/agents/${testAgent}`));

    // Test with unregistered address
    const unregisteredAgent = '0x0000000000000000000000000000000000000001';
    results.push(await testEndpoint('Agent Profile (Unregistered)', `${API_BASE}/agents/${unregisteredAgent}`));

    // 4. Pool Endpoints
    console.log('\n\n💧 POOL ENDPOINTS\n');
    results.push(await testEndpoint('All Pools', `${API_BASE}/pools`));

    // Test with agent #43's pool
    results.push(await testEndpoint('Pool Detail (Agent #43)', `${API_BASE}/pools/43`));

    // 5. Loan Endpoints
    console.log('\n\n💰 LOAN ENDPOINTS\n');

    // Test with a known loan ID (if we have one)
    results.push(await testEndpoint('Loan Detail', `${API_BASE}/loans/1`));

    // 6. Transaction Builder Endpoints
    console.log('\n\n🔨 TRANSACTION BUILDER ENDPOINTS\n');

    results.push(await testEndpoint('Build Register TX', `${API_BASE}/tx/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata: 'ipfs://test-metadata' })
    }));

    results.push(await testEndpoint('Build Request Loan TX', `${API_BASE}/tx/request-loan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 100, durationDays: 30 })
    }));

    results.push(await testEndpoint('Build Repay Loan TX', `${API_BASE}/tx/repay-loan`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loanId: 1 })
    }));

    results.push(await testEndpoint('Build Supply Liquidity TX', `${API_BASE}/tx/supply-liquidity`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 43, amount: 500 })
    }));

    // Summary
    console.log('\n\n' + '═'.repeat(70));
    console.log('  TEST SUMMARY');
    console.log('═'.repeat(70));

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    console.log(`\nTotal Tests:    ${results.length}`);
    console.log(`Successful:     ${successful} ✅`);
    console.log(`Failed:         ${failed} ❌`);
    console.log(`Success Rate:   ${((successful / results.length) * 100).toFixed(1)}%\n`);

    if (failed > 0) {
        console.log('Failed Tests:');
        results.filter(r => !r.success).forEach((r, i) => {
            console.log(`  ${i + 1}. ${r.error}`);
        });
        console.log('');
    }

    console.log('═'.repeat(70) + '\n');

    process.exit(failed > 0 ? 1 : 0);
}

main().catch(error => {
    console.error('\n❌ Test suite error:', error);
    process.exit(1);
});
