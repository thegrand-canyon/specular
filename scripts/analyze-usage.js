/**
 * Specular Protocol Usage Analysis
 *
 * Analyzes who is using Specular on both Base Mainnet and Arc Testnet
 * - Agent statistics
 * - Pool analytics
 * - Borrower activity
 * - Transaction volumes
 */

const { ethers } = require('ethers');
const fs = require('fs');

// Network configurations
const NETWORKS = {
    base: {
        name: 'Base Mainnet',
        rpc: 'https://mainnet.base.org',
        chainId: 8453,
        contracts: {
            registry: '0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb',
            marketplace: '0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE',
            reputation: '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF',
            usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
        }
    },
    arc: {
        name: 'Arc Testnet',
        rpc: process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
        chainId: 5042002,
        contracts: {
            registry: '0x741C03c0d95d2c15E479CE1c7E69B3196d86faD7',
            marketplace: '0x048363A325A5B188b7FF157d725C5e329f0171D3',
            reputation: '0x94F2fa47c4488202a46dAA9038Ed9C9c4c07467F',
            usdc: '0xf2807051e292e945751A25616705a9aadfb39895'
        }
    }
};

// ABIs
const REGISTRY_ABI = [
    'function totalAgents() view returns (uint256)',
    'function addressToAgentId(address) view returns (uint256)',
    'function getAgent(uint256) view returns (address agentAddress, uint256 registeredAt, string metadata)'
];

const MARKETPLACE_ABI = [
    'function nextPoolId() view returns (uint256)',
    'function pools(uint256) view returns (uint256 poolId, address agent, uint256 totalSupplied, uint256 totalBorrowed, uint256 availableLiquidity, bool isActive)',
    'function nextLoanId() view returns (uint256)',
    'function loans(uint256) view returns (uint256 poolId, address borrower, uint256 principal, uint256 interestRate, uint256 dueDate, uint8 status, uint256 collateralAmount)'
];

const REPUTATION_ABI = [
    'function getAgentScore(address) view returns (uint256)'
];

class UsageAnalyzer {
    constructor(network) {
        this.network = network;
        this.config = NETWORKS[network];
        this.provider = new ethers.JsonRpcProvider(this.config.rpc, this.config.chainId, { batchMaxCount: 1 });

        this.registry = new ethers.Contract(this.config.contracts.registry, REGISTRY_ABI, this.provider);
        this.marketplace = new ethers.Contract(this.config.contracts.marketplace, MARKETPLACE_ABI, this.provider);
        this.reputation = new ethers.Contract(this.config.contracts.reputation, REPUTATION_ABI, this.provider);
    }

    async analyze() {
        console.log(`\n${'='.repeat(70)}`);
        console.log(`  SPECULAR USAGE ANALYSIS - ${this.config.name.toUpperCase()}`);
        console.log('='.repeat(70));

        const results = {
            network: this.network,
            networkName: this.config.name,
            timestamp: new Date().toISOString(),
            agents: {},
            pools: {},
            loans: {},
            users: {},
            summary: {}
        };

        try {
            // 1. Agent Analysis
            console.log('\n[1/4] Analyzing Agents...');
            results.agents = await this.analyzeAgents();

            // 2. Pool Analysis
            console.log('[2/4] Analyzing Pools...');
            results.pools = await this.analyzePools();

            // 3. Loan Analysis
            console.log('[3/4] Analyzing Loans...');
            results.loans = await this.analyzeLoans();

            // 4. User Activity
            console.log('[4/4] Analyzing User Activity...');
            results.users = await this.analyzeUsers(results.loans.allLoans);

            // 5. Generate Summary
            results.summary = this.generateSummary(results);

            // Print Results
            this.printResults(results);

            return results;

        } catch (error) {
            console.error(`\n❌ Error analyzing ${this.config.name}:`, error.message);
            return null;
        }
    }

