const { ethers } = require('ethers');
const fs = require('fs');

const TARGET = parseInt(process.env.TARGET || '1000');
const LOAN_AMOUNT = 20;

async function agentWorker(agent, provider, addresses, loansPerAgent) {
    const wallet = new ethers.Wallet(agent.privateKey, provider);

    const mpAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json', 'utf8')).abi;
    const usdcAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/tokens/MockUSDC.sol/MockUSDC.json', 'utf8')).abi;

    const mp = new ethers.Contract(addresses.agentLiquidityMarketplace, mpAbi, wallet);
    const usdc = new ethers.Contract(addresses.mockUSDC, usdcAbi, wallet);

    const stats = {
        agent: agent.name,
        id: agent.id,
        target: loansPerAgent,
        success: 0,
        failed: 0,
        totalGas: 0n,
        startTime: Date.now()
    };

    console.log('[' + agent.name + '] Starting ' + loansPerAgent + ' rapid-fire loans...');

    // Approve
    try {
        const tx = await usdc.approve(addresses.agentLiquidityMarketplace, ethers.parseUnits('50000', 6));
        await tx.wait();
        console.log('[' + agent.name + '] ✅ Approved\n');
    } catch (error) {
        console.log('[' + agent.name + '] ❌ Approval failed\n');
        stats.endTime = Date.now();
        return stats;
    }

    // Rapid-fire loan cycles
    for (let i = 0; i < loansPerAgent; i++) {
        try {
            const loanTx = await mp.requestLoan(ethers.parseUnits(LOAN_AMOUNT.toString(), 6), 7);
            const requestReceipt = await loanTx.wait();

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

            const repayTx = await mp.repayLoan(loanId);
            const repayReceipt = await repayTx.wait();

            stats.totalGas += requestReceipt.gasUsed + repayReceipt.gasUsed;
            stats.success++;

            if ((i + 1) % 50 === 0) {
                const elapsed = (Date.now() - stats.startTime) / 1000;
                const rate = stats.success / elapsed;
                console.log('[' + agent.name + '] ' + (i + 1) + '/' + loansPerAgent + ' ✅ | ' + rate.toFixed(2) + ' loans/sec');
            }

        } catch (error) {
            stats.failed++;
            const errorMsg = error.message;

            if (errorMsg.includes('insufficient funds')) {
                console.log('[' + agent.name + '] 🛑 OUT OF GAS after ' + stats.success + ' loans\n');
                break;
            }

            if (stats.failed === 1 || stats.failed % 20 === 0) {
                console.log('[' + agent.name + '] ❌ ' + errorMsg.substring(0, 50));
            }
        }
    }

    stats.endTime = Date.now();
    stats.duration = (stats.endTime - stats.startTime) / 1000;

    console.log('[' + agent.name + '] ✅ COMPLETE: ' + stats.success + '/' + loansPerAgent + ' in ' + stats.duration.toFixed(1) + 's\n');

    return stats;
}

async function main() {
    console.log('\n🚀 FRESH AGENTS QUANTITY TEST\n');
    console.log('Target: ' + TARGET + ' total loans');
    console.log('Agents: 3 fresh agents (parallel execution)\n');

    const provider = new ethers.JsonRpcProvider('https://arc-testnet.drpc.org', undefined, { batchMaxCount: 1 });
    const addresses = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8'));
    const config = JSON.parse(fs.readFileSync('./fresh-agents-config.json', 'utf8'));

    const loansPerAgent = Math.ceil(TARGET / config.agents.length);

    console.log('Loans per Agent: ' + loansPerAgent);
    console.log('Loan Amount: ' + LOAN_AMOUNT + ' USDC\n');

    console.log('═'.repeat(70));
    console.log('LAUNCHING ALL FRESH AGENTS');
    console.log('═'.repeat(70) + '\n');

    const testStart = Date.now();

    // Run all agents in parallel
    const promises = config.agents.map(agent =>
        agentWorker(agent, provider, addresses, loansPerAgent)
    );

    const results = await Promise.all(promises);

    const testDuration = (Date.now() - testStart) / 1000;

    console.log('═'.repeat(70));
    console.log('QUANTITY TEST RESULTS');
    console.log('═'.repeat(70) + '\n');

    let totalSuccess = 0, totalFailed = 0, totalGas = 0n;

    for (const result of results) {
        const rate = result.duration > 0 ? (result.success / result.duration).toFixed(2) : '0.00';
        console.log(result.agent + ' (ID ' + result.id + '):');
        console.log('  Success: ' + result.success + '/' + result.target + ' (' + (result.success/result.target*100).toFixed(1) + '%)');
        console.log('  Failed: ' + result.failed);
        console.log('  Duration: ' + result.duration.toFixed(1) + 's');
        console.log('  Throughput: ' + rate + ' loans/sec');
        console.log('  Total Gas: ' + result.totalGas.toString().toLocaleString());
        console.log('');

        totalSuccess += result.success;
        totalFailed += result.failed;
        totalGas += result.totalGas;
    }

    console.log('─'.repeat(70));
    console.log('AGGREGATE RESULTS:');
    console.log('  Total Success: ' + totalSuccess + '/' + TARGET);
    console.log('  Total Failed: ' + totalFailed);
    console.log('  Success Rate: ' + (totalSuccess/(totalSuccess+totalFailed)*100).toFixed(2) + '%');
    console.log('  Total Duration: ' + testDuration.toFixed(1) + 's (' + (testDuration/60).toFixed(2) + 'm)');
    console.log('  Total Gas: ' + totalGas.toString().toLocaleString());
    console.log('');
    console.log('  **THROUGHPUT: ' + (totalSuccess / testDuration).toFixed(2) + ' loans/sec**');
    console.log('  **HOURLY RATE: ' + Math.round(totalSuccess / testDuration * 3600).toLocaleString() + ' loans/hour**');
    console.log('  **DAILY CAPACITY: ' + Math.round(totalSuccess / testDuration * 86400).toLocaleString() + ' loans/day**');
    console.log('');

    if (totalSuccess >= 1000) {
        console.log('🎉 SUCCESS: Processed 1,000+ loans!\n');
    } else if (totalSuccess >= 500) {
        console.log('✅ EXCELLENT: Processed ' + totalSuccess + ' loans!\n');
    } else {
        console.log('⚠️  Reached ' + totalSuccess + ' loans\n');
    }

    // Save results
    const reportPath = './quantity-test-fresh-agents-' + totalSuccess + 'loans-' + Date.now() + '.json';
    fs.writeFileSync(reportPath, JSON.stringify({
        network: 'arc-testnet',
        target: TARGET,
        agents: config.agents.length,
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
    process.exit(1);
});
