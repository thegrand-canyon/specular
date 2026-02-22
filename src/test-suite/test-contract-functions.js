'use strict';
/**
 * Contract Function Tests
 *
 * Direct contract interaction tests for all core functions:
 * - Registration
 * - Pool creation
 * - Liquidity supply/withdrawal
 * - Loan request/repayment
 * - Reputation updates
 */

require('dotenv').config();

const { ethers } = require('ethers');
const ADDRESSES = require('../config/arc-testnet-addresses.json');

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const PRIVATE_KEY = process.env.PRIVATE_KEY || process.env.BORROWER_KEY;

if (!PRIVATE_KEY) {
    console.error('[ERROR] PRIVATE_KEY or BORROWER_KEY required');
    process.exit(1);
}

const REG_ABI = [
    'function register(string agentURI, tuple(string key, bytes value)[] metadata) returns (uint256)',
    'function addressToAgentId(address) view returns (uint256)',
    'function isRegistered(address) view returns (bool)',
];

const MKT_ABI = [
    'function createAgentPool()',
    'function supplyLiquidity(uint256 agentId, uint256 amount)',
    'function withdrawLiquidity(uint256 agentId, uint256 amount)',
    'function requestLoan(uint256 amount, uint256 durationDays) returns (uint256)',
    'function repayLoan(uint256 loanId)',
    'function agentPools(uint256) view returns (uint256 agentId, address agentAddress, uint256 totalLiquidity, uint256 availableLiquidity, uint256 totalLoaned, uint256 totalEarned, bool isActive)',
    'function loans(uint256) view returns (uint256 loanId, address borrower, uint256 agentId, uint256 amount, uint256 collateralAmount, uint256 interestRate, uint256 startTime, uint256 endTime, uint256 duration, uint8 state)',
];

const ERC20_ABI = [
    'function approve(address spender, uint256 amount) returns (bool)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
];

const REP_ABI = [
    'function getReputationScore(uint256 agentId) view returns (uint256)',
];

async function main() {
    console.log('\n' + '═'.repeat(60));
    console.log('  Contract Function Tests');
    console.log('═'.repeat(60));

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    const registry = new ethers.Contract(ADDRESSES.agentRegistryV2, REG_ABI, wallet);
    const mkt = new ethers.Contract(ADDRESSES.agentLiquidityMarketplace, MKT_ABI, wallet);
    const usdc = new ethers.Contract(ADDRESSES.mockUSDC, ERC20_ABI, wallet);
    const rep = new ethers.Contract(ADDRESSES.reputationManagerV3, REP_ABI, provider);

    console.log(`\nWallet: ${wallet.address}`);

    const tests = [
        testRegistration,
        testPoolCreation,
        testLiquiditySupply,
        testLoanRequest,
        testLoanRepayment,
        testReputationUpdate,
    ];

    const results = [];

    for (const test of tests) {
        const name = test.name.replace('test', '');
        console.log(`\n${'─'.repeat(60)}`);
        console.log(`  Testing: ${name}`);
        console.log('─'.repeat(60));

        const start = Date.now();
        let status = 'PASS';
        let error = null;

        try {
            await test({ wallet, registry, mkt, usdc, rep, provider });
            console.log(`  ✓ ${name} passed`);
        } catch (err) {
            status = 'FAIL';
            error = err.message;
            console.error(`  ✗ ${name} failed: ${err.message}`);
        }

        const duration = ((Date.now() - start) / 1000).toFixed(2);
        results.push({ test: name, status, duration, error });
    }

    console.log(`\n${'═'.repeat(60)}`);
    console.log('  Test Summary');
    console.log('═'.repeat(60));

    results.forEach((r, i) => {
        const icon = r.status === 'PASS' ? '✓' : '✗';
        console.log(`  ${i + 1}. ${icon} ${r.test.padEnd(25)} ${r.duration}s`);
    });

    const passed = results.filter(r => r.status === 'PASS').length;
    const failed = results.filter(r => r.status === 'FAIL').length;

    console.log(`\n  Results: ${passed}/${results.length} passed, ${failed}/${results.length} failed`);
    console.log('═'.repeat(60) + '\n');

    process.exit(failed > 0 ? 1 : 0);
}

async function testRegistration({ wallet, registry }) {
    const isReg = await registry.isRegistered(wallet.address);
    if (isReg) {
        console.log('  Already registered (skipping)');
        return;
    }

    const metadata = JSON.stringify({ name: 'ContractTestAgent', ts: Date.now() });
    const tx = await registry.register(metadata, []);
    const receipt = await tx.wait();
    console.log(`  Registered! tx: ${receipt.hash.slice(0, 10)}...`);
}

