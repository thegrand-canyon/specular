'use strict';
/**
 * Multi-Lender Pool Test — Pro-Rata Interest Distribution
 *
 * Architecture:
 *   - Alice (agent #5) creates a pool and borrows from it
 *   - Bob (100 USDC) and Carol (300 USDC) supply different amounts as lenders
 *   - After repayment, Carol should earn 3x what Bob earns (pro-rata)
 *   - Each lender calls claimInterest to collect their share
 */

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL      = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const USDC_ADDR    = '0xf2807051e292e945751A25616705a9aadfb39895';
const MKT_ADDR     = '0xD1cf6E7864Bc4CbBE52aA94369dF08B106927559';
const REPMAN_ADDR  = '0x94F2fa47c4488202a46dAA9038Ed9C9c4c07467F';

const USDC_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address, uint256) returns (bool)',
    'function mint(address, uint256)',
];

const MKT_ABI = [
    'function createAgentPool()',
    'function supplyLiquidity(uint256 agentId, uint256 amount)',
    'function requestLoan(uint256 amount, uint256 durationDays) returns (uint256)',
    'function repayLoan(uint256 loanId)',
    'function claimInterest(uint256 agentId)',
    'function agentPools(uint256) view returns (uint256 agentId, address owner, uint256 totalLiquidity, uint256 availableLiquidity, uint256 totalLoaned, uint256 totalEarned, bool isActive)',
    'function getLenderPosition(uint256 agentId, address lender) view returns (uint256 amount, uint256 earnedInterest, uint256 depositTimestamp, uint256 shareOfPool)',
    'function loans(uint256) view returns (uint256 loanId, address borrower, uint256 agentId, uint256 amount, uint256 collateralAmount, uint256 interestRate, uint256 startTime, uint256 endTime, uint256 duration, uint8 state)',
    'function nextLoanId() view returns (uint256)',
    'event LoanRequested(uint256 indexed loanId, uint256 indexed agentId, address indexed borrower, uint256 amount)',
    'event LoanRepaid(uint256 indexed loanId, uint256 principal, uint256 interest)',
    'event InterestDistributed(uint256 indexed agentId, uint256 totalInterest)',
];

const REPMAN_ABI = [
    'function getReputationScore(address) view returns (uint256)',
    'function calculateCreditLimit(address) view returns (uint256)',
];

