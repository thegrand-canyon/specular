const { ethers } = require('ethers');
const fs = require('fs');

const LOAN_AMOUNT = 20; // Small loans for maximum count
const MAX_FAILURES_PER_AGENT = 50; // Stop agent after this many consecutive failures

async function agentWorker(agentName, privateKey, agentId, provider, addresses, mpAbi, usdcAbi) {
    const wallet = new ethers.Wallet(privateKey, provider);
    const mp = new ethers.Contract(addresses.agentLiquidityMarketplace, mpAbi, wallet);
    const usdc = new ethers.Contract(addresses.mockUSDC, usdcAbi, wallet);

    const stats = {
        name: agentName,
        id: agentId,
        address: wallet.address,
        success: 0,
        failed: 0,
        consecutiveFails: 0,
        totalGas: 0n,
        startTime: Date.now(),
        errors: {}
    };

    console.log('[' + agentName + '] Starting unlimited rapid-fire test...');
    console.log('[' + agentName + '] Address: ' + wallet.address + '\n');

    // Approve once with huge allowance
    try {
        const approveTx = await usdc.approve(addresses.agentLiquidityMarketplace, ethers.parseUnits('1000000', 6));
        await approveTx.wait();
        console.log('[' + agentName + '] ✅ Approved\n');
    } catch (error) {
        console.log('[' + agentName + '] ❌ Approval failed: ' + error.message + '\n');
        stats.endTime = Date.now();
        return stats;
    }

    // Run until we hit a stopping condition
    let consecutiveFails = 0;
    while (consecutiveFails < MAX_FAILURES_PER_AGENT) {
        try {
            // Request loan
            const loanTx = await mp.requestLoan(ethers.parseUnits(LOAN_AMOUNT.toString(), 6), 7);
            const requestReceipt = await loanTx.wait();

            // Extract loan ID
            let loanId;
            for (const log of requestReceipt.logs) {
                try {
                    const parsed = mp.interface.parseLog(log);
                    if (parsed?.name === 'LoanRequested') {
                        loanId = Number(parsed.args.loanId);
                        break;
                    }
                } catch {}
            }

            // Repay immediately
            const repayTx = await mp.repayLoan(loanId);
            const repayReceipt = await repayTx.wait();

            stats.totalGas += requestReceipt.gasUsed + repayReceipt.gasUsed;
            stats.success++;
            consecutiveFails = 0;

            // Progress update every 25 loans
            if (stats.success % 25 === 0) {
                const elapsed = (Date.now() - stats.startTime) / 1000;
                const rate = stats.success / elapsed;
                console.log('[' + agentName + '] ' + stats.success + ' ✅ | ' + rate.toFixed(2) + ' loans/sec | ' + (elapsed / 60).toFixed(1) + 'm');
            }

        } catch (error) {
            stats.failed++;
            consecutiveFails++;

            const errorMsg = error.message || String(error);
            const errorKey = errorMsg.substring(0, 30);
            stats.errors[errorKey] = (stats.errors[errorKey] || 0) + 1;

            // Stop conditions
            if (errorMsg.includes('insufficient funds') || errorMsg.includes('OUT OF GAS')) {
                console.log('[' + agentName + '] 🛑 OUT OF GAS after ' + stats.success + ' loans\n');
                break;
            }

            if (errorMsg.includes('Request timeout') || errorMsg.includes('408')) {
                if (stats.failed % 10 === 1) {
                    console.log('[' + agentName + '] ⚠️  RPC timeout (' + stats.failed + ' total failures)');
                }
                // Backoff on RPC errors
                await new Promise(resolve => setTimeout(resolve, 2000));
            }

            if (errorMsg.includes('Too many active')) {
                console.log('[' + agentName + '] ⏸️  Active loan limit hit\n');
                break;
            }

            // Report first occurrence of each error type
            if (stats.errors[errorKey] === 1 && !errorMsg.includes('timeout')) {
                console.log('[' + agentName + '] ❌ ' + errorMsg.substring(0, 60));
            }
        }
    }

    if (consecutiveFails >= MAX_FAILURES_PER_AGENT) {
        console.log('[' + agentName + '] 🛑 STOPPED after ' + MAX_FAILURES_PER_AGENT + ' consecutive failures\n');
    }

    stats.endTime = Date.now();
    stats.duration = (stats.endTime - stats.startTime) / 1000;

    console.log('[' + agentName + '] ✅ COMPLETE: ' + stats.success + ' loans in ' + (stats.duration / 60).toFixed(1) + 'm\n');

    return stats;
}

