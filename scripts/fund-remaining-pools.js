const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n💰 FUNDING REMAINING POOLS\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    // Fund Carol
    console.log('Funding Carol...');
    const carol = testAgents.find(a => a.name === 'Carol');
    const carolAmount = ethers.parseUnits('5000', 6);

    await usdc.approve(addresses.agentLiquidityMarketplace, carolAmount);
    const carolTx = await marketplace.supplyLiquidity(carol.agentId, carolAmount);
    await carolTx.wait();
    console.log('✅ Carol funded with 5,000 USDC\n');

    // Wait 10 seconds before next transaction
    console.log('Waiting 10 seconds...\n');
    await new Promise(resolve => setTimeout(resolve, 10000));

    // Fund Dave
    console.log('Funding Dave...');
    const dave = testAgents.find(a => a.name === 'Dave');
    const daveAmount = ethers.parseUnits('2500', 6);

    await usdc.approve(addresses.agentLiquidityMarketplace, daveAmount);
    const daveTx = await marketplace.supplyLiquidity(dave.agentId, daveAmount);
    await daveTx.wait();
    console.log('✅ Dave funded with 2,500 USDC\n');

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 FINAL POOL STATES\n');

    for (const agent of testAgents) {
        const pool = await marketplace.agentPools(agent.agentId);
        console.log(`${agent.name}:`);
        console.log(`  - Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
        console.log('');
    }

    console.log('✅ All pools funded! 🚀\n');
}

main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
