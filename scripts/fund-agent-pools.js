/**
 * Fund Agent Pools with Initial Liquidity
 * Supplies liquidity to Bob, Carol, and Dave's pools
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n💰 FUNDING AGENT POOLS\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const [deployer] = await ethers.getSigners();

    // Load test agents
    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    // Funding configurations
    const fundingConfigs = [
        { name: 'Bob', amount: '15000' },
        { name: 'Carol', amount: '10000' },
        { name: 'Dave', amount: '5000' }
    ];

    for (const config of fundingConfigs) {
        console.log(`AGENT: ${config.name}`);

        try {
            const agent = testAgents.find(a => a.name === config.name);
            if (!agent) {
                console.log(`   ⏭️  Agent not found, skipping\n`);
                continue;
            }

            const agentId = agent.agentId;
            const amount = ethers.parseUnits(config.amount, 6);

            console.log(`   Supplying ${config.amount} USDC to pool...`);
            console.log(`   - Agent ID: ${agentId}`);

            await usdc.approve(addresses.agentLiquidityMarketplace, amount);
            const tx = await marketplace.supplyLiquidity(agentId, amount);
            await tx.wait();

            console.log(`   ✅ Liquidity supplied successfully!\n`);

            // Small delay to avoid rate limits
            await new Promise(resolve => setTimeout(resolve, 3000));

        } catch (error) {
            console.log(`   ❌ Failed: ${error.message}\n`);
        }
    }

    // Show final pool states
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 FINAL POOL STATES\n');

    for (const agent of testAgents) {
        const agentId = agent.agentId;
        const pool = await marketplace.agentPools(agentId);

        if (pool.isActive) {
            console.log(`${agent.name}:`);
            console.log(`  - Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
            console.log(`  - Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
            console.log('');
        }
    }

    console.log('✅ Pool funding complete! 🚀\n');
}

main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
