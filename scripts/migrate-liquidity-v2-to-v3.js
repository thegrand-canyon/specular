/**
 * Migrate Liquidity from V2 to V3
 *
 * Withdraws liquidity from V2 pool and deposits into V3 pool
 *
 * Usage: npx hardhat run scripts/migrate-liquidity-v2-to-v3.js --network sepolia
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

    if (!addresses.lendingPoolV2) {
        console.log('❌ V2 pool address not found. Deploy V3 first.');
        process.exit(1);
    }

    // Get contracts
    const lendingPoolV2 = await ethers.getContractAt('LendingPoolV2', addresses.lendingPoolV2);
    const lendingPoolV3 = await ethers.getContractAt('LendingPoolV3', addresses.lendingPool);
    const usdc = await ethers.getContractAt('MockUSDC', addresses.mockUSDC);

    // Check V2 status
    console.log('📊 V2 Pool Status:');
    console.log('─────────────────────────────────────');

    const v2TotalLiquidity = await lendingPoolV2.totalLiquidity();
    const v2Available = await lendingPoolV2.availableLiquidity();
    const v2Loaned = await lendingPoolV2.totalLoaned();

    console.log('Total Liquidity:', ethers.formatUnits(v2TotalLiquidity, 6), 'USDC');
    console.log('Available:', ethers.formatUnits(v2Available, 6), 'USDC');
    console.log('Currently Loaned:', ethers.formatUnits(v2Loaned, 6), 'USDC');

    if (v2Loaned > 0n) {
        console.log('\n⚠️  WARNING: V2 has active loans!');
        console.log('Cannot withdraw loaned amount.');
        console.log('Options:');
        console.log('  1. Migrate only available liquidity now');
        console.log('  2. Wait for all loans to be repaid');
        console.log('  3. Keep both pools running');
    }

    // Check V3 status
    console.log('\n📊 V3 Pool Status:');
    console.log('─────────────────────────────────────');

    const v3TotalLiquidity = await lendingPoolV3.totalLiquidity();
    const v3Available = await lendingPoolV3.availableLiquidity();

    console.log('Total Liquidity:', ethers.formatUnits(v3TotalLiquidity, 6), 'USDC');
    console.log('Available:', ethers.formatUnits(v3Available, 6), 'USDC');

    // Determine migration amount
    const migrationAmount = v2Available;

    if (migrationAmount === 0n) {
        console.log('\n❌ No available liquidity to migrate');
        process.exit(0);
    }

    console.log('\n💰 Migration Plan:');
    console.log('─────────────────────────────────────');
    console.log('Amount to migrate:', ethers.formatUnits(migrationAmount, 6), 'USDC');

    // Ask for confirmation (in production)
    console.log('\n⏳ Starting migration...');

    // Step 1: Withdraw from V2
    console.log('\n1️⃣  Withdrawing from V2...');
    const withdrawTx = await lendingPoolV2.withdrawLiquidity(migrationAmount);
    await withdrawTx.wait();
    console.log('✅ Withdrawn from V2');

    // Check USDC balance
    const usdcBalance = await usdc.balanceOf(signer.address);
    console.log('   USDC in wallet:', ethers.formatUnits(usdcBalance, 6));

    // Step 2: Approve V3
    console.log('\n2️⃣  Approving V3 to spend USDC...');
    const approveTx = await usdc.approve(addresses.lendingPool, migrationAmount);
    await approveTx.wait();
    console.log('✅ Approved');

    // Step 3: Deposit to V3
    console.log('\n3️⃣  Depositing to V3...');
    const depositTx = await lendingPoolV3.depositLiquidity(migrationAmount);
    await depositTx.wait();
    console.log('✅ Deposited to V3');

    // Final status
    console.log('\n📊 Final Status:');
    console.log('═════════════════════════════════════');

    const v2FinalAvailable = await lendingPoolV2.availableLiquidity();
    const v3FinalAvailable = await lendingPoolV3.availableLiquidity();

    console.log('\nV2 Pool:');
    console.log('  Available:', ethers.formatUnits(v2FinalAvailable, 6), 'USDC');
    console.log('  Status:', v2FinalAvailable === 0n ? 'Empty ✓' : 'Still has liquidity');

    console.log('\nV3 Pool:');
    console.log('  Available:', ethers.formatUnits(v3FinalAvailable, 6), 'USDC');
    console.log('  Status:', 'Ready for auto-approve loans! ⚡');

    console.log('\n✅ Migration Complete!');
    console.log('\n🎯 Next Steps:');
    console.log('1. Test V3 auto-approve:');
    console.log('   npx hardhat run scripts/test-auto-approve.js --network sepolia');
    console.log('\n2. Update website to use V3 address:');
    console.log('   ', addresses.lendingPool);
    console.log('\n3. Monitor both pools during transition period\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
