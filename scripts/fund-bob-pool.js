/**
 * Add more liquidity to Bob's pool
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n💰 FUNDING BOB\'S POOL\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    const bob = testAgents.find(a => a.name === 'Bob');

    // Check current pool
    const pool = await marketplace.agentPools(bob.agentId);
    console.log('Current Pool State:');
    console.log(`  - Total: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
    console.log(`  - Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC\n`);

    // Add 5,000 USDC
    const amount = ethers.parseUnits('5000', 6);
    console.log(`Adding ${ethers.formatUnits(amount, 6)} USDC to Bob's pool...\n`);

    await usdc.approve(addresses.agentLiquidityMarketplace, amount);
    const tx = await marketplace.supplyLiquidity(bob.agentId, amount);
    await tx.wait();

    console.log('✅ Liquidity added!\n');

    // Check new state
    const newPool = await marketplace.agentPools(bob.agentId);
    console.log('New Pool State:');
    console.log(`  - Total: ${ethers.formatUnits(newPool.totalLiquidity, 6)} USDC`);
    console.log(`  - Available: ${ethers.formatUnits(newPool.availableLiquidity, 6)} USDC\n`);

    console.log('✅ Done! 🚀\n');
}

main().catch(console.error);
