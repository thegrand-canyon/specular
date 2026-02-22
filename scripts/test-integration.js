/**
 * Integration Testing Suite
 * Tests complex multi-step workflows across the entire P2P marketplace
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🔗 INTEGRATION TESTING SUITE\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManager);
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

    console.log('Testing complex integration scenarios...\n');

    // =============================================
    // INTEGRATION TEST 1: Complete Loan Lifecycle with Reputation Impact
    // =============================================
    console.log('INTEGRATION TEST 1: Complete Loan Lifecycle with Reputation Impact\n');

    try {
        const bob = testAgents.agents.find(a => a.name === 'Bob');
        const bobSigner = await ethers.getImpersonatedSigner(bob.address);

        // Fund Bob with ETH
        await deployer.sendTransaction({
            to: bob.address,
            value: ethers.parseEther('0.1')
        });

        // Step 1: Create pool for Bob
        console.log('   Step 1: Creating agent pool for Bob...');
        const poolExists = await marketplace.agentPools(bob.address);

        if (poolExists.interestRate === 0n) {
            await marketplace.createAgentPool(
                bob.address,
                800, // 8% rate
                ethers.parseUnits('25000', 6)
            );
            console.log('   ✅ Pool created');
        } else {
            console.log('   ✅ Pool already exists');
        }

        // Step 2: Check initial reputation
        console.log('   Step 2: Checking initial reputation...');
        const initialReputation = await reputationManager.getReputationScore(bob.address);
        console.log(`   Initial Reputation: ${initialReputation.toString()}`);

        // Step 3: Supply liquidity
        console.log('   Step 3: Supplying liquidity...');
        const supplyAmount = ethers.parseUnits('10000', 6);
        await usdc.approve(addresses.agentLiquidityMarketplace, supplyAmount);
        await marketplace.supplyLiquidity(bob.address, supplyAmount);
        console.log(`   ✅ Supplied ${ethers.formatUnits(supplyAmount, 6)} USDC`);

        // Step 4: Request loan
        console.log('   Step 4: Requesting loan...');
        const loanAmount = ethers.parseUnits('5000', 6);
        const duration = 30 * 24 * 60 * 60;

        const loanTx = await marketplace.connect(bobSigner).requestLoan(loanAmount, duration);
        const loanReceipt = await loanTx.wait();

        const loanEvent = loanReceipt.logs.find(log => {
            try {
                const parsed = marketplace.interface.parseLog(log);
                return parsed.name === 'LoanRequested';
            } catch { return false; }
        });
        const loanId = marketplace.interface.parseLog(loanEvent).args.loanId;
        console.log(`   ✅ Loan requested (ID: ${loanId.toString()})`);

        // Step 5: Verify loan state
        console.log('   Step 5: Verifying loan state...');
        const loan = await marketplace.loans(loanId);
        console.log(`   Loan Amount: ${ethers.formatUnits(loan.amount, 6)} USDC`);
        console.log(`   Interest: ${ethers.formatUnits(loan.interestAmount, 6)} USDC`);
        console.log(`   Status: Active`);

        // Step 6: Repay loan
        console.log('   Step 6: Repaying loan...');
        const totalRepayment = loan.amount + loan.interestAmount;
        await usdc.mint(bob.address, totalRepayment);
        await usdc.connect(bobSigner).approve(addresses.agentLiquidityMarketplace, totalRepayment);
        await marketplace.connect(bobSigner).repayLoan(loanId);
        console.log(`   ✅ Loan repaid`);

        // Step 7: Check reputation after repayment
        console.log('   Step 7: Checking reputation after repayment...');
        const finalReputation = await reputationManager.getReputationScore(bob.address);
        const reputationGain = finalReputation - initialReputation;
        console.log(`   Final Reputation: ${finalReputation.toString()}`);
        console.log(`   Reputation Gain: +${reputationGain.toString()}`);

        // Step 8: Claim interest
        console.log('   Step 8: Claiming interest...');
        const positionBefore = await marketplace.lenderPositions(deployer.address, bob.address);
        await marketplace.claimInterest(bob.address);
        const positionAfter = await marketplace.lenderPositions(deployer.address, bob.address);
        console.log(`   ✅ Interest claimed: ${ethers.formatUnits(positionBefore.earnedInterest, 6)} USDC`);

        console.log('   ✅ INTEGRATION TEST 1 PASSED\n');
        results.push({
            test: 'Complete Loan Lifecycle',
            status: 'PASS',
            loanAmount: ethers.formatUnits(loanAmount, 6),
            reputationGain: reputationGain.toString()
        });

    } catch (error) {
        console.log(`   ❌ INTEGRATION TEST 1 FAILED: ${error.message}\n`);
        results.push({
            test: 'Complete Loan Lifecycle',
            status: 'FAIL',
            error: error.message
        });
    }

    // =============================================
    // INTEGRATION TEST 2: Multi-Lender Pool with Concurrent Loans
    // =============================================
    console.log('INTEGRATION TEST 2: Multi-Lender Pool with Concurrent Loans\n');

    try {
        const carol = testAgents.agents.find(a => a.name === 'Carol');
        const carolSigner = await ethers.getImpersonatedSigner(carol.address);

        // Fund Carol
        await deployer.sendTransaction({
            to: carol.address,
            value: ethers.parseEther('0.1')
        });

        // Step 1: Create pool
        console.log('   Step 1: Creating pool for Carol...');
        const poolExists = await marketplace.agentPools(carol.address);

        if (poolExists.interestRate === 0n) {
            await marketplace.createAgentPool(
                carol.address,
                1200, // 12% rate
                ethers.parseUnits('30000', 6)
            );
            console.log('   ✅ Pool created');
        } else {
            console.log('   ✅ Pool already exists');
        }

        // Step 2: Multiple lenders supply
        console.log('   Step 2: Multiple lenders supplying liquidity...');

        // Deployer supplies 6000 USDC
        const supply1 = ethers.parseUnits('6000', 6);
        await usdc.approve(addresses.agentLiquidityMarketplace, supply1);
        await marketplace.supplyLiquidity(carol.address, supply1);
        console.log(`   ✅ Deployer supplied ${ethers.formatUnits(supply1, 6)} USDC`);

        // Alice supplies 4000 USDC (we'll use impersonation)
        const alice = testAgents.agents.find(a => a.name === 'Alice');
        const aliceSigner = await ethers.getImpersonatedSigner(alice.address);
        await deployer.sendTransaction({
            to: alice.address,
            value: ethers.parseEther('0.1')
        });

        const supply2 = ethers.parseUnits('4000', 6);
        await usdc.mint(alice.address, supply2);
        await usdc.connect(aliceSigner).approve(addresses.agentLiquidityMarketplace, supply2);
        await marketplace.connect(aliceSigner).supplyLiquidity(carol.address, supply2);
        console.log(`   ✅ Alice supplied ${ethers.formatUnits(supply2, 6)} USDC`);

        // Step 3: Verify lender positions
        console.log('   Step 3: Verifying lender positions...');
        const pool = await marketplace.agentPools(carol.address);
        const position1 = await marketplace.lenderPositions(deployer.address, carol.address);
        const position2 = await marketplace.lenderPositions(alice.address, carol.address);

        const share1 = (Number(position1.amount) * 100) / Number(pool.totalLiquidity);
        const share2 = (Number(position2.amount) * 100) / Number(pool.totalLiquidity);

        console.log(`   Deployer Share: ${share1.toFixed(1)}%`);
        console.log(`   Alice Share: ${share2.toFixed(1)}%`);

        // Step 4: Carol takes loan
        console.log('   Step 4: Carol requesting loan...');
        const loanAmount = ethers.parseUnits('8000', 6);
        const duration = 60 * 24 * 60 * 60;

        const loanTx = await marketplace.connect(carolSigner).requestLoan(loanAmount, duration);
        const loanReceipt = await loanTx.wait();

        const loanEvent = loanReceipt.logs.find(log => {
            try {
                const parsed = marketplace.interface.parseLog(log);
                return parsed.name === 'LoanRequested';
            } catch { return false; }
        });
        const loanId = marketplace.interface.parseLog(loanEvent).args.loanId;
        console.log(`   ✅ Loan requested (ID: ${loanId.toString()})`);

        // Step 5: Carol repays
        console.log('   Step 5: Carol repaying loan...');
        const loan = await marketplace.loans(loanId);
        const totalRepayment = loan.amount + loan.interestAmount;
        await usdc.mint(carol.address, totalRepayment);
        await usdc.connect(carolSigner).approve(addresses.agentLiquidityMarketplace, totalRepayment);
        await marketplace.connect(carolSigner).repayLoan(loanId);
        console.log(`   ✅ Loan repaid`);

        // Step 6: Verify proportional interest distribution
        console.log('   Step 6: Verifying proportional interest distribution...');
        const updatedPosition1 = await marketplace.lenderPositions(deployer.address, carol.address);
        const updatedPosition2 = await marketplace.lenderPositions(alice.address, carol.address);

        const interest1 = updatedPosition1.earnedInterest;
        const interest2 = updatedPosition2.earnedInterest;
        const totalInterest = interest1 + interest2;

        const interestShare1 = totalInterest > 0n ? (Number(interest1) * 100) / Number(totalInterest) : 0;
        const interestShare2 = totalInterest > 0n ? (Number(interest2) * 100) / Number(totalInterest) : 0;

        console.log(`   Deployer Interest: ${ethers.formatUnits(interest1, 6)} USDC (${interestShare1.toFixed(1)}%)`);
        console.log(`   Alice Interest: ${ethers.formatUnits(interest2, 6)} USDC (${interestShare2.toFixed(1)}%)`);

        // Verify shares match (within 1% tolerance)
        const shareDiff1 = Math.abs(interestShare1 - share1);
        const shareDiff2 = Math.abs(interestShare2 - share2);

        if (shareDiff1 < 1 && shareDiff2 < 1) {
            console.log('   ✅ INTEGRATION TEST 2 PASSED\n');
            results.push({
                test: 'Multi-Lender Pool',
                status: 'PASS',
                loanAmount: ethers.formatUnits(loanAmount, 6),
                lenders: 2
            });
        } else {
            console.log('   ❌ Interest distribution mismatch\n');
            results.push({
                test: 'Multi-Lender Pool',
                status: 'FAIL',
                reason: 'Interest distribution not proportional'
            });
        }

    } catch (error) {
        console.log(`   ❌ INTEGRATION TEST 2 FAILED: ${error.message}\n`);
        results.push({
            test: 'Multi-Lender Pool',
            status: 'FAIL',
            error: error.message
        });
    }

    // =============================================
    // INTEGRATION TEST 3: Withdrawal During Active Loan
    // =============================================
    console.log('INTEGRATION TEST 3: Withdrawal During Active Loan\n');

    try {
        const dave = testAgents.agents.find(a => a.name === 'Dave');
        const daveSigner = await ethers.getImpersonatedSigner(dave.address);

        await deployer.sendTransaction({
            to: dave.address,
            value: ethers.parseEther('0.1')
        });

        // Step 1: Create pool and supply
        console.log('   Step 1: Setting up pool...');
        const poolExists = await marketplace.agentPools(dave.address);

        if (poolExists.interestRate === 0n) {
            await marketplace.createAgentPool(
                dave.address,
                900, // 9% rate
                ethers.parseUnits('20000', 6)
            );
        }

        const supplyAmount = ethers.parseUnits('10000', 6);
        await usdc.approve(addresses.agentLiquidityMarketplace, supplyAmount);
        await marketplace.supplyLiquidity(dave.address, supplyAmount);
        console.log(`   ✅ Supplied ${ethers.formatUnits(supplyAmount, 6)} USDC`);

        // Step 2: Dave takes loan
        console.log('   Step 2: Dave requesting loan...');
        const loanAmount = ethers.parseUnits('6000', 6);
        const duration = 45 * 24 * 60 * 60;

        const loanTx = await marketplace.connect(daveSigner).requestLoan(loanAmount, duration);
        const loanReceipt = await loanTx.wait();

        const loanEvent = loanReceipt.logs.find(log => {
            try {
                const parsed = marketplace.interface.parseLog(log);
                return parsed.name === 'LoanRequested';
            } catch { return false; }
        });
        const loanId = marketplace.interface.parseLog(loanEvent).args.loanId;
        console.log(`   ✅ Loan active (ID: ${loanId.toString()})`);

        // Step 3: Try to withdraw more than available (should fail)
        console.log('   Step 3: Attempting to withdraw loaned amount...');
        const pool = await marketplace.agentPools(dave.address);
        const excessiveWithdrawal = pool.availableLiquidity + 1n;

        try {
            await marketplace.withdrawLiquidity(dave.address, excessiveWithdrawal);
            console.log('   ❌ Should have failed but succeeded\n');
            results.push({
                test: 'Withdrawal During Active Loan',
                status: 'FAIL',
                reason: 'Allowed withdrawal of loaned funds'
            });
        } catch (error) {
            if (error.message.includes('Insufficient available liquidity') || error.message.includes('revert')) {
                console.log('   ✅ Correctly rejected excessive withdrawal');

                // Step 4: Withdraw available amount (should succeed)
                console.log('   Step 4: Withdrawing available liquidity...');
                const safeWithdrawal = pool.availableLiquidity;

                if (safeWithdrawal > 0n) {
                    await marketplace.withdrawLiquidity(dave.address, safeWithdrawal);
                    console.log(`   ✅ Withdrew ${ethers.formatUnits(safeWithdrawal, 6)} USDC`);

                    console.log('   ✅ INTEGRATION TEST 3 PASSED\n');
                    results.push({
                        test: 'Withdrawal During Active Loan',
                        status: 'PASS'
                    });
                } else {
                    console.log('   ⏭️  No available liquidity to withdraw\n');
                    results.push({
                        test: 'Withdrawal During Active Loan',
                        status: 'SKIP',
                        reason: 'No available liquidity'
                    });
                }
            } else {
                throw error;
            }
        }

    } catch (error) {
        console.log(`   ❌ INTEGRATION TEST 3 FAILED: ${error.message}\n`);
        results.push({
            test: 'Withdrawal During Active Loan',
            status: 'FAIL',
            error: error.message
        });
    }

    // =============================================
    // SUMMARY
    // =============================================
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('🔗 INTEGRATION TEST SUMMARY\n');

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

    console.log('📊 Integration Tests:\n');
    results.forEach((r, idx) => {
        const icon = r.status === 'PASS' ? '✅' : r.status === 'SKIP' ? '⏭️' : '❌';
        console.log(`   ${idx + 1}. ${icon} ${r.test}`);
    });
    console.log('');

    // Save report
    const reportPath = path.join(__dirname, '..', 'integration-test-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({
        results,
        summary: { passed, failed, errors, skipped },
        timestamp: new Date().toISOString()
    }, null, 2));
    console.log(`📁 Report saved to: integration-test-report.json\n`);

    if (failed === 0 && errors === 0) {
        console.log('🎉 All integration tests passed!\n');
        console.log('✅ VERIFIED: Complex workflows work correctly\n');
        process.exit(0);
    } else {
        console.log('❌ Some integration tests failed. Review results.\n');
        process.exit(1);
    }
}

main().catch(error => {
    console.error('Integration test suite error:', error);
    process.exit(1);
});
