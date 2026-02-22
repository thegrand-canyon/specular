/**
 * Bob's Loan Cycle
 * Complete borrow and repay cycle for Bob
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n👤 BOB\'S LOAN CYCLE\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    const bob = testAgents.find(a => a.name === 'Bob');
    const bobWallet = new ethers.Wallet(bob.privateKey, ethers.provider);

    // Get initial state
    const initialRep = await reputationManager['getReputationScore(address)'](bob.address);
    const creditLimit = await reputationManager.calculateCreditLimit(bob.address);

    console.log('STEP 1: Initial State\n');
    console.log(`Bob's Reputation: ${initialRep}`);
    console.log(`Bob's Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC\n`);

    // Request loan
    console.log('STEP 2: Request Loan\n');
    const loanAmount = ethers.parseUnits('200', 6); // 200 USDC
    const durationDays = 14; // 14 days

    console.log(`Requesting ${ethers.formatUnits(loanAmount, 6)} USDC for ${durationDays} days...`);

    const requestTx = await marketplace.connect(bobWallet).requestLoan(loanAmount, durationDays);
    const receipt = await requestTx.wait();

    // Get loan ID from event
    const loanRequestedEvent = receipt.logs.find(log => {
        try {
            const parsed = marketplace.interface.parseLog(log);
            return parsed?.name === 'LoanRequested';
        } catch { return false; }
    });

    const loanId = loanRequestedEvent
        ? marketplace.interface.parseLog(loanRequestedEvent).args.loanId
        : null;

    console.log(`✅ Loan requested! Loan ID: ${loanId}`);
    console.log(`Tx: ${receipt.hash}\n`);

    // Get loan details
    const loan = await marketplace.loans(loanId);
    console.log('Loan Details:');
    console.log(`  - Amount: ${ethers.formatUnits(loan.amount, 6)} USDC`);
    console.log(`  - Interest Rate: ${Number(loan.interestRate) / 100}% APR`);
    console.log(`  - Collateral Required: ${ethers.formatUnits(loan.collateralAmount, 6)} USDC`);
    console.log(`  - Duration: ${durationDays} days\n`);

    // Check Bob's pool state
    const pool = await marketplace.agentPools(bob.agentId);
    console.log('Bob\'s Pool After Loan:');
    console.log(`  - Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
    console.log(`  - Loaned: ${ethers.formatUnits(pool.totalLoaned, 6)} USDC\n`);

    // Wait a bit before repaying
    console.log('Waiting 15 seconds before repayment...\n');
    await new Promise(resolve => setTimeout(resolve, 15000));

    // Calculate repayment
    console.log('STEP 3: Repay Loan\n');
    const interest = await marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
    const totalRepayment = loan.amount + interest;

    console.log('Repayment Calculation:');
    console.log(`  - Principal: ${ethers.formatUnits(loan.amount, 6)} USDC`);
    console.log(`  - Interest: ${ethers.formatUnits(interest, 6)} USDC`);
    console.log(`  - Total Due: ${ethers.formatUnits(totalRepayment, 6)} USDC\n`);

    // Approve and repay
    console.log('Approving USDC...');
    const approveTx = await usdc.connect(bobWallet).approve(addresses.agentLiquidityMarketplace, totalRepayment);
    await approveTx.wait();
    console.log('✅ Approved\n');

    console.log('Repaying loan...');
    const repayTx = await marketplace.connect(bobWallet).repayLoan(loanId);
    const repayReceipt = await repayTx.wait();
    console.log(`✅ Loan repaid! Tx: ${repayReceipt.hash}\n`);

    // Check final state
    const newRep = await reputationManager['getReputationScore(address)'](bob.address);
    const newCreditLimit = await reputationManager.calculateCreditLimit(bob.address);

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 FINAL RESULTS\n');

    console.log('Reputation:');
    console.log(`  - Before: ${initialRep}`);
    console.log(`  - After: ${newRep}`);
    console.log(`  - Gain: +${newRep - initialRep}\n`);

    console.log('Credit Limit:');
    console.log(`  - Before: ${ethers.formatUnits(creditLimit, 6)} USDC`);
    console.log(`  - After: ${ethers.formatUnits(newCreditLimit, 6)} USDC`);
    console.log(`  - Increase: ${ethers.formatUnits(newCreditLimit - creditLimit, 6)} USDC\n`);

    const finalPool = await marketplace.agentPools(bob.agentId);
    console.log('Bob\'s Pool Final State:');
    console.log(`  - Total Liquidity: ${ethers.formatUnits(finalPool.totalLiquidity, 6)} USDC`);
    console.log(`  - Available: ${ethers.formatUnits(finalPool.availableLiquidity, 6)} USDC`);
    console.log(`  - Loaned: ${ethers.formatUnits(finalPool.totalLoaned, 6)} USDC`);
    console.log(`  - Interest Earned: ~${ethers.formatUnits(interest * 99n / 100n, 6)} USDC (99% to lenders)\n`);

    console.log('✅ Bob\'s loan cycle complete! 🚀\n');
}

main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
