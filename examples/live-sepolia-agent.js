/**
 * Live Sepolia Agent Example
 *
 * This example shows how to interact with the deployed Specular Protocol on Sepolia.
 *
 * Prerequisites:
 * - Sepolia ETH in your wallet (get from faucet)
 * - RPC endpoint configured in .env
 *
 * What this does:
 * 1. Registers an agent
 * 2. Checks initial reputation (should be 500)
 * 3. Requests a loan based on reputation
 * 4. Monitors loan status
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

// Deployed Sepolia contract addresses
const SEPOLIA_ADDRESSES = {
    agentRegistry: '0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb',
    reputationManager: '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF',
    validationRegistry: '0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE',
    mockUSDC: '0x771c293167AeD146EC4f56479056645Be46a0275',
    lendingPool: '0x5592A6d7bF1816f77074b62911D50Dad92A3212b'
};

async function main() {
    console.log('\n🤖 Specular Protocol - Live Sepolia Agent Example\n');

    // Get signer (your wallet)
    const [signer] = await ethers.getSigners();
    console.log('Agent Wallet:', signer.address);

    // Check ETH balance
    const ethBalance = await ethers.provider.getBalance(signer.address);
    console.log('ETH Balance:', ethers.formatEther(ethBalance), 'ETH');

    if (ethBalance < ethers.parseEther('0.001')) {
        console.log('\n⚠️  WARNING: Low ETH balance. You may need more for gas fees.');
        console.log('Get Sepolia ETH from: https://cloud.google.com/application/web3/faucet/ethereum/sepolia\n');
    }

    // Get contract instances
    const agentRegistry = await ethers.getContractAt('AgentRegistryV2', SEPOLIA_ADDRESSES.agentRegistry);
    const reputationManager = await ethers.getContractAt('ReputationManagerV2', SEPOLIA_ADDRESSES.reputationManager);
    const lendingPool = await ethers.getContractAt('LendingPoolV2', SEPOLIA_ADDRESSES.lendingPool);
    const usdc = await ethers.getContractAt('MockUSDC', SEPOLIA_ADDRESSES.mockUSDC);

    // Check if already registered
    const isRegistered = await agentRegistry.isRegistered(signer.address);

    if (!isRegistered) {
        console.log('\n📝 Step 1: Registering as an agent...');

        // Create agent URI (in production, this would be IPFS or similar)
        const agentURI = 'ipfs://QmSpecularAgent123'; // Placeholder

        // Create metadata entries (optional)
        const metadata = []; // Empty array for now

        const registerTx = await agentRegistry.register(agentURI, metadata);
        console.log('Transaction hash:', registerTx.hash);
        await registerTx.wait();
        console.log('✅ Registered successfully!');

        const agentId = await agentRegistry.addressToAgentId(signer.address);
        console.log('Your Agent NFT ID:', agentId.toString());

        // Initialize reputation
        console.log('\nInitializing reputation...');
        const initTx = await reputationManager['initializeReputation(uint256)'](agentId);
        await initTx.wait();
        console.log('✅ Reputation initialized!');
    } else {
        console.log('\n✅ Already registered as an agent');
        const agentId = await agentRegistry.addressToAgentId(signer.address);
        console.log('Your Agent NFT ID:', agentId.toString());

        // Check if reputation is initialized
        const rep = await reputationManager.reputation(agentId);
        if (rep.lastUpdated === 0n) {
            console.log('\nReputation not initialized. Initializing now...');
            const initTx = await reputationManager['initializeReputation(uint256)'](agentId);
            await initTx.wait();
            console.log('✅ Reputation initialized!');
        }
    }

    // Check reputation
    console.log('\n📊 Step 2: Checking reputation...');
    const reputation = await reputationManager['getReputationScore(address)'](signer.address);
    console.log('Current Reputation Score:', reputation.toString(), '/ 1000');

    // Get credit details
    const creditLimit = await reputationManager['calculateCreditLimit(address)'](signer.address);
    const collateralRequired = await reputationManager['calculateCollateralRequirement(address)'](signer.address);

    console.log('Credit Limit:', ethers.formatUnits(creditLimit, 6), 'USDC');
    console.log('Collateral Required:', collateralRequired.toString(), '%');

    // Check USDC balance
    const usdcBalance = await usdc.balanceOf(signer.address);
    console.log('Your USDC Balance:', ethers.formatUnits(usdcBalance, 6), 'USDC');

    if (usdcBalance === 0n) {
        console.log('\n💡 Tip: You need USDC to test loans. Mint some with:');
        console.log('   npx hardhat run scripts/mint-usdc.js --network sepolia');
    }

    // Check pool liquidity
    const availableLiquidity = await lendingPool.availableLiquidity();
    console.log('\n🏦 Pool Status:');
    console.log('Available Liquidity:', ethers.formatUnits(availableLiquidity, 6), 'USDC');

    // Get active loans
    console.log('\n📋 Your Loans:');
    const loanCount = await lendingPool.nextLoanId();
    let activeLoanCount = 0;

    for (let i = 1n; i < loanCount; i++) {
        const loan = await lendingPool.loans(i);
        if (loan.borrower === signer.address) {
            activeLoanCount++;
            console.log(`\nLoan #${i}:`);
            console.log('  Amount:', ethers.formatUnits(loan.amount, 6), 'USDC');
            console.log('  Interest Rate:', loan.interestRate.toString(), 'bps');
            console.log('  Duration:', loan.durationDays.toString(), 'days');
            console.log('  Status:', ['REQUESTED', 'APPROVED', 'ACTIVE', 'REPAID', 'DEFAULTED'][loan.state]);

            if (loan.state === 2) { // ACTIVE
                const interest = await lendingPool.calculateInterest(loan.amount, loan.interestRate, loan.durationDays);
                const totalOwed = loan.amount + interest;
                console.log('  Total Owed:', ethers.formatUnits(totalOwed, 6), 'USDC');
            }
        }
    }

    if (activeLoanCount === 0) {
        console.log('No active loans');
    }

    // Request a loan example
    console.log('\n\n💡 Example: Request a Loan\n');
    console.log('To request a loan, you can use:');
    console.log('```javascript');
    console.log('const loanAmount = ethers.parseUnits("1000", 6); // 1000 USDC');
    console.log('const durationDays = 30;');
    console.log('');
    console.log('// Request loan');
    console.log('const requestTx = await lendingPool.requestLoan(loanAmount, durationDays);');
    console.log('await requestTx.wait();');
    console.log('');
    console.log('// Get loan ID from event');
    console.log('const receipt = await requestTx.wait();');
    console.log('const event = receipt.logs.find(log => {');
    console.log('  try { return lendingPool.interface.parseLog(log)?.name === "LoanRequested"; }');
    console.log('  catch { return false; }');
    console.log('});');
    console.log('const loanId = lendingPool.interface.parseLog(event).args.loanId;');
    console.log('console.log("Loan requested! ID:", loanId.toString());');
    console.log('```');

    console.log('\n📚 Contract Addresses:');
    console.log('AgentRegistry:      ', SEPOLIA_ADDRESSES.agentRegistry);
    console.log('ReputationManager:  ', SEPOLIA_ADDRESSES.reputationManager);
    console.log('ValidationRegistry: ', SEPOLIA_ADDRESSES.validationRegistry);
    console.log('MockUSDC:           ', SEPOLIA_ADDRESSES.mockUSDC);
    console.log('LendingPool:        ', SEPOLIA_ADDRESSES.lendingPool);

    console.log('\n✅ Done! Your agent is ready to use the Specular Protocol on Sepolia.\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
