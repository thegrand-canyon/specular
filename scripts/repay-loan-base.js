/**
 * Repay existing loan on Base
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://mainnet.base.org';
const DEPLOYER_KEY = process.env.PRIVATE_KEY;

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  REPAY LOAN ON BASE                              ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);

    console.log(`🔑 Account: ${deployer.address}\n`);

    // Load addresses
    const addresses = JSON.parse(fs.readFileSync('./src/config/base-addresses.json', 'utf8'));

    // Load ABIs
    const marketplaceAbi = JSON.parse(fs.readFileSync(
        './artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json',
        'utf8'
    )).abi;

    const usdcAbi = [
        'function balanceOf(address) view returns (uint256)',
        'function approve(address spender, uint256 amount) returns (bool)',
        'function allowance(address owner, address spender) view returns (uint256)'
    ];

    const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, marketplaceAbi, deployer);
    const usdc = new ethers.Contract(addresses.usdc, usdcAbi, deployer);

    // Check for loan #1
    const loanId = 1;
    console.log(`📋 Checking Loan #${loanId}...`);

    const loan = await marketplace.loans(loanId);

    console.log(`   Borrower: ${loan.borrower}`);
    console.log(`   Amount: ${ethers.formatUnits(loan.amount, 6)} USDC`);
    console.log(`   Collateral: ${ethers.formatUnits(loan.collateralAmount, 6)} USDC`);
    console.log(`   Interest rate: ${loan.interestRate / 100n}%`);
    console.log(`   State: ${loan.state} (0=REQUESTED, 1=ACTIVE, 2=REPAID, 3=DEFAULTED)`);

    if (loan.state === 2n) {
        console.log(`   ✅ Loan already repaid!\n`);
        return;
    }

    if (loan.state !== 1n) {
        console.log(`   ⚠️  Loan not active (state: ${loan.state})\n`);
        return;
    }

    console.log('\n💰 Calculating repayment...');

    // Calculate interest using marketplace function
    const interest = await marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
    const repayAmount = BigInt(loan.amount) + BigInt(interest);

    console.log(`   Principal: ${ethers.formatUnits(loan.amount, 6)} USDC`);
    console.log(`   Interest: ${ethers.formatUnits(interest, 6)} USDC`);
    console.log(`   Total to repay: ${ethers.formatUnits(repayAmount, 6)} USDC`);

    // Check balance
    const balance = await usdc.balanceOf(deployer.address);
    console.log(`   Current balance: ${ethers.formatUnits(balance, 6)} USDC`);

    if (balance < repayAmount) {
        console.log(`\n⚠️  Insufficient balance! Need ${ethers.formatUnits(repayAmount - balance, 6)} more USDC\n`);
        return;
    }

    // Approve repayment
    console.log('   Approving repayment...');
    const approveTx = await usdc.approve(addresses.agentLiquidityMarketplace, repayAmount);
    await approveTx.wait();
    console.log('   ✅ Approved');

    // Repay loan
    const repayTx = await marketplace.repayLoan(loanId);
    console.log(`   TX: ${repayTx.hash}`);
    await repayTx.wait();
    console.log('   ✅ Loan repaid!\n');

    // Check final state
    const finalLoan = await marketplace.loans(loanId);
    console.log('📊 Final State:');
    console.log(`   Loan state: ${finalLoan.state} (2 = REPAID)`);
    console.log(`   ✅ Production test complete!\n`);

    console.log('🎉 BASE MAINNET IS FULLY OPERATIONAL!\n');
    console.log(`View transaction: https://basescan.org/tx/${repayTx.hash}\n`);
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
