/**
 * Large Scale Testing
 *
 * High volume testing:
 * - 100 sequential loan cycles (configurable)
 * - Performance monitoring
 * - Gas tracking
 * - Pool health validation
 * - Detailed statistics
 */

const { ethers } = require('ethers');
const fs = require('fs');

const NETWORK = process.env.NETWORK || 'arc';
const LOAN_COUNT = parseInt(process.env.LOAN_COUNT || '100');
const LOAN_AMOUNT = parseInt(process.env.LOAN_AMOUNT || '50');
const REPORT_INTERVAL = 10; // Report every N loans

const RPC_URLS = {
    arc: 'https://arc-testnet.drpc.org',
    base: 'https://sepolia.base.org',
};

const AGENT_KEY = 'process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'';

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(`║    LARGE SCALE TEST - ${NETWORK.toUpperCase().padEnd(26)}║`);
    console.log('╚══════════════════════════════════════════════════╝\n');

    const RPC_URL = RPC_URLS[NETWORK];
    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const agent = new ethers.Wallet(AGENT_KEY, provider);

    console.log(`Network: ${NETWORK === 'arc' ? 'Arc Testnet' : 'Base Sepolia'}`);
    console.log(`Agent: ${agent.address}`);
    console.log(`Target: ${LOAN_COUNT} loans × ${LOAN_AMOUNT} USDC`);
    console.log(`Total Volume: ${LOAN_COUNT * LOAN_AMOUNT} USDC\n`);

    const configPath = NETWORK === 'arc'
        ? './src/config/arc-testnet-addresses.json'
        : './src/config/base-sepolia-addresses.json';

    const addresses = JSON.parse(fs.readFileSync(configPath, 'utf8'));

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

    const keys = {
        arc: {
            registry: 'agentRegistryV2',
            reputation: 'reputationManagerV3',
            marketplace: 'agentLiquidityMarketplace',
            usdc: 'mockUSDC',
        },
        base: {
            registry: 'AgentRegistryV2',
            reputation: 'ReputationManagerV3',
            marketplace: 'AgentLiquidityMarketplace',
            usdc: 'MockUSDC',
        },
    };

    const k = keys[NETWORK];

    const registryAbi = loadAbi('AgentRegistryV2');
    const reputationAbi = loadAbi('ReputationManagerV3');
    const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');
    const usdcAbi = loadAbi('MockUSDC');

    const registry = new ethers.Contract(addresses[k.registry], registryAbi, provider);
    const reputation = new ethers.Contract(addresses[k.reputation], reputationAbi, provider);
    const marketplace = new ethers.Contract(addresses[k.marketplace], marketplaceAbi, agent);
    const usdc = new ethers.Contract(addresses[k.usdc], usdcAbi, agent);

    const isRegistered = await registry.isRegistered(agent.address);
    if (!isRegistered) {
        console.log('❌ Agent not registered\n');
        return;
    }

    const agentId = await registry.addressToAgentId(agent.address);
    const creditLimit = await reputation.calculateCreditLimit(agent.address);
    const scoreBefore = await reputation['getReputationScore(address)'](agent.address);

    console.log('═'.repeat(70));
    console.log('INITIAL STATE');
    console.log('═'.repeat(70) + '\n');

    console.log(`Agent ID: ${agentId}`);
    console.log(`Reputation: ${scoreBefore}`);
    console.log(`Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC\n`);

    const poolBefore = await marketplace.getAgentPool(agentId);
    console.log('Pool Status:');
    console.log(`  Total Liquidity: ${ethers.formatUnits(poolBefore.totalLiquidity, 6)} USDC`);
    console.log(`  Available: ${ethers.formatUnits(poolBefore.availableLiquidity, 6)} USDC`);
    console.log(`  Total Loaned: ${ethers.formatUnits(poolBefore.totalLoaned, 6)} USDC`);
    console.log(`  Total Earned: ${ethers.formatUnits(poolBefore.totalEarned, 6)} USDC\n`);

    // Approve USDC
    console.log('Approving USDC...\n');
    const approveTx = await usdc.approve(addresses[k.marketplace], ethers.parseUnits('1000000', 6));
    await approveTx.wait();
    console.log('✅ Approved\n');

    console.log('═'.repeat(70));
    console.log(`LARGE SCALE TEST: ${LOAN_COUNT} SEQUENTIAL LOANS`);
    console.log('═'.repeat(70) + '\n');

    const testStart = Date.now();
    const results = [];
    let successCount = 0;
    let failCount = 0;
    let totalRequestGas = 0n;
    let totalRepayGas = 0n;
    let totalRequestTime = 0;
    let totalRepayTime = 0;

    // Track min/max for statistics
    let minRequestGas = Infinity;
    let maxRequestGas = 0;
    let minRepayGas = Infinity;
    let maxRepayGas = 0;
    let minCycleTime = Infinity;
    let maxCycleTime = 0;

    for (let i = 0; i < LOAN_COUNT; i++) {
        const cycleNum = i + 1;

        // Progress indicator
        if (cycleNum % REPORT_INTERVAL === 0 || cycleNum === 1) {
            const elapsed = (Date.now() - testStart) / 1000;
            const rate = cycleNum / elapsed;
            const eta = ((LOAN_COUNT - cycleNum) / rate / 60).toFixed(1);
            console.log(`\n[Progress: ${cycleNum}/${LOAN_COUNT} | ${(cycleNum/LOAN_COUNT*100).toFixed(1)}% | ETA: ${eta}m]`);
        }

        process.stdout.write(`${cycleNum}. `);

        try {
            // Request loan
            const requestStart = Date.now();
            const loanTx = await marketplace.requestLoan(
                ethers.parseUnits(LOAN_AMOUNT.toString(), 6),
                7
            );
            const requestReceipt = await loanTx.wait();
            const requestTime = Date.now() - requestStart;

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

            // Repay loan immediately
            const repayStart = Date.now();
            const repayTx = await marketplace.repayLoan(loanId);
            const repayReceipt = await repayTx.wait();
            const repayTime = Date.now() - repayStart;

            const totalCycleTime = requestTime + repayTime;
            const reqGas = requestReceipt.gasUsed;
            const repGas = repayReceipt.gasUsed;

            process.stdout.write(`✅ ${totalCycleTime}ms\n`);

            successCount++;
            totalRequestGas += reqGas;
            totalRepayGas += repGas;
            totalRequestTime += requestTime;
            totalRepayTime += repayTime;

            // Track min/max
            const reqGasNum = Number(reqGas);
            const repGasNum = Number(repGas);
            minRequestGas = Math.min(minRequestGas, reqGasNum);
            maxRequestGas = Math.max(maxRequestGas, reqGasNum);
            minRepayGas = Math.min(minRepayGas, repGasNum);
            maxRepayGas = Math.max(maxRepayGas, repGasNum);
            minCycleTime = Math.min(minCycleTime, totalCycleTime);
            maxCycleTime = Math.max(maxCycleTime, totalCycleTime);

            results.push({
                cycle: cycleNum,
                success: true,
                loanId,
                requestGas: reqGasNum,
                repayGas: repGasNum,
                requestTime,
                repayTime,
                totalTime: totalCycleTime,
            });

        } catch (error) {
            const errorMsg = error.message.split('\n')[0].substring(0, 60);
            process.stdout.write(`❌ ${errorMsg}\n`);

            failCount++;
            results.push({
                cycle: cycleNum,
                success: false,
                error: errorMsg,
            });
        }
    }

    const testDuration = Date.now() - testStart;

    console.log('\n');

    // Final state
    console.log('═'.repeat(70));
    console.log('FINAL STATE');
    console.log('═'.repeat(70) + '\n');

    const scoreAfter = await reputation['getReputationScore(address)'](agent.address);
    const poolAfter = await marketplace.getAgentPool(agentId);

    console.log(`Reputation: ${scoreBefore} → ${scoreAfter} (${Number(scoreAfter) - Number(scoreBefore) > 0 ? '+' : ''}${Number(scoreAfter) - Number(scoreBefore)})`);
    console.log('');

    console.log('Pool Status:');
    console.log(`  Total Liquidity: ${ethers.formatUnits(poolAfter.totalLiquidity, 6)} USDC`);
    console.log(`  Available: ${ethers.formatUnits(poolAfter.availableLiquidity, 6)} USDC`);
    console.log(`  Total Loaned: ${ethers.formatUnits(poolAfter.totalLoaned, 6)} USDC`);
    console.log(`  Total Earned: ${ethers.formatUnits(poolAfter.totalEarned, 6)} USDC`);

    const earnedDiff = Number(poolAfter.totalEarned) - Number(poolBefore.totalEarned);
    console.log(`  Earned This Test: ${ethers.formatUnits(earnedDiff, 6)} USDC\n`);

    // Statistics
    console.log('═'.repeat(70));
    console.log('TEST STATISTICS');
    console.log('═'.repeat(70) + '\n');

    console.log(`Total Duration: ${(testDuration / 1000).toFixed(2)}s (${(testDuration / 60000).toFixed(2)}m)`);
    console.log(`Success Rate: ${successCount}/${LOAN_COUNT} (${(successCount / LOAN_COUNT * 100).toFixed(2)}%)`);
    console.log(`Failed: ${failCount}\n`);

    if (successCount > 0) {
        const avgReqGas = Number(totalRequestGas) / successCount;
        const avgRepGas = Number(totalRepayGas) / successCount;
        const totalGas = Number(totalRequestGas + totalRepayGas);

        console.log('Gas Costs:');
        console.log(`  Total Gas Used: ${totalGas.toLocaleString()}`);
        console.log(`  Avg Request: ${Math.round(avgReqGas).toLocaleString()}`);
        console.log(`  Avg Repay: ${Math.round(avgRepGas).toLocaleString()}`);
        console.log(`  Avg Total: ${Math.round(avgReqGas + avgRepGas).toLocaleString()}`);
        console.log(`  Min Request: ${minRequestGas.toLocaleString()}`);
        console.log(`  Max Request: ${maxRequestGas.toLocaleString()}`);
        console.log(`  Min Repay: ${minRepayGas.toLocaleString()}`);
        console.log(`  Max Repay: ${maxRepayGas.toLocaleString()}\n`);

        console.log('Timing:');
        console.log(`  Avg Request: ${Math.round(totalRequestTime / successCount)}ms`);
        console.log(`  Avg Repay: ${Math.round(totalRepayTime / successCount)}ms`);
        console.log(`  Avg Cycle: ${Math.round((totalRequestTime + totalRepayTime) / successCount)}ms`);
        console.log(`  Min Cycle: ${minCycleTime}ms`);
        console.log(`  Max Cycle: ${maxCycleTime}ms`);
        console.log(`  Throughput: ${(successCount / (testDuration / 1000)).toFixed(2)} cycles/sec\n`);

        console.log('Interest:');
        const earnedPerLoan = earnedDiff / successCount;
        const earnedPct = (earnedPerLoan / (LOAN_AMOUNT * 1e6)) * 100;
        console.log(`  Total: ${ethers.formatUnits(earnedDiff, 6)} USDC`);
        console.log(`  Per Loan: ${ethers.formatUnits(Math.round(earnedPerLoan), 6)} USDC`);
        console.log(`  Percentage: ${earnedPct.toFixed(4)}% of loan amount\n`);

        console.log('Volume:');
        console.log(`  Total Borrowed: ${(successCount * LOAN_AMOUNT).toLocaleString()} USDC`);
        console.log(`  Total Repaid: ${(successCount * LOAN_AMOUNT).toLocaleString()} USDC`);
        console.log(`  Total Interest: ${ethers.formatUnits(earnedDiff, 6)} USDC`);
        console.log(`  Pool Utilization (peak): ${((LOAN_AMOUNT / (Number(poolBefore.totalLiquidity) / 1e6)) * 100).toFixed(2)}%\n`);
    }

    console.log('Pool Accounting Validation:');
    const expectedLoaned = 0; // All repaid
    const actualLoaned = Number(poolAfter.totalLoaned) / 1e6;
    const accountingOk = Math.abs(expectedLoaned - actualLoaned) < 0.01;
    console.log(`  Expected Loaned: ${expectedLoaned} USDC`);
    console.log(`  Actual Loaned: ${actualLoaned} USDC`);
    console.log(`  ${accountingOk ? '✅' : '❌'} Accounting ${accountingOk ? 'Accurate' : 'ERROR'}\n`);

    // Failure analysis
    if (failCount > 0) {
        console.log('Failure Analysis:');
        const errorTypes = {};
        results.filter(r => !r.success).forEach(r => {
            const key = r.error.substring(0, 40);
            errorTypes[key] = (errorTypes[key] || 0) + 1;
        });
        for (const [error, count] of Object.entries(errorTypes)) {
            console.log(`  ${count}x ${error}`);
        }
        console.log('');
    }

    console.log('═'.repeat(70) + '\n');

    // Save detailed results
    const reportPath = `./test-results-${NETWORK}-${LOAN_COUNT}loans-${Date.now()}.json`;
    fs.writeFileSync(reportPath, JSON.stringify({
        network: NETWORK,
        loanCount: LOAN_COUNT,
        loanAmount: LOAN_AMOUNT,
        successCount,
        failCount,
        testDuration,
        totalGas: totalGas.toString(),
        results,
        poolBefore: {
            totalLiquidity: poolBefore.totalLiquidity.toString(),
            availableLiquidity: poolBefore.availableLiquidity.toString(),
            totalLoaned: poolBefore.totalLoaned.toString(),
            totalEarned: poolBefore.totalEarned.toString(),
        },
        poolAfter: {
            totalLiquidity: poolAfter.totalLiquidity.toString(),
            availableLiquidity: poolAfter.availableLiquidity.toString(),
            totalLoaned: poolAfter.totalLoaned.toString(),
            totalEarned: poolAfter.totalEarned.toString(),
        },
    }, null, 2));

    console.log(`📊 Detailed results saved to: ${reportPath}\n`);
}

main().catch(err => {
    console.error('\n❌ Large scale test failed:', err.message);
    console.error(err);
    process.exit(1);
});
