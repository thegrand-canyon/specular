/**
 * Comprehensive V3 Testing
 * Tests multiple loan scenarios with different amounts and durations
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    console.log('\n🧪 COMPREHENSIVE V3 TESTING\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [signer] = await ethers.getSigners();
    console.log('Test Agent:', signer.address);

    // Load addresses
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const lendingPool = await ethers.getContractAt('LendingPoolV3', addresses.lendingPool);
    const reputationManager = await ethers.getContractAt('ReputationManagerV2', addresses.reputationManager);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    // Get starting state
    const startReputation = await reputationManager['getReputationScore(address)'](signer.address);
    const startCreditLimit = await reputationManager['calculateCreditLimit(address)'](signer.address);
    const startPoolLiquidity = await lendingPool.availableLiquidity();
    const startBalance = await usdc.balanceOf(signer.address);

    console.log('📊 Starting State:');
    console.log('───────────────────────────────────────────────────────');
    console.log('Reputation:', startReputation.toString());
    console.log('Credit Limit:', ethers.formatUnits(startCreditLimit, 6), 'USDC');
    console.log('Pool Liquidity:', ethers.formatUnits(startPoolLiquidity, 6), 'USDC');
    console.log('Agent Balance:', ethers.formatUnits(startBalance, 6), 'USDC');
    console.log('');

    // Test scenarios
    const testScenarios = [
        { amount: 500, duration: 7, name: '500 USDC / 7 days (minimum duration)' },
        { amount: 1000, duration: 30, name: '1,000 USDC / 30 days (standard)' },
        { amount: 2500, duration: 60, name: '2,500 USDC / 60 days (medium)' },
        { amount: 5000, duration: 90, name: '5,000 USDC / 90 days (quarter)' },
        { amount: 10000, duration: 180, name: '10,000 USDC / 180 days (half year)' },
        { amount: 15000, duration: 365, name: '15,000 USDC / 365 days (maximum duration)' },
        { amount: 3000, duration: 45, name: '3,000 USDC / 45 days' },
        { amount: 7500, duration: 120, name: '7,500 USDC / 120 days' },
        { amount: 20000, duration: 90, name: '20,000 USDC / 90 days (large loan)' },
        { amount: 1500, duration: 14, name: '1,500 USDC / 14 days (short term)' },
    ];

    let successfulLoans = 0;
    let totalFeesEarned = 0n;
    let totalApprovalTime = 0;
    const loanIds = [];

    console.log('🚀 Running Test Scenarios:\n');
    console.log('═══════════════════════════════════════════════════════\n');

    for (let i = 0; i < testScenarios.length; i++) {
        const scenario = testScenarios[i];
        const loanAmount = ethers.parseUnits(scenario.amount.toString(), 6);

        console.log(`Test ${i + 1}/${testScenarios.length}: ${scenario.name}`);
        console.log('─────────────────────────────────────────');

        try {
            // Pre-check
            const canAutoApprove = await lendingPool.canAutoApprove(signer.address, loanAmount);
            console.log('Can Auto-Approve:', canAutoApprove ? '✅ YES' : '❌ NO');

            if (!canAutoApprove) {
                console.log('⚠️  Skipping - would not auto-approve\n');
                continue;
            }

            // Request loan
            const startTime = Date.now();
            const balanceBefore = await usdc.balanceOf(signer.address);

            console.log('⏳ Requesting loan...');
            const requestTx = await lendingPool.requestLoan(loanAmount, scenario.duration);
            const receipt = await requestTx.wait();

            const endTime = Date.now();
            const approvalTime = endTime - startTime;
            totalApprovalTime += approvalTime;

            // Check if approved
            const approveEvent = receipt.logs.find(log => {
                try {
                    return lendingPool.interface.parseLog(log)?.name === 'LoanApproved';
                } catch { return false; }
            });

            if (approveEvent) {
                const parsed = lendingPool.interface.parseLog(approveEvent);
                const loanId = parsed.args.loanId;
                const autoApproved = parsed.args.autoApproved;

                loanIds.push(loanId);

                const balanceAfter = await usdc.balanceOf(signer.address);
                const received = balanceAfter - balanceBefore;

                // Get loan details
                const loan = await lendingPool.loans(loanId);
                const interest = (loan.amount * loan.interestRate * BigInt(scenario.duration)) / (10000n * 365n);
                totalFeesEarned += interest;

                console.log('✅ APPROVED!');
                console.log('   Loan ID:', loanId.toString());
                console.log('   Auto-Approved:', autoApproved ? 'YES ⚡' : 'NO');
                console.log('   Approval Time:', approvalTime + 'ms');
                console.log('   Received:', ethers.formatUnits(received, 6), 'USDC');
                console.log('   Interest Rate:', (Number(loan.interestRate) / 100).toFixed(2), '% APR');
                console.log('   Expected Interest:', ethers.formatUnits(interest, 6), 'USDC');

                successfulLoans++;
            } else {
                console.log('❌ Not approved');
            }

        } catch (error) {
            console.log('❌ Error:', error.message.split('\n')[0]);
        }

        console.log('');

        // Delay between requests to avoid nonce issues
        if (i < testScenarios.length - 1) {
            await sleep(5000);
        }
    }

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 Test Summary:\n');
    console.log('Total Scenarios:', testScenarios.length);
    console.log('Successful Loans:', successfulLoans);
    console.log('Success Rate:', ((successfulLoans / testScenarios.length) * 100).toFixed(1) + '%');
    console.log('Average Approval Time:', (totalApprovalTime / successfulLoans).toFixed(0) + 'ms');
    console.log('Total Expected Fees:', ethers.formatUnits(totalFeesEarned, 6), 'USDC');
    console.log('Loan IDs:', loanIds.join(', '));

    // Check final state
    const endPoolLiquidity = await lendingPool.availableLiquidity();
    const endBalance = await usdc.balanceOf(signer.address);
    const totalLoaned = await lendingPool.totalLoaned();

    console.log('\n📊 Final State:');
    console.log('───────────────────────────────────────────────────────');
    console.log('Pool Available:', ethers.formatUnits(endPoolLiquidity, 6), 'USDC');
    console.log('Pool Total Loaned:', ethers.formatUnits(totalLoaned, 6), 'USDC');
    console.log('Agent Balance:', ethers.formatUnits(endBalance, 6), 'USDC');
    console.log('Balance Increase:', ethers.formatUnits(endBalance - startBalance, 6), 'USDC');

    console.log('\n✅ Testing Phase 1 Complete!');
    console.log('\n🎯 Next: Repay all loans to complete the cycle');
    console.log('   Run: npx hardhat run scripts/repay-all-v3-loans.js --network sepolia\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
