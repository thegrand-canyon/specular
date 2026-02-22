/**
 * Check Loan State in Detail
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🔍 CHECKING LOAN #1 STATE\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);

    const loanId = 1;
    const loan = await marketplace.loans(loanId);

    const states = ['REQUESTED', 'REJECTED', 'ACTIVE', 'REPAID', 'DEFAULTED'];

    console.log('Loan #1 Full Details:');
    console.log(`  Loan ID: ${loan.loanId}`);
    console.log(`  Borrower: ${loan.borrower}`);
    console.log(`  Agent ID: ${loan.agentId}`);
    console.log(`  Amount: ${ethers.formatUnits(loan.amount, 6)} USDC`);
    console.log(`  Collateral: ${ethers.formatUnits(loan.collateralAmount, 6)} USDC`);
    console.log(`  Interest Rate: ${Number(loan.interestRate) / 100}% APR`);
    console.log(`  Duration: ${Number(loan.duration) / (24 * 60 * 60)} days`);
    console.log(`  Start Time: ${new Date(Number(loan.startTime) * 1000).toLocaleString()}`);
    console.log(`  End Time: ${new Date(Number(loan.endTime) * 1000).toLocaleString()}`);
    console.log(`  State: ${states[loan.state]} (${loan.state})`);
    console.log('');

    if (loan.state === 2) {
        console.log('⚠️  Loan is still ACTIVE!');
        console.log('The repayment transaction may not have updated the state correctly.\n');

        // Check if we can see the Repaid event
        console.log('Checking for LoanRepaid events...\n');

        const filter = marketplace.filters.LoanRepaid(loanId);
        const events = await marketplace.queryFilter(filter, -10000);

        if (events.length > 0) {
            console.log(`✅ Found ${events.length} LoanRepaid event(s):`);
            events.forEach(event => {
                console.log(`  Block: ${event.blockNumber}`);
                console.log(`  Tx: ${event.transactionHash}`);
            });
        } else {
            console.log('❌ No LoanRepaid events found');
            console.log('This confirms the loan was NOT actually repaid\n');
        }
    } else if (loan.state === 3) {
        console.log('✅ Loan is REPAID');
    }
}

main().catch(console.error);
