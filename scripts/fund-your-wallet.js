/**
 * Fund your secure wallet with test USDC from faucet
 */

const { ethers } = require('ethers');

const FAUCET_KEY = process.env.FAUCET_PRIVATE_KEY;
if (!FAUCET_KEY) {
    throw new Error('FAUCET_PRIVATE_KEY environment variable is required (use old compromised key if needed for faucet)');
}
const YOUR_WALLET = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';
const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';

async function fund() {
    console.log('═══════════════════════════════════════');
    console.log('  FUNDING YOUR WALLET WITH TEST USDC');
    console.log('═══════════════════════════════════════\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const faucet = new ethers.Wallet(FAUCET_KEY, provider);
    const usdc = new ethers.Contract(
        '0xf2807051e292e945751A25616705a9aadfb39895',
        ['function transfer(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'],
        faucet
    );

    // Check faucet balance
    const faucetBal = await usdc.balanceOf(faucet.address);
    console.log('Faucet wallet:', faucet.address);
    console.log('Faucet USDC:', ethers.formatUnits(faucetBal, 6));
    console.log('');

    // Check your current balance
    const yourBal = await usdc.balanceOf(YOUR_WALLET);
    console.log('Your wallet:', YOUR_WALLET);
    console.log('Your current USDC:', ethers.formatUnits(yourBal, 6));
    console.log('');

    // Send 100 USDC
    console.log('Sending 100 USDC to your wallet...');
    const amount = ethers.parseUnits('100', 6);
    const tx = await usdc.transfer(YOUR_WALLET, amount);
    console.log('TX:', tx.hash);
    await tx.wait();
    console.log('✅ Sent!');
    console.log('');

    // Check new balance
    const newBal = await usdc.balanceOf(YOUR_WALLET);
    console.log('Your new USDC balance:', ethers.formatUnits(newBal, 6));
    console.log('');
    console.log('═══════════════════════════════════════');
    console.log('  ✅ YOUR WALLET IS FUNDED!');
    console.log('═══════════════════════════════════════');
}

fund().catch((e) => { console.error(e); process.exit(1); });
