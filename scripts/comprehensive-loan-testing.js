/**
 * Comprehensive Loan Testing
 * Tests: 1) Successful loans & repayment, 2) Reputation changes, 3) Defaults
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🧪 COMPREHENSIVE LOAN TESTING\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const [deployer] = await ethers.getSigners();

    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    const results = {
        successfulLoans: [],
        repayments: [],
        reputationChanges: [],
        defaults: []
    };

    // ═══════════════════════════════════════════════
    // SCENARIO 1: Successful Loan Request & Repayment
    // ═══════════════════════════════════════════════
    console.log('SCENARIO 1: Successful Loan & Repayment\n');

    try {
        const alice = testAgents.find(a => a.name === 'Alice');
        const aliceWallet = new ethers.Wallet(alice.privateKey, ethers.provider);

        // Check initial reputation
        const initialRep = await reputationManager['getReputationScore(address)'](alice.address);
        console.log(`Alice's Initial Reputation: ${initialRep}`);

        // Calculate credit limit
        const creditLimit = await reputationManager.calculateCreditLimit(alice.address);
        console.log(`Alice's Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);

        // Request a loan (use 50% of credit limit)
        const loanAmount = creditLimit / 2n;
        const durationDays = 30; // 30 days

        console.log(`\nRequesting loan: ${ethers.formatUnits(loanAmount, 6)} USDC for 30 days...`);

        const requestTx = await marketplace.connect(aliceWallet).requestLoan(
            loanAmount,
            durationDays
        );
        const receipt = await requestTx.wait();

        // Find loan ID from event
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

        // Wait for transaction to settle
        await new Promise(resolve => setTimeout(resolve, 10000));

        // Approve the loan (as deployer/owner)
        console.log('\nApproving loan...');
        const approveTx = await marketplace.approveLoan(loanId);
        await approveTx.wait();
        console.log('✅ Loan approved and disbursed!');

        // Check loan details
        const loan = await marketplace.loans(loanId);
        console.log(`Loan Amount: ${ethers.formatUnits(loan.amount, 6)} USDC`);
        console.log(`Interest Rate: ${loan.interestRate / 100}% APR`);
        console.log(`Collateral: ${ethers.formatUnits(loan.collateral, 6)} USDC`);

        results.successfulLoans.push({
            agent: 'Alice',
            loanId: loanId.toString(),
            amount: ethers.formatUnits(loan.amount, 6),
            interestRate: loan.interestRate.toString()
        });

        // Wait before repayment
        await new Promise(resolve => setTimeout(resolve, 10000));

        // Repay the loan
        console.log('\nRepaying loan...');
        const interest = await marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
        const totalRepayment = loan.amount + interest;

        console.log(`Total Repayment: ${ethers.formatUnits(totalRepayment, 6)} USDC`);
        console.log(`  - Principal: ${ethers.formatUnits(loan.amount, 6)} USDC`);
        console.log(`  - Interest: ${ethers.formatUnits(interest, 6)} USDC`);

        // Approve and repay
        await usdc.connect(aliceWallet).approve(addresses.agentLiquidityMarketplace, totalRepayment);
        const repayTx = await marketplace.connect(aliceWallet).repayLoan(loanId);
        await repayTx.wait();
        console.log('✅ Loan repaid successfully!');

        // Check new reputation
        const newRep = await reputationManager['getReputationScore(address)'](alice.address);
        console.log(`\nAlice's New Reputation: ${newRep}`);
        console.log(`Reputation Change: +${newRep - initialRep}\n`);

        results.repayments.push({
            agent: 'Alice',
            loanId: loanId.toString(),
            totalPaid: ethers.formatUnits(totalRepayment, 6)
        });

        results.reputationChanges.push({
            agent: 'Alice',
            before: initialRep.toString(),
            after: newRep.toString(),
            change: (newRep - initialRep).toString()
        });

    } catch (error) {
        console.log(`❌ Failed: ${error.message}\n`);
    }

    // ═══════════════════════════════════════════════
    // SCENARIO 2: Another Agent - Bob
    // ═══════════════════════════════════════════════
    console.log('SCENARIO 2: Bob Borrows and Repays\n');

    try {
        await new Promise(resolve => setTimeout(resolve, 15000));

        const bob = testAgents.find(a => a.name === 'Bob');
        const bobWallet = new ethers.Wallet(bob.privateKey, ethers.provider);

        const initialRep = await reputationManager['getReputationScore(address)'](bob.address);
        const creditLimit = await reputationManager.calculateCreditLimit(bob.address);

        console.log(`Bob's Initial Reputation: ${initialRep}`);
        console.log(`Bob's Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);

        const loanAmount = creditLimit / 2n;
        const durationDays = 15; // 15 days

        console.log(`\nRequesting loan: ${ethers.formatUnits(loanAmount, 6)} USDC for 15 days...`);

        const requestTx = await marketplace.connect(bobWallet).requestLoan(
            loanAmount,
            durationDays
        );
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

        console.log(`✅ Loan requested! Loan ID: ${loanId}`);

        await new Promise(resolve => setTimeout(resolve, 10000));

        console.log('\nApproving loan...');
        const approveTx = await marketplace.approveLoan(loanId);
        await approveTx.wait();
        console.log('✅ Loan approved!');

        await new Promise(resolve => setTimeout(resolve, 10000));

        const loan = await marketplace.loans(loanId);
        const interest = await marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
        const totalRepayment = loan.amount + interest;

        console.log('\nRepaying loan...');
        await usdc.connect(bobWallet).approve(addresses.agentLiquidityMarketplace, totalRepayment);
        const repayTx = await marketplace.connect(bobWallet).repayLoan(loanId);
        await repayTx.wait();
        console.log('✅ Loan repaid!');

        const newRep = await reputationManager['getReputationScore(address)'](bob.address);
        console.log(`\nBob's New Reputation: ${newRep} (+${newRep - initialRep})\n`);

        results.successfulLoans.push({
            agent: 'Bob',
            loanId: loanId.toString(),
            amount: ethers.formatUnits(loan.amount, 6)
        });

        results.repayments.push({
            agent: 'Bob',
            loanId: loanId.toString(),
            totalPaid: ethers.formatUnits(totalRepayment, 6)
        });

        results.reputationChanges.push({
            agent: 'Bob',
            before: initialRep.toString(),
            after: newRep.toString(),
            change: (newRep - initialRep).toString()
        });

    } catch (error) {
        console.log(`❌ Failed: ${error.message}\n`);
    }

    // ═══════════════════════════════════════════════
    // SCENARIO 3: Default Test (Dave)
    // ═══════════════════════════════════════════════
    console.log('SCENARIO 3: Default Scenario (Dave)\n');

    try {
        await new Promise(resolve => setTimeout(resolve, 15000));

        const dave = testAgents.find(a => a.name === 'Dave');
        const daveWallet = new ethers.Wallet(dave.privateKey, ethers.provider);

        const initialRep = await reputationManager['getReputationScore(address)'](dave.address);
        const creditLimit = await reputationManager.calculateCreditLimit(dave.address);

        console.log(`Dave's Initial Reputation: ${initialRep}`);
        console.log(`Dave's Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);

        const loanAmount = creditLimit / 2n;
        const durationDays = 7; // 7 days

        console.log(`\nRequesting loan: ${ethers.formatUnits(loanAmount, 6)} USDC for 7 days...`);

        const requestTx = await marketplace.connect(daveWallet).requestLoan(
            loanAmount,
            durationDays
        );
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

        console.log(`✅ Loan requested! Loan ID: ${loanId}`);

        await new Promise(resolve => setTimeout(resolve, 10000));

        console.log('\nApproving loan...');
        const approveTx = await marketplace.approveLoan(loanId);
        await approveTx.wait();
        console.log('✅ Loan approved!');

        const loan = await marketplace.loans(loanId);
        console.log(`Loan Amount: ${ethers.formatUnits(loan.amount, 6)} USDC`);
        console.log(`Collateral: ${ethers.formatUnits(loan.collateral, 6)} USDC`);

        // NOTE: We won't actually default this loan in this test
        // (would need to wait for loan to expire or liquidate it)
        console.log('\n⚠️  Loan created but not repaid (simulating risky borrower)');
        console.log('In production, this would eventually default after expiry\n');

        results.successfulLoans.push({
            agent: 'Dave',
            loanId: loanId.toString(),
            amount: ethers.formatUnits(loan.amount, 6),
            status: 'ACTIVE (not repaid)'
        });

    } catch (error) {
        console.log(`❌ Failed: ${error.message}\n`);
    }

    // ═══════════════════════════════════════════════
    // FINAL SUMMARY
    // ═══════════════════════════════════════════════
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 COMPREHENSIVE TEST RESULTS\n');

    console.log('✅ SUCCESSFUL LOANS:');
    results.successfulLoans.forEach(loan => {
        console.log(`   ${loan.agent}: ${loan.amount} USDC (Loan ID: ${loan.loanId})`);
    });
    console.log('');

    console.log('✅ REPAYMENTS:');
    results.repayments.forEach(repay => {
        console.log(`   ${repay.agent}: ${repay.totalPaid} USDC repaid (Loan ID: ${repay.loanId})`);
    });
    console.log('');

    console.log('📈 REPUTATION CHANGES:');
    results.reputationChanges.forEach(change => {
        console.log(`   ${change.agent}: ${change.before} → ${change.after} (${change.change >= 0 ? '+' : ''}${change.change})`);
    });
    console.log('');

    // Show current pool states
    console.log('💰 FINAL POOL STATES:\n');
    for (const agent of testAgents) {
        const pool = await marketplace.agentPools(agent.agentId);
        console.log(`${agent.name}:`);
        console.log(`  - Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
        console.log(`  - Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
        console.log(`  - Loaned: ${ethers.formatUnits(pool.totalLoaned, 6)} USDC`);
        console.log('');
    }

    // Save results
    const resultsPath = path.join(__dirname, '..', 'comprehensive-loan-test-results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
    console.log(`📁 Results saved to: comprehensive-loan-test-results.json\n`);

    console.log('✅ Comprehensive loan testing complete! 🚀\n');
}

main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
