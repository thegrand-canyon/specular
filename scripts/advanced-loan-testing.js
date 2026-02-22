/**
 * Advanced Loan Testing
 * Tests multiple agents, concurrent loans, and edge cases
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🚀 ADVANCED LOAN TESTING\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    const results = {
        loansCreated: [],
        repayments: [],
        reputationChanges: [],
        errors: []
    };

    // ═══════════════════════════════════════════════
    // TEST 1: Bob Borrows from His Own Pool
    // ═══════════════════════════════════════════════
    console.log('TEST 1: Bob Borrows from His Own Pool\n');

    try {
        const bob = testAgents.find(a => a.name === 'Bob');
        const bobWallet = new ethers.Wallet(bob.privateKey, ethers.provider);

        // Check Bob's pool
        const bobPool = await marketplace.agentPools(bob.agentId);
        console.log(`Bob's Pool: ${ethers.formatUnits(bobPool.totalLiquidity, 6)} USDC\n`);

        const initialRep = await reputationManager['getReputationScore(address)'](bob.address);
        const creditLimit = await reputationManager.calculateCreditLimit(bob.address);

        console.log(`Bob's Reputation: ${initialRep}`);
        console.log(`Bob's Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC\n`);

        // Request a small loan (within pool and credit limit)
        const loanAmount = ethers.parseUnits('300', 6);
        const durationDays = 7;

        console.log(`Requesting ${ethers.formatUnits(loanAmount, 6)} USDC for ${durationDays} days...`);

        const requestTx = await marketplace.connect(bobWallet).requestLoan(loanAmount, durationDays);
        const receipt = await requestTx.wait();

        const loanRequestedEvent = receipt.logs.find(log => {
            try {
                const parsed = marketplace.interface.parseLog(log);
                return parsed?.name === 'LoanRequested';
            } catch { return false; }
        });

        const bobLoanId = loanRequestedEvent
            ? marketplace.interface.parseLog(loanRequestedEvent).args.loanId
            : null;

        console.log(`✅ Bob's loan created! Loan ID: ${bobLoanId}\n`);

        const bobLoan = await marketplace.loans(bobLoanId);
        console.log(`Interest Rate: ${Number(bobLoan.interestRate) / 100}% APR`);
        console.log(`Collateral: ${ethers.formatUnits(bobLoan.collateralAmount, 6)} USDC\n`);

        results.loansCreated.push({
            agent: 'Bob',
            loanId: bobLoanId.toString(),
            amount: ethers.formatUnits(loanAmount, 6),
            duration: durationDays,
            interestRate: Number(bobLoan.interestRate) / 100
        });

        // Wait before next test
        console.log('Waiting 15 seconds...\n');
        await new Promise(resolve => setTimeout(resolve, 15000));

    } catch (error) {
        console.log(`❌ Bob's loan failed: ${error.message}\n`);
        results.errors.push({ test: 'Bob loan', error: error.message });
    }

    // ═══════════════════════════════════════════════
    // TEST 2: Carol Borrows from Her Pool
    // ═══════════════════════════════════════════════
    console.log('TEST 2: Carol Borrows from Her Pool\n');

    try {
        const carol = testAgents.find(a => a.name === 'Carol');
        const carolWallet = new ethers.Wallet(carol.privateKey, ethers.provider);

        const carolPool = await marketplace.agentPools(carol.agentId);
        console.log(`Carol's Pool: ${ethers.formatUnits(carolPool.totalLiquidity, 6)} USDC\n`);

        const initialRep = await reputationManager['getReputationScore(address)'](carol.address);
        const creditLimit = await reputationManager.calculateCreditLimit(carol.address);

        console.log(`Carol's Reputation: ${initialRep}`);
        console.log(`Carol's Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC\n`);

        const loanAmount = ethers.parseUnits('500', 6);
        const durationDays = 14;

        console.log(`Requesting ${ethers.formatUnits(loanAmount, 6)} USDC for ${durationDays} days...`);

        const requestTx = await marketplace.connect(carolWallet).requestLoan(loanAmount, durationDays);
        const receipt = await requestTx.wait();

        const loanRequestedEvent = receipt.logs.find(log => {
            try {
                const parsed = marketplace.interface.parseLog(log);
                return parsed?.name === 'LoanRequested';
            } catch { return false; }
        });

        const carolLoanId = loanRequestedEvent
            ? marketplace.interface.parseLog(loanRequestedEvent).args.loanId
            : null;

        console.log(`✅ Carol's loan created! Loan ID: ${carolLoanId}\n`);

        const carolLoan = await marketplace.loans(carolLoanId);
        console.log(`Interest Rate: ${Number(carolLoan.interestRate) / 100}% APR`);
        console.log(`Collateral: ${ethers.formatUnits(carolLoan.collateralAmount, 6)} USDC\n`);

        results.loansCreated.push({
            agent: 'Carol',
            loanId: carolLoanId.toString(),
            amount: ethers.formatUnits(loanAmount, 6),
            duration: durationDays,
            interestRate: Number(carolLoan.interestRate) / 100
        });

        console.log('Waiting 15 seconds...\n');
        await new Promise(resolve => setTimeout(resolve, 15000));

    } catch (error) {
        console.log(`❌ Carol's loan failed: ${error.message}\n`);
        results.errors.push({ test: 'Carol loan', error: error.message });
    }

    // ═══════════════════════════════════════════════
    // TEST 3: Dave Gets a Small Loan
    // ═══════════════════════════════════════════════
    console.log('TEST 3: Dave Gets a Small Loan\n');

    try {
        const dave = testAgents.find(a => a.name === 'Dave');
        const daveWallet = new ethers.Wallet(dave.privateKey, ethers.provider);

        const davePool = await marketplace.agentPools(dave.agentId);
        console.log(`Dave's Pool: ${ethers.formatUnits(davePool.totalLiquidity, 6)} USDC\n`);

        const initialRep = await reputationManager['getReputationScore(address)'](dave.address);
        const creditLimit = await reputationManager.calculateCreditLimit(dave.address);

        console.log(`Dave's Reputation: ${initialRep}`);
        console.log(`Dave's Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC\n`);

        const loanAmount = ethers.parseUnits('200', 6);
        const durationDays = 7;

        console.log(`Requesting ${ethers.formatUnits(loanAmount, 6)} USDC for ${durationDays} days...`);

        const requestTx = await marketplace.connect(daveWallet).requestLoan(loanAmount, durationDays);
        const receipt = await requestTx.wait();

        const loanRequestedEvent = receipt.logs.find(log => {
            try {
                const parsed = marketplace.interface.parseLog(log);
                return parsed?.name === 'LoanRequested';
            } catch { return false; }
        });

        const daveLoanId = loanRequestedEvent
            ? marketplace.interface.parseLog(loanRequestedEvent).args.loanId
            : null;

        console.log(`✅ Dave's loan created! Loan ID: ${daveLoanId}\n`);

        const daveLoan = await marketplace.loans(daveLoanId);
        console.log(`Interest Rate: ${Number(daveLoan.interestRate) / 100}% APR`);
        console.log(`Collateral: ${ethers.formatUnits(daveLoan.collateralAmount, 6)} USDC\n`);

        results.loansCreated.push({
            agent: 'Dave',
            loanId: daveLoanId.toString(),
            amount: ethers.formatUnits(loanAmount, 6),
            duration: durationDays,
            interestRate: Number(daveLoan.interestRate) / 100
        });

    } catch (error) {
        console.log(`❌ Dave's loan failed: ${error.message}\n`);
        results.errors.push({ test: 'Dave loan', error: error.message });
    }

    // ═══════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 ADVANCED TEST RESULTS\n');

    console.log(`Total Loans Created: ${results.loansCreated.length}\n`);

    if (results.loansCreated.length > 0) {
        console.log('✅ ACTIVE LOANS:\n');
        results.loansCreated.forEach(loan => {
            console.log(`${loan.agent}:`);
            console.log(`  - Loan ID: ${loan.loanId}`);
            console.log(`  - Amount: ${loan.amount} USDC`);
            console.log(`  - Duration: ${loan.duration} days`);
            console.log(`  - Interest Rate: ${loan.interestRate}% APR`);
            console.log('');
        });
    }

    if (results.errors.length > 0) {
        console.log('⚠️  ERRORS:\n');
        results.errors.forEach(err => {
            console.log(`${err.test}: ${err.error}`);
        });
        console.log('');
    }

    // Show current pool states
    console.log('💰 CURRENT POOL STATES:\n');
    for (const agent of testAgents) {
        const pool = await marketplace.agentPools(agent.agentId);
        const rep = await reputationManager['getReputationScore(address)'](agent.address);

        console.log(`${agent.name}:`);
        console.log(`  - Reputation: ${rep}`);
        console.log(`  - Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
        console.log(`  - Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
        console.log(`  - Loaned: ${ethers.formatUnits(pool.totalLoaned, 6)} USDC`);
        console.log('');
    }

    // Save results
    const resultsPath = path.join(__dirname, '..', 'advanced-test-results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));
    console.log(`📁 Results saved to: advanced-test-results.json\n`);

    console.log('✅ Advanced testing complete! 🚀\n');
    console.log('💡 Next: Repay these loans to test reputation increases\n');
}

main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
