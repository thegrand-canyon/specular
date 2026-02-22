'use strict';
/**
 * Reputation Score Tracker
 *
 * Monitors an agent's reputation progression over multiple loan cycles
 * and validates the scoring algorithm.
 */

require('dotenv').config();

const { ethers } = require('ethers');
const ADDRESSES = require('../config/arc-testnet-addresses.json');

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const AGENT_ADDRESS = process.env.AGENT_ADDRESS || '0x656086A21073272533c8A3f56A94c1f3D8BCFcE2';

const REP_ABI = [
    'function getReputationScore(address agent) view returns (uint256)',
    'function getReputationScore(uint256 agentId) view returns (uint256)',
    'function tierForScore(uint256 score) view returns (uint8)',
    'function calculateCreditLimit(address agent) view returns (uint256)',
    'function calculateInterestRate(address agent) view returns (uint256)',
    'function calculateCollateralRequirement(address agent) view returns (uint256)',
];

const REG_ABI = [
    'function addressToAgentId(address) view returns (uint256)',
];

const MKT_ABI = [
    'function agentLoans(address, uint256) view returns (uint256)',
    'function loans(uint256) view returns (uint256 loanId, address borrower, uint256 agentId, uint256 amount, uint256 collateralAmount, uint256 interestRate, uint256 startTime, uint256 endTime, uint256 duration, uint8 state)',
];

const TIERS = ['UNRATED', 'HIGH_RISK', 'MEDIUM_RISK', 'LOW_RISK', 'EXCELLENT'];
const LOAN_STATES = ['REQUESTED', 'ACTIVE', 'REPAID', 'DEFAULTED'];

async function main() {
    console.log('\n' + '═'.repeat(60));
    console.log('  Reputation Score Tracker');
    console.log('═'.repeat(60));

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const registry = new ethers.Contract(ADDRESSES.agentRegistryV2, REG_ABI, provider);
    const repman = new ethers.Contract(ADDRESSES.reputationManagerV3, REP_ABI, provider);
    const mkt = new ethers.Contract(ADDRESSES.agentLiquidityMarketplace, MKT_ABI, provider);

    // Get agent ID
    const agentId = await registry.addressToAgentId(AGENT_ADDRESS);
    if (agentId === 0n) {
        console.error(`\n[ERROR] ${AGENT_ADDRESS} is not registered\n`);
        return;
    }

    console.log(`\nAgent: ${AGENT_ADDRESS}`);
    console.log(`ID:    #${agentId}`);

    // Get reputation metrics
    const score = await repman['getReputationScore(address)'](AGENT_ADDRESS);
    let tier = 0;
    try {
        tier = await repman.tierForScore(score);
    } catch {
        // Calculate tier manually if contract call fails
        if (Number(score) >= 800) tier = 4;
        else if (Number(score) >= 600) tier = 3;
        else if (Number(score) >= 400) tier = 2;
        else if (Number(score) >= 200) tier = 1;
        else tier = 0;
    }
    const creditLimit = await repman.calculateCreditLimit(AGENT_ADDRESS);
    const interestRate = await repman.calculateInterestRate(AGENT_ADDRESS);
    const collateral = await repman.calculateCollateralRequirement(AGENT_ADDRESS);

    console.log(`\n${'─'.repeat(60)}`);
    console.log('  Current Reputation Metrics');
    console.log('─'.repeat(60));
    console.log(`  Score:               ${score}`);
    console.log(`  Tier:                ${TIERS[tier]} (${tier})`);
    console.log(`  Credit Limit:        ${ethers.formatUnits(creditLimit, 6)} USDC`);
    console.log(`  Interest Rate:       ${Number(interestRate) / 100}%`);
    console.log(`  Collateral Required: ${collateral}%`);

    // Get loan history
    console.log(`\n${'─'.repeat(60)}`);
    console.log('  Loan History');
    console.log('─'.repeat(60));

    const loans = [];
    for (let i = 0; i < 100; i++) {
        try {
            const loanId = await mkt.agentLoans(AGENT_ADDRESS, i);
            if (!loanId || loanId === 0n) break;
            const loan = await mkt.loans(loanId);
            loans.push({ loanId: Number(loanId), ...loan });
        } catch {
            break;
        }
    }

    if (loans.length === 0) {
        console.log('  No loans found');
    } else {
        try {
            const repaid = loans.filter(l => l.state === 2n).length;
            const active = loans.filter(l => l.state === 1n).length;
            const defaulted = loans.filter(l => l.state === 3n).length;

            console.log(`  Total Loans:  ${loans.length}`);
            console.log(`  Repaid:       ${repaid} (${(repaid / loans.length * 100).toFixed(1)}%)`);
            console.log(`  Active:       ${active}`);
            console.log(`  Defaulted:    ${defaulted}`);

            console.log(`\n  Recent Loans:`);
            loans.slice(-10).forEach((l, i) => {
                const state = LOAN_STATES[l.state] || 'UNKNOWN';
                const amount = l.amount ? ethers.formatUnits(l.amount, 6) : '0';
                const rate = l.interestRate ? Number(l.interestRate) / 100 : 0;
                console.log(`    ${loans.length - 10 + i + 1}. Loan #${l.loanId}: ${amount} USDC @ ${rate}% — ${state}`);
            });
        } catch (err) {
            console.log(`  (Loan details unavailable: ${err.message.slice(0, 50)})`);
        }
    }

    // Score progression projection
    console.log(`\n${'─'.repeat(60)}`);
    console.log('  Score Progression (per on-time repayment)');
    console.log('─'.repeat(60));

    const projections = [];
    for (let i = 0; i < 100; i++) {
        const futureScore = Number(score) + (i * 10);
        let futureTier = tier;
        if (futureScore >= 800) futureTier = 4;
        else if (futureScore >= 600) futureTier = 3;
        else if (futureScore >= 400) futureTier = 2;
        else if (futureScore >= 200) futureTier = 1;
        else futureTier = 0;

        if (futureTier !== tier || i === 0 || i === 99) {
            projections.push({ repayments: i, score: futureScore, tier: TIERS[futureTier] });
        }
        if (futureScore >= 1000) break;
    }

    projections.forEach(p => {
        const tierChange = p.tier !== TIERS[tier] ? ` → ${p.tier}` : '';
        console.log(`    +${p.repayments} repayments: score ${p.score}${tierChange}`);
    });

    console.log('\n' + '═'.repeat(60) + '\n');
}

main().catch(err => {
    console.error('\n[ERROR]', err.message);
    process.exit(1);
});