async function main() {
    console.log('\n🔥 ULTIMATE STRESS TEST - MAXIMUM THROUGHPUT 🔥\n');
    console.log('Strategy: All available agents in parallel, unlimited duration\n');

    const provider = new ethers.JsonRpcProvider('https://arc-testnet.drpc.org', undefined, { batchMaxCount: 1 });
    const addresses = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8'));
    const freshConfig = JSON.parse(fs.readFileSync('./fresh-agents-config.json', 'utf8'));

    const mpAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json', 'utf8')).abi;
    const usdcAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/tokens/MockUSDC.sol/MockUSDC.json', 'utf8')).abi;

    // Collect all agents
    const agents = [
        // Main agent (high reputation, no collateral)
        {
            name: 'Main Agent',
            privateKey: '0x4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac',
            id: 1
        },
        // Fresh agents (zero reputation, 100% collateral)
        ...freshConfig.agents.map(a => ({
            name: a.name,
            privateKey: a.privateKey,
            id: a.id
        }))
    ];

    console.log('Agents: ' + agents.length);
    console.log('Loan Amount: ' + LOAN_AMOUNT + ' USDC');
    console.log('Strategy: Immediate repayment (avoid active loan limit)\n');

    console.log('═'.repeat(70));
    console.log('LAUNCHING ALL AGENTS IN PARALLEL');
    console.log('═'.repeat(70) + '\n');

    const testStart = Date.now();

    // Launch all agents in parallel
    const promises = agents.map(agent =>
        agentWorker(agent.name, agent.privateKey, agent.id, provider, addresses, mpAbi, usdcAbi)
    );

    const results = await Promise.all(promises);

    const testDuration = (Date.now() - testStart) / 1000;

    console.log('═'.repeat(70));
    console.log('ULTIMATE STRESS TEST RESULTS');
    console.log('═'.repeat(70) + '\n');

    let totalSuccess = 0, totalFailed = 0, totalGas = 0n;

    for (const result of results) {
        const rate = result.duration > 0 ? (result.success / result.duration).toFixed(2) : '0.00';
        console.log(result.name + ' (ID ' + result.id + '):');
        console.log('  Success: ' + result.success);
        console.log('  Failed: ' + result.failed);
        console.log('  Duration: ' + (result.duration / 60).toFixed(1) + 'm');
        console.log('  Throughput: ' + rate + ' loans/sec');
        console.log('  Total Gas: ' + result.totalGas.toString());

        if (Object.keys(result.errors).length > 0) {
            console.log('  Top Errors:');
            const sortedErrors = Object.entries(result.errors)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 3);
            for (const [err, count] of sortedErrors) {
                console.log('    - ' + err + '... (' + count + 'x)');
            }
        }
        console.log('');

        totalSuccess += result.success;
        totalFailed += result.failed;
        totalGas += result.totalGas;
    }

    console.log('─'.repeat(70));
    console.log('AGGREGATE RESULTS:');
    console.log('  Total Agents: ' + agents.length);
    console.log('  Total Success: ' + totalSuccess);
    console.log('  Total Failed: ' + totalFailed);
    console.log('  Success Rate: ' + (totalSuccess / (totalSuccess + totalFailed) * 100).toFixed(2) + '%');
    console.log('  Total Duration: ' + (testDuration / 60).toFixed(1) + 'm');
    console.log('  Total Gas: ' + totalGas.toString());
    console.log('');
    console.log('  **AGGREGATE THROUGHPUT: ' + (totalSuccess / testDuration).toFixed(2) + ' loans/sec**');
    console.log('  **HOURLY RATE: ' + Math.round(totalSuccess / testDuration * 3600) + ' loans/hour**');
    console.log('  **DAILY CAPACITY: ' + Math.round(totalSuccess / testDuration * 86400).toLocaleString() + ' loans/day**');
    console.log('');

    if (totalSuccess >= 1000) {
        console.log('🏆 LEGENDARY: Processed 1,000+ loans!');
    } else if (totalSuccess >= 500) {
        console.log('🎉 EXCELLENT: Processed ' + totalSuccess + ' loans!');
    } else if (totalSuccess >= 250) {
        console.log('✅ STRONG: Processed ' + totalSuccess + ' loans!');
    } else {
        console.log('📊 Processed ' + totalSuccess + ' loans');
    }
    console.log('');

    // Save results
    const reportPath = './ultimate-stress-test-' + totalSuccess + 'loans-' + Date.now() + '.json';
    fs.writeFileSync(reportPath, JSON.stringify({
        network: 'arc-testnet',
        agents: agents.length,
        totalSuccess,
        totalFailed,
        testDuration,
        throughput: totalSuccess / testDuration,
        totalGas: totalGas.toString(),
        results: results.map(r => ({ ...r, totalGas: r.totalGas.toString() }))
    }, null, 2));

    console.log('📊 Results saved to: ' + reportPath + '\n');
}

main().catch(err => {
    console.error('\n❌ Test failed:', err.message);
    console.error(err);
    process.exit(1);
});
