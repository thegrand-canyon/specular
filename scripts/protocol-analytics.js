/**
 * Protocol Analytics — One-Shot Report
 *
 * Queries all on-chain state for the Specular Protocol on Arc Testnet and
 * prints a comprehensive analytics report to stdout.
 *
 * Usage:
 *   npx hardhat run scripts/protocol-analytics.js --network arcTestnet
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

// ─── Contract ABIs (minimal interface pattern) ────────────────────────────────

const AGENT_REGISTRY_ABI = [
    'function totalAgents() view returns (uint256)',
    'function getAgentInfo(uint256 agentId) view returns (uint256 id, address owner, string agentURI, uint256 registeredAt, bool isActive)',
];

const REPUTATION_MANAGER_ABI = [
    'function getReputationScore(uint256 agentId) view returns (uint256)',
];

const MARKETPLACE_ABI = [
    'function agentPools(uint256 agentId) view returns (uint256 agentId, address owner, uint256 totalLiquidity, uint256 availableLiquidity, uint256 totalLoaned, uint256 totalEarned, bool isActive)',
    'function loans(uint256) view returns (uint256 loanId, address borrower, uint256 agentId, uint256 amount, uint256 collateralAmount, uint256 interestRate, uint256 startTime, uint256 endTime, uint256 duration, uint8 state)',
    'function nextLoanId() view returns (uint256)',
    'function accumulatedFees() view returns (uint256)',
];

// Loan states
const LOAN_STATE = { PENDING: 0, ACTIVE: 1, REPAID: 2, DEFAULTED: 3 };

// ─── Formatting helpers ───────────────────────────────────────────────────────

/**
 * Format a raw USDC BigInt value to a human-readable USD string.
 * @param {bigint} raw - Raw value with 6 decimal places.
 * @param {number} [decimals=2] - Display decimal places.
 * @returns {string}
 */
function formatUSDC(raw, decimals = 2) {
    return `$${Number(ethers.formatUnits(raw, 6)).toFixed(decimals)}`;
}

/**
 * Build a simple bar out of Unicode block characters.
 * @param {number} value - Current value.
 * @param {number} max   - Maximum value (full bar).
 * @param {number} [width=20] - Bar width in characters.
 * @returns {string}
 */
