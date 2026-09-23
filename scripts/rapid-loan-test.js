/**
 * Rapid Loan Testing - Maximum Throughput Test
 *
 * Processes as many loan cycles as possible:
 * 1. Request loan
 * 2. Repay immediately
 * 3. Repeat
 */

const { ethers } = require('ethers');
const fs = require('fs');

// Configuration
const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const CHAIN_ID = 5042002;
const LOAN_AMOUNT = process.env.LOAN_AMOUNT || '15'; // USDC
const DURATION_DAYS = process.env.DURATION_DAYS || 7;
const MAX_CYCLES = process.env.MAX_CYCLES || 100;
const CYCLE_DELAY = process.env.CYCLE_DELAY || 1000; // ms between cycles

// Load addresses
const addresses = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8'));

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

const mpAbi = loadAbi('AgentLiquidityMarketplace');
const registryAbi = loadAbi('AgentRegistryV2');
const rmAbi = loadAbi('ReputationManagerV3');
const usdcAbi = loadAbi('MockUSDC');

// Create provider and wallet
const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { batchMaxCount: 1 });
const privateKey = process.env.PRIVATE_KEY;
if (!privateKey) {
    console.error('❌ Error: PRIVATE_KEY environment variable required');
    process.exit(1);
}
const wallet = new ethers.Wallet(privateKey, provider);

// Contract instances
const registryAddress = addresses.agentRegistry || addresses.agentRegistryV2;
const reputationAddress = addresses.reputationManager || addresses.reputationManagerV3;
const usdcAddress = addresses.mockUSDC;

const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, mpAbi, wallet);
const registry = new ethers.Contract(registryAddress, registryAbi, wallet);
const reputationManager = new ethers.Contract(reputationAddress, rmAbi, wallet);
const usdc = new ethers.Contract(usdcAddress, usdcAbi, wallet);

// Metrics tracking
const metrics = {
    cycles: 0,
    loansRequested: 0,
    loansRepaid: 0,
    failures: 0,
    totalGasUsed: 0n,
    totalTime: 0,
    cycleTimings: [],
    errors: []
};

function log(message) {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    console.log(`[${timestamp}] ${message}`);
}

async function requestLoan(amount, duration) {
    const amountUSDC = ethers.parseUnits(amount.toString(), 6);

    log(`Requesting ${amount} USDC loan for ${duration} days...`);
    const tx = await marketplace.requestLoan(amountUSDC, duration);
    log(`TX sent: ${tx.hash}`);

    const receipt = await tx.wait();
    log(`✅ Loan requested in block ${receipt.blockNumber}`);

    // Extract loan ID from events
    const event = receipt.logs.find(log => {
        try {
            const parsed = marketplace.interface.parseLog(log);
            return parsed && parsed.name === 'LoanRequested';
        } catch {
            return false;
        }
    });

    if (event) {
        const parsed = marketplace.interface.parseLog(event);
        return { loanId: parsed.args.loanId, receipt };
    }

    throw new Error('Could not find LoanRequested event');
}

async function repayLoan(loanId) {
    log(`Repaying loan #${loanId}...`);

    // Get loan details to calculate repayment amount
    const loan = await marketplace.loans(loanId);

    // Calculate interest - ensure all BigInt operations
    const principal = BigInt(loan.principal);
    const interestRate = BigInt(loan.interestRate); // in basis points
    const interest = (principal * interestRate) / 10000n;
    const totalAmount = principal + interest;

    // Approve USDC (add 1% buffer for any rounding)
    const approveAmount = totalAmount + (totalAmount / 100n);
    log(`Approving ${ethers.formatUnits(approveAmount, 6)} USDC...`);
    const approveTx = await usdc.approve(addresses.agentLiquidityMarketplace, approveAmount);
    await approveTx.wait();

    // Repay loan
    const tx = await marketplace.repayLoan(loanId);
    log(`TX sent: ${tx.hash}`);

    const receipt = await tx.wait();
    log(`✅ Loan repaid in block ${receipt.blockNumber}`);

    return receipt;
}

async function performCycle(cycleNumber) {
    const cycleStart = Date.now();

    try {
        log(`\n${'='.repeat(60)}`);
        log(`CYCLE ${cycleNumber}/${MAX_CYCLES}`);
        log('='.repeat(60));

        // Request loan
        const { loanId, receipt: requestReceipt } = await requestLoan(LOAN_AMOUNT, DURATION_DAYS);
        metrics.loansRequested++;
        metrics.totalGasUsed += requestReceipt.gasUsed;

        log(`Loan ID: ${loanId}`);
        log(`Gas used for request: ${requestReceipt.gasUsed}`);

        // Small delay to let loan settle
        await new Promise(resolve => setTimeout(resolve, 500));

        // Repay loan immediately
        const repayReceipt = await repayLoan(loanId);
        metrics.loansRepaid++;
        metrics.totalGasUsed += repayReceipt.gasUsed;

        log(`Gas used for repayment: ${repayReceipt.gasUsed}`);

        const cycleTime = Date.now() - cycleStart;
        metrics.cycleTimings.push(cycleTime);

        log(`✅ Cycle completed in ${(cycleTime / 1000).toFixed(2)}s`);

        // Delay before next cycle
        if (CYCLE_DELAY > 0) {
            await new Promise(resolve => setTimeout(resolve, CYCLE_DELAY));
        }

        return true;

    } catch (error) {
        metrics.failures++;
        metrics.errors.push({
            cycle: cycleNumber,
            error: error.message,
            timestamp: new Date().toISOString()
        });

        log(`❌ Cycle failed: ${error.message}`);

        // Wait longer after failure
        await new Promise(resolve => setTimeout(resolve, 5000));

        return false;
    }
}

