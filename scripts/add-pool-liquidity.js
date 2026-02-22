/**
 * Add Liquidity to Pool #43
 *
 * This script:
 * 1. Mints 500 USDC to lender (if needed)
 * 2. Approves DepositRouter to spend USDC
 * 3. Deposits 500 USDC to Pool #43
 * 4. Verifies new pool state
 */

const { ethers } = require('ethers');
const addresses = require('../src/config/arc-testnet-addresses.json');

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const LENDER_KEY = process.env.LENDER_KEY || '0x41adb1d6ef22647a3de0e7993f4e33ec7bcd5b49359587967750ff8f3faddf67';
const AMOUNT_TO_ADD = process.env.AMOUNT || '500'; // USDC to add

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║         ADD LIQUIDITY TO POOL #43               ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const lender = new ethers.Wallet(LENDER_KEY, provider);

    console.log(`🔑 Lender: ${lender.address}\n`);

    // Contract instances
    const usdc = new ethers.Contract(
        addresses.mockUSDC,
        [
            'function balanceOf(address) view returns (uint256)',
            'function approve(address,uint256) returns (bool)',
            'function mint(address,uint256)'
        ],
        provider
    );

    const depositRouter = new ethers.Contract(
        addresses.depositRouter,
        ['function depositToAgentPool(uint256,uint256)'],
        provider
    );

    // Step 1: Check current balance
    console.log('📊 Step 1: Checking current balance...\n');

    const currentBalance = await usdc.balanceOf(lender.address);
    console.log(`   Current balance: ${ethers.formatUnits(currentBalance, 6)} USDC`);

    const amountToAdd = ethers.parseUnits(AMOUNT_TO_ADD, 6);
    console.log(`   Amount to add: ${AMOUNT_TO_ADD} USDC`);
    console.log(`   Pool ID: 43\n`);

    // Step 2: Mint if needed
    if (currentBalance < amountToAdd) {
        const needed = amountToAdd - currentBalance;
        console.log(`💵 Step 2: Minting ${ethers.formatUnits(needed, 6)} USDC...\n`);

        const mintTx = await usdc.connect(lender).mint(lender.address, needed);
        console.log(`   Transaction: ${mintTx.hash}`);
        await mintTx.wait();
        console.log(`   ✅ Minted!\n`);

        const newBalance = await usdc.balanceOf(lender.address);
        console.log(`   New balance: ${ethers.formatUnits(newBalance, 6)} USDC\n`);
    } else {
        console.log(`✅ Step 2: Sufficient balance, skipping mint\n`);
    }

    // Step 3: Approve
    console.log(`🔓 Step 3: Approving DepositRouter...\n`);

    const approveTx = await usdc.connect(lender).approve(addresses.depositRouter, amountToAdd);
    console.log(`   Transaction: ${approveTx.hash}`);
    await approveTx.wait();
    console.log(`   ✅ Approved!\n`);

    // Step 4: Deposit
    console.log(`💧 Step 4: Depositing to Pool #43...\n`);

    const depositTx = await depositRouter.connect(lender).depositToAgentPool(43, amountToAdd);
    console.log(`   Transaction: ${depositTx.hash}`);
    const receipt = await depositTx.wait();
    console.log(`   ✅ Deposited!\n`);

    // Step 5: Verify via API
    console.log(`📈 Step 5: Verifying pool state...\n`);

    const poolResponse = await fetch('http://localhost:3001/pools/43');
    const pool = await poolResponse.json();

    console.log(`   Pool #43 Updated State:`);
    console.log(`      Total Liquidity:    ${pool.totalLiquidityUsdc} USDC`);
    console.log(`      Available:          ${pool.availableLiquidityUsdc} USDC`);
    console.log(`      Total Loaned:       ${pool.totalLoanedUsdc} USDC`);
    console.log(`      Utilization:        ${pool.utilizationPct}%`);
    console.log(`      Total Earned:       ${pool.totalEarnedUsdc} USDC\n`);

    // Calculate health
    const util = parseFloat(pool.utilizationPct);
    const health = util > 90 ? '🔴 High utilization' :
                   util > 75 ? '🟡 Moderate utilization' :
                   '🟢 Healthy utilization';

    console.log(`   Pool Health: ${health}`);
    console.log(`   Withdrawal Capacity: ${parseFloat(pool.availableLiquidityUsdc).toFixed(2)} USDC\n`);

    console.log('═'.repeat(70));
    console.log('✅ LIQUIDITY ADDED SUCCESSFULLY');
    console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
