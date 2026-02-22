/**
 * Concurrent Load Test
 *
 * Tests multiple agents borrowing simultaneously:
 * - 3 agents with different pools
 * - Each agent runs 10 loan cycles
 * - All running concurrently (parallel)
 * - Total: 30 loans happening in parallel
 */

const { ethers } = require('ethers');
const fs = require('fs');

const NETWORK = process.env.NETWORK || 'arc';
const CYCLES_PER_AGENT = parseInt(process.env.CYCLES || '10');

const RPC_URLS = {
    arc: 'https://arc-testnet.drpc.org',
    base: 'https://sepolia.base.org',
};

const AGENTS = [
    {
        name: 'Agent 1',
        key: process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000',
        loanAmount: 100,
    },
    {
        name: 'Agent 2',
        key: 'process.env.TEST_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'',
        loanAmount: 50,
    },
    {
        name: 'Agent 3',
        key: 'process.env.TEST_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'',
        loanAmount: 75,
    },
];

async function runAgentCycles(agentConfig, provider, addresses, keys) {
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
        address: wallet.address,
        success: 0,
        failed: 0,
        totalGas: 0n,
        totalTime: 0,
        errors: [],
    };

    console.log(`[${agentConfig.name}] Starting ${CYCLES_PER_AGENT} cycles...`);

    // Approve USDC once
    try {
        const approveTx = await usdc.approve(addresses[keys.marketplace], ethers.parseUnits('100000', 6));
        await approveTx.wait();
    } catch (error) {
        console.log(`[${agentConfig.name}] ❌ Approval failed: ${error.message.split('\n')[0]}`);
        return results;
    }

    for (let i = 0; i < CYCLES_PER_AGENT; i++) {
        try {
            const cycleStart = Date.now();

            // Request loan
            const loanTx = await marketplace.requestLoan(
                ethers.parseUnits(agentConfig.loanAmount.toString(), 6),
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

            // Repay loan
            const repayTx = await marketplace.repayLoan(loanId);
            const repayReceipt = await repayTx.wait();

            const cycleTime = Date.now() - cycleStart;
            const gas = requestReceipt.gasUsed + repayReceipt.gasUsed;

            results.success++;
            results.totalGas += gas;
            results.totalTime += cycleTime;

            console.log(`[${agentConfig.name}] Cycle ${i + 1}/${CYCLES_PER_AGENT} ✅ (${cycleTime}ms, Gas: ${gas.toString()})`);

        } catch (error) {
            results.failed++;
            const errorMsg = error.message.split('\n')[0];
            results.errors.push(errorMsg);
            console.log(`[${agentConfig.name}] Cycle ${i + 1}/${CYCLES_PER_AGENT} ❌ ${errorMsg.substring(0, 60)}`);
        }
    }

    console.log(`[${agentConfig.name}] Completed: ${results.success}/${CYCLES_PER_AGENT} successful\n`);
    return results;
}

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(`║    CONCURRENT LOAD TEST - ${NETWORK.toUpperCase().padEnd(22)}║`);
    console.log('╚══════════════════════════════════════════════════╝\n');

    const RPC_URL = RPC_URLS[NETWORK];
    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });

    console.log(`Network: ${NETWORK === 'arc' ? 'Arc Testnet' : 'Base Sepolia'}`);
    console.log(`Agents: ${AGENTS.length}`);
    console.log(`Cycles per Agent: ${CYCLES_PER_AGENT}`);
    console.log(`Total Loans: ${AGENTS.length * CYCLES_PER_AGENT}\n`);

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
    console.log('STARTING CONCURRENT AGENT CYCLES');
    console.log('═'.repeat(70) + '\n');

    const testStart = Date.now();

    // Run all agents concurrently
    const agentPromises = AGENTS.map(agent =>
        runAgentCycles(agent, provider, addresses, k)
    );

    const agentResults = await Promise.all(agentPromises);

    const testDuration = Date.now() - testStart;

    console.log('═'.repeat(70));
    console.log('CONCURRENT LOAD TEST RESULTS');
    console.log('═'.repeat(70) + '\n');

    console.log(`Total Duration: ${(testDuration / 1000).toFixed(2)}s (${(testDuration / 60000).toFixed(2)}m)\n`);

    let totalSuccess = 0;
    let totalFailed = 0;
    let totalGas = 0n;

    console.log('Results by Agent:');
    console.log('-'.repeat(70));
    for (const result of agentResults) {
        const successRate = (result.success / CYCLES_PER_AGENT * 100).toFixed(1);
        const avgTime = result.success > 0 ? Math.round(result.totalTime / result.success) : 0;
        const avgGas = result.success > 0 ? Number(result.totalGas) / result.success : 0;

        console.log(`${result.agent} (${result.address.substring(0, 10)}...)`);
        console.log(`  Success: ${result.success}/${CYCLES_PER_AGENT} (${successRate}%)`);
        console.log(`  Failed: ${result.failed}`);
        console.log(`  Avg Time: ${avgTime}ms`);
        console.log(`  Avg Gas: ${Math.round(avgGas).toLocaleString()}`);
        console.log(`  Total Gas: ${result.totalGas.toString().toLocaleString()}`);

        if (result.errors.length > 0) {
            const uniqueErrors = [...new Set(result.errors)];
            console.log(`  Errors:`);
            for (const error of uniqueErrors) {
                const count = result.errors.filter(e => e === error).length;
                console.log(`    ${count}x ${error.substring(0, 50)}`);
            }
        }
        console.log('');

        totalSuccess += result.success;
        totalFailed += result.failed;
        totalGas += result.totalGas;
    }

    console.log('-'.repeat(70));
    console.log('Overall Statistics:');
    console.log(`  Total Loans: ${totalSuccess + totalFailed}`);
    console.log(`  Successful: ${totalSuccess}`);
    console.log(`  Failed: ${totalFailed}`);
    console.log(`  Success Rate: ${(totalSuccess / (totalSuccess + totalFailed) * 100).toFixed(2)}%`);
    console.log(`  Total Gas: ${totalGas.toString().toLocaleString()}`);
    console.log(`  Throughput: ${(totalSuccess / (testDuration / 1000)).toFixed(2)} loans/sec`);
    console.log(`  Avg per Agent: ${(totalSuccess / AGENTS.length).toFixed(1)} successful loans\n`);

    console.log('Concurrency Test:');
    const expectedSequentialTime = testDuration * AGENTS.length;
    const timesSaved = ((expectedSequentialTime / testDuration) - 1) * 100;
    console.log(`  ${AGENTS.length} agents ran concurrently`);
    console.log(`  Actual time: ${(testDuration / 1000).toFixed(2)}s`);
    console.log(`  Sequential would take: ~${(expectedSequentialTime / 1000).toFixed(2)}s`);
    console.log(`  Time saved: ~${timesSaved.toFixed(0)}% faster\n`);

    console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n❌ Concurrent load test failed:', err.message);
    console.error(err);
    process.exit(1);
});
