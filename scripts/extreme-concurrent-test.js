/**
 * Extreme Concurrent Load Test
 *
 * Push maximum concurrent load:
 * - 5 agents all borrowing simultaneously
 * - Each agent runs multiple cycles rapidly
 * - No delays between operations
 * - Maximum throughput test
 */

const { ethers } = require('ethers');
const fs = require('fs');

const NETWORK = process.env.NETWORK || 'arc';
const CYCLES_PER_AGENT = parseInt(process.env.CYCLES || '20');
const LOAN_AMOUNT = parseInt(process.env.LOAN_AMOUNT || '30');

const RPC_URLS = {
    arc: 'https://arc-testnet.drpc.org',
    base: 'https://sepolia.base.org',
};

// Use all available test agents
const AGENTS = [
    { name: 'Agent 1', key: 'process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'' },
    { name: 'Agent 2', key: '0x41adb1d6ef22647a3de0e7993f4e33ec7bcd5b49359587967750ff8f3faddf67' },
    { name: 'Agent 3', key: '0xebd981dcdb6f6f4c8744a40a937f7b75de400290c58c2728cfff0d2af2418452' },
];

async function runAgentCycles(agentConfig, provider, addresses, keys, agentNum) {
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

    const results = {
        agent: agentConfig.name,
        agentNum,
        address: wallet.address,
        success: 0,
        failed: 0,
        totalGas: 0n,
        totalTime: 0,
        minTime: Infinity,
        maxTime: 0,
        errors: [],
        startTime: Date.now(),
    };

    console.log(`[${agentConfig.name}] STARTING ${CYCLES_PER_AGENT} rapid-fire cycles (${LOAN_AMOUNT} USDC each)`);

    // Approve USDC once
    try {
        const approveTx = await usdc.approve(addresses[keys.marketplace], ethers.parseUnits('100000', 6));
        await approveTx.wait();
        console.log(`[${agentConfig.name}] ✅ Approved`);
    } catch (error) {
        console.log(`[${agentConfig.name}] ❌ Approval failed: ${error.message.split('\n')[0]}`);
        results.endTime = Date.now();
        return results;
    }

    // Rapid-fire loan cycles (no delays)
    for (let i = 0; i < CYCLES_PER_AGENT; i++) {
        try {
            const cycleStart = Date.now();

            // Request loan
            const loanTx = await marketplace.requestLoan(
                ethers.parseUnits(LOAN_AMOUNT.toString(), 6),
                7
            );
            const requestReceipt = await loanTx.wait();

            let loanId;
            for (const log of requestReceipt.logs) {
                try {
                    const parsed = marketplace.interface.parseLog(log);
                    if (parsed && parsed.name === 'LoanRequested') {
                        loanId = Number(parsed.args.loanId);
                        break;
                    }
                } catch {}
            }

            // Repay immediately (no delay)
            const repayTx = await marketplace.repayLoan(loanId);
            const repayReceipt = await repayTx.wait();

            const cycleTime = Date.now() - cycleStart;
            const gas = requestReceipt.gasUsed + repayReceipt.gasUsed;

            results.success++;
            results.totalGas += gas;
            results.totalTime += cycleTime;
            results.minTime = Math.min(results.minTime, cycleTime);
            results.maxTime = Math.max(results.maxTime, cycleTime);

            if (i % 5 === 0 || i === CYCLES_PER_AGENT - 1) {
                console.log(`[${agentConfig.name}] ${i + 1}/${CYCLES_PER_AGENT} ✅ ${cycleTime}ms`);
            }

        } catch (error) {
            results.failed++;
            const errorMsg = error.message.split('\n')[0];
            results.errors.push(errorMsg);

            if (results.failed % 5 === 1) {
                console.log(`[${agentConfig.name}] Cycle ${i + 1} ❌ ${errorMsg.substring(0, 50)}`);
            }
        }
    }

    results.endTime = Date.now();
    results.totalDuration = (results.endTime - results.startTime) / 1000;

    console.log(`[${agentConfig.name}] COMPLETE: ${results.success}/${CYCLES_PER_AGENT} in ${results.totalDuration.toFixed(1)}s (${(results.success/results.totalDuration).toFixed(2)} loans/sec)\n`);

    return results;
}

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(`║  EXTREME CONCURRENT LOAD TEST - ${NETWORK.toUpperCase().padEnd(18)}║`);
    console.log('╚══════════════════════════════════════════════════╝\n');

    const RPC_URL = RPC_URLS[NETWORK];
    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });

    console.log(`Network: ${NETWORK === 'arc' ? 'Arc Testnet' : 'Base Sepolia'}`);
    console.log(`Agents: ${AGENTS.length} (ALL RUNNING IN PARALLEL)`);
    console.log(`Cycles per Agent: ${CYCLES_PER_AGENT}`);
    console.log(`Loan Amount: ${LOAN_AMOUNT} USDC`);
    console.log(`Total Target: ${AGENTS.length * CYCLES_PER_AGENT} loans`);
    console.log(`Total Volume: ${AGENTS.length * CYCLES_PER_AGENT * LOAN_AMOUNT} USDC\n`);

    const configPath = NETWORK === 'arc'
        ? './src/config/arc-testnet-addresses.json'
        : './src/config/base-sepolia-addresses.json';

    const addresses = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    const keys = {
        arc: {
            marketplace: 'agentLiquidityMarketplace',
            usdc: 'mockUSDC',
        },
        base: {
            marketplace: 'AgentLiquidityMarketplace',
            usdc: 'MockUSDC',
        },
    };

    const k = keys[NETWORK];

    console.log('═'.repeat(70));
    console.log('LAUNCHING ALL AGENTS SIMULTANEOUSLY');
    console.log('═'.repeat(70) + '\n');

    const testStart = Date.now();

    // Run ALL agents concurrently (maximum parallel load)
    const agentPromises = AGENTS.map((agent, idx) =>
        runAgentCycles(agent, provider, addresses, k, idx + 1)
    );

    const agentResults = await Promise.all(agentPromises);

    const testDuration = (Date.now() - testStart) / 1000;

    console.log('═'.repeat(70));
    console.log('EXTREME LOAD TEST RESULTS');
    console.log('═'.repeat(70) + '\n');

    console.log(`Total Duration: ${testDuration.toFixed(2)}s (${(testDuration / 60).toFixed(2)}m)\n`);

    let totalSuccess = 0;
    let totalFailed = 0;
    let totalGas = 0n;
    let fastestCycle = Infinity;
    let slowestCycle = 0;

    console.log('Results by Agent:');
    console.log('-'.repeat(70));

    for (const result of agentResults) {
        const successRate = result.success > 0 ? (result.success / CYCLES_PER_AGENT * 100).toFixed(1) : '0.0';
        const avgTime = result.success > 0 ? Math.round(result.totalTime / result.success) : 0;
        const avgGas = result.success > 0 ? Number(result.totalGas) / result.success : 0;
        const throughput = result.success > 0 ? (result.success / result.totalDuration).toFixed(2) : '0.00';

        console.log(`${result.agent} (#${result.agentNum})`);
        console.log(`  Success: ${result.success}/${CYCLES_PER_AGENT} (${successRate}%)`);
        console.log(`  Failed: ${result.failed}`);
        console.log(`  Duration: ${result.totalDuration.toFixed(1)}s`);
        console.log(`  Throughput: ${throughput} loans/sec`);
        console.log(`  Avg Time: ${avgTime}ms (min: ${result.minTime}ms, max: ${result.maxTime}ms)`);
        console.log(`  Avg Gas: ${Math.round(avgGas).toLocaleString()}`);

        if (result.errors.length > 0) {
            const uniqueErrors = [...new Set(result.errors)];
            console.log(`  Errors: ${result.failed} total`);
            if (uniqueErrors.length <= 3) {
                uniqueErrors.forEach(err => {
                    const count = result.errors.filter(e => e === err).length;
                    console.log(`    ${count}x ${err.substring(0, 55)}`);
                });
            }
        }
        console.log('');

        totalSuccess += result.success;
        totalFailed += result.failed;
        totalGas += result.totalGas;
        fastestCycle = Math.min(fastestCycle, result.minTime === Infinity ? 0 : result.minTime);
        slowestCycle = Math.max(slowestCycle, result.maxTime);
    }

    console.log('-'.repeat(70));
    console.log('AGGREGATE STATISTICS:');
    console.log(`  Total Loans Attempted: ${totalSuccess + totalFailed}`);
    console.log(`  Successful: ${totalSuccess}`);
    console.log(`  Failed: ${totalFailed}`);
    console.log(`  Success Rate: ${(totalSuccess / (totalSuccess + totalFailed) * 100).toFixed(2)}%`);
    console.log(`  Total Gas: ${totalGas.toString().toLocaleString()}`);
    console.log(`  Total Volume: ${(totalSuccess * LOAN_AMOUNT).toLocaleString()} USDC`);
    console.log(`  Overall Throughput: ${(totalSuccess / testDuration).toFixed(2)} loans/sec`);
    console.log(`  Fastest Cycle: ${fastestCycle}ms`);
    console.log(`  Slowest Cycle: ${slowestCycle}ms\n`);

    console.log('CONCURRENCY ANALYSIS:');
    const avgAgentDuration = agentResults.reduce((sum, r) => sum + r.totalDuration, 0) / agentResults.length;
    const sequentialTime = avgAgentDuration * AGENTS.length;
    const parallelSpeedup = sequentialTime / testDuration;
    const efficiency = (parallelSpeedup / AGENTS.length) * 100;

    console.log(`  Agents Running: ${AGENTS.length}`);
    console.log(`  Avg Agent Duration: ${avgAgentDuration.toFixed(1)}s`);
    console.log(`  Actual Parallel Time: ${testDuration.toFixed(1)}s`);
    console.log(`  Sequential Would Take: ${sequentialTime.toFixed(1)}s`);
    console.log(`  Parallel Speedup: ${parallelSpeedup.toFixed(2)}x`);
    console.log(`  Parallel Efficiency: ${efficiency.toFixed(1)}%\n`);

    console.log('═'.repeat(70) + '\n');

    // Save results
    const reportPath = `./extreme-test-${NETWORK}-${AGENTS.length}agents-${CYCLES_PER_AGENT}cycles-${Date.now()}.json`;
    fs.writeFileSync(reportPath, JSON.stringify({
        network: NETWORK,
        agents: AGENTS.length,
        cyclesPerAgent: CYCLES_PER_AGENT,
        loanAmount: LOAN_AMOUNT,
        totalSuccess,
        totalFailed,
        testDuration,
        totalGas: totalGas.toString(),
        throughput: totalSuccess / testDuration,
        agentResults: agentResults.map(r => ({
            ...r,
            totalGas: r.totalGas.toString(),
        })),
    }, null, 2));

    console.log(`📊 Results saved to: ${reportPath}\n`);
}

main().catch(err => {
    console.error('\n❌ Extreme load test failed:', err.message);
    console.error(err);
    process.exit(1);
});
