/**
 * Simulate Agent Activity
 *
 * This script simulates realistic agent behavior:
 * 1. Agents request loans based on their credit limit
 * 2. Pool owner approves loans
 * 3. Agents repay loans to build reputation
 *
 * Usage: npx hardhat run scripts/simulate-agent-activity.js --network sepolia
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

const SEPOLIA_ADDRESSES = {
    agentRegistry: '0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb',
    reputationManager: '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF',
    lendingPool: '0x5592A6d7bF1816f77074b62911D50Dad92A3212b',
    mockUSDC: '0x771c293167AeD146EC4f56479056645Be46a0275'
};

async function main() {
    console.log('\n🤖 Simulating Agent Activity...\n');

    // Load test agents
    const agentsFile = path.join(__dirname, '..', 'test-agents.json');
    if (!fs.existsSync(agentsFile)) {
        console.log('❌ No test agents found!');
        console.log('Run: npx hardhat run scripts/create-test-agents.js --network sepolia');
        process.exit(1);
    }

    const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
    console.log(`Found ${agents.length} test agents\n`);

    const [deployer] = await ethers.getSigners();
    console.log('Pool owner:', deployer.address);

    // Get contract instances
    const lendingPool = await ethers.getContractAt('LendingPoolV2', SEPOLIA_ADDRESSES.lendingPool);
    const reputationManager = await ethers.getContractAt('ReputationManagerV2', SEPOLIA_ADDRESSES.reputationManager);
    const usdc = await ethers.getContractAt('MockUSDC', SEPOLIA_ADDRESSES.mockUSDC);

    // Verify pool owner
    const poolOwner = await lendingPool.owner();
    if (deployer.address.toLowerCase() !== poolOwner.toLowerCase()) {
        console.log('❌ Error: You are not the pool owner');
        console.log('Expected:', poolOwner);
        console.log('Got:', deployer.address);
        process.exit(1);
    }

    console.log('✅ Verified as pool owner\n');

    // Phase 1: Agents request loans
    console.log('═════════════════════════════════════');
    console.log('PHASE 1: AGENTS REQUEST LOANS');
    console.log('═════════════════════════════════════\n');

    const loanRequests = [];

    for (const agent of agents) {
        console.log(`\n🤖 ${agent.profile.name} (${agent.address.slice(0, 10)}...)`);
        console.log('─────────────────────────────────────');

        // Create wallet from private key
        const wallet = new ethers.Wallet(agent.privateKey, ethers.provider);

        // Check reputation and credit limit
        const reputation = await reputationManager['getReputationScore(address)'](wallet.address);
        const creditLimit = await reputationManager['calculateCreditLimit(address)'](wallet.address);
        const collateralRequired = await reputationManager['calculateCollateralRequirement(address)'](wallet.address);

        console.log('Reputation:', reputation.toString());
        console.log('Credit Limit:', ethers.formatUnits(creditLimit, 6), 'USDC');
        console.log('Collateral Required:', collateralRequired.toString(), '%');

        // Request a loan (start small - 50% of credit limit)
        const loanAmount = creditLimit / 2n;
        const duration = 30; // 30 days

        console.log(`\n⏳ Requesting loan: ${ethers.formatUnits(loanAmount, 6)} USDC for ${duration} days...`);

        try {
            // If collateral required, approve USDC
            if (collateralRequired > 0n) {
                const collateralAmount = (loanAmount * collateralRequired) / 100n;
                console.log('   Approving collateral:', ethers.formatUnits(collateralAmount, 6), 'USDC');

                const approveTx = await usdc.connect(wallet).approve(SEPOLIA_ADDRESSES.lendingPool, collateralAmount);
                await approveTx.wait();
            }

            // Request loan
            const requestTx = await lendingPool.connect(wallet).requestLoan(loanAmount, duration);
            const receipt = await requestTx.wait();

            // Get loan ID from event
            const event = receipt.logs.find(log => {
                try {
                    return lendingPool.interface.parseLog(log)?.name === 'LoanRequested';
                } catch {
                    return false;
                }
            });

            const loanId = lendingPool.interface.parseLog(event).args.loanId;
            console.log('✅ Loan requested! ID:', loanId.toString());

            loanRequests.push({
                agent: agent.profile.name,
                address: wallet.address,
                loanId: loanId.toString(),
                amount: loanAmount
            });

        } catch (error) {
            console.log('❌ Failed to request loan:', error.message);
        }
    }

    // Phase 2: Approve loans
    console.log('\n\n═════════════════════════════════════');
    console.log('PHASE 2: POOL OWNER APPROVES LOANS');
    console.log('═════════════════════════════════════\n');

    for (const request of loanRequests) {
        console.log(`\n💰 Approving loan #${request.loanId} for ${request.agent}...`);

        try {
            const approveTx = await lendingPool.approveLoan(request.loanId);
            await approveTx.wait();
            console.log('✅ Approved!');

            const loan = await lendingPool.loans(request.loanId);
            console.log('   Interest Rate:', (Number(loan.interestRate) / 100).toFixed(2), '% APR');
            console.log('   Due Date:', new Date(Number(loan.endTime) * 1000).toLocaleString());

        } catch (error) {
            console.log('❌ Failed to approve:', error.message);
        }
    }

    // Phase 3: Agents repay loans (simulate immediate repayment for testing)
    console.log('\n\n═════════════════════════════════════');
    console.log('PHASE 3: AGENTS REPAY LOANS');
    console.log('═════════════════════════════════════\n');

    for (const agent of agents) {
        const wallet = new ethers.Wallet(agent.privateKey, ethers.provider);

        // Find active loans for this agent
        const nextLoanId = await lendingPool.nextLoanId();

        for (let i = 1n; i < nextLoanId; i++) {
            const loan = await lendingPool.loans(i);

            if (loan.borrower === wallet.address && loan.state === 2) { // ACTIVE
                console.log(`\n🤖 ${agent.profile.name} repaying loan #${i}...`);
                console.log('─────────────────────────────────────');

                try {
                    // Calculate repayment amount
                    const interest = await lendingPool.calculateInterest(
                        loan.amount,
                        loan.interestRate,
                        loan.durationDays
                    );
                    const totalOwed = loan.amount + interest;
                    console.log('Amount owed:', ethers.formatUnits(totalOwed, 6), 'USDC');
                    console.log('  Principal:', ethers.formatUnits(loan.amount, 6), 'USDC');
                    console.log('  Interest:', ethers.formatUnits(interest, 6), 'USDC');

                    // Get reputation before
                    const repBefore = await reputationManager['getReputationScore(address)'](wallet.address);

                    // Approve USDC
                    console.log('⏳ Approving USDC...');
                    const approveTx = await usdc.connect(wallet).approve(SEPOLIA_ADDRESSES.lendingPool, totalOwed);
                    await approveTx.wait();

                    // Repay loan
                    console.log('⏳ Repaying loan...');
                    const repayTx = await lendingPool.connect(wallet).repayLoan(i);
                    await repayTx.wait();

                    // Get reputation after
                    const repAfter = await reputationManager['getReputationScore(address)'](wallet.address);
                    const repChange = repAfter - repBefore;

                    console.log('✅ Loan repaid!');
                    console.log('   Reputation:', repBefore.toString(), '→', repAfter.toString(), `(${repChange > 0n ? '+' : ''}${repChange})`);

                } catch (error) {
                    console.log('❌ Failed to repay:', error.message);
                }
            }
        }
    }

    // Summary
    console.log('\n\n═════════════════════════════════════');
    console.log('SIMULATION COMPLETE');
    console.log('═════════════════════════════════════\n');

    // Pool stats
    const totalLiquidity = await lendingPool.totalLiquidity();
    const availableLiquidity = await lendingPool.availableLiquidity();
    const totalLoaned = await lendingPool.totalLoaned();

    console.log('📊 Pool Statistics:');
    console.log('   Total Liquidity:', ethers.formatUnits(totalLiquidity, 6), 'USDC');
    console.log('   Available:', ethers.formatUnits(availableLiquidity, 6), 'USDC');
    console.log('   Currently Loaned:', ethers.formatUnits(totalLoaned, 6), 'USDC');

    // Calculate fees
    const expectedAvailable = totalLiquidity - totalLoaned;
    const accumulatedFees = availableLiquidity > expectedAvailable
        ? availableLiquidity - expectedAvailable
        : 0n;

    console.log('\n💰 Fees Earned:', ethers.formatUnits(accumulatedFees, 6), 'USDC');

    // Agent reputations
    console.log('\n🏆 Agent Reputations:');
    for (const agent of agents) {
        const wallet = new ethers.Wallet(agent.privateKey, ethers.provider);
        const reputation = await reputationManager['getReputationScore(address)'](wallet.address);
        console.log(`   ${agent.profile.name}: ${reputation.toString()} points`);
    }

    console.log('\n✅ Simulation complete!');
    console.log('\n💡 Check earnings with:');
    console.log('   npx hardhat run scripts/check-pool-earnings.js --network sepolia\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
