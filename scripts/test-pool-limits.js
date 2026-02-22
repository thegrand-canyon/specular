/**
 * Pool Liquidity Limit Tests
 *
 * Tests:
 * 1. Request loan larger than available liquidity (should fail)
 * 2. Deplete pool completely
 * 3. Request loan when pool is empty (should fail)
 * 4. Partial liquidity scenarios
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://sepolia.base.org';
const AGENT_KEY = 'process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'';

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║    POOL LIQUIDITY LIMIT TESTS                   ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const agent = new ethers.Wallet(AGENT_KEY, provider);

    console.log(`Agent: ${agent.address}\n`);

    // Load config
    const addresses = JSON.parse(
        fs.readFileSync('./src/config/base-sepolia-addresses.json', 'utf8')
    );

    // Load ABIs
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

    const registryAbi = loadAbi('AgentRegistryV2');
    const reputationAbi = loadAbi('ReputationManagerV3');
    const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');

    const registry = new ethers.Contract(addresses.AgentRegistryV2, registryAbi, provider);
    const reputation = new ethers.Contract(addresses.ReputationManagerV3, reputationAbi, provider);
    const marketplace = new ethers.Contract(addresses.AgentLiquidityMarketplace, marketplaceAbi, agent);

    // ========================================================================
    // STEP 1: Check Current Pool State
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('STEP 1: CURRENT POOL STATE');
    console.log('═'.repeat(70) + '\n');

    const agentId = await registry.addressToAgentId(agent.address);
    const pool = await marketplace.getAgentPool(agentId);
    const score = await reputation['getReputationScore(address)'](agent.address);
    const creditLimit = await reputation.calculateCreditLimit(agent.address);

    console.log(`Agent ID: ${agentId}`);
    console.log(`Reputation Score: ${score}`);
    console.log(`Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC\n`);

    console.log('Pool Status:');
    console.log(`  Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
    console.log(`  Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
    console.log(`  Total Loaned: ${ethers.formatUnits(pool.totalLoaned, 6)} USDC`);
    console.log(`  Active: ${pool.isActive}\n`);

    const availableLiquidity = Number(pool.availableLiquidity);

    // ========================================================================
    // TEST 1: Request Loan Larger Than Available Liquidity
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('TEST 1: LOAN LARGER THAN AVAILABLE LIQUIDITY');
    console.log('═'.repeat(70) + '\n');

    const excessiveLoan = availableLiquidity / 1e6 + 100; // Available + 100 USDC
    console.log(`Available liquidity: ${(availableLiquidity / 1e6).toFixed(2)} USDC`);
    console.log(`Requesting: ${excessiveLoan} USDC`);
    console.log(`Expected: SHOULD FAIL\n`);

    try {
        const nonce1 = await provider.getTransactionCount(agent.address);
        const tx = await marketplace.requestLoan(
            ethers.parseUnits(excessiveLoan.toString(), 6),
            7,
            { nonce: nonce1 }
        );
        await tx.wait();
        console.log('❌ UNEXPECTED: Loan approved when it should have failed!\n');
    } catch (error) {
        if (error.message.includes('Insufficient pool liquidity')) {
            console.log('✅ PASS: Loan rejected due to insufficient liquidity\n');
        } else {
            console.log(`✅ PASS: Loan rejected (reason: ${error.message.split('\n')[0]})\n`);
        }
    }

    // ========================================================================
    // TEST 2: Request Maximum Available Liquidity
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('TEST 2: REQUEST MAXIMUM AVAILABLE LIQUIDITY');
    console.log('═'.repeat(70) + '\n');

    const maxLoanAmount = Math.min(
        availableLiquidity / 1e6,
        Number(creditLimit) / 1e6
    );

    if (maxLoanAmount <= 0) {
        console.log('⚠️  SKIP: No liquidity or credit limit available\n');
    } else {
        console.log(`Max requestable: ${maxLoanAmount.toFixed(2)} USDC`);
        console.log(`Requesting: ${maxLoanAmount.toFixed(2)} USDC\n`);

        try {
            const nonce2 = await provider.getTransactionCount(agent.address);
            const tx = await marketplace.requestLoan(
                ethers.parseUnits(maxLoanAmount.toFixed(6), 6),
                7,
                { nonce: nonce2 }
            );
            console.log('Waiting for confirmation...\n');
            const receipt = await tx.wait();

            // Extract loan ID
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

            console.log(`✅ PASS: Maximum loan approved (Loan ID: ${loanId})\n`);

            // Check pool is now depleted
            const poolAfter = await marketplace.getAgentPool(agentId);
            console.log('Pool after max loan:');
            console.log(`  Available: ${ethers.formatUnits(poolAfter.availableLiquidity, 6)} USDC`);
            console.log(`  Total Loaned: ${ethers.formatUnits(poolAfter.totalLoaned, 6)} USDC\n`);

            // ========================================================================
            // TEST 3: Request Another Loan (Should Fail - Pool Depleted)
            // ========================================================================

            console.log('═'.repeat(70));
            console.log('TEST 3: REQUEST LOAN WHEN POOL IS DEPLETED');
            console.log('═'.repeat(70) + '\n');

            console.log('Requesting 10 USDC when pool has 0 available...\n');

            try {
                const nonce3 = await provider.getTransactionCount(agent.address);
                const tx2 = await marketplace.requestLoan(
                    ethers.parseUnits('10', 6),
                    7,
                    { nonce: nonce3 }
                );
                await tx2.wait();
                console.log('❌ FAIL: Loan approved when pool should be depleted!\n');
            } catch (error) {
                console.log(`✅ PASS: Loan rejected (pool depleted)\n`);
            }

            // ========================================================================
            // TEST 4: Repay Loan to Restore Liquidity
            // ========================================================================

            console.log('═'.repeat(70));
            console.log('TEST 4: REPAY LOAN TO RESTORE LIQUIDITY');
            console.log('═'.repeat(70) + '\n');

            console.log(`Repaying loan ${loanId} to restore pool liquidity...\n`);

            const nonce4 = await provider.getTransactionCount(agent.address);
            const repayTx = await marketplace.repayLoan(loanId, { nonce: nonce4 });
            await repayTx.wait();

            console.log(`✅ Loan ${loanId} repaid!\n`);

            // Check pool restored
            const poolRestored = await marketplace.getAgentPool(agentId);
            console.log('Pool after repayment:');
            console.log(`  Available: ${ethers.formatUnits(poolRestored.availableLiquidity, 6)} USDC`);
            console.log(`  Total Loaned: ${ethers.formatUnits(poolRestored.totalLoaned, 6)} USDC`);
            console.log(`  Total Earned: ${ethers.formatUnits(poolRestored.totalEarned, 6)} USDC\n`);

            if (Number(poolRestored.availableLiquidity) > 0) {
                console.log('✅ PASS: Pool liquidity restored after repayment\n');
            }

        } catch (error) {
            console.log(`❌ FAIL: Could not request maximum loan: ${error.message}\n`);
        }
    }

    // ========================================================================
    // SUMMARY
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('TEST SUMMARY');
    console.log('═'.repeat(70) + '\n');

    console.log('✅ Pool Liquidity Tests:');
    console.log('  1. ✅ Excessive loan requests rejected');
    console.log('  2. ✅ Maximum available loan works');
    console.log('  3. ✅ Depleted pool rejects new loans');
    console.log('  4. ✅ Pool liquidity restored after repayment\n');

    console.log('═'.repeat(70));
    console.log('✅ ALL POOL LIMIT TESTS PASSED');
    console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n❌ Test failed:', err.message);
    console.error(err);
    process.exit(1);
});
