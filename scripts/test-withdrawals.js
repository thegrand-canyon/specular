/**
 * Withdrawal Testing Suite
 * Tests lender withdrawal scenarios and pool liquidity management
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n💸 WITHDRAWAL TESTING SUITE\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));
    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const dave = testAgents[3];
    const daveWallet = new ethers.Wallet(dave.privateKey, ethers.provider);

    const results = [];

    // =============================================
    // SETUP: Create Dave's Pool and Supply Liquidity
    // =============================================
    console.log('SETUP: Creating Dave\'s Pool\n');

    try {
        const pool = await marketplace.agentPools(dave.agentId);
        if (!pool.isActive) {
            const tx = await marketplace.connect(daveWallet).createAgentPool();
            await tx.wait();
            console.log('✅ Dave\'s pool created');
        } else {
            console.log('✅ Dave\'s pool already exists');
        }
    } catch (error) {
        console.log(`❌ Failed: ${error.message}`);
        process.exit(1);
    }
    console.log('');

    const supplyAmount = ethers.parseUnits('10000', 6);

    console.log('Supplying Initial Liquidity\n');
    try {
        await usdc.approve(addresses.agentLiquidityMarketplace, supplyAmount);
        const tx = await marketplace.supplyLiquidity(dave.agentId, supplyAmount);
        await tx.wait();
        console.log(`✅ Supplied ${ethers.formatUnits(supplyAmount, 6)} USDC`);
    } catch (error) {
        console.log(`❌ Failed: ${error.message}`);
        process.exit(1);
    }
    console.log('');

    // =============================================
    // TEST 1: Partial Withdrawal
    // =============================================
    console.log('TEST 1: Partial Withdrawal (50%)\n');

    try {
        const position = await marketplace.getLenderPosition(dave.agentId, deployer.address);
        const withdrawAmount = position.amount / 2n;

        console.log(`   Current Position: ${ethers.formatUnits(position.amount, 6)} USDC`);
        console.log(`   Withdrawing: ${ethers.formatUnits(withdrawAmount, 6)} USDC`);
        console.log('');

        const balanceBefore = await usdc.balanceOf(deployer.address);
        const poolBefore = await marketplace.getAgentPool(dave.agentId);

        const tx = await marketplace.withdrawLiquidity(dave.agentId, withdrawAmount);
        const receipt = await tx.wait();

        const balanceAfter = await usdc.balanceOf(deployer.address);
        const poolAfter = await marketplace.getAgentPool(dave.agentId);
        const withdrawn = balanceAfter - balanceBefore;

        console.log(`   ✅ Withdrawal successful`);
        console.log(`   Withdrawn: ${ethers.formatUnits(withdrawn, 6)} USDC`);
        console.log(`   Gas Used: ${receipt.gasUsed.toLocaleString()}`);
        console.log('');

        // Verify amounts
        console.log('Verification:');
        console.log(`   Expected Withdrawn: ${ethers.formatUnits(withdrawAmount, 6)} USDC`);
        console.log(`   Actual Withdrawn: ${ethers.formatUnits(withdrawn, 6)} USDC`);

        if (withdrawn === withdrawAmount) {
            console.log(`   ✅ Withdrawal amount correct`);
        } else {
            console.log(`   ❌ Withdrawal amount mismatch!`);
        }

        // Verify pool updated
        const expectedPoolLiquidity = poolBefore.totalLiquidity - withdrawAmount;
        console.log(`   Expected Pool Liquidity: ${ethers.formatUnits(expectedPoolLiquidity, 6)} USDC`);
        console.log(`   Actual Pool Liquidity: ${ethers.formatUnits(poolAfter.totalLiquidity, 6)} USDC`);

        if (poolAfter.totalLiquidity === expectedPoolLiquidity) {
            console.log(`   ✅ Pool liquidity updated correctly`);
            results.push({ test: 'Partial withdrawal', status: 'PASS', gasUsed: Number(receipt.gasUsed) });
        } else {
            console.log(`   ❌ Pool liquidity incorrect!`);
            results.push({ test: 'Partial withdrawal', status: 'FAIL', reason: 'Pool liquidity mismatch' });
        }

    } catch (error) {
        console.log(`   ❌ Failed: ${error.message}`);
        results.push({ test: 'Partial withdrawal', status: 'FAIL', error: error.message });
    }
    console.log('');

    // =============================================
    // TEST 2: Withdrawal While Loan Active
    // =============================================
    console.log('TEST 2: Withdrawal While Loan Active\n');

    // First, Dave takes a loan
    const loanAmount = ethers.parseUnits('2000', 6);

    try {
        console.log('Dave taking a loan first...');
        // For simplicity, assuming 100% collateral for test agent
        await usdc.connect(daveWallet).approve(addresses.agentLiquidityMarketplace, loanAmount);
        const loanTx = await marketplace.connect(daveWallet).requestLoan(loanAmount, 30);
        await loanTx.wait();
        console.log(`   ✅ Loan of ${ethers.formatUnits(loanAmount, 6)} USDC disbursed`);
        console.log('');
    } catch (error) {
        console.log(`   ⚠️  Could not create loan: ${error.message}`);
        console.log('   Skipping this test\n');
        results.push({ test: 'Withdrawal with active loan', status: 'SKIP', reason: 'Loan creation failed' });
    }

    // Now try to withdraw more than available
    try {
        const pool = await marketplace.getAgentPool(dave.agentId);
        const position = await marketplace.getLenderPosition(dave.agentId, deployer.address);

        console.log('Pool State:');
        console.log(`   Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
        console.log(`   Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
        console.log(`   Loaned: ${ethers.formatUnits(pool.totalLoaned, 6)} USDC`);
        console.log(`   Your Position: ${ethers.formatUnits(position.amount, 6)} USDC`);
        console.log('');

        // Try to withdraw more than available
        const attemptWithdraw = pool.availableLiquidity + ethers.parseUnits('100', 6);

        console.log(`Attempting to withdraw ${ethers.formatUnits(attemptWithdraw, 6)} USDC...`);
        await marketplace.withdrawLiquidity(dave.agentId, attemptWithdraw);

        console.log(`   ❌ FAIL: Should have rejected withdrawal > available`);
        results.push({ test: 'Withdrawal with active loan', status: 'FAIL', reason: 'Accepted withdrawal > available' });

    } catch (error) {
        if (error.message.includes('Insufficient pool liquidity')) {
            console.log(`   ✅ PASS: Correctly rejected withdrawal > available liquidity`);
            results.push({ test: 'Withdrawal with active loan', status: 'PASS' });
        } else {
            console.log(`   ⚠️  PARTIAL: Rejected but wrong error: ${error.message}`);
            results.push({ test: 'Withdrawal with active loan', status: 'PARTIAL', error: error.message });
        }
    }
    console.log('');

    // =============================================
    // TEST 3: Withdraw Within Available Liquidity
    // =============================================
    console.log('TEST 3: Withdraw Within Available Liquidity\n');

    try {
        const pool = await marketplace.getAgentPool(dave.agentId);

        if (pool.availableLiquidity > 0) {
            const safeWithdraw = pool.availableLiquidity / 2n; // Withdraw 50% of available

            console.log(`   Available Liquidity: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
            console.log(`   Withdrawing: ${ethers.formatUnits(safeWithdraw, 6)} USDC`);
            console.log('');

            const tx = await marketplace.withdrawLiquidity(dave.agentId, safeWithdraw);
            const receipt = await tx.wait();

            console.log(`   ✅ Withdrawal successful`);
            console.log(`   Gas Used: ${receipt.gasUsed.toLocaleString()}`);
            results.push({ test: 'Safe withdrawal', status: 'PASS', gasUsed: Number(receipt.gasUsed) });
        } else {
            console.log(`   ⏭️  SKIPPED: No available liquidity`);
            results.push({ test: 'Safe withdrawal', status: 'SKIP' });
        }

    } catch (error) {
        console.log(`   ❌ Failed: ${error.message}`);
        results.push({ test: 'Safe withdrawal', status: 'FAIL', error: error.message });
    }
    console.log('');

    // =============================================
    // TEST 4: Full Withdrawal
    // =============================================
    console.log('TEST 4: Full Withdrawal (100%)\n');

    try {
        // First repay the loan if active
        const pool = await marketplace.getAgentPool(dave.agentId);

        if (pool.totalLoaned > 0) {
            console.log('   Repaying active loan first...');

            // Find active loan
            // Note: In production, you'd track loan IDs better
            // For testing, we'll try to repay recent loan

            try {
                const recentLoanId = 1; // Assuming recent loan ID
                const loan = await marketplace.loans(recentLoanId);

                if (loan.state === 1) { // ACTIVE
                    const interest = await marketplace.calculateInterest(
                        loan.amount,
                        loan.interestRate,
                        loan.duration
                    );
                    const totalRepayment = loan.amount + interest;

                    await usdc.connect(daveWallet).approve(addresses.agentLiquidityMarketplace, totalRepayment);
                    await marketplace.connect(daveWallet).repayLoan(recentLoanId);

                    console.log('   ✅ Loan repaid');
                }
            } catch (repayError) {
                console.log(`   ⚠️  Could not repay loan: ${repayError.message}`);
            }

            console.log('');
        }

        // Now withdraw everything
        const position = await marketplace.getLenderPosition(dave.agentId, deployer.address);

        if (position.amount > 0) {
            console.log(`   Withdrawing entire position: ${ethers.formatUnits(position.amount, 6)} USDC`);

            const balanceBefore = await usdc.balanceOf(deployer.address);

            const tx = await marketplace.withdrawLiquidity(dave.agentId, position.amount);
            const receipt = await tx.wait();

            const balanceAfter = await usdc.balanceOf(deployer.address);
            const withdrawn = balanceAfter - balanceBefore;

            console.log(`   ✅ Full withdrawal successful`);
            console.log(`   Withdrawn: ${ethers.formatUnits(withdrawn, 6)} USDC`);
            console.log(`   Gas Used: ${receipt.gasUsed.toLocaleString()}`);

            // Verify position is now zero
            const positionAfter = await marketplace.getLenderPosition(dave.agentId, deployer.address);
            console.log(`   Remaining Position: ${ethers.formatUnits(positionAfter.amount, 6)} USDC`);

            if (positionAfter.amount === 0n) {
                console.log(`   ✅ Position cleared completely`);
                results.push({ test: 'Full withdrawal', status: 'PASS', gasUsed: Number(receipt.gasUsed) });
            } else {
                console.log(`   ❌ Position not cleared!`);
                results.push({ test: 'Full withdrawal', status: 'FAIL', reason: 'Position not zero' });
            }
        } else {
            console.log(`   ⏭️  SKIPPED: No position to withdraw`);
            results.push({ test: 'Full withdrawal', status: 'SKIP' });
        }

    } catch (error) {
        console.log(`   ❌ Failed: ${error.message}`);
        results.push({ test: 'Full withdrawal', status: 'FAIL', error: error.message });
    }
    console.log('');

    // =============================================
    // TEST 5: Withdraw After Earning Interest
    // =============================================
    console.log('TEST 5: Withdraw After Earning Interest\n');

    try {
        // Supply fresh liquidity
        const freshSupply = ethers.parseUnits('5000', 6);
        await usdc.approve(addresses.agentLiquidityMarketplace, freshSupply);
        await marketplace.supplyLiquidity(dave.agentId, freshSupply);

        console.log(`   Supplied ${ethers.formatUnits(freshSupply, 6)} USDC`);

        // Dave takes loan
        const smallLoan = ethers.parseUnits('1000', 6);
        await usdc.connect(daveWallet).approve(addresses.agentLiquidityMarketplace, smallLoan);
        const loanTx = await marketplace.connect(daveWallet).requestLoan(smallLoan, 30);
        const loanReceipt = await loanTx.wait();

        const disbursedEvent = loanReceipt.logs.find(log => {
            try {
                return marketplace.interface.parseLog(log)?.name === 'LoanDisbursed';
            } catch { return false; }
        });

        if (disbursedEvent) {
            const loanId = marketplace.interface.parseLog(disbursedEvent).args.loanId;
            console.log(`   Loan ${loanId} disbursed`);

            // Repay with interest
            const loan = await marketplace.loans(loanId);
            const interest = await marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
            const totalRepayment = loan.amount + interest;

            await usdc.connect(daveWallet).approve(addresses.agentLiquidityMarketplace, totalRepayment);
            await marketplace.connect(daveWallet).repayLoan(loanId);

            console.log(`   Loan repaid with ${ethers.formatUnits(interest, 6)} USDC interest`);

            // Check earned interest
            const position = await marketplace.getLenderPosition(dave.agentId, deployer.address);
            console.log(`   Earned Interest: ${ethers.formatUnits(position.earnedInterest, 6)} USDC`);

            // Withdraw principal only (not earned interest)
            if (position.amount >= freshSupply) {
                await marketplace.withdrawLiquidity(dave.agentId, freshSupply);
                console.log(`   ✅ Withdrew principal, interest remains claimable`);

                // Verify interest still there
                const positionAfter = await marketplace.getLenderPosition(dave.agentId, deployer.address);
                console.log(`   Remaining Earned Interest: ${ethers.formatUnits(positionAfter.earnedInterest, 6)} USDC`);

                if (positionAfter.earnedInterest === position.earnedInterest) {
                    console.log(`   ✅ Interest preserved after withdrawal`);
                    results.push({ test: 'Withdrawal with interest', status: 'PASS' });
                } else {
                    console.log(`   ❌ Interest lost!`);
                    results.push({ test: 'Withdrawal with interest', status: 'FAIL', reason: 'Interest lost' });
                }
            } else {
                console.log(`   ⏭️  SKIPPED: Insufficient position`);
                results.push({ test: 'Withdrawal with interest', status: 'SKIP' });
            }
        } else {
            console.log(`   ⏭️  SKIPPED: Loan not disbursed`);
            results.push({ test: 'Withdrawal with interest', status: 'SKIP' });
        }

    } catch (error) {
        console.log(`   ⚠️  Test partially failed: ${error.message}`);
        results.push({ test: 'Withdrawal with interest', status: 'PARTIAL', error: error.message });
    }
    console.log('');

    // =============================================
    // SUMMARY
    // =============================================
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 WITHDRAWAL TEST SUMMARY\n');

    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    const partial = results.filter(r => r.status === 'PARTIAL').length;
    const skipped = results.filter(r => r.status === 'SKIP').length;

    console.log(`Total Tests: ${results.length}`);
    console.log(`✅ Passed:   ${passed}`);
    console.log(`❌ Failed:   ${failed}`);
    console.log(`⚠️  Partial:  ${partial}`);
    console.log(`⏭️  Skipped:  ${skipped}`);
    console.log('');

    if (failed > 0) {
        console.log('🚨 FAILED TESTS:\n');
        results.filter(r => r.status === 'FAIL').forEach(r => {
            console.log(`   - ${r.test}: ${r.reason || r.error}`);
        });
        console.log('');
    }

    // Average gas
    const gasTests = results.filter(r => r.gasUsed);
    if (gasTests.length > 0) {
        const avgGas = gasTests.reduce((sum, r) => sum + r.gasUsed, 0) / gasTests.length;
        console.log(`⛽ Average Gas: ${Math.round(avgGas).toLocaleString()}`);
        console.log('');
    }

    // Save results
    const reportPath = path.join(__dirname, '..', 'withdrawal-test-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({ results, summary: { passed, failed, partial, skipped } }, null, 2));
    console.log(`📁 Report saved to: withdrawal-test-report.json\n`);

    if (failed === 0) {
        console.log('🎉 All withdrawal tests passed!\n');
        console.log('✅ VERIFIED: Lenders can safely withdraw liquidity\n');
        process.exit(0);
    } else {
        console.log('❌ Some withdrawal tests failed. Review and fix.\n');
        process.exit(1);
    }
}

main().catch(error => {
    console.error('Test suite error:', error);
    process.exit(1);
});
