const { ethers } = require('ethers');
const fs = require('fs');

const addresses = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8'));

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
const usdcAbi = loadAbi('MockUSDC');

const agents = [
    { name: 'Main Agent', key: 'process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'' },
    { name: 'Fresh 1', key: '0x47471cb7a2ba033f2085a82050ff16248ff3a9e5d9ea17ddb0f5d2f208e043ad' },
    { name: 'Fresh 2', key: '0x41adb1d6ef22647a3de0e7993f4e33ec7bcd5b49359587967750ff8f3faddf67' },
    { name: 'Fresh 3', key: '0xebd981dcdb6f6f4c8744a40a937f7b75de400290c58c2728cfff0d2af2418452' }
];

const LOAN_AMOUNT = ethers.parseUnits((process.env.LOAN_AMOUNT || '20'), 6);
const DURATION_DAYS = parseInt(process.env.DURATION_DAYS || '30');
const MAX_CYCLES = parseInt(process.env.MAX_CYCLES || '1000');
const CYCLE_DELAY = parseInt(process.env.CYCLE_DELAY || '100'); // ms between cycles

let globalStats = {
    totalLoans: 0,
    successfulLoans: 0,
    failedLoans: 0,
    totalGasUsed: 0n,
    startTime: Date.now(),
    errors: {}
};

function recordError(error) {
    const msg = error.message.split('\n')[0];
    globalStats.errors[msg] = (globalStats.errors[msg] || 0) + 1;
}

async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runAgentCycles(agent, agentIndex) {
    const provider = new ethers.JsonRpcProvider(
        process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
        undefined,
        { batchMaxCount: 1 }
    );

    const wallet = new ethers.Wallet(agent.key, provider);
    const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, mpAbi, wallet);
    const usdc = new ethers.Contract(addresses.mockUSDC, usdcAbi, wallet);

    const stats = {
        loans: 0,
        successful: 0,
        failed: 0,
        gasUsed: 0n
    };

    console.log(`[${agent.name}] Starting at ${wallet.address}`);

    // Approve USDC once at start for all operations (includes both collateral and repayments)
    const maxApproval = ethers.parseUnits('1000000', 6); // 1M USDC approval
    const approveTx = await usdc.approve(addresses.agentLiquidityMarketplace, maxApproval);
    await approveTx.wait();
    console.log(`[${agent.name}] Approved ${ethers.formatUnits(maxApproval, 6)} USDC`);

    for (let cycle = 0; cycle < MAX_CYCLES; cycle++) {
        try {
            // Request loan (collateral handled automatically by contract)
            const borrowTx = await marketplace.requestLoan(
                LOAN_AMOUNT,
                DURATION_DAYS,
                { gasLimit: 1000000 }
            );
            const borrowReceipt = await borrowTx.wait();
            stats.gasUsed += borrowReceipt.gasUsed;

            // Parse loan ID from event
            const borrowEvent = borrowReceipt.logs
                .map(log => {
                    try {
                        return marketplace.interface.parseLog(log);
                    } catch {
                        return null;
                    }
                })
                .find(e => e && e.name === 'LoanRequested');

            if (!borrowEvent) {
                throw new Error('LoanRequested event not found');
            }

            const loanId = borrowEvent.args.loanId;

            // Calculate repayment amount
            const loan = await marketplace.loans(loanId);
            const repayAmount = loan.principal + loan.interest;

            // Repay loan (approval already done)
            const repayTx = await marketplace.repayLoan(loanId, { gasLimit: 1000000 });
            const repayReceipt = await repayTx.wait();
            stats.gasUsed += repayReceipt.gasUsed;

            stats.loans++;
            stats.successful++;
            globalStats.totalLoans++;
            globalStats.successfulLoans++;
            globalStats.totalGasUsed += stats.gasUsed;

            if (stats.successful % 10 === 0) {
                const elapsed = (Date.now() - globalStats.startTime) / 1000;
                const rate = globalStats.totalLoans / elapsed;
                console.log(`[${agent.name}] ${stats.successful} loans | Global: ${globalStats.totalLoans} (${rate.toFixed(2)}/s)`);
            }

            // Small delay to avoid overwhelming RPC
            if (CYCLE_DELAY > 0) {
                await sleep(CYCLE_DELAY);
            }

        } catch (error) {
            stats.failed++;
            globalStats.failedLoans++;
            recordError(error);

            // Back off on repeated errors
            if (error.code === 'TIMEOUT' || error.message.includes('timeout')) {
                console.log(`[${agent.name}] RPC timeout, backing off...`);
                await sleep(2000);
            }

            // Stop if running out of ETH
            if (error.message.includes('insufficient funds')) {
                console.log(`[${agent.name}] Out of ETH, stopping`);
                break;
            }

            // Stop if too many consecutive errors
            if (stats.failed > stats.successful && stats.failed > 5) {
                console.log(`[${agent.name}] Too many errors, stopping`);
                break;
            }
        }
    }

    console.log(`[${agent.name}] Finished: ${stats.successful} successful, ${stats.failed} failed`);
    return stats;
}

async function main() {
    console.log('=== ARC TESTNET LOAD TEST ===\n');
    console.log(`Loan amount: ${ethers.formatUnits(LOAN_AMOUNT, 6)} USDC`);
    console.log(`Duration: ${DURATION_DAYS} days`);
    console.log(`Max cycles per agent: ${MAX_CYCLES}`);
    console.log(`Agents: ${agents.length}`);
    console.log(`Cycle delay: ${CYCLE_DELAY}ms\n`);

    const startTime = Date.now();

    // Run all agents in parallel
    const agentPromises = agents.map((agent, i) => runAgentCycles(agent, i));
    const agentStats = await Promise.all(agentPromises);

    const totalTime = (Date.now() - startTime) / 1000;

    console.log('\n=== LOAD TEST COMPLETE ===\n');
    console.log(`Total time: ${totalTime.toFixed(2)}s`);
    console.log(`Total loans: ${globalStats.totalLoans}`);
    console.log(`Successful: ${globalStats.successfulLoans}`);
    console.log(`Failed: ${globalStats.failedLoans}`);
    console.log(`Success rate: ${((globalStats.successfulLoans / globalStats.totalLoans) * 100).toFixed(2)}%`);
    console.log(`Throughput: ${(globalStats.totalLoans / totalTime).toFixed(2)} loans/second`);
    console.log(`Total gas: ${globalStats.totalGasUsed.toString()}`);
    console.log(`Avg gas per loan: ${(globalStats.totalGasUsed / BigInt(globalStats.successfulLoans || 1)).toString()}`);

    if (Object.keys(globalStats.errors).length > 0) {
        console.log('\nTop errors:');
        const sorted = Object.entries(globalStats.errors)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
        for (const [msg, count] of sorted) {
            console.log(`  ${count}x: ${msg}`);
        }
    }

    console.log('\nPer-agent stats:');
    agents.forEach((agent, i) => {
        const stats = agentStats[i];
        console.log(`  ${agent.name}: ${stats.successful} successful, ${stats.failed} failed`);
    });
}

main().catch(console.error);
