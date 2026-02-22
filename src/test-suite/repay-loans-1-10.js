'use strict';
/**
 * Repay Loans #1-10 for Agent #43
 */

require('dotenv').config();
const { ethers } = require('ethers');
const ADDRESSES = require('../config/arc-testnet-addresses.json');

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const AGENT_KEY = process.env.PRIVATE_KEY;

const MKT_ABI = [
    'function loans(uint256) view returns (uint256 loanId, address borrower, uint256 agentId, uint256 amount, uint256 collateralAmount, uint256 interestRate, uint256 startTime, uint256 endTime, uint256 duration, uint8 state)',
    'function repayLoan(uint256 loanId) returns (bool)',
    'function calculateInterest(uint256 principal, uint256 annualRateBPS, uint256 durationSeconds) view returns (uint256)'
];

const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)'
];

async function main() {
    console.log('\n' + '═'.repeat(60));
    console.log('  REPAYING LOANS #1-10');
    console.log('═'.repeat(60) + '\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const agent = new ethers.Wallet(AGENT_KEY, provider);

    const mkt = new ethers.Contract(ADDRESSES.agentLiquidityMarketplace, MKT_ABI, agent);
    const usdc = new ethers.Contract(ADDRESSES.mockUSDC, ERC20_ABI, agent);

    console.log(`Agent: ${agent.address}\n`);

    let repaidCount = 0;
    for (let loanId = 1; loanId <= 10; loanId++) {
        console.log(`\nLoan #${loanId}:`);

        try {
            // Get loan details
            const loan = await mkt.loans(loanId);

            // Calculate interest
            const interest = await mkt.calculateInterest(loan.amount, loan.interestRate, loan.duration);
            const totalRepayment = loan.amount + interest;

            console.log(`  Principal: ${ethers.formatUnits(loan.amount, 6)} USDC`);
            console.log(`  Interest: ${ethers.formatUnits(interest, 6)} USDC (${Number(loan.interestRate) / 100}% APR)`);
            console.log(`  Total: ${ethers.formatUnits(totalRepayment, 6)} USDC`);

            // Approve USDC
            console.log(`  Approving USDC...`);
            const approveTx = await usdc.approve(ADDRESSES.agentLiquidityMarketplace, totalRepayment);
            await approveTx.wait();

            // Repay loan
            console.log(`  Repaying...`);
            const repayTx = await mkt.repayLoan(loanId);
            const receipt = await repayTx.wait();
            console.log(`  ✓ Repaid! (Block ${receipt.blockNumber})`);

            repaidCount++;

            // Delay between repayments
            await new Promise(r => setTimeout(r, 1000));

        } catch (err) {
            console.log(`  ✗ FAILED: ${err.message.slice(0, 80)}`);
        }
    }

    console.log('\n' + '═'.repeat(60));
    console.log(`  COMPLETE: ${repaidCount}/10 loans repaid`);
    console.log('═'.repeat(60) + '\n');
}

main().catch(console.error);
