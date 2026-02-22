/**
 * Check and Withdraw Platform Fees
 * Shows accumulated fees and allows withdrawal
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n💰 PLATFORM FEE MANAGEMENT\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const [deployer] = await ethers.getSigners();

    // Get owner info
    const owner = await marketplace.owner();
    console.log('Contract Owner (Fee Recipient):');
    console.log(`  Address: ${owner}`);
    console.log(`  Your Address: ${deployer.address}`);
    console.log(`  Match: ${owner === deployer.address ? '✅ Yes' : '❌ No'}\n`);

    // Check accumulated fees
    const accumulatedFees = await marketplace.accumulatedFees();
    console.log('Accumulated Platform Fees:');
    console.log(`  Amount: ${ethers.formatUnits(accumulatedFees, 6)} USDC`);
    console.log(`  Raw Value: ${accumulatedFees.toString()}\n`);

    // Check current USDC balance in wallet
    const walletBalance = await usdc.balanceOf(deployer.address);
    console.log('Your Current Wallet Balance:');
    console.log(`  USDC: ${ethers.formatUnits(walletBalance, 6)}\n`);

    // If there are fees, offer to withdraw
    if (accumulatedFees > 0n) {
        console.log('═══════════════════════════════════════════════════════\n');
        console.log('💵 WITHDRAWING FEES\n');

        console.log(`Withdrawing ${ethers.formatUnits(accumulatedFees, 6)} USDC...`);

        const tx = await marketplace.withdrawFees(accumulatedFees);
        const receipt = await tx.wait();

        console.log(`✅ Fees withdrawn!`);
        console.log(`   Tx Hash: ${receipt.hash}\n`);

        // Check new balances
        const newWalletBalance = await usdc.balanceOf(deployer.address);
        const newAccumulatedFees = await marketplace.accumulatedFees();

        console.log('Updated Balances:');
        console.log(`  Wallet USDC: ${ethers.formatUnits(newWalletBalance, 6)} (+${ethers.formatUnits(newWalletBalance - walletBalance, 6)})`);
        console.log(`  Fees in Contract: ${ethers.formatUnits(newAccumulatedFees, 6)}\n`);

    } else {
        console.log('═══════════════════════════════════════════════════════\n');
        console.log('No fees to withdraw yet.\n');
        console.log('Fees are accumulated when borrowers repay loans.');
        console.log('Platform takes 1% of interest earned.\n');
    }

    console.log('✅ Done! 🚀\n');
}

main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
