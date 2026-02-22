/**
 * Check Loan Status on Base Sepolia
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://sepolia.base.org';
const LOAN_ID = 1;

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC_URL);

    const addresses = JSON.parse(
        fs.readFileSync('./src/config/base-sepolia-addresses.json', 'utf8')
    );

    const marketplaceAbi = JSON.parse(
        fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json', 'utf8')
    ).abi;

    const marketplace = new ethers.Contract(addresses.AgentLiquidityMarketplace, marketplaceAbi, provider);

    console.log(`\n📋 LOAN #${LOAN_ID} STATUS\n`);

    try {
        const loan = await marketplace.loans(LOAN_ID);

        console.log(`Loan ID: ${loan.loanId}`);
        console.log(`Borrower: ${loan.borrower}`);
        console.log(`Agent ID: ${loan.agentId}`);
        console.log(`Amount: ${ethers.formatUnits(loan.amount, 6)} USDC`);
        console.log(`Collateral: ${ethers.formatUnits(loan.collateralAmount, 6)} USDC`);
        console.log(`Interest Rate: ${loan.interestRate} bps (${Number(loan.interestRate) / 100}%)`);
        console.log(`Duration: ${Number(loan.duration) / 86400} days`);
        console.log(`Start Time: ${loan.startTime === 0n ? 'Not started' : new Date(Number(loan.startTime) * 1000).toISOString()}`);
        console.log(`State: ${loan.state} (0=REQUESTED, 1=ACTIVE, 2=REPAID, 3=DEFAULTED)\n`);

        if (loan.state === 0n) {
            console.log('⚠️  Loan is in REQUESTED state - needs to be disbursed first!\n');
        }

    } catch (err) {
        console.log(`❌ Failed to get loan: ${err.message}\n`);
    }
}

main().catch(console.error);
