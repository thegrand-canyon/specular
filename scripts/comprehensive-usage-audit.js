/**
 * Comprehensive Usage Audit
 * Analyzes who is using Specular across all networks
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Network configurations
const NETWORKS = {
    arc: {
        name: 'Arc Testnet',
        rpc: process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
        config: require('../src/config/arc-testnet-addresses.json')
    },
    base: {
        name: 'Base Mainnet',
        rpc: 'https://mainnet.base.org',
        config: require('../src/config/base-addresses.json')
    },
    arbitrum: {
        name: 'Arbitrum One',
        rpc: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
        config: require('../src/config/arbitrum-addresses.json')
    }
};

// Load ABIs
function loadAbi(name) {
    const abiPath = path.join(__dirname, '../abis', `${name}.json`);
    const abiFile = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
    return Array.isArray(abiFile) ? abiFile : abiFile.abi || abiFile;
}

const registryAbi = loadAbi('AgentRegistryV2');
const reputationAbi = loadAbi('ReputationManagerV3');
const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');

class UsageAuditor {
    constructor(networkKey) {
        this.networkKey = networkKey;
        this.network = NETWORKS[networkKey];
        this.agents = [];
        this.pools = [];
        this.loans = [];
    }

    async initialize() {
        console.log(`\n🔍 Initializing ${this.network.name}...`);
        this.provider = new ethers.JsonRpcProvider(this.network.rpc, undefined, { batchMaxCount: 1 });
        this.registry = new ethers.Contract(this.network.config.agentRegistryV2, registryAbi, this.provider);
        this.reputation = new ethers.Contract(this.network.config.reputationManagerV3, reputationAbi, this.provider);
        this.marketplace = new ethers.Contract(this.network.config.agentLiquidityMarketplace, marketplaceAbi, this.provider);

        // Get USDC contract for balance checks
        const usdcAbi = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
        this.usdc = new ethers.Contract(this.network.config.usdc, usdcAbi, this.provider);
    }

    async auditAgents() {
        console.log(`📋 Auditing agents on ${this.network.name}...`);

        const totalAgents = await this.registry.totalAgents();
        const count = Number(totalAgents);

        console.log(`   Found ${count} total agents`);

        if (count === 0) {
            console.log(`   ⚠️  No agents registered on this network\n`);
            return;
        }

        // Fetch all agents
        for (let i = 1; i <= count; i++) {
            try {
                const agent = await this.registry.agents(i);
                const score = await this.reputation['getReputationScore(address)'](agent.agentWallet);
                const creditLimit = await this.reputation['calculateCreditLimit(address)'](agent.agentWallet);
                const interestRate = await this.reputation.calculateInterestRate(agent.agentWallet);

                this.agents.push({
                    agentId: i,
                    owner: agent.owner,
                    agentWallet: agent.agentWallet,
                    agentURI: agent.agentURI || 'N/A',
                    reputationScore: Number(score),
                    creditLimit: Number(ethers.formatUnits(creditLimit, 6)),
                    interestRate: Number(interestRate) / 100,
                    registrationTime: Number(agent.registrationTime),
                    isActive: agent.isActive
                });

                process.stdout.write(`   Processing agent ${i}/${count}\r`);
            } catch (e) {
                console.error(`   Error getting agent ${i}:`, e.message);
            }
        }

        console.log(`\n   ✅ Loaded ${this.agents.length} agents\n`);
    }

    async auditPools() {
        console.log(`💰 Auditing liquidity pools on ${this.network.name}...`);

        const totalPools = await this.marketplace.totalPools();
        const count = Number(totalPools);

        console.log(`   Found ${count} total pools`);

        if (count === 0) {
            console.log(`   ⚠️  No pools on this network\n`);
            return;
        }

        for (let i = 0; i < count; i++) {
            try {
                const agentId = await this.marketplace.agentPoolIds(i);
                const pool = await this.marketplace.agentPools(agentId);

                if (!pool.isActive) continue;

                // Find the agent info
                const agent = this.agents.find(a => a.agentId === Number(agentId));

                this.pools.push({
                    poolId: i + 1,
                    agentId: Number(agentId),
                    agentWallet: agent ? agent.agentWallet : 'Unknown',
                    owner: agent ? agent.owner : 'Unknown',
                    totalLiquidity: Number(ethers.formatUnits(pool.totalLiquidity, 6)),
                    availableLiquidity: Number(ethers.formatUnits(pool.availableLiquidity, 6)),
                    totalLoaned: Number(ethers.formatUnits(pool.totalLoaned, 6)),
                    totalEarned: Number(ethers.formatUnits(pool.totalEarned, 6)),
                    isActive: pool.isActive
                });

                process.stdout.write(`   Processing pool ${i + 1}/${count}\r`);
            } catch (e) {
                console.error(`   Error getting pool ${i}:`, e.message);
            }
        }

        console.log(`\n   ✅ Loaded ${this.pools.length} active pools\n`);
    }

    async auditLoans() {
        console.log(`📊 Auditing active loans on ${this.network.name}...`);

        try {
            // Get LoanRequested events
            const filter = this.marketplace.filters.LoanRequested();
            const events = await this.marketplace.queryFilter(filter, -100000); // Last ~100k blocks

            console.log(`   Found ${events.length} loan request events`);

            for (const event of events) {
                const loanId = event.args.loanId;

                try {
                    // Check if loan still exists and is active
                    const loan = await this.marketplace.loans(loanId);

                    if (loan.isActive) {
                        const borrower = this.agents.find(a => a.agentWallet.toLowerCase() === loan.borrower.toLowerCase());

                        this.loans.push({
                            loanId: Number(loanId),
                            borrower: loan.borrower,
                            borrowerAgentId: borrower ? borrower.agentId : 'Unknown',
                            agentPoolId: Number(loan.agentPoolId),
                            amount: Number(ethers.formatUnits(loan.amount, 6)),
                            interestRate: Number(loan.interestRate) / 100,
                            startTime: Number(loan.startTime),
                            duration: Number(loan.duration),
                            isActive: loan.isActive
                        });
                    }
                } catch (e) {
                    // Loan doesn't exist or was repaid
                }
            }

            console.log(`   ✅ Found ${this.loans.length} active loans\n`);
        } catch (e) {
            console.error(`   Error auditing loans:`, e.message);
        }
    }

    async auditBalances() {
        console.log(`💵 Checking USDC balances on ${this.network.name}...`);

        // Check marketplace balance (TVL)
        const marketplaceBal = await this.usdc.balanceOf(this.network.config.agentLiquidityMarketplace);
        this.tvl = Number(ethers.formatUnits(marketplaceBal, 6));

        console.log(`   Marketplace TVL: $${this.tvl.toFixed(2)}\n`);
    }

    generateReport() {
        const report = {
            network: this.networkKey,
            networkName: this.network.name,
            timestamp: new Date().toISOString(),
            summary: {
                totalAgents: this.agents.length,
                activeAgents: this.agents.filter(a => a.isActive).length,
                totalPools: this.pools.length,
                activeLoans: this.loans.length,
                tvl: this.tvl
            },
            agents: this.agents,
            pools: this.pools,
            loans: this.loans
        };

        return report;
    }

    printSummary() {
        console.log(`\n${'═'.repeat(60)}`);
        console.log(`${this.network.name.toUpperCase()} - USAGE SUMMARY`);
        console.log(`${'═'.repeat(60)}\n`);

        console.log(`📊 Agents: ${this.agents.length} total, ${this.agents.filter(a => a.isActive).length} active`);
        console.log(`💰 Pools: ${this.pools.length} active`);
        console.log(`📈 Loans: ${this.loans.length} active`);
        console.log(`💵 TVL: $${this.tvl.toFixed(2)}\n`);

        if (this.agents.length > 0) {
            console.log(`Top Agents by Reputation:`);
            const topAgents = [...this.agents]
                .sort((a, b) => b.reputationScore - a.reputationScore)
                .slice(0, 5);

            topAgents.forEach((agent, i) => {
                console.log(`   ${i + 1}. Agent #${agent.agentId} - Score: ${agent.reputationScore}, Credit: $${agent.creditLimit.toFixed(2)}`);
                console.log(`      Wallet: ${agent.agentWallet}`);
                console.log(`      Owner: ${agent.owner}`);
            });
        }

        if (this.pools.length > 0) {
            console.log(`\nTop Pools by Liquidity:`);
            const topPools = [...this.pools]
                .sort((a, b) => b.totalLiquidity - a.totalLiquidity)
                .slice(0, 5);

            topPools.forEach((pool, i) => {
                console.log(`   ${i + 1}. Pool #${pool.poolId} - Agent #${pool.agentId}`);
                console.log(`      Liquidity: $${pool.totalLiquidity.toFixed(2)}`);
                console.log(`      Loaned: $${pool.totalLoaned.toFixed(2)}`);
                console.log(`      Earned: $${pool.totalEarned.toFixed(2)}`);
            });
        }

        if (this.loans.length > 0) {
            console.log(`\nActive Loans:`);
            this.loans.forEach((loan, i) => {
                console.log(`   ${i + 1}. Loan #${loan.loanId} - $${loan.amount.toFixed(2)} @ ${loan.interestRate}%`);
                console.log(`      Borrower: ${loan.borrower}`);
                console.log(`      Pool: Agent #${loan.agentPoolId}`);
            });
        }

        console.log(`\n${'═'.repeat(60)}\n`);
    }

    async run() {
        await this.initialize();
        await this.auditAgents();
        await this.auditPools();
        await this.auditLoans();
        await this.auditBalances();
        this.printSummary();

        return this.generateReport();
    }
}

async function main() {
    console.log(`\n╔════════════════════════════════════════════════════════════╗`);
    console.log(`║      COMPREHENSIVE USAGE AUDIT - ALL NETWORKS              ║`);
    console.log(`╚════════════════════════════════════════════════════════════╝\n`);
    console.log(`Date: ${new Date().toISOString()}\n`);

    const reports = {};

    // Audit all networks
    for (const networkKey of ['arc', 'base', 'arbitrum']) {
        try {
            const auditor = new UsageAuditor(networkKey);
            reports[networkKey] = await auditor.run();
            await new Promise(resolve => setTimeout(resolve, 2000)); // Cool down
        } catch (error) {
            console.error(`\n❌ ${networkKey.toUpperCase()} audit failed:`, error.message);
            reports[networkKey] = { error: error.message };
        }
    }

    // Overall summary
    console.log(`\n╔════════════════════════════════════════════════════════════╗`);
    console.log(`║              OVERALL SUMMARY                               ║`);
    console.log(`╚════════════════════════════════════════════════════════════╝\n`);

    let totalAgents = 0;
    let totalPools = 0;
    let totalLoans = 0;
    let totalTVL = 0;

    for (const [network, report] of Object.entries(reports)) {
        if (!report.error) {
            totalAgents += report.summary.totalAgents;
            totalPools += report.summary.totalPools;
            totalLoans += report.summary.activeLoans;
            totalTVL += report.summary.tvl;

            console.log(`${NETWORKS[network].name}:`);
            console.log(`  Agents: ${report.summary.totalAgents}`);
            console.log(`  Pools: ${report.summary.totalPools}`);
            console.log(`  Loans: ${report.summary.activeLoans}`);
            console.log(`  TVL: $${report.summary.tvl.toFixed(2)}\n`);
        }
    }

    console.log(`${'─'.repeat(60)}`);
    console.log(`TOTAL ACROSS ALL NETWORKS:`);
    console.log(`  Agents: ${totalAgents}`);
    console.log(`  Pools: ${totalPools}`);
    console.log(`  Loans: ${totalLoans}`);
    console.log(`  TVL: $${totalTVL.toFixed(2)}`);
    console.log(`${'─'.repeat(60)}\n`);

    // Save detailed report
    const timestamp = Date.now();
    const reportPath = path.join(__dirname, `../usage-audit-${timestamp}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(reports, null, 2));
    console.log(`📄 Detailed report saved to: usage-audit-${timestamp}.json\n`);

    // Generate markdown report
    const mdReport = generateMarkdownReport(reports, { totalAgents, totalPools, totalLoans, totalTVL });
    const mdPath = path.join(__dirname, '../CURRENT_USAGE_AUDIT.md');
    fs.writeFileSync(mdPath, mdReport);
    console.log(`📄 Markdown report saved to: CURRENT_USAGE_AUDIT.md\n`);
}

function generateMarkdownReport(reports, totals) {
    let md = `# Specular Usage Audit\n\n`;
    md += `**Date:** ${new Date().toISOString()}\n`;
    md += `**Status:** ✅ Complete\n\n`;
    md += `---\n\n`;

    md += `## Executive Summary\n\n`;
    md += `| Metric | Total |\n`;
    md += `|--------|-------|\n`;
    md += `| **Total Agents** | ${totals.totalAgents} |\n`;
    md += `| **Active Pools** | ${totals.totalPools} |\n`;
    md += `| **Active Loans** | ${totals.totalLoans} |\n`;
    md += `| **Total TVL** | $${totals.totalTVL.toFixed(2)} |\n\n`;

    md += `---\n\n`;

    for (const [networkKey, report] of Object.entries(reports)) {
        if (report.error) {
            md += `## ${NETWORKS[networkKey].name}\n\n`;
            md += `❌ Error: ${report.error}\n\n`;
            continue;
        }

        md += `## ${report.networkName}\n\n`;
        md += `### Summary\n\n`;
        md += `- **Total Agents:** ${report.summary.totalAgents}\n`;
        md += `- **Active Agents:** ${report.summary.activeAgents}\n`;
        md += `- **Active Pools:** ${report.summary.totalPools}\n`;
        md += `- **Active Loans:** ${report.summary.activeLoans}\n`;
        md += `- **TVL:** $${report.summary.tvl.toFixed(2)}\n\n`;

        if (report.agents.length > 0) {
            md += `### Registered Agents\n\n`;
            md += `| ID | Wallet | Owner | Score | Credit Limit | Status |\n`;
            md += `|----|--------|-------|-------|--------------|--------|\n`;

            report.agents.forEach(agent => {
                md += `| ${agent.agentId} | \`${agent.agentWallet.slice(0, 10)}...\` | \`${agent.owner.slice(0, 10)}...\` | ${agent.reputationScore} | $${agent.creditLimit.toFixed(2)} | ${agent.isActive ? '✅' : '❌'} |\n`;
            });

            md += `\n`;
        }

        if (report.pools.length > 0) {
            md += `### Active Pools\n\n`;
            md += `| Pool ID | Agent ID | Liquidity | Available | Loaned | Earned |\n`;
            md += `|---------|----------|-----------|-----------|--------|--------|\n`;

            report.pools.forEach(pool => {
                md += `| ${pool.poolId} | ${pool.agentId} | $${pool.totalLiquidity.toFixed(2)} | $${pool.availableLiquidity.toFixed(2)} | $${pool.totalLoaned.toFixed(2)} | $${pool.totalEarned.toFixed(2)} |\n`;
            });

            md += `\n`;
        }

        if (report.loans.length > 0) {
            md += `### Active Loans\n\n`;
            md += `| Loan ID | Borrower | Amount | Rate | Pool |\n`;
            md += `|---------|----------|--------|------|------|\n`;

            report.loans.forEach(loan => {
                md += `| ${loan.loanId} | \`${loan.borrower.slice(0, 10)}...\` | $${loan.amount.toFixed(2)} | ${loan.interestRate}% | Agent #${loan.agentPoolId} |\n`;
            });

            md += `\n`;
        }

        md += `---\n\n`;
    }

    md += `## Unique Users\n\n`;

    const uniqueOwners = new Set();
    const uniqueWallets = new Set();

    for (const report of Object.values(reports)) {
        if (!report.error && report.agents) {
            report.agents.forEach(agent => {
                uniqueOwners.add(agent.owner);
                uniqueWallets.add(agent.agentWallet);
            });
        }
    }

    md += `- **Unique Owner Addresses:** ${uniqueOwners.size}\n`;
    md += `- **Unique Agent Wallets:** ${uniqueWallets.size}\n\n`;

    md += `### All Unique Owners\n\n`;
    Array.from(uniqueOwners).forEach(owner => {
        md += `- \`${owner}\`\n`;
    });

    md += `\n---\n\n`;
    md += `**Report generated:** ${new Date().toISOString()}\n`;

    return md;
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
