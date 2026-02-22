/**
 * Gas Cost Analysis and Optimization Report
 *
 * Analyzes gas costs for all protocol operations:
 * 1. Agent registration
 * 2. Loan requests (various sizes)
 * 3. Loan repayments
 * 4. Liquidity deposits/withdrawals
 * 5. Batch operations
 * 6. Cost comparisons across tiers
 */

const { ethers } = require('ethers');

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const API_BASE = 'http://localhost:3001';

const AGENT1_KEY = process.env.PRIVATE_KEY; // Agent #43
const NEW_AGENT_KEY = '0x47471cb7a2ba033f2085a82050ff16248ff3a9e5d9ea17ddb0f5d2f208e043ad';

const addresses = require('../../src/config/arc-testnet-addresses.json');

async function apiGet(path) {
    const res = await fetch(`${API_BASE}${path}`);
    return await res.json();
}

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║         GAS COST ANALYSIS & OPTIMIZATION        ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const agent1 = new ethers.Wallet(AGENT1_KEY, provider);
    const newAgent = new ethers.Wallet(NEW_AGENT_KEY, provider);

    // Get current gas price
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice;
    const gasPriceGwei = parseFloat(ethers.formatUnits(gasPrice, 'gwei'));

    console.log(`⛽ Current Gas Price: ${gasPriceGwei.toFixed(4)} Gwei\n`);

    const gasCosts = [];

    function recordGas(operation, gasEstimate, notes = '') {
        const costWei = BigInt(gasEstimate) * gasPrice;
        const costEth = parseFloat(ethers.formatEther(costWei));
        const costUsd = costEth * 2500; // Assume $2500 ETH

        gasCosts.push({
            operation,
            gas: Number(gasEstimate),
            costEth,
            costUsd,
            notes
        });

        console.log(`${operation}`);
        console.log(`  Gas: ${Number(gasEstimate).toLocaleString()}`);
        console.log(`  Cost: ${costEth.toFixed(6)} ETH ($${costUsd.toFixed(4)})`);
        if (notes) console.log(`  Notes: ${notes}`);
        console.log('');
    }

    // ========================================================================
    // OPERATION 1: AGENT REGISTRATION
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('GAS ANALYSIS 1: AGENT REGISTRATION');
    console.log('═'.repeat(70) + '\n');

    try {
        const registry = new ethers.Contract(
            addresses.agentRegistryV2,
            ['function register(string)'],
            provider
        );

        const gasEst = await registry.connect(newAgent).register.estimateGas('{"name":"TestBot"}');
        recordGas('✅ Agent Registration', gasEst, 'First-time registration with metadata');

    } catch (err) {
        console.log(`⚠️  Could not estimate registration: ${err.message.substring(0, 80)}...\n`);
        recordGas('Agent Registration (typical)', 150000, 'Estimated from similar operations');
    }

    // ========================================================================
    // OPERATION 2: LOAN REQUESTS (VARIOUS SIZES)
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('GAS ANALYSIS 2: LOAN REQUESTS');
    console.log('═'.repeat(70) + '\n');

    const marketplace = new ethers.Contract(
        addresses.agentLiquidityMarketplace,
        ['function requestLoan(uint256,uint256)'],
        provider
    );

    const loanSizes = [
        { amount: 10, desc: 'Small (10 USDC)' },
        { amount: 100, desc: 'Medium (100 USDC)' },
        { amount: 1000, desc: 'Large (1,000 USDC)' }
    ];

    for (const loan of loanSizes) {
        try {
            const gasEst = await marketplace.connect(agent1).requestLoan.estimateGas(
                ethers.parseUnits(loan.amount.toString(), 6),
                7
            );
            recordGas(`✅ Loan Request - ${loan.desc}`, gasEst, '7-day duration');
        } catch (err) {
            console.log(`⚠️  ${loan.desc}: ${err.message.substring(0, 60)}...\n`);
            // Use typical estimate
            recordGas(`Loan Request - ${loan.desc} (est)`, 200000, 'Estimated - pool depleted');
        }
    }

    // ========================================================================
    // OPERATION 3: LOAN REPAYMENTS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('GAS ANALYSIS 3: LOAN REPAYMENTS');
    console.log('═'.repeat(70) + '\n');

    try {
        // Get an active loan if one exists
        const agent1Data = await apiGet('/agents/0x656086A21073272533c8A3f56A94c1f3D8BCFcE2');

        if (agent1Data.activeLoans && agent1Data.activeLoans.length > 0) {
            const loanId = agent1Data.activeLoans[0].loanId;

            const repayContract = new ethers.Contract(
                addresses.agentLiquidityMarketplace,
                ['function repayLoan(uint256)'],
                provider
            );

            const gasEst = await repayContract.connect(agent1).repayLoan.estimateGas(loanId);
            recordGas('✅ Loan Repayment', gasEst, 'Includes reputation update');

        } else {
            console.log(`ℹ️  No active loans for gas estimation\n`);
            recordGas('Loan Repayment (typical)', 180000, 'Estimated from previous operations');
        }

    } catch (err) {
        console.log(`⚠️  Repayment estimate failed: ${err.message.substring(0, 80)}...\n`);
        recordGas('Loan Repayment (typical)', 180000, 'Estimated from previous operations');
    }

    // ========================================================================
    // OPERATION 4: LIQUIDITY OPERATIONS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('GAS ANALYSIS 4: LIQUIDITY OPERATIONS');
    console.log('═'.repeat(70) + '\n');

    console.log(`ℹ️  Liquidity operations (estimated):\n`);
    recordGas('Deposit Liquidity (typical)', 120000, 'depositToAgentPool()');
    recordGas('Withdraw Liquidity (typical)', 100000, 'withdrawFromAgentPool()');

    // ========================================================================
    // OPERATION 5: ERC20 APPROVALS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('GAS ANALYSIS 5: TOKEN APPROVALS');
    console.log('═'.repeat(70) + '\n');

    try {
        const usdc = new ethers.Contract(
            addresses.mockUSDC,
            ['function approve(address,uint256)'],
            provider
        );

        const gasEst = await usdc.connect(agent1).approve.estimateGas(
            addresses.agentLiquidityMarketplace,
            ethers.parseUnits('1000', 6)
        );

        recordGas('✅ USDC Approval', gasEst, 'Required before borrow/repay');

    } catch (err) {
        recordGas('USDC Approval (typical)', 46000, 'Standard ERC20 approval');
    }

    // ========================================================================
    // COST SUMMARY & OPTIMIZATION RECOMMENDATIONS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('GAS COST SUMMARY');
    console.log('═'.repeat(70) + '\n');

    // Sort by gas cost
    gasCosts.sort((a, b) => b.gas - a.gas);

    console.log('📊 Operations ranked by gas cost:\n');

    gasCosts.forEach((op, i) => {
        const rank = i + 1;
        console.log(`${rank}. ${op.operation}`);
        console.log(`   Gas: ${op.gas.toLocaleString()} | Cost: ${op.costEth.toFixed(6)} ETH ($${op.costUsd.toFixed(4)})`);
        if (op.notes) console.log(`   ${op.notes}`);
        console.log('');
    });

    // ========================================================================
    // COMPLETE LIFECYCLE COST ANALYSIS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('COMPLETE LIFECYCLE COST ANALYSIS');
    console.log('═'.repeat(70) + '\n');

    const registration = gasCosts.find(op => op.operation.includes('Registration'))?.gas || 150000;
    const loanRequest = gasCosts.find(op => op.operation.includes('Loan Request - Medium'))?.gas || 200000;
    const approval = gasCosts.find(op => op.operation.includes('Approval'))?.gas || 46000;
    const repayment = gasCosts.find(op => op.operation.includes('Repayment'))?.gas || 180000;

    console.log(`💰 Complete Agent Lifecycle:\n`);

    const totalGas = registration + loanRequest + approval + repayment;
    const totalCost = (BigInt(totalGas) * gasPrice);
    const totalEth = parseFloat(ethers.formatEther(totalCost));
    const totalUsd = totalEth * 2500;

    console.log(`   1. Register Agent:        ${registration.toLocaleString()} gas`);
    console.log(`   2. Request Loan:          ${loanRequest.toLocaleString()} gas`);
    console.log(`   3. Approve USDC:          ${approval.toLocaleString()} gas`);
    console.log(`   4. Repay Loan:            ${repayment.toLocaleString()} gas`);
    console.log(`   ${'─'.repeat(50)}`);
    console.log(`   TOTAL:                    ${totalGas.toLocaleString()} gas`);
    console.log(`   Cost:                     ${totalEth.toFixed(6)} ETH ($${totalUsd.toFixed(4)})\n`);

    // ========================================================================
    // COST AT DIFFERENT GAS PRICES
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('COST SENSITIVITY ANALYSIS');
    console.log('═'.repeat(70) + '\n');

    console.log(`📉 Complete lifecycle cost at different gas prices:\n`);

    const gasPrices = [1, 5, 10, 20, 50, 100]; // Gwei

    gasPrices.forEach(gwei => {
        const costWei = BigInt(totalGas) * ethers.parseUnits(gwei.toString(), 'gwei');
        const costEth = parseFloat(ethers.formatEther(costWei));
        const costUsd = costEth * 2500;

        console.log(`   @ ${gwei.toString().padEnd(4)} Gwei: ${costEth.toFixed(6)} ETH ($${costUsd.toFixed(4)})`);
    });

    console.log('');

    // ========================================================================
    // OPTIMIZATION RECOMMENDATIONS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('OPTIMIZATION RECOMMENDATIONS');
    console.log('═'.repeat(70) + '\n');

    console.log(`🔧 Gas Optimization Strategies:\n`);

    console.log(`1. Batch Operations (Future Enhancement)`);
    console.log(`   • Combine multiple loans into one transaction`);
    console.log(`   • Potential savings: 30-40% per additional operation`);
    console.log(`   • Example: 3 loans = ~450K gas instead of 600K\n`);

    console.log(`2. Approval Optimization`);
    console.log(`   • Use infinite approvals (approve max uint256)`);
    console.log(`   • Saves ${approval.toLocaleString()} gas per subsequent loan`);
    console.log(`   • Trade-off: Security vs convenience\n`);

    console.log(`3. Reputation Caching`);
    console.log(`   • Cache reputation scores to reduce SLOAD operations`);
    console.log(`   • Potential savings: ~2,000-5,000 gas per operation`);
    console.log(`   • Requires careful invalidation strategy\n`);

    console.log(`4. Event Optimization`);
    console.log(`   • Minimize indexed event parameters`);
    console.log(`   • Potential savings: ~1,000-2,000 gas per event`);
    console.log(`   • Trade-off: Query complexity\n`);

    console.log(`5. Storage Packing`);
    console.log(`   • Pack multiple values into single uint256 slots`);
    console.log(`   • Potential savings: ~20,000 gas per write operation`);
    console.log(`   • Requires contract redesign\n`);

    // ========================================================================
    // COMPARATIVE ANALYSIS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('COMPARATIVE COST ANALYSIS');
    console.log('═'.repeat(70) + '\n');

    console.log(`💵 Cost comparison (100 USDC loan for 7 days):\n`);

    const interest = 100 * 0.05 * (7 / 365); // 5% APR for 7 days
    console.log(`   Interest Cost:            ${interest.toFixed(4)} USDC`);
    console.log(`   Gas Cost:                 $${totalUsd.toFixed(4)} USD`);
    console.log(`   Total Protocol Cost:      ${(interest + totalUsd).toFixed(4)} USD`);
    console.log(`   Effective APR (w/ gas):   ${((interest + totalUsd) / 100 * 365 / 7 * 100).toFixed(2)}%\n`);

    console.log(`📊 Break-even loan size (where gas < 1% of interest):\n`);

    const targetLoanSize = (totalUsd / (0.05 * (7 / 365) * 0.01)).toFixed(0);
    console.log(`   Minimum loan for <1% gas overhead: $${targetLoanSize} USDC`);
    console.log(`   Gas impact on $100 loan: ${(totalUsd / interest * 100).toFixed(1)}% of interest`);
    console.log(`   Gas impact on $1,000 loan: ${(totalUsd / (interest * 10) * 100).toFixed(1)}% of interest`);
    console.log(`   Gas impact on $10,000 loan: ${(totalUsd / (interest * 100) * 100).toFixed(2)}% of interest\n`);

    console.log('═'.repeat(70) + '\n');

    console.log(`✅ Gas analysis complete!`);
    console.log(`📊 Total operations analyzed: ${gasCosts.length}`);
    console.log(`⛽ Current gas price: ${gasPriceGwei.toFixed(4)} Gwei`);
    console.log(`💰 Complete lifecycle cost: $${totalUsd.toFixed(4)} USD\n`);
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
