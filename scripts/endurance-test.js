/**
 * Endurance Test
 *
 * Tests protocol stability under continuous load:
 * - 20 rapid sequential loan requests
 * - Track success rate, gas costs, and timing
 * - Monitor pool accounting accuracy
 * - Immediate repayment of each loan
 */

const { ethers } = require('ethers');
const fs = require('fs');

const NETWORK = process.env.NETWORK || 'arc';
const LOAN_COUNT = parseInt(process.env.LOAN_COUNT || '20');
const LOAN_AMOUNT = parseInt(process.env.LOAN_AMOUNT || '50');

const RPC_URLS = {
    arc: 'https://arc-testnet.drpc.org',
    base: 'https://sepolia.base.org',
};

const AGENT_KEY = process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000';

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(`║    ENDURANCE TEST - ${NETWORK.toUpperCase().padEnd(27)}║`);
    console.log('╚══════════════════════════════════════════════════╝\n');

    const RPC_URL = RPC_URLS[NETWORK];
    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const agent = new ethers.Wallet(AGENT_KEY, provider);

    console.log(`Network: ${NETWORK === 'arc' ? 'Arc Testnet' : 'Base Sepolia'}`);
    console.log(`Agent: ${agent.address}`);
    console.log(`Target: ${LOAN_COUNT} loans × ${LOAN_AMOUNT} USDC\n`);

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
    const approveTx = await usdc.approve(addresses[k.marketplace], ethers.parseUnits('100000', 6));
    await approveTx.wait();
    console.log('✅ Approved\n');

    console.log('═'.repeat(70));
    console.log(`ENDURANCE TEST: ${LOAN_COUNT} SEQUENTIAL LOANS`);
    console.log('═'.repeat(70) + '\n');

    const testStart = Date.now();
    const results = [];
    let successCount = 0;
    let failCount = 0;
    let totalRequestGas = 0;
    let totalRepayGas = 0;
    let totalRequestTime = 0;
    let totalRepayTime = 0;

    for (let i = 0; i < LOAN_COUNT; i++) {
        const cycleNum = i + 1;
        process.stdout.write(`Cycle ${cycleNum}/${LOAN_COUNT}: `);

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

            const totalCycleTime = Date.now() - requestStart;

            process.stdout.write(`✅ Loan #${loanId} (${requestTime + repayTime}ms, Gas: ${Number(requestReceipt.gasUsed) + Number(repayReceipt.gasUsed)})\n`);

            successCount++;
            totalRequestGas += Number(requestReceipt.gasUsed);
            totalRepayGas += Number(repayReceipt.gasUsed);
            totalRequestTime += requestTime;
            totalRepayTime += repayTime;

            results.push({
                cycle: cycleNum,
                success: true,
                loanId,
                requestGas: Number(requestReceipt.gasUsed),
                repayGas: Number(repayReceipt.gasUsed),
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

    console.log('');

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

    console.log(`Total Duration: ${(testDuration / 1000).toFixed(2)}s`);
    console.log(`Success Rate: ${successCount}/${LOAN_COUNT} (${(successCount / LOAN_COUNT * 100).toFixed(1)}%)`);
    console.log(`Failed: ${failCount}\n`);

    if (successCount > 0) {
        console.log('Gas Costs:');
        console.log(`  Avg Request: ${Math.round(totalRequestGas / successCount).toLocaleString()}`);
        console.log(`  Avg Repay: ${Math.round(totalRepayGas / successCount).toLocaleString()}`);
        console.log(`  Avg Total: ${Math.round((totalRequestGas + totalRepayGas) / successCount).toLocaleString()}`);
        console.log(`  Total Gas Used: ${(totalRequestGas + totalRepayGas).toLocaleString()}\n`);

        console.log('Timing:');
        console.log(`  Avg Request: ${Math.round(totalRequestTime / successCount)}ms`);
        console.log(`  Avg Repay: ${Math.round(totalRepayTime / successCount)}ms`);
        console.log(`  Avg Cycle: ${Math.round((totalRequestTime + totalRepayTime) / successCount)}ms`);
        console.log(`  Throughput: ${(successCount / (testDuration / 1000)).toFixed(2)} cycles/sec\n`);

        console.log('Interest:');
        const earnedPerLoan = earnedDiff / successCount;
        const earnedPct = (earnedPerLoan / (LOAN_AMOUNT * 1e6)) * 100;
        console.log(`  Per Loan: ${ethers.formatUnits(Math.round(earnedPerLoan), 6)} USDC`);
        console.log(`  Percentage: ${earnedPct.toFixed(4)}% of loan amount\n`);
    }

    console.log('Pool Accounting Validation:');
    const expectedLoaned = 0; // All repaid
    const actualLoaned = Number(poolAfter.totalLoaned) / 1e6;
    const accountingOk = Math.abs(expectedLoaned - actualLoaned) < 0.01;
    console.log(`  Expected Loaned: ${expectedLoaned} USDC`);
    console.log(`  Actual Loaned: ${actualLoaned} USDC`);
    console.log(`  ${accountingOk ? '✅' : '❌'} Accounting ${accountingOk ? 'Accurate' : 'ERROR'}\n`);

    console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n❌ Endurance test failed:', err.message);
    console.error(err);
    process.exit(1);
});
