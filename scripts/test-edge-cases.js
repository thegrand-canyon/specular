/**
 * Edge Case Testing Suite
 * Tests boundary conditions and unusual scenarios
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🔬 EDGE CASE TESTING SUITE\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));
    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);

    const alice = testAgents[0];
    const bob = testAgents[1];
    const aliceWallet = new ethers.Wallet(alice.privateKey, ethers.provider);
    const bobWallet = new ethers.Wallet(bob.privateKey, ethers.provider);

    const results = [];

    // =============================================
    // EDGE CASE 1: Zero Amount Supply
    // =============================================
    console.log('EDGE CASE 1: Zero Amount Supply\n');
    try {
        await marketplace.supplyLiquidity(alice.agentId, 0);
        console.log('❌ FAILED: Should reject zero amount');
        results.push({ test: 'Zero supply', status: 'FAIL', reason: 'Accepted zero amount' });
    } catch (error) {
        if (error.message.includes('Amount must be > 0')) {
            console.log('✅ PASSED: Correctly rejected zero amount');
            results.push({ test: 'Zero supply', status: 'PASS' });
        } else {
            console.log(`⚠️  PARTIAL: Rejected but wrong error: ${error.message}`);
            results.push({ test: 'Zero supply', status: 'PARTIAL', error: error.message });
        }
    }
    console.log('');

    // =============================================
    // EDGE CASE 2: Loan Larger Than Pool
    // =============================================
    console.log('EDGE CASE 2: Loan Larger Than Available Liquidity\n');
    try {
        const pool = await marketplace.getAgentPool(alice.agentId);
        const tooLarge = pool.availableLiquidity + ethers.parseUnits('1000', 6);

        const collateralPercent = await reputationManager.calculateCollateralRequirement(alice.address);
        const requiredCollateral = (tooLarge * collateralPercent) / 100n;

        if (requiredCollateral > 0) {
            await usdc.connect(aliceWallet).approve(addresses.agentLiquidityMarketplace, requiredCollateral);
        }

        await marketplace.connect(aliceWallet).requestLoan(tooLarge, 30);
        console.log('❌ FAILED: Should reject loan larger than available liquidity');
        results.push({ test: 'Oversized loan', status: 'FAIL', reason: 'Accepted oversized loan' });
    } catch (error) {
        if (error.message.includes('Insufficient pool liquidity')) {
            console.log('✅ PASSED: Correctly rejected oversized loan');
            results.push({ test: 'Oversized loan', status: 'PASS' });
        } else {
            console.log(`⚠️  PARTIAL: Rejected but wrong error: ${error.message}`);
            results.push({ test: 'Oversized loan', status: 'PARTIAL', error: error.message });
        }
    }
    console.log('');

    // =============================================
    // EDGE CASE 3: Loan Exceeding Credit Limit
    // =============================================
    console.log('EDGE CASE 3: Loan Exceeding Credit Limit\n');
    try {
        const creditLimit = await reputationManager.calculateCreditLimit(alice.address);
        const tooLarge = creditLimit + ethers.parseUnits('100', 6);

        const collateralPercent = await reputationManager.calculateCollateralRequirement(alice.address);
        const requiredCollateral = (tooLarge * collateralPercent) / 100n;

        if (requiredCollateral > 0) {
            await usdc.connect(aliceWallet).approve(addresses.agentLiquidityMarketplace, requiredCollateral);
        }

        await marketplace.connect(aliceWallet).requestLoan(tooLarge, 30);
        console.log('❌ FAILED: Should reject loan exceeding credit limit');
        results.push({ test: 'Credit limit exceeded', status: 'FAIL', reason: 'Accepted loan over limit' });
    } catch (error) {
        if (error.message.includes('Exceeds credit limit')) {
            console.log('✅ PASSED: Correctly rejected loan over credit limit');
            console.log(`   Credit limit: ${ethers.formatUnits(await reputationManager.calculateCreditLimit(alice.address), 6)} USDC`);
            results.push({ test: 'Credit limit exceeded', status: 'PASS' });
        } else {
            console.log(`⚠️  PARTIAL: Rejected but wrong error: ${error.message}`);
            results.push({ test: 'Credit limit exceeded', status: 'PARTIAL', error: error.message });
        }
    }
    console.log('');

    // =============================================
    // EDGE CASE 4: Insufficient Collateral
    // =============================================
    console.log('EDGE CASE 4: Insufficient Collateral\n');
    try {
        const loanAmount = ethers.parseUnits('500', 6);
        const collateralPercent = await reputationManager.calculateCollateralRequirement(alice.address);
        const requiredCollateral = (loanAmount * collateralPercent) / 100n;
        const insufficientCollateral = requiredCollateral - ethers.parseUnits('1', 6); // 1 USDC short

        if (requiredCollateral > 0) {
            await usdc.connect(aliceWallet).approve(addresses.agentLiquidityMarketplace, insufficientCollateral);
            await marketplace.connect(aliceWallet).requestLoan(loanAmount, 30);
            console.log('❌ FAILED: Should reject insufficient collateral');
            results.push({ test: 'Insufficient collateral', status: 'FAIL', reason: 'Accepted insufficient collateral' });
        } else {
            console.log('⏭️  SKIPPED: No collateral required for this agent');
            results.push({ test: 'Insufficient collateral', status: 'SKIP', reason: 'No collateral required' });
        }
    } catch (error) {
        console.log('✅ PASSED: Correctly rejected insufficient collateral');
        console.log(`   Error: ${error.message.substring(0, 100)}...`);
        results.push({ test: 'Insufficient collateral', status: 'PASS' });
    }
    console.log('');

    // =============================================
    // EDGE CASE 5: Withdraw More Than Available
    // =============================================
    console.log('EDGE CASE 5: Withdraw More Than Available\n');
    try {
        const position = await marketplace.getLenderPosition(alice.agentId, deployer.address);
        const tooMuch = position.amount + ethers.parseUnits('1000', 6);

        await marketplace.withdrawLiquidity(alice.agentId, tooMuch);
        console.log('❌ FAILED: Should reject withdrawal larger than balance');
        results.push({ test: 'Over-withdrawal', status: 'FAIL', reason: 'Accepted over-withdrawal' });
    } catch (error) {
        if (error.message.includes('Insufficient balance')) {
            console.log('✅ PASSED: Correctly rejected over-withdrawal');
            results.push({ test: 'Over-withdrawal', status: 'PASS' });
        } else {
            console.log(`⚠️  PARTIAL: Rejected but wrong error: ${error.message}`);
            results.push({ test: 'Over-withdrawal', status: 'PARTIAL', error: error.message });
        }
    }
    console.log('');

    // =============================================
    // EDGE CASE 6: Non-Agent Creates Pool
    // =============================================
    console.log('EDGE CASE 6: Non-Agent Tries to Create Pool\n');
    try {
        // Use deployer (not an agent)
        await marketplace.connect(deployer).createAgentPool();
        console.log('❌ FAILED: Should reject non-agent pool creation');
        results.push({ test: 'Non-agent pool', status: 'FAIL', reason: 'Allowed non-agent' });
    } catch (error) {
        if (error.message.includes('Not a registered agent')) {
            console.log('✅ PASSED: Correctly rejected non-agent');
            results.push({ test: 'Non-agent pool', status: 'PASS' });
        } else {
            console.log(`⚠️  PARTIAL: Rejected but wrong error: ${error.message}`);
            results.push({ test: 'Non-agent pool', status: 'PARTIAL', error: error.message });
        }
    }
    console.log('');

    // =============================================
    // EDGE CASE 7: Duplicate Pool Creation
    // =============================================
    console.log('EDGE CASE 7: Agent Tries to Create Duplicate Pool\n');
    try {
        const pool = await marketplace.agentPools(alice.agentId);
        if (pool.isActive) {
            await marketplace.connect(aliceWallet).createAgentPool();
            console.log('❌ FAILED: Should reject duplicate pool');
            results.push({ test: 'Duplicate pool', status: 'FAIL', reason: 'Allowed duplicate' });
        } else {
            console.log('⏭️  SKIPPED: Pool doesn\'t exist yet');
            results.push({ test: 'Duplicate pool', status: 'SKIP' });
        }
    } catch (error) {
        if (error.message.includes('Pool already exists')) {
            console.log('✅ PASSED: Correctly rejected duplicate pool');
            results.push({ test: 'Duplicate pool', status: 'PASS' });
        } else {
            console.log(`⚠️  PARTIAL: Rejected but wrong error: ${error.message}`);
            results.push({ test: 'Duplicate pool', status: 'PARTIAL', error: error.message });
        }
    }
    console.log('');

    // =============================================
    // EDGE CASE 8: Invalid Loan Duration
    // =============================================
    console.log('EDGE CASE 8: Loan with Duration < 7 Days\n');
    try {
        const loanAmount = ethers.parseUnits('100', 6);
        const collateralPercent = await reputationManager.calculateCollateralRequirement(alice.address);
        const requiredCollateral = (loanAmount * collateralPercent) / 100n;

        if (requiredCollateral > 0) {
            await usdc.connect(aliceWallet).approve(addresses.agentLiquidityMarketplace, requiredCollateral);
        }

        await marketplace.connect(aliceWallet).requestLoan(loanAmount, 5); // 5 days
        console.log('❌ FAILED: Should reject duration < 7 days');
        results.push({ test: 'Short duration', status: 'FAIL', reason: 'Accepted < 7 days' });
    } catch (error) {
        if (error.message.includes('Invalid duration')) {
            console.log('✅ PASSED: Correctly rejected short duration');
            results.push({ test: 'Short duration', status: 'PASS' });
        } else {
            console.log(`⚠️  PARTIAL: Rejected but wrong error: ${error.message}`);
            results.push({ test: 'Short duration', status: 'PARTIAL', error: error.message });
        }
    }
    console.log('');

    // =============================================
    // EDGE CASE 9: Loan with Duration > 365 Days
    // =============================================
    console.log('EDGE CASE 9: Loan with Duration > 365 Days\n');
    try {
        const loanAmount = ethers.parseUnits('100', 6);
        const collateralPercent = await reputationManager.calculateCollateralRequirement(alice.address);
        const requiredCollateral = (loanAmount * collateralPercent) / 100n;

        if (requiredCollateral > 0) {
            await usdc.connect(aliceWallet).approve(addresses.agentLiquidityMarketplace, requiredCollateral);
        }

        await marketplace.connect(aliceWallet).requestLoan(loanAmount, 400); // 400 days
        console.log('❌ FAILED: Should reject duration > 365 days');
        results.push({ test: 'Long duration', status: 'FAIL', reason: 'Accepted > 365 days' });
    } catch (error) {
        if (error.message.includes('Invalid duration')) {
            console.log('✅ PASSED: Correctly rejected long duration');
            results.push({ test: 'Long duration', status: 'PASS' });
        } else {
            console.log(`⚠️  PARTIAL: Rejected but wrong error: ${error.message}`);
            results.push({ test: 'Long duration', status: 'PARTIAL', error: error.message });
        }
    }
    console.log('');

    // =============================================
    // EDGE CASE 10: Claim Interest with None Available
    // =============================================
    console.log('EDGE CASE 10: Claim Interest with None Earned\n');
    try {
        // Use Bob who hasn't earned anything
        const position = await marketplace.getLenderPosition(bob.agentId, deployer.address);

        if (position.earnedInterest === 0n) {
            await marketplace.claimInterest(bob.agentId);
            console.log('❌ FAILED: Should reject claim with no interest');
            results.push({ test: 'Empty claim', status: 'FAIL', reason: 'Allowed empty claim' });
        } else {
            console.log('⏭️  SKIPPED: Interest available');
            results.push({ test: 'Empty claim', status: 'SKIP' });
        }
    } catch (error) {
        if (error.message.includes('No interest to claim')) {
            console.log('✅ PASSED: Correctly rejected empty claim');
            results.push({ test: 'Empty claim', status: 'PASS' });
        } else {
            console.log(`⚠️  PARTIAL: Rejected but wrong error: ${error.message}`);
            results.push({ test: 'Empty claim', status: 'PARTIAL', error: error.message });
        }
    }
    console.log('');

    // =============================================
    // SUMMARY
    // =============================================
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 EDGE CASE TEST SUMMARY\n');

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
            console.log(`   - ${r.test}: ${r.reason}`);
        });
        console.log('');
    }

    if (partial > 0) {
        console.log('⚠️  PARTIAL TESTS (wrong error messages):\n');
        results.filter(r => r.status === 'PARTIAL').forEach(r => {
            console.log(`   - ${r.test}: ${r.error}`);
        });
        console.log('');
    }

    // Save results
    const reportPath = path.join(__dirname, '..', 'edge-case-test-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({ results, summary: { passed, failed, partial, skipped } }, null, 2));
    console.log(`📁 Report saved to: edge-case-test-report.json\n`);

    if (failed === 0) {
        console.log('🎉 All edge cases handled correctly!\n');
        process.exit(0);
    } else {
        console.log('❌ Some edge cases not properly handled. Review and fix.\n');
        process.exit(1);
    }
}

main().catch(error => {
    console.error('Test suite error:', error);
    process.exit(1);
});
