/**
 * Run All P2P Marketplace Tests
 * Automated test suite with detailed reporting
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

class TestReporter {
    constructor() {
        this.tests = [];
        this.startTime = Date.now();
    }

    addTest(name, status, details = {}) {
        this.tests.push({
            name,
            status, // 'pass', 'fail', 'skip'
            details,
            timestamp: Date.now()
        });
    }

    addError(testName, error) {
        this.addTest(testName, 'fail', { error: error.message, stack: error.stack });
    }

    generateReport() {
        const passed = this.tests.filter(t => t.status === 'pass').length;
        const failed = this.tests.filter(t => t.status === 'fail').length;
        const skipped = this.tests.filter(t => t.status === 'skip').length;
        const duration = Date.now() - this.startTime;

        const report = {
            summary: {
                total: this.tests.length,
                passed,
                failed,
                skipped,
                duration: `${(duration / 1000).toFixed(2)}s`,
                successRate: `${((passed / this.tests.length) * 100).toFixed(1)}%`
            },
            tests: this.tests,
            timestamp: new Date().toISOString()
        };

        return report;
    }

    printReport() {
        const report = this.generateReport();

        console.log('\n═══════════════════════════════════════════════════════');
        console.log('📊 P2P MARKETPLACE TEST REPORT');
        console.log('═══════════════════════════════════════════════════════\n');

        console.log('📈 Summary:');
        console.log(`   Total Tests:    ${report.summary.total}`);
        console.log(`   ✅ Passed:      ${report.summary.passed}`);
        console.log(`   ❌ Failed:      ${report.summary.failed}`);
        console.log(`   ⏭️  Skipped:     ${report.summary.skipped}`);
        console.log(`   ⏱️  Duration:    ${report.summary.duration}`);
        console.log(`   📊 Success Rate: ${report.summary.successRate}`);
        console.log('');

        console.log('📋 Test Results:\n');

        report.tests.forEach((test, idx) => {
            const icon = test.status === 'pass' ? '✅' : test.status === 'fail' ? '❌' : '⏭️';
            console.log(`${idx + 1}. ${icon} ${test.name}`);

            if (test.details.error) {
                console.log(`   Error: ${test.details.error}`);
            }
            if (test.details.gasUsed) {
                console.log(`   Gas Used: ${test.details.gasUsed.toLocaleString()}`);
            }
            if (test.details.value) {
                console.log(`   Value: ${test.details.value}`);
            }
        });

        console.log('\n═══════════════════════════════════════════════════════\n');

        // Save report to file
        const reportPath = path.join(__dirname, '..', 'p2p-test-report.json');
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
        console.log(`📁 Report saved to: p2p-test-report.json\n`);

        return report;
    }
}

async function main() {
    console.log('\n🧪 Running Comprehensive P2P Marketplace Tests\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const reporter = new TestReporter();
    const [deployer] = await ethers.getSigners();

    // Load addresses
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    // Check if marketplace deployed
    if (!addresses.agentLiquidityMarketplace) {
        console.log('❌ AgentLiquidityMarketplace not deployed yet!');
        console.log('   Run: npx hardhat run scripts/deploy-liquidity-marketplace.js --network sepolia\n');
        process.exit(1);
    }

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);

    console.log('📋 Test Configuration:');
    console.log(`   Marketplace: ${addresses.agentLiquidityMarketplace}`);
    console.log(`   Deployer: ${deployer.address}`);
    console.log('');

    // Load test agents
    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    let testAgents;
    try {
        testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));
    } catch (e) {
        console.log('❌ test-agents.json not found!');
        console.log('   Run: npx hardhat run scripts/create-test-agents.js --network sepolia\n');
        process.exit(1);
    }

    const alice = testAgents[0];
    const bob = testAgents[1];
    const aliceWallet = new ethers.Wallet(alice.privateKey, ethers.provider);
    const bobWallet = new ethers.Wallet(bob.privateKey, ethers.provider);

    // =============================================
    // TEST 1: Contract Deployment Check
    // =============================================
    console.log('TEST 1: Verify Contract Deployment\n');
    try {
        const owner = await marketplace.owner();
        const platformFee = await marketplace.platformFeeRate();

        reporter.addTest('Contract deployed', 'pass', {
            owner,
            platformFee: Number(platformFee)
        });
        console.log(`✅ Contract deployed at ${addresses.agentLiquidityMarketplace}`);
        console.log(`   Owner: ${owner}`);
        console.log(`   Platform Fee: ${Number(platformFee) / 100}%`);
    } catch (error) {
        reporter.addError('Contract deployment check', error);
        console.log(`❌ Failed: ${error.message}`);
    }
    console.log('');

    // =============================================
    // TEST 2: Create Agent Pools
    // =============================================
    console.log('TEST 2: Create Agent Pools\n');

    for (const agent of [alice, bob]) {
        try {
            const wallet = new ethers.Wallet(agent.privateKey, ethers.provider);
            const pool = await marketplace.agentPools(agent.agentId);

            if (pool.isActive) {
                reporter.addTest(`${agent.name} pool exists`, 'skip');
                console.log(`⏭️  ${agent.name}'s pool already exists`);
            } else {
                const tx = await marketplace.connect(wallet).createAgentPool();
                const receipt = await tx.wait();

                reporter.addTest(`Create ${agent.name} pool`, 'pass', {
                    gasUsed: Number(receipt.gasUsed)
                });
                console.log(`✅ ${agent.name}'s pool created (Gas: ${receipt.gasUsed.toLocaleString()})`);
            }
        } catch (error) {
            reporter.addError(`Create ${agent.name} pool`, error);
            console.log(`❌ ${agent.name} pool creation failed: ${error.message}`);
        }
    }
    console.log('');

    // =============================================
    // TEST 3: Supply Liquidity
    // =============================================
    console.log('TEST 3: Supply Liquidity to Alice\'s Pool\n');

    const supplyAmount = ethers.parseUnits('10000', 6);

    try {
        const balanceBefore = await usdc.balanceOf(deployer.address);

        await usdc.approve(addresses.agentLiquidityMarketplace, supplyAmount);
        const tx = await marketplace.supplyLiquidity(alice.agentId, supplyAmount);
        const receipt = await tx.wait();

        const balanceAfter = await usdc.balanceOf(deployer.address);
        const transferred = balanceBefore - balanceAfter;

        reporter.addTest('Supply liquidity', 'pass', {
            gasUsed: Number(receipt.gasUsed),
            value: ethers.formatUnits(transferred, 6) + ' USDC'
        });

        console.log(`✅ Supplied ${ethers.formatUnits(transferred, 6)} USDC`);
        console.log(`   Gas Used: ${receipt.gasUsed.toLocaleString()}`);
    } catch (error) {
        reporter.addError('Supply liquidity', error);
        console.log(`❌ Failed: ${error.message}`);
    }
    console.log('');

    // =============================================
    // TEST 4: Check Pool State
    // =============================================
    console.log('TEST 4: Verify Pool State After Supply\n');

    try {
        const pool = await marketplace.getAgentPool(alice.agentId);
        const position = await marketplace.getLenderPosition(alice.agentId, deployer.address);

        const expectedLiquidity = supplyAmount;
        const actualLiquidity = pool.totalLiquidity;

        if (actualLiquidity >= expectedLiquidity) {
            reporter.addTest('Pool liquidity correct', 'pass', {
                value: ethers.formatUnits(actualLiquidity, 6) + ' USDC'
            });
            console.log(`✅ Pool liquidity: ${ethers.formatUnits(actualLiquidity, 6)} USDC`);
        } else {
            reporter.addTest('Pool liquidity incorrect', 'fail', {
                expected: ethers.formatUnits(expectedLiquidity, 6),
                actual: ethers.formatUnits(actualLiquidity, 6)
            });
            console.log(`❌ Pool liquidity mismatch`);
        }

        console.log(`   Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
        console.log(`   Lenders: ${pool.lenderCount}`);
        console.log(`   Your Position: ${ethers.formatUnits(position.amount, 6)} USDC`);
    } catch (error) {
        reporter.addError('Pool state verification', error);
        console.log(`❌ Failed: ${error.message}`);
    }
    console.log('');

    // =============================================
    // TEST 5: Request Loan
    // =============================================
    console.log('TEST 5: Alice Requests Loan from Her Pool\n');

    const loanAmount = ethers.parseUnits('5000', 6);
    const duration = 30; // 30 days

    try {
        // Get collateral requirement
        const collateralPercent = await reputationManager.calculateCollateralRequirement(alice.address);
        const requiredCollateral = (loanAmount * collateralPercent) / 100n;

        console.log(`   Loan Amount: ${ethers.formatUnits(loanAmount, 6)} USDC`);
        console.log(`   Duration: ${duration} days`);
        console.log(`   Collateral: ${ethers.formatUnits(requiredCollateral, 6)} USDC (${collateralPercent}%)`);
        console.log('');

        // Approve collateral
        if (requiredCollateral > 0) {
            await usdc.connect(aliceWallet).approve(addresses.agentLiquidityMarketplace, requiredCollateral);
        }

        // Request loan
        const tx = await marketplace.connect(aliceWallet).requestLoan(loanAmount, duration);
        const receipt = await tx.wait();

        // Get loan ID from event
        const disbursedEvent = receipt.logs.find(log => {
            try {
                return marketplace.interface.parseLog(log)?.name === 'LoanDisbursed';
            } catch { return false; }
        });

        if (disbursedEvent) {
            const loanId = marketplace.interface.parseLog(disbursedEvent).args.loanId;

            reporter.addTest('Request loan', 'pass', {
                gasUsed: Number(receipt.gasUsed),
                loanId: Number(loanId)
            });

            console.log(`✅ Loan disbursed! ID: ${loanId}`);
            console.log(`   Gas Used: ${receipt.gasUsed.toLocaleString()}`);

            // Save loan ID for repayment
            global.testLoanId = loanId;
        } else {
            reporter.addTest('Loan disbursement', 'fail', { error: 'No LoanDisbursed event' });
            console.log(`❌ Loan not disbursed`);
        }
    } catch (error) {
        reporter.addError('Request loan', error);
        console.log(`❌ Failed: ${error.message}`);
    }
    console.log('');

    // =============================================
    // TEST 6: Interest Calculation
    // =============================================
    console.log('TEST 6: Verify Interest Calculation\n');

    if (global.testLoanId) {
        try {
            const loan = await marketplace.loans(global.testLoanId);
            const interest = await marketplace.calculateInterest(
                loan.amount,
                loan.interestRate,
                loan.duration
            );

            // Manual calculation
            const annualRate = Number(loan.interestRate);
            const durationDays = Number(loan.duration) / 86400;
            const expectedInterest = (Number(loan.amount) * annualRate * durationDays) / (10000 * 365);
            const calculatedInterest = Number(interest);

            // Allow 1% tolerance for rounding
            const tolerance = expectedInterest * 0.01;
            const isCorrect = Math.abs(calculatedInterest - expectedInterest) <= tolerance;

            if (isCorrect) {
                reporter.addTest('Interest calculation', 'pass', {
                    expected: expectedInterest.toFixed(2),
                    actual: calculatedInterest.toFixed(2)
                });
                console.log(`✅ Interest calculation correct`);
            } else {
                reporter.addTest('Interest calculation', 'fail', {
                    expected: expectedInterest.toFixed(2),
                    actual: calculatedInterest.toFixed(2),
                    difference: (calculatedInterest - expectedInterest).toFixed(2)
                });
                console.log(`❌ Interest calculation mismatch`);
            }

            console.log(`   Expected: ${(expectedInterest / 1e6).toFixed(6)} USDC`);
            console.log(`   Calculated: ${ethers.formatUnits(interest, 6)} USDC`);
            console.log(`   Rate: ${annualRate / 100}% APR`);
            console.log(`   Duration: ${durationDays.toFixed(0)} days`);
        } catch (error) {
            reporter.addError('Interest calculation', error);
            console.log(`❌ Failed: ${error.message}`);
        }
    } else {
        reporter.addTest('Interest calculation', 'skip');
        console.log(`⏭️  Skipped (no active loan)`);
    }
    console.log('');

    // =============================================
    // TEST 7: Repay Loan
    // =============================================
    console.log('TEST 7: Alice Repays Loan\n');

    if (global.testLoanId) {
        try {
            const loan = await marketplace.loans(global.testLoanId);
            const interest = await marketplace.calculateInterest(
                loan.amount,
                loan.interestRate,
                loan.duration
            );
            const totalRepayment = loan.amount + interest;

            console.log(`   Principal: ${ethers.formatUnits(loan.amount, 6)} USDC`);
            console.log(`   Interest: ${ethers.formatUnits(interest, 6)} USDC`);
            console.log(`   Total: ${ethers.formatUnits(totalRepayment, 6)} USDC`);
            console.log('');

            // Approve and repay
            await usdc.connect(aliceWallet).approve(addresses.agentLiquidityMarketplace, totalRepayment);
            const tx = await marketplace.connect(aliceWallet).repayLoan(global.testLoanId);
            const receipt = await tx.wait();

            reporter.addTest('Repay loan', 'pass', {
                gasUsed: Number(receipt.gasUsed),
                amount: ethers.formatUnits(totalRepayment, 6) + ' USDC'
            });

            console.log(`✅ Loan repaid!`);
            console.log(`   Gas Used: ${receipt.gasUsed.toLocaleString()}`);
        } catch (error) {
            reporter.addError('Repay loan', error);
            console.log(`❌ Failed: ${error.message}`);
        }
    } else {
        reporter.addTest('Repay loan', 'skip');
        console.log(`⏭️  Skipped (no active loan)`);
    }
    console.log('');

    // =============================================
    // TEST 8: Interest Distribution
    // =============================================
    console.log('TEST 8: Verify Interest Distribution to Lender\n');

    try {
        const position = await marketplace.getLenderPosition(alice.agentId, deployer.address);

        if (position.earnedInterest > 0) {
            reporter.addTest('Interest distributed', 'pass', {
                value: ethers.formatUnits(position.earnedInterest, 6) + ' USDC'
            });
            console.log(`✅ Lender earned: ${ethers.formatUnits(position.earnedInterest, 6)} USDC`);
        } else {
            reporter.addTest('Interest distribution', 'fail', {
                error: 'No interest earned'
            });
            console.log(`❌ No interest distributed`);
        }
    } catch (error) {
        reporter.addError('Interest distribution', error);
        console.log(`❌ Failed: ${error.message}`);
    }
    console.log('');

    // =============================================
    // TEST 9: Claim Interest
    // =============================================
    console.log('TEST 9: Lender Claims Earned Interest\n');

    try {
        const position = await marketplace.getLenderPosition(alice.agentId, deployer.address);

        if (position.earnedInterest > 0) {
            const balanceBefore = await usdc.balanceOf(deployer.address);

            const tx = await marketplace.claimInterest(alice.agentId);
            const receipt = await tx.wait();

            const balanceAfter = await usdc.balanceOf(deployer.address);
            const claimed = balanceAfter - balanceBefore;

            reporter.addTest('Claim interest', 'pass', {
                gasUsed: Number(receipt.gasUsed),
                value: ethers.formatUnits(claimed, 6) + ' USDC'
            });

            console.log(`✅ Claimed: ${ethers.formatUnits(claimed, 6)} USDC`);
            console.log(`   Gas Used: ${receipt.gasUsed.toLocaleString()}`);
        } else {
            reporter.addTest('Claim interest', 'skip');
            console.log(`⏭️  No interest to claim`);
        }
    } catch (error) {
        reporter.addError('Claim interest', error);
        console.log(`❌ Failed: ${error.message}`);
    }
    console.log('');

    // =============================================
    // Generate Report
    // =============================================
    const report = reporter.printReport();

    // Exit with error code if any tests failed
    if (report.summary.failed > 0) {
        console.log('❌ Some tests failed. Please review and fix issues.\n');
        process.exit(1);
    } else {
        console.log('✅ All tests passed! P2P marketplace is working correctly.\n');
        process.exit(0);
    }
}

main().catch((error) => {
    console.error('\n❌ Test suite crashed:', error);
    process.exit(1);
});
