/**
 * Agent Leaderboard — Live-Updating
 *
 * Displays all registered agents ranked by reputation score. The board
 * clears and refreshes every 15 seconds.
 *
 * Usage:
 *   npx hardhat run scripts/agent-leaderboard.js --network arcTestnet
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

const LOAN_STATE_ACTIVE = 1;
const REFRESH_INTERVAL_MS = 15_000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format a raw USDC BigInt to a display string like "$40,000". */
function formatUSDC(raw, decimals = 0) {
    const n = Number(ethers.formatUnits(raw, 6));
    return `$${n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}`;
}

/** Right-pad a string to width. */
function rpad(str, width) {
    const s = String(str);
    return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/** Left-pad a string to width. */
function lpad(str, width) {
    const s = String(str);
    return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

/**
 * Render a compact reputation bar using filled/empty blocks.
 * Max score is treated as 1000 for scaling purposes.
 *
 * @param {number} score - Reputation score.
 * @param {number} [width=8] - Bar width in characters.
 * @returns {string}
 */
function reputationBar(score, width = 8) {
    const MAX = 1000;
    const filled = Math.round(Math.min(score / MAX, 1) * width);
    return '█'.repeat(filled) + '░'.repeat(width - filled);
}

/**
 * Estimate APY for a pool.
 * Uses totalEarned / totalLiquidity if earnings exist, otherwise
 * falls back to the active loan's stated interest rate.
 *
 * @param {object} pool
 * @param {Array<object>} allLoans - All loans across the protocol.
 * @returns {string}
 */
function estimateAPY(pool, allLoans) {
    if (pool.totalLiquidity === 0n) return '0%';

    if (pool.totalEarned > 0n) {
        const bps = Number(pool.totalEarned * 10000n / pool.totalLiquidity);
        return `${(bps / 100).toFixed(1)}%`;
    }

    const activeLoan = allLoans.find(
        l => l.agentId === pool.agentId && l.state === LOAN_STATE_ACTIVE
    );
    if (activeLoan) {
        return `${(activeLoan.interestRate / 100).toFixed(1)}%`;
    }

    return '0%';
}

// ─── Data fetching ────────────────────────────────────────────────────────────

/**
 * Fetch leaderboard data: pools with reputation, loan counts, and APY.
 *
 * @param {ethers.Contract} agentRegistry
 * @param {ethers.Contract} reputationMgr
 * @param {ethers.Contract} marketplace
 * @returns {Promise<{ rows: Array<object>, totalAgents: number, loanCount: number }>}
 */
async function fetchLeaderboardData(agentRegistry, reputationMgr, marketplace) {
    const totalAgents = Number(await agentRegistry.totalAgents());
    const nextLoanId  = Number(await marketplace.nextLoanId());
    const totalLoans  = Math.max(0, nextLoanId - 1);

    // Fetch all loans (needed for per-agent loan counts and APY)
    const allLoans = [];
    for (let loanId = 1; loanId <= totalLoans; loanId++) {
        try {
            const l = await marketplace.loans(loanId);
            allLoans.push({
                loanId,
                agentId:      Number(l.agentId),
                interestRate: Number(l.interestRate),
                state:        Number(l.state),
            });
        } catch {
            // Skip
        }
    }

    // Fetch per-agent pool + reputation
    const rows = [];
    for (let agentId = 1; agentId <= totalAgents; agentId++) {
        try {
            const p = await marketplace.agentPools(agentId);
            const rep = Number(await reputationMgr['getReputationScore(uint256)'](agentId));

            const agentLoans = allLoans.filter(l => l.agentId === agentId);
            const loanCount  = agentLoans.length;
            const borrowed   = p.totalLoaned;
            const apy        = estimateAPY(
                { agentId, totalLiquidity: p.totalLiquidity, totalEarned: p.totalEarned },
                allLoans
            );

            rows.push({
                agentId,
                reputation: rep,
                totalLiquidity: p.totalLiquidity,
                borrowed,
                loanCount,
                apy,
                isActive: p.isActive,
            });
        } catch {
            // Skip agents with no pool
        }
    }

    // Sort by reputation descending
    rows.sort((a, b) => b.reputation - a.reputation);

    return { rows, totalAgents, loanCount: totalLoans };
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/**
 * Render and print the leaderboard to stdout.
 *
 * @param {{ rows: Array<object>, totalAgents: number, loanCount: number }} data
 */
function renderLeaderboard({ rows, totalAgents, loanCount }) {
    console.clear();

    const border = '═'.repeat(79);
    console.log(border);
    console.log('    SPECULAR PROTOCOL - AGENT LEADERBOARD');
    console.log(border);
    console.log(`  Updated: ${new Date().toUTCString()}`);
    console.log(`  Total Agents: ${totalAgents}  |  Total Loans: ${loanCount}\n`);

    // Column header
    const header = [
        lpad('Rank', 5),
        rpad('Agent ID', 10),
        rpad('Reputation', 20),          // bar + number
        rpad('Pool Size', 12),
        rpad('Borrowed', 12),
        lpad('Loans', 6),
        rpad('APY Est.', 10),
    ].join('  ');
    console.log(`  ${header}`);
    console.log(`  ${'─'.repeat(header.length)}`);

    if (rows.length === 0) {
        console.log('  No agents found.');
    }

    rows.forEach((row, idx) => {
        const repDisplay = `${reputationBar(row.reputation)} ${row.reputation}`;
        const line = [
            lpad(idx + 1,            5),
            rpad(`#${row.agentId}`,  10),
            rpad(repDisplay,         20),
            rpad(formatUSDC(row.totalLiquidity, 0), 12),
            rpad(formatUSDC(row.borrowed, 0),       12),
            lpad(row.loanCount,      6),
            rpad(row.apy,            10),
        ].join('  ');
        console.log(`  ${line}`);
    });

    console.log('');
    console.log(border);
    console.log(`  Refreshing in ${REFRESH_INTERVAL_MS / 1000}s... (Ctrl+C to stop)`);
    console.log(border);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const agentRegistry = await ethers.getContractAt(AGENT_REGISTRY_ABI, addresses.agentRegistryV2);
    const reputationMgr = await ethers.getContractAt(REPUTATION_MANAGER_ABI, addresses.reputationManagerV3);
    const marketplace   = await ethers.getContractAt(MARKETPLACE_ABI, addresses.agentLiquidityMarketplace);

    /**
     * Performs one refresh cycle: fetch data and render.
     */
    async function refresh() {
        try {
            const data = await fetchLeaderboardData(agentRegistry, reputationMgr, marketplace);
            renderLeaderboard(data);
        } catch (err) {
            console.error('Error refreshing leaderboard:', err.message);
        }
    }

    // Initial render
    await refresh();

    // Schedule recurring refresh
    setInterval(refresh, REFRESH_INTERVAL_MS);

    // Keep the process alive
    await new Promise(() => {});
}

main().catch(err => {
    console.error('Leaderboard error:', err.message);
    process.exit(1);
});
