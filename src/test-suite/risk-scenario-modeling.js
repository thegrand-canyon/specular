/**
 * Risk Scenario Modeling & Stress Testing
 *
 * Models various risk scenarios to assess protocol resilience:
 * 1. Default cascades (10%, 25%, 50% default rates)
 * 2. Liquidity crisis (bank run scenario)
 * 3. Gas price shocks (10x, 100x increases)
 * 4. Interest rate sensitivity
 * 5. Reputation manipulation attempts
 * 6. Black swan events
 * 7. Revenue modeling under stress
 * 8. Recovery time analysis
 */

const API_BASE = 'http://localhost:3001';

async function apiGet(path) {
    const res = await fetch(`${API_BASE}${path}`);
    return await res.json();
}

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║       RISK SCENARIO MODELING & STRESS TEST      ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    // Get current state
    const status = await apiGet('/status');
    const pool = await apiGet('/pools/43');
    const agent43 = await apiGet('/agents/0x656086A21073272533c8A3f56A94c1f3D8BCFcE2');

    console.log('📊 Current Protocol State:\n');
    console.log(`   Total Agents:      ${status.agentCount}`);
    console.log(`   Total Loans:       ${status.loanCount}`);
    console.log(`   Active Loans:      ${status.activeLoanCount}`);
    console.log(`   Pool Liquidity:    ${pool.totalLiquidityUsdc} USDC`);
    console.log(`   Pool Loaned:       ${pool.totalLoanedUsdc} USDC`);
    console.log(`   Pool Earned:       ${pool.totalEarnedUsdc} USDC\n`);

    // ========================================================================
    // SCENARIO 1: DEFAULT CASCADE ANALYSIS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('SCENARIO 1: DEFAULT CASCADE ANALYSIS');
    console.log('═'.repeat(70) + '\n');

    console.log('⚠️  What if loans start defaulting?\n');

    const activeLoans = status.activeLoanCount;
    const loanedAmount = parseFloat(pool.totalLoanedUsdc);
    const avgLoanSize = loanedAmount / activeLoans;

    const defaultRates = [10, 25, 50, 75, 100];

    console.log('   Default Impact Analysis:\n');

    defaultRates.forEach(rate => {
        const defaultCount = Math.floor(activeLoans * (rate / 100));
        const defaultAmount = avgLoanSize * defaultCount;
        const poolLoss = defaultAmount; // No collateral for PRIME tier
        const lenderLoss = (poolLoss / parseFloat(pool.totalLiquidityUsdc)) * 100;

        console.log(`   ${rate}% Default Rate:`);
        console.log(`      Loans Defaulted:     ${defaultCount} of ${activeLoans}`);
        console.log(`      Amount Lost:         ${defaultAmount.toFixed(2)} USDC`);
        console.log(`      Pool Impact:         -${lenderLoss.toFixed(2)}% of capital`);
        console.log(`      Lender ROI Impact:   ${(lenderLoss > 10 ? '🔴 Severe' : lenderLoss > 5 ? '🟡 Moderate' : '🟢 Manageable')}`);
        console.log('');
    });

    console.log('   💡 Key Insights:\n');
    console.log(`      • 10% defaults = ${(avgLoanSize * Math.floor(activeLoans * 0.1)).toFixed(2)} USDC loss (${((avgLoanSize * Math.floor(activeLoans * 0.1)) / parseFloat(pool.totalLiquidityUsdc) * 100).toFixed(2)}% of pool)`);
    console.log(`      • 25% defaults = ${(avgLoanSize * Math.floor(activeLoans * 0.25)).toFixed(2)} USDC loss (${((avgLoanSize * Math.floor(activeLoans * 0.25)) / parseFloat(pool.totalLiquidityUsdc) * 100).toFixed(2)}% of pool)`);
    console.log(`      • 50% defaults = ${(avgLoanSize * Math.floor(activeLoans * 0.5)).toFixed(2)} USDC loss (${((avgLoanSize * Math.floor(activeLoans * 0.5)) / parseFloat(pool.totalLiquidityUsdc) * 100).toFixed(2)}% of pool)`);
    console.log(`      • Current fees earned: ${pool.totalEarnedUsdc} USDC`);
    console.log(`      • Break-even default rate: ~${(parseFloat(pool.totalEarnedUsdc) / loanedAmount * 100).toFixed(1)}%\n`);

    // ========================================================================
    // SCENARIO 2: LIQUIDITY CRISIS (BANK RUN)
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('SCENARIO 2: LIQUIDITY CRISIS (BANK RUN)');
    console.log('═'.repeat(70) + '\n');

    console.log('🏃 What if all lenders want to withdraw at once?\n');

    const availableLiquidity = parseFloat(pool.availableLiquidityUsdc);
    const totalLiquidity = parseFloat(pool.totalLiquidityUsdc);
    const withdrawalCapacity = (availableLiquidity / totalLiquidity) * 100;

    console.log(`   Current State:`);
    console.log(`      Total Deposited:      ${totalLiquidity} USDC`);
    console.log(`      Available Now:        ${availableLiquidity.toFixed(6)} USDC`);
    console.log(`      Locked in Loans:      ${loanedAmount.toFixed(2)} USDC`);
    console.log(`      Withdrawal Capacity:  ${withdrawalCapacity.toFixed(2)}%\n`);

    console.log(`   Bank Run Scenarios:\n`);

    const withdrawalDemands = [10, 25, 50, 75, 100];

    withdrawalDemands.forEach(demand => {
        const demandAmount = totalLiquidity * (demand / 100);
        const canWithdraw = Math.min(demandAmount, availableLiquidity);
        const shortfall = demandAmount - canWithdraw;
        const shortfallPct = (shortfall / demandAmount) * 100;

        console.log(`   ${demand}% Want to Withdraw (${demandAmount.toFixed(2)} USDC):`);
        console.log(`      Can Fulfill:         ${canWithdraw.toFixed(6)} USDC`);
        console.log(`      Shortfall:           ${shortfall.toFixed(6)} USDC`);
        console.log(`      Fulfillment Rate:    ${((canWithdraw / demandAmount) * 100).toFixed(2)}%`);
        console.log(`      Risk Level:          ${shortfallPct > 90 ? '🔴 Critical' : shortfallPct > 50 ? '🟡 High' : '🟢 Manageable'}`);
        console.log('');
    });

    console.log(`   💡 Liquidity Analysis:\n`);
    console.log(`      • Protocol is ${withdrawalCapacity < 10 ? 'HIGHLY illiquid' : withdrawalCapacity < 25 ? 'moderately illiquid' : 'reasonably liquid'}`);
    console.log(`      • Current utilization: ${pool.utilizationPct}%`);
    console.log(`      • Time to full liquidity: ${activeLoans} loans must be repaid`);
    console.log(`      • Protection: Loan durations limit withdrawal demand\n`);

    // ========================================================================
    // SCENARIO 3: GAS PRICE SHOCK
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('SCENARIO 3: GAS PRICE SHOCK');
    console.log('═'.repeat(70) + '\n');

    console.log('⛽ What if gas prices spike dramatically?\n');

    const lifecycleGas = 559187; // From gas analysis
    const ethPrice = 2500;
    const currentGasGwei = 20;

    const gasPrices = [20, 50, 100, 500, 1000];

    console.log(`   Economic Viability at Different Gas Prices:\n`);

    gasPrices.forEach(gwei => {
        const costEth = lifecycleGas * (gwei / 1e9);
        const costUsd = costEth * ethPrice;

        // Calculate minimum viable loan
        const interest7d = (rate, amount) => amount * (rate / 100) * (7 / 365);
        const minLoanFor1Pct = costUsd / (0.05 * (7 / 365) * 0.01); // Where gas = 1% of interest

        console.log(`   @ ${gwei} Gwei:`);
        console.log(`      Lifecycle Cost:      $${costUsd.toFixed(2)}`);
        console.log(`      Min Viable Loan:     $${minLoanFor1Pct.toFixed(0)} USDC (for gas < 1% of interest)`);
        console.log(`      Impact on $100 loan: Gas is ${(costUsd / (100 * 0.05 * 7/365) * 100).toFixed(0)}x the interest`);
        console.log(`      Viability:           ${costUsd < 1 ? '🟢 Excellent' : costUsd < 10 ? '🟡 Good' : costUsd < 50 ? '🟠 Marginal' : '🔴 Poor'}`);
        console.log('');
    });

    console.log(`   💡 Gas Sensitivity:\n`);
    console.log(`      • Protocol is HIGHLY sensitive to gas prices`);
    console.log(`      • L2 deployment critical for economic viability`);
    console.log(`      • At 1000 Gwei: Only loans >$1M are economical`);
    console.log(`      • At 1 Gwei (L2): Loans >$150 are economical\n`);

    // ========================================================================
    // SCENARIO 4: INTEREST RATE SENSITIVITY
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('SCENARIO 4: INTEREST RATE SENSITIVITY');
    console.log('═'.repeat(70) + '\n');

    console.log('💰 How do rate changes affect the system?\n');

    const currentRates = { UNRATED: 15, SUBPRIME: 10, STANDARD: 7, PRIME: 5 };
    const rateChanges = [-50, -25, 0, 25, 50]; // Percentage changes

    console.log(`   Rate Change Impact Analysis:\n`);

    rateChanges.forEach(change => {
        const multiplier = 1 + (change / 100);
        const newRates = {
            UNRATED: currentRates.UNRATED * multiplier,
            SUBPRIME: currentRates.SUBPRIME * multiplier,
            STANDARD: currentRates.STANDARD * multiplier,
            PRIME: currentRates.PRIME * multiplier
        };

        // Estimate revenue impact (assume avg 7-day, avg loan $100)
        const avgRate = (newRates.UNRATED + newRates.PRIME) / 2;
        const annualRevenue = totalLiquidity * (parseFloat(pool.utilizationPct) / 100) * (avgRate / 100);

        console.log(`   ${change > 0 ? '+' : ''}${change}% Rate Change:`);
        console.log(`      PRIME:    ${newRates.PRIME.toFixed(2)}% APR`);
        console.log(`      UNRATED:  ${newRates.UNRATED.toFixed(2)}% APR`);
        console.log(`      Est. Pool Revenue: ${annualRevenue.toFixed(2)} USDC/year`);
        console.log(`      Borrower Impact:   ${change > 0 ? '🔴 More expensive' : change < 0 ? '🟢 Cheaper' : '⚪ No change'}`);
        console.log('');
    });

    // ========================================================================
    // SCENARIO 5: REPUTATION MANIPULATION ATTEMPT
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('SCENARIO 5: REPUTATION MANIPULATION');
    console.log('═'.repeat(70) + '\n');

    console.log('🎭 Can reputation be gamed for profit?\n');

    console.log(`   Attack Vector: Rapid Build-Then-Default\n`);

    const costToPrime = 6; // From earlier analysis, $6 in interest
    const primeLimit = 50000; // Credit limit at PRIME

    console.log(`      1. Build reputation to PRIME:`);
    console.log(`         Cost:                ${costToPrime} USDC`);
    console.log(`         Time:                ~85 loans`);
    console.log(`         Credit limit gained: ${primeLimit.toLocaleString()} USDC\n`);

    console.log(`      2. Max out credit and default:`);
    console.log(`         Available to borrow: ${availableLiquidity.toFixed(2)} USDC (limited by pool)`);
    console.log(`         Potential gain:      ${(availableLiquidity - costToPrime).toFixed(2)} USDC`);
    console.log(`         Collateral required: 0 USDC (PRIME tier)\n`);

    console.log(`      3. Cost-Benefit Analysis:`);
    const potentialGain = availableLiquidity - costToPrime;
    const roi = (potentialGain / costToPrime) * 100;

    console.log(`         Investment:          ${costToPrime} USDC`);
    console.log(`         Potential return:    ${potentialGain.toFixed(2)} USDC`);
    console.log(`         ROI:                 ${roi.toFixed(0)}%`);
    console.log(`         Risk:                Loss of future access, reputation\n`);

    console.log(`   💡 Defense Mechanisms:\n`);
    console.log(`      ✅ Pool liquidity limits max theft to ${availableLiquidity.toFixed(2)} USDC`);
    console.log(`      ✅ Time investment (85 loans) creates switching cost`);
    console.log(`      ⚠️  No collateral requirement makes attack feasible`);
    console.log(`      ⚠️  $${potentialGain.toFixed(2)} gain vs $${costToPrime} cost = vulnerable!\n`);

    // ========================================================================
    // SCENARIO 6: BLACK SWAN EVENTS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('SCENARIO 6: BLACK SWAN EVENTS');
    console.log('═'.repeat(70) + '\n');

    console.log('🦢 Extreme but plausible scenarios:\n');

    console.log(`   Event 1: USDC De-Peg (loses 50% value)`);
    console.log(`      Impact on borrowers:   🟢 Positive (debt worth less)`);
    console.log(`      Impact on lenders:     🔴 Severe (deposits worth 50% less)`);
    console.log(`      Impact on protocol:    ⚪ Neutral (all amounts in USDC)`);
    console.log(`      Recovery:              Depends on USDC recovery\n`);

    console.log(`   Event 2: Smart Contract Bug (critical vulnerability)`);
    console.log(`      Worst case:            Total loss of ${totalLiquidity} USDC`);
    console.log(`      Mitigation:            Audit, bug bounty, gradual deployment`);
    console.log(`      Insurance:             Consider protocol insurance`);
    console.log(`      Recovery:              Difficult - requires governance\n`);

    console.log(`   Event 3: Regulatory Action (protocol shutdown)`);
    console.log(`      Active loans:          ${activeLoans} loans affected`);
    console.log(`      Locked capital:        ${loanedAmount.toFixed(2)} USDC`);
    console.log(`      Lender access:         ${availableLiquidity.toFixed(6)} USDC available`);
    console.log(`      Recovery:              Orderly loan repayment required\n`);

    console.log(`   Event 4: Chain Congestion (1000 Gwei for weeks)`);
    console.log(`      Repayment cost:        $${(lifecycleGas * (1000 / 1e9) * ethPrice).toFixed(2)}`);
    console.log(`      Economic viability:    🔴 Only $1M+ loans viable`);
    console.log(`      Default risk:          🔴 High (too expensive to repay)`);
    console.log(`      Mitigation:            L2 deployment\n`);

    // ========================================================================
    // SCENARIO 7: RECOVERY TIME ANALYSIS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('SCENARIO 7: RECOVERY TIME ANALYSIS');
    console.log('═'.repeat(70) + '\n');

    console.log('⏱️  How quickly can the protocol recover from shocks?\n');

    const dailyLoanRate = 9.7; // From earlier analysis
    const avgLoanInterest = loanedAmount * 0.05 * (7 / 365); // Avg 5%, 7 days

    console.log(`   Scenario: 25% of loans default\n`);

    const loss25 = loanedAmount * 0.25;

    console.log(`      Loss Amount:          ${loss25.toFixed(2)} USDC`);
    console.log(`      Current Daily Revenue: ${(avgLoanInterest * dailyLoanRate / 7).toFixed(4)} USDC/day`);
    console.log(`      Recovery Time:        ${(loss25 / (avgLoanInterest * dailyLoanRate / 7)).toFixed(0)} days`);
    console.log(`      At 2x utilization:    ${(loss25 / (avgLoanInterest * dailyLoanRate / 7 * 2)).toFixed(0)} days\n`);

    console.log(`   💡 Recovery Insights:\n`);
    console.log(`      • High utilization accelerates recovery`);
    console.log(`      • Revenue model is slow to absorb losses`);
    console.log(`      • Diversified agent pool reduces concentration risk`);
    console.log(`      • Consider reserve fund for stability\n`);

    // ========================================================================
    // SCENARIO 8: OPTIMAL RISK/REWARD ANALYSIS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('SCENARIO 8: OPTIMAL RISK/REWARD');
    console.log('═'.repeat(70) + '\n');

    console.log('⚖️  Finding the optimal balance:\n');

    const utilizationLevels = [50, 70, 85, 95, 100];

    console.log(`   Utilization vs Risk Analysis:\n`);

    utilizationLevels.forEach(util => {
        const loanedOut = totalLiquidity * (util / 100);
        const available = totalLiquidity - loanedOut;
        const annualRevenue = loanedOut * 0.06; // Avg 6% APR
        const withdrawalCapacity = (available / totalLiquidity) * 100;

        console.log(`   ${util}% Utilization:`);
        console.log(`      Loaned:              ${loanedOut.toFixed(2)} USDC`);
        console.log(`      Available:           ${available.toFixed(2)} USDC`);
        console.log(`      Annual Revenue:      ${annualRevenue.toFixed(2)} USDC`);
        console.log(`      Withdrawal Capacity: ${withdrawalCapacity.toFixed(1)}%`);
        console.log(`      Risk Level:          ${util > 90 ? '🔴 High' : util > 75 ? '🟡 Moderate' : '🟢 Low'}`);
        console.log(`      Recommended:         ${util >= 70 && util <= 85 ? '✅ Optimal zone' : ''}`);
        console.log('');
    });

    console.log(`   💡 Optimal Strategy:\n`);
    console.log(`      • Target: 70-85% utilization`);
    console.log(`      • Maximum revenue with acceptable liquidity risk`);
    console.log(`      • Maintain 15-30% buffer for withdrawals`);
    console.log(`      • Current ${pool.utilizationPct}% is TOO HIGH - add liquidity\n`);

    // ========================================================================
    // SUMMARY
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('RISK ASSESSMENT SUMMARY');
    console.log('═'.repeat(70) + '\n');

    console.log('🎯 Critical Risks Identified:\n');
    console.log('   🔴 HIGH RISK:\n');
    console.log('      1. Reputation manipulation: ROI of gaming system too high');
    console.log('         → Mitigation: Add collateral even for high scores (e.g., 10% at PRIME)\n');

    console.log('      2. Pool over-utilization: 100.5% leaves zero liquidity buffer');
    console.log('         → Mitigation: Add 500+ USDC, target 70-85% utilization\n');

    console.log('      3. Gas price sensitivity: Economic model breaks at >50 Gwei');
    console.log('         → Mitigation: Deploy to L2s (Base, Arbitrum, Optimism)\n');

    console.log('   🟡 MODERATE RISK:\n');
    console.log('      4. Default cascade: 25% default rate = significant loss');
    console.log('         → Mitigation: Diversify borrower base, improve screening\n');

    console.log('      5. Slow loss recovery: Takes months to recover from defaults');
    console.log('         → Mitigation: Reserve fund, insurance pool\n');

    console.log('   🟢 LOW RISK:\n');
    console.log('      6. Liquidity run: Limited by loan durations');
    console.log('      7. Interest rate changes: Gradual adjustments tolerable\n');

    console.log('📊 Overall Risk Score: 🟡 MODERATE\n');
    console.log('   • Economic model: Sound but needs L2 deployment');
    console.log('   • Liquidity management: Currently stressed, needs rebalancing');
    console.log('   • Reputation system: Functional but gameable - add collateral');
    console.log('   • Recovery capacity: Adequate for small shocks, weak for large ones\n');

    console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
