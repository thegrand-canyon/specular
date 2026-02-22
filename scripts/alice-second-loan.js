/**
 * Alice's Second Loan
 * Test another loan with Alice who has proven reputation
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n💰 ALICE\'S SECOND LOAN\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);

    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    const alice = testAgents.find(a => a.name === 'Alice');
    const aliceWallet = new ethers.Wallet(alice.privateKey, ethers.provider);

    // Check Alice's current state
    const rep = await reputationManager['getReputationScore(address)'](alice.address);
    const creditLimit = await reputationManager.calculateCreditLimit(alice.address);
    const pool = await marketplace.agentPools(alice.agentId);

    console.log('Alice\'s Current State:');
    console.log(`  Reputation: ${rep}`);
    console.log(`  Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);
    console.log(`  Pool Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC\n`);

    // Request a loan
    const loanAmount = ethers.parseUnits('800', 6); // 800 USDC
    const durationDays = 20; // 20 days

    console.log(`Requesting ${ethers.formatUnits(loanAmount, 6)} USDC for ${durationDays} days...`);

    try {
        const requestTx = await marketplace.connect(aliceWallet).requestLoan(loanAmount, durationDays);
        const receipt = await requestTx.wait();

        const loanRequestedEvent = receipt.logs.find(log => {
            try {
                const parsed = marketplace.interface.parseLog(log);
                return parsed?.name === 'LoanRequested';
            } catch { return false; }
        });

        const loanId = loanRequestedEvent
            ? marketplace.interface.parseLog(loanRequestedEvent).args.loanId
            : null;

        console.log(`✅ Loan created! Loan ID: ${loanId}`);
        console.log(`   Tx: ${receipt.hash}\n`);

        const loan = await marketplace.loans(loanId);
        console.log('Loan Details:');
        console.log(`  Amount: ${ethers.formatUnits(loan.amount, 6)} USDC`);
        console.log(`  Interest Rate: ${Number(loan.interestRate) / 100}% APR`);
        console.log(`  Collateral: ${ethers.formatUnits(loan.collateralAmount, 6)} USDC`);
        console.log(`  Duration: ${Number(loan.duration) / (24 * 60 * 60)} days\n`);

        // Check pool state
        const newPool = await marketplace.agentPools(alice.agentId);
        console.log('Pool After Loan:');
        console.log(`  Available: ${ethers.formatUnits(newPool.availableLiquidity, 6)} USDC`);
        console.log(`  Loaned: ${ethers.formatUnits(newPool.totalLoaned, 6)} USDC\n`);

        console.log('✅ Success! 🚀\n');

    } catch (error) {
        console.log(`❌ Failed: ${error.message}\n`);

        // Try to get more detail
        if (error.data) {
            console.log(`Error data: ${error.data}\n`);
        }

        // Try a smaller amount
        console.log('Let me try a smaller amount (500 USDC)...\n');

        try {
            const smallAmount = ethers.parseUnits('500', 6);
            const tx = await marketplace.connect(aliceWallet).requestLoan(smallAmount, 15);
            const receipt = await tx.wait();
            console.log(`✅ Smaller loan succeeded! Tx: ${receipt.hash}\n`);
        } catch (err2) {
            console.log(`❌ Smaller loan also failed: ${err2.message}\n`);
        }
    }
}

main().catch(console.error);
