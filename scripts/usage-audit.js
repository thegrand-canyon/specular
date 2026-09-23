/**
 * Specular Protocol Usage Audit
 * Analyzes who is using the protocol across all networks
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Load ABIs
function loadAbi(name) {
    const abiPath = path.join(__dirname, '../abis', `${name}.json`);
    const abiFile = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
    return Array.isArray(abiFile) ? abiFile : abiFile.abi || abiFile;
}

const registryAbi = loadAbi('AgentRegistryV2');
const reputationAbi = loadAbi('ReputationManagerV3');
const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');

// Network configurations
const NETWORKS = {
    arc: {
        name: 'Arc Testnet',
        rpc: process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
        addresses: require('../src/config/arc-testnet-addresses.json')
    },
    base: {
        name: 'Base Mainnet',
        rpc: 'https://mainnet.base.org',
        addresses: require('../src/config/base-addresses.json')
    },
    arbitrum: {
        name: 'Arbitrum One',
        rpc: 'https://arb1.arbitrum.io/rpc',
        addresses: require('../src/config/arbitrum-addresses.json')
    }
};

class UsageAuditor {
    constructor(networkKey) {
        this.network = NETWORKS[networkKey];
        this.networkKey = networkKey;
        this.usage = {
            network: this.network.name,
            timestamp: new Date().toISOString(),
            agents: [],
            pools: [],
            loans: [],
            uniqueUsers: new Set(),
            stats: {
                totalAgents: 0,
                activePools: 0,
                totalLoans: 0,
                activeLoans: 0,
                totalBorrowed: 0n,
                totalRepaid: 0n,
                uniqueAddresses: 0
            }
        };
    }

    async initialize() {
        this.provider = new ethers.JsonRpcProvider(this.network.rpc, undefined, { batchMaxCount: 1 });

        this.contracts = {
            registry: new ethers.Contract(this.network.addresses.agentRegistryV2, registryAbi, this.provider),
            reputation: new ethers.Contract(this.network.addresses.reputationManagerV3, reputationAbi, this.provider),
            marketplace: new ethers.Contract(this.network.addresses.agentLiquidityMarketplace, marketplaceAbi, this.provider)
        };
    }

    async scanAgents() {
        console.log('   Scanning registered agents...');

        try {
            // Get AgentRegistered events
            const filter = this.contracts.registry.filters.AgentRegistered();
            const events = await this.contracts.registry.queryFilter(filter, 0, 'latest');

            for (const event of events) {
                const agentAddress = event.args.agentAddress;
                const agentId = event.args.agentId;

                this.usage.uniqueUsers.add(agentAddress.toLowerCase());

                // Get agent details
                const [isRegistered, score] = await Promise.all([
                    this.contracts.registry.isRegistered(agentAddress),
                    this.contracts.reputation['getReputationScore(address)'](agentAddress).catch(() => 0n)
                ]);

                this.usage.agents.push({
                    agentId: agentId.toString(),
                    address: agentAddress,
                    isRegistered,
                    reputationScore: score.toString(),
                    registeredAt: event.blockNumber
                });
            }

            this.usage.stats.totalAgents = this.usage.agents.length;
            console.log(`      Found ${this.usage.agents.length} registered agents`);

        } catch (error) {
            console.log(`      Error scanning agents: ${error.message}`);
        }
    }

    async scanPools() {
        console.log('   Scanning liquidity pools...');

        try {
            // Get PoolCreated events
            const filter = this.contracts.marketplace.filters.PoolCreated();
            const events = await this.contracts.marketplace.queryFilter(filter, 0, 'latest');

            for (const event of events) {
                const agentId = event.args.agentId;
                const agentAddress = event.args.agentAddress;

                this.usage.uniqueUsers.add(agentAddress.toLowerCase());

                // Get pool details
                try {
                    const pool = await this.contracts.marketplace.getAgentPool(agentId);

                    this.usage.pools.push({
                        agentId: agentId.toString(),
                        agentAddress,
                        totalLiquidity: ethers.formatUnits(pool.totalLiquidity, 6),
                        availableLiquidity: ethers.formatUnits(pool.availableLiquidity, 6),
                        totalLoaned: ethers.formatUnits(pool.totalLoaned, 6),
                        totalEarned: ethers.formatUnits(pool.totalEarned, 6),
                        isActive: pool.isActive,
                        createdAt: event.blockNumber
                    });

                    if (pool.isActive) {
                        this.usage.stats.activePools++;
                    }
                } catch (e) {
                    // Pool might not exist or be accessible
                }
            }

            console.log(`      Found ${this.usage.pools.length} pools (${this.usage.stats.activePools} active)`);

        } catch (error) {
            console.log(`      Error scanning pools: ${error.message}`);
        }
    }

    async scanLoans() {
        console.log('   Scanning loan activity...');

        try {
            // Get LoanRequested events
            const requestFilter = this.contracts.marketplace.filters.LoanRequested();
            const requestEvents = await this.contracts.marketplace.queryFilter(requestFilter, 0, 'latest');

            console.log(`      Found ${requestEvents.length} loan requests`);

            for (const event of requestEvents) {
                const loanId = event.args.loanId;
                const borrower = event.args.borrower;
                const amount = event.args.amount;

                this.usage.uniqueUsers.add(borrower.toLowerCase());
                this.usage.stats.totalBorrowed += amount;

                const loanInfo = {
                    loanId: loanId.toString(),
                    borrower,
                    amount: ethers.formatUnits(amount, 6),
                    status: 'requested',
                    requestedAt: event.blockNumber
                };

                // Check if loan was repaid
                try {
                    const repayFilter = this.contracts.marketplace.filters.LoanRepaid(loanId);
                    const repayEvents = await this.contracts.marketplace.queryFilter(repayFilter, event.blockNumber, 'latest');

                    if (repayEvents.length > 0) {
                        loanInfo.status = 'repaid';
                        loanInfo.repaidAt = repayEvents[0].blockNumber;
                        this.usage.stats.totalRepaid += amount;
                    } else {
                        loanInfo.status = 'active';
                        this.usage.stats.activeLoans++;
                    }
                } catch (e) {
                    // Couldn't determine repayment status
                }

                this.usage.loans.push(loanInfo);
            }

            this.usage.stats.totalLoans = this.usage.loans.length;
            console.log(`      Found ${this.usage.loans.length} total loans (${this.usage.stats.activeLoans} active)`);

        } catch (error) {
            console.log(`      Error scanning loans: ${error.message}`);
        }
    }

    async scanLiquiditySupplies() {
        console.log('   Scanning liquidity providers...');

        try {
            // Get LiquiditySupplied events
            const filter = this.contracts.marketplace.filters.LiquiditySupplied();
            const events = await this.contracts.marketplace.queryFilter(filter, 0, 'latest');

            const suppliers = new Map();

            for (const event of events) {
                const supplier = event.args.supplier;
                const amount = event.args.amount;

                this.usage.uniqueUsers.add(supplier.toLowerCase());

                if (!suppliers.has(supplier)) {
                    suppliers.set(supplier, {
                        address: supplier,
                        totalSupplied: 0n,
                        supplyCount: 0
                    });
                }

                const supplierData = suppliers.get(supplier);
                supplierData.totalSupplied += amount;
                supplierData.supplyCount++;
            }

            console.log(`      Found ${suppliers.size} unique liquidity providers`);
            console.log(`      Total supplies: ${events.length}`);

            // Store top suppliers
            this.usage.topSuppliers = Array.from(suppliers.values())
                .sort((a, b) => Number(b.totalSupplied - a.totalSupplied))
                .slice(0, 10)
                .map(s => ({
                    address: s.address,
                    totalSupplied: ethers.formatUnits(s.totalSupplied, 6),
                    supplyCount: s.supplyCount
                }));

        } catch (error) {
            console.log(`      Error scanning liquidity: ${error.message}`);
        }
    }

    async runAudit() {
        console.log('\n╔════════════════════════════════════════════════════════════╗');
        console.log(`║           USAGE AUDIT: ${this.network.name.padEnd(34)}║`);
        console.log('╚════════════════════════════════════════════════════════════╝\n');

        await this.initialize();

        await this.scanAgents();
        await this.scanPools();
        await this.scanLoans();
        await this.scanLiquiditySupplies();

        // Finalize stats
        this.usage.stats.uniqueAddresses = this.usage.uniqueUsers.size;

        // Print summary
        console.log('\n' + '═'.repeat(60));
        console.log('USAGE SUMMARY');
        console.log('═'.repeat(60));
        console.log(`Registered Agents:       ${this.usage.stats.totalAgents}`);
        console.log(`Active Pools:            ${this.usage.stats.activePools}`);
        console.log(`Total Loans:             ${this.usage.stats.totalLoans}`);
        console.log(`Active Loans:            ${this.usage.stats.activeLoans}`);
        console.log(`Total Borrowed:          ${ethers.formatUnits(this.usage.stats.totalBorrowed, 6)} USDC`);
        console.log(`Total Repaid:            ${ethers.formatUnits(this.usage.stats.totalRepaid, 6)} USDC`);
        console.log(`Unique Addresses:        ${this.usage.stats.uniqueAddresses}`);
        console.log('═'.repeat(60) + '\n');

        // Convert Set to Array for JSON serialization
        this.usage.uniqueUsers = Array.from(this.usage.uniqueUsers);

        return this.usage;
    }
}

async function main() {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║          SPECULAR PROTOCOL - USAGE AUDIT                   ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    console.log(`Date: ${new Date().toISOString()}\n`);

    const allUsage = {};

    // Audit all networks
    for (const networkKey of ['arc', 'base', 'arbitrum']) {
        const auditor = new UsageAuditor(networkKey);
        allUsage[networkKey] = await auditor.runAudit();
        await new Promise(resolve => setTimeout(resolve, 2000));
    }

    // Overall summary
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                  OVERALL USAGE SUMMARY                     ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    let totalAgents = 0;
    let totalPools = 0;
    let totalLoans = 0;
    let totalBorrowed = 0n;
    let allUsers = new Set();

    for (const [networkKey, usage] of Object.entries(allUsage)) {
        totalAgents += usage.stats.totalAgents;
        totalPools += usage.stats.activePools;
        totalLoans += usage.stats.totalLoans;
        totalBorrowed += BigInt(usage.stats.totalBorrowed);
        usage.uniqueUsers.forEach(u => allUsers.add(u));

        console.log(`${usage.network}:`);
        console.log(`   Agents: ${usage.stats.totalAgents}`);
        console.log(`   Pools: ${usage.stats.activePools}`);
        console.log(`   Loans: ${usage.stats.totalLoans}`);
        console.log(`   Borrowed: ${ethers.formatUnits(usage.stats.totalBorrowed, 6)} USDC`);
        console.log('');
    }

    console.log('─'.repeat(60));
    console.log(`Total Across All Networks:`);
    console.log(`   Registered Agents:    ${totalAgents}`);
    console.log(`   Active Pools:         ${totalPools}`);
    console.log(`   Total Loans:          ${totalLoans}`);
    console.log(`   Total Borrowed:       ${ethers.formatUnits(totalBorrowed, 6)} USDC`);
    console.log(`   Unique Users:         ${allUsers.size}`);
    console.log('─'.repeat(60) + '\n');

    // Top users by network
    console.log('📊 TOP USERS BY ACTIVITY:\n');
    for (const [networkKey, usage] of Object.entries(allUsage)) {
        if (usage.agents.length > 0) {
            console.log(`${usage.network}:`);
            console.log('   Top Agents by Reputation:');
            const topAgents = usage.agents
                .sort((a, b) => Number(BigInt(b.reputationScore) - BigInt(a.reputationScore)))
                .slice(0, 5);

            topAgents.forEach((agent, i) => {
                console.log(`   ${i + 1}. ${agent.address} (Score: ${agent.reputationScore})`);
            });
            console.log('');
        }

        if (usage.topSuppliers && usage.topSuppliers.length > 0) {
            console.log('   Top Liquidity Providers:');
            usage.topSuppliers.slice(0, 5).forEach((supplier, i) => {
                console.log(`   ${i + 1}. ${supplier.address} (${supplier.totalSupplied} USDC supplied)`);
            });
            console.log('');
        }
    }

    // Save results
    const outputPath = path.join(__dirname, '../usage-audit-results.json');
    fs.writeFileSync(outputPath, JSON.stringify(allUsage, null, 2));
    console.log(`📄 Full results saved to: ${outputPath}\n`);

    // Exit
    process.exit(0);
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
