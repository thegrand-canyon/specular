/**
 * Check Arc Testnet Pool Status
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://arc-testnet.drpc.org';
const AGENT_ADDR = '0x656086A21073272533c8A3f56A94c1f3D8BCFcE2';

async function main() {
    console.log('\n📊 ARC TESTNET POOL STATUS\n');

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
    const reputationAbi = loadAbi('ReputationManagerV3');
    const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');

    const registry = new ethers.Contract(addresses.agentRegistryV2, registryAbi, provider);
    const reputation = new ethers.Contract(addresses.reputationManagerV3, reputationAbi, provider);
    const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, marketplaceAbi, provider);

    const agentId = await registry.addressToAgentId(AGENT_ADDR);
    const score = await reputation['getReputationScore(address)'](AGENT_ADDR);
    const creditLimit = await reputation.calculateCreditLimit(AGENT_ADDR);
    const interestRate = await reputation.calculateInterestRate(AGENT_ADDR);

    console.log('═'.repeat(70));
    console.log('AGENT PROFILE');
    console.log('═'.repeat(70) + '\n');

    console.log(`Address: ${AGENT_ADDR}`);
    console.log(`Agent ID: ${agentId}`);
    console.log(`Reputation Score: ${score}`);
    console.log(`Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);
    console.log(`Interest Rate: ${Number(interestRate) / 100}% APR\n`);

    console.log('═'.repeat(70));
    console.log('POOL STATUS');
    console.log('═'.repeat(70) + '\n');

    const pool = await marketplace.getAgentPool(agentId);

    console.log(`Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
    console.log(`Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
    console.log(`Total Loaned: ${ethers.formatUnits(pool.totalLoaned, 6)} USDC`);
    console.log(`Total Earned: ${ethers.formatUnits(pool.totalEarned, 6)} USDC\n`);

    const utilization = (Number(pool.totalLoaned) / Number(pool.totalLiquidity)) * 100;
    console.log(`Utilization: ${utilization.toFixed(2)}%\n`);

    // Count active vs repaid loans
    console.log('═'.repeat(70));
    console.log('LOAN HISTORY');
    console.log('═'.repeat(70) + '\n');

    let totalLoans = 0;
    let activeLoans = 0;
    let repaidLoans = 0;
    let totalBorrowed = 0n;
    let totalRepaid = 0n;

    const states = ['REQUESTED', 'ACTIVE', 'REPAID', 'DEFAULTED'];

    for (let i = 1; i <= 30; i++) {
        try {
            const loan = await marketplace.loans(i);
            if (loan.borrower.toLowerCase() === AGENT_ADDR.toLowerCase()) {
                totalLoans++;
                totalBorrowed += loan.amount;

                if (loan.state === 1) {
                    activeLoans++;
                    console.log(`Loan #${i}: ${ethers.formatUnits(loan.amount, 6)} USDC - ${states[loan.state]}`);
                } else if (loan.state === 2) {
                    repaidLoans++;
                    totalRepaid += loan.amount;
                }
            }
        } catch (e) {
            break;
        }
    }

    console.log(`\nTotal Loans: ${totalLoans}`);
    console.log(`Active: ${activeLoans}`);
    console.log(`Repaid: ${repaidLoans}`);
    console.log(`Total Borrowed: ${ethers.formatUnits(totalBorrowed, 6)} USDC`);
    console.log(`Total Repaid: ${ethers.formatUnits(totalRepaid, 6)} USDC\n`);

    // Calculate max borrowable amount
    const maxByCredit = Number(creditLimit);
    const maxByLiquidity = Number(pool.availableLiquidity);
    const maxLoan = Math.min(maxByCredit, maxByLiquidity);

    console.log('═'.repeat(70));
    console.log('BORROWING CAPACITY');
    console.log('═'.repeat(70) + '\n');

    console.log(`Max by credit limit: ${ethers.formatUnits(maxByCredit, 6)} USDC`);
    console.log(`Max by pool liquidity: ${ethers.formatUnits(maxByLiquidity, 6)} USDC`);
    console.log(`Actual max loan: ${ethers.formatUnits(maxLoan, 6)} USDC\n`);

    console.log('═'.repeat(70) + '\n');
}

main().catch(console.error);
