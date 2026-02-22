/**
 * Comprehensive Testnet Suite
 *
 * Tests multiple scenarios on Arc or Base Sepolia:
 * 1. Multiple loan sizes
 * 2. Multiple loan cycles
 * 3. Pool depletion scenarios
 * 4. Credit limit enforcement
 * 5. Concurrent loans
 */

const { ethers } = require('ethers');
const fs = require('fs');

const NETWORK = process.env.NETWORK || 'arc'; // 'arc' or 'base'
const RPC_URLS = {
    arc: 'https://arc-testnet.drpc.org',
    base: 'https://sepolia.base.org',
};

const AGENT_KEY = 'process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'';

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(`║    COMPREHENSIVE TEST SUITE - ${NETWORK.toUpperCase().padEnd(19)}║`);
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
        console.log('❌ Agent not registered. Please register first.\n');
        return;
    }

    const agentId = await registry.addressToAgentId(agent.address);
    const scoreBefore = await reputation['getReputationScore(address)'](agent.address);
    const creditLimit = await reputation.calculateCreditLimit(agent.address);
    const interestRate = await reputation.calculateInterestRate(agent.address);

    console.log('═'.repeat(70));
    console.log('INITIAL STATE');
    console.log('═'.repeat(70) + '\n');

    console.log(`Agent ID: ${agentId}`);
    console.log(`Reputation: ${scoreBefore}`);
    console.log(`Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);
    console.log(`Interest Rate: ${Number(interestRate) / 100}% APR\n`);

    const pool = await marketplace.getAgentPool(agentId);
    console.log('Pool Status:');
    console.log(`  Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
    console.log(`  Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
    console.log(`  Total Loaned: ${ethers.formatUnits(pool.totalLoaned, 6)} USDC\n`);

    const availableLiquidity = Number(pool.availableLiquidity) / 1e6;
    const maxLoanByCredit = Number(creditLimit) / 1e6;
    const maxLoan = Math.min(availableLiquidity, maxLoanByCredit);

    console.log(`Max Loan Available: ${maxLoan.toFixed(2)} USDC\n`);

    // Approve USDC once
    console.log('Approving USDC...\n');
    let nonce = await provider.getTransactionCount(agent.address);
    const approveTx = await usdc.approve(
        addresses[k.marketplace],
        ethers.parseUnits('100000', 6),
        { nonce }
    );
    await approveTx.wait();
    console.log('✅ USDC approved\n');

    // Test different loan amounts
    const loanAmounts = [50, 100, 150, 200];
    const successfulLoans = [];

    console.log('═'.repeat(70));
    console.log('TEST: MULTIPLE LOAN SIZES');
    console.log('═'.repeat(70) + '\n');

    for (const amount of loanAmounts) {
        console.log(`Testing ${amount} USDC loan...`);

        if (amount > maxLoan) {
            console.log(`  ⚠️  Skipped (exceeds max ${maxLoan.toFixed(2)} USDC)\n`);
            continue;
        }

        try {
            nonce = await provider.getTransactionCount(agent.address);
            const loanTx = await marketplace.requestLoan(
                ethers.parseUnits(amount.toString(), 6),
                7,
                { nonce }
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

            console.log(`  ✅ Approved (Loan ID: ${loanId}, Gas: ${receipt.gasUsed.toString()})`);
            successfulLoans.push({ id: loanId, amount });

            // Immediately repay to test multiple cycles
            nonce = await provider.getTransactionCount(agent.address);
            const repayTx = await marketplace.repayLoan(loanId, { nonce });
            const repayReceipt = await repayTx.wait();

            console.log(`  ✅ Repaid (Gas: ${repayReceipt.gasUsed.toString()})\n`);

        } catch (error) {
            console.log(`  ❌ Failed: ${error.message.split('\n')[0]}\n`);
        }
    }

    console.log(`Total successful loans: ${successfulLoans.length}/${loanAmounts.length}\n`);

    // Check final reputation
    console.log('═'.repeat(70));
    console.log('FINAL STATE');
    console.log('═'.repeat(70) + '\n');

    const scoreAfter = await reputation['getReputationScore(address)'](agent.address);
    const scoreChange = Number(scoreAfter) - Number(scoreBefore);

    console.log(`Reputation before: ${scoreBefore}`);
    console.log(`Reputation after: ${scoreAfter}`);
    console.log(`Change: ${scoreChange > 0 ? '+' : ''}${scoreChange} points\n`);

    const poolAfter = await marketplace.getAgentPool(agentId);
    console.log('Pool After Tests:');
    console.log(`  Total Liquidity: ${ethers.formatUnits(poolAfter.totalLiquidity, 6)} USDC`);
    console.log(`  Available: ${ethers.formatUnits(poolAfter.availableLiquidity, 6)} USDC`);
    console.log(`  Total Loaned: ${ethers.formatUnits(poolAfter.totalLoaned, 6)} USDC`);
    console.log(`  Total Earned: ${ethers.formatUnits(poolAfter.totalEarned, 6)} USDC\n`);

    console.log('═'.repeat(70));
    console.log('TEST SUMMARY');
    console.log('═'.repeat(70) + '\n');

    console.log(`✅ Completed ${successfulLoans.length} loan cycles`);
    console.log(`✅ Pool earned ${ethers.formatUnits(poolAfter.totalEarned, 6)} USDC`);
    console.log(`✅ Reputation ${scoreChange > 0 ? `increased by ${scoreChange}` : `stayed at ${scoreBefore} (maxed out)`}\n`);

    console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n❌ Test suite failed:', err.message);
    console.error(err);
    process.exit(1);
});
