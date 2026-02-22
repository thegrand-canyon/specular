/**
 * Complete Agent Lifecycle Using Only the Specular API
 *
 * This example demonstrates the full journey of an AI agent using
 * only HTTP requests to the Specular Agent API - no direct contract calls.
 *
 * Journey:
 * 1. Discover the protocol via /.well-known
 * 2. Register as a new agent
 * 3. Build reputation from score 100 → 500 → 750 → 1000
 * 4. See improvements in rates and limits at each tier
 * 5. Track costs, earnings, and ROI
 */

const { ethers } = require('ethers');

const API_BASE = 'http://localhost:3001';
const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';

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

// Helper: Send transaction
async function sendTx(wallet, txData, description) {
    console.log(`\n📤 ${description}...`);
    const tx = await wallet.sendTransaction({
        to: txData.to,
        data: txData.data
    });
    console.log(`   TX: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);
    return receipt;
}

// Helper: Approve USDC spending
async function approveUSDC(wallet, usdcAddress, spender, amount) {
    const usdcContract = new ethers.Contract(
        usdcAddress,
        ['function approve(address,uint256) returns(bool)'],
        wallet
    );
    const tx = await usdcContract.approve(spender, amount);
    console.log(`   Approving USDC... ${tx.hash}`);
    await tx.wait();
    console.log(`   ✅ USDC approved`);
}

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   Specular Agent - Full Lifecycle via API       ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    // Setup wallet (use a fresh wallet or existing one)
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
        console.log('❌ PRIVATE_KEY not set');
        console.log('   export PRIVATE_KEY=0x...\n');
        process.exit(1);
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet(privateKey, provider);

    console.log(`👤 Agent Address: ${wallet.address}\n`);

    // STEP 1: Discover Protocol
    console.log('═'.repeat(70));
    console.log('STEP 1: DISCOVER PROTOCOL');
    console.log('═'.repeat(70));

    const discovery = await apiGet('/.well-known/specular.json');
    console.log('\n✅ Protocol discovered:');
    console.log(`   Name: ${discovery.protocol} v${discovery.version}`);
    console.log(`   Network: ${discovery.network} (chainId ${discovery.chainId})`);
    console.log(`   API: ${discovery.api}`);
    console.log(`   Contracts: ${Object.keys(discovery.contracts).length} deployed`);

    const usdc = discovery.contracts.mockUSDC;
    const marketplace = discovery.contracts.agentLiquidityMarketplace;

    // Check if already registered
    let profile = await apiGet(`/agents/${wallet.address}`);

    if (profile.registered) {
        console.log(`\n✅ Already registered as Agent #${profile.agentId}`);
        console.log(`   Reputation Score: ${profile.reputation.score}`);
        console.log(`   Tier: ${profile.reputation.tier}`);
    } else {
        // STEP 2: Register as Agent
        console.log('\n' + '═'.repeat(70));
        console.log('STEP 2: REGISTER AS AGENT');
        console.log('═'.repeat(70));

        const registerTx = await apiPost('/tx/register', {
            metadata: JSON.stringify({
                name: 'API Test Agent',
                version: '1.0',
                description: 'Testing full lifecycle via API',
                timestamp: new Date().toISOString()
            })
        });

        await sendTx(wallet, registerTx, 'Registering as agent');

        // Verify registration
        await new Promise(r => setTimeout(r, 2000));
        profile = await apiGet(`/agents/${wallet.address}`);
        console.log(`\n✅ Registration confirmed!`);
        console.log(`   Agent ID: ${profile.agentId}`);
        console.log(`   Initial Score: ${profile.reputation.score}`);
    }

    // STEP 3: Request Credit Report (x402 payment)
    console.log('\n' + '═'.repeat(70));
    console.log('STEP 3: REQUEST CREDIT REPORT (x402 Payment)');
    console.log('═'.repeat(70));

    try {
        const creditReport = await apiGet(`/credit/${wallet.address}`);
        console.log('\n✅ Credit report received (paid 1 USDC via x402):');
        console.log(`   Score: ${creditReport.score}`);
        console.log(`   Tier: ${creditReport.tier}`);
        console.log(`   Max Loan: ${creditReport.maxLoanUsdc} USDC`);
        console.log(`   Interest Rate: ${creditReport.interestRatePct}%`);
        console.log(`   Collateral Required: ${creditReport.collateralPct}%`);
    } catch (error) {
        console.log('\n⚠️  Credit report skipped (requires wallet integration)');
        console.log(`   Error: ${error.message}`);
    }

    // STEP 4: Find Best Pool
    console.log('\n' + '═'.repeat(70));
    console.log('STEP 4: FIND LIQUIDITY POOLS');
    console.log('═'.repeat(70));

    const pools = await apiGet('/pools');
    console.log(`\n✅ Found ${pools.count} active pools:`);
    pools.pools.forEach(pool => {
        console.log(`   Pool #${pool.id}: ${pool.availableLiquidityUsdc} USDC available (${pool.utilizationPct}% utilized)`);
    });

    // STEP 5: Build Reputation - Tier by Tier
    console.log('\n' + '═'.repeat(70));
    console.log('STEP 5: BUILD REPUTATION (BORROW → REPAY CYCLES)');
    console.log('═'.repeat(70));

    const tiers = [
        { name: 'BAD_CREDIT', targetScore: 100, loanAmount: 10, cycles: 0 },
        { name: 'SUBPRIME', targetScore: 500, loanAmount: 20, cycles: 5 },
        { name: 'FAIR', targetScore: 750, loanAmount: 50, cycles: 8 },
        { name: 'GOOD', targetScore: 1000, loanAmount: 100, cycles: 10 }
    ];

    let currentTier = 0;
    let totalCost = 0;
    let totalPaid = 0;
    let loanHistory = [];

    // Get current score
    profile = await apiGet(`/agents/${wallet.address}`);
    let currentScore = profile.reputation.score;

    console.log(`\nStarting Score: ${currentScore}`);
    console.log(`Starting Tier: ${profile.reputation.tier}\n`);

    // Determine which tier we're at
    if (currentScore >= 1000) currentTier = 4;
    else if (currentScore >= 750) currentTier = 3;
    else if (currentScore >= 500) currentTier = 2;
    else if (currentScore >= 100) currentTier = 1;

    // Build reputation tier by tier
    for (let tier = currentTier; tier < tiers.length; tier++) {
        const target = tiers[tier];

        console.log(`\n${'─'.repeat(70)}`);
        console.log(`TARGET: ${target.name} (Score ${target.targetScore}+)`);
        console.log(`${'─'.repeat(70)}`);

        // Get fresh profile
        profile = await apiGet(`/agents/${wallet.address}`);
        currentScore = profile.reputation.score;

        if (currentScore >= target.targetScore && tier > 0) {
            console.log(`✅ Already at tier ${target.name} (score ${currentScore})`);
            continue;
        }

        const cyclesNeeded = target.cycles - loanHistory.length;
        console.log(`\nNeed ${cyclesNeeded} on-time loan cycles to reach ${target.targetScore}`);
        console.log(`Loan amount: ${target.loanAmount} USDC each`);

        for (let cycle = 0; cycle < cyclesNeeded; cycle++) {
            console.log(`\n  Cycle ${cycle + 1}/${cyclesNeeded}:`);

            // Request loan
            const loanTx = await apiPost('/tx/request-loan', {
                amount: target.loanAmount,
                durationDays: 7
            });

            // Approve collateral first
            const collateralAmount = ethers.parseUnits(
                (target.loanAmount * (profile.reputation.collateralRequiredPct / 100)).toString(),
                6
            );
            await approveUSDC(wallet, usdc, marketplace, collateralAmount);

            // Send loan request
            const loanReceipt = await sendTx(wallet, loanTx, `Requesting ${target.loanAmount} USDC loan`);

            // Parse loan ID from event
            const loanId = parseInt(loanReceipt.logs[loanReceipt.logs.length - 1].topics[1], 16);
            console.log(`   Loan ID: ${loanId}`);

            // Wait a moment for block
            await new Promise(r => setTimeout(r, 2000));

            // Check loan details
            const loan = await apiGet(`/loans/${loanId}`);
            console.log(`   Amount: ${loan.amountUsdc} USDC`);
            console.log(`   Collateral: ${loan.collateralUsdc} USDC`);
            console.log(`   Rate: ${loan.interestRatePct}%`);
            console.log(`   Duration: ${loan.durationDays} days`);

            // Repay immediately (simulate work being done)
            await new Promise(r => setTimeout(r, 2000));

            const repayTx = await apiPost('/tx/repay-loan', { loanId });

            // Approve repayment amount
            const repayAmount = ethers.parseUnits(repayTx.repayAmount, 0); // Already in units
            await approveUSDC(wallet, usdc, marketplace, repayAmount);

            // Send repayment
            await sendTx(wallet, repayTx, `Repaying loan #${loanId}`);

            // Track costs
            const interest = parseFloat(repayTx.repayAmount) / 1e6 - loan.amountUsdc;
            totalCost += interest;
            totalPaid += parseFloat(repayTx.repayAmount) / 1e6;

            loanHistory.push({
                loanId,
                amount: loan.amountUsdc,
                interest,
                rate: loan.interestRatePct
            });

            console.log(`   Interest paid: ${interest.toFixed(6)} USDC`);
            console.log(`   ✅ Loan repaid (+10 reputation)`);

            // Update score
            await new Promise(r => setTimeout(r, 2000));
            profile = await apiGet(`/agents/${wallet.address}`);
            currentScore = profile.reputation.score;
            console.log(`   New Score: ${currentScore} (${profile.reputation.tier})`);
        }

        console.log(`\n✅ Reached ${target.name} tier!`);
        console.log(`   Score: ${currentScore}`);
        console.log(`   Credit Limit: ${profile.reputation.creditLimitUsdc} USDC`);
        console.log(`   Interest Rate: ${profile.reputation.interestRatePct}%`);
        console.log(`   Collateral: ${profile.reputation.collateralRequiredPct}%`);
    }

    // FINAL SUMMARY
    console.log('\n' + '═'.repeat(70));
    console.log('JOURNEY COMPLETE!');
    console.log('═'.repeat(70));

    profile = await apiGet(`/agents/${wallet.address}`);

    console.log(`\n📊 Final Stats:`);
    console.log(`   Agent ID: ${profile.agentId}`);
    console.log(`   Reputation Score: ${profile.reputation.score}`);
    console.log(`   Tier: ${profile.reputation.tier}`);
    console.log(`   Credit Limit: ${profile.reputation.creditLimitUsdc} USDC`);
    console.log(`   Interest Rate: ${profile.reputation.interestRatePct}%`);
    console.log(`   Collateral Required: ${profile.reputation.collateralRequiredPct}%`);

    console.log(`\n💰 Financial Summary:`);
    console.log(`   Total Loans: ${loanHistory.length}`);
    console.log(`   Total Borrowed: ${loanHistory.reduce((sum, l) => sum + l.amount, 0)} USDC`);
    console.log(`   Total Repaid: ${totalPaid.toFixed(2)} USDC`);
    console.log(`   Total Interest Paid: ${totalCost.toFixed(6)} USDC`);
    console.log(`   Average Rate: ${(totalCost / loanHistory.reduce((sum, l) => sum + l.amount, 0) * 100).toFixed(2)}%`);

    console.log(`\n🎯 Tier Progression:`);
    console.log(`   100 (BAD_CREDIT)    → 100% collateral, 15% APR`);
    console.log(`   500 (SUBPRIME)      → 25% collateral, 10% APR`);
    console.log(`   750 (FAIR)          → 0% collateral, 7% APR`);
    console.log(`   1000 (GOOD)         → 0% collateral, 5% APR`);

    console.log('\n═'.repeat(70));
    console.log('✅ All operations completed using only the Specular API!');
    console.log('═'.repeat(70) + '\n');
}

main().catch(error => {
    console.error('\n❌ Error:', error);
    process.exit(1);
});
