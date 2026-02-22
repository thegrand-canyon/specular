/**
 * Minimal Gas Test
 *
 * Tests just the loan request with minimal gas usage
 * Skip collateral approval to save gas
 *
 * Usage: npx hardhat run scripts/minimal-test.js --network sepolia
 */

const { ethers } = require('hardhat');

const SEPOLIA_ADDRESSES = {
    reputationManager: '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF',
    lendingPool: '0x5592A6d7bF1816f77074b62911D50Dad92A3212b',
    mockUSDC: '0x771c293167AeD146EC4f56479056645Be46a0275'
};

async function main() {
    console.log('\n⚡ Minimal Gas Test\n');

    const [signer] = await ethers.getSigners();
    console.log('Address:', signer.address);

    const ethBalance = await ethers.provider.getBalance(signer.address);
    console.log('ETH Balance:', ethers.formatEther(ethBalance), 'ETH');

    if (ethBalance < ethers.parseEther('0.0003')) {
        console.log('\n❌ Insufficient ETH for gas');
        console.log('Need at least 0.0003 ETH');
        console.log('\nTry these faucets:');
        console.log('  1. https://sepolia-faucet.pk910.de/ (PoW - no account)');
        console.log('  2. https://www.alchemy.com/faucets/ethereum-sepolia');
        console.log('  3. https://faucet.quicknode.com/ethereum/sepolia\n');
        process.exit(1);
    }

    const lendingPool = await ethers.getContractAt('LendingPoolV2', SEPOLIA_ADDRESSES.lendingPool);
    const reputationManager = await ethers.getContractAt('ReputationManagerV2', SEPOLIA_ADDRESSES.reputationManager);

    // Check current state
    const reputation = await reputationManager['getReputationScore(address)'](signer.address);
    console.log('Reputation:', reputation.toString());

    // Request smallest possible loan to minimize gas
    const loanAmount = ethers.parseUnits('100', 6); // 100 USDC only
    const duration = 30;

    console.log('\n⏳ Requesting', ethers.formatUnits(loanAmount, 6), 'USDC loan...');
    console.log('(Skipping collateral to save gas)\n');

    try {
        // Estimate gas first
        const gasEstimate = await lendingPool.requestLoan.estimateGas(loanAmount, duration);
        console.log('Estimated gas:', gasEstimate.toString());

        const gasPrice = await ethers.provider.getFeeData();
        const estimatedCost = gasEstimate * gasPrice.gasPrice;
        console.log('Estimated cost:', ethers.formatEther(estimatedCost), 'ETH\n');

        if (ethBalance < estimatedCost * 2n) {
            console.log('❌ Not enough ETH for this transaction');
            console.log('Need ~', ethers.formatEther(estimatedCost * 2n), 'ETH');
            process.exit(1);
        }

        // This will fail because we need 100% collateral
        // But shows what gas would be needed
        console.log('Note: This will fail due to collateral requirement');
        console.log('But now you know the gas cost!\n');

    } catch (error) {
        console.log('Expected error:', error.message);
    }

    console.log('\n💡 To actually test:');
    console.log('  1. Get 0.001+ ETH from faucets above');
    console.log('  2. Run: npx hardhat run scripts/test-loan-cycle.js --network sepolia\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
