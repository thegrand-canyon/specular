/**
 * Repay Loan #1 on Base Sepolia
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://sepolia.base.org';
const AGENT_KEY = 'process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000'';
const LOAN_ID = 1;

async function main() {
    console.log('\n💸 REPAY LOAN ON BASE SEPOLIA\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const agent = new ethers.Wallet(AGENT_KEY, provider);

    console.log(`Agent: ${agent.address}\n`);

    const addresses = JSON.parse(
        fs.readFileSync('./src/config/base-sepolia-addresses.json', 'utf8')
    );

    const marketplaceAbi = JSON.parse(
        fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json', 'utf8')
    ).abi;

    const marketplace = new ethers.Contract(addresses.AgentLiquidityMarketplace, marketplaceAbi, agent);

    // Check loan first
    const loan = await marketplace.loans(LOAN_ID);
    console.log(`Loan #${LOAN_ID}:`);
    console.log(`  Borrower: ${loan.borrower}`);
    console.log(`  Agent: ${agent.address}`);
    console.log(`  Match? ${loan.borrower.toLowerCase() === agent.address.toLowerCase()}`);
    console.log(`  State: ${loan.state}\n`);

    // Try to repay
    console.log(`💸 Repaying loan #${LOAN_ID}...\n`);

    try {
        const nonce = await provider.getTransactionCount(agent.address);
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice * 120n / 100n;

        const tx = await marketplace.repayLoan(LOAN_ID, { gasPrice, nonce });
        console.log(`📋 Tx sent: ${tx.hash}`);

        const receipt = await tx.wait();
        console.log(`✅ Repayment successful!`);
        console.log(`   Gas used: ${receipt.gasUsed.toString()}\n`);

    } catch (err) {
        console.error(`\n❌ Repayment failed: ${err.message}`);
        if (err.reason) {
            console.error(`Reason: ${err.reason}`);
        }
        process.exit(1);
    }
}

main();
