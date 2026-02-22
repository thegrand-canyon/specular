const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));
    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);

    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    console.log('\n📊 CURRENT POOL STATES\n');

    for (const agent of testAgents) {
        const agentId = agent.agentId;
        const pool = await marketplace.agentPools(agentId);

        console.log(`${agent.name}:`);
        console.log(`  - Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
        console.log(`  - Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
        console.log(`  - Loaned: ${ethers.formatUnits(pool.totalLoaned, 6)} USDC`);
        console.log('');
    }
}

main().catch(console.error);
