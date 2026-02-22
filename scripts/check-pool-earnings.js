/**
 * Check Pool Earnings and Withdraw Fees
 *
 * This script helps pool owners:
 * 1. See total pool value
 * 2. Calculate accumulated interest/fees
 * 3. Withdraw earnings
 *
 * Usage: npx hardhat run scripts/check-pool-earnings.js --network sepolia
 */

const { ethers } = require('hardhat');

const SEPOLIA_LENDING_POOL = '0x5592A6d7bF1816f77074b62911D50Dad92A3212b';

async function main() {
    console.log('\n💰 Pool Earnings Dashboard\n');

    const [signer] = await ethers.getSigners();
    console.log('Your address:', signer.address);

    // Get contract instance
    const lendingPool = await ethers.getContractAt('LendingPoolV2', SEPOLIA_LENDING_POOL);

    // Check if you're the owner
    const owner = await lendingPool.owner();
    if (signer.address.toLowerCase() !== owner.toLowerCase()) {
        console.log('\n❌ Error: You are not the pool owner');
        console.log('Pool owner:', owner);
        console.log('\nOnly the pool owner can withdraw fees.');
        process.exit(1);
    }

    console.log('✅ Verified: You are the pool owner\n');

    // Get pool stats
    const totalLiquidity = await lendingPool.totalLiquidity();
    const availableLiquidity = await lendingPool.availableLiquidity();
    const totalLoaned = await lendingPool.totalLoaned();

    console.log('📊 Pool Statistics:');
    console.log('─────────────────────────────────────');
    console.log('Total Liquidity:     ', ethers.formatUnits(totalLiquidity, 6), 'USDC');
    console.log('Available Liquidity: ', ethers.formatUnits(availableLiquidity, 6), 'USDC');
    console.log('Currently Loaned:    ', ethers.formatUnits(totalLoaned, 6), 'USDC');

    // Calculate earnings
    // Earnings = Available Liquidity - (Total Liquidity - Total Loaned)
    // This represents interest that has been paid back
    const theoreticalAvailable = totalLiquidity - totalLoaned;
    const accumulatedFees = availableLiquidity > theoreticalAvailable
        ? availableLiquidity - theoreticalAvailable
        : 0n;

    console.log('\n💵 Earnings Analysis:');
    console.log('─────────────────────────────────────');
    console.log('Expected Available:  ', ethers.formatUnits(theoreticalAvailable, 6), 'USDC');
    console.log('Actual Available:    ', ethers.formatUnits(availableLiquidity, 6), 'USDC');
    console.log('Accumulated Fees:    ', ethers.formatUnits(accumulatedFees, 6), 'USDC');

    if (accumulatedFees > 0n) {
        console.log('\n🎉 You have earned', ethers.formatUnits(accumulatedFees, 6), 'USDC in interest!');
    } else {
        console.log('\nℹ️  No accumulated fees yet (all loans still outstanding)');
    }

    // Show all loans and their status
    console.log('\n📋 Loan Portfolio:');
    console.log('─────────────────────────────────────');

    const nextLoanId = await lendingPool.nextLoanId();
    let activeLoanCount = 0;
    let repaidLoanCount = 0;
    let totalInterestEarned = 0n;

    for (let i = 1n; i < nextLoanId; i++) {
        const loan = await lendingPool.loans(i);

        if (loan.state === 3) { // REPAID
            repaidLoanCount++;
            const interest = await lendingPool.calculateInterest(
                loan.amount,
                loan.interestRate,
                loan.durationDays
            );
            totalInterestEarned += interest;

            console.log(`\nLoan #${i} - REPAID ✅`);
            console.log('  Borrower:', loan.borrower);
            console.log('  Amount:', ethers.formatUnits(loan.amount, 6), 'USDC');
            console.log('  Interest Earned:', ethers.formatUnits(interest, 6), 'USDC');
            console.log('  Rate:', (Number(loan.interestRate) / 100).toFixed(2), '% APR');
        } else if (loan.state === 2) { // ACTIVE
            activeLoanCount++;
            const interest = await lendingPool.calculateInterest(
                loan.amount,
                loan.interestRate,
                loan.durationDays
            );

            console.log(`\nLoan #${i} - ACTIVE 🔄`);
            console.log('  Borrower:', loan.borrower);
            console.log('  Amount:', ethers.formatUnits(loan.amount, 6), 'USDC');
            console.log('  Expected Interest:', ethers.formatUnits(interest, 6), 'USDC');
            console.log('  Rate:', (Number(loan.interestRate) / 100).toFixed(2), '% APR');
            console.log('  Due:', new Date(Number(loan.endTime) * 1000).toLocaleString());
        }
    }

    console.log('\n📈 Summary:');
    console.log('─────────────────────────────────────');
    console.log('Active Loans:', activeLoanCount);
    console.log('Repaid Loans:', repaidLoanCount);
    console.log('Total Interest Earned:', ethers.formatUnits(totalInterestEarned, 6), 'USDC');

    // Withdrawal options
    if (availableLiquidity > 0n) {
        console.log('\n💸 Withdrawal Options:');
        console.log('─────────────────────────────────────');
        console.log('You can withdraw up to', ethers.formatUnits(availableLiquidity, 6), 'USDC');

        if (accumulatedFees > 0n) {
            console.log('\n💡 Recommended: Withdraw just the fees to keep pool operational');
            console.log('   Withdraw amount:', ethers.formatUnits(accumulatedFees, 6), 'USDC');
            console.log('\n   Command:');
            console.log(`   npx hardhat run scripts/withdraw-fees.js --network sepolia -- ${ethers.formatUnits(accumulatedFees, 6)}`);
        }

        console.log('\n⚠️  Warning: Withdrawing too much may prevent new loans from being approved');
        console.log('   Keep enough liquidity for active lending operations');
    }

    console.log('\n✅ Done!\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
