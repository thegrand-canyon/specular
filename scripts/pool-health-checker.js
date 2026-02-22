/**
 * Pool Health Checker
 *
 * Scans all active agent pools and produces a health report flagging:
 *   - Utilization > 80%   → WARNING
 *   - Utilization > 95%   → CRITICAL
 *   - Pools with no loans → INFO (zero activity)
 *   - Agent reputation < 100 → WARNING (collateral risk)
 *   - Loans past their due date (overdue without repayment) → WARNING / CRITICAL
 *   - Interest accruing with no repayment activity → INFO
 *
 * Usage:
 *   npx hardhat run scripts/pool-health-checker.js --network arcTestnet
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const AGENT_REGISTRY_ABI = [
    'function totalAgents() view returns (uint256)',
];

const REPUTATION_MANAGER_ABI = [
    'function getReputationScore(uint256 agentId) view returns (uint256)',
];

const MARKETPLACE_ABI = [
    'function agentPools(uint256 agentId) view returns (uint256 agentId, address owner, uint256 totalLiquidity, uint256 availableLiquidity, uint256 totalLoaned, uint256 totalEarned, bool isActive)',
    'function loans(uint256 loanId) view returns (address borrower, uint256 agentId, uint256 principal, uint256 collateral, uint256 interestRate, uint256 startTime, uint256 durationDays, uint256 totalRepayment, uint256 repaidAmount, uint8 state)',
    'function nextLoanId() view returns (uint256)',
];

// Loan states
const LOAN_STATE = { PENDING: 0, ACTIVE: 1, REPAID: 2, DEFAULTED: 3 };

// Health status levels (ordered by severity)
const STATUS = {
    HEALTHY:  'HEALTHY',
    INFO:     'INFO',
    WARNING:  'WARNING',
    CRITICAL: 'CRITICAL',
};

// Utilization thresholds (percentage)
const UTIL_WARN     = 80;
const UTIL_CRITICAL = 95;

// Reputation threshold
const REP_RISK = 100;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format a raw USDC BigInt to a human-readable string. */
function formatUSDC(raw, decimals = 2) {
    return `$${Number(ethers.formatUnits(raw, 6)).toFixed(decimals)}`;
}

/**
 * Return a coloured status badge.
 * (Colours use ANSI escapes; they degrade gracefully if the terminal doesn't
 *  support them.)
 *
 * @param {string} status - One of STATUS.*
 * @returns {string}
 */
function badge(status) {
    const codes = {
        [STATUS.HEALTHY]:  '\x1b[32m',  // green
        [STATUS.INFO]:     '\x1b[36m',  // cyan
        [STATUS.WARNING]:  '\x1b[33m',  // yellow
        [STATUS.CRITICAL]: '\x1b[31m',  // red
    };
    const reset = '\x1b[0m';
    const width = 10;
    const padded = status.padEnd(width);
    return `${codes[status] ?? ''}[ ${padded} ]${reset}`;
}

/**
 * Compare two status levels and return the more severe one.
 * @param {string} a
 * @param {string} b
 * @returns {string}
 */
