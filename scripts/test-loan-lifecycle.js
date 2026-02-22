/**
 * Test Loan Lifecycle on Base Sepolia
 *
 * Tests loan request → repayment flow and measures gas costs
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://sepolia.base.org';
const AGENT_KEY = process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000';
const LOAN_AMOUNT = 100; // 100 USDC
const DURATION_DAYS = 7;

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║    TEST LOAN LIFECYCLE ON BASE SEPOLIA          ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const agent = new ethers.Wallet(AGENT_KEY, provider);

    console.log(`🔑 Agent: ${agent.address}\n`);

    // Load addresses
    const addresses = JSON.parse(
        fs.readFileSync('./src/config/base-sepolia-addresses.json', 'utf8')
    );

    // Load ABIs
    const marketplaceAbi = JSON.parse(
        fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json', 'utf8')
    ).abi;

    const marketplace = new ethers.Contract(addresses.AgentLiquidityMarketplace, marketplaceAbi, agent);

    // Get gas price
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice;
    const gasPriceGwei = parseFloat(ethers.formatUnits(gasPrice, 'gwei'));

    console.log(`⛽ Gas Price: ${gasPriceGwei.toFixed(4)} Gwei\n`);

    const gasStats = {
        operations: [],
        totalGas: 0,
        totalCostEth: 0
    };

    function recordGas(operation, receipt) {
        const gasUsed = Number(receipt.gasUsed);
        const costWei = gasUsed * Number(gasPrice);
        const costEth = parseFloat(ethers.formatEther(costWei));
        const costUsd = costEth * 2500; // Assume $2500 ETH

        gasStats.operations.push({ operation, gasUsed, costEth, costUsd });
        gasStats.totalGas += gasUsed;
        gasStats.totalCostEth += costEth;

        console.log(`   ✅ ${operation}`);
        console.log(`      Gas: ${gasUsed.toLocaleString()}`);
        console.log(`      Cost: ${costEth.toFixed(6)} ETH ($${costUsd.toFixed(4)})\n`);
    }

    // ========================================================================
    // STEP 1: REQUEST LOAN
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('STEP 1: REQUEST LOAN');
    console.log('═'.repeat(70) + '\n');

    console.log(`💰 Requesting ${LOAN_AMOUNT} USDC loan for ${DURATION_DAYS} days...\n`);

    const nonce = await provider.getTransactionCount(agent.address);
    const adjustedGasPrice = gasPrice * 120n / 100n;

    const tx1 = await marketplace.requestLoan(
        ethers.parseUnits(LOAN_AMOUNT.toString(), 6),
        DURATION_DAYS,
        { gasPrice: adjustedGasPrice, nonce }
    );

    console.log(`📋 Tx sent: ${tx1.hash}`);
    console.log(`⏳ Waiting for confirmation...\n`);

    const receipt1 = await tx1.wait();
    recordGas('Loan Request', receipt1);

    // Extract loan ID from events
    let loanId;
    for (const log of receipt1.logs) {
        try {
            const parsed = marketplace.interface.parseLog({ topics: log.topics, data: log.data });
            if (parsed && parsed.name === 'LoanRequested') {
                loanId = Number(parsed.args.loanId);
                break;
            }
        } catch {}
    }

    console.log(`   📋 Loan ID: ${loanId}\n`);

    // ========================================================================
    // STEP 2: REPAY LOAN
    // ========================================================================

    if (loanId !== undefined) {
        console.log('═'.repeat(70));
        console.log('STEP 2: REPAY LOAN');
        console.log('═'.repeat(70) + '\n');

        console.log(`💸 Repaying loan #${loanId}...\n`);

        const nonce2 = await provider.getTransactionCount(agent.address);
        const tx2 = await marketplace.repayLoan(loanId, { gasPrice: adjustedGasPrice, nonce: nonce2 });

        console.log(`📋 Tx sent: ${tx2.hash}`);
        console.log(`⏳ Waiting for confirmation...\n`);

        const receipt2 = await tx2.wait();
        recordGas('Loan Repayment', receipt2);
    }

    // ========================================================================
    // GAS ANALYSIS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('GAS COST ANALYSIS');
    console.log('═'.repeat(70) + '\n');

    console.log('📊 Operation Breakdown:\n');

    gasStats.operations.forEach((op, i) => {
        console.log(`   ${i + 1}. ${op.operation}`);
        console.log(`      Gas: ${op.gasUsed.toLocaleString()}`);
        console.log(`      Cost: ${op.costEth.toFixed(6)} ETH ($${op.costUsd.toFixed(4)})\n`);
    });

    console.log('═'.repeat(70));
    console.log('SUMMARY');
    console.log('═'.repeat(70) + '\n');

    const totalCostUsd = gasStats.totalCostEth * 2500;

    console.log(`⛽ Gas Price: ${gasPriceGwei.toFixed(4)} Gwei\n`);

    console.log(`💰 Loan Lifecycle Cost:\\n`);
    console.log(`   Total Gas:    ${gasStats.totalGas.toLocaleString()}`);
    console.log(`   Total Cost:   ${gasStats.totalCostEth.toFixed(6)} ETH`);
    console.log(`   USD Cost:     $${totalCostUsd.toFixed(4)}\n`);

    console.log(`📉 Comparison vs Arc Testnet:\\n`);
    console.log(`   Arc Cost:     $13.98 @ 20 Gwei (request + repay only)`);
    console.log(`   Base Cost:    $${totalCostUsd.toFixed(4)} @ ${gasPriceGwei.toFixed(2)} Gwei`);
    const savings = ((13.98 - totalCostUsd) / 13.98 * 100);
    const savingsMultiple = (13.98 / totalCostUsd);
    console.log(`   Savings:      $${(13.98 - totalCostUsd).toFixed(4)} (${savings.toFixed(1)}%)`);
    console.log(`   Cost Reduction: ${savingsMultiple.toFixed(1)}x cheaper!\n`);

    console.log(`💡 Economic Impact:\\n`);
    console.log(`   For $${LOAN_AMOUNT} loan @ 15% APR for ${DURATION_DAYS} days:`);
    const interest = (LOAN_AMOUNT * 0.15 * DURATION_DAYS / 365);
    console.log(`      Interest:     $${interest.toFixed(4)}`);
    console.log(`      Gas (Arc):    $13.98 (${(13.98 / interest).toFixed(1)}x interest)`);
    console.log(`      Gas (Base):   $${totalCostUsd.toFixed(4)} (${(totalCostUsd / interest).toFixed(2)}x interest)`);
    console.log(`      Improvement:  ${((13.98 / interest - totalCostUsd / interest) / (13.98 / interest) * 100).toFixed(1)}% better!\\n`);

    console.log('═'.repeat(70));
    console.log('✅ BASE SEPOLIA TEST COMPLETE');
    console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
