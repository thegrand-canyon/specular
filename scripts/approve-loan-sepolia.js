/**
 * Approve a Loan on Sepolia (Pool Manager Only)
 *
 * This script approves a pending loan request.
 * Only the lending pool owner can run this.
 *
 * Usage: npx hardhat run scripts/approve-loan-sepolia.js --network sepolia
 */

const { ethers } = require('hardhat');

const SEPOLIA_LENDING_POOL = '0x5592A6d7bF1816f77074b62911D50Dad92A3212b';

async function main() {
    console.log('\n✅ Approving Loan on Sepolia\n');

    const [signer] = await ethers.getSigners();
    console.log('Pool Manager:', signer.address);

    // Get contract instance
    const lendingPool = await ethers.getContractAt('LendingPoolV2', SEPOLIA_LENDING_POOL);

    // Get owner
    const owner = await lendingPool.owner();
    if (signer.address.toLowerCase() !== owner.toLowerCase()) {
        console.log('❌ Error: Only the pool owner can approve loans');
        console.log('Owner:', owner);
        console.log('Your address:', signer.address);
        process.exit(1);
    }

    // Find pending loans
    console.log('📋 Pending Loan Requests:\n');

    const loanCount = await lendingPool.nextLoanId();
    let pendingLoans = [];

    for (let i = 1n; i < loanCount; i++) {
        const loan = await lendingPool.loans(i);
        if (loan.state === 0) { // REQUESTED (0=REQUESTED, 1=APPROVED, 2=ACTIVE)
            pendingLoans.push({
                id: i,
                borrower: loan.borrower,
                amount: loan.amount,
                interestRate: loan.interestRate,
                durationDays: loan.durationDays,
                collateralAmount: loan.collateralAmount
            });

            console.log(`Loan #${i}:`);
            console.log('  Borrower:', loan.borrower);
            console.log('  Amount:', ethers.formatUnits(loan.amount, 6), 'USDC');
            console.log('  Interest Rate:', (Number(loan.interestRate) / 100).toFixed(2), '% APR');
            console.log('  Duration:', loan.durationDays.toString(), 'days');
            console.log('  Collateral:', ethers.formatUnits(loan.collateralAmount, 6), 'USDC');
            console.log('');
        }
    }

    if (pendingLoans.length === 0) {
        console.log('No pending loan requests\n');
        process.exit(0);
    }

    // Approve the first pending loan (you can modify this)
    const loanToApprove = pendingLoans[0].id;

    console.log(`\n⏳ Approving Loan #${loanToApprove}...`);

    const approveTx = await lendingPool.approveLoan(loanToApprove);
    console.log('Transaction hash:', approveTx.hash);
    await approveTx.wait();

    console.log('✅ Loan approved successfully!');

    // Get updated loan status
    const loan = await lendingPool.loans(loanToApprove);
    console.log('\n📋 Updated Loan Status:');
    console.log('  Status: ACTIVE');
    console.log('  Start Time:', new Date(Number(loan.startTime) * 1000).toLocaleString());
    console.log('  Due Date:', new Date(Number(loan.endTime) * 1000).toLocaleString());

    console.log('\n💡 The borrower can now:');
    console.log('1. Use the borrowed USDC');
    console.log('2. Repay before the due date to improve reputation\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
