/**
 * Edge Case Testing
 *
 * Tests extreme scenarios:
 * 1. Very small loans (1 USDC)
 * 2. Very large loans (near credit limit)
 * 3. Minimum duration loans (1 day)
 * 4. Maximum duration loans (365 days)
 * 5. Exact credit limit loan
 * 6. Over credit limit (should fail)
 */

const { ethers } = require('ethers');
const fs = require('fs');

const NETWORK = process.env.NETWORK || 'arc';
const RPC_URLS = {
    arc: 'https://arc-testnet.drpc.org',
    base: 'https://sepolia.base.org',
};

const AGENT_KEY = 'process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'';

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(`║    EDGE CASE TEST - ${NETWORK.toUpperCase().padEnd(28)}║`);
    console.log('╚══════════════════════════════════════════════════╝\n');

    const RPC_URL = RPC_URLS[NETWORK];
    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const agent = new ethers.Wallet(AGENT_KEY, provider);

    console.log(`Network: ${NETWORK === 'arc' ? 'Arc Testnet' : 'Base Sepolia'}`);
    console.log(`Agent: ${agent.address}\n`);

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
    const score = await reputation['getReputationScore(address)'](agent.address);

    console.log('═'.repeat(70));
    console.log('AGENT INFO');
    console.log('═'.repeat(70) + '\n');

    console.log(`Agent ID: ${agentId}`);
    console.log(`Reputation: ${score}`);
    console.log(`Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC\n`);

    const pool = await marketplace.getAgentPool(agentId);
    console.log('Pool Status:');
    console.log(`  Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
    console.log(`  Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
    console.log(`  Total Loaned: ${ethers.formatUnits(pool.totalLoaned, 6)} USDC\n`);

    // Approve USDC
    console.log('Approving USDC...\n');
    const approveTx = await usdc.approve(addresses[k.marketplace], ethers.parseUnits('100000', 6));
    await approveTx.wait();
    console.log('✅ Approved\n');

    const availableLiquidity = Number(pool.availableLiquidity) / 1e6;
    const creditLimitUSDC = Number(creditLimit) / 1e6;
    const maxLoan = Math.min(availableLiquidity, creditLimitUSDC);

    // Test cases
    const tests = [
        {
            name: 'Minimum loan (1 USDC)',
            amount: 1,
            duration: 7,
            shouldPass: true,
        },
        {
            name: 'Very small loan (0.01 USDC)',
            amount: 0.01,
            duration: 7,
            shouldPass: true, // May fail if there's a minimum
        },
        {
            name: 'Large loan (80% of credit limit)',
            amount: Math.floor(creditLimitUSDC * 0.8),
            duration: 7,
            shouldPass: availableLiquidity >= creditLimitUSDC * 0.8,
        },
        {
            name: 'Exact credit limit',
            amount: creditLimitUSDC,
            duration: 7,
            shouldPass: availableLiquidity >= creditLimitUSDC,
        },
        {
            name: 'Over credit limit (should fail)',
            amount: creditLimitUSDC + 1,
            duration: 7,
            shouldPass: false,
        },
        {
            name: 'Minimum duration (1 day)',
            amount: 10,
            duration: 1,
            shouldPass: true,
        },
        {
            name: 'Long duration (365 days)',
            amount: 10,
            duration: 365,
            shouldPass: true,
        },
    ];

    console.log('═'.repeat(70));
    console.log('EDGE CASE TESTING');
    console.log('═'.repeat(70) + '\n');

    const results = [];
    const successfulLoans = [];

    for (const test of tests) {
        console.log(`Test: ${test.name}`);
        console.log(`  Amount: ${test.amount} USDC, Duration: ${test.duration} days`);
        console.log(`  Expected: ${test.shouldPass ? 'PASS' : 'FAIL'}`);

        if (test.amount > maxLoan && test.shouldPass) {
            console.log(`  ⚠️  Skipped - exceeds max loan (${maxLoan.toFixed(2)} USDC)\n`);
            results.push({
                test: test.name,
                status: 'skipped',
                reason: 'Exceeds max loan',
            });
            continue;
        }

        try {
            const loanTx = await marketplace.requestLoan(
                ethers.parseUnits(test.amount.toFixed(6), 6),
                test.duration
            );
            const receipt = await loanTx.wait();

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

            const actualResult = 'PASS';
            const matchesExpected = test.shouldPass;

            console.log(`  ✅ ${actualResult} (Loan ID: ${loanId}, Gas: ${receipt.gasUsed.toString()})`);
            console.log(`  ${matchesExpected ? '✅' : '⚠️'} Matches expected result\n`);

            results.push({
                test: test.name,
                status: 'passed',
                loanId,
                gas: receipt.gasUsed.toString(),
                matchesExpected,
            });

            successfulLoans.push({ id: loanId, amount: test.amount });

        } catch (error) {
            const actualResult = 'FAIL';
            const matchesExpected = !test.shouldPass;
            const reason = error.message.split('\n')[0];

            console.log(`  ❌ ${actualResult}`);
            console.log(`  ${matchesExpected ? '✅' : '⚠️'} Matches expected result`);
            console.log(`  Reason: ${reason}\n`);

            results.push({
                test: test.name,
                status: 'failed',
                reason,
                matchesExpected,
            });
        }
    }

    // Repay all successful loans
    console.log('═'.repeat(70));
    console.log('CLEANUP: REPAYING LOANS');
    console.log('═'.repeat(70) + '\n');

    for (const loan of successfulLoans) {
        console.log(`Repaying loan #${loan.id} (${loan.amount} USDC)...`);

        try {
            const repayTx = await marketplace.repayLoan(loan.id);
            const receipt = await repayTx.wait();
            console.log(`  ✅ Repaid (Gas: ${receipt.gasUsed.toString()})\n`);
        } catch (error) {
            console.log(`  ❌ Failed: ${error.message.split('\n')[0]}\n`);
        }
    }

    // Summary
    console.log('═'.repeat(70));
    console.log('TEST SUMMARY');
    console.log('═'.repeat(70) + '\n');

    const passed = results.filter(r => r.status === 'passed').length;
    const failed = results.filter(r => r.status === 'failed').length;
    const skipped = results.filter(r => r.status === 'skipped').length;
    const matchedExpected = results.filter(r => r.matchesExpected).length;

    console.log(`Total Tests: ${tests.length}`);
    console.log(`  Passed: ${passed}`);
    console.log(`  Failed: ${failed}`);
    console.log(`  Skipped: ${skipped}`);
    console.log(`  Matched Expected: ${matchedExpected}/${tests.length - skipped}\n`);

    console.log('Results by Test:');
    for (const result of results) {
        const icon = result.status === 'passed' ? '✅' : result.status === 'failed' ? '❌' : '⚠️';
        const match = result.matchesExpected ? '✅' : '⚠️';
        console.log(`  ${icon} ${match} ${result.test}`);
    }
    console.log('');

    console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n❌ Edge case test failed:', err.message);
    console.error(err);
    process.exit(1);
});
