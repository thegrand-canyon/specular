'use strict';
/**
 * Repay All Active Loans for an Agent
 */

require('dotenv').config();
const { ethers } = require('ethers');
const ADDRESSES = require('../config/arc-testnet-addresses.json');

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const AGENT_KEY = process.env.PRIVATE_KEY;

const MKT_ABI = [
    'function agentLoans(address, uint256) view returns (uint256)',
    'function loans(uint256) view returns (uint256 loanId, address borrower, uint256 agentId, uint256 amount, uint256 collateralAmount, uint256 interestRate, uint256 startTime, uint256 endTime, uint256 duration, uint8 state)',
    'function repayLoan(uint256 loanId) returns (bool)',
    'function calculateRepaymentAmount(uint256 loanId) view returns (uint256)'
];

const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)'
];

const REG_ABI = [
    'function addressToAgentId(address) view returns (uint256)'
];

async function main() {
    console.log('\n' + '═'.repeat(60));
    console.log('  REPAYING ALL ACTIVE LOANS');
    console.log('═'.repeat(60));

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const agent = new ethers.Wallet(AGENT_KEY, provider);

    const registry = new ethers.Contract(ADDRESSES.agentRegistryV2, REG_ABI, provider);
    const mkt = new ethers.Contract(ADDRESSES.agentLiquidityMarketplace, MKT_ABI, agent);
    const usdc = new ethers.Contract(ADDRESSES.mockUSDC, ERC20_ABI, agent);

    const agentId = await registry.addressToAgentId(agent.address);
    console.log(`\nAgent: ${agent.address}`);
    console.log(`Agent ID: ${agentId}\n`);

    // Find all loans for this agent
    console.log(`Finding loans for agent...\n`);

    const allLoanIds = [];
    let index = 0;
    while (true) {
        try {
            const loanId = await mkt.agentLoans(agent.address, index);
            if (loanId == 0) break;
            allLoanIds.push(Number(loanId));
            index++;
        } catch (err) {
            break;
        }
        await new Promise(r => setTimeout(r, 50));
    }

    console.log(`Found ${allLoanIds.length} total loans\n`);

    // Filter for active loans
    const activeLoans = [];
    for (const loanId of allLoanIds) {
        const loan = await mkt.loans(loanId);
        // State 1 = ACTIVE
        if (loan.state === 1) {
            activeLoans.push({
                loanId: Number(loan.loanId),
                amount: loan.amount,
                interestRate: loan.interestRate
            });
        }
        await new Promise(r => setTimeout(r, 50));
    }

    console.log(`Found ${activeLoans.length} active loans:\n`);
    activeLoans.forEach(loan => {
        console.log(`  Loan #${loan.loanId}: ${ethers.formatUnits(loan.amount, 6)} USDC at ${loan.interestRate / 100}% APR`);
    });

    if (activeLoans.length === 0) {
        console.log('\nNo active loans to repay!\n');
        return;
    }

    console.log('\n' + '─'.repeat(60));
    console.log('  REPAYING LOANS');
    console.log('─'.repeat(60) + '\n');

    let repaidCount = 0;
    for (const loan of activeLoans) {
        console.log(`Repaying Loan #${loan.loanId}...`);

        try {
            // Calculate repayment amount
            const repayAmount = await mkt.calculateRepaymentAmount(loan.loanId);
            console.log(`  Repayment: ${ethers.formatUnits(repayAmount, 6)} USDC`);

            // Approve USDC
            console.log(`  Approving USDC...`);
            const approveTx = await usdc.approve(ADDRESSES.agentLiquidityMarketplace, repayAmount);
            await approveTx.wait();

            // Repay loan
            console.log(`  Repaying...`);
            const repayTx = await mkt.repayLoan(loan.loanId);
            const receipt = await repayTx.wait();
            console.log(`  ✓ Repaid! (tx: ${receipt.hash})\n`);

            repaidCount++;

            // Delay between repayments
            await new Promise(r => setTimeout(r, 1000));

        } catch (err) {
            console.log(`  ✗ FAILED: ${err.message.slice(0, 80)}\n`);
        }
    }

    console.log('═'.repeat(60));
    console.log(`  COMPLETE: ${repaidCount}/${activeLoans.length} loans repaid`);
    console.log('═'.repeat(60) + '\n');
}

main().catch(console.error);
