/**
 * Create Agent Pools in Liquidity Marketplace
 * Allow test agents to receive P2P liquidity
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🏊 Creating Agent Liquidity Pools\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);

    console.log('Marketplace:', addresses.agentLiquidityMarketplace);
    console.log('');

    // Create pools for each test agent
    for (const agent of testAgents) {
        console.log(`📋 Agent: ${agent.name}`);
        console.log(`   Address: ${agent.address}`);
        console.log(`   Agent ID: ${agent.agentId}`);

        const wallet = new ethers.Wallet(agent.privateKey, ethers.provider);

        try {
            // Check if pool already exists
            const pool = await marketplace.agentPools(agent.agentId);
            if (pool.isActive) {
                console.log(`   ⏭️  Pool already exists`);
                console.log('');
                continue;
            }

            // Create pool
            console.log('   Creating pool...');
            const tx = await marketplace.connect(wallet).createAgentPool();
            await tx.wait();
            console.log('   ✅ Pool created!');

            // Verify pool
            const poolData = await marketplace.getAgentPool(agent.agentId);
            console.log('   Pool Details:');
            console.log(`     Total Liquidity: ${ethers.formatUnits(poolData.totalLiquidity, 6)} USDC`);
            console.log(`     Available: ${ethers.formatUnits(poolData.availableLiquidity, 6)} USDC`);
            console.log(`     Lender Count: ${poolData.lenderCount}`);
        } catch (error) {
            console.log(`   ❌ Error: ${error.message}`);
        }

        console.log('');
    }

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('✅ Agent Pools Created!\n');
    console.log('🎯 Next: Supply liquidity to agents:');
    console.log('   npx hardhat run scripts/test-p2p-lending.js --network sepolia\n');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
