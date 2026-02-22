/**
 * Add Liquidity to Base Mainnet
 * Supplies USDC to AgentLiquidityMarketplace for agents to borrow
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Base Mainnet config
const RPC_URL = 'https://mainnet.base.org';
const CHAIN_ID = 8453;

// Contract addresses (from base-addresses.json)
const addresses = require('../src/config/base-addresses.json');

// ABIs
const marketplaceAbi = require('../abis/AgentLiquidityMarketplace.json').abi;
const usdcAbi = [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)'
];

async function main() {
    console.log('==========================================');
    console.log('  Add Liquidity to Base Mainnet');
    console.log('==========================================\n');

    // Get private key from env
    const privateKey = process.env.PRIVATE_KEY;
    if (!privateKey) {
        console.error('❌ PRIVATE_KEY not set in environment');
        console.log('\nUsage:');
        console.log('  PRIVATE_KEY=0x... SUPPLY_AMOUNT=1000 node scripts/add-base-liquidity.js');
        process.exit(1);
    }

    // Get supply amount (default 1000 USDC)
    const supplyAmount = process.env.SUPPLY_AMOUNT || '1000';
    const amountUSDC = ethers.parseUnits(supplyAmount, 6); // USDC has 6 decimals

    // Setup provider and wallet
    const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet(privateKey, provider);

    console.log(`📍 Wallet: ${wallet.address}`);
    console.log(`🌐 Network: Base Mainnet (Chain ID: ${CHAIN_ID})`);
    console.log(`💰 Supply Amount: ${supplyAmount} USDC\n`);

    // Connect to contracts
    const usdc = new ethers.Contract(addresses.usdc, usdcAbi, wallet);
    const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, marketplaceAbi, wallet);

    // Step 1: Check balances
    console.log('📊 Step 1: Checking balances...');
    const ethBalance = await provider.getBalance(wallet.address);
    const usdcBalance = await usdc.balanceOf(wallet.address);

    console.log(`   ETH: ${ethers.formatEther(ethBalance)}`);
    console.log(`   USDC: ${ethers.formatUnits(usdcBalance, 6)}`);

    if (usdcBalance < amountUSDC) {
        console.error(`\n❌ Insufficient USDC balance!`);
        console.error(`   Need: ${supplyAmount} USDC`);
        console.error(`   Have: ${ethers.formatUnits(usdcBalance, 6)} USDC`);
        console.log('\n💡 To get USDC on Base:');
        console.log('   1. Bridge from Ethereum: https://bridge.base.org');
        console.log('   2. Buy on Base DEX: Uniswap, Aerodrome, etc.');
        process.exit(1);
    }

    // Step 2: Approve USDC
    console.log('\n✅ Step 2: Approving USDC...');
    const currentAllowance = await usdc.allowance(wallet.address, addresses.agentLiquidityMarketplace);

    if (currentAllowance < amountUSDC) {
        console.log('   Sending approval transaction...');
        const approveTx = await usdc.approve(addresses.agentLiquidityMarketplace, amountUSDC);
        console.log(`   Tx: ${approveTx.hash}`);
        await approveTx.wait();
        console.log('   ✓ Approval confirmed');
    } else {
        console.log('   ✓ Already approved');
    }

    // Step 3: Check if pool exists for this agent
    console.log('\n🏊 Step 3: Checking for existing pool...');

    // Get agent ID
    const registry = new ethers.Contract(
        addresses.agentRegistryV2,
        ['function addressToAgentId(address) view returns (uint256)'],
        provider
    );
    const agentId = await registry.addressToAgentId(wallet.address);
    console.log(`   Agent ID: ${agentId}`);

    if (agentId === 0n) {
        console.log('\n⚠️  You are not registered as an agent!');
        console.log('   First register: call AgentRegistryV2.register()');
        console.log(`   Contract: ${addresses.agentRegistryV2}`);
        process.exit(1);
    }

    // Check for existing pool
    const totalPools = await marketplace.totalPools();
    let existingPoolId = 0;

    for (let i = 1; i <= Number(totalPools); i++) {
        const pool = await marketplace.pools(i);
        if (pool.agentId === agentId) {
            existingPoolId = i;
            console.log(`   ✓ Found existing pool: ID ${i}`);
            break;
        }
    }

    // Step 4: Supply liquidity
    console.log('\n💧 Step 4: Supplying liquidity...');

    let tx;
    if (existingPoolId > 0) {
        // Add to existing pool
        console.log(`   Adding ${supplyAmount} USDC to pool ${existingPoolId}...`);
        tx = await marketplace.supplyLiquidity(existingPoolId, amountUSDC);
    } else {
        // Create new pool
        console.log(`   Creating new pool with ${supplyAmount} USDC...`);
        tx = await marketplace.createPool(agentId, amountUSDC);
    }

    console.log(`   Tx: ${tx.hash}`);
    console.log('   Waiting for confirmation...');
    const receipt = await tx.wait();
    console.log(`   ✓ Confirmed in block ${receipt.blockNumber}`);

    // Step 5: Verify
    console.log('\n🔍 Step 5: Verifying...');

    const poolId = existingPoolId || Number(totalPools) + 1;
    const pool = await marketplace.pools(poolId);

    console.log(`\n📊 Pool Stats:`);
    console.log(`   Pool ID: ${poolId}`);
    console.log(`   Agent ID: ${pool.agentId}`);
    console.log(`   Total Liquidity: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`);
    console.log(`   Available: ${ethers.formatUnits(pool.availableLiquidity, 6)} USDC`);
    console.log(`   Lender Count: ${pool.lenderCount}`);
    console.log(`   Active: ${pool.isActive}`);

    console.log('\n==========================================');
    console.log('  ✅ Liquidity Added Successfully!');
    console.log('==========================================');
    console.log(`\n🎉 Agents can now borrow from pool ${poolId}!`);
    console.log(`\n🔗 View on BaseScan:`);
    console.log(`   https://basescan.org/tx/${tx.hash}`);
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error('\n❌ Error:', error.message);
        process.exit(1);
    });
