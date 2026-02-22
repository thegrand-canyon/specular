/**
 * Repay V3 Loan
 *
 * Usage: npx hardhat run scripts/repay-v3-loan.js --network sepolia -- <loanId>
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    // Get loan ID from command line or default to 1
    const args = process.argv.slice(2);
    const loanId = args.length > 0 && !args[args.length - 1].includes('sepolia')
        ? args[args.length - 1]
        : '1';

    console.log('\n💰 Repaying V3 Loan\n');
    console.log('═════════════════════════════════════\n');

    const [signer] = await ethers.getSigners();

    // Load addresses
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const lendingPool = await ethers.getContractAt('LendingPoolV3', addresses.lendingPool);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    // Get loan details
    const loan = await lendingPool.loans(loanId);

    console.log('📋 Loan Details:');
    console.log('  Amount:', ethers.formatUnits(loan.amount, 6), 'USDC');
    console.log('  Interest Rate:', (Number(loan.interestRate) / 100).toFixed(2), '% APR');
    console.log('  Duration:', loan.durationDays.toString(), 'days');
    console.log('  Due Date:', new Date(Number(loan.endTime) * 1000).toLocaleString());

    // Calculate interest
    const principal = loan.amount;
    const rate = loan.interestRate;
    const duration = loan.durationDays;
    const interest = (principal * rate * duration) / (10000n * 365n);
    const totalRepayment = principal + interest;

    console.log('\n💵 Repayment Calculation:');
    console.log('  Principal:', ethers.formatUnits(principal, 6), 'USDC');
    console.log('  Interest:', ethers.formatUnits(interest, 6), 'USDC');
    console.log('  Total:', ethers.formatUnits(totalRepayment, 6), 'USDC');

    const balanceBefore = await usdc.balanceOf(signer.address);
    console.log('\n📊 Balance Before:', ethers.formatUnits(balanceBefore, 6), 'USDC');

    // Approve USDC
    console.log('\n1️⃣  Approving USDC...');
    const approveTx = await usdc.approve(addresses.lendingPool, totalRepayment);
    await approveTx.wait();
    console.log('✅ Approved\n');

    // Repay loan
    console.log('2️⃣  Repaying loan...');
    const repayTx = await lendingPool.repayLoan(loanId);
    const receipt = await repayTx.wait();
    console.log('✅ Loan repaid!\n');

    // Check if repaid on time
    const event = receipt.logs.find(log => {
        try {
            return lendingPool.interface.parseLog(log)?.name === 'LoanRepaid';
        } catch { return false; }
    });

    if (event) {
        const parsed = lendingPool.interface.parseLog(event);
        const onTime = parsed.args.onTime;
        console.log('On Time:', onTime ? '✅ YES' : '❌ NO');
    }

    const balanceAfter = await usdc.balanceOf(signer.address);
    console.log('\n📊 Balance After:', ethers.formatUnits(balanceAfter, 6), 'USDC');
    console.log('Total Paid:', ethers.formatUnits(balanceBefore - balanceAfter, 6), 'USDC');

    // Check pool earnings
    const poolLiquidity = await lendingPool.availableLiquidity();
    console.log('\n💰 Pool Liquidity:', ethers.formatUnits(poolLiquidity, 6), 'USDC');
    console.log('Pool earned:', ethers.formatUnits(interest, 6), 'USDC in fees');

    console.log('\n✅ Repayment Complete!');
    console.log('\n🎯 V3 Features Demonstrated:');
    console.log('  ✅ Instant auto-approval');
    console.log('  ✅ No manual intervention');
    console.log('  ✅ Automatic interest calculation');
    console.log('  ✅ Fees accumulate in pool\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
