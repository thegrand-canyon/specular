'use strict';
/**
 * Verify Collateral Transfer
 *
 * Check if collateral is actually transferred to contract or just approved
 */

require('dotenv').config();
const { ethers } = require('ethers');
const ADDRESSES = require('../config/arc-testnet-addresses.json');

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const BORROWER_KEY = process.env.PRIVATE_KEY;

const MKT_ABI = [
    'function requestLoan(uint256 amount, uint256 durationDays) returns (uint256)',
    'function repayLoan(uint256 loanId)',
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
    console.log('  COLLATERAL TRANSFER VERIFICATION');
    console.log('═'.repeat(80));

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const borrower = new ethers.Wallet(BORROWER_KEY, provider);

    const registry = new ethers.Contract(ADDRESSES.agentRegistryV2, REG_ABI, provider);
    const mkt = new ethers.Contract(ADDRESSES.agentLiquidityMarketplace, MKT_ABI, borrower);
    const usdc = new ethers.Contract(ADDRESSES.mockUSDC, ERC20_ABI, borrower);

    const borrowerId = await registry.addressToAgentId(borrower.address);

    console.log(`\nBorrower: ${borrower.address}`);
    console.log(`Agent ID: ${borrowerId}\n`);

    // Balances before
    const borrowerBalanceBefore = await usdc.balanceOf(borrower.address);
    const contractBalanceBefore = await usdc.balanceOf(ADDRESSES.agentLiquidityMarketplace);

    console.log('Before Loan Request:');
    console.log(`  Borrower USDC: ${ethers.formatUnits(borrowerBalanceBefore, 6)} USDC`);
    console.log(`  Contract USDC: ${ethers.formatUnits(contractBalanceBefore, 6)} USDC\n`);

    // Request loan
    const loanAmount = ethers.parseUnits('20', 6);
    const collateral = loanAmount; // 100% collateral

    console.log('Requesting Loan:');
    console.log(`  Loan amount: ${ethers.formatUnits(loanAmount, 6)} USDC`);
    console.log(`  Expected collateral: ${ethers.formatUnits(collateral, 6)} USDC\n`);

    // Approve
    console.log('Approving collateral...');
    const approveTx = await usdc.approve(ADDRESSES.agentLiquidityMarketplace, collateral * 2n);
    await approveTx.wait();
    console.log('  ✓ Approved\n');

    // Request
    console.log('Requesting loan...');
    const loanTx = await mkt.requestLoan(loanAmount, 7);
    const receipt = await loanTx.wait();

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

    console.log(`  ✓ Loan #${loanId} created\n`);

    // Balances after
    const borrowerBalanceAfter = await usdc.balanceOf(borrower.address);
    const contractBalanceAfter = await usdc.balanceOf(ADDRESSES.agentLiquidityMarketplace);

    console.log('After Loan Request:');
    console.log(`  Borrower USDC: ${ethers.formatUnits(borrowerBalanceAfter, 6)} USDC`);
    console.log(`  Contract USDC: ${ethers.formatUnits(contractBalanceAfter, 6)} USDC\n`);

    const borrowerChange = borrowerBalanceBefore - borrowerBalanceAfter;
    const contractChange = contractBalanceAfter - contractBalanceBefore;

    console.log('Changes:');
    console.log(`  Borrower balance change: ${ethers.formatUnits(borrowerChange, 6)} USDC`);
    console.log(`  Contract balance change: ${ethers.formatUnits(contractChange, 6)} USDC\n`);

    // Get loan details
    const loan = await mkt.loans(loanId);
    console.log('Loan Details:');
    console.log(`  Principal: ${ethers.formatUnits(loan.amount, 6)} USDC`);
    console.log(`  Collateral (on-chain): ${ethers.formatUnits(loan.collateralAmount, 6)} USDC`);
    console.log(`  State: ${['NONE', 'ACTIVE', 'REPAID', 'DEFAULTED'][loan.state]}\n`);

    // Analysis
    console.log('═'.repeat(80));
    console.log('ANALYSIS:');
    console.log('═'.repeat(80));

    const expectedCollateral = collateral;
    const actualBorrowerDeduction = borrowerChange;
    const actualContractIncrease = contractChange;

    if (actualBorrowerDeduction === expectedCollateral && actualContractIncrease === expectedCollateral) {
        console.log('\n✓ SECURE: Collateral properly transferred');
        console.log(`  - Borrower lost: ${ethers.formatUnits(actualBorrowerDeduction, 6)} USDC`);
        console.log(`  - Contract gained: ${ethers.formatUnits(actualContractIncrease, 6)} USDC`);
        console.log(`  - Matches expected: ${ethers.formatUnits(expectedCollateral, 6)} USDC`);
    } else if (actualBorrowerDeduction === 0n) {
        console.log('\n⚠ WARNING: No collateral transferred from borrower!');
        console.log(`  - Expected: ${ethers.formatUnits(expectedCollateral, 6)} USDC deduction`);
        console.log(`  - Actual: ${ethers.formatUnits(actualBorrowerDeduction, 6)} USDC deduction`);
        console.log(`  - Contract relies on allowance, not actual transfer`);

        if (actualContractIncrease > 0n) {
            console.log(`\n  Note: Contract balance increased by ${ethers.formatUnits(actualContractIncrease, 6)} USDC`);
            console.log(`  This might be the loan disbursement from pool liquidity`);
        }
    } else {
        console.log('\n⚠ MISMATCH: Collateral transfer mismatch');
        console.log(`  - Expected: ${ethers.formatUnits(expectedCollateral, 6)} USDC`);
        console.log(`  - Borrower deduction: ${ethers.formatUnits(actualBorrowerDeduction, 6)} USDC`);
        console.log(`  - Contract increase: ${ethers.formatUnits(actualContractIncrease, 6)} USDC`);
    }

    console.log('\n' + '═'.repeat(80) + '\n');

    // Check if we can withdraw the "approved" collateral
    console.log('Testing if collateral is truly locked:');
    console.log('  Attempting to transfer "locked" collateral to another address...\n');

    try {
        const testAmount = ethers.parseUnits('1', 6);
        const testTx = await usdc.transfer('0x0000000000000000000000000000000000000001', testAmount);
        await testTx.wait();

        console.log('  ⚠ WARNING: Could transfer funds that should be locked as collateral!');
        console.log('  This means collateral is NOT actually held by contract\n');
    } catch (err) {
        if (err.message.includes('insufficient')) {
            console.log('  ✓ SECURE: Cannot transfer - funds properly locked\n');
        } else {
            console.log(`  Error: ${err.message.slice(0, 100)}\n`);
        }
    }
}

main().catch(console.error);
