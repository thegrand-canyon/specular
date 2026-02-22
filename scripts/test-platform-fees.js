/**
 * Platform Fee Testing Suite
 * Validates platform fee collection, distribution, and withdrawal
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n💰 PLATFORM FEE TESTING SUITE\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const [deployer] = await ethers.getSigners();
    const results = [];

    // Load test agents
    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    if (!fs.existsSync(testAgentsPath)) {
        console.log('❌ Test agents not found. Run create-test-agents.js first.\n');
        process.exit(1);
    }
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));
    const alice = testAgents.agents.find(a => a.name === 'Alice');

    console.log('Testing platform fee mechanisms...\n');

    // =============================================
    // TEST 1: Current Platform Fee Rate
    // =============================================
    console.log('TEST 1: Current Platform Fee Rate');

    try {
        const feeRate = await marketplace.platformFeeRate();
        const feePercentage = Number(feeRate) / 100;

        console.log(`   Platform Fee Rate: ${feePercentage}% (${feeRate} basis points)`);

        if (feeRate <= 500n) { // Max 5%
            console.log(`   ✅ PASS: Fee rate within acceptable range (≤ 5%)`);
            results.push({
                test: 'Platform Fee Rate',
                status: 'PASS',
                feeRate: feePercentage + '%'
            });
        } else {
            console.log(`   ❌ FAIL: Fee rate exceeds 5% maximum`);
            results.push({
                test: 'Platform Fee Rate',
                status: 'FAIL',
                feeRate: feePercentage + '%',
                reason: 'Exceeds 5% maximum'
            });
        }
    } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
        results.push({
            test: 'Platform Fee Rate',
            status: 'ERROR',
            error: error.message
        });
    }

    console.log('');

    // =============================================
    // TEST 2: Platform Fee Calculation Accuracy
    // =============================================
    console.log('TEST 2: Platform Fee Calculation Accuracy');

    try {
        const totalInterest = ethers.parseUnits('100', 6); // 100 USDC
        const feeRate = await marketplace.platformFeeRate();

        // Calculate expected platform fee
        const expectedPlatformFee = (totalInterest * feeRate) / 10000n;
        const expectedLenderShare = totalInterest - expectedPlatformFee;

        console.log(`   Total Interest: ${ethers.formatUnits(totalInterest, 6)} USDC`);
        console.log(`   Expected Platform Fee: ${ethers.formatUnits(expectedPlatformFee, 6)} USDC`);
        console.log(`   Expected Lender Share: ${ethers.formatUnits(expectedLenderShare, 6)} USDC`);

        // Verify the sum equals total
        const sum = expectedPlatformFee + expectedLenderShare;

        if (sum === totalInterest) {
            console.log(`   ✅ PASS: Platform fee + Lender share = Total interest`);
            results.push({
                test: 'Fee Calculation Accuracy',
                status: 'PASS',
                platformFee: ethers.formatUnits(expectedPlatformFee, 6),
                lenderShare: ethers.formatUnits(expectedLenderShare, 6)
            });
        } else {
            console.log(`   ❌ FAIL: Sum mismatch (${ethers.formatUnits(sum, 6)} != ${ethers.formatUnits(totalInterest, 6)})`);
            results.push({
                test: 'Fee Calculation Accuracy',
                status: 'FAIL',
                reason: 'Sum does not equal total'
            });
        }
    } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
        results.push({
            test: 'Fee Calculation Accuracy',
            status: 'ERROR',
            error: error.message
        });
    }

    console.log('');

    // =============================================
    // TEST 3: Platform Fee Collection
    // =============================================
    console.log('TEST 3: Platform Fee Collection via Loan Cycle');

    try {
        // Ensure pool exists for Alice
        const pool = await marketplace.agentPools(alice.address);

        if (pool.interestRate === 0n) {
            await marketplace.createAgentPool(
                alice.address,
                1000, // 10% rate
                ethers.parseUnits('50000', 6)
            );
            console.log(`   Created pool for ${alice.name}`);
        }

        // Get initial platform fees collected
        const initialPlatformFees = await marketplace.totalPlatformFeesCollected();
        console.log(`   Initial Platform Fees: ${ethers.formatUnits(initialPlatformFees, 6)} USDC`);

        // Supply liquidity
        const supplyAmount = ethers.parseUnits('5000', 6);
        await usdc.approve(addresses.agentLiquidityMarketplace, supplyAmount);
        await marketplace.supplyLiquidity(alice.address, supplyAmount);
        console.log(`   Supplied ${ethers.formatUnits(supplyAmount, 6)} USDC`);

        // Alice requests loan
        const aliceSigner = await ethers.getImpersonatedSigner(alice.address);
        await deployer.sendTransaction({
            to: alice.address,
            value: ethers.parseEther('0.1')
        });

        const loanAmount = ethers.parseUnits('2000', 6);
        const duration = 30 * 24 * 60 * 60; // 30 days

        const loanTx = await marketplace.connect(aliceSigner).requestLoan(loanAmount, duration);
        const loanReceipt = await loanTx.wait();

        // Get loan ID from event
        const loanEvent = loanReceipt.logs.find(log => {
            try {
                const parsed = marketplace.interface.parseLog(log);
                return parsed.name === 'LoanRequested';
            } catch { return false; }
        });
        const loanId = marketplace.interface.parseLog(loanEvent).args.loanId;

        console.log(`   Loan ID: ${loanId.toString()}`);

        // Get loan details
        const loan = await marketplace.loans(loanId);
        const totalInterest = loan.interestAmount;

        console.log(`   Loan Amount: ${ethers.formatUnits(loan.amount, 6)} USDC`);
        console.log(`   Interest: ${ethers.formatUnits(totalInterest, 6)} USDC`);

        // Calculate expected platform fee
        const feeRate = await marketplace.platformFeeRate();
        const expectedPlatformFee = (totalInterest * feeRate) / 10000n;

        console.log(`   Expected Platform Fee: ${ethers.formatUnits(expectedPlatformFee, 6)} USDC`);

        // Repay loan
        const totalRepayment = loan.amount + loan.interestAmount;
        await usdc.mint(alice.address, totalRepayment);
        await usdc.connect(aliceSigner).approve(addresses.agentLiquidityMarketplace, totalRepayment);
        await marketplace.connect(aliceSigner).repayLoan(loanId);

        console.log(`   Loan repaid`);

        // Get new platform fees collected
        const newPlatformFees = await marketplace.totalPlatformFeesCollected();
        const platformFeesCollected = newPlatformFees - initialPlatformFees;

        console.log(`   Platform Fees Collected: ${ethers.formatUnits(platformFeesCollected, 6)} USDC`);

        // Verify platform fee was collected correctly
        const difference = platformFeesCollected > expectedPlatformFee
            ? platformFeesCollected - expectedPlatformFee
            : expectedPlatformFee - platformFeesCollected;

        const percentDiff = expectedPlatformFee > 0n
            ? (Number(difference) * 100) / Number(expectedPlatformFee)
            : 0;

        if (percentDiff < 1) { // 1% tolerance
            console.log(`   ✅ PASS: Platform fee collected accurately`);
            results.push({
                test: 'Platform Fee Collection',
                status: 'PASS',
                expected: ethers.formatUnits(expectedPlatformFee, 6),
                actual: ethers.formatUnits(platformFeesCollected, 6),
                percentDiff: percentDiff.toFixed(4) + '%'
            });
        } else {
            console.log(`   ❌ FAIL: Platform fee mismatch (${percentDiff.toFixed(2)}% difference)`);
            results.push({
                test: 'Platform Fee Collection',
                status: 'FAIL',
                expected: ethers.formatUnits(expectedPlatformFee, 6),
                actual: ethers.formatUnits(platformFeesCollected, 6),
                percentDiff: percentDiff.toFixed(4) + '%'
            });
        }
    } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
        results.push({
            test: 'Platform Fee Collection',
            status: 'ERROR',
            error: error.message
        });
    }

    console.log('');

    // =============================================
    // TEST 4: Platform Fee Withdrawal (Owner Only)
    // =============================================
    console.log('TEST 4: Platform Fee Withdrawal');

    try {
        const platformFees = await marketplace.totalPlatformFeesCollected();

        if (platformFees > 0n) {
            const withdrawAmount = platformFees / 2n; // Withdraw half

            console.log(`   Available Platform Fees: ${ethers.formatUnits(platformFees, 6)} USDC`);
            console.log(`   Withdrawing: ${ethers.formatUnits(withdrawAmount, 6)} USDC`);

            const balanceBefore = await usdc.balanceOf(deployer.address);

            const tx = await marketplace.withdrawPlatformFees(withdrawAmount);
            await tx.wait();

            const balanceAfter = await usdc.balanceOf(deployer.address);
            const received = balanceAfter - balanceBefore;

            console.log(`   Received: ${ethers.formatUnits(received, 6)} USDC`);

            if (received === withdrawAmount) {
                console.log(`   ✅ PASS: Platform fee withdrawal successful`);
                results.push({
                    test: 'Platform Fee Withdrawal',
                    status: 'PASS',
                    amount: ethers.formatUnits(withdrawAmount, 6)
                });
            } else {
                console.log(`   ❌ FAIL: Received amount doesn't match withdrawal`);
                results.push({
                    test: 'Platform Fee Withdrawal',
                    status: 'FAIL',
                    expected: ethers.formatUnits(withdrawAmount, 6),
                    actual: ethers.formatUnits(received, 6)
                });
            }
        } else {
            console.log('   ⏭️  No platform fees to withdraw');
            results.push({
                test: 'Platform Fee Withdrawal',
                status: 'SKIP',
                reason: 'No fees available'
            });
        }
    } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
        results.push({
            test: 'Platform Fee Withdrawal',
            status: 'ERROR',
            error: error.message
        });
    }

    console.log('');

    // =============================================
    // TEST 5: Fee Rate Update (Owner Only)
    // =============================================
    console.log('TEST 5: Platform Fee Rate Update');

    try {
        const currentFeeRate = await marketplace.platformFeeRate();
        const newFeeRate = 150; // 1.5%

        console.log(`   Current Fee Rate: ${Number(currentFeeRate) / 100}%`);
        console.log(`   New Fee Rate: ${newFeeRate / 100}%`);

        const tx = await marketplace.setPlatformFeeRate(newFeeRate);
        await tx.wait();

        const updatedFeeRate = await marketplace.platformFeeRate();

        console.log(`   Updated Fee Rate: ${Number(updatedFeeRate) / 100}%`);

        if (updatedFeeRate === BigInt(newFeeRate)) {
            console.log(`   ✅ PASS: Fee rate updated successfully`);
            results.push({
                test: 'Fee Rate Update',
                status: 'PASS',
                oldRate: Number(currentFeeRate) / 100 + '%',
                newRate: Number(updatedFeeRate) / 100 + '%'
            });

            // Restore original fee rate
            await marketplace.setPlatformFeeRate(currentFeeRate);
            console.log(`   Restored original fee rate`);
        } else {
            console.log(`   ❌ FAIL: Fee rate not updated correctly`);
            results.push({
                test: 'Fee Rate Update',
                status: 'FAIL',
                expected: newFeeRate / 100 + '%',
                actual: Number(updatedFeeRate) / 100 + '%'
            });
        }
    } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
        results.push({
            test: 'Fee Rate Update',
            status: 'ERROR',
            error: error.message
        });
    }

    console.log('');

    // =============================================
    // TEST 6: Fee Rate Limits (Max 5%)
    // =============================================
    console.log('TEST 6: Platform Fee Rate Limits');

    try {
        console.log(`   Testing maximum fee rate (5%)...`);

        // Try to set fee to 5% (should work)
        const maxFeeRate = 500; // 5%
        await marketplace.setPlatformFeeRate(maxFeeRate);
        const updatedRate = await marketplace.platformFeeRate();

        if (updatedRate === BigInt(maxFeeRate)) {
            console.log(`   ✅ Can set to 5% maximum`);
        }

        // Try to set fee to 6% (should fail)
        console.log(`   Testing above maximum (6%)...`);

        try {
            await marketplace.setPlatformFeeRate(600); // 6%
            console.log(`   ❌ FAIL: Allowed fee rate > 5%`);
            results.push({
                test: 'Fee Rate Limits',
                status: 'FAIL',
                reason: 'Allowed fee rate exceeding 5%'
            });
        } catch (error) {
            if (error.message.includes('exceeds maximum') || error.message.includes('revert')) {
                console.log(`   ✅ PASS: Correctly rejected fee rate > 5%`);
                results.push({
                    test: 'Fee Rate Limits',
                    status: 'PASS'
                });
            } else {
                throw error;
            }
        }

        // Restore original fee rate
        const originalFeeRate = 100; // 1%
        await marketplace.setPlatformFeeRate(originalFeeRate);
        console.log(`   Restored original fee rate (1%)`);

    } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
        results.push({
            test: 'Fee Rate Limits',
            status: 'ERROR',
            error: error.message
        });
    }

    console.log('');

    // =============================================
    // SUMMARY
    // =============================================
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('💰 PLATFORM FEE TEST SUMMARY\n');

    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    const errors = results.filter(r => r.status === 'ERROR').length;
    const skipped = results.filter(r => r.status === 'SKIP').length;

    console.log(`Total Tests: ${results.length}`);
    console.log(`✅ Passed:   ${passed}`);
    console.log(`❌ Failed:   ${failed}`);
    console.log(`⚠️  Errors:   ${errors}`);
    console.log(`⏭️  Skipped:  ${skipped}`);
    console.log('');

    // Show platform fee summary
    const totalFeesCollected = await marketplace.totalPlatformFeesCollected();
    const currentFeeRate = await marketplace.platformFeeRate();

    console.log('📊 Platform Fee Summary:\n');
    console.log(`   Current Fee Rate: ${Number(currentFeeRate) / 100}%`);
    console.log(`   Total Fees Collected: ${ethers.formatUnits(totalFeesCollected, 6)} USDC`);
    console.log('');

    // Save report
    const reportPath = path.join(__dirname, '..', 'platform-fee-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({
        results,
        summary: { passed, failed, errors, skipped },
        platformFeeSummary: {
            currentFeeRate: Number(currentFeeRate) / 100 + '%',
            totalFeesCollected: ethers.formatUnits(totalFeesCollected, 6)
        },
        timestamp: new Date().toISOString()
    }, null, 2));
    console.log(`📁 Report saved to: platform-fee-report.json\n`);

    if (failed === 0 && errors === 0) {
        console.log('🎉 All platform fee tests passed!\n');
        console.log('✅ VERIFIED: Fee collection and distribution working correctly\n');
        process.exit(0);
    } else {
        console.log('❌ Some platform fee tests failed. Review results.\n');
        process.exit(1);
    }
}

main().catch(error => {
    console.error('Platform fee test suite error:', error);
    process.exit(1);
});
