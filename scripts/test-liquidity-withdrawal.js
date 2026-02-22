/**
 * Test Liquidity Withdrawal
 * Tests a lender withdrawing their liquidity from a pool
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n💧 TESTING LIQUIDITY WITHDRAWAL\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const [deployer] = await ethers.getSigners();

    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    // We'll test withdrawing from Bob's pool (deployer supplied 1,000 USDC)
    const bob = testAgents.find(a => a.name === 'Bob');

    console.log('TEST: Withdraw Liquidity from Bob\'s Pool\n');

    // Check deployer's position in Bob's pool
    const position = await marketplace.positions(bob.agentId, deployer.address);
    console.log('Your Position in Bob\'s Pool:');
    console.log(`  Amount Supplied: ${ethers.formatUnits(position.amount, 6)} USDC`);
    console.log(`  Deposit Time: ${new Date(Number(position.depositTimestamp) * 1000).toLocaleString()}\n`);

    if (position.amount === 0n) {
        console.log('❌ No liquidity position found. You haven\'t supplied to this pool.\n');
        return;
    }

    // Check Bob's pool state before withdrawal
    const poolBefore = await marketplace.agentPools(bob.agentId);
    console.log('Bob\'s Pool Before Withdrawal:');
    console.log(`  Total Liquidity: ${ethers.formatUnits(poolBefore.totalLiquidity, 6)} USDC`);
    console.log(`  Available: ${ethers.formatUnits(poolBefore.availableLiquidity, 6)} USDC`);
    console.log(`  Loaned: ${ethers.formatUnits(poolBefore.totalLoaned, 6)} USDC\n`);

    // Check deployer's USDC balance before
    const balanceBefore = await usdc.balanceOf(deployer.address);
    console.log('Your USDC Balance Before: ${ethers.formatUnits(balanceBefore, 6)} USDC\n');

    // Calculate how much we can withdraw (can't withdraw loaned amount)
    const maxWithdraw = poolBefore.availableLiquidity < position.amount
        ? poolBefore.availableLiquidity
        : position.amount;

    console.log(`Maximum Withdrawable: ${ethers.formatUnits(maxWithdraw, 6)} USDC\n`);

    // Try to withdraw 500 USDC (half of our position)
    const withdrawAmount = ethers.parseUnits('500', 6);

    if (withdrawAmount > maxWithdraw) {
        console.log('⚠️  Requested amount exceeds available. Withdrawing max instead.\n');
    }

    const actualWithdraw = withdrawAmount > maxWithdraw ? maxWithdraw : withdrawAmount;

    console.log(`Withdrawing ${ethers.formatUnits(actualWithdraw, 6)} USDC...\n`);

    try {
        const tx = await marketplace.withdrawLiquidity(bob.agentId, actualWithdraw);
        const receipt = await tx.wait();

        console.log(`✅ Withdrawal successful!`);
        console.log(`   Tx Hash: ${receipt.hash}\n`);

        // Check new states
        const poolAfter = await marketplace.agentPools(bob.agentId);
        const balanceAfter = await usdc.balanceOf(deployer.address);
        const positionAfter = await marketplace.positions(bob.agentId, deployer.address);

        console.log('═══════════════════════════════════════════════════════\n');
        console.log('📊 RESULTS\n');

        console.log('Bob\'s Pool After Withdrawal:');
        console.log(`  Total Liquidity: ${ethers.formatUnits(poolAfter.totalLiquidity, 6)} USDC (${ethers.formatUnits(poolBefore.totalLiquidity - poolAfter.totalLiquidity, 6)})`);
        console.log(`  Available: ${ethers.formatUnits(poolAfter.availableLiquidity, 6)} USDC\n`);

        console.log('Your Position After:');
        console.log(`  Amount Remaining: ${ethers.formatUnits(positionAfter.amount, 6)} USDC\n`);

        console.log('Your USDC Balance:');
        console.log(`  Before: ${ethers.formatUnits(balanceBefore, 6)} USDC`);
        console.log(`  After: ${ethers.formatUnits(balanceAfter, 6)} USDC`);
        console.log(`  Gained: +${ethers.formatUnits(balanceAfter - balanceBefore, 6)} USDC\n`);

        console.log('✅ Liquidity withdrawal test passed! 🚀\n');

    } catch (error) {
        console.log(`❌ Withdrawal failed: ${error.message}\n`);

        if (error.message.includes('Insufficient available')) {
            console.log('⚠️  Pool doesn\'t have enough available liquidity (some is loaned out)\n');
        }
    }
}

main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
