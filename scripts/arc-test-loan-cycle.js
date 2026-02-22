/**
 * Test complete loan cycle on Arc Testnet
 * Borrow, repay, check reputation
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🔄 TESTING LOAN CYCLE ON ARC\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const marketplace = await ethers.getContractAt('AgentLiquidityMarketplace', addresses.agentLiquidityMarketplace);
    const reputationManager = await ethers.getContractAt('ReputationManagerV3', addresses.reputationManagerV3);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    // Load test agents
    const testAgentsPath = path.join(__dirname, '..', 'arc-test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    // Test with Alice
    const alice = testAgents.find(a => a.name === 'Alice');
    console.log(`TEST AGENT: ${alice.name}`);
    console.log(`  Address: ${alice.address}`);
    console.log(`  Agent ID: ${alice.agentId}\n`);

    const aliceWallet = new ethers.Wallet(alice.privateKey, ethers.provider);

    // 1. Check initial state
    console.log('📊 INITIAL STATE\n');
    const initialRep = await reputationManager['getReputationScore(address)'](alice.address);
    const initialBalance = await usdc.balanceOf(alice.address);
    console.log(`  Reputation: ${initialRep}`);
    console.log(`  USDC Balance: ${ethers.formatUnits(initialBalance, 6)}\n`);

    // 2. Request loan
    console.log('💰 REQUESTING LOAN\n');
    const loanAmount = ethers.parseUnits('1000', 6); // 1000 USDC
    const duration = 30; // 30 days

    console.log(`  Amount: 1000 USDC`);
    console.log(`  Duration: ${duration} days`);

    // Check collateral requirement
    const collateralPercent = await reputationManager.calculateCollateralRequirement(alice.address);
    const requiredCollateral = (loanAmount * collateralPercent) / 100n;
    console.log(`  Collateral Required: ${ethers.formatUnits(requiredCollateral, 6)} USDC (${collateralPercent}%)\n`);

    // Approve collateral
    if (requiredCollateral > 0) {
        console.log(`  Approving collateral...`);
        const approveTx = await usdc.connect(aliceWallet).approve(addresses.agentLiquidityMarketplace, requiredCollateral);
        await approveTx.wait();
        console.log(`  ✅ Collateral approved\n`);
        await new Promise(resolve => setTimeout(resolve, 3000));
    }

    const requestTx = await marketplace.connect(aliceWallet).requestLoan(loanAmount, duration);
    const receipt = await requestTx.wait();

    // Get loan ID from event
    const loanRequestedEvent = receipt.logs.find(log => {
        try {
            const parsed = marketplace.interface.parseLog(log);
            return parsed?.name === 'LoanRequested';
        } catch { return false; }
    });

    let loanId;
    if (loanRequestedEvent) {
        const parsed = marketplace.interface.parseLog(loanRequestedEvent);
        loanId = parsed.args.loanId;
        console.log(`  ✅ Loan requested: ID ${loanId}\n`);
    } else {
        console.log('  ❌ Could not get loan ID\n');
        return;
    }

    await new Promise(resolve => setTimeout(resolve, 5000));

    // 3. Check loan status
    const loan = await marketplace.loans(loanId);
    console.log('📋 LOAN STATUS\n');
    console.log(`  State: ${['REQUESTED', 'ACTIVE', 'REPAID', 'DEFAULTED'][loan.state]}`);
    console.log(`  Amount: ${ethers.formatUnits(loan.amount, 6)} USDC`);
    console.log(`  Interest Rate: ${Number(loan.interestRate) / 100}%\n`);

    // Check new balance
    const balanceAfterLoan = await usdc.balanceOf(alice.address);
    console.log(`  Alice's new balance: ${ethers.formatUnits(balanceAfterLoan, 6)} USDC\n`);

    await new Promise(resolve => setTimeout(resolve, 5000));

    // 4. Repay loan
    console.log('💸 REPAYING LOAN\n');

    // Calculate total repayment
    const principal = loan.amount;
    const interestRate = loan.interestRate;
    const durationSeconds = loan.duration;
    const interest = (principal * interestRate * durationSeconds) / (10000n * 365n * 24n * 3600n);
    const totalRepayment = principal + interest;

    console.log(`  Principal: ${ethers.formatUnits(principal, 6)} USDC`);
    console.log(`  Interest: ${ethers.formatUnits(interest, 6)} USDC`);
    console.log(`  Total: ${ethers.formatUnits(totalRepayment, 6)} USDC\n`);

    // Approve and repay
    const approveTx = await usdc.connect(aliceWallet).approve(addresses.agentLiquidityMarketplace, totalRepayment);
    await approveTx.wait();
    console.log(`  ✅ USDC approved\n`);

    await new Promise(resolve => setTimeout(resolve, 3000));

    const repayTx = await marketplace.connect(aliceWallet).repayLoan(loanId);
    await repayTx.wait();
    console.log(`  ✅ Loan repaid!\n`);

    await new Promise(resolve => setTimeout(resolve, 5000));

    // 5. Check final state
    console.log('📊 FINAL STATE\n');
    const finalRep = await reputationManager['getReputationScore(address)'](alice.address);
    const finalBalance = await usdc.balanceOf(alice.address);
    const finalLoan = await marketplace.loans(loanId);

    console.log(`  Reputation: ${initialRep} → ${finalRep} (+${finalRep - initialRep})`);
    console.log(`  USDC Balance: ${ethers.formatUnits(finalBalance, 6)}`);
    console.log(`  Loan State: ${['REQUESTED', 'ACTIVE', 'REPAID', 'DEFAULTED'][finalLoan.state]}\n`);

    console.log('═══════════════════════════════════════════════════════\n');
    console.log('✅ LOAN CYCLE COMPLETE!\n');
    console.log('🎯 Alice successfully borrowed, repaid, and built reputation on Arc! 🚀\n');
}

main().catch(error => {
    console.error('Error:', error);
    process.exit(1);
});
