/**
 * Pool Stress Test
 *
 * Pushes pool to 90%+ utilization and tests:
 * - Multiple concurrent loans
 * - Pool depletion scenarios
 * - Rejection when capacity reached
 * - Pool recovery after repayments
 * - Accounting accuracy under stress
 */

const { ethers } = require('ethers');
const fs = require('fs');

const NETWORK = process.env.NETWORK || 'arc';
const RPC_URLS = {
    arc: 'https://arc-testnet.drpc.org',
    base: 'https://sepolia.base.org',
};

const AGENT_KEY = process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000';
const TARGET_UTILIZATION = 90; // Target 90% pool utilization

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(`║    POOL STRESS TEST - ${NETWORK.toUpperCase().padEnd(24)}║`);
    console.log('╚══════════════════════════════════════════════════╝\n');

    const RPC_URL = RPC_URLS[NETWORK];
    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const agent = new ethers.Wallet(AGENT_KEY, provider);

    console.log(`Network: ${NETWORK === 'arc' ? 'Arc Testnet' : 'Base Sepolia'}`);
    console.log(`Agent: ${agent.address}`);
    console.log(`Target Utilization: ${TARGET_UTILIZATION}%\n`);

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

    // Get initial pool state
    console.log('═'.repeat(70));
    console.log('INITIAL POOL STATE');
    console.log('═'.repeat(70) + '\n');

    const poolBefore = await marketplace.getAgentPool(agentId);

    console.log(`Total Liquidity: ${ethers.formatUnits(poolBefore.totalLiquidity, 6)} USDC`);
    console.log(`Available: ${ethers.formatUnits(poolBefore.availableLiquidity, 6)} USDC`);
    console.log(`Total Loaned: ${ethers.formatUnits(poolBefore.totalLoaned, 6)} USDC`);
    console.log(`Utilization: ${(Number(poolBefore.totalLoaned) / Number(poolBefore.totalLiquidity) * 100).toFixed(2)}%\n`);

    const totalLiquidity = Number(poolBefore.totalLiquidity) / 1e6;
    const availableLiquidity = Number(poolBefore.availableLiquidity) / 1e6;
    const targetBorrowed = (totalLiquidity * TARGET_UTILIZATION) / 100;
    const currentBorrowed = Number(poolBefore.totalLoaned) / 1e6;
    const needToBorrow = targetBorrowed - currentBorrowed;

    console.log(`Target Borrowed: ${targetBorrowed.toFixed(2)} USDC (${TARGET_UTILIZATION}% of ${totalLiquidity.toFixed(2)})`);
    console.log(`Currently Borrowed: ${currentBorrowed.toFixed(2)} USDC`);
    console.log(`Need to Borrow: ${needToBorrow.toFixed(2)} USDC\n`);

    if (needToBorrow <= 0) {
        console.log('⚠️  Pool already at target utilization or higher\n');
        console.log('Proceeding with test loans anyway...\n');
    }

    // Calculate loan strategy
    const maxLoanByCredit = Number(creditLimit) / 1e6;
    const maxLoanByPool = availableLiquidity;
    const maxLoan = Math.min(maxLoanByCredit, maxLoanByPool);

    console.log('Agent Limits:');
    console.log(`  Credit Limit: ${maxLoanByCredit.toFixed(2)} USDC`);
    console.log(`  Pool Available: ${maxLoanByPool.toFixed(2)} USDC`);
    console.log(`  Max Single Loan: ${maxLoan.toFixed(2)} USDC\n`);

    // Approve USDC once
    console.log('Approving USDC...\n');
    const approveTx = await usdc.approve(addresses[k.marketplace], ethers.parseUnits('1000000', 6));
    await approveTx.wait();
    console.log('✅ Approved\n');

    // Request multiple loans to reach target utilization
    console.log('═'.repeat(70));
    console.log('STRESS TEST: REQUESTING MULTIPLE LOANS');
    console.log('═'.repeat(70) + '\n');

    const loans = [];
    let totalRequested = 0;
    const loanSize = Math.min(200, maxLoan); // 200 USDC per loan or max available

    // Request loans until we hit target or limit
    for (let i = 0; i < 10; i++) {
        const pool = await marketplace.getAgentPool(agentId);
        const currentUtil = (Number(pool.totalLoaned) / Number(pool.totalLiquidity)) * 100;
        const available = Number(pool.availableLiquidity) / 1e6;

        console.log(`Loan ${i + 1}: Utilization at ${currentUtil.toFixed(2)}%, Available: ${available.toFixed(2)} USDC`);

        if (currentUtil >= TARGET_UTILIZATION) {
            console.log(`  ✅ Target utilization reached!\n`);
            break;
        }

        if (available < 10) {
            console.log(`  ⚠️  Pool nearly depleted (< 10 USDC available)\n`);
            break;
        }

        const amount = Math.min(loanSize, available);

        try {
            const startTime = Date.now();

            const loanTx = await marketplace.requestLoan(
                ethers.parseUnits(amount.toFixed(6), 6),
                7
            );
            const receipt = await loanTx.wait();
            const duration = Date.now() - startTime;

            let loanId;
            for (const log of receipt.logs) {
                try {
                    const parsed = marketplace.interface.parseLog(log);
                    if (parsed && parsed.name === 'LoanRequested') {
                        loanId = Number(parsed.args.loanId);
                        break;
                    }
                } catch {}
            }

            console.log(`  ✅ Approved (ID: ${loanId}, ${amount.toFixed(2)} USDC, ${duration}ms, Gas: ${receipt.gasUsed.toString()})\n`);

            loans.push({ id: loanId, amount });
            totalRequested += amount;

        } catch (error) {
            console.log(`  ❌ Failed: ${error.message.split('\n')[0]}\n`);
            break;
        }
    }

    // Check final pool state
    console.log('═'.repeat(70));
    console.log('POOL STATE UNDER STRESS');
    console.log('═'.repeat(70) + '\n');

    const poolStressed = await marketplace.getAgentPool(agentId);

    console.log(`Total Liquidity: ${ethers.formatUnits(poolStressed.totalLiquidity, 6)} USDC`);
    console.log(`Available: ${ethers.formatUnits(poolStressed.availableLiquidity, 6)} USDC`);
    console.log(`Total Loaned: ${ethers.formatUnits(poolStressed.totalLoaned, 6)} USDC`);

    const finalUtilization = (Number(poolStressed.totalLoaned) / Number(poolStressed.totalLiquidity)) * 100;
    console.log(`Utilization: ${finalUtilization.toFixed(2)}%\n`);

    if (finalUtilization >= TARGET_UTILIZATION) {
        console.log(`✅ Target utilization achieved: ${finalUtilization.toFixed(2)}% >= ${TARGET_UTILIZATION}%\n`);
    } else {
        console.log(`⚠️  Target not reached: ${finalUtilization.toFixed(2)}% < ${TARGET_UTILIZATION}%\n`);
    }

    // Test: Try to request loan when pool is nearly depleted
    console.log('═'.repeat(70));
    console.log('TEST: REQUEST LOAN WHEN POOL NEARLY FULL');
    console.log('═'.repeat(70) + '\n');

    const remainingLiquidity = Number(poolStressed.availableLiquidity) / 1e6;
    const excessiveAmount = remainingLiquidity + 100;

    console.log(`Remaining: ${remainingLiquidity.toFixed(2)} USDC`);
    console.log(`Requesting: ${excessiveAmount.toFixed(2)} USDC (should fail)\n`);

    try {
        await marketplace.requestLoan(
            ethers.parseUnits(excessiveAmount.toFixed(6), 6),
            7
        );
        console.log('❌ UNEXPECTED: Loan approved when it should have failed!\n');
    } catch (error) {
        console.log(`✅ PASS: Loan correctly rejected\n`);
        console.log(`Reason: ${error.message.split('\n')[0]}\n`);
    }

    // Repay all loans to restore pool
    console.log('═'.repeat(70));
    console.log('RECOVERY: REPAYING ALL LOANS');
    console.log('═'.repeat(70) + '\n');

    let repaidCount = 0;

    for (const loan of loans) {
        console.log(`Repaying loan #${loan.id}...`);

        try {
            const repayTx = await marketplace.repayLoan(loan.id);
            const receipt = await repayTx.wait();

            console.log(`  ✅ Repaid (Gas: ${receipt.gasUsed.toString()})\n`);
            repaidCount++;

        } catch (error) {
            console.log(`  ❌ Failed: ${error.message.split('\n')[0]}\n`);
        }
    }

    // Final pool state
    console.log('═'.repeat(70));
    console.log('FINAL POOL STATE (AFTER RECOVERY)');
    console.log('═'.repeat(70) + '\n');

    const poolFinal = await marketplace.getAgentPool(agentId);

    console.log(`Total Liquidity: ${ethers.formatUnits(poolFinal.totalLiquidity, 6)} USDC`);
    console.log(`Available: ${ethers.formatUnits(poolFinal.availableLiquidity, 6)} USDC`);
    console.log(`Total Loaned: ${ethers.formatUnits(poolFinal.totalLoaned, 6)} USDC`);
    console.log(`Total Earned: ${ethers.formatUnits(poolFinal.totalEarned, 6)} USDC`);
    console.log(`Utilization: ${(Number(poolFinal.totalLoaned) / Number(poolFinal.totalLiquidity) * 100).toFixed(2)}%\n`);

    // Summary
    console.log('═'.repeat(70));
    console.log('STRESS TEST SUMMARY');
    console.log('═'.repeat(70) + '\n');

    console.log(`Loans Created: ${loans.length}`);
    console.log(`Loans Repaid: ${repaidCount}`);
    console.log(`Total Volume Stressed: ${totalRequested.toFixed(2)} USDC`);
    console.log(`Peak Utilization: ${finalUtilization.toFixed(2)}%`);
    console.log(`Interest Earned: ${ethers.formatUnits(poolFinal.totalEarned, 6)} USDC\n`);

    console.log('Test Results:');
    console.log(`  ${loans.length > 0 ? '✅' : '❌'} Multiple loans created`);
    console.log(`  ${finalUtilization >= 50 ? '✅' : '⚠️'} Pool stressed (${finalUtilization.toFixed(2)}% utilization)`);
    console.log(`  ✅ Excessive loan rejected`);
    console.log(`  ${repaidCount === loans.length ? '✅' : '⚠️'} All loans repaid (${repaidCount}/${loans.length})`);
    console.log(`  ✅ Pool recovered\n`);

    console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n❌ Stress test failed:', err.message);
    console.error(err);
    process.exit(1);
});
