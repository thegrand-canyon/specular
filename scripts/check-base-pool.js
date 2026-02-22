/**
 * Check Base Sepolia Pool Status
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://sepolia.base.org';
const AGENT_ADDR = '0x656086A21073272533c8A3f56A94c1f3D8BCFcE2';

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    // Load addresses
    const addresses = JSON.parse(
        fs.readFileSync('./src/config/base-sepolia-addresses.json', 'utf8')
    );

    // Load ABIs
    const registryAbi = JSON.parse(
        fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json', 'utf8')
    ).abi;

    const marketplaceAbi = JSON.parse(
        fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json', 'utf8')
    ).abi;

    const registry = new ethers.Contract(addresses.AgentRegistryV2, registryAbi, provider);
    const marketplace = new ethers.Contract(addresses.AgentLiquidityMarketplace, marketplaceAbi, provider);

    const agentId = await registry.addressToAgentId(AGENT_ADDR);
    console.log(`\nAgent ID: ${agentId}\n`);

    if (agentId === 0n) {
        console.log('❌ Agent not registered\n');
        return;
    }

    try {
        const pool = await marketplace.getAgentPool(agentId);
        console.log('✅ Agent Pool exists!\n');
        console.log(`   Agent ID: ${pool.agentId}`);
        console.log(`   Owner: ${pool.owner}`);
        console.log(`   Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
        console.log(`   Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
        console.log(`   Active Loans: ${pool.activeLoans}`);
        console.log(`   Lender Count: ${pool.lenderCount}\n`);
    } catch (err) {
        console.log(`❌ Pool does not exist: ${err.message}\n`);
    }
}

main().catch(console.error);
