/**
 * V3 Stress Test
 * High-volume testing with many loans
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log('\n🔥 V3 STRESS TEST - HIGH VOLUME\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [signer] = await ethers.getSigners();

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const lendingPool = await ethers.getContractAt('LendingPoolV3', addresses.lendingPool);
    const reputationManager = await ethers.getContractAt('ReputationManagerV2', addresses.reputationManager);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    // Get state
    const reputation = await reputationManager['getReputationScore(address)'](signer.address);
    const creditLimit = await reputationManager['calculateCreditLimit(address)'](signer.address);
    const poolLiquidity = await lendingPool.availableLiquidity();

    console.log('📊 Starting State:');
    console.log('  Reputation:', reputation.toString());
    console.log('  Credit Limit:', ethers.formatUnits(creditLimit, 6), 'USDC');
    console.log('  Pool Liquidity:', ethers.formatUnits(poolLiquidity, 6), 'USDC');
    console.log('');

    // Generate 20 diverse test scenarios
    const scenarios = [
        // Small loans - quick turnaround
        { amount: 100, duration: 7 },
        { amount: 250, duration: 7 },
        { amount: 500, duration: 7 },
        { amount: 750, duration: 14 },
        { amount: 1000, duration: 14 },

        // Medium loans - standard terms
        { amount: 2000, duration: 30 },
        { amount: 3500, duration: 30 },
        { amount: 5000, duration: 45 },
        { amount: 6000, duration: 60 },
        { amount: 7500, duration: 60 },

        // Large loans - longer terms
        { amount: 10000, duration: 90 },
        { amount: 12500, duration: 120 },
        { amount: 15000, duration: 180 },
        { amount: 17500, duration: 270 },
        { amount: 20000, duration: 365 },

        // Mixed
        { amount: 4000, duration: 75 },
        { amount: 8000, duration: 100 },
        { amount: 11000, duration: 150 },
        { amount: 13000, duration: 200 },
        { amount: 9000, duration: 120 },
    ];

    let successfulLoans = 0;
    let failedLoans = 0;
    let totalFeesExpected = 0n;
    let totalApprovalTime = 0;
    let totalLoaned = 0n;
    const loanIds = [];

    console.log(`🚀 Running ${scenarios.length} loan requests...\n`);
    console.log('═══════════════════════════════════════════════════════\n');

    for (let i = 0; i < scenarios.length; i++) {
        const scenario = scenarios[i];
        const loanAmount = ethers.parseUnits(scenario.amount.toString(), 6);

        console.log(`[${i + 1}/${scenarios.length}] ${scenario.amount} USDC / ${scenario.duration} days`);

        try {
            // Pre-check
            const canAutoApprove = await lendingPool.canAutoApprove(signer.address, loanAmount);

            if (!canAutoApprove) {
                console.log('  ⚠️  Would not auto-approve - skipping');
                failedLoans++;
                console.log('');
                continue;
            }

            // Request loan
            const startTime = Date.now();
            const requestTx = await lendingPool.requestLoan(loanAmount, scenario.duration);
            const receipt = await requestTx.wait();
            const endTime = Date.now();

            const approvalTime = endTime - startTime;
            totalApprovalTime += approvalTime;

            // Check approval
            const approveEvent = receipt.logs.find(log => {
                try {
                    return lendingPool.interface.parseLog(log)?.name === 'LoanApproved';
                } catch { return false; }
            });

            if (approveEvent) {
                const parsed = lendingPool.interface.parseLog(approveEvent);
                const loanId = parsed.args.loanId;
                loanIds.push(loanId);

                // Get loan details
                const loan = await lendingPool.loans(loanId);
                const interest = (loan.amount * loan.interestRate * BigInt(scenario.duration)) / (10000n * 365n);
                totalFeesExpected += interest;
                totalLoaned += loan.amount;

                console.log(`  ✅ APPROVED (${approvalTime}ms) - ID: ${loanId} - Interest: ${ethers.formatUnits(interest, 6)} USDC`);
                successfulLoans++;
            } else {
                console.log('  ❌ Not approved');
                failedLoans++;
            }

        } catch (error) {
            console.log('  ❌ Error:', error.message.split('\n')[0].substring(0, 80));
            failedLoans++;
        }

        console.log('');

        // Small delay
        if (i < scenarios.length - 1) {
            await sleep(3000);
        }
    }

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 STRESS TEST RESULTS:\n');
    console.log('Total Requests:', scenarios.length);
    console.log('✅ Successful:', successfulLoans);
    console.log('❌ Failed:', failedLoans);
    console.log('Success Rate:', ((successfulLoans / scenarios.length) * 100).toFixed(1) + '%');
    console.log('');
    console.log('💰 Financial Metrics:');
    console.log('  Total Loaned:', ethers.formatUnits(totalLoaned, 6), 'USDC');
    console.log('  Expected Fees:', ethers.formatUnits(totalFeesExpected, 6), 'USDC');
    console.log('  Average Loan Size:', ethers.formatUnits(totalLoaned / BigInt(successfulLoans), 6), 'USDC');
    console.log('');
    console.log('⚡ Performance:');
    console.log('  Average Approval Time:', (totalApprovalTime / successfulLoans).toFixed(0) + 'ms');
    console.log('  Throughput:', (successfulLoans / (totalApprovalTime / 1000 / 60)).toFixed(1), 'loans/minute');
    console.log('');
    console.log('Loan IDs:', loanIds.slice(0, 10).join(', '), loanIds.length > 10 ? `... (${loanIds.length} total)` : '');

    // Final pool state
    const finalPoolLiquidity = await lendingPool.availableLiquidity();
    const finalTotalLoaned = await lendingPool.totalLoaned();

    console.log('\n📊 Pool State:');
    console.log('  Available Liquidity:', ethers.formatUnits(finalPoolLiquidity, 6), 'USDC');
    console.log('  Total Loaned:', ethers.formatUnits(finalTotalLoaned, 6), 'USDC');
    console.log('  Utilization:', ((Number(finalTotalLoaned) / (Number(finalPoolLiquidity) + Number(finalTotalLoaned))) * 100).toFixed(1) + '%');

    console.log('\n✅ Stress Test Complete!');
    console.log('🎯 Next: Repay all loans');
    console.log('   npx hardhat run scripts/repay-all-v3-loans.js --network sepolia\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
