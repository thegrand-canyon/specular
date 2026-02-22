/**
 * Fund remaining agent pools on Arc
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n💰 FUNDING REMAINING POOLS ON ARC\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const [deployer] = await ethers.getSigners();

    // Check balance
    const balance = await usdc.balanceOf(deployer.address);
    console.log(`Deployer USDC balance: ${ethers.formatUnits(balance, 6)} USDC\n`);

    // Load test agents
    const testAgentsPath = path.join(__dirname, '..', 'arc-test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    // Fund Alice and Carol
    const poolsToFund = [
        { name: 'Alice', agentId: 5, amount: '20000' },
        { name: 'Carol', agentId: 7, amount: '10000' }
    ];

    for (const pool of poolsToFund) {
        console.log(`AGENT: ${pool.name} (ID: ${pool.agentId})`);

        try {
            // Check current pool status
            const poolData = await marketplace.agentPools(pool.agentId);
            console.log(`   Current liquidity: ${ethers.formatUnits(poolData.totalLiquidity, 6)} USDC`);

            // Supply liquidity
            const liquidityAmount = ethers.parseUnits(pool.amount, 6);
            console.log(`   Supplying ${pool.amount} USDC...`);

            // Approve USDC
            const approveTx = await usdc.approve(addresses.agentLiquidityMarketplace, liquidityAmount);
            await approveTx.wait();
            console.log(`   ✅ USDC approved`);

            await new Promise(resolve => setTimeout(resolve, 3000));

            // Supply liquidity
            const supplyTx = await marketplace.supplyLiquidity(pool.agentId, liquidityAmount);
            await supplyTx.wait();
            console.log(`   ✅ Liquidity supplied`);

            // Check new balance
            const updatedPool = await marketplace.agentPools(pool.agentId);
            console.log(`   ✅ New liquidity: ${ethers.formatUnits(updatedPool.totalLiquidity, 6)} USDC\n`);

            await new Promise(resolve => setTimeout(resolve, 5000));

        } catch (error) {
            console.log(`   ❌ Failed: ${error.message}\n`);
        }
    }

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📊 FINAL POOL STATUS\n');

    for (const agent of testAgents) {
        try {
            const pool = await marketplace.agentPools(agent.agentId);
            if (pool.isActive) {
                console.log(`${agent.name} (ID ${agent.agentId}):`);
                console.log(`  - Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
                console.log(`  - Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC\n`);
            }
        } catch (error) {
            console.log(`${agent.name}: Error checking pool\n`);
        }
    }

    console.log('✅ Done! 🚀\n');
}

main().catch(console.error);
