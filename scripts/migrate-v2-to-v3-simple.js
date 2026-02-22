/**
 * Simple V2 to V3 Migration
 * Withdraws totalLiquidity from V2 and deposits to V3
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n💧 Migrating Liquidity V2 → V3\n');

    const [signer] = await ethers.getSigners();
    console.log('Account:', signer.address);

    // Load addresses
    const addressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const addresses = JSON.parse(fs.readFileSync(addressesPath, 'utf8'));

    const lendingPoolV2 = await ethers.getContractAt('LendingPoolV2', addresses.lendingPoolV2);
    const lendingPoolV3 = await ethers.getContractAt('LendingPoolV3', addresses.lendingPool);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    // Get V2 totalLiquidity (not available, to avoid underflow)
    const v2TotalLiquidity = await lendingPoolV2.totalLiquidity();
    console.log('V2 Total Liquidity:', ethers.formatUnits(v2TotalLiquidity, 6), 'USDC');
    console.log('Withdrawing totalLiquidity amount to avoid underflow...\n');

    // Withdraw from V2
    console.log('1️⃣  Withdrawing from V2...');
    const withdrawTx = await lendingPoolV2.withdrawLiquidity(v2TotalLiquidity);
    await withdrawTx.wait();
    console.log('✅ Withdrawn:', ethers.formatUnits(v2TotalLiquidity, 6), 'USDC\n');

    // Approve V3
    console.log('2️⃣  Approving V3...');
    const approveTx = await usdc.approve(addresses.lendingPool, v2TotalLiquidity);
    await approveTx.wait();
    console.log('✅ Approved\n');

    // Deposit to V3
    console.log('3️⃣  Depositing to V3...');
    const depositTx = await lendingPoolV3.depositLiquidity(v2TotalLiquidity);
    await depositTx.wait();
    console.log('✅ Deposited to V3\n');

    // Check final balances
    const v3Available = await lendingPoolV3.availableLiquidity();
    console.log('📊 V3 Pool Status:');
    console.log('  Available:', ethers.formatUnits(v3Available, 6), 'USDC ⚡');
    
    console.log('\n✅ Migration Complete!');
    console.log('\n🎯 Next: Test auto-approve');
    console.log('   npx hardhat run scripts/test-auto-approve.js --network sepolia\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
