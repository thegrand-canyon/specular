/**
 * Test Complete Loan Cycle
 *
 * This script tests the complete loan lifecycle with Agent #1:
 * 1. Request a loan
 * 2. Approve the loan (as pool owner)
 * 3. Repay the loan
 * 4. Show reputation improvement and fees earned
 *
 * Usage: npx hardhat run scripts/test-loan-cycle.js --network sepolia
 */

const { ethers } = require('hardhat');

const SEPOLIA_ADDRESSES = {
    reputationManager: '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF',
    lendingPool: '0x5592A6d7bF1816f77074b62911D50Dad92A3212b',
    mockUSDC: '0x771c293167AeD146EC4f56479056645Be46a0275'
};

async function main() {
    console.log('\n🧪 Testing Complete Loan Cycle\n');
    console.log('═════════════════════════════════════\n');

    const [signer] = await ethers.getSigners();
    console.log('Agent/Pool Owner:', signer.address);

    // Get contracts
    const lendingPool = await ethers.getContractAt('LendingPoolV2', SEPOLIA_ADDRESSES.lendingPool);
    const reputationManager = await ethers.getContractAt('ReputationManagerV2', SEPOLIA_ADDRESSES.reputationManager);
    const usdc = await ethers.getContractAt('MockUSDC', SEPOLIA_ADDRESSES.mockUSDC);

    // Check initial state
    console.log('📊 Initial State:');
    console.log('─────────────────────────────────────');

    const reputation = await reputationManager['getReputationScore(address)'](signer.address);
    const creditLimit = await reputationManager['calculateCreditLimit(address)'](signer.address);
    const collateralRequired = await reputationManager['calculateCollateralRequirement(address)'](signer.address);
    const poolLiquidity = await lendingPool.availableLiquidity();
    const usdcBalance = await usdc.balanceOf(signer.address);

    console.log('Reputation:', reputation.toString());
    console.log('Credit Limit:', ethers.formatUnits(creditLimit, 6), 'USDC');
    console.log('Collateral Required:', collateralRequired.toString(), '%');
    console.log('Pool Liquidity:', ethers.formatUnits(poolLiquidity, 6), 'USDC');
    console.log('Your USDC Balance:', ethers.formatUnits(usdcBalance, 6), 'USDC');

    // Step 1: Request Loan
    console.log('\n\n📝 STEP 1: REQUEST LOAN');
    console.log('═════════════════════════════════════\n');

    const loanAmount = ethers.parseUnits('500', 6); // 500 USDC
    const duration = 30; // 30 days

    console.log('Requesting:', ethers.formatUnits(loanAmount, 6), 'USDC');
    console.log('Duration:', duration, 'days\n');

    // Approve collateral if needed
    if (collateralRequired > 0n) {
        const collateralAmount = (loanAmount * collateralRequired) / 100n;
        console.log('⏳ Approving collateral:', ethers.formatUnits(collateralAmount, 6), 'USDC...');
        const approveTx = await usdc.approve(SEPOLIA_ADDRESSES.lendingPool, collateralAmount);
        await approveTx.wait();
        console.log('✅ Collateral approved\n');
    }

    console.log('⏳ Requesting loan...');
    const requestTx = await lendingPool.requestLoan(loanAmount, duration);
    const receipt = await requestTx.wait();

    // Get loan ID
    const event = receipt.logs.find(log => {
        try {
            return lendingPool.interface.parseLog(log)?.name === 'LoanRequested';
        } catch {
            return false;
        }
    });

    const loanId = lendingPool.interface.parseLog(event).args.loanId;
    console.log('✅ Loan requested! Loan ID:', loanId.toString());
    console.log('Transaction:', receipt.hash);

    // Step 2: Approve Loan
    console.log('\n\n💰 STEP 2: APPROVE LOAN (as Pool Owner)');
    console.log('═════════════════════════════════════\n');

    console.log('⏳ Approving loan #' + loanId.toString() + '...');
    const approveTx = await lendingPool.approveLoan(loanId);
    await approveTx.wait();
    console.log('✅ Loan approved!');

    const loan = await lendingPool.loans(loanId);
    const interest = await lendingPool.calculateInterest(loan.amount, loan.interestRate, loan.durationDays);
    const totalRepayment = loan.amount + interest;

    console.log('\n📋 Loan Details:');
    console.log('  Principal:', ethers.formatUnits(loan.amount, 6), 'USDC');
    console.log('  Interest Rate:', (Number(loan.interestRate) / 100).toFixed(2), '% APR');
    console.log('  Interest Amount:', ethers.formatUnits(interest, 6), 'USDC');
    console.log('  Total Repayment:', ethers.formatUnits(totalRepayment, 6), 'USDC');
    console.log('  Due Date:', new Date(Number(loan.endTime) * 1000).toLocaleString());

    // Check USDC received
    const usdcBalanceAfterLoan = await usdc.balanceOf(signer.address);
    console.log('\n💵 Your USDC Balance:', ethers.formatUnits(usdcBalanceAfterLoan, 6), 'USDC');
    console.log('   (Received:', ethers.formatUnits(usdcBalanceAfterLoan - usdcBalance, 6), 'USDC)');

    // Step 3: Repay Loan
    console.log('\n\n💸 STEP 3: REPAY LOAN');
    console.log('═════════════════════════════════════\n');

    const repBefore = await reputationManager['getReputationScore(address)'](signer.address);
    console.log('Current Reputation:', repBefore.toString());
    console.log('Amount to repay:', ethers.formatUnits(totalRepayment, 6), 'USDC\n');

    console.log('⏳ Approving USDC for repayment...');
    const approveRepayTx = await usdc.approve(SEPOLIA_ADDRESSES.lendingPool, totalRepayment);
    await approveRepayTx.wait();
    console.log('✅ Approved\n');

    console.log('⏳ Repaying loan...');
    const repayTx = await lendingPool.repayLoan(loanId);
    await repayTx.wait();
    console.log('✅ Loan repaid!');

    // Check reputation change
    const repAfter = await reputationManager['getReputationScore(address)'](signer.address);
    const repChange = repAfter - repBefore;

    console.log('\n📈 Reputation Update:');
    console.log('  Before:', repBefore.toString());
    console.log('  After:', repAfter.toString());
    console.log('  Change:', repChange > 0n ? '+' : '', repChange.toString());

    // New credit limit
    const newCreditLimit = await reputationManager['calculateCreditLimit(address)'](signer.address);
    console.log('\n💳 New Credit Limit:', ethers.formatUnits(newCreditLimit, 6), 'USDC');
    console.log('   (Increased by:', ethers.formatUnits(newCreditLimit - creditLimit, 6), 'USDC)');

    // Step 4: Check Pool Earnings
    console.log('\n\n💰 STEP 4: POOL EARNINGS');
    console.log('═════════════════════════════════════\n');

    const finalLiquidity = await lendingPool.availableLiquidity();
    const feesEarned = finalLiquidity - poolLiquidity;

    console.log('Pool Liquidity:');
    console.log('  Before:', ethers.formatUnits(poolLiquidity, 6), 'USDC');
    console.log('  After:', ethers.formatUnits(finalLiquidity, 6), 'USDC');
    console.log('  Fees Earned:', ethers.formatUnits(feesEarned, 6), 'USDC 🎉\n');

    // Summary
    console.log('\n═════════════════════════════════════');
    console.log('✅ LOAN CYCLE COMPLETE!');
    console.log('═════════════════════════════════════\n');

    console.log('Summary:');
    console.log('  ✅ Agent borrowed', ethers.formatUnits(loanAmount, 6), 'USDC');
    console.log('  ✅ Agent repaid', ethers.formatUnits(totalRepayment, 6), 'USDC');
    console.log('  ✅ Agent reputation increased by', repChange.toString(), 'points');
    console.log('  ✅ Pool earned', ethers.formatUnits(interest, 6), 'USDC in fees');
    console.log('  ✅ Agent credit limit increased to', ethers.formatUnits(newCreditLimit, 6), 'USDC\n');

    console.log('🎯 Next Steps:');
    console.log('  1. Run this script again to build more reputation');
    console.log('  2. Withdraw fees: npx hardhat run scripts/withdraw-fees.js --network sepolia -- ' + ethers.formatUnits(feesEarned, 6));
    console.log('  3. Get more Sepolia ETH to create additional test agents\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
