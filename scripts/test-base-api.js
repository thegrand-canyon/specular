/**
 * Comprehensive Base Mainnet API Testing
 */

const { ethers } = require('ethers');

const API_URL = 'http://localhost:3001';
const YOUR_WALLET = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';

async function testAPI() {
    console.log('═══════════════════════════════════════');
    console.log('  BASE MAINNET API TEST SUITE');
    console.log('═══════════════════════════════════════\n');

    let passed = 0;
    let failed = 0;

    // Test 1: Discovery endpoint
    console.log('Test 1: Discovery Endpoint');
    try {
        const res = await fetch(`${API_URL}/.well-known/specular.json`);
        const data = await res.json();

        if (data.protocol === 'Specular' && data.network === 'base' && data.chainId === 8453) {
            console.log('  ✅ Discovery endpoint working');
            console.log(`     Network: ${data.network}, Chain: ${data.chainId}`);
            passed++;
        } else {
            console.log('  ❌ Discovery returned wrong data');
            failed++;
        }
    } catch (error) {
        console.log('  ❌ Discovery failed:', error.message);
        failed++;
    }

    // Test 2: Health check
    console.log('\nTest 2: Health Check');
    try {
        const res = await fetch(`${API_URL}/health`);
        const data = await res.json();

        if (data.ok && data.blockNumber > 0) {
            console.log('  ✅ Health check passing');
            console.log(`     Current block: ${data.blockNumber}`);
            passed++;
        } else {
            console.log('  ❌ Health check failed');
            failed++;
        }
    } catch (error) {
        console.log('  ❌ Health endpoint error:', error.message);
        failed++;
    }

    // Test 3: Status endpoint
    console.log('\nTest 3: Protocol Status');
    try {
        const res = await fetch(`${API_URL}/status`);
        const data = await res.json();

        if (data.network === 'base' && data.totalPools >= 1) {
            console.log('  ✅ Status endpoint working');
            console.log(`     TVL: ${data.tvl}`);
            console.log(`     Total Pools: ${data.totalPools}`);
            passed++;
        } else {
            console.log('  ❌ Status returned unexpected data');
            failed++;
        }
    } catch (error) {
        console.log('  ❌ Status endpoint error:', error.message);
        failed++;
    }

    // Test 4: Agent profile (registered)
    console.log('\nTest 4: Agent Profile (Your Wallet)');
    try {
        const res = await fetch(`${API_URL}/agents/${YOUR_WALLET}`);
        const data = await res.json();

        if (data.registered && data.agentId) {
            console.log('  ✅ Agent profile working');
            console.log(`     Agent ID: ${data.agentId}`);
            console.log(`     Reputation: ${data.reputation.score} (${data.reputation.tier})`);
            console.log(`     Credit Limit: ${data.creditLimit}`);
            console.log(`     Interest Rate: ${data.interestRate}`);
            passed++;
        } else {
            console.log('  ❌ Agent profile incomplete');
            failed++;
        }
    } catch (error) {
        console.log('  ❌ Agent profile error:', error.message);
        failed++;
    }

    // Test 5: Agent profile (unregistered)
    console.log('\nTest 5: Agent Profile (Unregistered Address)');
    try {
        const randomAddr = '0x' + '1'.repeat(40);
        const res = await fetch(`${API_URL}/agents/${randomAddr}`);
        const data = await res.json();

        if (!data.registered && data.address) {
            console.log('  ✅ Unregistered agent handled correctly');
            console.log(`     Registered: ${data.registered}`);
            passed++;
        } else {
            console.log('  ❌ Unregistered agent response unexpected');
            failed++;
        }
    } catch (error) {
        console.log('  ❌ Unregistered agent error:', error.message);
        failed++;
    }

    // Test 6: Pools listing
    console.log('\nTest 6: Pools Listing');
    try {
        const res = await fetch(`${API_URL}/pools`);
        const data = await res.json();

        if (data.pools && Array.isArray(data.pools) && data.pools.length > 0) {
            console.log('  ✅ Pools listing working');
            console.log(`     Found ${data.pools.length} pool(s)`);
            console.log(`     Pool 1: ${data.pools[0].availableLiquidity} USDC available`);
            console.log(`     Utilization: ${data.pools[0].utilization}`);
            passed++;
        } else {
            console.log('  ❌ Pools listing failed');
            failed++;
        }
    } catch (error) {
        console.log('  ❌ Pools endpoint error:', error.message);
        failed++;
    }

    // Test 7: Pool detail
    console.log('\nTest 7: Pool Detail');
    try {
        const res = await fetch(`${API_URL}/pools/1`);
        const data = await res.json();

        if (data.poolId === 1 && data.agentAddress) {
            console.log('  ✅ Pool detail working');
            console.log(`     Agent: ${data.agentAddress}`);
            console.log(`     Total Liquidity: ${data.totalLiquidity} USDC`);
            console.log(`     Available: ${data.availableLiquidity} USDC`);
            console.log(`     Earned: ${data.totalEarned} USDC`);
            passed++;
        } else {
            console.log('  ❌ Pool detail incomplete');
            failed++;
        }
    } catch (error) {
        console.log('  ❌ Pool detail error:', error.message);
        failed++;
    }

    // Test 8: Transaction endpoint - Register
    console.log('\nTest 8: Transaction Endpoint - Register');
    try {
        const res = await fetch(`${API_URL}/tx/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agentURI: 'test-agent',
                metadata: []
            })
        });
        const data = await res.json();

        if (data.to && data.data && data.description) {
            console.log('  ✅ Register transaction endpoint working');
            console.log(`     To: ${data.to}`);
            console.log(`     Gas Estimate: ${data.gasEstimate}`);
            passed++;
        } else {
            console.log('  ❌ Register transaction incomplete');
            failed++;
        }
    } catch (error) {
        console.log('  ❌ Register transaction error:', error.message);
        failed++;
    }

    // Test 9: Transaction endpoint - Request Loan
    console.log('\nTest 9: Transaction Endpoint - Request Loan');
    try {
        const res = await fetch(`${API_URL}/tx/request-loan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                poolId: 1,
                amount: 50,
                durationDays: 30
            })
        });
        const data = await res.json();

        if (data.to && data.data && data.description) {
            console.log('  ✅ Request loan transaction endpoint working');
            console.log(`     Description: ${data.description}`);
            console.log(`     Gas Estimate: ${data.gasEstimate}`);
            passed++;
        } else {
            console.log('  ❌ Request loan transaction incomplete');
            failed++;
        }
    } catch (error) {
        console.log('  ❌ Request loan transaction error:', error.message);
        failed++;
    }

    // Test 10: Transaction endpoint - Repay Loan
    console.log('\nTest 10: Transaction Endpoint - Repay Loan');
    try {
        const res = await fetch(`${API_URL}/tx/repay-loan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                loanId: 1
            })
        });
        const data = await res.json();

        if (data.to && data.data && data.description) {
            console.log('  ✅ Repay loan transaction endpoint working');
            console.log(`     Description: ${data.description}`);
            console.log(`     Gas Estimate: ${data.gasEstimate}`);
            passed++;
        } else {
            console.log('  ❌ Repay loan transaction incomplete');
            failed++;
        }
    } catch (error) {
        console.log('  ❌ Repay loan transaction error:', error.message);
        failed++;
    }

    // Summary
    console.log('\n═══════════════════════════════════════');
    console.log('  TEST RESULTS');
    console.log('═══════════════════════════════════════');
    console.log(`  ✅ Passed: ${passed}/10`);
    console.log(`  ❌ Failed: ${failed}/10`);
    console.log(`  Success Rate: ${(passed/10*100).toFixed(0)}%`);
    console.log('═══════════════════════════════════════\n');

    if (failed === 0) {
        console.log('🎉 ALL TESTS PASSED! Base Mainnet API is production ready.\n');
    } else {
        console.log('⚠️  Some tests failed. Check errors above.\n');
    }
}

testAPI().catch((e) => { console.error(e); process.exit(1); });
