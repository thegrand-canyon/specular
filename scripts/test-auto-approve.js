/**
 * Test Auto-Approve Functionality (V3)
 *
 * This script tests the instant loan approval feature of V3
 *
 * Usage: npx hardhat run scripts/test-auto-approve.js --network sepolia
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n⚡ Testing V3 Auto-Approve Feature\n');
    console.log('═════════════════════════════════════\n');

    const [signer] = await ethers.getSigners();
    console.log('Agent:', signer.address);

    // Load addresses
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    // Get V3 contract
    const lendingPoolV3 = await ethers.getContractAt('LendingPoolV3', addresses.lendingPool);
    const reputationManager = await ethers.getContractAt('ReputationManagerV2', addresses.reputationManager);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    // Check current state
    console.log('📊 Current State:');
    console.log('─────────────────────────────────────');

    const reputation = await reputationManager['getReputationScore(address)'](signer.address);
    const creditLimit = await reputationManager['calculateCreditLimit(address)'](signer.address);
    const poolLiquidity = await lendingPoolV3.availableLiquidity();

    console.log('Reputation:', reputation.toString());
    console.log('Credit Limit:', ethers.formatUnits(creditLimit, 6), 'USDC');
    console.log('Pool Liquidity:', ethers.formatUnits(poolLiquidity, 6), 'USDC');

    // Check auto-approve settings
    const autoApproveEnabled = await lendingPoolV3.autoApproveEnabled();
    const maxAutoApprove = await lendingPoolV3.maxAutoApproveAmount();
    const minReputation = await lendingPoolV3.minReputationForAutoApprove();

    console.log('\n⚙️  Auto-Approve Configuration:');
    console.log('─────────────────────────────────────');
    console.log('Enabled:', autoApproveEnabled);
    console.log('Max Amount:', ethers.formatUnits(maxAutoApprove, 6), 'USDC');
    console.log('Min Reputation:', minReputation.toString());

    // Test if loan would be auto-approved
    const loanAmount = ethers.parseUnits('1000', 6);
    const canAutoApprove = await lendingPoolV3.canAutoApprove(signer.address, loanAmount);

    console.log('\n🔍 Pre-Check:');
    console.log('─────────────────────────────────────');
    console.log('Loan Amount:', ethers.formatUnits(loanAmount, 6), 'USDC');
    console.log('Will Auto-Approve:', canAutoApprove ? '✅ YES' : '❌ NO');

    if (!canAutoApprove) {
        console.log('\n❌ Loan will NOT auto-approve. Reasons:');
        if (!autoApproveEnabled) console.log('   - Auto-approve is disabled');
        if (loanAmount > maxAutoApprove) console.log('   - Amount exceeds max auto-approve');
        if (poolLiquidity < loanAmount) console.log('   - Insufficient pool liquidity');
        if (reputation < minReputation) console.log('   - Reputation below minimum');
        console.log('\nFix these issues and try again.\n');
        process.exit(1);
    }

    // Request loan (should auto-approve!)
    console.log('\n⚡ TESTING AUTO-APPROVE');
    console.log('═════════════════════════════════════\n');

    const balanceBefore = await usdc.balanceOf(signer.address);
    console.log('USDC Balance Before:', ethers.formatUnits(balanceBefore, 6), 'USDC');

    console.log('\n⏳ Requesting loan (expecting INSTANT approval)...');

    const requestTime = Date.now();
    const requestTx = await lendingPoolV3.requestLoan(loanAmount, 30);
    const receipt = await requestTx.wait();
    const approvalTime = Date.now();

    // Check if auto-approved
    const event = receipt.logs.find(log => {
        try {
            const parsed = lendingPoolV3.interface.parseLog(log);
            return parsed?.name === 'LoanApproved';
        } catch {
            return false;
        }
    });

    if (event) {
        const parsedEvent = lendingPoolV3.interface.parseLog(event);
        const loanId = parsedEvent.args.loanId;
        const autoApproved = parsedEvent.args.autoApproved;

        console.log('✅ LOAN AUTO-APPROVED! 🎉\n');
        console.log('Loan ID:', loanId.toString());
        console.log('Auto-Approved:', autoApproved ? 'YES ⚡' : 'NO (manual)');
        console.log('Approval Time:', (approvalTime - requestTime) + 'ms');

        // Check balance
        const balanceAfter = await usdc.balanceOf(signer.address);
        console.log('\nUSDC Balance After:', ethers.formatUnits(balanceAfter, 6), 'USDC');
        console.log('Received:', ethers.formatUnits(balanceAfter - balanceBefore, 6), 'USDC');

        // Get loan details
        const loan = await lendingPoolV3.loans(loanId);
        console.log('\n📋 Loan Details:');
        console.log('  Amount:', ethers.formatUnits(loan.amount, 6), 'USDC');
        console.log('  Interest Rate:', (Number(loan.interestRate) / 100).toFixed(2), '% APR');
        console.log('  Duration:', loan.durationDays.toString(), 'days');
        console.log('  State:', ['REQUESTED', 'APPROVED', 'ACTIVE', 'REPAID', 'DEFAULTED'][loan.state]);
        console.log('  Due Date:', new Date(Number(loan.endTime) * 1000).toLocaleString());

        console.log('\n🎯 SUCCESS! V3 Auto-Approve is Working!');
        console.log('═════════════════════════════════════');
        console.log('\n✨ Key Improvements Over V2:');
        console.log('  ✅ INSTANT approval (no waiting!)');
        console.log('  ✅ USDC in wallet immediately');
        console.log('  ✅ Fully autonomous operation');
        console.log('  ✅ Better UX for agents');

        console.log('\n💡 Now repay the loan to test full cycle:');
        console.log(`   npx hardhat run scripts/repay-loan.js --network sepolia -- ${loanId}\n`);

    } else {
        console.log('❌ Loan was NOT auto-approved');
        console.log('Check the transaction for details.');
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
