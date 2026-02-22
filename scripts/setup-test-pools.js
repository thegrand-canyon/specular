/**
 * Setup Test Agent Pools
 * Creates pools for all 4 test agents and supplies initial liquidity
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🏊 SETTING UP TEST AGENT POOLS\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const [deployer] = await ethers.getSigners();

    // Load test agents
    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    console.log(`Found ${testAgents.length} test agents\n`);

    // Pool configurations for each agent
    const poolConfigs = [
        { name: 'Alice', rate: 1000, maxLoan: '50000', initialLiquidity: '20000' },  // 10% APR
        { name: 'Bob', rate: 800, maxLoan: '30000', initialLiquidity: '15000' },     // 8% APR
        { name: 'Carol', rate: 1200, maxLoan: '25000', initialLiquidity: '10000' },  // 12% APR
        { name: 'Dave', rate: 900, maxLoan: '20000', initialLiquidity: '5000' }      // 9% APR
    ];

    for (const config of poolConfigs) {
        console.log(`AGENT: ${config.name}`);

        try {
            const agent = testAgents.find(a => a.name === config.name);
            if (!agent) {
                console.log(`   ⏭️  Agent not found, skipping\n`);
                continue;
            }

            const agentId = agent.agentId;

            // Check if pool exists
            const existingPool = await marketplace.agentPools(agentId);

            if (existingPool.isActive) {
                console.log(`   ⏭️  Pool already exists`);
                console.log(`   - Agent ID: ${agentId}`);
                console.log(`   - Liquidity: ${ethers.formatUnits(existingPool.totalLiquidity, 6)} USDC\n`);
                continue;
            }

            // Create pool (agent must call it themselves)
            console.log(`   Creating pool (as ${config.name})...`);
            console.log(`   - Agent ID: ${agentId}`);

            const agentWallet = new ethers.Wallet(agent.privateKey, ethers.provider);
            const createTx = await marketplace.connect(agentWallet).createAgentPool();
            await createTx.wait();
            console.log(`   ✅ Pool created`);

            // Supply initial liquidity
            console.log(`   Supplying ${config.initialLiquidity} USDC liquidity...`);
            const liquidityAmount = ethers.parseUnits(config.initialLiquidity, 6);

            await usdc.approve(addresses.agentLiquidityMarketplace, liquidityAmount);
            const supplyTx = await marketplace.supplyLiquidity(agentId, liquidityAmount);
            await supplyTx.wait();

            console.log(`   ✅ Liquidity supplied`);
            console.log(`   ✅ ${config.name}'s pool is ready!\n`);

            // Small delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 3000));

        } catch (error) {
            console.log(`   ❌ Failed: ${error.message}\n`);
        }
    }

    // Final summary
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 POOL SETUP SUMMARY\n');

    for (const config of poolConfigs) {
        const agent = testAgents.find(a => a.name === config.name);
        if (agent) {
            try {
                const agentId = agent.agentId;
                const pool = await marketplace.agentPools(agentId);
                if (pool.interestRate > 0) {
                    console.log(`${config.name}:`);
                    console.log(`  ✅ Pool active`);
                    console.log(`  - Rate: ${pool.interestRate / 100}%`);
                    console.log(`  - Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
                    console.log(`  - Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
                    console.log('');
                }
            } catch (error) {
                console.log(`${config.name}: ❌ Error checking pool\n`);
            }
        }
    }

    console.log('✅ All test pools are ready! 🚀\n');
    console.log('🎯 NEXT: Run comprehensive scenarios to test everything!\n');
}

main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