    async analyzeAgents() {
        const totalAgents = await this.registry.totalAgents();
        console.log(`      Total Agents Registered: ${totalAgents}`);

        const agents = [];
        const agentAddresses = new Set();

        for (let i = 1; i <= totalAgents; i++) {
            try {
                const agent = await this.registry.getAgent(i);
                const score = await this.reputation.getAgentScore(agent.agentAddress);

                agents.push({
                    id: i,
                    address: agent.agentAddress,
                    registeredAt: Number(agent.registeredAt),
                    registeredDate: new Date(Number(agent.registeredAt) * 1000).toISOString().split('T')[0],
                    score: Number(score),
                    metadata: agent.metadata
                });

                agentAddresses.add(agent.agentAddress);
            } catch (error) {
                // Skip if agent doesn't exist
            }
        }

        // Sort by registration date
        agents.sort((a, b) => b.registeredAt - a.registeredAt);

        return {
            total: Number(totalAgents),
            active: agents.length,
            uniqueAddresses: agentAddresses.size,
            list: agents,
            byScore: {
                excellent: agents.filter(a => a.score >= 800).length,
                good: agents.filter(a => a.score >= 600 && a.score < 800).length,
                fair: agents.filter(a => a.score >= 400 && a.score < 600).length,
                poor: agents.filter(a => a.score < 400).length
            }
        };
    }

    async analyzePools() {
        const nextPoolId = await this.marketplace.nextPoolId();
        const totalPools = Number(nextPoolId) - 1;
        console.log(`      Total Pools: ${totalPools}`);

        const pools = [];
        let totalSupplied = 0n;
        let totalBorrowed = 0n;
        let activePools = 0;

        for (let i = 1; i <= totalPools; i++) {
            try {
                const pool = await this.marketplace.pools(i);

                const poolData = {
                    id: i,
                    agentId: Number(pool.poolId),
                    agentAddress: pool.agent,
                    totalSupplied: Number(ethers.formatUnits(pool.totalSupplied, 6)),
                    totalBorrowed: Number(ethers.formatUnits(pool.totalBorrowed, 6)),
                    availableLiquidity: Number(ethers.formatUnits(pool.availableLiquidity, 6)),
                    utilization: pool.totalSupplied > 0n
                        ? Number(pool.totalBorrowed * 10000n / pool.totalSupplied) / 100
                        : 0,
                    isActive: pool.isActive
                };

                pools.push(poolData);

                totalSupplied += pool.totalSupplied;
                totalBorrowed += pool.totalBorrowed;
                if (pool.isActive) activePools++;

            } catch (error) {
                // Skip if pool doesn't exist
            }
        }

        // Sort by TVL (totalSupplied)
        pools.sort((a, b) => b.totalSupplied - a.totalSupplied);

        return {
            total: totalPools,
            active: activePools,
            list: pools,
            totalSupplied: Number(ethers.formatUnits(totalSupplied, 6)),
            totalBorrowed: Number(ethers.formatUnits(totalBorrowed, 6)),
            totalAvailable: Number(ethers.formatUnits(totalSupplied - totalBorrowed, 6)),
            avgUtilization: totalSupplied > 0n
                ? Number(totalBorrowed * 10000n / totalSupplied) / 100
                : 0
        };
    }

