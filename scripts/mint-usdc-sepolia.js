/**
 * Mint test USDC on Sepolia
 *
 * This script mints test USDC tokens for testing the lending protocol.
 * Usage: npx hardhat run scripts/mint-usdc-sepolia.js --network sepolia
 */

const { ethers } = require('hardhat');

const SEPOLIA_MOCK_USDC = '0x771c293167AeD146EC4f56479056645Be46a0275';

async function main() {
    console.log('\n💵 Minting test USDC on Sepolia...\n');

    const [signer] = await ethers.getSigners();
    console.log('Minting to:', signer.address);

    // Get USDC contract
    const usdc = await ethers.getContractAt('MockUSDC', SEPOLIA_MOCK_USDC);

    // Check current balance
    const balanceBefore = await usdc.balanceOf(signer.address);
    console.log('Current USDC balance:', ethers.formatUnits(balanceBefore, 6), 'USDC');

    // Mint 10,000 USDC
    const mintAmount = ethers.parseUnits('10000', 6);
    console.log('\nMinting', ethers.formatUnits(mintAmount, 6), 'USDC...');

    const mintTx = await usdc.mint(signer.address, mintAmount);
    console.log('Transaction hash:', mintTx.hash);
    await mintTx.wait();

    // Check new balance
    const balanceAfter = await usdc.balanceOf(signer.address);
    console.log('\n✅ Mint successful!');
    console.log('New USDC balance:', ethers.formatUnits(balanceAfter, 6), 'USDC\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
