/**
 * Migrate from first V3 to second V3 (fixed version)
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n💧 Migrating to V3 Final\n');

    const [signer] = await ethers.getSigners();

    const firstV3Address = "0xF7077e5bA6B0F3BDa8E22CdD1Fb395e18d7D18F0";
    const secondV3Address = "0x309C6463477aF7bB7dc907840495764168094257";
    const usdcAddress = "0x771c293167AeD146EC4f56479056645Be46a0275";

    const firstV3 = await ethers.getContractAt('LendingPoolV2', firstV3Address);
    const secondV3 = await ethers.getContractAt('LendingPoolV3', secondV3Address);
    const usdc = await ethers.getContractAt('MockUSDC', usdcAddress);

    // Get available liquidity from first V3
    const amount = await firstV3.availableLiquidity();
    console.log('Amount to migrate:', ethers.formatUnits(amount, 6), 'USDC\n');

    // Withdraw from first V3
    console.log('1️⃣  Withdrawing from first V3...');
    const withdrawTx = await firstV3.withdrawLiquidity(amount);
    await withdrawTx.wait();
    console.log('✅ Withdrawn\n');

    // Approve second V3
    console.log('2️⃣  Approving second V3...');
    const approveTx = await usdc.approve(secondV3Address, amount);
    await approveTx.wait();
    console.log('✅ Approved\n');

    // Deposit to second V3
    console.log('3️⃣  Depositing to second V3...');
    const depositTx = await secondV3.depositLiquidity(amount);
    await depositTx.wait();
    console.log('✅ Deposited\n');

    const finalAmount = await secondV3.availableLiquidity();
    console.log('📊 V3 Final Liquidity:', ethers.formatUnits(finalAmount, 6), 'USDC ⚡');

    console.log('\n✅ Migration Complete!');
    console.log('\n🎯 Test auto-approve now:');
    console.log('   npx hardhat run scripts/test-auto-approve.js --network sepolia\n');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
