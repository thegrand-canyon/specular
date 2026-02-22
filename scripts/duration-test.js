/**
 * Loan Duration Testing
 *
 * Tests different loan durations and validates interest calculations:
 * - 7, 14, 30, 90, 180, 365 days
 * - Compares expected vs actual interest
 * - Validates interest formula
 */

const { ethers } = require('ethers');
const fs = require('fs');

const NETWORK = process.env.NETWORK || 'arc';
const RPC_URLS = {
    arc: 'https://arc-testnet.drpc.org',
    base: 'https://sepolia.base.org',
};

const AGENT_KEY = 'process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'';
const LOAN_AMOUNT = 100; // USDC

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log(`║    DURATION TEST - ${NETWORK.toUpperCase().padEnd(28)}║`);
    console.log('╚══════════════════════════════════════════════════╝\n');

    const RPC_URL = RPC_URLS[NETWORK];
    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const agent = new ethers.Wallet(AGENT_KEY, provider);

    console.log(`Network: ${NETWORK === 'arc' ? 'Arc Testnet' : 'Base Sepolia'}`);
    console.log(`Agent: ${agent.address}`);
    console.log(`Loan Amount: ${LOAN_AMOUNT} USDC\n`);

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
    const interestRate = await reputation.calculateInterestRate(agent.address);
    const score = await reputation['getReputationScore(address)'](agent.address);

    console.log('═'.repeat(70));
    console.log('AGENT INFO');
    console.log('═'.repeat(70) + '\n');

    console.log(`Agent ID: ${agentId}`);
    console.log(`Reputation: ${score}`);
    console.log(`Interest Rate: ${Number(interestRate) / 100}% APR\n`);

    // Approve USDC
    console.log('Approving USDC...\n');
    const approveTx = await usdc.approve(addresses[k.marketplace], ethers.parseUnits('100000', 6));
    await approveTx.wait();
    console.log('✅ Approved\n');

    const durations = [7, 14, 30, 90, 180, 365];

    console.log('═'.repeat(70));
    console.log('DURATION TESTING');
    console.log('═'.repeat(70) + '\n');

    const results = [];

    for (const days of durations) {
        console.log(`Testing ${days} day loan...`);

        // Calculate expected interest
        const apr = Number(interestRate) / 100; // e.g., 5% -> 5
        const expectedInterest = (LOAN_AMOUNT * (apr / 100) * days) / 365;

        console.log(`  Expected interest: ${expectedInterest.toFixed(6)} USDC (${apr}% APR)`);

        try {
            // Request loan
            const loanTx = await marketplace.requestLoan(
                ethers.parseUnits(LOAN_AMOUNT.toString(), 6),
                days
            );
            const requestReceipt = await loanTx.wait();

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

            // Get loan details
            const loan = await marketplace.loans(loanId);
            const actualInterest = Number(loan.interestAmount) / 1e6;

            console.log(`  ✅ Loan created (ID: ${loanId})`);
            console.log(`  Actual interest: ${actualInterest.toFixed(6)} USDC`);

            const diff = Math.abs(expectedInterest - actualInterest);
            const diffPct = (diff / expectedInterest) * 100;
            const matches = diff < 0.01; // Within 1 cent

            console.log(`  Difference: ${diff.toFixed(6)} USDC (${diffPct.toFixed(2)}%)`);
            console.log(`  ${matches ? '✅' : '⚠️'} ${matches ? 'Matches' : 'Differs from'} expected\n`);

            // Repay loan
            const repayTx = await marketplace.repayLoan(loanId);
            await repayTx.wait();

            results.push({
                days,
                loanId,
                expectedInterest,
                actualInterest,
                diff,
                diffPct,
                matches,
                requestGas: Number(requestReceipt.gasUsed),
            });

        } catch (error) {
            console.log(`  ❌ Failed: ${error.message.split('\n')[0]}\n`);
            results.push({
                days,
                error: error.message.split('\n')[0],
            });
        }
    }

    // Summary
    console.log('═'.repeat(70));
    console.log('DURATION TEST SUMMARY');
    console.log('═'.repeat(70) + '\n');

    const successful = results.filter(r => r.loanId).length;
    const matchedExpected = results.filter(r => r.matches).length;

    console.log(`Durations Tested: ${durations.length}`);
    console.log(`Successful: ${successful}/${durations.length}`);
    console.log(`Matched Expected: ${matchedExpected}/${successful}\n`);

    console.log('Interest Comparison:');
    console.log('Duration | Expected  | Actual    | Diff      | Match');
    console.log('-'.repeat(70));
    for (const result of results) {
        if (result.loanId) {
            const icon = result.matches ? '✅' : '⚠️';
            console.log(
                `${result.days.toString().padStart(3)} days | ` +
                `${result.expectedInterest.toFixed(6)} | ` +
                `${result.actualInterest.toFixed(6)} | ` +
                `${result.diff.toFixed(6)} | ${icon}`
            );
        } else {
            console.log(`${result.days.toString().padStart(3)} days | FAILED: ${result.error.substring(0, 40)}`);
        }
    }
    console.log('');

    if (successful > 0) {
        const avgGas = results.filter(r => r.requestGas).reduce((sum, r) => sum + r.requestGas, 0) / successful;
        console.log(`Average Request Gas: ${Math.round(avgGas).toLocaleString()}\n`);
    }

    console.log('Interest Formula Validation:');
    console.log(`  Formula: Interest = Amount × (APR / 100) × Days / 365`);
    console.log(`  APR: ${Number(interestRate) / 100}%`);
    console.log(`  ${matchedExpected === successful ? '✅' : '⚠️'} All durations ${matchedExpected === successful ? 'match' : 'vary from'} expected\n`);

    console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n❌ Duration test failed:', err.message);
    console.error(err);
    process.exit(1);
});
