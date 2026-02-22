/**
 * Repay Alice's Loan
 * Simple script to repay loan ID 1
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n💰 REPAYING ALICE\'S LOAN\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    const alice = testAgents.find(a => a.name === 'Alice');
    const aliceWallet = new ethers.Wallet(alice.privateKey, ethers.provider);

    // Get initial reputation
    const initialRep = await reputationManager['getReputationScore(address)'](alice.address);
    console.log(`Alice's Initial Reputation: ${initialRep}\n`);

    // Get loan details
    const loanId = 1;
    const loan = await marketplace.loans(loanId);

    console.log('Loan Details:');
    console.log(`  - Loan ID: ${loanId}`);
    console.log(`  - Amount: ${ethers.formatUnits(loan.amount, 6)} USDC`);
    console.log(`  - Interest Rate: ${Number(loan.interestRate) / 100}% APR`);
    console.log(`  - Duration: ${Number(loan.duration) / (24 * 60 * 60)} days`);

    // Calculate repayment
    const interest = await marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
    const totalRepayment = loan.amount + interest;

    console.log('\nRepayment Calculation:');
    console.log(`  - Principal: ${ethers.formatUnits(loan.amount, 6)} USDC`);
    console.log(`  - Interest: ${ethers.formatUnits(interest, 6)} USDC`);
    console.log(`  - Total Due: ${ethers.formatUnits(totalRepayment, 6)} USDC\n`);

    // Check Alice's USDC balance
    const aliceBalance = await usdc.balanceOf(alice.address);
    console.log(`Alice's USDC Balance: ${ethers.formatUnits(aliceBalance, 6)} USDC`);

    if (aliceBalance < totalRepayment) {
        console.log('⚠️  Insufficient balance! Minting more USDC...\n');
        const needed = totalRepayment - aliceBalance + ethers.parseUnits('100', 6); // Extra buffer
        await usdc.mint(alice.address, needed);
        console.log('✅ USDC minted\n');
    }

    // Approve USDC
    console.log('Approving USDC spending...');
    const approveTx = await usdc.connect(aliceWallet).approve(addresses.agentLiquidityMarketplace, totalRepayment);
    await approveTx.wait();
    console.log('✅ Approved\n');

    // Repay loan
    console.log('Repaying loan...');
    const repayTx = await marketplace.connect(aliceWallet).repayLoan(loanId);
    const receipt = await repayTx.wait();
    console.log(`✅ Loan repaid! Tx: ${receipt.hash}\n`);

    // Check new reputation
    const newRep = await reputationManager['getReputationScore(address)'](alice.address);

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 RESULTS\n');
    console.log('Reputation Change:');
    console.log(`  - Before: ${initialRep}`);
    console.log(`  - After: ${newRep}`);
    console.log(`  - Gain: +${newRep - initialRep}\n`);

    // Check pool state
    const pool = await marketplace.agentPools(alice.agentId);
    console.log('Alice\'s Pool:');
    console.log(`  - Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
    console.log(`  - Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
    console.log(`  - Loaned: ${ethers.formatUnits(pool.totalLoaned, 6)} USDC\n`);

    console.log('✅ Repayment complete! 🚀\n');
}

main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
