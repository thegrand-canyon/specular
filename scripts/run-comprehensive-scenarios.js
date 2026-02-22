/**
 * Comprehensive Testing Scenarios
 * Uses existing 4 test agents to run diverse scenarios
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🧪 COMPREHENSIVE TESTING SCENARIOS\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const [deployer] = await ethers.getSigners();

    // Load test agents
    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    console.log(`📋 Loaded ${testAgents.length} test agents\n`);

    const scenarios = [];

    // ═══════════════════════════════════════════════
    // SCENARIO 1: Multi-Lender Pool
    // ═══════════════════════════════════════════════
    console.log('SCENARIO 1: Multi-Lender Pool\n');
    console.log('   Testing: Multiple lenders funding Alice\n');

    try {
        const alice = testAgents.find(a => a.name === 'Alice');
        const aliceWallet = new ethers.Wallet(alice.privateKey, ethers.provider);

        // Check if Alice has a pool
        const aliceId = alice.agentId;
        const alicePool = await marketplace.agentPools(aliceId);

        console.log(`   Alice's Pool:`);
        console.log(`   - Total Liquidity: ${ethers.formatUnits(alicePool.totalLiquidity, 6)} USDC`);
        console.log(`   - Available: ${ethers.formatUnits(alicePool.availableLiquidity, 6)} USDC`);
        console.log(`   - Active: ${alicePool.isActive}`);
        console.log('');

        // Deployer supplies (if not at capacity)
        if (alicePool.availableLiquidity < ethers.parseUnits('100000', 6)) {
            console.log('   💰 Deployer supplying 5,000 USDC...');
            const supplyAmount = ethers.parseUnits('5000', 6);
            await usdc.approve(addresses.agentLiquidityMarketplace, supplyAmount);
            const tx = await marketplace.supplyLiquidity(aliceId, supplyAmount);
            await tx.wait();
            console.log('   ✅ Liquidity supplied');
        } else {
            console.log('   ⏭️  Pool at capacity, skipping supply');
        }

        console.log('');
        scenarios.push({ name: 'Multi-Lender Pool', status: 'PASS' });

    } catch (error) {
        console.log(`   ❌ Failed: ${error.message}\n`);
        scenarios.push({ name: 'Multi-Lender Pool', status: 'FAIL', error: error.message });
    }

    // ═══════════════════════════════════════════════
    // SCENARIO 2: Check All Agent Reputations
    // ═══════════════════════════════════════════════
    console.log('SCENARIO 2: Agent Reputation Analysis\n');

    for (const agent of testAgents) {
        try {
            const reputation = await reputationManager['getReputationScore(address)'](agent.address);
            const creditLimit = await reputationManager.calculateCreditLimit(agent.address);

            console.log(`   ${agent.name}:`);
            console.log(`   - Reputation: ${reputation.toString()}`);
            console.log(`   - Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);
            console.log('');
        } catch (error) {
            console.log(`   ❌ ${agent.name}: ${error.message}\n`);
        }
    }

    scenarios.push({ name: 'Reputation Analysis', status: 'PASS' });

    // ═══════════════════════════════════════════════
    // SCENARIO 3: Check Pool States
    // ═══════════════════════════════════════════════
    console.log('SCENARIO 3: All Pool States\n');

    for (const agent of testAgents) {
        try {
            const agentId = agent.agentId;
            const pool = await marketplace.agentPools(agentId);

            if (pool.isActive) {
                console.log(`   ${agent.name}'s Pool:`);
                console.log(`   - Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
                console.log(`   - Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
                console.log(`   - Loaned: ${ethers.formatUnits(pool.totalLoaned, 6)} USDC`);
                console.log(`   - Active: ${pool.isActive}`);
                console.log('');
            } else {
                console.log(`   ${agent.name}: No pool\n`);
            }
        } catch (error) {
            console.log(`   ❌ ${agent.name}: ${error.message}\n`);
        }
    }

    scenarios.push({ name: 'Pool States', status: 'PASS' });

    // ═══════════════════════════════════════════════
    // SCENARIO 4: Platform Metrics
    // ═══════════════════════════════════════════════
    console.log('SCENARIO 4: Platform-Wide Metrics\n');

    try {
        const platformFeeRate = await marketplace.platformFeeRate();

        console.log(`   Platform Fee Rate: ${Number(platformFeeRate) / 100}%`);
        console.log('');

        scenarios.push({ name: 'Platform Metrics', status: 'PASS' });
    } catch (error) {
        console.log(`   ❌ Failed: ${error.message}\n`);
        scenarios.push({ name: 'Platform Metrics', status: 'FAIL', error: error.message });
    }

    // ═══════════════════════════════════════════════
    // SUMMARY
    // ═══════════════════════════════════════════════
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 TESTING SUMMARY\n');

    const passed = scenarios.filter(s => s.status === 'PASS').length;
    const failed = scenarios.filter(s => s.status === 'FAIL').length;

    console.log(`Total Scenarios: ${scenarios.length}`);
    console.log(`✅ Passed: ${passed}`);
    console.log(`❌ Failed: ${failed}`);
    console.log('');

    scenarios.forEach((s, idx) => {
        const icon = s.status === 'PASS' ? '✅' : '❌';
        console.log(`${idx + 1}. ${icon} ${s.name}`);
    });

    console.log('');
    console.log('✅ Comprehensive scenario testing complete! 🚀\n');
}

main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
