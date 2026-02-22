/**
 * Build Agent Reputation to Target Score
 *
 * Repeatedly borrows and repays loans to build reputation score.
 * Includes rate limit protection and progress tracking.
 */

const { ethers } = require('ethers');

const API_BASE = 'http://localhost:3001';
const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const DELAY_BETWEEN_CYCLES = 3000; // 3 seconds to avoid rate limits

// Helper: API request
async function apiGet(path) {
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok) throw new Error(`API error: ${res.statusText}`);
    return await res.json();
}

async function apiPost(path, body) {
    const res = await fetch(`${API_BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`API error: ${res.statusText}`);
    return await res.json();
}

// Helper: Approve USDC spending
async function approveUSDC(wallet, usdcAddress, spender, amount) {
    const usdcContract = new ethers.Contract(
        usdcAddress,
        ['function approve(address,uint256) returns(bool)'],
        wallet
    );
    const tx = await usdcContract.approve(spender, amount);
    await tx.wait();
}

// Helper: Send transaction with retry
async function sendTxWithRetry(wallet, txData, description, maxRetries = 3) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            const tx = await wallet.sendTransaction({
                to: txData.to,
                data: txData.data
            });
            const receipt = await tx.wait();
            return receipt;
        } catch (error) {
            if (attempt === maxRetries) throw error;

            console.log(`   ⚠️  Attempt ${attempt} failed, retrying in 5s...`);
            await new Promise(r => setTimeout(r, 5000));
        }
    }
}

async function borrowAndRepay(wallet, usdc, marketplace, loanAmount, description) {
    try {
        // Get fresh profile to check collateral requirements
        const profile = await apiGet(`/agents/${wallet.address}`);

        // Request loan
        const loanTx = await apiPost('/tx/request-loan', {
            amount: loanAmount,
            durationDays: 7
        });

        // Approve collateral if needed
        const collateralAmount = ethers.parseUnits(
            (loanAmount * (profile.reputation.collateralRequiredPct / 100)).toString(),
            6
        );
        if (collateralAmount > 0n) {
            await approveUSDC(wallet, usdc, marketplace, collateralAmount);
        }

        // Send loan request
        const loanReceipt = await sendTxWithRetry(wallet, loanTx, `Request ${loanAmount} USDC loan`);
        const loanId = parseInt(loanReceipt.logs[loanReceipt.logs.length - 1].topics[1], 16);

        // Wait for block confirmation
        await new Promise(r => setTimeout(r, 2000));

        // Get loan details
        const loan = await apiGet(`/loans/${loanId}`);

        // Repay loan
        const repayTx = await apiPost('/tx/repay-loan', { loanId });

        // Approve repayment amount
        const repayAmount = ethers.parseUnits(repayTx.repayAmount, 0);
        await approveUSDC(wallet, usdc, marketplace, repayAmount);

        // Send repayment
        await sendTxWithRetry(wallet, repayTx, `Repay loan #${loanId}`);

        // Calculate interest
        const interest = parseFloat(repayTx.repayAmount) / 1e6 - loan.amountUsdc;

        return {
            success: true,
            loanId,
            amount: loan.amountUsdc,
            interest,
            rate: loan.interestRatePct
        };

    } catch (error) {
        return {
            success: false,
            error: error.message
        };
    }
}

