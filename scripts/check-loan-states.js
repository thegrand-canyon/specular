/**
 * Check Loan States
 * Debug script to see actual loan states
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    const [signer] = await ethers.getSigners();
    console.log('\n📋 Checking Loan States\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const lendingPool = await ethers.getContractAt('LendingPoolV3', addresses.lendingPool);

    const nextLoanId = await lendingPool.nextLoanId();
    console.log('Next Loan ID:', nextLoanId.toString());
    console.log('Checking loans 0 to', (nextLoanId - 1n).toString(), '\n');

    const states = ['REQUESTED', 'APPROVED', 'ACTIVE', 'REPAID', 'DEFAULTED'];

    for (let i = 0; i < nextLoanId; i++) {
        try {
            const loan = await lendingPool.loans(i);
            const isMine = loan.borrower.toLowerCase() === signer.address.toLowerCase();

            console.log(`Loan ${i}:`);
            console.log('  Borrower:', loan.borrower, isMine ? '(YOU)' : '');
            console.log('  Amount:', ethers.formatUnits(loan.amount, 6), 'USDC');
            console.log('  State:', states[loan.state], `(${loan.state})`);
            console.log('  Interest Rate:', (Number(loan.interestRate) / 100).toFixed(2), '% APR');
            console.log('  Duration:', loan.durationDays.toString(), 'days');
            console.log('');
        } catch (error) {
            console.log(`Loan ${i}: Error -`, error.message.split('\n')[0]);
        }
    }

    // Check pool stats
    const totalLoaned = await lendingPool.totalLoaned();
    const availableLiquidity = await lendingPool.availableLiquidity();
    const totalLiquidity = await lendingPool.totalLiquidity();

    console.log('Pool Statistics:');
    console.log('  Total Loaned:', ethers.formatUnits(totalLoaned, 6), 'USDC');
    console.log('  Available Liquidity:', ethers.formatUnits(availableLiquidity, 6), 'USDC');
    console.log('  Total Liquidity:', ethers.formatUnits(totalLiquidity, 6), 'USDC');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
