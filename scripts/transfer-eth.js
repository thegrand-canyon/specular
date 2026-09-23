/**
 * Transfer ETH Between Wallets
 *
 * Transfers ETH from one wallet to another on Sepolia
 *
 * Usage:
 *   node scripts/transfer-eth.js <from-private-key> <to-address> <amount-in-eth>
 *
 * Example:
 *   node scripts/transfer-eth.js 0x407... 0x656... 0.009
 */

const { ethers } = require('ethers');

async function main() {
    const args = process.argv.slice(2);

    if (args.length < 3) {
        console.log('\n❌ Missing arguments!\n');
        console.log('Usage:');
        console.log('  node scripts/transfer-eth.js <from-private-key> <to-address> <amount>\n');
        console.log('Example:');
        console.log('  node scripts/transfer-eth.js 0x<from-private-key> 0x<to-address> 0.009\n');
        process.exit(1);
    }

    const [privateKey, toAddress, amountStr] = args;

    console.log('\n💸 Transferring ETH on Sepolia...\n');

    // Connect to Sepolia
    const provider = new ethers.JsonRpcProvider('https://ethereum-sepolia-rpc.publicnode.com');
    const wallet = new ethers.Wallet(privateKey, provider);

    console.log('From:', wallet.address);
    console.log('To:', toAddress);
    console.log('Amount:', amountStr, 'ETH\n');

    // Check balance
    const balance = await provider.getBalance(wallet.address);
    console.log('Current balance:', ethers.formatEther(balance), 'ETH');

    const amount = ethers.parseEther(amountStr);

    if (balance < amount) {
        console.log('\n❌ Insufficient balance!');
        console.log('Requested:', ethers.formatEther(amount), 'ETH');
        console.log('Available:', ethers.formatEther(balance), 'ETH');
        process.exit(1);
    }

    // Send transaction
    console.log('\n⏳ Sending transaction...');

    const tx = await wallet.sendTransaction({
        to: toAddress,
        value: amount
    });

    console.log('Transaction hash:', tx.hash);
    console.log('Waiting for confirmation...');

    await tx.wait();

    console.log('✅ Transfer complete!\n');

    // Check new balance
    const newBalance = await provider.getBalance(wallet.address);
    console.log('New balance:', ethers.formatEther(newBalance), 'ETH\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
