/**
 * Request a Loan on Sepolia
 *
 * This example demonstrates the complete loan request workflow:
 * 1. Check eligibility
 * 2. Request a loan
 * 3. Monitor loan status
 *
 * Prerequisites:
 * - Registered as an agent (run live-sepolia-agent.js first)
 * - USDC balance for collateral if needed (run mint-usdc-sepolia.js)
 *
 * Usage: npx hardhat run examples/request-loan-sepolia.js --network sepolia
 */

const { ethers } = require('hardhat');

const SEPOLIA_ADDRESSES = {
    reputationManager: '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF',
    mockUSDC: '0x771c293167AeD146EC4f56479056645Be46a0275',
    lendingPool: '0x5592A6d7bF1816f77074b62911D50Dad92A3212b'
};

async function main() {
    console.log('\n💰 Requesting a Loan on Sepolia\n');

    const [signer] = await ethers.getSigners();
    console.log('Agent:', signer.address);

    // Get contract instances
    const reputationManager = await ethers.getContractAt('ReputationManagerV2', SEPOLIA_ADDRESSES.reputationManager);
    const lendingPool = await ethers.getContractAt('LendingPoolV2', SEPOLIA_ADDRESSES.lendingPool);
    const usdc = await ethers.getContractAt('MockUSDC', SEPOLIA_ADDRESSES.mockUSDC);

    // Step 1: Check eligibility
    console.log('📊 Step 1: Checking loan eligibility...\n');

    const reputation = await reputationManager['getReputationScore(address)'](signer.address);
    const creditLimit = await reputationManager['calculateCreditLimit(address)'](signer.address);
    const collateralRequired = await reputationManager['calculateCollateralRequirement(address)'](signer.address);

    console.log('Reputation Score:', reputation.toString());
    console.log('Credit Limit:', ethers.formatUnits(creditLimit, 6), 'USDC');
    console.log('Collateral Required:', collateralRequired.toString(), '%');

    if (creditLimit === 0n) {
        console.log('\n❌ Error: Your reputation is too low to request loans.');
        console.log('Minimum reputation score required: 500');
        process.exit(1);
    }

    // Step 2: Set loan parameters
    const loanAmount = ethers.parseUnits('1000', 6); // 1000 USDC
    const durationDays = 30;

    console.log('\n💳 Step 2: Loan Request Details...\n');
    console.log('Amount:', ethers.formatUnits(loanAmount, 6), 'USDC');
    console.log('Duration:', durationDays, 'days');

    // Validate amount
    if (loanAmount > creditLimit) {
        console.log('\n❌ Error: Requested amount exceeds your credit limit');
        console.log('Please request', ethers.formatUnits(creditLimit, 6), 'USDC or less');
        process.exit(1);
    }

    console.log('\nLoan Details:');
    console.log('  Principal:', ethers.formatUnits(loanAmount, 6), 'USDC');
    console.log('  (Interest will be calculated upon approval)');

    // Check collateral
    if (collateralRequired > 0n) {
        const collateralAmount = (loanAmount * collateralRequired) / 100n;
        console.log('  Collateral Required:', ethers.formatUnits(collateralAmount, 6), 'USDC');

        const balance = await usdc.balanceOf(signer.address);
        if (balance < collateralAmount) {
            console.log('\n❌ Error: Insufficient USDC for collateral');
            console.log('You have:', ethers.formatUnits(balance, 6), 'USDC');
            console.log('You need:', ethers.formatUnits(collateralAmount, 6), 'USDC');
            console.log('\nMint more USDC with:');
            console.log('  npx hardhat run scripts/mint-usdc-sepolia.js --network sepolia');
            process.exit(1);
        }

        // Approve collateral
        console.log('\n⏳ Approving USDC collateral...');
        const approveTx = await usdc.approve(SEPOLIA_ADDRESSES.lendingPool, collateralAmount);
        await approveTx.wait();
        console.log('✅ Approved');
    }

    // Step 3: Request the loan
    console.log('\n📝 Step 3: Submitting loan request...\n');

    const requestTx = await lendingPool.requestLoan(loanAmount, durationDays);
    console.log('Transaction hash:', requestTx.hash);
    const receipt = await requestTx.wait();

    // Parse the LoanRequested event
    const loanRequestedEvent = receipt.logs.find(log => {
        try {
            return lendingPool.interface.parseLog(log)?.name === 'LoanRequested';
        } catch {
            return false;
        }
    });

    if (!loanRequestedEvent) {
        console.log('❌ Could not find LoanRequested event');
        process.exit(1);
    }

    const parsedEvent = lendingPool.interface.parseLog(loanRequestedEvent);
    const loanId = parsedEvent.args.loanId;

    console.log('✅ Loan requested successfully!');
    console.log('\nLoan ID:', loanId.toString());

    // Get loan details
    const loan = await lendingPool.loans(loanId);
    console.log('\n📋 Loan Details:');
    console.log('  Amount:', ethers.formatUnits(loan.amount, 6), 'USDC');
    console.log('  Interest Rate:', loan.interestRate.toString(), 'bps');
    console.log('  Duration:', loan.durationDays.toString(), 'days');
    console.log('  Collateral:', ethers.formatUnits(loan.collateralAmount, 6), 'USDC');
    console.log('  Status: REQUESTED (awaiting approval)');

    console.log('\n⏳ Next Steps:');
    console.log('1. Wait for loan approval from pool manager');
    console.log('2. Once approved, loan status will change to ACTIVE');
    console.log('3. USDC will be transferred to your wallet');
    console.log('4. Use the USDC for trading or other purposes');
    console.log('5. Repay before due date to improve reputation\n');

    console.log('💡 Monitor your loan with:');
    console.log('   npx hardhat run examples/live-sepolia-agent.js --network sepolia\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