const LOAN_STATES = ['REQUESTED', 'APPROVED', 'ACTIVE', 'REPAID', 'DEFAULTED', 'LIQUIDATED'];

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function safeCall(fn, label, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try { return await fn(); }
        catch (e) {
            if (i === retries - 1) throw e;
            console.log(`  [retry ${i+1}] ${label}: ${e.message.slice(0, 70)}`);
            await sleep(3000);
        }
    }
}

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const deployer  = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    // Load saved agents
    const agents    = JSON.parse(fs.readFileSync('/Users/peterschroeder/Specular/arc-test-agents.json', 'utf8'));
    const aliceData = agents.find(a => a.agentId === '5');
    const bobData   = agents.find(a => a.agentId === '6');
    const carolData = agents.find(a => a.agentId === '7');

    const aliceW = new ethers.Wallet(aliceData.privateKey, provider); // borrower + pool owner
    const bobW   = new ethers.Wallet(bobData.privateKey, provider);   // lender (smaller stake)
    const carolW = new ethers.Wallet(carolData.privateKey, provider); // lender (larger stake)

    const ALICE_ID = 5;

    const usdc   = new ethers.Contract(USDC_ADDR, USDC_ABI, provider);
    const mkt    = new ethers.Contract(MKT_ADDR, MKT_ABI, provider);
    const repman = new ethers.Contract(REPMAN_ADDR, REPMAN_ABI, provider);
    const iface  = new ethers.Interface(MKT_ABI);

    console.log('='.repeat(60));
    console.log('  Multi-Lender Pro-Rata Test — Arc Testnet');
    console.log('='.repeat(60));
    console.log(`  Alice  (#${ALICE_ID}, borrower): ${aliceW.address}`);
    console.log(`  Bob    (lender, 100 USDC):   ${bobW.address}`);
    console.log(`  Carol  (lender, 300 USDC):   ${carolW.address}`);

    // ── Step 1: Snapshot baseline ──────────────────────────────────────────────
    console.log('\n─── Step 1: Baseline state ───');
    const poolBefore = await safeCall(() => mkt.agentPools(ALICE_ID), 'agentPools(5)');
    await sleep(400);
    console.log(`  Alice pool: active=${poolBefore.isActive}, totalLiq=${Number(poolBefore.totalLiquidity)/1e6} USDC, earned=${Number(poolBefore.totalEarned)/1e6} USDC`);

    const aliceScore = await safeCall(() => repman.getReputationScore(aliceW.address), 'repScore');
    await sleep(400);
    const aliceLimit = await safeCall(() => repman.calculateCreditLimit(aliceW.address), 'creditLimit');
    await sleep(400);
    console.log(`  Alice: score=${aliceScore}, creditLimit=${Number(aliceLimit)/1e6} USDC`);

    const loanPerPool = Math.min(200, Math.floor(Number(aliceLimit) / 1e6));
    console.log(`  Loan amount: ${loanPerPool} USDC`);

    // ── Step 2: Create pool if needed ─────────────────────────────────────────
    console.log('\n─── Step 2: Create Alice pool (if needed) ───');
    if (!poolBefore.isActive) {
        console.log('  Calling createAgentPool()...');
        const tx = await safeCall(() => mkt.connect(aliceW).createAgentPool(), 'createPool');
        await tx.wait();
        await sleep(1500);
        console.log('  Pool created ✓');
    } else {
        console.log('  Alice pool already active ✓');
    }

    // ── Step 3: Lenders supply to Alice's pool ────────────────────────────────
    console.log('\n─── Step 3: Bob + Carol supply liquidity ───');

    // Bob supplies 100 USDC (1 share unit)
    const BOB_SUPPLY   = 100n * 1_000_000n;
    // Carol supplies 300 USDC (3 share units → should earn 3x interest)
    const CAROL_SUPPLY = 300n * 1_000_000n;

    for (const [name, wallet, supply] of [
        ['Bob',   bobW,   BOB_SUPPLY],
        ['Carol', carolW, CAROL_SUPPLY],
    ]) {
        const bal = await safeCall(() => usdc.balanceOf(wallet.address), `bal ${name}`);
        await sleep(300);

        if (bal < supply) {
            const needed = supply - bal;
            console.log(`  Minting ${Number(needed)/1e6} USDC for ${name}...`);
            await (await safeCall(() => usdc.connect(deployer).mint(wallet.address, needed), `mint ${name}`)).wait();
            await sleep(1200);
        }

        console.log(`  ${name} approving ${Number(supply)/1e6} USDC...`);
        await (await safeCall(() => usdc.connect(wallet).approve(MKT_ADDR, supply), `approve ${name}`)).wait();
        await sleep(1200);

        console.log(`  ${name} supplying ${Number(supply)/1e6} USDC to pool #${ALICE_ID}...`);
        await (await safeCall(() => mkt.connect(wallet).supplyLiquidity(ALICE_ID, supply), `supply ${name}`)).wait();
        await sleep(1500);
        console.log(`  ${name}: supplied ✓`);
    }

    // ── Step 4: Snapshot lender positions ─────────────────────────────────────
    console.log('\n─── Step 4: Lender positions after supply ───');
    const bobPos0   = await safeCall(() => mkt.getLenderPosition(ALICE_ID, bobW.address), 'bobPos');
    await sleep(400);
    const carolPos0 = await safeCall(() => mkt.getLenderPosition(ALICE_ID, carolW.address), 'carolPos');
    await sleep(400);
    console.log(`  Bob:   ${Number(bobPos0.amount)/1e6} USDC, share=${Number(bobPos0.shareOfPool)/100}%`);
    console.log(`  Carol: ${Number(carolPos0.amount)/1e6} USDC, share=${Number(carolPos0.shareOfPool)/100}%`);

    // ── Step 5: Alice requests loan ───────────────────────────────────────────
    console.log('\n─── Step 5: Alice requests loan ───');
    const loanAmtRaw = BigInt(loanPerPool * 1_000_000);

    const aliceBal = await safeCall(() => usdc.balanceOf(aliceW.address), 'aliceBal');
    await sleep(400);
    console.log(`  Alice USDC balance: ${Number(aliceBal)/1e6} USDC`);

    // Approve collateral (contract pulls up to 100% of loan as collateral for low-score agents)
    const collateralApproval = loanAmtRaw * 2n; // 2x buffer
    console.log(`  Alice approving ${Number(collateralApproval)/1e6} USDC for collateral...`);
    await (await safeCall(() => usdc.connect(aliceW).approve(MKT_ADDR, collateralApproval), 'approve collateral')).wait();
    await sleep(1200);

    console.log(`  Requesting ${loanPerPool} USDC loan for 7 days...`);
    const loanTx = await safeCall(
        () => mkt.connect(aliceW).requestLoan(loanAmtRaw, 7n),
        'requestLoan'
    );
    const loanReceipt = await loanTx.wait();
    await sleep(1500);

    let loanId = null;
    for (const log of loanReceipt.logs) {
        try {
            const parsed = iface.parseLog(log);
            if (parsed?.name === 'LoanRequested') {
                loanId = Number(parsed.args[0]);
                console.log(`  Loan #${loanId} created (pool #${Number(parsed.args[1])}) ✓`);
            }
        } catch {}
    }

    if (loanId === null) {
        throw new Error('Could not parse LoanRequested event');
    }

    // ── Step 6: Read loan details ─────────────────────────────────────────────
    console.log('\n─── Step 6: Loan details ───');
    const loan = await safeCall(() => mkt.loans(loanId), `loans(${loanId})`);
    await sleep(400);
    console.log(`  Loan #${loanId}: ${Number(loan.amount)/1e6} USDC @ ${Number(loan.interestRate)} bps APR`);
    console.log(`  State: ${LOAN_STATES[Number(loan.state)]}`);

    // ── Step 7: Fund Alice for repayment ──────────────────────────────────────
    console.log('\n─── Step 7: Fund Alice for repayment ───');
    const repayBuffer = loanAmtRaw * 2n;
    const aliceBal2  = await safeCall(() => usdc.balanceOf(aliceW.address), 'aliceBal2');
    await sleep(400);

    if (aliceBal2 < repayBuffer) {
        const needed = repayBuffer - aliceBal2;
        console.log(`  Minting ${Number(needed)/1e6} USDC for Alice...`);
        await (await safeCall(() => usdc.connect(deployer).mint(aliceW.address, needed), 'mint Alice')).wait();
        await sleep(1200);
    }

    const aliceBal3 = await safeCall(() => usdc.balanceOf(aliceW.address), 'aliceBal3');
    await sleep(400);
    console.log(`  Approving ${Number(aliceBal3)/1e6} USDC for repayment...`);
    await (await safeCall(() => usdc.connect(aliceW).approve(MKT_ADDR, aliceBal3), 'approve repay')).wait();
    await sleep(1200);

    // ── Step 8: Alice repays loan ─────────────────────────────────────────────
    console.log('\n─── Step 8: Alice repays loan ───');
    const repayTx = await safeCall(() => mkt.connect(aliceW).repayLoan(loanId), 'repayLoan');
    const repayReceipt = await repayTx.wait();
    await sleep(2000);

    let interestPaid = 0n;
    for (const log of repayReceipt.logs) {
        try {
            const parsed = iface.parseLog(log);
            if (parsed?.name === 'LoanRepaid') {
                console.log(`  Loan #${loanId} repaid: principal=${Number(parsed.args[1])/1e6} USDC, interest=${Number(parsed.args[2])/1e6} USDC ✓`);
                interestPaid = parsed.args[2];
            }
            if (parsed?.name === 'InterestDistributed') {
                console.log(`  Interest distributed to pool #${Number(parsed.args[0])}: ${Number(parsed.args[1])/1e6} USDC`);
            }
        } catch {}
    }

    // ── Step 9: Lenders claim interest ────────────────────────────────────────
    console.log('\n─── Step 9: Lenders claim interest ───');
    const bobBalBefore   = await safeCall(() => usdc.balanceOf(bobW.address), 'bobBal');
    await sleep(300);
    const carolBalBefore = await safeCall(() => usdc.balanceOf(carolW.address), 'carolBal');
    await sleep(300);

    for (const [name, wallet] of [['Bob', bobW], ['Carol', carolW]]) {
        const pos = await safeCall(() => mkt.getLenderPosition(ALICE_ID, wallet.address), `pos ${name}`);
        await sleep(300);
        console.log(`  ${name} earned (on-chain): ${Number(pos.earnedInterest)/1e6} USDC`);

        if (pos.earnedInterest > 0n) {
            const claimTx = await safeCall(() => mkt.connect(wallet).claimInterest(ALICE_ID), `claimInterest ${name}`);
            await claimTx.wait();
            await sleep(1200);
            console.log(`  ${name}: interest claimed ✓`);
        }
    }

    // ── Step 10: Final balances ───────────────────────────────────────────────
    console.log('\n─── Step 10: Final balances ───');
    const bobBalAfter   = await safeCall(() => usdc.balanceOf(bobW.address), 'bobBalAfter');
    await sleep(300);
    const carolBalAfter = await safeCall(() => usdc.balanceOf(carolW.address), 'carolBalAfter');
    await sleep(300);

    const bobEarned   = bobBalAfter - bobBalBefore;
    const carolEarned = carolBalAfter - carolBalBefore;

    // ── Final Summary ─────────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(60));
    console.log('  MULTI-LENDER PRO-RATA RESULTS');
    console.log('='.repeat(60));
    console.log(`  Bob   supplied:  100 USDC (25% of pool)`);
    console.log(`  Carol supplied:  300 USDC (75% of pool)`);
    console.log(`  Total interest paid by Alice: ${Number(interestPaid)/1e6} USDC`);
    console.log('');
    console.log(`  Bob   earned: ${Number(bobEarned)/1e6} USDC`);
    console.log(`  Carol earned: ${Number(carolEarned)/1e6} USDC`);

    if (carolEarned > 0n && bobEarned > 0n) {
        const ratio = Number(carolEarned) / Number(bobEarned);
        console.log(`  Carol/Bob ratio: ${ratio.toFixed(2)}x (expected ~3.0x)`);
        const proRataCorrect = Math.abs(ratio - 3.0) < 0.5;
        console.log(`\n  Pro-rata verified: ${proRataCorrect ? 'YES ✓' : 'NO ✗ (ratio off)'}`);
        console.log(`  Test result: ${(carolEarned > bobEarned) ? 'PASSED ✓' : 'FAILED ✗'}`);
    } else if (carolEarned > 0n || bobEarned > 0n) {
        console.log('\n  Partial: only one lender earned (check claimInterest)');
    } else {
        // Check on-chain positions before claiming (interest may be tiny)
        console.log('\n  No balance change — checking on-chain positions...');
        const bobPos   = await safeCall(() => mkt.getLenderPosition(ALICE_ID, bobW.address), 'bobPos');
        await sleep(300);
        const carolPos = await safeCall(() => mkt.getLenderPosition(ALICE_ID, carolW.address), 'carolPos');
        await sleep(300);
        console.log(`  Bob earned (pos):   ${Number(bobPos.earnedInterest)/1e6} USDC`);
        console.log(`  Carol earned (pos): ${Number(carolPos.earnedInterest)/1e6} USDC`);
    }
    console.log('='.repeat(60));
}

main().catch(err => {
    console.error('\nFatal:', err.message);
    if (err.info) console.error('Info:', JSON.stringify(err.info, null, 2).slice(0, 300));
    process.exit(1);
});
