/**
 * Test Small Loan Request
 *
 * Try requesting a smaller loan to see if credit limit or collateral is the issue
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://sepolia.base.org';
const AGENT_KEY = '0x4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac';

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const agent = new ethers.Wallet(AGENT_KEY, provider);

    console.log(`\nAgent: ${agent.address}\n`);

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
    const reputationAbi = loadAbi('ReputationManagerV3');
    const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');
    const usdcAbi = loadAbi('MockUSDC');

    const registry = new ethers.Contract(addresses.AgentRegistryV2, registryAbi, provider);
    const reputation = new ethers.Contract(addresses.ReputationManagerV3, reputationAbi, provider);
    const marketplace = new ethers.Contract(addresses.AgentLiquidityMarketplace, marketplaceAbi, agent);
    const usdc = new ethers.Contract(addresses.MockUSDC, usdcAbi, agent);

    const agentId = await registry.addressToAgentId(agent.address);
    const score = await reputation['getReputationScore(address)'](agent.address);
    const creditLimit = await reputation.calculateCreditLimit(agent.address);
    const interestRate = await reputation.calculateInterestRate(agent.address);

    console.log('Current Agent State:');
    console.log(`  ID: ${agentId}`);
    console.log(`  Reputation: ${score}`);
    console.log(`  Credit Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);
    console.log(`  Interest Rate: ${Number(interestRate) / 100}% APR\n`);

    // Check USDC balance
    const usdcBalance = await usdc.balanceOf(agent.address);
    console.log(`  USDC Balance: ${ethers.formatUnits(usdcBalance, 6)} USDC\n`);

    // Try different loan amounts
    const testAmounts = [50, 100, 150, 200, 500];

    for (const amount of testAmounts) {
        console.log(`\nTrying ${amount} USDC loan...`);

        try {
            // First approve USDC for collateral
            const nonce1 = await provider.getTransactionCount(agent.address);
            const approveTx = await usdc.approve(
                addresses.AgentLiquidityMarketplace,
                ethers.parseUnits('10000', 6),
                { nonce: nonce1 }
            );
            await approveTx.wait();

            const nonce2 = await provider.getTransactionCount(agent.address);
            const tx = await marketplace.requestLoan(
                ethers.parseUnits(amount.toString(), 6),
                7,
                { nonce: nonce2 }
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

            console.log(`  ✅ SUCCESS: Loan ID ${loanId}`);

            // Check loan details
            const loan = await marketplace.loans(loanId);
            console.log(`  Principal: ${ethers.formatUnits(loan.amount, 6)} USDC`);
            console.log(`  State: ${loan.state} (1=ACTIVE)`);

            // Stop after first successful loan
            break;

        } catch (error) {
            console.log(`  ❌ FAILED: ${error.message.split('\n')[0]}`);
        }
    }
}

main().catch(console.error);