async function main() {
    const targetScore = parseInt(process.env.TARGET_SCORE || '1000');
    const cycleDelay = parseInt(process.env.CYCLE_DELAY || DELAY_BETWEEN_CYCLES);

    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   Build Reputation - Automated Loan Cycles      ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
        console.log('❌ PRIVATE_KEY not set\n');
        process.exit(1);
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet(privateKey, provider);

    console.log(`👤 Agent: ${wallet.address}`);
    console.log(`🎯 Target Score: ${targetScore}\n`);

    // Get discovery info
    const discovery = await apiGet('/.well-known/specular.json');
    const usdc = discovery.contracts.mockUSDC;
    const marketplace = discovery.contracts.agentLiquidityMarketplace;

    // Get starting profile
    let profile = await apiGet(`/agents/${wallet.address}`);
    if (!profile.registered) {
        console.log('❌ Agent not registered\n');
        process.exit(1);
    }

    const startScore = profile.reputation.score;
    const startTier = profile.reputation.tier;

    console.log('═'.repeat(70));
    console.log('STARTING STATUS');
    console.log('═'.repeat(70));
    console.log(`Score: ${startScore}`);
    console.log(`Tier: ${startTier}`);
    console.log(`Credit Limit: ${profile.reputation.creditLimitUsdc} USDC`);
    console.log(`Interest Rate: ${profile.reputation.interestRatePct}%`);
    console.log(`Collateral: ${profile.reputation.collateralRequiredPct}%`);
    console.log('');

    if (startScore >= targetScore) {
        console.log(`✅ Already at target score ${targetScore}!\n`);
        process.exit(0);
    }

    // Calculate cycles needed (+10 per cycle)
    const pointsNeeded = targetScore - startScore;
    const cyclesNeeded = Math.ceil(pointsNeeded / 10);

    console.log('═'.repeat(70));
    console.log('PLAN');
    console.log('═'.repeat(70));
    console.log(`Current Score: ${startScore}`);
    console.log(`Target Score: ${targetScore}`);
    console.log(`Points Needed: ${pointsNeeded}`);
    console.log(`Cycles Required: ${cyclesNeeded} (10 points per cycle)`);
    console.log(`Estimated Time: ${Math.ceil(cyclesNeeded * (cycleDelay / 1000 + 10))} seconds`);
    console.log('');

    // Determine loan amount based on tier
    let loanAmount = 50; // Default
    if (startScore < 500) loanAmount = 20;
    else if (startScore < 750) loanAmount = 50;
    else loanAmount = 100;

    console.log(`Loan Amount: ${loanAmount} USDC per cycle\n`);
    console.log('Starting in 3 seconds...\n');
    await new Promise(r => setTimeout(r, 3000));

    // Track progress
    let currentScore = startScore;
    let totalInterest = 0;
    let completedCycles = 0;
    let failedCycles = 0;

    // Main loop
    for (let cycle = 1; cycle <= cyclesNeeded; cycle++) {
        console.log('─'.repeat(70));
        console.log(`Cycle ${cycle}/${cyclesNeeded} (Score: ${currentScore} → ${Math.min(currentScore + 10, targetScore)})`);
        console.log('─'.repeat(70));

        const result = await borrowAndRepay(
            wallet,
            usdc,
            marketplace,
            loanAmount,
            `Cycle ${cycle}`
        );

        if (result.success) {
            completedCycles++;
            totalInterest += result.interest;

            console.log(`✅ Loan #${result.loanId}: ${result.amount} USDC @ ${result.rate}%`);
            console.log(`   Interest: ${result.interest.toFixed(6)} USDC`);

            // Wait for score update
            await new Promise(r => setTimeout(r, 2000));

            // Get updated score
            profile = await apiGet(`/agents/${wallet.address}`);
            currentScore = profile.reputation.score;

            console.log(`   New Score: ${currentScore} (${profile.reputation.tier})`);

            // Check for tier upgrade
            if (currentScore === 500 || currentScore === 670 || currentScore === 750 || currentScore === 1000) {
                console.log('\n🎉 TIER UPGRADE! 🎉');
                console.log(`   Tier: ${profile.reputation.tier}`);
                console.log(`   Credit Limit: ${profile.reputation.creditLimitUsdc} USDC`);
                console.log(`   Interest Rate: ${profile.reputation.interestRatePct}%`);
                console.log(`   Collateral: ${profile.reputation.collateralRequiredPct}%\n`);

                // Adjust loan amount for better tier
                if (currentScore >= 750) loanAmount = 100;
            }

            if (currentScore >= targetScore) {
                console.log('\n🎯 TARGET SCORE REACHED! 🎯\n');
                break;
            }

        } else {
            failedCycles++;
            console.log(`❌ Cycle failed: ${result.error}`);

            if (result.error.includes('timeout') || result.error.includes('rate')) {
                console.log(`   Waiting 10s before retry...\n`);
                await new Promise(r => setTimeout(r, 10000));
            }
        }

        // Delay between cycles to avoid rate limits
        if (cycle < cyclesNeeded) {
            await new Promise(r => setTimeout(r, cycleDelay));
        }
    }

    // Final summary
    console.log('\n' + '═'.repeat(70));
    console.log('FINAL RESULTS');
    console.log('═'.repeat(70));

    const finalProfile = await apiGet(`/agents/${wallet.address}`);

    console.log(`\n📊 Score Progress:`);
    console.log(`   Starting: ${startScore} (${startTier})`);
    console.log(`   Ending: ${finalProfile.reputation.score} (${finalProfile.reputation.tier})`);
    console.log(`   Gained: +${finalProfile.reputation.score - startScore} points`);

    console.log(`\n💰 Financial Summary:`);
    console.log(`   Completed Cycles: ${completedCycles}`);
    console.log(`   Failed Cycles: ${failedCycles}`);
    console.log(`   Total Borrowed: ${completedCycles * loanAmount} USDC`);
    console.log(`   Total Interest: ${totalInterest.toFixed(6)} USDC`);
    console.log(`   Average Per Loan: ${(totalInterest / completedCycles).toFixed(6)} USDC`);

    console.log(`\n🎯 Final Status:`);
    console.log(`   Tier: ${finalProfile.reputation.tier}`);
    console.log(`   Credit Limit: ${finalProfile.reputation.creditLimitUsdc} USDC`);
    console.log(`   Interest Rate: ${finalProfile.reputation.interestRatePct}%`);
    console.log(`   Collateral: ${finalProfile.reputation.collateralRequiredPct}%`);

    console.log('\n' + '═'.repeat(70));
    if (finalProfile.reputation.score >= targetScore) {
        console.log('✅ SUCCESS - Target score achieved!');
    } else {
        console.log('⚠️  INCOMPLETE - Target score not reached');
    }
    console.log('═'.repeat(70) + '\n');
}

main().catch(error => {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
});
