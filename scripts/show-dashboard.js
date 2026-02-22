/**
 * Platform Dashboard
 * Shows complete state of all agents, pools, loans, and platform metrics
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n📊 SPECULAR PLATFORM DASHBOARD\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    const [deployer] = await ethers.getSigners();

    // Platform metrics
    const platformFeeRate = await marketplace.platformFeeRate();
    const accumulatedFees = await marketplace.accumulatedFees();
    const paused = await marketplace.paused();

    console.log('🏦 PLATFORM STATUS\n');
    console.log(`Network: Sepolia Testnet`);
    console.log(`Contract: ${addresses.agentLiquidityMarketplace}`);
    console.log(`Status: ${paused ? '⏸️  Paused' : '✅ Active'}`);
    console.log(`Platform Fee: ${Number(platformFeeRate) / 100}%`);
    console.log(`Accumulated Fees: ${ethers.formatUnits(accumulatedFees, 6)} USDC`);
    console.log(`Owner: ${deployer.address}\n`);

    // Calculate totals
    let totalLiquidity = 0n;
    let totalAvailable = 0n;
    let totalLoaned = 0n;

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('👥 AGENTS & POOLS\n');

    for (const agent of testAgents) {
        const pool = await marketplace.agentPools(agent.agentId);
        const rep = await reputationManager['getReputationScore(address)'](agent.address);
        const creditLimit = await reputationManager.calculateCreditLimit(agent.address);

        totalLiquidity += pool.totalLiquidity;
        totalAvailable += pool.availableLiquidity;
        totalLoaned += pool.totalLoaned;

        console.log(`${agent.name} (Agent ID: ${agent.agentId})`);
        console.log(`  Address: ${agent.address}`);
        console.log(`  Reputation: ${rep} | Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);
        console.log(`  Pool:`);
        console.log(`    • Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
        console.log(`    • Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
        console.log(`    • Loaned Out: ${ethers.formatUnits(pool.totalLoaned, 6)} USDC`);
        console.log(`    • Utilization: ${pool.totalLiquidity > 0 ? ((pool.totalLoaned * 10000n / pool.totalLiquidity) / 100n).toString() : '0'}%`);
        console.log('');
    }

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('💰 PLATFORM TOTALS\n');
    console.log(`Total Value Locked (TVL): ${ethers.formatUnits(totalLiquidity, 6)} USDC`);
    console.log(`Available Liquidity: ${ethers.formatUnits(totalAvailable, 6)} USDC`);
    console.log(`Total Loaned: ${ethers.formatUnits(totalLoaned, 6)} USDC`);
    console.log(`Platform Utilization: ${totalLiquidity > 0 ? ((totalLoaned * 10000n / totalLiquidity) / 100n).toString() : '0'}%\n`);

    // Try to fetch some recent loans
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('📝 RECENT LOANS\n');

    let foundLoans = 0;
    for (let loanId = 1; loanId <= 10; loanId++) {
        try {
            const loan = await marketplace.loans(loanId);
            if (loan.borrower !== ethers.ZeroAddress) {
                const agent = testAgents.find(a => a.address.toLowerCase() === loan.borrower.toLowerCase());
                const states = ['Requested', 'Rejected', 'Active', 'Repaid', 'Defaulted'];

                console.log(`Loan #${loanId}:`);
                console.log(`  Borrower: ${agent ? agent.name : loan.borrower}`);
                console.log(`  Amount: ${ethers.formatUnits(loan.amount, 6)} USDC`);
                console.log(`  Interest Rate: ${Number(loan.interestRate) / 100}% APR`);
                console.log(`  State: ${states[loan.state] || loan.state}`);
                console.log('');
                foundLoans++;
            }
        } catch (error) {
            // Loan doesn't exist, skip
            break;
        }
    }

    if (foundLoans === 0) {
        console.log('No loans found\n');
    }

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('💵 YOUR WALLET\n');
    const walletBalance = await usdc.balanceOf(deployer.address);
    const ethBalance = await ethers.provider.getBalance(deployer.address);
    console.log(`Address: ${deployer.address}`);
    console.log(`ETH: ${ethers.formatEther(ethBalance)} ETH`);
    console.log(`USDC: ${ethers.formatUnits(walletBalance, 6)} USDC\n`);

    console.log('═══════════════════════════════════════════════════════\n');
    console.log(`✅ Dashboard updated: ${new Date().toLocaleString()}\n`);
}

main().catch(console.error);
