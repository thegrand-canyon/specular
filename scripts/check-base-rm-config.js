/**
 * Check ReputationManagerV3 Configuration
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://sepolia.base.org';
const AGENT_ADDR = '0x656086A21073272533c8A3f56A94c1f3D8BCFcE2';

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    const addresses = JSON.parse(
        fs.readFileSync('./src/config/base-sepolia-addresses.json', 'utf8')
    );

    const rmAbi = JSON.parse(
        fs.readFileSync('./artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json', 'utf8')
    ).abi;

    const registryAbi = JSON.parse(
        fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json', 'utf8')
    ).abi;

    const rm = new ethers.Contract(addresses.ReputationManagerV3, rmAbi, provider);
    const registry = new ethers.Contract(addresses.AgentRegistryV2, registryAbi, provider);

    console.log('\n📊 REPUTATION MANAGER CONFIGURATION\n');

    const agentId = await registry.addressToAgentId(AGENT_ADDR);
    console.log(`Agent ID: ${agentId}\n`);

    // Check validationRegistry
    const vr = await rm.validationRegistry();
    console.log(`ValidationRegistry: ${vr}`);
    console.log(`Is zero address? ${vr === ethers.ZeroAddress}\n`);

    // Check if marketplace is authorized
    const isAuth = await rm.authorizedPools(addresses.AgentLiquidityMarketplace);
    console.log(`Marketplace authorized? ${isAuth}\n`);

    // Try to calculate credit limit
    try {
        const limit = await rm.calculateCreditLimit(AGENT_ADDR);
        console.log(`✅ Credit limit: ${ethers.formatUnits(limit, 6)} USDC\n`);
    } catch (err) {
        console.log(`❌ Failed to calculate credit limit: ${err.message}\n`);
    }

    // Try to calculate collateral requirement
    try {
        const collateral = await rm.calculateCollateralRequirement(AGENT_ADDR);
        console.log(`✅ Collateral requirement: ${collateral}%\n`);
    } catch (err) {
        console.log(`❌ Failed to calculate collateral: ${err.message}\n`);
    }

    // Try to calculate interest rate
    try {
        const rate = await rm.calculateInterestRate(AGENT_ADDR);
        console.log(`✅ Interest rate: ${rate} (basis points)\n`);
    } catch (err) {
        console.log(`❌ Failed to calculate interest rate: ${err.message}\n`);
    }
}

main().catch(console.error);