function bar(value, max, width = 20) {
    if (max === 0) return '░'.repeat(width);
    const filled = Math.round((value / max) * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/** Print a section header. */
function header(title) {
    const line = '═'.repeat(56);
    console.log(`\n${line}`);
    console.log(`  ${title}`);
    console.log(line);
}

/** Left-pad a string to a given width. */
function pad(str, width) {
    const s = String(str);
    return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

/** Right-pad a string to a given width. */
function rpad(str, width) {
    const s = String(str);
    return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

// ─── Data collection ──────────────────────────────────────────────────────────

/**
 * Fetch all agent pools from the marketplace.
 * Returns an array of pool objects; pools that fail to fetch are silently skipped.
 *
 * @param {ethers.Contract} marketplace
 * @param {ethers.Contract} reputationManager
 * @param {number} totalAgents
 * @returns {Promise<Array<object>>}
 */
async function fetchPools(marketplace, reputationManager, totalAgents) {
    const pools = [];
    for (let agentId = 1; agentId <= totalAgents; agentId++) {
        try {
            const p = await marketplace.agentPools(agentId);
            const rep = await reputationManager['getReputationScore(uint256)'](agentId);
            pools.push({
                agentId,
                owner: p.owner,
                totalLiquidity: p.totalLiquidity,
                availableLiquidity: p.availableLiquidity,
                totalLoaned: p.totalLoaned,
                totalEarned: p.totalEarned,
                isActive: p.isActive,
                reputation: Number(rep),
            });
        } catch {
            // Skip agents that have no pool or error on query
        }
    }
    return pools;
}

/**
 * Fetch all loans from the marketplace.
 * Returns an array of loan objects; individual failures are silently skipped.
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
            loans.push({
                loanId,
                borrower: l.borrower,
                agentId: Number(l.agentId),
                amount: l.amount,
                collateralAmount: l.collateralAmount,
                interestRate: Number(l.interestRate),
                startTime: Number(l.startTime),
                duration: Number(l.duration),
                state: Number(l.state),
            });
        } catch {
            // Skip
        }
    }
    return loans;
}

// ─── Analytics computations ───────────────────────────────────────────────────

/**
 * Compute per-loan accrued interest for ACTIVE loans.
 * Interest = principal * rate * elapsedDays / (365 * 10000)
 * (rate is stored in basis points × 100, i.e. 500 = 5 %)
 *
 * @param {object} loan
 * @returns {bigint} Accrued interest in USDC raw units.
 */
function accruedInterest(loan) {
    if (loan.state !== LOAN_STATE.ACTIVE) return 0n;
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    const elapsed = nowSec - BigInt(loan.startTime);
    const elapsedDays = elapsed / 86400n;
    // interestRate is in basis points (e.g. 500 = 5%)
    return (loan.amount * BigInt(loan.interestRate) * elapsedDays) / (365n * 10000n);
}

/**
 * Estimate annualised APY for a given pool based on totalEarned vs totalLoaned.
 * Falls back to the active loan's interest rate if there are no earnings yet.
 *
 * @param {object} pool
 * @param {Array<object>} loans - All loans for this pool.
 * @returns {string} Formatted APY string.
 */
function estimateAPY(pool, loans) {
    if (pool.totalLiquidity === 0n) return '0.00%';

    // Use totalEarned vs totalLiquidity as a simple proxy
    if (pool.totalEarned > 0n) {
        const apyBps = (pool.totalEarned * 10000n) / pool.totalLiquidity;
        // Annualise: this is cumulative, so treat it as rough estimate
        return `${(Number(apyBps) / 100).toFixed(2)}%`;
    }

    // Fall back to the active loan's stated rate
    const activeLoan = loans.find(l => l.agentId === pool.agentId && l.state === LOAN_STATE.ACTIVE);
    if (activeLoan) {
        return `${(activeLoan.interestRate / 100).toFixed(2)}%`;
    }

    return '0.00%';
}

// ─── Report sections ──────────────────────────────────────────────────────────

function printProtocolOverview({ tvl, utilization, platformFees, totalAgents, activePools }) {
    header('PROTOCOL OVERVIEW');
    console.log(`  Total Agents:        ${totalAgents}`);
    console.log(`  Active Pools:        ${activePools}`);
    console.log(`  Protocol TVL:        ${formatUSDC(tvl)}`);
    console.log(`  Utilization Rate:    ${utilization.toFixed(2)}%`);
    console.log(`  Platform Revenue:    ${formatUSDC(platformFees, 6)} USDC`);
}

function printLoanSummary({ total, active, completed, defaulted, pending, avgLoanSize, totalVolume }) {
    header('LOAN STATISTICS');
    console.log(`  Total Loans:         ${total}`);
    console.log(`  Active:              ${active}`);
    console.log(`  Pending:             ${pending}`);
    console.log(`  Completed (Repaid):  ${completed}`);
    console.log(`  Defaulted:           ${defaulted}`);
    console.log(`  Total Volume:        ${formatUSDC(totalVolume)}`);
    console.log(`  Average Loan Size:   ${total > 0 ? formatUSDC(avgLoanSize) : 'N/A'}`);
}

function printInterestRateDistribution(loans) {
    header('INTEREST RATE DISTRIBUTION');

    // Group into 1% buckets (interestRate is in bps, e.g. 500 = 5%)
    const buckets = {};
    for (const loan of loans) {
        // Convert bps to percentage, floor to nearest integer for bucket
        const pct = Math.floor(loan.interestRate / 100);
        buckets[pct] = (buckets[pct] || 0) + 1;
    }

    if (Object.keys(buckets).length === 0) {
        console.log('  No loans found.');
        return;
    }

    const maxCount = Math.max(...Object.values(buckets));
    const sorted = Object.entries(buckets).sort((a, b) => Number(a[0]) - Number(b[0]));

    console.log(`  ${'Rate'.padEnd(10)} ${'Count'.padEnd(8)} Distribution`);
    console.log(`  ${'─'.repeat(40)}`);
    for (const [pct, count] of sorted) {
        const barStr = bar(count, maxCount, 24);
        console.log(`  ${`${pct}%`.padEnd(10)} ${String(count).padEnd(8)} ${barStr}`);
    }
}

function printReputationDistribution(pools) {
    header('REPUTATION SCORE DISTRIBUTION');

    // Buckets: 0-99, 100-199, ..., 900-999, 1000+
    const buckets = {};
    for (let i = 0; i <= 900; i += 100) {
        buckets[i] = 0;
    }
    buckets[1000] = 0;

    for (const pool of pools) {
        if (!pool.isActive) continue;
        const rep = pool.reputation;
        const bucketKey = rep >= 1000 ? 1000 : Math.floor(rep / 100) * 100;
        buckets[bucketKey] = (buckets[bucketKey] || 0) + 1;
    }

    const maxCount = Math.max(...Object.values(buckets), 1);
    console.log(`  ${'Range'.padEnd(14)} ${'Count'.padEnd(8)} Distribution`);
    console.log(`  ${'─'.repeat(46)}`);
    for (const [start, count] of Object.entries(buckets)) {
        const startN = Number(start);
        const label = startN === 1000 ? '1000+' : `${startN}-${startN + 99}`;
        const barStr = bar(count, maxCount, 24);
        console.log(`  ${label.padEnd(14)} ${String(count).padEnd(8)} ${barStr}`);
    }
}

function printTopAgents(pools, loans) {
    header('TOP 10 AGENTS BY REPUTATION');

    const activePools = pools.filter(p => p.isActive);
    const sorted = [...activePools].sort((a, b) => b.reputation - a.reputation).slice(0, 10);

    if (sorted.length === 0) {
        console.log('  No active pools found.');
        return;
    }

    // Column widths
    const cols = {
        rank:   4,
        id:     9,
        rep:    11,
        pool:   12,
        borrowed: 12,
        loans:  7,
        util:   8,
        apy:    9,
        earned: 14,
    };

    const hdr = [
        rpad('Rank',     cols.rank),
        rpad('Agent',    cols.id),
        rpad('Reputation', cols.rep),
        rpad('Pool Size', cols.pool),
        rpad('Borrowed', cols.borrowed),
        rpad('Loans',    cols.loans),
        rpad('Util%',    cols.util),
        rpad('APY Est.', cols.apy),
        rpad('Int. Earned', cols.earned),
    ].join('  ');

    console.log(`  ${hdr}`);
    console.log(`  ${'─'.repeat(hdr.length)}`);

    sorted.forEach((pool, idx) => {
        const agentLoans = loans.filter(l => l.agentId === pool.agentId);
        const util = pool.totalLiquidity > 0n
            ? (Number(pool.totalLoaned * 10000n / pool.totalLiquidity) / 100).toFixed(1)
            : '0.0';
        const apy = estimateAPY(pool, loans);

        const row = [
            rpad(`${idx + 1}`,                            cols.rank),
            rpad(`#${pool.agentId}`,                      cols.id),
            rpad(pool.reputation,                         cols.rep),
            rpad(formatUSDC(pool.totalLiquidity, 0),      cols.pool),
            rpad(formatUSDC(pool.totalLoaned, 0),         cols.borrowed),
            rpad(agentLoans.length,                       cols.loans),
            rpad(`${util}%`,                              cols.util),
            rpad(apy,                                     cols.apy),
            rpad(formatUSDC(pool.totalEarned, 2),         cols.earned),
        ].join('  ');

        console.log(`  ${row}`);
    });
}

function printAPYEstimate(pools, loans) {
    header('APY ESTIMATES (ACTIVE POOLS)');

    const activePools = pools.filter(p => p.isActive && p.totalLiquidity > 0n);
    if (activePools.length === 0) {
        console.log('  No active pools with liquidity.');
        return;
    }

    console.log(`  ${'Agent'.padEnd(10)} ${'Pool Size'.padEnd(14)} ${'APY Est.'.padEnd(12)} Notes`);
    console.log(`  ${'─'.repeat(52)}`);

    for (const pool of activePools) {
        const apy = estimateAPY(pool, loans);
        const hasActiveLoans = loans.some(l => l.agentId === pool.agentId && l.state === LOAN_STATE.ACTIVE);
        const note = hasActiveLoans ? 'Has active loans' : pool.totalEarned > 0n ? 'Historical earnings' : 'No loan history';
        console.log(`  ${`#${pool.agentId}`.padEnd(10)} ${formatUSDC(pool.totalLiquidity, 0).padEnd(14)} ${apy.padEnd(12)} ${note}`);
    }
}

function printLenderPositions(pools) {
    header('LENDER POSITION SUMMARY');
    console.log('  Note: On-chain lender tracking requires LiquiditySupplied event analysis.');
    console.log('        Showing pool-level summaries.\n');

    const activePools = pools.filter(p => p.isActive);
    if (activePools.length === 0) {
        console.log('  No active pools.');
        return;
    }

    console.log(`  ${'Agent'.padEnd(10)} ${'Owner (Lender)'.padEnd(44)} ${'Pool Size'.padEnd(14)} ${'Available'}`);
    console.log(`  ${'─'.repeat(80)}`);

    for (const pool of activePools) {
        console.log(
            `  ${`#${pool.agentId}`.padEnd(10)}` +
            ` ${pool.owner.padEnd(44)}` +
            ` ${formatUSDC(pool.totalLiquidity, 2).padEnd(14)}` +
            ` ${formatUSDC(pool.availableLiquidity, 2)}`
        );
    }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    console.log('\n');
    console.log('═'.repeat(56));
    console.log('  SPECULAR PROTOCOL — ANALYTICS REPORT');
    console.log('  Arc Testnet');
    console.log(`  Generated: ${new Date().toUTCString()}`);
    console.log('═'.repeat(56));

    // Connect contracts
    const agentRegistry    = await ethers.getContractAt(AGENT_REGISTRY_ABI, addresses.agentRegistryV2);
    const reputationMgr    = await ethers.getContractAt(REPUTATION_MANAGER_ABI, addresses.reputationManagerV3);
    const marketplace      = await ethers.getContractAt(MARKETPLACE_ABI, addresses.agentLiquidityMarketplace);

    // Core counts
    const totalAgents = Number(await agentRegistry.totalAgents());
    const nextLoanId  = Number(await marketplace.nextLoanId());
    const totalLoans  = Math.max(0, nextLoanId - 1);
    const platformFees = await marketplace.accumulatedFees();

    console.log(`\n  Fetching data for ${totalAgents} agents and ${totalLoans} loans…`);

    // Fetch all pools and loans (in parallel batches would be faster; kept sequential for clarity)
    const pools = await fetchPools(marketplace, reputationMgr, totalAgents);
    const loans = await fetchLoans(marketplace, totalLoans);

    // ── Derived metrics ──────────────────────────────────────────────────────

    const activePools = pools.filter(p => p.isActive);

    // TVL = sum of totalLiquidity across ALL active pools
    const tvl = activePools.reduce((acc, p) => acc + p.totalLiquidity, 0n);

    // Currently loaned out
    const totalBorrowed = activePools.reduce((acc, p) => acc + p.totalLoaned, 0n);

    // Utilization
    const utilization = tvl > 0n
        ? (Number(totalBorrowed * 10000n / tvl) / 100)
        : 0;

    // Loan counts
    const activeLoans    = loans.filter(l => l.state === LOAN_STATE.ACTIVE).length;
    const pendingLoans   = loans.filter(l => l.state === LOAN_STATE.PENDING).length;
    const completedLoans = loans.filter(l => l.state === LOAN_STATE.REPAID).length;
    const defaultedLoans = loans.filter(l => l.state === LOAN_STATE.DEFAULTED).length;

    // Volume and average
    const totalVolume = loans.reduce((acc, l) => acc + l.amount, 0n);
    const avgLoanSize = totalLoans > 0 ? totalVolume / BigInt(totalLoans) : 0n;

    // ── Print report ─────────────────────────────────────────────────────────

    printProtocolOverview({
        tvl,
        utilization,
        platformFees,
        totalAgents,
        activePools: activePools.length,
    });

    printLoanSummary({
        total:      totalLoans,
        active:     activeLoans,
        pending:    pendingLoans,
        completed:  completedLoans,
        defaulted:  defaultedLoans,
        avgLoanSize,
        totalVolume,
    });

    printInterestRateDistribution(loans);
    printReputationDistribution(pools);
    printTopAgents(pools, loans);
    printAPYEstimate(pools, loans);
    printLenderPositions(activePools);

    console.log('\n' + '═'.repeat(56));
    console.log('  END OF REPORT');
    console.log('═'.repeat(56) + '\n');
}

main().catch(err => {
    console.error('\nAnalytics script error:', err.message);
    process.exit(1);
});
