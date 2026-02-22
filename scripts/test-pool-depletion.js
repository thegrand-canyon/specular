/**
 * Test Pool Depletion
 *
 * Request multiple loans to deplete pool and verify limit enforcement
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://sepolia.base.org';
const AGENT_KEY = process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000';

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║    POOL DEPLETION TEST                          ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const agent = new ethers.Wallet(AGENT_KEY, provider);

    console.log(`Agent: ${agent.address}\n`);

    const addresses = JSON.parse(
        fs.readFileSync('./src/config/base-sepolia-addresses.json', 'utf8')
    );

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
    const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');
    const usdcAbi = loadAbi('MockUSDC');

    const registry = new ethers.Contract(addresses.AgentRegistryV2, registryAbi, provider);
    const marketplace = new ethers.Contract(addresses.AgentLiquidityMarketplace, marketplaceAbi, agent);
    const usdc = new ethers.Contract(addresses.MockUSDC, usdcAbi, agent);

    // Check initial pool state
    const agentId = await registry.addressToAgentId(agent.address);
    const poolBefore = await marketplace.getAgentPool(agentId);

    console.log('═'.repeat(70));
    console.log('INITIAL POOL STATE');
    console.log('═'.repeat(70) + '\n');

    console.log(`Available Liquidity: ${ethers.formatUnits(poolBefore.availableLiquidity, 6)} USDC`);
    console.log(`Total Loaned: ${ethers.formatUnits(poolBefore.totalLoaned, 6)} USDC\n`);

    const availableLiquidity = Number(poolBefore.availableLiquidity) / 1e6;

    // Approve USDC once
    console.log('Approving USDC for collateral...');
    let nonce = await provider.getTransactionCount(agent.address);
    const approveTx = await usdc.approve(
        addresses.AgentLiquidityMarketplace,
        ethers.parseUnits('100000', 6),
        { nonce }
    );
    await approveTx.wait();
    console.log('✅ Approved\n');

    // Request loans in increments
    const loanAmounts = [];
    let totalBorrowed = 0;
    const maxLoans = 10; // Safety limit
    let loanCount = 0;

    console.log('═'.repeat(70));
    console.log('REQUESTING LOANS UNTIL POOL DEPLETES');
    console.log('═'.repeat(70) + '\n');

    // Start with smaller loans, then try larger ones
    const testAmounts = [200, 300, 500, 700, 1000];

    for (const loanAmount of testAmounts) {
        if (loanCount >= maxLoans) {
            console.log('⚠️  Reached maximum loan count (10)\n');
            break;
        }

        if (totalBorrowed >= availableLiquidity * 0.95) {
            console.log('⚠️  Nearly depleted pool (95%+)\n');
            break;
        }

        console.log(`Requesting ${loanAmount} USDC...`);

        try {
            nonce = await provider.getTransactionCount(agent.address);
            const tx = await marketplace.requestLoan(
                ethers.parseUnits(loanAmount.toString(), 6),
                7,
                { nonce }
            );
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

            console.log(`  ✅ Approved (Loan ID: ${loanId})`);
            loanAmounts.push({ id: loanId, amount: loanAmount });
            totalBorrowed += loanAmount;
            loanCount++;

            // Check pool after each loan
            const poolNow = await marketplace.getAgentPool(agentId);
            const remaining = Number(poolNow.availableLiquidity) / 1e6;
            console.log(`  Pool remaining: ${remaining.toFixed(2)} USDC\n`);

        } catch (error) {
            console.log(`  ❌ REJECTED: ${error.message.split('\n')[0]}\n`);
            break;
        }
    }

    // Check final pool state
    console.log('═'.repeat(70));
    console.log('FINAL POOL STATE');
    console.log('═'.repeat(70) + '\n');

    const poolAfter = await marketplace.getAgentPool(agentId);
    console.log(`Available Liquidity: ${ethers.formatUnits(poolAfter.availableLiquidity, 6)} USDC`);
    console.log(`Total Loaned: ${ethers.formatUnits(poolAfter.totalLoaned, 6)} USDC`);
    console.log(`Utilization: ${((Number(poolAfter.totalLoaned) / Number(poolBefore.totalLiquidity)) * 100).toFixed(1)}%\n`);

    // Try one more loan that should fail
    console.log('═'.repeat(70));
    console.log('TESTING: LOAN WHEN POOL IS DEPLETED');
    console.log('═'.repeat(70) + '\n');

    const remainingLiquidity = Number(poolAfter.availableLiquidity) / 1e6;
    const excessLoan = Math.ceil(remainingLiquidity) + 100;

    console.log(`Remaining: ${remainingLiquidity.toFixed(2)} USDC`);
    console.log(`Requesting: ${excessLoan} USDC (should fail)\n`);

    try {
        nonce = await provider.getTransactionCount(agent.address);
        const tx = await marketplace.requestLoan(
            ethers.parseUnits(excessLoan.toString(), 6),
            7,
            { nonce }
        );
        await tx.wait();
        console.log('❌ UNEXPECTED: Loan approved when pool should be depleted!\n');
    } catch (error) {
        console.log('✅ PASS: Loan correctly rejected due to insufficient liquidity\n');
    }

    // Summary
    console.log('═'.repeat(70));
    console.log('SUMMARY');
    console.log('═'.repeat(70) + '\n');

    console.log(`Total loans created: ${loanCount}`);
    console.log(`Total borrowed: ${totalBorrowed.toFixed(2)} USDC`);
    console.log(`Pool utilization: ${((Number(poolAfter.totalLoaned) / Number(poolBefore.totalLiquidity)) * 100).toFixed(1)}%`);
    console.log(`\nLoans created:`);
    for (const loan of loanAmounts) {
        console.log(`  Loan #${loan.id}: ${loan.amount} USDC`);
    }
    console.log('');

    console.log('═'.repeat(70));
    console.log('✅ POOL DEPLETION TEST COMPLETE');
    console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n❌ Test failed:', err.message);
    console.error(err);
    process.exit(1);
});
