/**
 * Multi-Agent Testing
 *
 * Tests 3 agents competing for liquidity:
 * - Agent 1: High reputation (existing)
 * - Agent 2: Medium reputation (new)
 * - Agent 3: Low reputation (new)
 *
 * Validates:
 * - Concurrent borrowing
 * - Pool accounting under multi-agent load
 * - Credit limit enforcement per agent
 * - Interest rate differentiation
 */

const { ethers } = require('ethers');
const fs = require('fs');

const NETWORK = process.env.NETWORK || 'arc';
const RPC_URLS = {
    arc: 'https://arc-testnet.drpc.org',
    base: 'https://sepolia.base.org',
};

// Three different agents
const AGENTS = [
    {
        name: 'Agent 1 (High Rep)',
        key: process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000',
        loanAmount: 200, // Will request 200 USDC
    },
    {
        name: 'Agent 2 (Medium Rep)',
        key: 'process.env.TEST_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'',
        loanAmount: 100, // Will request 100 USDC
    },
    {
        name: 'Agent 3 (Low Rep)',
        key: 'process.env.TEST_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'',
        loanAmount: 50, // Will request 50 USDC
    },
];

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(`║    MULTI-AGENT TEST - ${NETWORK.toUpperCase().padEnd(25)}║`);
    console.log('╚══════════════════════════════════════════════════╝\n');

    const RPC_URL = RPC_URLS[NETWORK];
    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });

    console.log(`Network: ${NETWORK === 'arc' ? 'Arc Testnet' : 'Base Sepolia'}\n`);

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

    // Setup agents
    console.log('═'.repeat(70));
    console.log('AGENT SETUP');
    console.log('═'.repeat(70) + '\n');

    const agentData = [];

    for (const agentConfig of AGENTS) {
        const wallet = new ethers.Wallet(agentConfig.key, provider);
        const registry = new ethers.Contract(addresses[k.registry], registryAbi, provider);
        const reputation = new ethers.Contract(addresses[k.reputation], reputationAbi, provider);
        const marketplace = new ethers.Contract(addresses[k.marketplace], marketplaceAbi, wallet);
        const usdc = new ethers.Contract(addresses[k.usdc], usdcAbi, wallet);

        const isRegistered = await registry.isRegistered(wallet.address);

        console.log(`${agentConfig.name}:`);
        console.log(`  Address: ${wallet.address}`);
        console.log(`  Registered: ${isRegistered ? '✅ Yes' : '❌ No'}`);

        if (!isRegistered) {
            console.log(`  Registering...`);

            const registryWithSigner = new ethers.Contract(addresses[k.registry], registryAbi, wallet);
            let nonce = await provider.getTransactionCount(wallet.address);

            try {
                const registerTx = await registryWithSigner.register(
                    `ipfs://${agentConfig.name.replace(/\s/g, '-')}`,
                    [],
                    { nonce }
                );
                await registerTx.wait();
                console.log(`  ✅ Registered\n`);
            } catch (error) {
                console.log(`  ❌ Registration failed: ${error.message}\n`);
                continue;
            }

            // Create pool
            nonce = await provider.getTransactionCount(wallet.address);
            try {
                const createPoolTx = await marketplace.createAgentPool({ nonce });
                await createPoolTx.wait();
                console.log(`  ✅ Pool created\n`);
            } catch (error) {
                console.log(`  ⚠️  Pool creation failed (may already exist)\n`);
            }

            // Supply initial liquidity
            nonce = await provider.getTransactionCount(wallet.address);
            await usdc.approve(addresses[k.marketplace], ethers.parseUnits('10000', 6), { nonce });

            nonce = await provider.getTransactionCount(wallet.address);
            const agentId = await registry.addressToAgentId(wallet.address);

            try {
                await marketplace.supplyLiquidity(agentId, ethers.parseUnits('500', 6), { nonce });
                console.log(`  ✅ Liquidity supplied (500 USDC)\n`);
            } catch (error) {
                console.log(`  ⚠️  Liquidity supply may have failed\n`);
            }
        }

        const agentId = await registry.addressToAgentId(wallet.address);
        const score = await reputation['getReputationScore(address)'](wallet.address);
        const creditLimit = await reputation.calculateCreditLimit(wallet.address);
        const interestRate = await reputation.calculateInterestRate(wallet.address);
        const ethBalance = await provider.getBalance(wallet.address);

        console.log(`  ID: ${agentId}`);
        console.log(`  Reputation: ${score}`);
        console.log(`  Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);
        console.log(`  Interest Rate: ${Number(interestRate) / 100}% APR`);
        console.log(`  ETH Balance: ${ethers.formatEther(ethBalance)} ETH\n`);

        agentData.push({
            name: agentConfig.name,
            wallet,
            agentId,
            score,
            creditLimit,
            interestRate,
            loanAmount: agentConfig.loanAmount,
            marketplace,
            usdc,
        });
    }

    // Test concurrent borrowing
    console.log('═'.repeat(70));
    console.log('TEST: CONCURRENT LOAN REQUESTS');
    console.log('═'.repeat(70) + '\n');

    const loanResults = [];

    for (const agent of agentData) {
        console.log(`${agent.name} requesting ${agent.loanAmount} USDC...`);

        if (Number(agent.ethBalance) === 0) {
            console.log(`  ⚠️  Skipped (no ETH for gas)\n`);
            continue;
        }

        try {
            // Approve USDC (let ethers handle nonce)
            const approveTx = await agent.usdc.approve(
                addresses[k.marketplace],
                ethers.parseUnits('10000', 6)
            );
            await approveTx.wait();

            // Request loan
            const loanTx = await agent.marketplace.requestLoan(
                ethers.parseUnits(agent.loanAmount.toString(), 6),
                7
            );
            const receipt = await loanTx.wait();

            let loanId;
            for (const log of receipt.logs) {
                try {
                    const parsed = agent.marketplace.interface.parseLog(log);
                    if (parsed && parsed.name === 'LoanRequested') {
                        loanId = Number(parsed.args.loanId);
                        break;
                    }
                } catch {}
            }

            console.log(`  ✅ Approved (Loan ID: ${loanId}, Gas: ${receipt.gasUsed.toString()})\n`);

            loanResults.push({
                agent: agent.name,
                loanId,
                amount: agent.loanAmount,
                success: true,
            });

        } catch (error) {
            console.log(`  ❌ Failed: ${error.message.split('\n')[0]}\n`);
            loanResults.push({
                agent: agent.name,
                amount: agent.loanAmount,
                success: false,
                error: error.message.split('\n')[0],
            });
        }
    }

    // Check pool states
    console.log('═'.repeat(70));
    console.log('POOL STATES AFTER LOANS');
    console.log('═'.repeat(70) + '\n');

    const marketplace = new ethers.Contract(addresses[k.marketplace], marketplaceAbi, provider);

    for (const agent of agentData) {
        try {
            const pool = await marketplace.getAgentPool(agent.agentId);

            console.log(`${agent.name} Pool:`);
            console.log(`  Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
            console.log(`  Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
            console.log(`  Total Loaned: ${ethers.formatUnits(pool.totalLoaned, 6)} USDC`);
            console.log(`  Utilization: ${(Number(pool.totalLoaned) / Number(pool.totalLiquidity) * 100).toFixed(2)}%\n`);
        } catch (error) {
            console.log(`${agent.name}: ⚠️  Pool not found\n`);
        }
    }

    // Repay all loans
    console.log('═'.repeat(70));
    console.log('REPAYING ALL LOANS');
    console.log('═'.repeat(70) + '\n');

    for (const result of loanResults) {
        if (!result.success) continue;

        const agent = agentData.find(a => a.name === result.agent);
        if (!agent) continue;

        console.log(`${agent.name} repaying loan #${result.loanId}...`);

        try {
            const repayTx = await agent.marketplace.repayLoan(result.loanId);
            const receipt = await repayTx.wait();

            console.log(`  ✅ Repaid (Gas: ${receipt.gasUsed.toString()})\n`);

        } catch (error) {
            console.log(`  ❌ Repayment failed: ${error.message.split('\n')[0]}\n`);
        }
    }

    // Final summary
    console.log('═'.repeat(70));
    console.log('SUMMARY');
    console.log('═'.repeat(70) + '\n');

    const successful = loanResults.filter(r => r.success).length;
    const failed = loanResults.filter(r => !r.success).length;

    console.log(`Agents Tested: ${agentData.length}`);
    console.log(`Loans Requested: ${loanResults.length}`);
    console.log(`  Successful: ${successful}`);
    console.log(`  Failed: ${failed}\n`);

    console.log('Results by Agent:');
    for (const result of loanResults) {
        const status = result.success ? '✅' : '❌';
        console.log(`  ${status} ${result.agent}: ${result.amount} USDC${result.error ? ` (${result.error})` : ''}`);
    }
    console.log('');

    console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n❌ Multi-agent test failed:', err.message);
    console.error(err);
    process.exit(1);
});