async function checkBalances() {
    log('\n📊 Checking initial balances...');

    const ethBalance = await provider.getBalance(wallet.address);
    const usdcBalance = await usdc.balanceOf(wallet.address);

    log(`Wallet: ${wallet.address}`);
    log(`ETH Balance: ${ethers.formatEther(ethBalance)}`);
    log(`USDC Balance: ${ethers.formatUnits(usdcBalance, 6)}`);

    // Check if registered
    const agentId = await registry.addressToAgentId(wallet.address);
    if (agentId === 0n) {
        log('❌ Agent not registered!');
        return false;
    }

    log(`Agent ID: ${agentId}`);

    // Check pool liquidity
    const pool = await marketplace.agentPools(agentId);
    log(`Pool Available Liquidity: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);

    const requiredLiquidity = parseFloat(LOAN_AMOUNT) * MAX_CYCLES;
    if (parseFloat(ethers.formatUnits(pool.availableLiquidity, 6)) < requiredLiquidity) {
        log(`⚠️  Warning: Pool may not have enough liquidity for ${MAX_CYCLES} cycles`);
    }

    // Check reputation
    const reputation = await reputationManager['getReputationScore(address)'](wallet.address);
    log(`Reputation Score: ${reputation}/1000`);

    return true;
}

async function printSummary() {
    console.log('\n' + '█'.repeat(80));
    console.log('RAPID LOAN TEST - FINAL SUMMARY');
    console.log('█'.repeat(80));
    console.log(`Total Cycles Attempted: ${metrics.cycles}`);
    console.log(`Loans Requested: ${metrics.loansRequested}`);
    console.log(`Loans Repaid: ${metrics.loansRepaid}`);
    console.log(`Failures: ${metrics.failures}`);
    console.log(`Success Rate: ${((metrics.loansRepaid / metrics.cycles) * 100).toFixed(1)}%`);
    console.log('');

    if (metrics.cycleTimings.length > 0) {
        const avgCycleTime = metrics.cycleTimings.reduce((a, b) => a + b, 0) / metrics.cycleTimings.length;
        const minCycleTime = Math.min(...metrics.cycleTimings);
        const maxCycleTime = Math.max(...metrics.cycleTimings);

        console.log('PERFORMANCE METRICS:');
        console.log(`  Average Cycle Time: ${(avgCycleTime / 1000).toFixed(2)}s`);
        console.log(`  Fastest Cycle: ${(minCycleTime / 1000).toFixed(2)}s`);
        console.log(`  Slowest Cycle: ${(maxCycleTime / 1000).toFixed(2)}s`);
        console.log(`  Loans Per Minute: ${((metrics.loansRepaid / (metrics.totalTime / 60000))).toFixed(2)}`);
        console.log('');
    }

    console.log('GAS METRICS:');
    console.log(`  Total Gas Used: ${metrics.totalGasUsed.toString()}`);
    console.log(`  Avg Gas Per Cycle: ${(Number(metrics.totalGasUsed) / metrics.loansRepaid).toFixed(0)}`);
    console.log('');

    if (metrics.errors.length > 0) {
        console.log('ERRORS:');
        metrics.errors.slice(0, 5).forEach((err, i) => {
            console.log(`  ${i + 1}. Cycle ${err.cycle}: ${err.error}`);
        });
        if (metrics.errors.length > 5) {
            console.log(`  ... and ${metrics.errors.length - 5} more errors`);
        }
        console.log('');
    }

    // Check final balances
    const usdcBalance = await usdc.balanceOf(wallet.address);
    const reputation = await reputationManager['getReputationScore(address)'](wallet.address);

    console.log('FINAL STATE:');
    console.log(`  USDC Balance: ${ethers.formatUnits(usdcBalance, 6)}`);
    console.log(`  Reputation Score: ${reputation}/1000`);
    console.log('');

    console.log('█'.repeat(80) + '\n');

    // Save results
    const resultsFile = `./rapid-loan-test-results-${Date.now()}.json`;
    fs.writeFileSync(resultsFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        network: 'arc-testnet',
        configuration: {
            loanAmount: LOAN_AMOUNT,
            durationDays: DURATION_DAYS,
            maxCycles: MAX_CYCLES,
            cycleDelay: CYCLE_DELAY
        },
        metrics,
        finalState: {
            usdcBalance: ethers.formatUnits(usdcBalance, 6),
            reputation: reputation.toString()
        }
    }, null, 2));

    log(`📁 Results saved to: ${resultsFile}`);
}

async function main() {
    console.log('\n' + '█'.repeat(80));
    console.log('RAPID LOAN TEST - MAXIMUM THROUGHPUT');
    console.log('█'.repeat(80));
    console.log(`Configuration:`);
    console.log(`  Loan Amount: ${LOAN_AMOUNT} USDC`);
    console.log(`  Duration: ${DURATION_DAYS} days`);
    console.log(`  Max Cycles: ${MAX_CYCLES}`);
    console.log(`  Cycle Delay: ${CYCLE_DELAY}ms`);
    console.log('█'.repeat(80) + '\n');

    // Check initial state
    const canProceed = await checkBalances();
    if (!canProceed) {
        log('❌ Prerequisites not met. Exiting.');
        process.exit(1);
    }

    log('\n🚀 Starting rapid loan testing...\n');

    const startTime = Date.now();

    // Run cycles
    for (let i = 1; i <= MAX_CYCLES; i++) {
        metrics.cycles = i;
        await performCycle(i);
    }

    metrics.totalTime = Date.now() - startTime;

    log(`\n✨ Test completed in ${(metrics.totalTime / 1000).toFixed(2)}s`);

    await printSummary();
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
