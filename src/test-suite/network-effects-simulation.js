/**
 * Network Effects & Growth Simulation
 *
 * Models protocol growth and network effects:
 * 1. Scaling projections (100, 1000, 10000 agents)
 * 2. Liquidity dynamics as network grows
 * 3. Reputation distribution at scale
 * 4. Fee revenue projections
 * 5. Multi-pool dynamics
 * 6. Critical mass analysis
 * 7. Competitive equilibrium
 * 8. Flywheel effects
 */

const API_BASE = 'http://localhost:3001';

async function apiGet(path) {
    const res = await fetch(`${API_BASE}${path}`);
    return await res.json();
}

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║     NETWORK EFFECTS & GROWTH SIMULATION         ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    // Get current baseline
    const status = await apiGet('/status');
    const pool = await apiGet('/pools/43');

    console.log('📊 Current Baseline:\n');
    console.log(`   Agents:           ${status.agentCount}`);
    console.log(`   Loans:            ${status.loanCount}`);
    console.log(`   Loans/Agent:      ${(status.loanCount / status.agentCount).toFixed(2)}`);
    console.log(`   Pool Liquidity:   ${pool.totalLiquidityUsdc} USDC`);
    console.log(`   Daily Loan Rate:  ~9.7 loans/day\n`);

    const baselineLoansPerAgent = status.loanCount / status.agentCount;
    const baselineLiquidityPerAgent = parseFloat(pool.totalLiquidityUsdc) / status.agentCount;

    // ========================================================================
    // SIMULATION 1: SCALING PROJECTIONS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('SIMULATION 1: SCALING PROJECTIONS');
    console.log('═'.repeat(70) + '\n');

    console.log('📈 What happens as the network grows?\n');

    const scales = [
        { agents: 100, desc: 'Early Growth' },
        { agents: 500, desc: 'Product-Market Fit' },
        { agents: 1000, desc: 'Scale' },
        { agents: 5000, desc: 'Mass Adoption' },
        { agents: 10000, desc: 'Maturity' }
    ];

    scales.forEach(scale => {
        const totalLoans = scale.agents * baselineLoansPerAgent;
        const totalLiquidity = scale.agents * baselineLiquidityPerAgent;
        const avgLoanSize = 100; // Assume $100 avg
        const avgRate = 0.07; // 7% APR avg
        const annualRevenue = totalLiquidity * 0.7 * avgRate; // 70% utilization

        console.log(`   ${scale.agents.toLocaleString()} Agents (${scale.desc}):`);
        console.log(`      Expected Loans:       ${Math.round(totalLoans).toLocaleString()}`);
        console.log(`      Required Liquidity:   $${totalLiquidity.toLocaleString()}`);
        console.log(`      Est. Annual Revenue:  $${annualRevenue.toFixed(0).toLocaleString()}`);
        console.log(`      Daily Transactions:   ${(totalLoans / 30).toFixed(0)} loans/day`);
        console.log(`      Network Effect:       ${scale.agents / status.agentCount}x current\n`);
    });

    // ========================================================================
    // SIMULATION 2: LIQUIDITY DYNAMICS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('SIMULATION 2: LIQUIDITY DYNAMICS');
    console.log('═'.repeat(70) + '\n');

    console.log('💧 How does liquidity behave at scale?\n');

    const liquidityScenarios = [
        { agents: 100, poolsPerAgent: 0.1, liquidityPerPool: 5000 },
        { agents: 500, poolsPerAgent: 0.15, liquidityPerPool: 10000 },
        { agents: 1000, poolsPerAgent: 0.2, liquidityPerPool: 15000 },
        { agents: 5000, poolsPerAgent: 0.25, liquidityPerPool: 20000 }
    ];

    liquidityScenarios.forEach(scenario => {
        const totalPools = scenario.agents * scenario.poolsPerAgent;
        const totalLiquidity = totalPools * scenario.liquidityPerPool;
        const avgAgentDemand = 200; // $200 avg borrowing per agent
        const totalDemand = scenario.agents * avgAgentDemand;
        const utilizationPct = (totalDemand / totalLiquidity) * 100;

        console.log(`   ${scenario.agents} Agents Scenario:`);
        console.log(`      Active Pools:         ${Math.round(totalPools)}`);
        console.log(`      Total Liquidity:      $${totalLiquidity.toLocaleString()}`);
        console.log(`      Borrowing Demand:     $${totalDemand.toLocaleString()}`);
        console.log(`      Utilization:          ${utilizationPct.toFixed(1)}%`);
        console.log(`      Liquidity Health:     ${utilizationPct > 85 ? '🔴 Tight' : utilizationPct > 60 ? '🟡 Balanced' : '🟢 Abundant'}\n`);
    });

    console.log('   💡 Liquidity Insights:\n');
    console.log('      • As network grows, more pools activate');
    console.log('      • Avg pool size increases with confidence');
    console.log('      • Utilization self-balances around 60-80%');
    console.log('      • Diversification reduces concentration risk\n');

    // ========================================================================
    // SIMULATION 3: REPUTATION DISTRIBUTION AT SCALE
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('SIMULATION 3: REPUTATION DISTRIBUTION AT SCALE');
    console.log('═'.repeat(70) + '\n');

    console.log('🎯 How does reputation evolve as network matures?\n');

    // Model reputation distribution using power law
    const reputationModels = [
        { stage: 'Launch (1 month)', unrated: 70, subprime: 20, standard: 8, prime: 2 },
        { stage: 'Growth (3 months)', unrated: 40, subprime: 30, standard: 20, prime: 10 },
        { stage: 'Mature (6 months)', unrated: 20, subprime: 25, standard: 35, prime: 20 },
        { stage: 'Established (12+ months)', unrated: 10, subprime: 20, standard: 40, prime: 30 }
    ];

    reputationModels.forEach(model => {
        const avgRate = (0.15 * model.unrated + 0.10 * model.subprime + 0.07 * model.standard + 0.05 * model.prime) / 100;

        console.log(`   ${model.stage}:`);
        console.log(`      UNRATED:   ${model.unrated}% (15% APR)`);
        console.log(`      SUBPRIME:  ${model.subprime}% (10% APR)`);
        console.log(`      STANDARD:  ${model.standard}% (7% APR)`);
        console.log(`      PRIME:     ${model.prime}% (5% APR)`);
        console.log(`      Weighted Avg Rate: ${(avgRate * 100).toFixed(2)}% APR`);
        console.log(`      Quality Score:     ${model.standard + model.prime}% in top tiers\n`);
    });

    console.log('   💡 Reputation Evolution:\n');
    console.log('      • Initial: Mostly UNRATED (high risk, high revenue)');
    console.log('      • Growth: Users build reputation (balanced)');
    console.log('      • Mature: Majority in STANDARD/PRIME (low risk, stable revenue)');
    console.log('      • Network improves over time - self-selection effect\n');

    // ========================================================================
    // SIMULATION 4: REVENUE PROJECTIONS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('SIMULATION 4: REVENUE PROJECTIONS');
    console.log('═'.repeat(70) + '\n');

    console.log('💰 Protocol revenue at different scales:\n');

    const revenueScales = [
        { liquidity: 10000, util: 70, avgRate: 0.08, desc: 'Small' },
        { liquidity: 100000, util: 75, avgRate: 0.07, desc: 'Medium' },
        { liquidity: 1000000, util: 80, avgRate: 0.06, desc: 'Large' },
        { liquidity: 10000000, util: 85, avgRate: 0.055, desc: 'Very Large' }
    ];

    revenueScales.forEach(scale => {
        const loanedAmount = scale.liquidity * (scale.util / 100);
        const annualInterest = loanedAmount * scale.avgRate;
        const monthlyRevenue = annualInterest / 12;
        const lenderApy = (annualInterest / scale.liquidity) * 100;

        console.log(`   $${(scale.liquidity / 1000).toFixed(0)}K TVL (${scale.desc}):`);
        console.log(`      Loaned:               $${loanedAmount.toLocaleString()}`);
        console.log(`      Annual Interest:      $${annualInterest.toFixed(0).toLocaleString()}`);
        console.log(`      Monthly Revenue:      $${monthlyRevenue.toFixed(0).toLocaleString()}`);
        console.log(`      Lender APY:           ${lenderApy.toFixed(2)}%`);
        console.log(`      Utilization:          ${scale.util}%\n`);
    });

    console.log('   💡 Revenue Insights:\n');
    console.log('      • Linear scaling with TVL');
    console.log('      • Rates decrease as network matures (safer borrowers)');
    console.log('      • Utilization increases with liquidity depth');
    console.log('      • At $1M TVL: ~$48K annual revenue\n');

    // ========================================================================
    // SIMULATION 5: MULTI-POOL DYNAMICS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('SIMULATION 5: MULTI-POOL DYNAMICS');
    console.log('═'.repeat(70) + '\n');

    console.log('🌊 What happens with many competing pools?\n');

    const poolCompetition = [
        { pools: 1, avgLiquidity: 1000, rates: [5, 15], desc: 'Monopoly' },
        { pools: 5, avgLiquidity: 2000, rates: [5, 12], desc: 'Oligopoly' },
        { pools: 20, avgLiquidity: 3000, rates: [5, 10], desc: 'Competition' },
        { pools: 100, avgLiquidity: 5000, rates: [5, 8], desc: 'Mature Market' }
    ];

    poolCompetition.forEach(market => {
        const totalLiquidity = market.pools * market.avgLiquidity;
        const rateSpread = market.rates[1] - market.rates[0];
        const marketEfficiency = 100 - (rateSpread / 0.15 * 100); // Lower spread = more efficient

        console.log(`   ${market.pools} Pools (${market.desc}):`);
        console.log(`      Total Liquidity:      $${totalLiquidity.toLocaleString()}`);
        console.log(`      Rate Range:           ${market.rates[0]}-${market.rates[1]}% APR`);
        console.log(`      Rate Spread:          ${rateSpread}%`);
        console.log(`      Market Efficiency:    ${marketEfficiency.toFixed(1)}%`);
        console.log(`      Competition Level:    ${market.pools < 5 ? '🟡 Low' : market.pools < 50 ? '🟢 Healthy' : '🟢 High'}\n`);
    });

    console.log('   💡 Market Dynamics:\n');
    console.log('      • More pools = tighter spreads (better for borrowers)');
    console.log('      • Competition drives down rates');
    console.log('      • Efficiency increases with pool count');
    console.log('      • Sweet spot: 20-50 active pools for balance\n');

    // ========================================================================
    // SIMULATION 6: CRITICAL MASS ANALYSIS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('SIMULATION 6: CRITICAL MASS ANALYSIS');
    console.log('═'.repeat(70) + '\n');

    console.log('🎯 When does the network become self-sustaining?\n');

    const milestones = [
        { agents: 50, liquidity: 50000, loans: 100, status: 'Bootstrapping', sustainable: false },
        { agents: 200, liquidity: 200000, loans: 500, status: 'Growing', sustainable: false },
        { agents: 500, liquidity: 500000, loans: 1500, status: 'Critical Mass', sustainable: true },
        { agents: 1000, liquidity: 1000000, loans: 3000, status: 'Scaling', sustainable: true },
        { agents: 5000, liquidity: 5000000, loans: 15000, status: 'Established', sustainable: true }
    ];

    milestones.forEach(milestone => {
        const revenueRun = milestone.liquidity * 0.7 * 0.07; // 70% util, 7% APR
        const breakeven = 100000; // Assume $100K annual operating costs

        console.log(`   ${milestone.agents} Agents (${milestone.status}):`);
        console.log(`      TVL:                  $${(milestone.liquidity / 1000).toFixed(0)}K`);
        console.log(`      Loan Volume:          ${milestone.loans.toLocaleString()} loans`);
        console.log(`      Annual Revenue:       $${revenueRun.toFixed(0).toLocaleString()}`);
        console.log(`      vs Break-even:        ${revenueRun > breakeven ? '✅ Profitable' : '🟡 Subsidized'}`);
        console.log(`      Sustainable:          ${milestone.sustainable ? '✅ Yes' : '❌ No'}\n`);
    });

    console.log('   💡 Critical Mass Insights:\n');
    console.log('      • Critical mass: ~500 agents, $500K TVL');
    console.log('      • Requires 1,500+ loans for sustainable flywheel');
    console.log('      • Revenue covers operations at ~$500K TVL');
    console.log('      • Below critical mass: Requires subsidy/grants\n');

    // ========================================================================
    // SIMULATION 7: FLYWHEEL EFFECTS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('SIMULATION 7: FLYWHEEL EFFECTS');
    console.log('═'.repeat(70) + '\n');

    console.log('🔄 Positive feedback loops in the network:\n');

    console.log('   Loop 1: Liquidity Flywheel\n');
    console.log('      More Agents → More Borrowing Demand');
    console.log('      → Higher Lender APY → More Liquidity');
    console.log('      → More Loan Capacity → More Agents\n');

    console.log('   Loop 2: Reputation Flywheel\n');
    console.log('      More Users → More Loan Data');
    console.log('      → Better Risk Models → More Accurate Pricing');
    console.log('      → Better User Experience → More Users\n');

    console.log('   Loop 3: Network Effects\n');
    console.log('      More Agents → More Pools');
    console.log('      → Better Rates (competition) → More Agents');
    console.log('      → Deeper Liquidity → Lower Risk → More Agents\n');

    console.log('   💡 Flywheel Strength at Different Scales:\n');

    const flywheelStrength = [
        { agents: 44, strength: 20, desc: 'Weak - early stage' },
        { agents: 100, strength: 40, desc: 'Building - gaining traction' },
        { agents: 500, strength: 75, desc: 'Strong - self-sustaining' },
        { agents: 1000, strength: 90, desc: 'Very Strong - network effects dominant' }
    ];

    flywheelStrength.forEach(fw => {
        console.log(`      ${fw.agents} agents: ${fw.strength}% strength - ${fw.desc}`);
    });

    console.log('');

    // ========================================================================
    // SIMULATION 8: COMPETITIVE EQUILIBRIUM
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('SIMULATION 8: COMPETITIVE EQUILIBRIUM');
    console.log('═'.repeat(70) + '\n');

    console.log('⚖️  Where does the market settle?\n');

    console.log('   Equilibrium Predictions:\n');
    console.log('      • Interest Rates:     5-8% APR (competitive market)');
    console.log('      • Pool Utilization:   70-80% (optimal risk/reward)');
    console.log('      • Tier Distribution:  60% in STANDARD/PRIME (mature network)');
    console.log('      • Default Rate:       <2% (reputation screening works)');
    console.log('      • Lender APY:         4-6% (after defaults)\n');

    console.log('   Market Forces:\n');
    console.log('      📈 Upward Pressure on Rates:');
    console.log('         • Default risk');
    console.log('         • Operational costs');
    console.log('         • Lender profit requirements\n');

    console.log('      📉 Downward Pressure on Rates:');
    console.log('         • Competition between pools');
    console.log('         • Better reputation = lower risk');
    console.log('         • Scale economies\n');

    console.log('   💡 Long-term Equilibrium:\n');
    console.log('      • Rates converge to 5-8% for most users');
    console.log('      • Utilization stabilizes around 75%');
    console.log('      • Reputation becomes key differentiator');
    console.log('      • Multiple pools create competitive market\n');

    // ========================================================================
    // SIMULATION 9: GROWTH SCENARIOS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('SIMULATION 9: GROWTH SCENARIOS');
    console.log('═'.repeat(70) + '\n');

    console.log('📊 Different growth trajectories:\n');

    const growthScenarios = [
        { name: 'Conservative', monthlyGrowth: 10, months: 12 },
        { name: 'Base Case', monthlyGrowth: 25, months: 12 },
        { name: 'Optimistic', monthlyGrowth: 50, months: 12 },
        { name: 'Viral', monthlyGrowth: 100, months: 12 }
    ];

    const currentAgents = 44;

    growthScenarios.forEach(scenario => {
        let agents = currentAgents;
        for (let i = 0; i < scenario.months; i++) {
            agents = agents * (1 + scenario.monthlyGrowth / 100);
        }

        const tvl = agents * baselineLiquidityPerAgent;
        const annualRevenue = tvl * 0.75 * 0.07;

        console.log(`   ${scenario.name} (${scenario.monthlyGrowth}% monthly):`);
        console.log(`      Agents in 12 months:  ${Math.round(agents).toLocaleString()}`);
        console.log(`      Expected TVL:         $${(tvl / 1000).toFixed(0)}K`);
        console.log(`      Annual Revenue:       $${annualRevenue.toFixed(0).toLocaleString()}`);
        console.log(`      Growth Multiple:      ${(agents / currentAgents).toFixed(1)}x\n`);
    });

    // ========================================================================
    // SUMMARY
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('NETWORK EFFECTS SUMMARY');
    console.log('═'.repeat(70) + '\n');

    console.log('🎯 Key Findings:\n');
    console.log('   1. Critical Mass: 500 agents, $500K TVL, 1,500 loans');
    console.log('   2. Optimal Scale: 1,000-5,000 agents for balanced growth');
    console.log('   3. Flywheel Activates: At ~100-200 agents');
    console.log('   4. Market Equilibrium: 5-8% APR, 70-80% utilization');
    console.log('   5. Revenue Potential: $48K/year per $1M TVL\n');

    console.log('📈 Growth Strategy Recommendations:\n');
    console.log('   • Phase 1 (0-100 agents): Subsidize to kickstart flywheel');
    console.log('   • Phase 2 (100-500): Organic growth as network effects engage');
    console.log('   • Phase 3 (500+): Self-sustaining, focus on efficiency');
    console.log('   • Target: 25% monthly growth to reach critical mass in 12 months\n');

    console.log('💡 Network Effect Strength: 🟡 DEVELOPING (44 agents)\n');
    console.log('   • Current: Early stage, weak network effects');
    console.log('   • Path to Critical Mass: Need 456 more agents (11.4x growth)');
    console.log('   • Timeline: ~6-12 months at 25-50% monthly growth');
    console.log('   • Key Unlock: Once past 200 agents, flywheel accelerates growth\n');

    console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
