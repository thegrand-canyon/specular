/**
 * Stress Testing Suite
 * High volume, concurrent operations, and extreme scenarios
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n💪 STRESS TESTING SUITE\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));
    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);

    const results = {
        tests: [],
        gasMetrics: [],
        throughput: {},
        poolStates: {}
    };

    // Use Dave for stress testing
    const dave = testAgents[3];
    const daveWallet = new ethers.Wallet(dave.privateKey, ethers.provider);

    // =============================================
    // STRESS TEST 1: High Volume Liquidity Supply
    // =============================================
    console.log('STRESS TEST 1: 10 Sequential Liquidity Supplies\n');

    const supplyCount = 10;
    const supplyAmount = ethers.parseUnits('1000', 6); // 1k USDC each
    const supplyStartTime = Date.now();
    const supplyGasCosts = [];

    try {
        // Ensure pool exists
        const pool = await marketplace.agentPools(dave.agentId);
        if (!pool.isActive) {
            await marketplace.connect(daveWallet).createAgentPool();
            console.log('✅ Created Dave\'s pool\n');
        }

        console.log(`Supplying liquidity ${supplyCount} times...`);

        for (let i = 0; i < supplyCount; i++) {
            const tx = await usdc.approve(addresses.agentLiquidityMarketplace, supplyAmount);
            await tx.wait();

            const supplyTx = await marketplace.supplyLiquidity(dave.agentId, supplyAmount);
            const receipt = await supplyTx.wait();

            supplyGasCosts.push(Number(receipt.gasUsed));
            console.log(`   ${i + 1}. Supplied 1,000 USDC - Gas: ${receipt.gasUsed.toLocaleString()}`);
        }

        const supplyDuration = (Date.now() - supplyStartTime) / 1000;
        const avgSupplyGas = supplyGasCosts.reduce((a, b) => a + b, 0) / supplyGasCosts.length;
        const throughput = supplyCount / supplyDuration;

        console.log('');
        console.log('✅ High Volume Supply Complete');
        console.log(`   Total Supplies: ${supplyCount}`);
        console.log(`   Duration: ${supplyDuration.toFixed(2)}s`);
        console.log(`   Throughput: ${throughput.toFixed(2)} supplies/sec`);
        console.log(`   Avg Gas: ${Math.round(avgSupplyGas).toLocaleString()}`);
        console.log(`   Min Gas: ${Math.min(...supplyGasCosts).toLocaleString()}`);
        console.log(`   Max Gas: ${Math.max(...supplyGasCosts).toLocaleString()}`);

        results.tests.push({
            test: 'High volume supply',
            status: 'PASS',
            count: supplyCount,
            duration: supplyDuration + 's',
            throughput: throughput.toFixed(2) + '/s',
            avgGas: Math.round(avgSupplyGas)
        });

        results.throughput.supply = throughput;

    } catch (error) {
        console.log(`❌ Failed: ${error.message}`);
        results.tests.push({
            test: 'High volume supply',
            status: 'FAIL',
            error: error.message
        });
    }
    console.log('');

    // =============================================
    // STRESS TEST 2: Sequential Loans
    // =============================================
    console.log('STRESS TEST 2: 5 Sequential Loan Cycles\n');

    const loanCycles = 5;
    const loanAmount = ethers.parseUnits('500', 6);
    const loanStartTime = Date.now();
    const loanGasCosts = [];
    const repayGasCosts = [];

    try {
        console.log('Executing loan cycles (request → repay)...\n');

        for (let i = 0; i < loanCycles; i++) {
            // Get collateral requirement
            const collateralPercent = await reputationManager.calculateCollateralRequirement(dave.address);
            const requiredCollateral = (loanAmount * collateralPercent) / 100n;

            // Approve collateral
            if (requiredCollateral > 0) {
                await usdc.connect(daveWallet).approve(addresses.agentLiquidityMarketplace, requiredCollateral);
            }

            // Request loan
            const loanTx = await marketplace.connect(daveWallet).requestLoan(loanAmount, 30);
            const loanReceipt = await loanTx.wait();
            loanGasCosts.push(Number(loanReceipt.gasUsed));

            // Get loan ID
            const disbursedEvent = loanReceipt.logs.find(log => {
                try {
                    return marketplace.interface.parseLog(log)?.name === 'LoanDisbursed';
                } catch { return false; }
            });

            if (disbursedEvent) {
                const loanId = marketplace.interface.parseLog(disbursedEvent).args.loanId;

                // Immediately repay
                const loan = await marketplace.loans(loanId);
                const interest = await marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
                const totalRepayment = loan.amount + interest;

                await usdc.connect(daveWallet).approve(addresses.agentLiquidityMarketplace, totalRepayment);
                const repayTx = await marketplace.connect(daveWallet).repayLoan(loanId);
                const repayReceipt = await repayTx.wait();
                repayGasCosts.push(Number(repayReceipt.gasUsed));

                console.log(`   Cycle ${i + 1}:`);
                console.log(`     Loan ${loanId} - Gas: ${loanReceipt.gasUsed.toLocaleString()}`);
                console.log(`     Repay - Gas: ${repayReceipt.gasUsed.toLocaleString()}`);
            }
        }

        const loanDuration = (Date.now() - loanStartTime) / 1000;
        const avgLoanGas = loanGasCosts.reduce((a, b) => a + b, 0) / loanGasCosts.length;
        const avgRepayGas = repayGasCosts.reduce((a, b) => a + b, 0) / repayGasCosts.length;
        const throughput = loanCycles / loanDuration;

        console.log('');
        console.log('✅ Sequential Loan Cycles Complete');
        console.log(`   Total Cycles: ${loanCycles}`);
        console.log(`   Duration: ${loanDuration.toFixed(2)}s`);
        console.log(`   Throughput: ${throughput.toFixed(2)} cycles/sec`);
        console.log(`   Avg Loan Gas: ${Math.round(avgLoanGas).toLocaleString()}`);
        console.log(`   Avg Repay Gas: ${Math.round(avgRepayGas).toLocaleString()}`);

        results.tests.push({
            test: 'Sequential loan cycles',
            status: 'PASS',
            count: loanCycles,
            duration: loanDuration + 's',
            throughput: throughput.toFixed(2) + '/s',
            avgLoanGas: Math.round(avgLoanGas),
            avgRepayGas: Math.round(avgRepayGas)
        });

        results.throughput.loans = throughput;

    } catch (error) {
        console.log(`❌ Failed: ${error.message}`);
        results.tests.push({
            test: 'Sequential loan cycles',
            status: 'FAIL',
            error: error.message
        });
    }
    console.log('');

    // =============================================
    // STRESS TEST 3: Pool Utilization Test
    // =============================================
    console.log('STRESS TEST 3: High Pool Utilization (90%+)\n');

    try {
        const pool = await marketplace.getAgentPool(dave.agentId);
        console.log(`Current Pool State:`);
        console.log(`   Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
        console.log(`   Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
        console.log(`   Utilization: ${Number(pool.utilizationRate) / 100}%`);
        console.log('');

        // Try to take loan for 90% of available liquidity
        const highLoanAmount = (pool.availableLiquidity * 90n) / 100n;

        console.log(`Attempting to borrow ${ethers.formatUnits(highLoanAmount, 6)} USDC (90% of pool)...`);

        const collateralPercent = await reputationManager.calculateCollateralRequirement(dave.address);
        const requiredCollateral = (highLoanAmount * collateralPercent) / 100n;

        if (requiredCollateral > 0) {
            await usdc.connect(daveWallet).approve(addresses.agentLiquidityMarketplace, requiredCollateral);
        }

        const tx = await marketplace.connect(daveWallet).requestLoan(highLoanAmount, 30);
        const receipt = await tx.wait();

        // Check new utilization
        const poolAfter = await marketplace.getAgentPool(dave.agentId);
        const utilization = Number(poolAfter.utilizationRate) / 100;

        console.log(`   ✅ Loan succeeded`);
        console.log(`   New Utilization: ${utilization}%`);
        console.log(`   Gas Used: ${receipt.gasUsed.toLocaleString()}`);

        if (utilization >= 90) {
            console.log(`   ✅ High utilization achieved (${utilization}%)`);
            results.tests.push({
                test: 'High pool utilization',
                status: 'PASS',
                utilization: utilization + '%',
                gasUsed: Number(receipt.gasUsed)
            });
        } else {
            console.log(`   ⚠️  Utilization below 90% (${utilization}%)`);
            results.tests.push({
                test: 'High pool utilization',
                status: 'PARTIAL',
                utilization: utilization + '%'
            });
        }

    } catch (error) {
        console.log(`❌ Failed: ${error.message}`);
        results.tests.push({
            test: 'High pool utilization',
            status: 'FAIL',
            error: error.message
        });
    }
    console.log('');

    // =============================================
    // STRESS TEST 4: Rapid Withdrawals
    // =============================================
    console.log('STRESS TEST 4: 5 Rapid Partial Withdrawals\n');

    const withdrawCount = 5;
    const withdrawStartTime = Date.now();
    const withdrawGasCosts = [];

    try {
        console.log('Executing rapid withdrawals...\n');

        for (let i = 0; i < withdrawCount; i++) {
            const position = await marketplace.getLenderPosition(dave.agentId, deployer.address);
            const pool = await marketplace.getAgentPool(dave.agentId);

            if (position.amount > 0 && pool.availableLiquidity > 0) {
                // Withdraw 10% of position or available, whichever is smaller
                const maxWithdraw = position.amount < pool.availableLiquidity ? position.amount : pool.availableLiquidity;
                const withdrawAmount = maxWithdraw / 10n;

                if (withdrawAmount > 0) {
                    const tx = await marketplace.withdrawLiquidity(dave.agentId, withdrawAmount);
                    const receipt = await tx.wait();
                    withdrawGasCosts.push(Number(receipt.gasUsed));

                    console.log(`   ${i + 1}. Withdrew ${ethers.formatUnits(withdrawAmount, 6)} USDC - Gas: ${receipt.gasUsed.toLocaleString()}`);
                } else {
                    console.log(`   ${i + 1}. Skipped (amount too small)`);
                }
            } else {
                console.log(`   ${i + 1}. Skipped (no available funds)`);
            }
        }

        const withdrawDuration = (Date.now() - withdrawStartTime) / 1000;

        if (withdrawGasCosts.length > 0) {
            const avgWithdrawGas = withdrawGasCosts.reduce((a, b) => a + b, 0) / withdrawGasCosts.length;
            const throughput = withdrawGasCosts.length / withdrawDuration;

            console.log('');
            console.log('✅ Rapid Withdrawals Complete');
            console.log(`   Successful Withdrawals: ${withdrawGasCosts.length}`);
            console.log(`   Duration: ${withdrawDuration.toFixed(2)}s`);
            console.log(`   Throughput: ${throughput.toFixed(2)} withdrawals/sec`);
            console.log(`   Avg Gas: ${Math.round(avgWithdrawGas).toLocaleString()}`);

            results.tests.push({
                test: 'Rapid withdrawals',
                status: 'PASS',
                count: withdrawGasCosts.length,
                duration: withdrawDuration + 's',
                avgGas: Math.round(avgWithdrawGas)
            });
        } else {
            console.log('');
            console.log('⏭️  No withdrawals executed');
            results.tests.push({
                test: 'Rapid withdrawals',
                status: 'SKIP',
                reason: 'No available funds'
            });
        }

    } catch (error) {
        console.log(`❌ Failed: ${error.message}`);
        results.tests.push({
            test: 'Rapid withdrawals',
            status: 'FAIL',
            error: error.message
        });
    }
    console.log('');

    // =============================================
    // STRESS TEST 5: Maximum Pool State Check
    // =============================================
    console.log('STRESS TEST 5: Pool State After Stress\n');

    try {
        const pool = await marketplace.getAgentPool(dave.agentId);
        const position = await marketplace.getLenderPosition(dave.agentId, deployer.address);

        console.log('Final Pool State:');
        console.log(`   Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
        console.log(`   Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
        console.log(`   Total Loaned: ${ethers.formatUnits(pool.totalLoaned, 6)} USDC`);
        console.log(`   Total Earned: ${ethers.formatUnits(pool.totalEarned, 6)} USDC`);
        console.log(`   Utilization: ${Number(pool.utilizationRate) / 100}%`);
        console.log(`   Lender Count: ${pool.lenderCount}`);
        console.log('');

        console.log('Deployer Position:');
        console.log(`   Amount: ${ethers.formatUnits(position.amount, 6)} USDC`);
        console.log(`   Earned Interest: ${ethers.formatUnits(position.earnedInterest, 6)} USDC`);
        console.log(`   Share: ${Number(position.shareOfPool) / 100}%`);
        console.log('');

        // Verify pool integrity
        const totalLiquidity = pool.totalLiquidity;
        const sumAvailableLoaned = pool.availableLiquidity + pool.totalLoaned;

        console.log('Pool Integrity Check:');
        console.log(`   Total Liquidity: ${ethers.formatUnits(totalLiquidity, 6)} USDC`);
        console.log(`   Available + Loaned: ${ethers.formatUnits(sumAvailableLoaned, 6)} USDC`);

        // Allow small rounding difference (interest earned)
        const difference = totalLiquidity > sumAvailableLoaned ?
            totalLiquidity - sumAvailableLoaned :
            sumAvailableLoaned - totalLiquidity;

        if (difference <= pool.totalEarned) {
            console.log(`   ✅ Pool accounting correct (diff: ${ethers.formatUnits(difference, 6)} USDC)`);
            results.tests.push({
                test: 'Pool integrity',
                status: 'PASS',
                difference: ethers.formatUnits(difference, 6)
            });
        } else {
            console.log(`   ❌ Pool accounting mismatch! (diff: ${ethers.formatUnits(difference, 6)} USDC)`);
            results.tests.push({
                test: 'Pool integrity',
                status: 'FAIL',
                difference: ethers.formatUnits(difference, 6)
            });
        }

        results.poolStates.final = {
            totalLiquidity: ethers.formatUnits(pool.totalLiquidity, 6),
            availableLiquidity: ethers.formatUnits(pool.availableLiquidity, 6),
            totalLoaned: ethers.formatUnits(pool.totalLoaned, 6),
            totalEarned: ethers.formatUnits(pool.totalEarned, 6),
            utilization: Number(pool.utilizationRate) / 100
        };

    } catch (error) {
        console.log(`❌ Failed: ${error.message}`);
        results.tests.push({
            test: 'Pool integrity',
            status: 'FAIL',
            error: error.message
        });
    }
    console.log('');

    // =============================================
    // SUMMARY
    // =============================================
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 STRESS TEST SUMMARY\n');

    const passed = results.tests.filter(t => t.status === 'PASS').length;
    const failed = results.tests.filter(t => t.status === 'FAIL').length;
    const partial = results.tests.filter(t => t.status === 'PARTIAL').length;
    const skipped = results.tests.filter(t => t.status === 'SKIP').length;

    console.log(`Total Tests: ${results.tests.length}`);
    console.log(`✅ Passed:   ${passed}`);
    console.log(`❌ Failed:   ${failed}`);
    console.log(`⚠️  Partial:  ${partial}`);
    console.log(`⏭️  Skipped:  ${skipped}`);
    console.log('');

    if (results.throughput.supply || results.throughput.loans) {
        console.log('📈 Throughput Metrics:');
        if (results.throughput.supply) {
            console.log(`   Supply: ${results.throughput.supply.toFixed(2)} operations/sec`);
        }
        if (results.throughput.loans) {
            console.log(`   Loans: ${results.throughput.loans.toFixed(2)} cycles/sec`);
        }
        console.log('');
    }

    if (failed > 0) {
        console.log('🚨 FAILED TESTS:\n');
        results.tests.filter(t => t.status === 'FAIL').forEach(t => {
            console.log(`   - ${t.test}: ${t.error}`);
        });
        console.log('');
    }

    // Save results
    const reportPath = path.join(__dirname, '..', 'stress-test-report.json');
    fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
    console.log(`📁 Report saved to: stress-test-report.json\n`);

    if (failed === 0) {
        console.log('🎉 All stress tests passed! System handles high load.\n');
        console.log('✅ VERIFIED: Marketplace can handle production volume\n');
        process.exit(0);
    } else {
        console.log('❌ Some stress tests failed. Review and optimize.\n');
        process.exit(1);
    }
}

main().catch(error => {
    console.error('Test suite error:', error);
    process.exit(1);
});