function maxSeverity(a, b) {
    const order = [STATUS.HEALTHY, STATUS.INFO, STATUS.WARNING, STATUS.CRITICAL];
    return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

// ─── Data fetching ────────────────────────────────────────────────────────────

/**
 * Fetch all active pools with their reputation scores.
 */
async function fetchPools(agentRegistry, reputationMgr, marketplace) {
    const totalAgents = Number(await agentRegistry.totalAgents());
    const pools = [];

    for (let agentId = 1; agentId <= totalAgents; agentId++) {
        try {
            const p = await marketplace.agentPools(agentId);
            if (!p.isActive) continue;

            const rep = Number(await reputationMgr['getReputationScore(uint256)'](agentId));
            pools.push({
                agentId,
                owner: p.owner,
                totalLiquidity:    p.totalLiquidity,
                availableLiquidity: p.availableLiquidity,
                totalLoaned:       p.totalLoaned,
                totalEarned:       p.totalEarned,
                isActive:          p.isActive,
                reputation:        rep,
            });
        } catch {
            // Skip
        }
    }

    return pools;
}

/**
 * Fetch all loans and group them by agentId.
 */
async function fetchLoansByAgent(marketplace) {
    const nextLoanId = Number(await marketplace.nextLoanId());
    const totalLoans = Math.max(0, nextLoanId - 1);
    const byAgent = new Map();
    const nowSec = Math.floor(Date.now() / 1000);

    for (let loanId = 1; loanId <= totalLoans; loanId++) {
        try {
            const l = await marketplace.loans(loanId);
            const agentId = Number(l.agentId);
            if (!byAgent.has(agentId)) byAgent.set(agentId, []);

            const startTime   = Number(l.startTime);
            const durationDays = Number(l.durationDays);
            const dueAt        = startTime + durationDays * 86400;
            const overdueSeconds = nowSec - dueAt;

            byAgent.get(agentId).push({
                loanId,
                state:        Number(l.state),
                principal:    l.principal,
                repaidAmount: l.repaidAmount,
                interestRate: Number(l.interestRate),
                startTime,
                durationDays,
                dueAt,
                overdueSeconds,
                hasRepayment: l.repaidAmount > 0n,
            });
        } catch {
            // Skip
        }
    }

    return byAgent;
}

// ─── Health checks ────────────────────────────────────────────────────────────

/**
 * Run all health checks for a single pool and return a list of findings.
 *
 * @param {object} pool
 * @param {Array<object>} loans - Loans belonging to this pool.
 * @returns {{ overallStatus: string, findings: Array<{level: string, message: string}> }}
 */
function checkPool(pool, loans) {
    const findings = [];
    let overallStatus = STATUS.HEALTHY;

    // ── 1. Utilization ───────────────────────────────────────────────────────
    const utilPct = pool.totalLiquidity > 0n
        ? Number(pool.totalLoaned * 10000n / pool.totalLiquidity) / 100
        : 0;

    if (utilPct >= UTIL_CRITICAL) {
        findings.push({ level: STATUS.CRITICAL, message: `Utilization ${utilPct.toFixed(1)}% — pool nearly empty (< 5% available)` });
        overallStatus = maxSeverity(overallStatus, STATUS.CRITICAL);
    } else if (utilPct >= UTIL_WARN) {
        findings.push({ level: STATUS.WARNING, message: `Utilization ${utilPct.toFixed(1)}% — pool above 80% capacity` });
        overallStatus = maxSeverity(overallStatus, STATUS.WARNING);
    }

    // ── 2. Zero activity ─────────────────────────────────────────────────────
    if (loans.length === 0) {
        findings.push({ level: STATUS.INFO, message: 'No loans ever — pool has had zero borrowing activity' });
        overallStatus = maxSeverity(overallStatus, STATUS.INFO);
    }

    // ── 3. Reputation risk ───────────────────────────────────────────────────
    if (pool.reputation < REP_RISK) {
        findings.push({ level: STATUS.WARNING, message: `Reputation score ${pool.reputation} < ${REP_RISK} — elevated collateral risk` });
        overallStatus = maxSeverity(overallStatus, STATUS.WARNING);
    }

    // ── 4. Overdue / past-due loans ──────────────────────────────────────────
    const nowSec = Math.floor(Date.now() / 1000);
    const activeLoans = loans.filter(l => l.state === LOAN_STATE.ACTIVE);

    for (const loan of activeLoans) {
        if (loan.overdueSeconds > 0) {
            const overdueDays = Math.ceil(loan.overdueSeconds / 86400);
            const level = overdueDays >= 7 ? STATUS.CRITICAL : STATUS.WARNING;
            findings.push({
                level,
                message: `Loan #${loan.loanId}: ${overdueDays} day(s) past due (${formatUSDC(loan.principal)} principal)`,
            });
            overallStatus = maxSeverity(overallStatus, level);
        }
    }

    // ── 5. Interest accruing with no repayment ───────────────────────────────
    const accruingNoRepayment = activeLoans.filter(l => !l.hasRepayment && l.startTime > 0);
    for (const loan of accruingNoRepayment) {
        const elapsedDays = Math.floor((nowSec - loan.startTime) / 86400);
        if (elapsedDays > 0) {
            findings.push({
                level: STATUS.INFO,
                message: `Loan #${loan.loanId}: interest accruing for ${elapsedDays} day(s) — no repayment recorded yet`,
            });
            overallStatus = maxSeverity(overallStatus, STATUS.INFO);
        }
    }

    // ── No issues found ──────────────────────────────────────────────────────
    if (findings.length === 0) {
        findings.push({ level: STATUS.HEALTHY, message: 'All checks passed' });
    }

    return { overallStatus, findings, utilPct };
}

// ─── Report rendering ─────────────────────────────────────────────────────────

function printReport(pools, loansByAgent) {
    const border = '═'.repeat(72);

    console.log(`\n${border}`);
    console.log('  SPECULAR PROTOCOL — POOL HEALTH CHECKER');
    console.log(`  Arc Testnet  |  ${new Date().toUTCString()}`);
    console.log(border);

    if (pools.length === 0) {
        console.log('\n  No active pools found.\n');
        return;
    }

    // Summary counters
    const summary = { HEALTHY: 0, INFO: 0, WARNING: 0, CRITICAL: 0 };

    for (const pool of pools) {
        const loans = loansByAgent.get(pool.agentId) || [];
        const { overallStatus, findings, utilPct } = checkPool(pool, loans);
        summary[overallStatus]++;

        console.log(`\n  ${badge(overallStatus)}  Agent #${pool.agentId}`);
        console.log(`    Owner:       ${pool.owner}`);
        console.log(`    Reputation:  ${pool.reputation}`);
        console.log(`    Pool Size:   ${formatUSDC(pool.totalLiquidity, 2)}`);
        console.log(`    Available:   ${formatUSDC(pool.availableLiquidity, 2)}`);
        console.log(`    Borrowed:    ${formatUSDC(pool.totalLoaned, 2)}`);
        console.log(`    Utilization: ${utilPct.toFixed(1)}%`);
        console.log(`    Loans:       ${loans.length} total, ${loans.filter(l => l.state === LOAN_STATE.ACTIVE).length} active`);
        console.log(`    Findings:`);

        for (const f of findings) {
            const indent = '      ';
            const levelTag = f.level === STATUS.HEALTHY ? '  OK  ' : f.level.padEnd(8);
            console.log(`${indent}[${levelTag}] ${f.message}`);
        }
    }

    // Summary footer
    console.log(`\n${border}`);
    console.log('  SUMMARY');
    console.log(`  ${'─'.repeat(40)}`);
    console.log(`  Pools Checked: ${pools.length}`);
    console.log(`  HEALTHY:  ${summary.HEALTHY}`);
    console.log(`  INFO:     ${summary.INFO}`);
    console.log(`  WARNING:  ${summary.WARNING}`);
    console.log(`  CRITICAL: ${summary.CRITICAL}`);
    console.log(border + '\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const agentRegistry = await ethers.getContractAt(AGENT_REGISTRY_ABI, addresses.agentRegistryV2);
    const reputationMgr = await ethers.getContractAt(REPUTATION_MANAGER_ABI, addresses.reputationManagerV3);
    const marketplace   = await ethers.getContractAt(MARKETPLACE_ABI, addresses.agentLiquidityMarketplace);

    console.log('\n  Fetching pool and loan data…');

    const [pools, loansByAgent] = await Promise.all([
        fetchPools(agentRegistry, reputationMgr, marketplace),
        fetchLoansByAgent(marketplace),
    ]);

    printReport(pools, loansByAgent);
}

main().catch(err => {
    console.error('Health checker error:', err.message);
    process.exit(1);
});
