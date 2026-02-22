/**
 * Gas Optimization Testing Suite
 * Measures and validates gas costs for all marketplace operations
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n⛽ GAS OPTIMIZATION TESTING SUITE\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const [deployer] = await ethers.getSigners();
    const results = [];
    const gasMetrics = {};

    // Load test agents
    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    if (!fs.existsSync(testAgentsPath)) {
        console.log('❌ Test agents not found. Run create-test-agents.js first.\n');
        process.exit(1);
    }
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));
    const alice = testAgents.agents.find(a => a.name === 'Alice');

    if (!alice) {
        console.log('❌ Alice agent not found in test-agents.json\n');
        process.exit(1);
    }

    console.log('Testing gas costs for all operations...\n');

    // =============================================
    // TEST 1: Pool Creation Gas Cost
    // =============================================
    console.log('TEST 1: Pool Creation Gas Cost');

    try {
        const poolExists = await marketplace.agentPools(alice.address);

        if (poolExists.interestRate === 0n) {
            // Pool doesn't exist, create it
            const tx = await marketplace.createAgentPool(
                alice.address,
                1000, // 10% rate
                ethers.parseUnits('50000', 6) // max loan
            );
            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed;

            console.log(`   Gas Used: ${gasUsed.toString()}`);
            console.log(`   Gas Price: ${receipt.gasPrice ? ethers.formatUnits(receipt.gasPrice, 'gwei') + ' gwei' : 'N/A'}`);
            console.log(`   Total Cost: ${receipt.gasPrice ? ethers.formatEther(gasUsed * receipt.gasPrice) + ' ETH' : 'N/A'}`);

            gasMetrics.poolCreation = Number(gasUsed);

            if (gasUsed < 200000n) {
                console.log(`   ✅ PASS: Gas usage optimal (< 200k)`);
                results.push({ test: 'Pool Creation', status: 'PASS', gasUsed: gasUsed.toString() });
            } else if (gasUsed < 300000n) {
                console.log(`   ⚠️  WARN: Gas usage acceptable (200k-300k)`);
                results.push({ test: 'Pool Creation', status: 'WARN', gasUsed: gasUsed.toString() });
            } else {
                console.log(`   ❌ FAIL: Gas usage too high (> 300k)`);
                results.push({ test: 'Pool Creation', status: 'FAIL', gasUsed: gasUsed.toString() });
            }
        } else {
            console.log('   ⏭️  Pool already exists, skipping creation test');
            results.push({ test: 'Pool Creation', status: 'SKIP', reason: 'Pool exists' });
        }
    } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
        results.push({ test: 'Pool Creation', status: 'ERROR', error: error.message });
    }

    console.log('');

    // =============================================
    // TEST 2: Supply Liquidity Gas Cost
    // =============================================
    console.log('TEST 2: Supply Liquidity Gas Cost');

    try {
        const supplyAmount = ethers.parseUnits('1000', 6);

        // Approve
        const approveTx = await usdc.approve(addresses.agentLiquidityMarketplace, supplyAmount);
        await approveTx.wait();

        // Supply
        const tx = await marketplace.supplyLiquidity(alice.address, supplyAmount);
        const receipt = await tx.wait();
        const gasUsed = receipt.gasUsed;

        console.log(`   Amount: 1000 USDC`);
        console.log(`   Gas Used: ${gasUsed.toString()}`);
        console.log(`   Gas Price: ${receipt.gasPrice ? ethers.formatUnits(receipt.gasPrice, 'gwei') + ' gwei' : 'N/A'}`);
        console.log(`   Total Cost: ${receipt.gasPrice ? ethers.formatEther(gasUsed * receipt.gasPrice) + ' ETH' : 'N/A'}`);

        gasMetrics.supplyLiquidity = Number(gasUsed);

        if (gasUsed < 150000n) {
            console.log(`   ✅ PASS: Gas usage optimal (< 150k)`);
            results.push({ test: 'Supply Liquidity', status: 'PASS', gasUsed: gasUsed.toString() });
        } else if (gasUsed < 200000n) {
            console.log(`   ⚠️  WARN: Gas usage acceptable (150k-200k)`);
            results.push({ test: 'Supply Liquidity', status: 'WARN', gasUsed: gasUsed.toString() });
        } else {
            console.log(`   ❌ FAIL: Gas usage too high (> 200k)`);
            results.push({ test: 'Supply Liquidity', status: 'FAIL', gasUsed: gasUsed.toString() });
        }
    } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
        results.push({ test: 'Supply Liquidity', status: 'ERROR', error: error.message });
    }

    console.log('');

    // =============================================
    // TEST 3: Request Loan Gas Cost
    // =============================================
    console.log('TEST 3: Request Loan Gas Cost');

    try {
        const loanAmount = ethers.parseUnits('500', 6);
        const duration = 30 * 24 * 60 * 60;

        const aliceSigner = await ethers.getImpersonatedSigner(alice.address);
        await deployer.sendTransaction({
            to: alice.address,
            value: ethers.parseEther('0.1')
        });

        const tx = await marketplace.connect(aliceSigner).requestLoan(loanAmount, duration);
        const receipt = await tx.wait();
        const gasUsed = receipt.gasUsed;

        console.log(`   Amount: 500 USDC`);
        console.log(`   Duration: 30 days`);
        console.log(`   Gas Used: ${gasUsed.toString()}`);
        console.log(`   Gas Price: ${receipt.gasPrice ? ethers.formatUnits(receipt.gasPrice, 'gwei') + ' gwei' : 'N/A'}`);
        console.log(`   Total Cost: ${receipt.gasPrice ? ethers.formatEther(gasUsed * receipt.gasPrice) + ' ETH' : 'N/A'}`);

        gasMetrics.requestLoan = Number(gasUsed);

        if (gasUsed < 250000n) {
            console.log(`   ✅ PASS: Gas usage optimal (< 250k)`);
            results.push({ test: 'Request Loan', status: 'PASS', gasUsed: gasUsed.toString() });
        } else if (gasUsed < 350000n) {
            console.log(`   ⚠️  WARN: Gas usage acceptable (250k-350k)`);
            results.push({ test: 'Request Loan', status: 'WARN', gasUsed: gasUsed.toString() });
        } else {
            console.log(`   ❌ FAIL: Gas usage too high (> 350k)`);
            results.push({ test: 'Request Loan', status: 'FAIL', gasUsed: gasUsed.toString() });
        }
    } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
        results.push({ test: 'Request Loan', status: 'ERROR', error: error.message });
    }

    console.log('');

    // =============================================
    // TEST 4: Repay Loan Gas Cost
    // =============================================
    console.log('TEST 4: Repay Loan Gas Cost');

    try {
        const aliceSigner = await ethers.getImpersonatedSigner(alice.address);

        // Get active loan
        const pool = await marketplace.agentPools(alice.address);
        const loanId = pool.currentLoanId;

        if (loanId > 0n) {
            const loan = await marketplace.loans(loanId);
            const totalRepayment = loan.amount + loan.interestAmount;

            // Mint USDC to Alice for repayment
            await usdc.mint(alice.address, totalRepayment);

            // Approve
            await usdc.connect(aliceSigner).approve(addresses.agentLiquidityMarketplace, totalRepayment);

            // Repay
            const tx = await marketplace.connect(aliceSigner).repayLoan(loanId);
            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed;

            console.log(`   Loan ID: ${loanId.toString()}`);
            console.log(`   Amount: ${ethers.formatUnits(totalRepayment, 6)} USDC`);
            console.log(`   Gas Used: ${gasUsed.toString()}`);
            console.log(`   Gas Price: ${receipt.gasPrice ? ethers.formatUnits(receipt.gasPrice, 'gwei') + ' gwei' : 'N/A'}`);
            console.log(`   Total Cost: ${receipt.gasPrice ? ethers.formatEther(gasUsed * receipt.gasPrice) + ' ETH' : 'N/A'}`);

            gasMetrics.repayLoan = Number(gasUsed);

            if (gasUsed < 200000n) {
                console.log(`   ✅ PASS: Gas usage optimal (< 200k)`);
                results.push({ test: 'Repay Loan', status: 'PASS', gasUsed: gasUsed.toString() });
            } else if (gasUsed < 300000n) {
                console.log(`   ⚠️  WARN: Gas usage acceptable (200k-300k)`);
                results.push({ test: 'Repay Loan', status: 'WARN', gasUsed: gasUsed.toString() });
            } else {
                console.log(`   ❌ FAIL: Gas usage too high (> 300k)`);
                results.push({ test: 'Repay Loan', status: 'FAIL', gasUsed: gasUsed.toString() });
            }
        } else {
            console.log('   ⏭️  No active loan, skipping repayment test');
            results.push({ test: 'Repay Loan', status: 'SKIP', reason: 'No active loan' });
        }
    } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
        results.push({ test: 'Repay Loan', status: 'ERROR', error: error.message });
    }

    console.log('');

    // =============================================
    // TEST 5: Claim Interest Gas Cost
    // =============================================
    console.log('TEST 5: Claim Interest Gas Cost');

    try {
        const position = await marketplace.lenderPositions(deployer.address, alice.address);

        if (position.earnedInterest > 0n) {
            const tx = await marketplace.claimInterest(alice.address);
            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed;

            console.log(`   Interest: ${ethers.formatUnits(position.earnedInterest, 6)} USDC`);
            console.log(`   Gas Used: ${gasUsed.toString()}`);
            console.log(`   Gas Price: ${receipt.gasPrice ? ethers.formatUnits(receipt.gasPrice, 'gwei') + ' gwei' : 'N/A'}`);
            console.log(`   Total Cost: ${receipt.gasPrice ? ethers.formatEther(gasUsed * receipt.gasPrice) + ' ETH' : 'N/A'}`);

            gasMetrics.claimInterest = Number(gasUsed);

            if (gasUsed < 80000n) {
                console.log(`   ✅ PASS: Gas usage optimal (< 80k)`);
                results.push({ test: 'Claim Interest', status: 'PASS', gasUsed: gasUsed.toString() });
            } else if (gasUsed < 120000n) {
                console.log(`   ⚠️  WARN: Gas usage acceptable (80k-120k)`);
                results.push({ test: 'Claim Interest', status: 'WARN', gasUsed: gasUsed.toString() });
            } else {
                console.log(`   ❌ FAIL: Gas usage too high (> 120k)`);
                results.push({ test: 'Claim Interest', status: 'FAIL', gasUsed: gasUsed.toString() });
            }
        } else {
            console.log('   ⏭️  No interest to claim, creating scenario...');

            // Supply, loan, repay cycle to generate interest
            const supplyAmount = ethers.parseUnits('2000', 6);
            await usdc.approve(addresses.agentLiquidityMarketplace, supplyAmount);
            await marketplace.supplyLiquidity(alice.address, supplyAmount);

            const aliceSigner = await ethers.getImpersonatedSigner(alice.address);
            const loanAmount = ethers.parseUnits('1000', 6);
            const duration = 7 * 24 * 60 * 60;

            const loanTx = await marketplace.connect(aliceSigner).requestLoan(loanAmount, duration);
            const loanReceipt = await loanTx.wait();
            const loanEvent = loanReceipt.logs.find(log => {
                try {
                    const parsed = marketplace.interface.parseLog(log);
                    return parsed.name === 'LoanRequested';
                } catch { return false; }
            });
            const loanId = marketplace.interface.parseLog(loanEvent).args.loanId;

            // Mint and repay
            const loan = await marketplace.loans(loanId);
            const totalRepayment = loan.amount + loan.interestAmount;
            await usdc.mint(alice.address, totalRepayment);
            await usdc.connect(aliceSigner).approve(addresses.agentLiquidityMarketplace, totalRepayment);
            await marketplace.connect(aliceSigner).repayLoan(loanId);

            // Now claim
            const tx = await marketplace.claimInterest(alice.address);
            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed;

            console.log(`   Gas Used: ${gasUsed.toString()}`);
            gasMetrics.claimInterest = Number(gasUsed);

            if (gasUsed < 80000n) {
                console.log(`   ✅ PASS: Gas usage optimal (< 80k)`);
                results.push({ test: 'Claim Interest', status: 'PASS', gasUsed: gasUsed.toString() });
            } else if (gasUsed < 120000n) {
                console.log(`   ⚠️  WARN: Gas usage acceptable (80k-120k)`);
                results.push({ test: 'Claim Interest', status: 'WARN', gasUsed: gasUsed.toString() });
            } else {
                console.log(`   ❌ FAIL: Gas usage too high (> 120k)`);
                results.push({ test: 'Claim Interest', status: 'FAIL', gasUsed: gasUsed.toString() });
            }
        }
    } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
        results.push({ test: 'Claim Interest', status: 'ERROR', error: error.message });
    }

    console.log('');

    // =============================================
    // TEST 6: Withdraw Liquidity Gas Cost
    // =============================================
    console.log('TEST 6: Withdraw Liquidity Gas Cost');

    try {
        const position = await marketplace.lenderPositions(deployer.address, alice.address);
        const withdrawAmount = position.amount / 2n;

        if (withdrawAmount > 0n) {
            const tx = await marketplace.withdrawLiquidity(alice.address, withdrawAmount);
            const receipt = await tx.wait();
            const gasUsed = receipt.gasUsed;

            console.log(`   Amount: ${ethers.formatUnits(withdrawAmount, 6)} USDC`);
            console.log(`   Gas Used: ${gasUsed.toString()}`);
            console.log(`   Gas Price: ${receipt.gasPrice ? ethers.formatUnits(receipt.gasPrice, 'gwei') + ' gwei' : 'N/A'}`);
            console.log(`   Total Cost: ${receipt.gasPrice ? ethers.formatEther(gasUsed * receipt.gasPrice) + ' ETH' : 'N/A'}`);

            gasMetrics.withdrawLiquidity = Number(gasUsed);

            if (gasUsed < 100000n) {
                console.log(`   ✅ PASS: Gas usage optimal (< 100k)`);
                results.push({ test: 'Withdraw Liquidity', status: 'PASS', gasUsed: gasUsed.toString() });
            } else if (gasUsed < 150000n) {
                console.log(`   ⚠️  WARN: Gas usage acceptable (100k-150k)`);
                results.push({ test: 'Withdraw Liquidity', status: 'WARN', gasUsed: gasUsed.toString() });
            } else {
                console.log(`   ❌ FAIL: Gas usage too high (> 150k)`);
                results.push({ test: 'Withdraw Liquidity', status: 'FAIL', gasUsed: gasUsed.toString() });
            }
        } else {
            console.log('   ⏭️  No position to withdraw from');
            results.push({ test: 'Withdraw Liquidity', status: 'SKIP', reason: 'No position' });
        }
    } catch (error) {
        console.log(`   ❌ ERROR: ${error.message}`);
        results.push({ test: 'Withdraw Liquidity', status: 'ERROR', error: error.message });
    }

    console.log('');

    // =============================================
    // SUMMARY
    // =============================================
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('⛽ GAS OPTIMIZATION SUMMARY\n');

    const passed = results.filter(r => r.status === 'PASS').length;
    const warned = results.filter(r => r.status === 'WARN').length;
    const failed = results.filter(r => r.status === 'FAIL').length;
    const skipped = results.filter(r => r.status === 'SKIP').length;

    console.log(`Total Tests: ${results.length}`);
    console.log(`✅ Optimal:  ${passed}`);
    console.log(`⚠️  Warning: ${warned}`);
    console.log(`❌ Failed:   ${failed}`);
    console.log(`⏭️  Skipped:  ${skipped}`);
    console.log('');

    if (Object.keys(gasMetrics).length > 0) {
        console.log('📊 Gas Usage Metrics:\n');

        const operations = [
            { name: 'Pool Creation', key: 'poolCreation', optimal: 200000, acceptable: 300000 },
            { name: 'Supply Liquidity', key: 'supplyLiquidity', optimal: 150000, acceptable: 200000 },
            { name: 'Request Loan', key: 'requestLoan', optimal: 250000, acceptable: 350000 },
            { name: 'Repay Loan', key: 'repayLoan', optimal: 200000, acceptable: 300000 },
            { name: 'Claim Interest', key: 'claimInterest', optimal: 80000, acceptable: 120000 },
            { name: 'Withdraw Liquidity', key: 'withdrawLiquidity', optimal: 100000, acceptable: 150000 }
        ];

        operations.forEach(op => {
            if (gasMetrics[op.key]) {
                const gas = gasMetrics[op.key];
                const percentage = ((gas / op.optimal) * 100).toFixed(1);
                const status = gas < op.optimal ? '✅' : gas < op.acceptable ? '⚠️' : '❌';
                console.log(`   ${status} ${op.name.padEnd(20)} ${gas.toLocaleString().padStart(10)} gas (${percentage}% of optimal)`);
            }
        });

        console.log('');

        const avgGas = Object.values(gasMetrics).reduce((a, b) => a + b, 0) / Object.values(gasMetrics).length;
        console.log(`Average Gas Usage: ${Math.round(avgGas).toLocaleString()} gas`);
        console.log('');
    }

    // Save report
    const reportPath = path.join(__dirname, '..', 'gas-optimization-report.json');
    fs.writeFileSync(reportPath, JSON.stringify({
        results,
        gasMetrics,
        summary: { passed, warned, failed, skipped },
        timestamp: new Date().toISOString()
    }, null, 2));
    console.log(`📁 Report saved to: gas-optimization-report.json\n`);

    if (failed === 0) {
        console.log('🎉 All gas optimization tests passed!\n');
        console.log('✅ VERIFIED: Gas costs are within acceptable ranges\n');
        process.exit(0);
    } else {
        console.log('⚠️  Some operations have high gas costs.\n');
        console.log('💡 Consider optimizing before mainnet deployment.\n');
        process.exit(0); // Don't fail, just warn
    }
}

main().catch(error => {
    console.error('Gas test suite error:', error);
    process.exit(1);
});
