/**
 * Setup Lending Pool on Sepolia
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n💰 Setting up LendingPoolV2 on Sepolia...\n');

    const [deployer] = await ethers.getSigners();
    console.log('Using account:', deployer.address);

    // Load Sepolia addresses
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    // Get contract instances
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);
    const lendingPool = await ethers.getContractAt('LendingPoolV2', addresses.lendingPool);

    // Check USDC balance
    const balance = await usdc.balanceOf(deployer.address);
    console.log(`Your USDC balance: ${ethers.formatUnits(balance, 6)} USDC`);

    // Deposit liquidity
    const depositAmount = ethers.parseUnits('100000', 6); // 100k USDC

    console.log(`\nDepositing ${ethers.formatUnits(depositAmount, 6)} USDC into lending pool...`);

    // Approve USDC
    console.log('Approving USDC...');
    const approveTx = await usdc.approve(addresses.lendingPool, depositAmount);
    await approveTx.wait();

    // Deposit
    console.log('Depositing liquidity...');
    const depositTx = await lendingPool.depositLiquidity(depositAmount);
    await depositTx.wait();

    // Check pool status
    const availableLiquidity = await lendingPool.availableLiquidity();
    const totalLent = await lendingPool.totalLent();

    console.log('\n✅ Pool setup complete!');
    console.log(`   Total Liquidity: ${ethers.formatUnits(availableLiquidity, 6)} USDC`);
    console.log(`   Available: ${ethers.formatUnits(availableLiquidity, 6)} USDC`);
    console.log(`   Lent Out: ${ethers.formatUnits(totalLent, 6)} USDC\n`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
