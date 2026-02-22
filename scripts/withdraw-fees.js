/**
 * Withdraw Fees from Lending Pool
 *
 * This script allows the pool owner to withdraw accumulated fees/interest.
 *
 * Usage:
 *   npx hardhat run scripts/withdraw-fees.js --network sepolia -- <amount>
 *
 * Example:
 *   npx hardhat run scripts/withdraw-fees.js --network sepolia -- 50.5
 *   (Withdraws 50.5 USDC)
 */

const { ethers } = require('hardhat');

const SEPOLIA_LENDING_POOL = '0x5592A6d7bF1816f77074b62911D50Dad92A3212b';
const SEPOLIA_USDC = '0x771c293167AeD146EC4f56479056645Be46a0275';

async function main() {
    console.log('\n💸 Withdrawing Fees from Lending Pool\n');

    const [signer] = await ethers.getSigners();
    console.log('Your address:', signer.address);

    // Get amount from command line args
    const args = process.argv.slice(2);
    const amountArg = args.find(arg => !arg.startsWith('--'));

    if (!amountArg) {
        console.log('❌ Error: Please provide withdrawal amount');
        console.log('\nUsage:');
        console.log('  npx hardhat run scripts/withdraw-fees.js --network sepolia -- <amount>');
        console.log('\nExample:');
        console.log('  npx hardhat run scripts/withdraw-fees.js --network sepolia -- 50.5');
        console.log('\nTo see available balance, run:');
        console.log('  npx hardhat run scripts/check-pool-earnings.js --network sepolia');
        process.exit(1);
    }

    const withdrawalAmount = ethers.parseUnits(amountArg, 6);
    console.log('Withdrawal amount:', ethers.formatUnits(withdrawalAmount, 6), 'USDC\n');

    // Get contracts
    const lendingPool = await ethers.getContractAt('LendingPoolV2', SEPOLIA_LENDING_POOL);
    const usdc = await ethers.getContractAt('MockUSDC', SEPOLIA_USDC);

    // Verify ownership
    const owner = await lendingPool.owner();
    if (signer.address.toLowerCase() !== owner.toLowerCase()) {
        console.log('❌ Error: Only the pool owner can withdraw fees');
        console.log('Pool owner:', owner);
        console.log('Your address:', signer.address);
        process.exit(1);
    }

    // Check available liquidity
    const availableLiquidity = await lendingPool.availableLiquidity();
    const totalLoaned = await lendingPool.totalLoaned();

    console.log('📊 Current Pool Status:');
    console.log('  Available Liquidity:', ethers.formatUnits(availableLiquidity, 6), 'USDC');
    console.log('  Currently Loaned:', ethers.formatUnits(totalLoaned, 6), 'USDC');

    if (withdrawalAmount > availableLiquidity) {
        console.log('\n❌ Error: Insufficient available liquidity');
        console.log('  Requested:', ethers.formatUnits(withdrawalAmount, 6), 'USDC');
        console.log('  Available:', ethers.formatUnits(availableLiquidity, 6), 'USDC');
        process.exit(1);
    }

    // Calculate remaining liquidity after withdrawal
    const remainingLiquidity = availableLiquidity - withdrawalAmount;
    console.log('  Remaining After Withdrawal:', ethers.formatUnits(remainingLiquidity, 6), 'USDC');

    if (remainingLiquidity < totalLoaned) {
        console.log('\n⚠️  WARNING: Remaining liquidity may not cover active loans');
        console.log('  This could prevent new loan approvals');
        console.log('  Consider withdrawing less to maintain lending capacity');
    }

    // Get current USDC balance
    const balanceBefore = await usdc.balanceOf(signer.address);
    console.log('\n💵 Your Current USDC Balance:', ethers.formatUnits(balanceBefore, 6), 'USDC');

    // Confirm withdrawal
    console.log('\n⏳ Processing withdrawal...');

    try {
        const tx = await lendingPool.withdrawLiquidity(withdrawalAmount);
        console.log('Transaction hash:', tx.hash);
        console.log('Waiting for confirmation...');

        await tx.wait();
        console.log('✅ Withdrawal successful!\n');

        // Check new balances
        const balanceAfter = await usdc.balanceOf(signer.address);
        const newAvailableLiquidity = await lendingPool.availableLiquidity();

        console.log('📊 Updated Balances:');
        console.log('  Your USDC:', ethers.formatUnits(balanceAfter, 6), 'USDC (+', ethers.formatUnits(balanceAfter - balanceBefore, 6), ')');
        console.log('  Pool Available:', ethers.formatUnits(newAvailableLiquidity, 6), 'USDC');

        console.log('\n🎉 Successfully withdrew', ethers.formatUnits(withdrawalAmount, 6), 'USDC in fees!\n');

    } catch (error) {
        console.log('\n❌ Withdrawal failed:', error.message);
        process.exit(1);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
