/**
 * Simple Loan Cycle Testing
 * Repay Alice's existing loan, test Bob's loan, demonstrate defaults
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🔄 SIMPLE LOAN CYCLE TESTING\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    // ═══════════════════════════════════════════════
    // STEP 1: Repay Alice's Loan (ID: 1)
    // ═══════════════════════════════════════════════
    console.log('STEP 1: Alice Repays Her Loan\n');

    try {
        const alice = testAgents.find(a => a.name === 'Alice');
        const aliceWallet = new ethers.Wallet(alice.privateKey, ethers.provider);

        const initialRep = await reputationManager['getReputationScore(address)'](alice.address);
        console.log(`Alice's Initial Reputation: ${initialRep}`);

        // Get loan details
        const loanId = 1;
        const loan = await marketplace.loans(loanId);

        console.log(`\nLoan Details:`);
        console.log(`  - Amount: ${ethers.formatUnits(loan.amount, 6)} USDC`);
        console.log(`  - Interest Rate: ${loan.interestRate / 100}% APR`);
        console.log(`  - State: ${loan.state}`);

        // Calculate repayment
        const interest = await marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
        const totalRepayment = loan.amount + interest;

        console.log(`\nRepayment Calculation:`);
        console.log(`  - Principal: ${ethers.formatUnits(loan.amount, 6)} USDC`);
        console.log(`  - Interest: ${ethers.formatUnits(interest, 6)} USDC`);
        console.log(`  - Total: ${ethers.formatUnits(totalRepayment, 6)} USDC`);

        // Approve and repay
        console.log('\nApproving USDC...');
        const approveTx = await usdc.connect(aliceWallet).approve(addresses.agentLiquidityMarketplace, totalRepayment);
        await approveTx.wait();
        console.log('✅ Approved');

        console.log('Repaying loan...');
        const repayTx = await marketplace.connect(aliceWallet).repayLoan(loanId);
        await repayTx.wait();
        console.log('✅ Loan repaid successfully!');

        // Check new reputation
        const newRep = await reputationManager['getReputationScore(address)'](alice.address);
        console.log(`\nReputation Update:`);
        console.log(`  - Before: ${initialRep}`);
        console.log(`  - After: ${newRep}`);
        console.log(`  - Change: +${newRep - initialRep}\n`);

    } catch (error) {
        console.log(`❌ Failed: ${error.message}\n`);
        if (error.message.includes('Loan not active')) {
            console.log('⚠️  Loan may have already been repaid or is in wrong state\n');
        }
    }

    // Wait before next scenario
    await new Promise(resolve => setTimeout(resolve, 15000));

    // ═══════════════════════════════════════════════
    // STEP 2: Bob's Complete Loan Cycle
    // ═══════════════════════════════════════════════
    console.log('STEP 2: Bob\'s Complete Loan Cycle\n');

    try {
        const bob = testAgents.find(a => a.name === 'Bob');
        const bobWallet = new ethers.Wallet(bob.privateKey, ethers.provider);

        const initialRep = await reputationManager['getReputationScore(address)'](bob.address);
        const creditLimit = await reputationManager.calculateCreditLimit(bob.address);

        console.log(`Bob's Initial Reputation: ${initialRep}`);
        console.log(`Bob's Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);

        // Request loan
        const loanAmount = ethers.parseUnits('300', 6); // 300 USDC
        const durationDays = 14;

        console.log(`\nRequesting loan: ${ethers.formatUnits(loanAmount, 6)} USDC for ${durationDays} days...`);

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

        console.log(`✅ Loan created! Loan ID: ${loanId}`);

        const loan = await marketplace.loans(loanId);
        console.log(`State: ${loan.state === 2 ? 'ACTIVE (auto-disbursed)' : 'REQUESTED'}`);

        // Wait before repaying
        await new Promise(resolve => setTimeout(resolve, 15000));

        // Repay immediately
        const interest = await marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
        const totalRepayment = loan.amount + interest;

        console.log(`\nRepaying ${ethers.formatUnits(totalRepayment, 6)} USDC...`);

        await usdc.connect(bobWallet).approve(addresses.agentLiquidityMarketplace, totalRepayment);
        const repayTx = await marketplace.connect(bobWallet).repayLoan(loanId);
        await repayTx.wait();
        console.log('✅ Loan repaid!');

        const newRep = await reputationManager['getReputationScore(address)'](bob.address);
        console.log(`\nBob's Reputation: ${initialRep} → ${newRep} (+${newRep - initialRep})\n`);

    } catch (error) {
        console.log(`❌ Failed: ${error.message}\n`);
    }

    // Wait before final scenario
    await new Promise(resolve => setTimeout(resolve, 15000));

    // ═══════════════════════════════════════════════
    // STEP 3: Dave's Loan (Will Remain Unpaid)
    // ═══════════════════════════════════════════════
    console.log('STEP 3: Dave\'s Risky Loan (Simulated Default)\n');

    try {
        const dave = testAgents.find(a => a.name === 'Dave');
        const daveWallet = new ethers.Wallet(dave.privateKey, ethers.provider);

        const initialRep = await reputationManager['getReputationScore(address)'](dave.address);
        console.log(`Dave's Initial Reputation: ${initialRep}`);

        const loanAmount = ethers.parseUnits('200', 6); // 200 USDC
        const durationDays = 7;

        console.log(`\nRequesting loan: ${ethers.formatUnits(loanAmount, 6)} USDC for ${durationDays} days...`);

        const requestTx = await marketplace.connect(daveWallet).requestLoan(loanAmount, durationDays);
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

        const loan = await marketplace.loans(loanId);
        console.log(`Amount: ${ethers.formatUnits(loan.amount, 6)} USDC`);
        console.log(`Collateral: ${ethers.formatUnits(loan.collateralAmount, 6)} USDC`);
        console.log('\n⚠️  This loan will remain unpaid (simulating risky borrower behavior)');
        console.log('⚠️  In production, this would be liquidated after expiry\n');

    } catch (error) {
        console.log(`❌ Failed: ${error.message}\n`);
    }

    // ═══════════════════════════════════════════════
    // FINAL SUMMARY
    // ═══════════════════════════════════════════════
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 FINAL STATE\n');

    // Show all agent reputations
    console.log('👥 AGENT REPUTATIONS:\n');
    for (const agent of testAgents) {
        const rep = await reputationManager['getReputationScore(address)'](agent.address);
        const creditLimit = await reputationManager.calculateCreditLimit(agent.address);
        console.log(`${agent.name}:`);
        console.log(`  - Reputation: ${rep}`);
        console.log(`  - Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);
        console.log('');
    }

    // Show pool states
    console.log('💰 POOL STATES:\n');
    for (const agent of testAgents) {
        const pool = await marketplace.agentPools(agent.agentId);
        console.log(`${agent.name}:`);
        console.log(`  - Total: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
        console.log(`  - Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
        console.log(`  - Loaned: ${ethers.formatUnits(pool.totalLoaned, 6)} USDC`);
        console.log('');
    }

    console.log('✅ Loan cycle testing complete! 🚀\n');
}

main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
