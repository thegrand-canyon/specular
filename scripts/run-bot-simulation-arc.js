/**
 * Run Bot Simulation on Arc Testnet
 * Launches multiple agent bots and lender bots
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');
const { AutonomousAgentBot } = require('../src/bots/AutonomousAgentBot');
const { LenderBot } = require('../src/bots/LenderBot');

async function main() {
    console.log('\n🤖 LAUNCHING BOT SIMULATION ON ARC\n');
    console.log('═══════════════════════════════════════════════════════\n');

    // Load Arc addresses
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    console.log('Arc Configuration:');
    console.log(`  AgentRegistryV2:            ${addresses.agentRegistryV2}`);
    console.log(`  ReputationManagerV3:        ${addresses.reputationManagerV3}`);
    console.log(`  AgentLiquidityMarketplace:  ${addresses.agentLiquidityMarketplace}`);
    console.log(`  MockUSDC:                   ${addresses.mockUSDC}\n`);

    const [deployer] = await ethers.getSigners();
    const provider = ethers.provider;

    // Load USDC contract
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    console.log(`Deployer: ${deployer.address}`);
    const deployerBalance = await usdc.balanceOf(deployer.address);
    console.log(`Deployer USDC: ${ethers.formatUnits(deployerBalance, 6)} USDC\n`);

    // ==========================================
    // CREATE AGENT BOTS
    // ==========================================
    console.log('🤖 Creating Agent Bots...\n');

    const agentBots = [];

    const agentConfigs = [
        { name: 'AgentBot-Alpha', loanAmount: 500, targetLoans: 3, poolLiquidity: 5000 },
        { name: 'AgentBot-Beta', loanAmount: 1000, targetLoans: 3, poolLiquidity: 10000 },
        { name: 'AgentBot-Gamma', loanAmount: 1000, targetLoans: 3, poolLiquidity: 15000 }
    ];

    for (const config of agentConfigs) {
        // Create wallet for bot
        const botWallet = ethers.Wallet.createRandom().connect(provider);

        console.log(`Setting up ${config.name}:`);
        console.log(`  Address: ${botWallet.address}`);

        // Fund with gas (Arc uses USDC)
        const gasAmount = ethers.parseEther('0.1');
        await deployer.sendTransaction({
            to: botWallet.address,
            value: gasAmount
        });
        console.log(`  ✅ Funded with ${ethers.formatEther(gasAmount)} USDC gas`);

        // Fund with USDC for collateral + pool
        const usdcAmount = ethers.parseUnits('20000', 6); // 20k USDC
        await usdc.mint(botWallet.address, usdcAmount);
        console.log(`  ✅ Minted 20,000 USDC`);

        // Create bot
        const bot = new AutonomousAgentBot({
            name: config.name,
            provider,
            wallet: botWallet,
            contracts: addresses,
            strategy: {
                loanAmount: config.loanAmount,
                loanDuration: 30,
                repaymentDelay: 0,
                targetLoans: config.targetLoans,
                poolLiquidity: config.poolLiquidity
            }
        });

        agentBots.push(bot);
        console.log(`  ✅ ${config.name} ready\n`);

        await sleep(3000);
    }

    // ==========================================
    // PRE-REGISTER AGENTS (collect IDs for lenders)
    // ==========================================
    console.log('📋 Pre-registering agents to collect IDs...\n');

    const agentRegistry = await ethers.getContractAt('AgentRegistryV2', addresses.agentRegistryV2);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);

    // Pre-register each bot to get their agent IDs before lenders start
    for (const bot of agentBots) {
        await bot.registerAgent();
        await bot.initializeReputation();
        await bot.createPool();
        console.log(`  Agent ID ${bot.state.agentId} pool seeded for ${bot.name}\n`);
        await sleep(2000);
    }

    const activeAgentIds = agentBots.map(b => b.state.agentId).filter(id => id != null);
    console.log(`Active agent IDs for this simulation: [${activeAgentIds.join(', ')}]\n`);

    // ==========================================
    // CREATE LENDER BOTS
    // ==========================================
    console.log('💰 Creating Lender Bots...\n');

    const lenderBots = [];

    const lenderConfigs = [
        { name: 'LenderBot-Omega', totalCapital: 30000, diversification: 3 },
        { name: 'LenderBot-Sigma', totalCapital: 40000, diversification: 4 }
    ];

    for (const config of lenderConfigs) {
        // Create wallet for bot
        const botWallet = ethers.Wallet.createRandom().connect(provider);

        console.log(`Setting up ${config.name}:`);
        console.log(`  Address: ${botWallet.address}`);

        // Fund with gas
        const gasAmount = ethers.parseEther('0.1');
        await deployer.sendTransaction({
            to: botWallet.address,
            value: gasAmount
        });
        console.log(`  ✅ Funded with ${ethers.formatEther(gasAmount)} USDC gas`);

        // Fund with USDC capital
        const usdcAmount = ethers.parseUnits(config.totalCapital.toString(), 6);
        await usdc.mint(botWallet.address, usdcAmount);
        console.log(`  ✅ Minted ${config.totalCapital.toLocaleString()} USDC`);

        // Create bot — pass the current simulation's agent IDs as preferred targets
        const bot = new LenderBot({
            name: config.name,
            provider,
            wallet: botWallet,
            contracts: addresses,
            strategy: {
                totalCapital: config.totalCapital,
                diversification: config.diversification,
                minAgentReputation: 100,
                rebalanceInterval: 30000, // 30 seconds
                preferredAgentIds: activeAgentIds,
                maxMonitorCycles: 3
            }
        });

        lenderBots.push(bot);
        console.log(`  ✅ ${config.name} ready (will target agents: [${activeAgentIds.join(', ')}])\n`);

        await sleep(3000);
    }

    // ==========================================
    // START SIMULATION
    // ==========================================
    console.log('═══════════════════════════════════════════════════════\n');
    console.log('🚀 STARTING SIMULATION\n');
    console.log(`Agent Bots: ${agentBots.length}`);
    console.log(`Lender Bots: ${lenderBots.length}\n`);

    // Start agent bots (pools already seeded, go straight to loan cycles)
    console.log('--- Phase 1: Agent Bots Loan Cycles ---\n');
    const agentPromises = agentBots.map((bot, i) => {
        return sleep(i * 3000).then(() => bot.runLoanCycle());
    });

    // Start lender bots immediately (pools are already created)
    console.log('--- Phase 2: Lender Bots Supply Liquidity ---\n');
    const lenderPromises = lenderBots.map((bot, i) => {
        return sleep(i * 5000).then(() => bot.start());
    });

    // Wait for all bots to complete
    console.log('--- Phase 3: Running Autonomous Operations ---\n');
    await Promise.all([...agentPromises, ...lenderPromises]);

    // ==========================================
    // FINAL REPORT
    // ==========================================
    console.log('\n═══════════════════════════════════════════════════════\n');
    console.log('📊 SIMULATION COMPLETE - FINAL REPORT\n');

    console.log('AGENT BOTS:\n');
    for (const bot of agentBots) {
        const state = bot.getState();
        console.log(`${state.name}:`);
        console.log(`  Agent ID: ${state.agentId}`);
        console.log(`  Reputation: ${state.reputation}`);
        console.log(`  Loans Completed: ${state.loansCompleted}`);
        console.log(`  Total Borrowed: ${state.totalBorrowed} USDC`);
        console.log(`  Total Repaid: ${state.totalRepaid.toFixed(2)} USDC`);
        console.log('');
    }

    console.log('LENDER BOTS:\n');
    for (const bot of lenderBots) {
        const state = bot.getState();
        console.log(`${state.name}:`);
        console.log(`  Total Supplied: ${state.totalSupplied.toLocaleString()} USDC`);
        console.log(`  Total Earned: ${state.totalEarned.toFixed(2)} USDC`);
        console.log(`  Active Positions: ${Object.keys(state.positions).length}`);
        console.log('');
    }

    // Save results
    const results = {
        timestamp: new Date().toISOString(),
        network: 'Arc Testnet',
        agents: agentBots.map(bot => bot.getState()),
        lenders: lenderBots.map(bot => bot.getState())
    };

    const resultsPath = path.join(__dirname, '..', 'bot-simulation-results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(results, null, 2));

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('✅ Simulation results saved to: bot-simulation-results.json\n');
    console.log('🎉 Bot simulation complete! 🚀\n');
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(error => {
    console.error('Simulation failed:', error);
    process.exit(1);
});
