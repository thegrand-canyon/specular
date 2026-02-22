/**
 * Stress Test on Base Mainnet
 * Run multiple loan cycles to validate production readiness
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://mainnet.base.org';
const DEPLOYER_KEY = process.env.PRIVATE_KEY;

// Test parameters
const LOAN_CYCLES = 15;
const LOAN_AMOUNT = ethers.parseUnits('3', 6); // 3 USDC per loan
const LOAN_DURATION = 30; // days

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  BASE MAINNET STRESS TEST                        ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet(DEPLOYER_KEY, provider);

    console.log(`🔑 Agent: ${wallet.address}`);
    console.log(`🎯 Target: ${LOAN_CYCLES} loan cycles`);
    console.log(`💰 Loan size: ${ethers.formatUnits(LOAN_AMOUNT, 6)} USDC\n`);

    // Load addresses and ABIs
    const addresses = JSON.parse(fs.readFileSync('./src/config/base-addresses.json', 'utf8'));

    const marketplaceAbi = JSON.parse(fs.readFileSync(
        './artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json',
        'utf8'
    )).abi;

    const rmAbi = JSON.parse(fs.readFileSync(
        './artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json',
        'utf8'
    )).abi;

    const usdcAbi = [
        'function balanceOf(address) view returns (uint256)',
        'function approve(address spender, uint256 amount) returns (bool)',
    ];

    const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, marketplaceAbi, wallet);
    const reputationManager = new ethers.Contract(addresses.reputationManagerV3, rmAbi, wallet);
    const usdc = new ethers.Contract(addresses.usdc, usdcAbi, wallet);

    // Initial checks
    console.log('📊 Initial Status:');
    const initialBalance = await usdc.balanceOf(wallet.address);
    const initialScore = await reputationManager['getReputationScore(address)'](wallet.address);

    console.log(`   USDC Balance: ${ethers.formatUnits(initialBalance, 6)}`);
    console.log(`   Reputation Score: ${initialScore}\n`);

    // Approve large amount upfront for all loans
    console.log('🔓 Approving USDC for all operations...');
    const maxApproval = ethers.parseUnits('1000', 6);
    const approveTx = await usdc.approve(addresses.agentLiquidityMarketplace, maxApproval);
    await approveTx.wait();
    console.log('   ✅ Approved\n');

    // Track metrics
    const results = {
        successful: 0,
        failed: 0,
        totalGasUsed: 0n,
        totalInterestPaid: 0n,
        startTime: Date.now(),
        loans: []
    };

    console.log('🔄 Starting loan cycles...\n');
    console.log('═'.repeat(70));

    for (let i = 1; i <= LOAN_CYCLES; i++) {
        const cycleStart = Date.now();

        try {
            console.log(`\n📋 Cycle ${i}/${LOAN_CYCLES}`);

            // Get current score
            const score = await reputationManager['getReputationScore(address)'](wallet.address);
            console.log(`   Reputation: ${score}`);

            // Request loan
            console.log(`   Requesting ${ethers.formatUnits(LOAN_AMOUNT, 6)} USDC...`);
            const requestTx = await marketplace.requestLoan(LOAN_AMOUNT, LOAN_DURATION);
            const requestReceipt = await requestTx.wait();

            // Parse loan ID from event
            const event = requestReceipt.logs.find(log => {
                try {
                    return marketplace.interface.parseLog(log).name === 'LoanRequested';
                } catch { return false; }
            });

            const loanId = marketplace.interface.parseLog(event).args.loanId;
            console.log(`   ✅ Loan #${loanId} active`);

            results.totalGasUsed += requestReceipt.gasUsed;

            // Small delay
            await new Promise(r => setTimeout(r, 2000));

            // Calculate repayment
            const loan = await marketplace.loans(loanId);
            const interest = await marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
            const repayAmount = BigInt(loan.amount) + BigInt(interest);

            // Repay loan
            console.log(`   Repaying ${ethers.formatUnits(repayAmount, 6)} USDC...`);
            const repayTx = await marketplace.repayLoan(loanId);
            const repayReceipt = await repayTx.wait();

            console.log(`   ✅ Repaid (interest: ${ethers.formatUnits(interest, 6)} USDC)`);

            results.totalGasUsed += repayReceipt.gasUsed;
            results.totalInterestPaid += interest;

            const cycleTime = ((Date.now() - cycleStart) / 1000).toFixed(1);
            console.log(`   ⏱️  Cycle time: ${cycleTime}s`);

            results.successful++;
            results.loans.push({
                loanId: Number(loanId),
                amount: Number(ethers.formatUnits(loan.amount, 6)),
                interest: Number(ethers.formatUnits(interest, 6)),
                gasUsed: Number(requestReceipt.gasUsed + repayReceipt.gasUsed),
                cycleTime: parseFloat(cycleTime)
            });

            // Small delay between cycles
            await new Promise(r => setTimeout(r, 1000));

        } catch (error) {
            console.log(`   ❌ Failed: ${error.message}`);
            results.failed++;

            // If we hit a hard error, check what it is
            if (error.message.includes('Too many active loans')) {
                console.log('\n⚠️  Hit concurrent loan limit. This is expected behavior.\n');
                break;
            }
            if (error.message.includes('Insufficient')) {
                console.log('\n⚠️  Insufficient balance. Stopping test.\n');
                break;
            }
        }
    }

    console.log('\n═'.repeat(70));

    // Final status
    console.log('\n📊 Final Status:');
    const finalBalance = await usdc.balanceOf(wallet.address);
    const finalScore = await reputationManager['getReputationScore(address)'](wallet.address);

    console.log(`   USDC Balance: ${ethers.formatUnits(finalBalance, 6)}`);
    console.log(`   Reputation Score: ${finalScore} (was ${initialScore})\n`);

    // Calculate metrics
    const totalTime = ((Date.now() - results.startTime) / 1000).toFixed(1);
    const avgGasPerCycle = results.successful > 0 ? Number(results.totalGasUsed / BigInt(results.successful)) : 0;
    const successRate = ((results.successful / (results.successful + results.failed)) * 100).toFixed(1);

    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  STRESS TEST RESULTS                             ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    console.log('✅ Success Rate:', successRate + '%');
    console.log(`   Completed: ${results.successful}/${LOAN_CYCLES}`);
    console.log(`   Failed: ${results.failed}\n`);

    console.log('⏱️  Performance:');
    console.log(`   Total time: ${totalTime}s`);
    console.log(`   Avg cycle time: ${(parseFloat(totalTime) / results.successful).toFixed(1)}s`);
    console.log(`   Throughput: ${(results.successful / parseFloat(totalTime) * 60).toFixed(1)} loans/min\n`);

    console.log('⛽ Gas Usage:');
    console.log(`   Total gas: ${results.totalGasUsed.toLocaleString()}`);
    console.log(`   Avg per cycle: ${avgGasPerCycle.toLocaleString()}`);
    console.log(`   Estimated cost: $${(Number(results.totalGasUsed) * 0.1 / 1e9 * 3000 * 0.001).toFixed(2)}\n`);

    console.log('💰 Economics:');
    console.log(`   Total borrowed: ${results.successful * Number(ethers.formatUnits(LOAN_AMOUNT, 6))} USDC`);
    console.log(`   Total interest paid: ${ethers.formatUnits(results.totalInterestPaid, 6)} USDC`);
    console.log(`   Avg interest per loan: ${(Number(ethers.formatUnits(results.totalInterestPaid, 6)) / results.successful).toFixed(6)} USDC\n`);

    console.log('📈 Reputation Progress:');
    console.log(`   Score change: +${finalScore - initialScore} points\n`);

    if (results.successful >= LOAN_CYCLES * 0.9) {
        console.log('🎉 STRESS TEST PASSED!\n');
        console.log('✅ Base mainnet is production-ready for multi-chain expansion!\n');
    } else {
        console.log('⚠️  Some issues encountered. Review logs above.\n');
    }

    // Save detailed results
    const report = {
        network: 'base-mainnet',
        timestamp: new Date().toISOString(),
        agent: wallet.address,
        config: {
            cycles: LOAN_CYCLES,
            loanAmount: ethers.formatUnits(LOAN_AMOUNT, 6) + ' USDC',
            duration: LOAN_DURATION + ' days'
        },
        results: {
            successful: results.successful,
            failed: results.failed,
            successRate: parseFloat(successRate),
            totalTime: parseFloat(totalTime),
            totalGasUsed: results.totalGasUsed.toString(),
            totalInterestPaid: ethers.formatUnits(results.totalInterestPaid, 6),
            initialScore: Number(initialScore),
            finalScore: Number(finalScore),
            scoreDelta: Number(finalScore - initialScore),
            loans: results.loans
        }
    };

    fs.writeFileSync(
        './BASE_STRESS_TEST_RESULTS.json',
        JSON.stringify(report, null, 2)
    );

    console.log('💾 Detailed results saved to: BASE_STRESS_TEST_RESULTS.json\n');
}

main().catch(err => {
    console.error('\n❌ Test failed:', err.message);
    console.error(err);
    process.exit(1);
});
