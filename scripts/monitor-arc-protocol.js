/**
 * Real-Time Protocol Monitor for Arc
 * Tracks all loans, agents, reputation changes, and protocol stats
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

class ProtocolMonitor {
    constructor(provider, contracts) {
        this.provider = provider;
        this.contracts = contracts;
        this.stats = {
            totalAgents: 0,
            totalPools: 0,
            totalLoans: 0,
            activeLoans: 0,
            totalLiquidity: 0,
            totalBorrowed: 0,
            totalRepaid: 0,
            platformFees: 0
        };
        this.agents = new Map();
        this.loans = new Map();
    }

    async start() {
        console.log('\n📊 PROTOCOL MONITOR - ARC TESTNET\n');
        console.log('═══════════════════════════════════════════════════════\n');

        // Load contracts
        await this.loadContracts();

        // Initial snapshot
        await this.updateStats();

        // Start event listeners
        this.setupEventListeners();

        // Periodic updates
        setInterval(() => this.updateStats(), 30000); // Every 30 seconds

        console.log('✅ Monitor started. Press Ctrl+C to stop.\n');
    }

    async loadContracts() {
        this.agentRegistry = await ethers.getContractAt('AgentRegistryV2', this.contracts.agentRegistryV2);
        this.reputationManager = await ethers.getContractAt('ReputationManagerV3', this.contracts.reputationManagerV3);
        this.marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', this.contracts.agentLiquidityMarketplace);
        this.usdc = await ethers.getContractAt('MockUSDC', this.contracts.mockUSDC);
    }

    async updateStats() {
        console.clear();
        console.log('\n📊 SPECULAR PROTOCOL - LIVE DASHBOARD\n');
        console.log('═══════════════════════════════════════════════════════\n');
        console.log(`⏰ ${new Date().toLocaleString()}\n`);

        try {
            // Get total agents
            this.stats.totalAgents = Number(await this.agentRegistry.totalAgents());

            // Get marketplace stats
            const nextLoanId = Number(await this.marketplace.nextLoanId());
            this.stats.totalLoans = nextLoanId - 1;

            // Platform fees
            this.stats.platformFees = Number(ethers.formatUnits(await this.marketplace.accumulatedFees(), 6));

            // Scan all agents and pools
            let totalLiquidity = 0;
            let totalLoaned = 0;
            let activePools = 0;

            for (let agentId = 1; agentId <= this.stats.totalAgents; agentId++) {
                try {
                    const pool = await this.marketplace.agentPools(agentId);
                    if (pool[6]) { // isActive
                        activePools++;
                        totalLiquidity += Number(ethers.formatUnits(pool[2], 6)); // totalLiquidity
                        totalLoaned += Number(ethers.formatUnits(pool[4], 6)); // totalLoaned

                        // Get reputation
                        const reputation = Number(await this.reputationManager['getReputationScore(uint256)'](agentId));

                        this.agents.set(agentId, {
                            reputation,
                            totalLiquidity: Number(ethers.formatUnits(pool[2], 6)),
                            availableLiquidity: Number(ethers.formatUnits(pool[3], 6)),
                            totalLoaned: Number(ethers.formatUnits(pool[4], 6)),
                            totalEarned: Number(ethers.formatUnits(pool[5], 6))
                        });
                    }
                } catch (error) {
                    // Skip
                }
            }

            this.stats.totalPools = activePools;
            this.stats.totalLiquidity = totalLiquidity;
            this.stats.totalBorrowed = totalLoaned;

            // Count active loans
            let activeLoans = 0;
            for (let loanId = 1; loanId <= this.stats.totalLoans; loanId++) {
                try {
                    const loan = await this.marketplace.loans(loanId);
                    if (loan[9] === 1) { // ACTIVE state
                        activeLoans++;
                    }
                } catch (error) {
                    // Skip
                }
            }
            this.stats.activeLoans = activeLoans;

            // Display
            this.displayDashboard();

        } catch (error) {
            console.error('Error updating stats:', error.message);
        }
    }

    displayDashboard() {
        // Protocol Overview
        console.log('📈 PROTOCOL OVERVIEW\n');
        console.log(`  Total Agents:          ${this.stats.totalAgents}`);
        console.log(`  Active Pools:          ${this.stats.totalPools}`);
        console.log(`  Total Liquidity:       ${this.stats.totalLiquidity.toFixed(2)} USDC`);
        console.log(`  Currently Borrowed:    ${this.stats.totalBorrowed.toFixed(2)} USDC`);
        console.log(`  Utilization Rate:      ${this.stats.totalLiquidity > 0 ? ((this.stats.totalBorrowed / this.stats.totalLiquidity) * 100).toFixed(1) : 0}%`);
        console.log(`  Platform Fees:         ${this.stats.platformFees.toFixed(6)} USDC\n`);

        // Loan Stats
        console.log('💰 LOAN ACTIVITY\n');
        console.log(`  Total Loans:           ${this.stats.totalLoans}`);
        console.log(`  Active Loans:          ${this.stats.activeLoans}`);
        console.log(`  Completed Loans:       ${this.stats.totalLoans - this.stats.activeLoans}\n`);

        // Top Agents
        console.log('🏆 TOP AGENTS BY REPUTATION\n');
        const sortedAgents = Array.from(this.agents.entries())
            .sort((a, b) => b[1].reputation - a[1].reputation)
            .slice(0, 5);

        for (const [agentId, data] of sortedAgents) {
            console.log(`  Agent ${agentId}:`);
            console.log(`    Reputation:    ${data.reputation}`);
            console.log(`    Pool Size:     ${data.totalLiquidity.toFixed(0)} USDC`);
            console.log(`    Available:     ${data.availableLiquidity.toFixed(0)} USDC`);
            console.log(`    Borrowed:      ${data.totalLoaned.toFixed(0)} USDC`);
            console.log(`    Interest Paid: ${data.totalEarned.toFixed(2)} USDC`);
            console.log('');
        }

        // Network Info
        console.log('🌐 NETWORK INFO\n');
        console.log(`  Chain:         Arc Testnet`);
        console.log(`  Chain ID:      5042002`);
        console.log(`  Marketplace:   ${this.contracts.agentLiquidityMarketplace}\n`);

        console.log('═══════════════════════════════════════════════════════\n');
        console.log('🔄 Auto-refresh in 30s... (Ctrl+C to stop)\n');
    }

    setupEventListeners() {
        // Listen for new agents
        this.agentRegistry.on('AgentRegistered', (agentId, owner, agentURI, timestamp) => {
            console.log(`\n🆕 NEW AGENT REGISTERED!`);
            console.log(`   Agent ID: ${agentId.toString()}`);
            console.log(`   Owner: ${owner}`);
            console.log('');
        });

        // Listen for loan requests
        this.marketplace.on('LoanRequested', (loanId, agentId, borrower, amount) => {
            console.log(`\n💰 LOAN REQUESTED!`);
            console.log(`   Loan ID: ${loanId.toString()}`);
            console.log(`   Agent ID: ${agentId.toString()}`);
            console.log(`   Amount: ${ethers.formatUnits(amount, 6)} USDC`);
            console.log('');
        });

        // Listen for loan repayments
        this.marketplace.on('LoanRepaid', (loanId, principal, interest) => {
            console.log(`\n✅ LOAN REPAID!`);
            console.log(`   Loan ID: ${loanId.toString()}`);
            console.log(`   Principal: ${ethers.formatUnits(principal, 6)} USDC`);
            console.log(`   Interest: ${ethers.formatUnits(interest, 6)} USDC`);
            console.log('');
        });

        // Listen for liquidity supply
        this.marketplace.on('LiquiditySupplied', (agentId, lender, amount) => {
            console.log(`\n💸 LIQUIDITY SUPPLIED!`);
            console.log(`   Agent ID: ${agentId.toString()}`);
            console.log(`   Lender: ${lender}`);
            console.log(`   Amount: ${ethers.formatUnits(amount, 6)} USDC`);
            console.log('');
        });

        // Listen for reputation updates
        this.reputationManager.on('ReputationUpdated', (agentId, oldScore, newScore, reason) => {
            console.log(`\n⭐ REPUTATION UPDATED!`);
            console.log(`   Agent ID: ${agentId.toString()}`);
            console.log(`   ${oldScore.toString()} → ${newScore.toString()} (+${newScore - oldScore})`);
            console.log(`   Reason: ${reason}`);
            console.log('');
        });
    }
}

async function main() {
    // Load Arc addresses
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const monitor = new ProtocolMonitor(ethers.provider, addresses);
    await monitor.start();

    // Keep running
    await new Promise(() => {});
}

main().catch(error => {
    console.error('Monitor error:', error);
    process.exit(1);
});
