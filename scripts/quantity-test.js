/**
 * Quantity Test - 1,000+ Loan Rapid-Fire Test
 *
 * Goal: Maximum throughput - how many loans can the network handle in rapid succession?
 * Strategy:
 * - Multiple agents all borrowing simultaneously
 * - Rapid-fire requests (no artificial delays)
 * - Each agent respects active loan limit by repaying immediately
 * - Measure total throughput and network capacity
 */

const { ethers } = require('ethers');
const fs = require('fs');

const NETWORK = process.env.NETWORK || 'arc';
const TARGET_LOANS = parseInt(process.env.TARGET_LOANS || '1000');

const RPC_URLS = {
    arc: 'https://arc-testnet.drpc.org',
    base: 'https://sepolia.base.org',
};

// All available agents for maximum parallelization
const AGENTS = [
    { name: 'Agent 1', key: process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000', address: '0x656086A21073272533c8A3f56A94c1f3D8BCFcE2' },
    { name: 'Agent 2', key: 'process.env.TEST_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'', address: '0xd673e66BF1C3Bf696d88A147Cfddc17AaB7C9F8A' },
    { name: 'Agent 3', key: 'process.env.TEST_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'', address: '0x05E7092f2E3b303499783260DB72786a0788fb80' },
];

async function quantityAgent(agentConfig, provider, addresses, keys, targetLoans) {
    const wallet = new ethers.Wallet(agentConfig.key, provider);

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

    const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');
    const usdcAbi = loadAbi('MockUSDC');

    const marketplace = new ethers.Contract(addresses[keys.marketplace], marketplaceAbi, wallet);
    const usdc = new ethers.Contract(addresses[keys.usdc], usdcAbi, wallet);

    const stats = {
        agent: agentConfig.name,
        address: agentConfig.address,
        target: targetLoans,
        completed: 0,
        failed: 0,
        totalGas: 0n,
        totalTime: 0,
        minTime: Infinity,
        maxTime: 0,
        errors: {},
        startTime: Date.now(),
    };

    console.log(`[${agentConfig.name}] 🚀 QUANTITY MODE: Targeting ${targetLoans} rapid-fire loans`);

    // Check balance first
    try {
        const ethBalance = await provider.getBalance(wallet.address);
        const usdcBalance = await usdc.balanceOf(wallet.address);
        console.log(`[${agentConfig.name}] ETH: ${ethers.formatEther(ethBalance)} | USDC: ${ethers.formatUnits(usdcBalance, 6)}`);

        if (ethBalance < ethers.parseEther('0.01')) {
            console.log(`[${agentConfig.name}] ⚠️  LOW ETH - may not complete all loans`);
        }
    } catch (error) {
        console.log(`[${agentConfig.name}] ❌ Balance check failed: ${error.message.substring(0, 50)}`);
    }

    // Approve USDC
    try {
        const approveTx = await usdc.approve(addresses[keys.marketplace], ethers.parseUnits('500000', 6));
        await approveTx.wait();
        console.log(`[${agentConfig.name}] ✅ Approved\n`);
    } catch (error) {
        console.log(`[${agentConfig.name}] ❌ Approval failed: ${error.message.substring(0, 50)}`);
        stats.endTime = Date.now();
        return stats;
    }

    // Rapid-fire loan cycles
    let consecutiveLimitErrors = 0;
    const LIMIT_ERROR_THRESHOLD = 10; // Stop after 10 consecutive limit errors

    for (let i = 0; i < targetLoans; i++) {
        try {
            const cycleStart = Date.now();

            // Request 20 USDC loan for 7 days
            const loanTx = await marketplace.requestLoan(ethers.parseUnits('20', 6), 7);
            const requestReceipt = await loanTx.wait();

            // Extract loan ID
            let loanId;
            for (const log of requestReceipt.logs) {
                try {
                    const parsed = marketplace.interface.parseLog(log);
                    if (parsed?.name === 'LoanRequested') {
                        loanId = Number(parsed.args.loanId);
                        break;
                    }
                } catch {}
            }

            // Repay immediately (to free up active loan slot)
            const repayTx = await marketplace.repayLoan(loanId);
            const repayReceipt = await repayTx.wait();

            const cycleTime = Date.now() - cycleStart;
            const gas = requestReceipt.gasUsed + repayReceipt.gasUsed;

            stats.completed++;
            stats.totalGas += gas;
            stats.totalTime += cycleTime;
            stats.minTime = Math.min(stats.minTime, cycleTime);
            stats.maxTime = Math.max(stats.maxTime, cycleTime);

            // Reset consecutive limit errors on success
            consecutiveLimitErrors = 0;

            // Progress updates every 50 loans
            if ((i + 1) % 50 === 0) {
                const elapsed = (Date.now() - stats.startTime) / 1000;
                const rate = stats.completed / elapsed;
                const eta = (targetLoans - stats.completed) / rate / 60;
                console.log(`[${agentConfig.name}] ${stats.completed}/${targetLoans} ✅ ${rate.toFixed(2)} loans/sec | ETA: ${eta.toFixed(1)}m`);
            }

        } catch (error) {
            stats.failed++;
            const errorMsg = error.message.split('\n')[0];

            // Track error types
            const errorType = errorMsg.includes('Too many active loans') ? 'ACTIVE_LOAN_LIMIT' :
                            errorMsg.includes('insufficient funds') ? 'OUT_OF_GAS' :
                            errorMsg.includes('408') ? 'RPC_TIMEOUT' :
                            errorMsg.includes('replacement') ? 'NONCE_CONFLICT' : 'OTHER';

            stats.errors[errorType] = (stats.errors[errorType] || 0) + 1;

            // Check for consecutive limit errors (indicates persistent limit hit)
            if (errorType === 'ACTIVE_LOAN_LIMIT') {
                consecutiveLimitErrors++;
                if (consecutiveLimitErrors >= LIMIT_ERROR_THRESHOLD) {
                    console.log(`[${agentConfig.name}] ⚠️  ${LIMIT_ERROR_THRESHOLD} consecutive limit errors - pausing 5s to allow repayments...`);
                    await new Promise(resolve => setTimeout(resolve, 5000));
                    consecutiveLimitErrors = 0;
                }
            } else {
                consecutiveLimitErrors = 0;
            }

            // Log errors periodically
            if (stats.failed % 20 === 1) {
                console.log(`[${agentConfig.name}] ${i + 1}. ❌ ${errorType}: ${errorMsg.substring(0, 40)}`);
            }

            // Stop if out of gas
            if (errorType === 'OUT_OF_GAS') {
                console.log(`[${agentConfig.name}] 🛑 OUT OF GAS - Stopping after ${stats.completed} loans\n`);
                break;
            }
        }
    }

    stats.endTime = Date.now();
    stats.totalDuration = (stats.endTime - stats.startTime) / 1000;

    console.log(`[${agentConfig.name}] ✅ COMPLETE: ${stats.completed}/${targetLoans} in ${stats.totalDuration.toFixed(1)}s\n`);

    return stats;
}

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(`║    QUANTITY TEST - ${NETWORK.toUpperCase().padEnd(28)}║`);
    console.log('╚══════════════════════════════════════════════════╝\n');

    const RPC_URL = RPC_URLS[NETWORK];
    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });

    // Distribute target across agents
    const loansPerAgent = Math.ceil(TARGET_LOANS / AGENTS.length);

    console.log(`🎯 QUANTITY TEST PARAMETERS:`);
    console.log(`  Network: ${NETWORK === 'arc' ? 'Arc Testnet' : 'Base Sepolia'}`);
    console.log(`  Target Total: ${TARGET_LOANS} loans`);
    console.log(`  Agents: ${AGENTS.length} (all parallel)`);
    console.log(`  Per Agent: ${loansPerAgent} loans`);
    console.log(`  Loan Size: 20 USDC`);
    console.log(`  Strategy: Rapid-fire with immediate repayment\n`);

    const configPath = NETWORK === 'arc'
        ? './src/config/arc-testnet-addresses.json'
        : './src/config/base-sepolia-addresses.json';

    const addresses = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    const keys = {
        arc: { marketplace: 'agentLiquidityMarketplace', usdc: 'mockUSDC' },
        base: { marketplace: 'AgentLiquidityMarketplace', usdc: 'MockUSDC' },
    };

    const k = keys[NETWORK];

    console.log('═'.repeat(70));
    console.log('🚀 LAUNCHING ALL AGENTS FOR MAXIMUM THROUGHPUT');
    console.log('═'.repeat(70) + '\n');

    const testStart = Date.now();

    // All agents run simultaneously - maximum parallelization
    const agentPromises = AGENTS.map(agent =>
        quantityAgent(agent, provider, addresses, k, loansPerAgent)
    );

    const results = await Promise.all(agentPromises);

    const testDuration = (Date.now() - testStart) / 1000;

    console.log('═'.repeat(70));
    console.log('QUANTITY TEST RESULTS');
    console.log('═'.repeat(70) + '\n');

    console.log(`Total Duration: ${testDuration.toFixed(2)}s (${(testDuration / 60).toFixed(2)}m)\n`);

    let totalCompleted = 0;
    let totalFailed = 0;
    let totalGas = 0n;
    let allErrors = {};

    console.log('Results by Agent:');
    console.log('-'.repeat(70));

    for (const result of results) {
        const successRate = result.target > 0 ? ((result.completed / result.target) * 100).toFixed(1) : '0.0';
        const avgTime = result.completed > 0 ? Math.round(result.totalTime / result.completed) : 0;
        const throughput = result.totalDuration > 0 ? (result.completed / result.totalDuration).toFixed(2) : '0.00';

        console.log(`${result.agent}:`);
        console.log(`  Target: ${result.target}`);
        console.log(`  Completed: ${result.completed} (${successRate}%)`);
        console.log(`  Failed: ${result.failed}`);
        console.log(`  Duration: ${result.totalDuration.toFixed(1)}s`);
        console.log(`  Throughput: ${throughput} loans/sec`);
        console.log(`  Avg Cycle Time: ${avgTime}ms`);
        console.log(`  Total Gas: ${result.totalGas.toString().toLocaleString()}`);

        if (Object.keys(result.errors).length > 0) {
            console.log(`  Error Breakdown:`);
            for (const [type, count] of Object.entries(result.errors)) {
                console.log(`    ${type}: ${count}`);
                allErrors[type] = (allErrors[type] || 0) + count;
            }
        }
        console.log('');

        totalCompleted += result.completed;
        totalFailed += result.failed;
        totalGas += result.totalGas;
    }

    console.log('-'.repeat(70));
    console.log('AGGREGATE QUANTITY METRICS:');
    console.log(`  Target: ${TARGET_LOANS}`);
    console.log(`  Completed: ${totalCompleted} (${((totalCompleted/TARGET_LOANS)*100).toFixed(1)}%)`);
    console.log(`  Failed: ${totalFailed}`);
    console.log(`  Success Rate: ${((totalCompleted / (totalCompleted + totalFailed)) * 100).toFixed(2)}%`);
    console.log(`  Total Duration: ${testDuration.toFixed(2)}s (${(testDuration/60).toFixed(2)}m)`);
    console.log(`  Total Gas: ${totalGas.toString().toLocaleString()}`);
    console.log(`  **THROUGHPUT: ${(totalCompleted / testDuration).toFixed(2)} loans/sec**`);
    console.log(`  **HOURLY RATE: ${Math.round(totalCompleted / testDuration * 3600)} loans/hour**`);
    console.log(`  **DAILY CAPACITY: ${Math.round(totalCompleted / testDuration * 86400)} loans/day**\n`);

    if (Object.keys(allErrors).length > 0) {
        console.log('ERROR SUMMARY:');
        for (const [type, count] of Object.entries(allErrors)) {
            console.log(`  ${type}: ${count} (${((count/(totalCompleted+totalFailed))*100).toFixed(1)}%)`);
        }
        console.log('');
    }

    console.log('QUANTITY ANALYSIS:');
    console.log(`  ${AGENTS.length} agents operated in parallel`);
    console.log(`  Achieved ${totalCompleted} loans in ${(testDuration/60).toFixed(2)} minutes`);
    console.log(`  Network throughput: ${(totalCompleted / testDuration).toFixed(2)} loans/sec`);
    if (totalCompleted >= 1000) {
        console.log(`  ✅ Successfully processed 1,000+ loans!`);
    } else {
        console.log(`  ⚠️  Reached ${totalCompleted} loans (${((totalCompleted/TARGET_LOANS)*100).toFixed(1)}% of target)`);
    }
    console.log('');

    console.log('═'.repeat(70) + '\n');

    // Save results
    const reportPath = `./quantity-test-${NETWORK}-${AGENTS.length}agents-${totalCompleted}loans-${Date.now()}.json`;
    fs.writeFileSync(reportPath, JSON.stringify({
        network: NETWORK,
        target: TARGET_LOANS,
        agents: AGENTS.length,
        totalCompleted,
        totalFailed,
        testDuration,
        throughput: totalCompleted / testDuration,
        totalGas: totalGas.toString(),
        results: results.map(r => ({
            ...r,
            totalGas: r.totalGas.toString(),
        })),
        errors: allErrors,
    }, null, 2));

    console.log(`📊 Results saved to: ${reportPath}\n`);

    if (totalCompleted >= 1000) {
        console.log('🎉 QUANTITY TEST PASSED: 1,000+ loans processed!\n');
    }
}

main().catch(err => {
    console.error('\n❌ Quantity test failed:', err.message);
    console.error(err);
    process.exit(1);
});