    async analyzeLoans() {
        const nextLoanId = await this.marketplace.nextLoanId();
        const totalLoans = Number(nextLoanId) - 1;
        console.log(`      Total Loans: ${totalLoans}`);

        const loans = [];
        const borrowers = new Set();
        let totalPrincipal = 0;
        let activeLoans = 0;
        let repaidLoans = 0;
        let defaultedLoans = 0;

        // Loan status enum: 0=Active, 1=Repaid, 2=Defaulted, 3=Liquidated
        const statusNames = ['Active', 'Repaid', 'Defaulted', 'Liquidated'];

        for (let i = 1; i <= totalLoans; i++) {
            try {
                const loan = await this.marketplace.loans(i);

                const loanData = {
                    id: i,
                    poolId: Number(loan.poolId),
                    borrower: loan.borrower,
                    principal: Number(ethers.formatUnits(loan.principal, 6)),
                    interestRate: Number(loan.interestRate),
                    dueDate: Number(loan.dueDate),
                    dueDateFormatted: new Date(Number(loan.dueDate) * 1000).toISOString().split('T')[0],
                    status: Number(loan.status),
                    statusName: statusNames[Number(loan.status)],
                    collateralAmount: Number(ethers.formatUnits(loan.collateralAmount, 6))
                };

                loans.push(loanData);
                borrowers.add(loan.borrower);
                totalPrincipal += loanData.principal;

                if (loanData.status === 0) activeLoans++;
                else if (loanData.status === 1) repaidLoans++;
                else if (loanData.status === 2 || loanData.status === 3) defaultedLoans++;

            } catch (error) {
                // Skip if loan doesn't exist
            }
        }

        // Sort by loan ID (most recent first)
        loans.sort((a, b) => b.id - a.id);

        return {
            total: totalLoans,
            active: activeLoans,
            repaid: repaidLoans,
            defaulted: defaultedLoans,
            uniqueBorrowers: borrowers.size,
            totalPrincipal,
            avgLoanSize: totalLoans > 0 ? totalPrincipal / totalLoans : 0,
            allLoans: loans
        };
    }

    async analyzeUsers(loans) {
        const userActivity = new Map();

        // Aggregate loan data by borrower
        for (const loan of loans) {
            if (!userActivity.has(loan.borrower)) {
                userActivity.set(loan.borrower, {
                    address: loan.borrower,
                    totalLoans: 0,
                    activeLoans: 0,
                    repaidLoans: 0,
                    defaultedLoans: 0,
                    totalBorrowed: 0,
                    avgLoanSize: 0
                });
            }

            const user = userActivity.get(loan.borrower);
            user.totalLoans++;
            user.totalBorrowed += loan.principal;

            if (loan.status === 0) user.activeLoans++;
            else if (loan.status === 1) user.repaidLoans++;
            else if (loan.status === 2 || loan.status === 3) user.defaultedLoans++;
        }

        // Calculate averages and convert to array
        const users = Array.from(userActivity.values()).map(user => ({
            ...user,
            avgLoanSize: user.totalLoans > 0 ? user.totalBorrowed / user.totalLoans : 0,
            repaymentRate: user.totalLoans > 0 ? (user.repaidLoans / user.totalLoans * 100) : 0
        }));

        // Sort by total borrowed
        users.sort((a, b) => b.totalBorrowed - a.totalBorrowed);

        return {
            total: users.length,
            list: users,
            topBorrowers: users.slice(0, 5)
        };
    }

    generateSummary(results) {
        const defaultRate = results.loans.total > 0
            ? (results.loans.defaulted / results.loans.total * 100)
            : 0;

        const tvl = results.pools.totalSupplied;
        const utilization = results.pools.avgUtilization;

        return {
            tvl,
            totalBorrowed: results.pools.totalBorrowed,
            utilization,
            totalAgents: results.agents.total,
            totalPools: results.pools.total,
            activePools: results.pools.active,
            totalLoans: results.loans.total,
            activeLoans: results.loans.active,
            uniqueBorrowers: results.loans.uniqueBorrowers,
            defaultRate,
            avgLoanSize: results.loans.avgLoanSize,
            health: this.calculateHealth(tvl, defaultRate, utilization)
        };
    }

    calculateHealth(tvl, defaultRate, utilization) {
        let score = 0;

        // TVL score (0-40 points)
        if (tvl > 100000) score += 40;
        else if (tvl > 50000) score += 30;
        else if (tvl > 10000) score += 20;
        else if (tvl > 1000) score += 10;

        // Default rate score (0-30 points)
        if (defaultRate < 2) score += 30;
        else if (defaultRate < 5) score += 20;
        else if (defaultRate < 10) score += 10;

        // Utilization score (0-30 points)
        if (utilization >= 40 && utilization <= 80) score += 30;
        else if (utilization >= 20 && utilization <= 90) score += 20;
        else if (utilization > 0) score += 10;

        if (score >= 80) return 'Excellent';
        if (score >= 60) return 'Good';
        if (score >= 40) return 'Fair';
        if (score >= 20) return 'Poor';
        return 'Very Low Activity';
    }

