/**
 * Export Protocol Data to JSON
 *
 * Fetches all on-chain state and writes it to JSON files under the
 * project-root `data/` directory for use in external analysis tools,
 * dashboards, or data pipelines.
 *
 * Output files:
 *   data/agents.json   — all agents with reputation and pool stats
 *   data/loans.json    — all loans with full details
 *   data/pools.json    — all pool states
 *   data/summary.json  — protocol-level summary statistics
 *
 * Usage:
 *   npx hardhat run scripts/export-protocol-data.js --network arcTestnet
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const AGENT_REGISTRY_ABI = [
    'function totalAgents() view returns (uint256)',
    'function getAgentInfo(uint256 agentId) view returns (uint256 id, address owner, string agentURI, uint256 registeredAt, bool isActive)',
];

const REPUTATION_MANAGER_ABI = [
    'function getReputationScore(uint256 agentId) view returns (uint256)',
];

const MARKETPLACE_ABI = [
    'function agentPools(uint256 agentId) view returns (uint256 agentId, address owner, uint256 totalLiquidity, uint256 availableLiquidity, uint256 totalLoaned, uint256 totalEarned, bool isActive)',
    'function loans(uint256 loanId) view returns (address borrower, uint256 agentId, uint256 principal, uint256 collateral, uint256 interestRate, uint256 startTime, uint256 durationDays, uint256 totalRepayment, uint256 repaidAmount, uint8 state)',
    'function nextLoanId() view returns (uint256)',
    'function accumulatedFees() view returns (uint256)',
];

// Loan state names
const LOAN_STATE_NAME = ['PENDING', 'ACTIVE', 'REPAID', 'DEFAULTED'];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Convert a raw USDC BigInt to a human-readable decimal string.
 * Stored as a string to avoid JSON precision loss on large values.
 *
 * @param {bigint} raw
 * @returns {string}
 */
function toUSDC(raw) {
    return ethers.formatUnits(raw, 6);
}

/**
 * Ensure the `data/` output directory exists, creating it if necessary.
 *
 * @param {string} dataDir - Absolute path to the data directory.
 */
function ensureDataDir(dataDir) {
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
        console.log(`  Created directory: ${dataDir}`);
    }
}

/**
 * Write a JSON file and log the result.
 *
 * @param {string} filePath
 * @param {object} data
 */
function writeJSON(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    const sizeKB = (fs.statSync(filePath).size / 1024).toFixed(1);
    console.log(`  Written: ${filePath} (${sizeKB} KB)`);
}

// ─── Data collection ──────────────────────────────────────────────────────────

/**
 * Fetch all agent records from AgentRegistry.
 *
 * @param {ethers.Contract} agentRegistry
 * @param {number} totalAgents
 * @returns {Promise<Array<object>>}
 */
async function fetchAgentInfos(agentRegistry, totalAgents) {
    const infos = [];
    for (let agentId = 1; agentId <= totalAgents; agentId++) {
        try {
            const info = await agentRegistry.getAgentInfo(agentId);
            infos.push({
                id:           Number(info.id),
                owner:        info.owner,
                agentURI:     info.agentURI,
                registeredAt: Number(info.registeredAt),
                isActive:     info.isActive,
            });
        } catch {
            infos.push({ id: agentId, error: 'fetch_failed' });
        }
    }
    return infos;
}

/**
 * Fetch all pool data with reputation scores.
 *
 * @param {ethers.Contract} marketplace
 * @param {ethers.Contract} reputationMgr
 * @param {number} totalAgents
 * @returns {Promise<Array<object>>}
 */
async function fetchPools(marketplace, reputationMgr, totalAgents) {
    const pools = [];
    for (let agentId = 1; agentId <= totalAgents; agentId++) {
        try {
            const p   = await marketplace.agentPools(agentId);
            const rep = Number(await reputationMgr['getReputationScore(uint256)'](agentId));

            const totalLiq  = p.totalLiquidity;
            const totalLoan = p.totalLoaned;
            const utilPct   = totalLiq > 0n
                ? Number(totalLoan * 10000n / totalLiq) / 100
                : 0;

            pools.push({
                agentId,
                owner:              p.owner,
                reputation:         rep,
                totalLiquidity:     toUSDC(p.totalLiquidity),
                availableLiquidity: toUSDC(p.availableLiquidity),
                totalLoaned:        toUSDC(p.totalLoaned),
                totalEarned:        toUSDC(p.totalEarned),
                utilizationPct:     utilPct,
                isActive:           p.isActive,
            });
        } catch {
            pools.push({ agentId, error: 'fetch_failed' });
        }
    }
    return pools;
}

/**
 * Fetch all loans from the marketplace.
 *
 * @param {ethers.Contract} marketplace
 * @param {number} totalLoans
 * @returns {Promise<Array<object>>}
 */
