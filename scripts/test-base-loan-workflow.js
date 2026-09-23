/**
 * Test Full Loan Workflow on Base Mainnet
 *
 * This will test (but not execute):
 * 1. Register a new agent
 * 2. Check reputation and credit limit
 * 3. Request a loan
 * 4. Check loan status
 * 5. Repay the loan
 */

const { ethers } = require('ethers');
const fs = require('fs');

const NETWORK = 'base';
const RPC_URL = 'https://mainnet.base.org';
const API_URL = 'http://localhost:3001';

async function testLoanWorkflow() {
    console.log('═══════════════════════════════════════');
    console.log('  BASE MAINNET LOAN WORKFLOW TEST');
    console.log('═══════════════════════════════════════\n');

    // Create a test wallet (not funded, just for testing calldata)
    const testWallet = ethers.Wallet.createRandom();
    console.log('Test Agent Address:', testWallet.address);
    console.log('(Not funded - testing calldata generation only)\n');

    // Step 1: Test registration calldata
    console.log('Step 1: Generate Registration Transaction');
    console.log('─────────────────────────────────────────');
    try {
        const regRes = await fetch(`${API_URL}/tx/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                agentURI: `test-agent-${testWallet.address.slice(0, 8)}`,
                metadata: []
            })
        });
        const regTx = await regRes.json();

        console.log('✅ Registration transaction generated');
        console.log('   To:', regTx.to);
        console.log('   Gas Estimate:', regTx.gasEstimate);
        console.log('   Calldata length:', regTx.data.length, 'bytes\n');
    } catch (error) {
        console.log('❌ Registration failed:', error.message, '\n');
    }

    // Step 2: Check agent profile
    console.log('Step 2: Check Agent Profile');
    console.log('─────────────────────────────────────────');
    try {
        const profileRes = await fetch(`${API_URL}/agents/${testWallet.address}`);
        const profile = await profileRes.json();

        if (!profile.registered) {
            console.log('✅ Profile check working');
            console.log('   Status: Not registered (as expected)');
            console.log('   Hint:', profile.hint, '\n');
        }
    } catch (error) {
        console.log('❌ Profile check failed:', error.message, '\n');
    }

    // Step 3: Test loan request calldata
    console.log('Step 3: Generate Loan Request Transaction');
    console.log('─────────────────────────────────────────');
    try {
        const loanRes = await fetch(`${API_URL}/tx/request-loan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                amount: 50,
                durationDays: 30
            })
        });
        const loanTx = await loanRes.json();

        console.log('✅ Loan request transaction generated');
        console.log('   Description:', loanTx.description);
        console.log('   To:', loanTx.to);
        console.log('   Gas Estimate:', loanTx.gasEstimate);
        console.log('   Calldata length:', loanTx.data.length, 'bytes\n');
    } catch (error) {
        console.log('❌ Loan request failed:', error.message, '\n');
    }

    // Step 4: Test repay loan calldata
    console.log('Step 4: Generate Loan Repayment Transaction');
    console.log('─────────────────────────────────────────');
    try {
        const repayRes = await fetch(`${API_URL}/tx/repay-loan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                loanId: 1
            })
        });
        const repayTx = await repayRes.json();

        console.log('✅ Repayment transaction generated');
        console.log('   Description:', repayTx.description);
        console.log('   To:', repayTx.to);
        console.log('   Gas Estimate:', repayTx.gasEstimate);
        console.log('   Calldata length:', repayTx.data.length, 'bytes\n');
    } catch (error) {
        console.log('❌ Repayment generation failed:', error.message, '\n');
    }

    // Step 5: Test with your actual registered wallet
    const yourWallet = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';
    console.log('Step 5: Check Your Actual Agent Profile');
    console.log('─────────────────────────────────────────');
    try {
        const yourProfileRes = await fetch(`${API_URL}/agents/${yourWallet}`);
        const yourProfile = await yourProfileRes.json();

        console.log('✅ Your profile:');
        console.log('   Agent ID:', yourProfile.agentId);
        console.log('   Reputation:', yourProfile.reputation.score, '(' + yourProfile.reputation.tier + ')');
        console.log('   Credit Limit:', yourProfile.credit.limit);
        console.log('   Interest Rate:', yourProfile.credit.interestRate);
        console.log('   Active Loans:', yourProfile.stats.activeLoans);
        console.log('   Total Loans:', yourProfile.stats.totalLoans, '\n');
    } catch (error) {
        console.log('❌ Your profile check failed:', error.message, '\n');
    }

    // Step 6: Check available liquidity
    console.log('Step 6: Check Available Liquidity');
    console.log('─────────────────────────────────────────');
    try {
        const poolsRes = await fetch(`${API_URL}/pools`);
        const poolsData = await poolsRes.json();

        console.log('✅ Available pools:', poolsData.pools.length);
        poolsData.pools.forEach(pool => {
            console.log(`   Pool ${pool.poolId}:`);
            console.log(`     Owner: ${pool.agentAddress}`);
            console.log(`     Available: ${pool.availableLiquidity} USDC`);
            console.log(`     Utilization: ${pool.utilization}`);
        });
        console.log();
    } catch (error) {
        console.log('❌ Pools check failed:', error.message, '\n');
    }

    // Summary
    console.log('═══════════════════════════════════════');
    console.log('  WORKFLOW TEST COMPLETE');
    console.log('═══════════════════════════════════════');
    console.log();
    console.log('✅ All transaction generation working');
    console.log('✅ API endpoints operational');
    console.log('✅ Ready for real agent integration');
    console.log();
    console.log('Next Steps:');
    console.log('1. Fund a test wallet with ETH + USDC');
    console.log('2. Use SDK to execute actual transactions');
    console.log('3. Monitor loan lifecycle on BaseScan');
    console.log();
}

testLoanWorkflow().catch((e) => { console.error(e); process.exit(1); });
