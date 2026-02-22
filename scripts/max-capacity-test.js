/**
 * Maximum Capacity Test
 *
 * Tests maximum pool capacity and large loans:
 * 1. Supply large liquidity (10,000 USDC+)
 * 2. Test maximum loan sizes
 * 3. Test near-credit-limit loans
 * 4. Validate pool handles large volumes
 */

const { ethers } = require('ethers');
const fs = require('fs');

const NETWORK = process.env.NETWORK || 'arc';
const LIQUIDITY_AMOUNT = parseInt(process.env.LENDER_SUPPLY || '10000');
const LOAN_AMOUNT = parseInt(process.env.LOAN_AMOUNT || '5000');
const LOAN_COUNT = parseInt(process.env.LOAN_COUNT || '3');

const RPC_URLS = {
    arc: 'https://arc-testnet.drpc.org',
    base: 'https://sepolia.base.org',
};

const AGENT_KEY = process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000';
const LENDER_KEY = 'process.env.TEST_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'';

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(`║    MAX CAPACITY TEST - ${NETWORK.toUpperCase().padEnd(25)}║`);
    console.log('╚══════════════════════════════════════════════════╝\n');

    const RPC_URL = RPC_URLS[NETWORK];
    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const agent = new ethers.Wallet(AGENT_KEY, provider);
    const lender = new ethers.Wallet(LENDER_KEY, provider);

    console.log(`Network: ${NETWORK === 'arc' ? 'Arc Testnet' : 'Base Sepolia'}`);
    console.log(`Agent (Borrower): ${agent.address}`);
    console.log(`Lender: ${lender.address}`);
    console.log(`Liquidity to Supply: ${LIQUIDITY_AMOUNT.toLocaleString()} USDC`);
    console.log(`Loan Amount: ${LOAN_AMOUNT.toLocaleString()} USDC`);
    console.log(`Loan Count: ${LOAN_COUNT}\n`);

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
    const marketplaceLender = new ethers.Contract(addresses[k.marketplace], marketplaceAbi, lender);
    const marketplaceAgent = new ethers.Contract(addresses[k.marketplace], marketplaceAbi, agent);
    const usdcLender = new ethers.Contract(addresses[k.usdc], usdcAbi, lender);
    const usdcAgent = new ethers.Contract(addresses[k.usdc], usdcAbi, agent);

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

    // Check current pool
    const poolBefore = await marketplaceAgent.getAgentPool(agentId);
    console.log('Current Pool:');
    console.log(`  Total Liquidity: ${ethers.formatUnits(poolBefore.totalLiquidity, 6)} USDC`);
    console.log(`  Available: ${ethers.formatUnits(poolBefore.availableLiquidity, 6)} USDC`);
    console.log(`  Total Loaned: ${ethers.formatUnits(poolBefore.totalLoaned, 6)} USDC\n`);

    // Supply large liquidity
    console.log('═'.repeat(70));
    console.log('SUPPLYING LARGE LIQUIDITY');
    console.log('═'.repeat(70) + '\n');

    console.log(`Checking lender USDC balance...`);
    const lenderBalance = await usdcLender.balanceOf(lender.address);
    console.log(`Lender has: ${ethers.formatUnits(lenderBalance, 6)} USDC\n`);

    if (Number(lenderBalance) < LIQUIDITY_AMOUNT * 1e6) {
        console.log(`Minting ${LIQUIDITY_AMOUNT} USDC to lender...`);
        // If lender doesn't have enough, would need to mint more
        console.log('⚠️  Insufficient USDC for liquidity supply\n');
        console.log('Proceeding with available liquidity...\n');
    }

    console.log('Approving USDC...');
    const approveTx = await usdcLender.approve(addresses[k.marketplace], ethers.parseUnits(LIQUIDITY_AMOUNT.toString(), 6));
    await approveTx.wait();
    console.log('✅ Approved\n');

    console.log(`Supplying ${LIQUIDITY_AMOUNT} USDC to pool...`);
    try {
        const supplyTx = await marketplaceLender.supplyLiquidity(
            agentId,
            ethers.parseUnits(LIQUIDITY_AMOUNT.toString(), 6)
        );
        const receipt = await supplyTx.wait();
        console.log(`✅ Supplied (Gas: ${receipt.gasUsed.toString()})\n`);
    } catch (error) {
        console.log(`❌ Supply failed: ${error.message.split('\n')[0]}\n`);
        console.log('Proceeding with current pool liquidity...\n');
    }

    // Check updated pool
    const poolAfterSupply = await marketplaceAgent.getAgentPool(agentId);
    console.log('Pool After Liquidity Supply:');
    console.log(`  Total Liquidity: ${ethers.formatUnits(poolAfterSupply.totalLiquidity, 6)} USDC`);
    console.log(`  Available: ${ethers.formatUnits(poolAfterSupply.availableLiquidity, 6)} USDC`);
    console.log(`  Total Loaned: ${ethers.formatUnits(poolAfterSupply.totalLoaned, 6)} USDC\n`);

    const availableLiquidity = Number(poolAfterSupply.availableLiquidity) / 1e6;
    const creditLimitUSDC = Number(creditLimit) / 1e6;
    const maxLoan = Math.min(availableLiquidity, creditLimitUSDC);

    console.log(`Max Possible Loan: ${maxLoan.toFixed(2)} USDC\n`);

    // Test large loans
    console.log('═'.repeat(70));
    console.log('TESTING LARGE LOANS');
    console.log('═'.repeat(70) + '\n');

    // Approve USDC for agent
    console.log('Approving USDC for agent...');
    const approveAgentTx = await usdcAgent.approve(addresses[k.marketplace], ethers.parseUnits('100000', 6));
    await approveAgentTx.wait();
    console.log('✅ Approved\n');

    const loans = [];
    const loanAmountToUse = Math.min(LOAN_AMOUNT, maxLoan);

    for (let i = 0; i < LOAN_COUNT; i++) {
        console.log(`Large Loan ${i + 1}/${LOAN_COUNT}: ${loanAmountToUse.toFixed(2)} USDC`);

        try {
            const loanTx = await marketplaceAgent.requestLoan(
                ethers.parseUnits(loanAmountToUse.toString(), 6),
                7
            );
            const receipt = await loanTx.wait();

            let loanId;
            for (const log of receipt.logs) {
                try {
                    const parsed = marketplaceAgent.interface.parseLog(log);
                    if (parsed && parsed.name === 'LoanRequested') {
                        loanId = Number(parsed.args.loanId);
                        break;
                    }
                } catch {}
            }

            console.log(`  ✅ Approved (ID: ${loanId}, Gas: ${receipt.gasUsed.toString()})\n`);
            loans.push(loanId);

        } catch (error) {
            console.log(`  ❌ Failed: ${error.message.split('\n')[0]}\n`);
        }

        // Check pool after each loan
        const currentPool = await marketplaceAgent.getAgentPool(agentId);
        const utilization = (Number(currentPool.totalLoaned) / Number(currentPool.totalLiquidity)) * 100;
        console.log(`  Pool Utilization: ${utilization.toFixed(2)}%`);
        console.log(`  Available: ${ethers.formatUnits(currentPool.availableLiquidity, 6)} USDC\n`);
    }

    // Check final pool state
    const poolFinal = await marketplaceAgent.getAgentPool(agentId);
    console.log('═'.repeat(70));
    console.log('POOL STATE UNDER MAXIMUM LOAD');
    console.log('═'.repeat(70) + '\n');

    console.log(`Total Liquidity: ${ethers.formatUnits(poolFinal.totalLiquidity, 6)} USDC`);
    console.log(`Available: ${ethers.formatUnits(poolFinal.availableLiquidity, 6)} USDC`);
    console.log(`Total Loaned: ${ethers.formatUnits(poolFinal.totalLoaned, 6)} USDC`);
    console.log(`Utilization: ${(Number(poolFinal.totalLoaned) / Number(poolFinal.totalLiquidity) * 100).toFixed(2)}%\n`);

    // Repay all loans
    console.log('═'.repeat(70));
    console.log('REPAYING ALL LARGE LOANS');
    console.log('═'.repeat(70) + '\n');

    for (const loanId of loans) {
        console.log(`Repaying loan #${loanId}...`);

        try {
            const repayTx = await marketplaceAgent.repayLoan(loanId);
            const receipt = await repayTx.wait();
            console.log(`  ✅ Repaid (Gas: ${receipt.gasUsed.toString()})\n`);
        } catch (error) {
            console.log(`  ❌ Failed: ${error.message.split('\n')[0]}\n`);
        }
    }

    // Final state
    const poolEnd = await marketplaceAgent.getAgentPool(agentId);
    console.log('═'.repeat(70));
    console.log('FINAL STATE');
    console.log('═'.repeat(70) + '\n');

    console.log(`Total Liquidity: ${ethers.formatUnits(poolEnd.totalLiquidity, 6)} USDC`);
    console.log(`Available: ${ethers.formatUnits(poolEnd.availableLiquidity, 6)} USDC`);
    console.log(`Total Loaned: ${ethers.formatUnits(poolEnd.totalLoaned, 6)} USDC`);
    console.log(`Total Earned: ${ethers.formatUnits(poolEnd.totalEarned, 6)} USDC\n`);

    console.log('Test Summary:');
    console.log(`  Liquidity Supplied: ${LIQUIDITY_AMOUNT} USDC (attempted)`);
    console.log(`  Large Loans Created: ${loans.length}/${LOAN_COUNT}`);
    console.log(`  Loan Size: ${loanAmountToUse.toFixed(2)} USDC each`);
    console.log(`  Total Borrowed: ${(loans.length * loanAmountToUse).toFixed(2)} USDC`);
    console.log(`  All Loans Repaid: ${Number(poolEnd.totalLoaned) === 0 ? '✅ Yes' : '❌ No'}\n`);

    console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n❌ Max capacity test failed:', err.message);
    console.error(err);
    process.exit(1);
});
