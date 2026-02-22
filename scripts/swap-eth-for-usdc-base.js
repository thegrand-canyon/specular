/**
 * Swap ETH for USDC on Base Mainnet
 * Uses Uniswap V3 on Base
 */

const { ethers } = require('ethers');

const RPC_URL = 'https://mainnet.base.org';
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Base mainnet addresses
const WETH = '0x4200000000000000000000000000000000000006'; // Wrapped ETH on Base
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base
const UNISWAP_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481'; // Uniswap V3 SwapRouter on Base

// Uniswap V3 Router ABI (minimal)
const ROUTER_ABI = [
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)'
];

const USDC_ABI = [
    'function balanceOf(address) view returns (uint256)',
    'function decimals() view returns (uint8)'
];

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  SWAP ETH → USDC ON BASE                         ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(PRIVATE_KEY, provider);

    console.log(`🔑 Wallet: ${wallet.address}\n`);

    // Check balances before
    console.log('📊 Current Balances:');
    const ethBefore = await provider.getBalance(wallet.address);
    const usdcContract = new ethers.Contract(USDC, USDC_ABI, provider);
    const usdcBefore = await usdcContract.balanceOf(wallet.address);

    console.log(`   ETH: ${ethers.formatEther(ethBefore)}`);
    console.log(`   USDC: ${ethers.formatUnits(usdcBefore, 6)}\n`);

    // Amount to swap (0.03 ETH)
    const amountIn = ethers.parseEther('0.03');
    console.log(`💱 Swapping ${ethers.formatEther(amountIn)} ETH for USDC...\n`);

    // Connect to router
    const router = new ethers.Contract(UNISWAP_ROUTER, ROUTER_ABI, wallet);

    // Set up swap parameters
    // Using 0.05% fee tier (most liquid for USDC/WETH on Base)
    const params = {
        tokenIn: WETH,
        tokenOut: USDC,
        fee: 500, // 0.05% fee tier
        recipient: wallet.address,
        amountIn: amountIn,
        amountOutMinimum: 0, // Accept any amount (for testnet - in production use proper slippage)
        sqrtPriceLimitX96: 0
    };

    try {
        // Execute swap
        console.log('⏳ Executing swap...');
        const tx = await router.exactInputSingle(params, {
            value: amountIn, // Send ETH with the transaction
            gasLimit: 500000
        });

        console.log(`   TX: ${tx.hash}`);
        console.log(`   Waiting for confirmation...`);

        const receipt = await tx.wait();
        console.log(`   ✅ Swap confirmed! (Block: ${receipt.blockNumber})\n`);

        // Wait a moment for balance to update
        await new Promise(r => setTimeout(r, 3000));

        // Check balances after
        console.log('📊 New Balances:');
        const ethAfter = await provider.getBalance(wallet.address);
        const usdcAfter = await usdcContract.balanceOf(wallet.address);

        console.log(`   ETH: ${ethers.formatEther(ethAfter)}`);
        console.log(`   USDC: ${ethers.formatUnits(usdcAfter, 6)}\n`);

        // Calculate changes
        const ethSpent = ethBefore - ethAfter;
        const usdcReceived = usdcAfter - usdcBefore;

        console.log('📈 Summary:');
        console.log(`   ETH Spent: ${ethers.formatEther(ethSpent)}`);
        console.log(`   USDC Received: ${ethers.formatUnits(usdcReceived, 6)}`);
        console.log(`   Exchange Rate: $${(Number(ethers.formatUnits(usdcReceived, 6)) / Number(ethers.formatEther(amountIn))).toFixed(2)} per ETH\n`);

        console.log('✅ Swap complete! Ready for production test.\n');
        console.log('🔜 Next step: Run production test');
        console.log('   PRIVATE_KEY=$PRIVATE_KEY node scripts/test-base-production.js\n');

    } catch (error) {
        console.error('\n❌ Swap failed:', error.message);

        if (error.message.includes('insufficient funds')) {
            console.error('\n⚠️  Insufficient ETH for gas + swap amount');
        } else if (error.message.includes('INSUFFICIENT_OUTPUT_AMOUNT')) {
            console.error('\n⚠️  Slippage too high. Try adjusting amountOutMinimum');
        } else {
            console.error(error);
        }

        process.exit(1);
    }
}

main().catch(err => {
    console.error('\n❌ Error:', err.message);
    process.exit(1);
});
