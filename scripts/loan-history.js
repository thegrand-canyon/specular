/**
 * Loan History
 *
 * Fetches and displays the complete loan history for the protocol or for a
 * specific agent when the AGENT_ID environment variable is set.
 *
 * Usage:
 *   npx hardhat run scripts/loan-history.js --network arcTestnet
 *   AGENT_ID=5 npx hardhat run scripts/loan-history.js --network arcTestnet
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

// ─── ABIs ─────────────────────────────────────────────────────────────────────

const MARKETPLACE_ABI = [
    'function loans(uint256 loanId) view returns (address borrower, uint256 agentId, uint256 principal, uint256 collateral, uint256 interestRate, uint256 startTime, uint256 durationDays, uint256 totalRepayment, uint256 repaidAmount, uint8 state)',
    'function nextLoanId() view returns (uint256)',
];

// ─── Loan state labels ────────────────────────────────────────────────────────

/** @type {Record<number, string>} */
const STATE_LABEL = {
    0: 'PENDING',
    1: 'ACTIVE',
    2: 'REPAID',
    3: 'DEFAULTED',
};

/** @type {Record<number, string>} ANSI colours for state labels. */
const STATE_COLOR = {
    0: '\x1b[36m',  // cyan  — PENDING
    1: '\x1b[33m',  // yellow — ACTIVE
    2: '\x1b[32m',  // green  — REPAID
    3: '\x1b[31m',  // red    — DEFAULTED
};
const RESET = '\x1b[0m';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Format a raw USDC BigInt to a display string. */
function formatUSDC(raw, decimals = 2) {
    return `$${Number(ethers.formatUnits(raw, 6)).toFixed(decimals)}`;
}

/**
 * Compute interest that has accrued on an ACTIVE loan up to now.
 * Formula: principal × rate(bps) × elapsed_days / (365 × 10000)
 *
 * @param {object} loan
 * @returns {bigint} Accrued interest in raw USDC units.
 */
function accruedInterest(loan) {
    if (loan.state !== 1 /* ACTIVE */) return 0n;
    const nowSec     = BigInt(Math.floor(Date.now() / 1000));
    const elapsed    = nowSec - BigInt(loan.startTime);
    const elapsedDays = elapsed / 86400n;
    return (loan.principal * BigInt(loan.interestRate) * elapsedDays) / (365n * 10000n);
}

/**
 * Compute interest earned on a REPAID loan.
 * = totalRepayment − principal
 *
 * @param {object} loan
 * @returns {bigint}
 */
function earnedInterest(loan) {
    if (loan.state !== 2 /* REPAID */) return 0n;
    return loan.totalRepayment > loan.principal
        ? loan.totalRepayment - loan.principal
        : 0n;
}

/** Colour-wrap a state label string. */
function colorState(state) {
    const label = STATE_LABEL[state] ?? 'UNKNOWN';
    const color = STATE_COLOR[state] ?? '';
    return `${color}${label.padEnd(9)}${RESET}`;
}

// ─── Data fetching ────────────────────────────────────────────────────────────

/**
 * Fetch all loans from the marketplace.
 *
 * @param {ethers.Contract} marketplace
 * @returns {Promise<Array<object>>}
 */
async function fetchAllLoans(marketplace) {
    const nextLoanId = Number(await marketplace.nextLoanId());
    const totalLoans = Math.max(0, nextLoanId - 1);
    const loans = [];

    for (let loanId = 1; loanId <= totalLoans; loanId++) {
        try {
            const l = await marketplace.loans(loanId);
            loans.push({
                loanId,
                borrower:      l.borrower,
                agentId:       Number(l.agentId),
                principal:     l.principal,
                collateral:    l.collateral,
                interestRate:  Number(l.interestRate),
                startTime:     Number(l.startTime),
                durationDays:  Number(l.durationDays),
                totalRepayment: l.totalRepayment,
                repaidAmount:  l.repaidAmount,
                state:         Number(l.state),
            });
        } catch {
            // Skip loans that fail to fetch
        }
    }

    return loans;
}

// ─── Rendering ────────────────────────────────────────────────────────────────

/**
 * Print the full loan history table plus a summary footer.
 *
 * @param {Array<object>} loans - Filtered loan list.
 * @param {number|null}  agentFilter - Agent ID filter or null for all.
 */
function printHistory(loans, agentFilter) {
    const border = '═'.repeat(80);
    const title  = agentFilter != null
        ? `LOAN HISTORY — Agent #${agentFilter}`
        : 'LOAN HISTORY — All Agents';

    console.log(`\n${border}`);
    console.log(`  SPECULAR PROTOCOL — ${title}`);
    console.log(`  Arc Testnet  |  ${new Date().toUTCString()}`);
    console.log(border);

    if (loans.length === 0) {
        console.log('\n  No loans found.\n');
        return;
    }

    // Column header
    console.log(
        `\n  ${'Loan'.padEnd(8)}` +
        `${'Agent'.padEnd(8)}` +
        `${'Principal'.padEnd(14)}` +
        `${'Duration'.padEnd(10)}` +
        `${'State'.padEnd(14)}` +
        `${'Rate'.padEnd(8)}` +
        `Interest`
    );
    console.log(`  ${'─'.repeat(76)}`);

    // Accumulators for summary
    let totalPrincipal = 0n;
    let totalInterest  = 0n;
    let activeCount    = 0;

    for (const loan of loans) {
        let interest;
        let interestNote;

        if (loan.state === 2 /* REPAID */) {
            interest = earnedInterest(loan);
            interestNote = formatUSDC(interest);
        } else if (loan.state === 1 /* ACTIVE */) {
            interest = accruedInterest(loan);
            interestNote = `${formatUSDC(interest)} (accruing)`;
            activeCount++;
        } else {
            interest = 0n;
            interestNote = '$0.00';
        }

        totalPrincipal += loan.principal;
        totalInterest  += interest;

        const ratePct  = `${(loan.interestRate / 100).toFixed(1)}%`;

        console.log(
            `  ${`#${loan.loanId}`.padEnd(8)}` +
            `${`#${loan.agentId}`.padEnd(8)}` +
            `${formatUSDC(loan.principal, 2).padEnd(14)}` +
            `${`${loan.durationDays}d`.padEnd(10)}` +
            `${colorState(loan.state).padEnd(14)}` +
            `${ratePct.padEnd(8)}` +
            interestNote
        );
    }

    // Summary
    console.log(`\n${'─'.repeat(80)}`);
    console.log(
        `  Summary: ${loans.length} loan(s) | ` +
        `${formatUSDC(totalPrincipal)} total principal | ` +
        `${formatUSDC(totalInterest)} interest earned | ` +
        `${activeCount} active`
    );
    console.log(`${border}\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    // Optional agent filter from environment
    const agentFilter = process.env.AGENT_ID != null ? Number(process.env.AGENT_ID) : null;

    if (agentFilter != null) {
        console.log(`\n  Fetching loan history for Agent #${agentFilter}…`);
    } else {
        console.log('\n  Fetching complete protocol loan history…');
    }

    const marketplace = await ethers.getContractAt(MARKETPLACE_ABI, addresses.agentLiquidityMarketplace);
    const allLoans    = await fetchAllLoans(marketplace);

    // Apply optional agent filter
    const loans = agentFilter != null
        ? allLoans.filter(l => l.agentId === agentFilter)
        : allLoans;

    printHistory(loans, agentFilter);
}

main().catch(err => {
    console.error('Loan history error:', err.message);
    process.exit(1);
});
