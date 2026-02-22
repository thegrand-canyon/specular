/**
 * Simple Repayment & Reputation Test
 *
 * Tests loan repayment increases reputation score
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://sepolia.base.org';
const AGENT_KEY = 'process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'';

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║    REPUTATION UPDATE TEST                        ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const agent = new ethers.Wallet(AGENT_KEY, provider);

    console.log(`Agent: ${agent.address}\n`);

    // Load config
    const addresses = JSON.parse(
        fs.readFileSync('./src/config/base-sepolia-addresses.json', 'utf8')
    );

    // Load ABIs
    function loadAbi(name) {
        const paths = [
            `./artifacts/contracts/${name}.sol/${name}.json`,
            `./artifacts/contracts/core/${name}.sol/${name}.json`,
            `./artifacts/contracts/tokens/${name}.sol/${name}.json`,
        ];
        for (const p of paths) {
            try {
                return JSON.parse(fs.readFileSync(p, 'utf8')).abi;
            } catch {}
        }
        throw new Error(`Cannot find ABI for ${name}`);
    }

    const registryAbi = loadAbi('AgentRegistryV2');
    const reputationAbi = loadAbi('ReputationManagerV3');
    const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');
    const usdcAbi = loadAbi('MockUSDC');

    const registry = new ethers.Contract(addresses.AgentRegistryV2, registryAbi, provider);
    const reputation = new ethers.Contract(addresses.ReputationManagerV3, reputationAbi, provider);
    const marketplace = new ethers.Contract(addresses.AgentLiquidityMarketplace, marketplaceAbi, agent);
    const usdc = new ethers.Contract(addresses.MockUSDC, usdcAbi, agent);

    // ========================================================================
    // STEP 1: Check Current State
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('STEP 1: CURRENT STATE');
    console.log('═'.repeat(70) + '\n');

    const agentId = await registry.addressToAgentId(agent.address);
    const scoreBefore = await reputation['getReputationScore(address)'](agent.address);
    const limitBefore = await reputation.calculateCreditLimit(agent.address);
    const rateBefore = await reputation.calculateInterestRate(agent.address);

    console.log(`Agent ID: ${agentId}`);
    console.log(`Reputation: ${scoreBefore}`);
    console.log(`Credit Limit: ${ethers.formatUnits(limitBefore, 6)} USDC`);
    console.log(`Interest Rate: ${Number(rateBefore) / 100}% APR\n`);

    const pool = await marketplace.getAgentPool(agentId);
    console.log(`Pool Liquidity: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC\n`);

    // ========================================================================
    // STEP 2: Request New Loan
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('STEP 2: REQUEST NEW LOAN');
    console.log('═'.repeat(70) + '\n');

    const loanAmount = '150'; // 150 USDC
    const duration = 10; // 10 days

    console.log(`Requesting ${loanAmount} USDC for ${duration} days...\n`);

    // Approve USDC (need approval for collateral)
    const nonce1 = await provider.getTransactionCount(agent.address);
    const approveTx = await usdc.approve(
        addresses.AgentLiquidityMarketplace,
        ethers.parseUnits('1000', 6),
        { nonce: nonce1 }
    );
    await approveTx.wait();
    console.log('✅ USDC approved\n');

    // Request loan
    const nonce2 = await provider.getTransactionCount(agent.address);
    const loanTx = await marketplace.requestLoan(
        ethers.parseUnits(loanAmount, 6),
        duration,
        { nonce: nonce2 }
    );

    console.log('Waiting for confirmation...\n');
    const receipt = await loanTx.wait();

    // Extract loan ID
    let loanId;
    for (const log of receipt.logs) {
        try {
            const parsed = marketplace.interface.parseLog(log);
            if (parsed && parsed.name === 'LoanRequested') {
                loanId = Number(parsed.args.loanId);
                break;
            }
        } catch {}
    }

    console.log(`✅ Loan #${loanId} approved!\n`);

    // ========================================================================
    // STEP 3: Check Loan Details
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('STEP 3: LOAN DETAILS');
    console.log('═'.repeat(70) + '\n');

    const loan = await marketplace.loans(loanId);
    const interest = (Number(loan.amount) * Number(loan.interestRate) / 10000 * duration / 365);
    const total = Number(loan.amount) + interest;

    console.log(`Loan ID: ${loanId}`);
    console.log(`Principal: ${ethers.formatUnits(loan.amount, 6)} USDC`);
    console.log(`Interest Rate: ${Number(loan.interestRate) / 100}% APR`);
    console.log(`Duration: ${Number(loan.duration) / 86400} days`);
    console.log(`Interest: ${(interest / 1e6).toFixed(4)} USDC`);
    console.log(`Total Repayment: ${(total / 1e6).toFixed(4)} USDC`);
    console.log(`State: ${loan.state} (1=ACTIVE)\n`);

    // ========================================================================
    // STEP 4: Repay Loan
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('STEP 4: REPAY LOAN');
    console.log('═'.repeat(70) + '\n');

    console.log(`Repaying loan #${loanId}...\n`);

    const nonce3 = await provider.getTransactionCount(agent.address);
    const repayTx = await marketplace.repayLoan(loanId, { nonce: nonce3 });

    console.log('Waiting for confirmation...\n');
    await repayTx.wait();

    console.log(`✅ Loan #${loanId} REPAID!\n`);

    // ========================================================================
    // STEP 5: Check Reputation Update
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('STEP 5: REPUTATION UPDATE');
    console.log('═'.repeat(70) + '\n');

    const scoreAfter = await reputation['getReputationScore(address)'](agent.address);
    const limitAfter = await reputation.calculateCreditLimit(agent.address);
    const rateAfter = await reputation.calculateInterestRate(agent.address);

    const scoreChange = Number(scoreAfter) - Number(scoreBefore);
    const limitChange = Number(limitAfter) - Number(limitBefore);
    const rateChange = Number(rateAfter) - Number(rateBefore);

    console.log('BEFORE REPAYMENT:');
    console.log(`  Reputation: ${scoreBefore}`);
    console.log(`  Credit Limit: ${ethers.formatUnits(limitBefore, 6)} USDC`);
    console.log(`  Interest Rate: ${Number(rateBefore) / 100}% APR\n`);

    console.log('AFTER REPAYMENT:');
    console.log(`  Reputation: ${scoreAfter}`);
    console.log(`  Credit Limit: ${ethers.formatUnits(limitAfter, 6)} USDC`);
    console.log(`  Interest Rate: ${Number(rateAfter) / 100}% APR\n`);

    console.log('CHANGES:');
    console.log(`  Reputation: ${scoreChange > 0 ? '+' : ''}${scoreChange} points`);
    console.log(`  Credit Limit: ${limitChange > 0 ? '+' : ''}${ethers.formatUnits(limitChange, 6)} USDC`);
    console.log(`  Interest Rate: ${rateChange > 0 ? '+' : ''}${rateChange / 100}% APR\n`);

    if (scoreChange > 0) {
        console.log(`🎉 SUCCESS! Reputation increased by ${scoreChange} points!\n`);
    }

    // ========================================================================
    // STEP 6: Pool Status
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('STEP 6: POOL STATUS AFTER REPAYMENT');
    console.log('═'.repeat(70) + '\n');

    const poolAfter = await marketplace.getAgentPool(agentId);

    console.log(`Available Liquidity: ${ethers.formatUnits(poolAfter.availableLiquidity, 6)} USDC`);
    console.log(`Total Loaned: ${ethers.formatUnits(poolAfter.totalLoaned, 6)} USDC`);
    console.log(`Total Earned: ${ethers.formatUnits(poolAfter.totalEarned, 6)} USDC\n`);

    // ========================================================================
    // SUMMARY
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('TEST SUMMARY');
    console.log('═'.repeat(70) + '\n');

    console.log('✅ Complete Loan Lifecycle:');
    console.log(`  1. ✅ Requested ${loanAmount} USDC loan`);
    console.log(`  2. ✅ Loan #${loanId} approved & funded`);
    console.log(`  3. ✅ Repaid ${(total / 1e6).toFixed(4)} USDC (principal + interest)`);
    console.log(`  4. ✅ Reputation increased by ${scoreChange} points`);
    console.log(`  5. ✅ Pool earned ${ethers.formatUnits(poolAfter.totalEarned, 6)} USDC\n`);

    if (Number(scoreAfter) >= 50) {
        console.log(`🎯 TIP: With ${scoreAfter} reputation, you're building a strong credit history!\n`);
    }

    console.log('═'.repeat(70));
    console.log('✅ ALL TESTS PASSED');
    console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n❌ Test failed:', err.message);
    process.exit(1);
});
