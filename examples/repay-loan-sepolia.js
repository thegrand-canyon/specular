/**
 * Repay a Loan on Sepolia
 *
 * This example shows how to repay an active loan.
 * Repaying on time improves your reputation score!
 *
 * Prerequisites:
 * - Active loan
 * - Sufficient USDC to cover principal + interest
 *
 * Usage: npx hardhat run examples/repay-loan-sepolia.js --network sepolia
 */

const { ethers } = require('hardhat');

const SEPOLIA_ADDRESSES = {
    mockUSDC: '0x771c293167AeD146EC4f56479056645Be46a0275',
    lendingPool: '0x5592A6d7bF1816f77074b62911D50Dad92A3212b',
    reputationManager: '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF'
};

async function main() {
    console.log('\n💸 Repaying Loan on Sepolia\n');

    const [signer] = await ethers.getSigners();
    console.log('Agent:', signer.address);

    // Get contract instances
    const lendingPool = await ethers.getContractAt('LendingPoolV2', SEPOLIA_ADDRESSES.lendingPool);
    const usdc = await ethers.getContractAt('MockUSDC', SEPOLIA_ADDRESSES.mockUSDC);
    const reputationManager = await ethers.getContractAt('ReputationManagerV2', SEPOLIA_ADDRESSES.reputationManager);

    // Find active loans for this agent
    console.log('📋 Your Active Loans:\n');

    const loanCount = await lendingPool.nextLoanId();
    let activeLoans = [];

    for (let i = 1n; i < loanCount; i++) {
        const loan = await lendingPool.loans(i);
        if (loan.borrower === signer.address && loan.state === 2) { // ACTIVE (0=REQUESTED, 1=APPROVED, 2=ACTIVE)
            const interest = await lendingPool.calculateInterest(loan.amount, loan.interestRate, loan.durationDays);
            const totalOwed = loan.amount + interest;
            const dueDate = new Date(Number(loan.endTime) * 1000);
            const isOverdue = Date.now() > dueDate.getTime();

            activeLoans.push({
                id: i,
                amount: loan.amount,
                totalOwed,
                dueDate,
                isOverdue
            });

            console.log(`Loan #${i}:`);
            console.log('  Principal:', ethers.formatUnits(loan.amount, 6), 'USDC');
            console.log('  Total Owed:', ethers.formatUnits(totalOwed, 6), 'USDC');
            console.log('  Due Date:', dueDate.toLocaleString());
            console.log('  Status:', isOverdue ? '🔴 OVERDUE' : '🟢 On Time');
            console.log('');
        }
    }

    if (activeLoans.length === 0) {
        console.log('No active loans to repay\n');
        process.exit(0);
    }

    // Repay the first active loan
    const loanToRepay = activeLoans[0];
    const loanId = loanToRepay.id;

    console.log(`\n💰 Repaying Loan #${loanId}...`);
    console.log('Amount to repay:', ethers.formatUnits(loanToRepay.totalOwed, 6), 'USDC');

    // Check USDC balance
    const balance = await usdc.balanceOf(signer.address);
    console.log('Your USDC balance:', ethers.formatUnits(balance, 6), 'USDC');

    if (balance < loanToRepay.totalOwed) {
        console.log('\n❌ Error: Insufficient USDC balance');
        console.log('You need:', ethers.formatUnits(loanToRepay.totalOwed, 6), 'USDC');
        console.log('You have:', ethers.formatUnits(balance, 6), 'USDC');
        console.log('\nMint more USDC with:');
        console.log('  npx hardhat run scripts/mint-usdc-sepolia.js --network sepolia');
        process.exit(1);
    }

    // Get reputation before repayment
    const reputationBefore = await reputationManager['getReputationScore(address)'](signer.address);
    console.log('\n📊 Current Reputation:', reputationBefore.toString());

    // Approve USDC
    console.log('\n⏳ Step 1: Approving USDC...');
    const approveTx = await usdc.approve(SEPOLIA_ADDRESSES.lendingPool, loanToRepay.totalOwed);
    await approveTx.wait();
    console.log('✅ Approved');

    // Repay loan
    console.log('\n⏳ Step 2: Repaying loan...');
    const repayTx = await lendingPool.repayLoan(loanId);
    console.log('Transaction hash:', repayTx.hash);
    await repayTx.wait();

    console.log('✅ Loan repaid successfully!');

    // Check reputation after repayment
    const reputationAfter = await reputationManager['getReputationScore(address)'](signer.address);
    const reputationChange = reputationAfter - reputationBefore;

    console.log('\n📈 Reputation Updated:');
    console.log('  Before:', reputationBefore.toString());
    console.log('  After:', reputationAfter.toString());
    console.log('  Change:', reputationChange > 0n ? '+' + reputationChange.toString() : reputationChange.toString());

    if (loanToRepay.isOverdue) {
        console.log('\n⚠️  This loan was repaid late. Your reputation decreased.');
    } else {
        console.log('\n🎉 Great job! You repaid on time and improved your reputation!');
    }

    // Show updated credit limit
    const newCreditLimit = await reputationManager['calculateCreditLimit(address)'](signer.address);

    console.log('\n💳 Updated Credit Terms:');
    console.log('  Credit Limit:', ethers.formatUnits(newCreditLimit, 6), 'USDC');

    // Check if collateral was returned
    const loan = await lendingPool.loans(loanId);
    if (loan.collateralAmount > 0n) {
        console.log('\n✅ Collateral of', ethers.formatUnits(loan.collateralAmount, 6), 'USDC returned');
    }

    console.log('\n💡 Your improved reputation allows you to:');
    console.log('  • Request larger loans');
    console.log('  • Get lower interest rates');
    console.log('  • Reduce collateral requirements\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
