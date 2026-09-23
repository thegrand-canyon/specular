/**
 * Send USDC from your wallet to demo agent wallet
 */

const { ethers } = require('ethers');

const YOUR_KEY = process.env.PRIVATE_KEY;
if (!YOUR_KEY) {
    throw new Error('PRIVATE_KEY environment variable is required');
}
const DEMO_AGENT = '0x1565D4c825C597f0A2B9AC5d1983F1A7F737A8C6';
const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';

async function fund() {
    console.log('═══════════════════════════════════════');
    console.log('  FUNDING DEMO AGENT');
    console.log('═══════════════════════════════════════\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(YOUR_KEY, provider);
    const usdc = new ethers.Contract(
        '0xf2807051e292e945751A25616705a9aadfb39895',
        ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'],
        wallet
    );

    // Check balances before
    const yourBal = await usdc.balanceOf(wallet.address);
    const demoBal = await usdc.balanceOf(DEMO_AGENT);

    console.log('Your wallet:', wallet.address);
    console.log('Your USDC:', ethers.formatUnits(yourBal, 6));
    console.log('');
    console.log('Demo agent:', DEMO_AGENT);
    console.log('Demo USDC:', ethers.formatUnits(demoBal, 6));
    console.log('');

    // Send 50 USDC
    console.log('Sending 50 USDC to demo agent...');
    const amount = ethers.parseUnits('50', 6);
    const tx = await usdc.transfer(DEMO_AGENT, amount);
    console.log('TX:', tx.hash);
    await tx.wait();
    console.log('✅ Sent!');
    console.log('');

    // Check balances after
    const newDemoBal = await usdc.balanceOf(DEMO_AGENT);
    console.log('Demo agent new balance:', ethers.formatUnits(newDemoBal, 6), 'USDC');
    console.log('');
    console.log('═══════════════════════════════════════');
    console.log('  ✅ DEMO AGENT IS FUNDED!');
    console.log('  Ready to start demo agent now.');
    console.log('═══════════════════════════════════════');
}

fund().catch((e) => { console.error(e); process.exit(1); });