async function fetchLoans(marketplace, totalLoans) {
    const loans = [];
    for (let loanId = 1; loanId <= totalLoans; loanId++) {
        try {
            const l = await marketplace.loans(loanId);
            const state = Number(l.state);
            const nowSec = Math.floor(Date.now() / 1000);
            const startTime = Number(l.startTime);
            const durationDays = Number(l.durationDays);
            const dueAt = startTime + durationDays * 86400;
            const isOverdue = state === 1 /* ACTIVE */ && nowSec > dueAt;

            loans.push({
                loanId,
                borrower:      l.borrower,
                agentId:       Number(l.agentId),
                principal:     toUSDC(l.principal),
                collateral:    toUSDC(l.collateral),
                interestRateBps: Number(l.interestRate),
                interestRatePct: Number(l.interestRate) / 100,
                startTime,
                durationDays,
                dueAt,
                isOverdue,
                totalRepayment: toUSDC(l.totalRepayment),
                repaidAmount:   toUSDC(l.repaidAmount),
                state,
                stateName:      LOAN_STATE_NAME[state] ?? 'UNKNOWN',
            });
        } catch {
            loans.push({ loanId, error: 'fetch_failed' });
        }
    }
    return loans;
}

/**
 * Compute protocol-level summary statistics.
 *
 * @param {Array<object>} pools  - Pool records.
 * @param {Array<object>} loans  - Loan records.
 * @param {bigint}        fees   - Accumulated platform fees.
 * @param {number}        totalAgents
 * @returns {object}
 */
function buildSummary(pools, loans, fees, totalAgents) {
    const activePools  = pools.filter(p => p.isActive && !p.error);
    const validLoans   = loans.filter(l => !l.error);

    const tvlRaw       = activePools.reduce((s, p) => s + BigInt(Math.round(parseFloat(p.totalLiquidity) * 1e6)), 0n);
    const borrowedRaw  = activePools.reduce((s, p) => s + BigInt(Math.round(parseFloat(p.totalLoaned) * 1e6)), 0n);
    const earnedRaw    = activePools.reduce((s, p) => s + BigInt(Math.round(parseFloat(p.totalEarned) * 1e6)), 0n);
    const volumeRaw    = validLoans.reduce((s, l) => s + BigInt(Math.round(parseFloat(l.principal) * 1e6)), 0n);

    const utilPct = tvlRaw > 0n
        ? Number(borrowedRaw * 10000n / tvlRaw) / 100
        : 0;

    const loanCounts = {
        total:     validLoans.length,
        active:    validLoans.filter(l => l.state === 1).length,
        pending:   validLoans.filter(l => l.state === 0).length,
        repaid:    validLoans.filter(l => l.state === 2).length,
        defaulted: validLoans.filter(l => l.state === 3).length,
        overdue:   validLoans.filter(l => l.isOverdue).length,
    };

    const avgLoanSizeRaw = loanCounts.total > 0
        ? volumeRaw / BigInt(loanCounts.total)
        : 0n;

    return {
        exportedAt:        new Date().toISOString(),
        network:           'arcTestnet',
        totalAgents,
        activePools:       activePools.length,
        tvl:               toUSDC(tvlRaw),
        totalBorrowed:     toUSDC(borrowedRaw),
        totalEarned:       toUSDC(earnedRaw),
        utilizationPct:    utilPct,
        platformRevenue:   toUSDC(fees),
        loanCounts,
        totalLoanVolume:   toUSDC(volumeRaw),
        averageLoanSize:   toUSDC(avgLoanSizeRaw),
    };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const dataDir = path.join(__dirname, '..', 'data');
    ensureDataDir(dataDir);

    console.log('\n  Connecting to contracts…');
    const agentRegistry = await ethers.getContractAt(AGENT_REGISTRY_ABI, addresses.agentRegistryV2);
    const reputationMgr = await ethers.getContractAt(REPUTATION_MANAGER_ABI, addresses.reputationManagerV3);
    const marketplace   = await ethers.getContractAt(MARKETPLACE_ABI, addresses.agentLiquidityMarketplace);

    const totalAgents = Number(await agentRegistry.totalAgents());
    const nextLoanId  = Number(await marketplace.nextLoanId());
    const totalLoans  = Math.max(0, nextLoanId - 1);
    const fees        = await marketplace.accumulatedFees();

    console.log(`  Agents: ${totalAgents}  |  Loans: ${totalLoans}`);
    console.log('  Fetching all data (this may take a moment)…\n');

    // Fetch all data in parallel where possible
    const [agentInfos, pools, loans] = await Promise.all([
        fetchAgentInfos(agentRegistry, totalAgents),
        fetchPools(marketplace, reputationMgr, totalAgents),
        fetchLoans(marketplace, totalLoans),
    ]);

    // Build combined agent records (registry info + pool stats)
    const agents = agentInfos.map(info => {
        const pool = pools.find(p => p.agentId === info.id);
        return { ...info, pool: pool ?? null };
    });

    const summary = buildSummary(pools, loans, fees, totalAgents);

    // Write output files
    console.log('  Writing JSON files…\n');
    writeJSON(path.join(dataDir, 'agents.json'), agents);
    writeJSON(path.join(dataDir, 'loans.json'),  loans);
    writeJSON(path.join(dataDir, 'pools.json'),  pools);
    writeJSON(path.join(dataDir, 'summary.json'), summary);

    console.log('\n  Export complete.\n');
    console.log('  Summary:');
    console.log(`    TVL:              $${summary.tvl} USDC`);
    console.log(`    Total Borrowed:   $${summary.totalBorrowed} USDC`);
    console.log(`    Utilization:      ${summary.utilizationPct.toFixed(2)}%`);
    console.log(`    Platform Revenue: $${summary.platformRevenue} USDC`);
    console.log(`    Total Loans:      ${summary.loanCounts.total}`);
    console.log('');
}

main().catch(err => {
    console.error('Export error:', err.message);
    process.exit(1);
});
