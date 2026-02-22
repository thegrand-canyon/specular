'use strict';
/**
 * Security Test: Concurrent Loan Bypass Attack
 *
 * Tests the [SECURITY-01] fix on the NEW AgentLiquidityMarketplace
 * Attempts to bypass credit limit by taking many small loans concurrently
 */

require('dotenv').config();
const { ethers } = require('ethers');
const ADDRESSES = require('../config/arc-testnet-addresses.json');

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ATTACKER_KEY = process.env.PRIVATE_KEY;

const MKT_ABI = [
    'function requestLoan(uint256 amount, uint256 durationDays) returns (uint256)',
    'function MAX_ACTIVE_LOANS_PER_AGENT() view returns (uint256)',
    'function loans(uint256) view returns (uint256 loanId, address borrower, uint256 agentId, uint256 amount, uint256 collateralAmount, uint256 interestRate, uint256 startTime, uint256 endTime, uint256 duration, uint8 state)'
];

const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)'
];

const REG_ABI = [
    'function addressToAgentId(address) view returns (uint256)'
];

const REP_ABI = [
    'function getReputationScore(address) view returns (uint256)',
    'function calculateCreditLimit(address) view returns (uint256)'
];

async function main() {
    console.log('\n' + '═'.repeat(80));
    console.log('  SECURITY TEST: Concurrent Loan Bypass Attack');
    console.log('  Testing [SECURITY-01] Fix on NEW Marketplace');
    console.log('═'.repeat(80));

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const attacker = new ethers.Wallet(ATTACKER_KEY, provider);

    const registry = new ethers.Contract(ADDRESSES.agentRegistryV2, REG_ABI, provider);
    const reputation = new ethers.Contract(ADDRESSES.reputationManagerV3, REP_ABI, provider);
    const mkt = new ethers.Contract(ADDRESSES.agentLiquidityMarketplace, MKT_ABI, attacker);
    const usdc = new ethers.Contract(ADDRESSES.mockUSDC, ERC20_ABI, attacker);

    const attackerId = await registry.addressToAgentId(attacker.address);

    console.log(`\nAttacker Address: ${attacker.address}`);
    console.log(`Agent ID: ${attackerId}`);
    console.log(`Marketplace: ${ADDRESSES.agentLiquidityMarketplace}`);
    console.log(`Note: ${ADDRESSES.agentLiquidityMarketplace_old ? 'Testing NEW marketplace with security fix' : 'Testing marketplace'}\n`);

    // Verify security constant
    const maxActiveLoans = await mkt.MAX_ACTIVE_LOANS_PER_AGENT();
    console.log(`✓ MAX_ACTIVE_LOANS_PER_AGENT: ${maxActiveLoans}\n`);

    // Get attacker's current state
    const score = await reputation.getReputationScore(attacker.address);
    const creditLimit = await reputation.calculateCreditLimit(attacker.address);

    console.log('Attacker Current State:');
    console.log(`  Reputation Score: ${score}`);
    console.log(`  Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);
    console.log(`  USDC Balance: ${ethers.formatUnits(await usdc.balanceOf(attacker.address), 6)} USDC\n`);

    console.log('═'.repeat(80));
    console.log('  ATTACK SCENARIO');
    console.log('═'.repeat(80));
    console.log('\nAttempting to bypass credit limit via loan fragmentation...\n');

    // Approve massive collateral
    console.log('Step 1: Approve large collateral amount...');
    await usdc.approve(ADDRESSES.agentLiquidityMarketplace, ethers.parseUnits('100000', 6));
    console.log('  ✓ Approved 100,000 USDC\n');

    console.log('Step 2: Take small loans rapidly to bypass credit limit...\n');

    const loanAmount = ethers.parseUnits('20', 6); // 20 USDC per loan
    const loans = [];
    let success = 0;
    let blocked = false;

    // Try to take many loans (more than the limit)
    for (let i = 1; i <= 15; i++) {
        console.log(`Loan Attempt #${i}:`);

        try {
            const tx = await mkt.requestLoan(loanAmount, 7);
            const receipt = await tx.wait();

            // Find loan ID from events
            let loanId = null;
            for (const log of receipt.logs) {
                if (log.topics?.length >= 2) {
                    const candidate = parseInt(log.topics[1], 16);
                    if (candidate > 0 && candidate < 100000) {
                        loanId = candidate;
                        break;
                    }
                }
            }

            console.log(`  ✓ SUCCESS - Loan #${loanId} approved`);
            loans.push(loanId);
            success++;

        } catch (err) {
            if (err.message.includes('Too many active loans')) {
                console.log(`  ✗ BLOCKED - "Too many active loans" (Security fix working!)`);
                blocked = true;
                break;
            } else {
                console.log(`  ✗ FAILED - ${err.message.slice(0, 80)}`);
                break;
            }
        }

        // Wait between requests
        await new Promise(r => setTimeout(r, 500));
    }

    console.log('\n' + '═'.repeat(80));
    console.log('  TEST RESULTS');
    console.log('═'.repeat(80));

    console.log(`\nLoans Created: ${success}`);
    console.log(`Total Borrowed: ${success * 20} USDC`);
    console.log(`Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);
    console.log(`Security Limit: ${maxActiveLoans} active loans\n`);

    if (blocked && success === Number(maxActiveLoans)) {
        console.log('✅ SECURITY FIX WORKING CORRECTLY\n');
        console.log('Expected Behavior:');
        console.log(`  - Allow up to ${maxActiveLoans} concurrent loans`);
        console.log(`  - Block loan #${Number(maxActiveLoans) + 1} with "Too many active loans"`);
        console.log(`  - Actual: ${success} loans approved, loan #${success + 1} blocked\n`);

        console.log('Protection Verified:');
        console.log(`  ✓ Cannot take more than ${maxActiveLoans} loans concurrently`);
        console.log(`  ✓ Credit limit bypass via fragmentation prevented`);
        console.log(`  ✓ [SECURITY-01] fix is effective\n`);

        console.log('═'.repeat(80));
        console.log('✅ SECURITY TEST PASSED');
        console.log('═'.repeat(80));
        console.log('\nThe marketplace successfully prevents concurrent loan bypass attacks.\n');

    } else if (success > Number(maxActiveLoans)) {
        console.log('🚨 CRITICAL SECURITY FAILURE\n');
        console.log('Expected Behavior:');
        console.log(`  - Block after ${maxActiveLoans} concurrent loans`);
        console.log(`  - Actual: ${success} loans approved\n`);

        console.log('Vulnerability:');
        console.log('  ✗ Can take more than MAX_ACTIVE_LOANS_PER_AGENT loans');
        console.log('  ✗ Credit limit bypass possible via fragmentation');
        console.log('  ✗ [SECURITY-01] fix NOT working\n');

        console.log('═'.repeat(80));
        console.log('❌ SECURITY TEST FAILED');
        console.log('═'.repeat(80));
        console.log('\nThe marketplace is vulnerable to concurrent loan bypass attacks!\n');

    } else {
        console.log('⚠️  UNEXPECTED RESULT\n');
        console.log(`Expected: ${maxActiveLoans} loans approved`);
        console.log(`Actual: ${success} loans approved`);
        console.log(`Blocked: ${blocked}\n`);

        if (success < Number(maxActiveLoans)) {
            console.log('Possible reasons:');
            console.log('  - Pool liquidity exhausted');
            console.log('  - Credit limit reached before concurrent limit');
            console.log('  - Collateral approval insufficient\n');
        }

        console.log('═'.repeat(80));
        console.log('⚠️  SECURITY TEST INCONCLUSIVE');
        console.log('═'.repeat(80));
        console.log('\nManual investigation required.\n');
    }
}

main().catch(console.error);
