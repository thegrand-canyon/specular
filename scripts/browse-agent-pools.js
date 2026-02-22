/**
 * Browse Agent Liquidity Pools
 * View all agent pools and their performance metrics
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🔍 Browsing Agent Liquidity Pools\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);
    const agentRegistry = await ethers.getContractAt('AgentRegistryV2', addresses.agentRegistry);

    console.log('Marketplace:', addresses.agentLiquidityMarketplace);
    console.log('');

    // Collect pool data for all test agents
    const poolData = [];

    for (const agent of testAgents) {
        try {
            // Get pool info
            const pool = await marketplace.getAgentPool(agent.agentId);

            // Get reputation
            const reputation = await reputationManager['getReputationScore(address)'](agent.address);
            const creditLimit = await reputationManager.calculateCreditLimit(agent.address);
            const interestRate = await reputationManager.calculateInterestRate(agent.address);
            const collateralReq = await reputationManager.calculateCollateralRequirement(agent.address);

            // Get agent metadata
            const agentInfo = await agentRegistry.agents(agent.agentId);

            // Calculate APY for lenders (rough estimate)
            const estimatedAPY = pool.totalEarned > 0 && pool.totalLiquidity > 0
                ? (Number(pool.totalEarned) * 100n * 365n) / (Number(pool.totalLiquidity) * 30n) // Assuming 30-day avg
                : 0n;

            poolData.push({
                name: agent.name,
                agentId: agent.agentId,
                address: agent.address,
                reputation: Number(reputation),
                creditLimit: pool.totalLiquidity > 0 ? Number(creditLimit) : 0,
                interestRate: Number(interestRate) / 100,
                collateralReq: Number(collateralReq),
                totalLiquidity: Number(pool.totalLiquidity) / 1e6,
                availableLiquidity: Number(pool.availableLiquidity) / 1e6,
                totalLoaned: Number(pool.totalLoaned) / 1e6,
                totalEarned: Number(pool.totalEarned) / 1e6,
                utilization: Number(pool.utilizationRate) / 100,
                lenderCount: Number(pool.lenderCount),
                estimatedAPY: Number(estimatedAPY),
                isActive: agentInfo.isActive
            });
        } catch (error) {
            console.log(`⚠️  Error fetching data for ${agent.name}: ${error.message}`);
        }
    }

    // Sort by total liquidity (most funded first)
    poolData.sort((a, b) => b.totalLiquidity - a.totalLiquidity);

    // Display pools
    console.log('📋 AVAILABLE AGENT POOLS\n');
    console.log('═══════════════════════════════════════════════════════\n');

    for (const pool of poolData) {
        console.log(`🤖 ${pool.name} (Agent #${pool.agentId})`);
        console.log(`   Address: ${pool.address.slice(0, 10)}...${pool.address.slice(-8)}`);
        console.log('');

        console.log('   📊 Pool Stats:');
        console.log(`      Total Liquidity:    ${pool.totalLiquidity.toFixed(2)} USDC`);
        console.log(`      Available:          ${pool.availableLiquidity.toFixed(2)} USDC`);
        console.log(`      Currently Loaned:   ${pool.totalLoaned.toFixed(2)} USDC`);
        console.log(`      Total Earned:       ${pool.totalEarned.toFixed(2)} USDC`);
        console.log(`      Utilization:        ${pool.utilization.toFixed(1)}%`);
        console.log(`      Lenders:            ${pool.lenderCount}`);
        console.log('');

        console.log('   🎯 Agent Profile:');
        console.log(`      Reputation:         ${pool.reputation}/1000`);
        console.log(`      Credit Limit:       ${(pool.creditLimit / 1e6).toFixed(0)} USDC`);
        console.log(`      Interest Rate:      ${pool.interestRate}% APR`);
        console.log(`      Collateral Req:     ${pool.collateralReq}%`);
        console.log('');

        console.log('   💰 Lender Returns:');
        if (pool.totalEarned > 0) {
            console.log(`      Total Earned:       ${pool.totalEarned.toFixed(2)} USDC`);
            console.log(`      Est. APY:           ${pool.estimatedAPY.toFixed(2)}%`);
        } else {
            console.log(`      No earnings yet     (New pool)`);
        }
        console.log('');

        // Investment recommendation
        console.log('   📈 Investment Score:');
        let score = 0;
        let reasons = [];

        if (pool.reputation >= 800) {
            score += 3;
            reasons.push('Excellent reputation');
        } else if (pool.reputation >= 600) {
            score += 2;
            reasons.push('Good reputation');
        } else if (pool.reputation >= 400) {
            score += 1;
            reasons.push('Average reputation');
        } else {
            reasons.push('Low reputation');
        }

        if (pool.totalEarned > 0) {
            score += 2;
            reasons.push('Proven earnings');
        }

        if (pool.utilization > 50 && pool.utilization < 90) {
            score += 1;
            reasons.push('Healthy utilization');
        }

        if (pool.lenderCount > 0) {
            score += 1;
            reasons.push('Community trust');
        }

        const rating = score >= 5 ? '⭐⭐⭐⭐⭐ Excellent' :
                       score >= 4 ? '⭐⭐⭐⭐ Good' :
                       score >= 3 ? '⭐⭐⭐ Average' :
                       score >= 2 ? '⭐⭐ Below Average' :
                                    '⭐ High Risk';

        console.log(`      ${rating}`);
        console.log(`      ${reasons.join(' • ')}`);
        console.log('');

        console.log('───────────────────────────────────────────────────────\n');
    }

    // Summary statistics
    const totalLiquidity = poolData.reduce((sum, p) => sum + p.totalLiquidity, 0);
    const totalLoaned = poolData.reduce((sum, p) => sum + p.totalLoaned, 0);
    const totalEarned = poolData.reduce((sum, p) => sum + p.totalEarned, 0);
    const activePools = poolData.filter(p => p.isActive).length;

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 MARKETPLACE SUMMARY\n');
    console.log(`   Active Pools:       ${activePools}`);
    console.log(`   Total Liquidity:    ${totalLiquidity.toFixed(2)} USDC`);
    console.log(`   Currently Loaned:   ${totalLoaned.toFixed(2)} USDC`);
    console.log(`   Total Earned:       ${totalEarned.toFixed(2)} USDC`);
    console.log(`   Avg Utilization:    ${(totalLoaned / totalLiquidity * 100).toFixed(1)}%`);
    console.log('');

    // Top agent
    const topAgent = poolData[0];
    console.log('🏆 TOP AGENT:');
    console.log(`   ${topAgent.name} with ${topAgent.totalLiquidity.toFixed(2)} USDC liquidity`);
    console.log(`   Reputation: ${topAgent.reputation}/1000`);
    console.log(`   Interest Rate: ${topAgent.interestRate}% APR`);
    console.log('');

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('💡 TIP: To supply liquidity to an agent, use:');
    console.log('   marketplace.supplyLiquidity(agentId, amount)\n');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
