/**
 * Detailed Loan Audit for Arc Testnet
 *
 * Investigate pool accounting issue
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://arc-testnet.drpc.org';
const AGENT_ADDR = '0x656086A21073272533c8A3f56A94c1f3D8BCFcE2';

async function main() {
    console.log('\n🔍 DETAILED LOAN AUDIT - ARC TESTNET\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });

    const addresses = JSON.parse(
        fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8')
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

    const registry = new ethers.Contract(addresses.agentRegistryV2, registryAbi, provider);
    const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, marketplaceAbi, provider);

    const agentId = await registry.addressToAgentId(AGENT_ADDR);

    console.log('═'.repeat(80));
    console.log('INDIVIDUAL LOAN DETAILS');
    console.log('═'.repeat(80) + '\n');

    const states = ['REQUESTED', 'ACTIVE', 'REPAID', 'DEFAULTED'];
    const loansByState = { 0: [], 1: [], 2: [], 3: [] };

    let totalActiveAmount = 0n;
    let totalRepaidAmount = 0n;

    for (let i = 1; i <= 30; i++) {
        try {
            const loan = await marketplace.loans(i);

            if (loan.borrower.toLowerCase() !== AGENT_ADDR.toLowerCase()) {
                continue;
            }

            const state = Number(loan.state);
            const amount = Number(loan.amount);

            loansByState[state].push({
                id: i,
                amount: ethers.formatUnits(loan.amount, 6),
                state: states[state],
                rate: Number(loan.interestRate) / 100,
                duration: Number(loan.duration) / 86400,
                startTime: Number(loan.startTime),
                endTime: Number(loan.endTime),
            });

            if (state === 1) {
                totalActiveAmount += loan.amount;
            } else if (state === 2) {
                totalRepaidAmount += loan.amount;
            }

            console.log(`Loan #${i}:`);
            console.log(`  Borrower: ${loan.borrower}`);
            console.log(`  Amount: ${ethers.formatUnits(loan.amount, 6)} USDC`);
            console.log(`  State: ${states[state]} (${state})`);
            console.log(`  Interest Rate: ${Number(loan.interestRate) / 100}% APR`);
            console.log(`  Duration: ${Number(loan.duration) / 86400} days`);
            console.log(`  Pool ID: ${loan.poolId}`);

            if (loan.startTime > 0) {
                const start = new Date(Number(loan.startTime) * 1000);
                const end = new Date(Number(loan.endTime) * 1000);
                console.log(`  Started: ${start.toISOString()}`);
                console.log(`  Ends: ${end.toISOString()}`);

                const now = Math.floor(Date.now() / 1000);
                if (state === 1 && now > Number(loan.endTime)) {
                    console.log(`  ⚠️  OVERDUE: ${Math.floor((now - Number(loan.endTime)) / 86400)} days`);
                }
            }

            console.log('');

        } catch (e) {
            // No more loans
            break;
        }
    }

    console.log('═'.repeat(80));
    console.log('SUMMARY BY STATE');
    console.log('═'.repeat(80) + '\n');

    for (const [state, loans] of Object.entries(loansByState)) {
        if (loans.length > 0) {
            const totalAmount = loans.reduce((sum, l) => sum + parseFloat(l.amount), 0);
            console.log(`${states[state]} (${loans.length} loans, ${totalAmount.toFixed(2)} USDC):`);
            for (const loan of loans) {
                console.log(`  #${loan.id}: ${loan.amount} USDC @ ${loan.rate}% APR`);
            }
            console.log('');
        }
    }

    console.log('═'.repeat(80));
    console.log('CALCULATED TOTALS');
    console.log('═'.repeat(80) + '\n');

    console.log(`Active Loans: ${ethers.formatUnits(totalActiveAmount, 6)} USDC`);
    console.log(`Repaid Loans: ${ethers.formatUnits(totalRepaidAmount, 6)} USDC\n`);

    // Compare with pool state
    const pool = await marketplace.getAgentPool(agentId);

    console.log('Pool State (from contract):');
    console.log(`  Total Loaned: ${ethers.formatUnits(pool.totalLoaned, 6)} USDC`);
    console.log(`  Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
    console.log(`  Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC\n`);

    const discrepancy = Number(pool.totalLoaned) - Number(totalActiveAmount);

    if (discrepancy !== 0n) {
        console.log(`⚠️  ACCOUNTING DISCREPANCY:`);
        console.log(`   Pool totalLoaned: ${ethers.formatUnits(pool.totalLoaned, 6)} USDC`);
        console.log(`   Sum of active loans: ${ethers.formatUnits(totalActiveAmount, 6)} USDC`);
        console.log(`   Difference: ${ethers.formatUnits(discrepancy, 6)} USDC\n`);
    } else {
        console.log(`✅ Pool accounting matches active loans\n`);
    }

    console.log('═'.repeat(80) + '\n');
}

main().catch(console.error);