    printResults(results) {
        const s = results.summary;

        console.log('\n' + '='.repeat(70));
        console.log('  SUMMARY');
        console.log('='.repeat(70));
        console.log(`  Network:          ${results.networkName}`);
        console.log(`  Health:           ${s.health}`);
        console.log(`  TVL:              $${s.tvl.toLocaleString()} USDC`);
        console.log(`  Total Borrowed:   $${s.totalBorrowed.toLocaleString()} USDC`);
        console.log(`  Utilization:      ${s.utilization.toFixed(2)}%`);
        console.log(`  Default Rate:     ${s.defaultRate.toFixed(2)}%`);
        console.log('');
        console.log(`  Total Agents:     ${s.totalAgents}`);
        console.log(`  Total Pools:      ${s.totalPools} (${s.activePools} active)`);
        console.log(`  Total Loans:      ${s.totalLoans} (${s.activeLoans} active)`);
        console.log(`  Unique Borrowers: ${s.uniqueBorrowers}`);
        console.log(`  Avg Loan Size:    $${s.avgLoanSize.toFixed(2)} USDC`);

        // Top Agents
        if (results.agents.list.length > 0) {
            console.log('\n' + '-'.repeat(70));
            console.log('  TOP 5 AGENTS BY REPUTATION SCORE');
            console.log('-'.repeat(70));

            const topAgents = [...results.agents.list].sort((a, b) => b.score - a.score).slice(0, 5);
            topAgents.forEach((agent, i) => {
                console.log(`  ${i + 1}. ${agent.address.slice(0, 10)}... (Score: ${agent.score})`);
                console.log(`     Registered: ${agent.registeredDate}`);
            });
        }

        // Top Pools
        if (results.pools.list.length > 0) {
            console.log('\n' + '-'.repeat(70));
            console.log('  TOP 5 POOLS BY TVL');
            console.log('-'.repeat(70));

            results.pools.list.slice(0, 5).forEach((pool, i) => {
                console.log(`  ${i + 1}. Pool #${pool.id} - Agent ${pool.agentAddress.slice(0, 10)}...`);
                console.log(`     TVL: $${pool.totalSupplied.toLocaleString()} | Borrowed: $${pool.totalBorrowed.toLocaleString()} | Util: ${pool.utilization.toFixed(2)}%`);
            });
        }

        // Top Borrowers
        if (results.users.topBorrowers.length > 0) {
            console.log('\n' + '-'.repeat(70));
            console.log('  TOP 5 BORROWERS BY VOLUME');
            console.log('-'.repeat(70));

            results.users.topBorrowers.forEach((user, i) => {
                console.log(`  ${i + 1}. ${user.address.slice(0, 10)}...`);
                console.log(`     Borrowed: $${user.totalBorrowed.toLocaleString()} | Loans: ${user.totalLoans} | Repayment Rate: ${user.repaymentRate.toFixed(0)}%`);
            });
        }

        console.log('\n' + '='.repeat(70) + '\n');
    }
}

// Main execution
async function main() {
    const network = process.env.NETWORK || 'arc';

    console.log('\n╔════════════════════════════════════════════════════════════════════╗');
    console.log('║           SPECULAR PROTOCOL - USAGE ANALYSIS                       ║');
    console.log('╚════════════════════════════════════════════════════════════════════╝');

    const analyzer = new UsageAnalyzer(network);
    const results = await analyzer.analyze();

    if (results) {
        // Save to file
        const filename = `usage-report-${network}-${Date.now()}.json`;
        fs.writeFileSync(filename, JSON.stringify(results, null, 2));
        console.log(`\n📄 Full report saved to: ${filename}\n`);
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error('\n❌ Fatal error:', error.message);
        process.exit(1);
    });
}

module.exports = { UsageAnalyzer };