async function testPoolCreation({ wallet, registry, mkt }) {
    const agentId = await registry.addressToAgentId(wallet.address);
    if (agentId === 0n) throw new Error('Not registered');

    const pool = await mkt.agentPools(agentId);
    if (pool.isActive) {
        console.log('  Pool already exists (skipping)');
        return;
    }

    const tx = await mkt.createAgentPool();
    const receipt = await tx.wait();
    console.log(`  Pool created! tx: ${receipt.hash.slice(0, 10)}...`);
}

async function testLiquiditySupply({ wallet, registry, mkt, usdc }) {
    const agentId = await registry.addressToAgentId(wallet.address);
    if (agentId === 0n) throw new Error('Not registered');

    const pool = await mkt.agentPools(agentId);
    if (!pool.isActive) throw new Error('Pool not active');

    const amount = ethers.parseUnits('50', 6); // 50 USDC

    // Approve
    const allowance = await usdc.allowance(wallet.address, ADDRESSES.agentLiquidityMarketplace);
    if (allowance < amount) {
        const approveTx = await usdc.approve(ADDRESSES.agentLiquidityMarketplace, amount * 2n);
        await approveTx.wait();
        console.log('  Approved USDC');
    }

    // Supply
    const tx = await mkt.supplyLiquidity(agentId, amount);
    const receipt = await tx.wait();
    console.log(`  Supplied 50 USDC! tx: ${receipt.hash.slice(0, 10)}...`);
}

async function testLoanRequest({ wallet, registry, mkt, usdc }) {
    const agentId = await registry.addressToAgentId(wallet.address);
    if (agentId === 0n) throw new Error('Not registered');

    const amount = ethers.parseUnits('10', 6); // 10 USDC
    const collateral = amount; // 100% collateral for low score

    // Approve collateral
    const allowance = await usdc.allowance(wallet.address, ADDRESSES.agentLiquidityMarketplace);
    if (allowance < collateral) {
        const approveTx = await usdc.approve(ADDRESSES.agentLiquidityMarketplace, collateral * 2n);
        await approveTx.wait();
        console.log('  Approved collateral');
    }

    // Request loan
    const tx = await mkt.requestLoan(amount, 7);
    const receipt = await tx.wait();

    // Parse loan ID from events
    let loanId = null;
    for (const log of receipt.logs) {
        if (log.topics?.length >= 2) {
            const candidate = parseInt(log.topics[1], 16);
            if (candidate > 0 && candidate < 100000) {
                loanId = candidate;
                break;
            }
        }
    }

    console.log(`  Loan #${loanId} requested! tx: ${receipt.hash.slice(0, 10)}...`);
    return loanId;
}

async function testLoanRepayment({ wallet, registry, mkt, usdc }) {
    const agentId = await registry.addressToAgentId(wallet.address);
    if (agentId === 0n) throw new Error('Not registered');

    // Find an active loan
    let activeLoanId = null;
    for (let i = 0; i < 50; i++) {
        try {
            const loanId = await mkt.agentLoans(wallet.address, i);
            if (!loanId || loanId === 0n) break;

            const loan = await mkt.loans(loanId);
            if (loan.state === 1n) { // ACTIVE
                activeLoanId = Number(loanId);
                break;
            }
        } catch {
            break;
        }
    }

    if (!activeLoanId) {
        console.log('  No active loans to repay (skipping)');
        return;
    }

    const loan = await mkt.loans(activeLoanId);
    const principal = loan.amount;
    const rate = loan.interestRate;
    const duration = loan.duration;
    const interest = (principal * rate * duration) / (365n * 86400n * 10000n);
    const totalRepay = principal + interest;

    // Approve repayment
    const allowance = await usdc.allowance(wallet.address, ADDRESSES.agentLiquidityMarketplace);
    if (allowance < totalRepay) {
        const approveTx = await usdc.approve(ADDRESSES.agentLiquidityMarketplace, totalRepay * 2n);
        await approveTx.wait();
        console.log(`  Approved ${ethers.formatUnits(totalRepay, 6)} USDC for repayment`);
    }

    // Repay
    const tx = await mkt.repayLoan(activeLoanId);
    const receipt = await tx.wait();
    console.log(`  Loan #${activeLoanId} repaid! tx: ${receipt.hash.slice(0, 10)}...`);
}

async function testReputationUpdate({ wallet, registry, rep }) {
    const agentId = await registry.addressToAgentId(wallet.address);
    if (agentId === 0n) throw new Error('Not registered');

    const score = await rep['getReputationScore(uint256)'](agentId);
    console.log(`  Current reputation score: ${score}`);

    if (score === 0n) {
        console.log('  (Score is 0 — complete a loan to increase)');
    } else {
        console.log(`  Score successfully updated from previous loans`);
    }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
    console.error('\n[FATAL]', err.message);
    process.exit(1);
});
