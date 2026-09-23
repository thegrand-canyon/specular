/**
 * Supply liquidity to Arc Testnet lending pool
 */

console.log('Script starting...');

const { ethers } = require('ethers');
const fs = require('fs');

console.log('Loaded libraries...');

const YOUR_KEY = process.env.PRIVATE_KEY;
if (!YOUR_KEY) {
    throw new Error('PRIVATE_KEY environment variable is required');
}
const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';

console.log('Loading config files...');
const addresses = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const mpAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;
const usdcAbi = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'];

console.log('Config loaded. Starting supply function...\n');

async function supply() {
    console.log('═══════════════════════════════════════');
    console.log('  SUPPLYING LIQUIDITY TO ARC TESTNET');
    console.log('═══════════════════════════════════════\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(YOUR_KEY, provider);

    const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, mpAbi, wallet);
    const usdc = new ethers.Contract(addresses.mockUSDC, usdcAbi, wallet);

    // Check balance
    const bal = await usdc.balanceOf(wallet.address);
    console.log('Your wallet:', wallet.address);
    console.log('Your USDC:', ethers.formatUnits(bal, 6));
    console.log('');

    // Supply 30 USDC (enough for 3 demo loans)
    const supplyAmount = ethers.parseUnits('30', 6);
    console.log('Supplying 30 USDC to lending pool...');
    console.log('');

    // Step 1: Approve
    console.log('Step 1: Approving USDC...');
    const approveTx = await usdc.approve(addresses.agentLiquidityMarketplace, supplyAmount);
    await approveTx.wait();
    console.log('✅ Approved');

    // Step 2: Supply to agent ID 48 (the demo agent)
    console.log('Step 2: Supplying liquidity for demo agent (ID 48)...');
    const supplyTx = await marketplace.supplyLiquidity(48, supplyAmount);
    console.log('TX:', supplyTx.hash);
    await supplyTx.wait();
    console.log('✅ Supplied!');
    console.log('');

    console.log('═══════════════════════════════════════');
    console.log('  ✅ LIQUIDITY POOL CREATED!');
    console.log('  Demo agent can now borrow.');
    console.log('═══════════════════════════════════════');
}

supply().catch((e) => { console.error(e); process.exit(1); });
