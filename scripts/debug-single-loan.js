const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🔍 DEBUG: Single Agent Loan Request\n');

    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const testAgentsPath = path.join(__dirname, '..', 'test-agents.json');
    const testAgents = JSON.parse(fs.readFileSync(testAgentsPath, 'utf8'));

    const alice = testAgents[0];
    const wallet = new ethers.Wallet(alice.privateKey, ethers.provider);

    const v3Pool = await ethers.getContractAt('LendingPoolV3', addresses.lendingPool);
    const reputationManager = await ethers.getContractAt('ReputationManagerV2', addresses.reputationManager);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    const reputation = await reputationManager['getReputationScore(address)'](alice.address);
    const collateralReq = await reputationManager['calculateCollateralRequirement(address)'](alice.address);
    const creditLimit = await reputationManager['calculateCreditLimit(address)'](alice.address);

    console.log('Alice Status:');
    console.log('  Reputation:', reputation.toString());
    console.log('  Collateral Requirement:', collateralReq.toString(), '%');
    console.log('  Credit Limit:', ethers.formatUnits(creditLimit, 6), 'USDC\n');

    const loanAmount = ethers.parseUnits('1000', 6);
    const collateralAmount = (loanAmount * collateralReq) / 100n;

    console.log('Loan Details:');
    console.log('  Loan Amount:', ethers.formatUnits(loanAmount, 6), 'USDC');
    console.log('  Collateral Needed:', ethers.formatUnits(collateralAmount, 6), 'USDC\n');

    // Can auto-approve?
    const canAutoApprove = await v3Pool.canAutoApprove(alice.address, loanAmount);
    console.log('Can Auto-Approve:', canAutoApprove, '\n');

    // Approve collateral
    console.log('Approving collateral...');
    const approveTx = await usdc.connect(wallet).approve(addresses.lendingPool, collateralAmount);
    await approveTx.wait();
    console.log('✅ Approved\n');

    // Request loan
    console.log('Requesting loan...');
    try {
        const tx = await v3Pool.connect(wallet).requestLoan(loanAmount, 30);
        const receipt = await tx.wait();
        console.log('✅ Loan requested!');
        console.log('Gas used:', receipt.gasUsed.toString());
    } catch (error) {
        console.log('❌ Error:', error.message);
        console.log('\nFull error:');
        console.log(error);
    }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
