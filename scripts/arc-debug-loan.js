/**
 * Debug loan request on Arc
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🔍 DEBUGGING LOAN REQUEST\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    // Load Alice
    const testAgentsPath = path.join(__dirname, '..', 'arc-test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));
    const alice = testAgents.find(a => a.name === 'Alice');

    console.log(`ALICE (ID ${alice.agentId})\n`);
    console.log(`Address: ${alice.address}\n`);

    // Check gas balance (native USDC on Arc)
    const gasBalance = await ethers.provider.getBalance(alice.address);
    console.log(`Gas Balance (native USDC): ${ethers.formatEther(gasBalance)} USDC`);

    // Check USDC token balance
    const usdcBalance = await usdc.balanceOf(alice.address);
    console.log(`USDC Token Balance: ${ethers.formatUnits(usdcBalance, 6)} USDC`);

    // Check reputation
    const reputation = await reputationManager['getReputationScore(address)'](alice.address);
    console.log(`Reputation: ${reputation}\n`);

    // Check pool
    const pool = await marketplace.agentPools(alice.agentId);
    console.log(`POOL STATUS:`);
    console.log(`  Active: ${pool.isActive}`);
    console.log(`  Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
    console.log(`  Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC\n`);

    // Check credit limit
    const creditLimit = await reputationManager.calculateCreditLimit(alice.address);
    console.log(`Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);

    // Check collateral requirement
    const collateralReq = await reputationManager.calculateCollateralRequirement(alice.address);
    console.log(`Collateral Requirement: ${collateralReq}%`);

    // Check interest rate
    const interestRate = await reputationManager.calculateInterestRate(alice.address);
    console.log(`Interest Rate: ${interestRate / 100}% APR\n`);

    // Check marketplace constants
    const minDuration = await marketplace.MIN_LOAN_DURATION();
    const maxDuration = await marketplace.MAX_LOAN_DURATION();
    console.log(`MARKETPLACE SETTINGS:`);
    console.log(`  Min Duration: ${minDuration / 86400n} days`);
    console.log(`  Max Duration: ${maxDuration / 86400n} days\n`);

    console.log('✅ Debug complete!\n');
}

main().catch(console.error);
