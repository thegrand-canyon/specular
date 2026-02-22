/**
 * Generate New Wallet
 *
 * Creates a new Ethereum wallet for getting Sepolia ETH from faucets
 */

const { ethers } = require('ethers');

async function main() {
    console.log('\n🔑 Generating New Wallet...\n');

    // Create random wallet
    const wallet = ethers.Wallet.createRandom();

    console.log('═════════════════════════════════════');
    console.log('NEW WALLET GENERATED');
    console.log('═════════════════════════════════════\n');

    console.log('📍 Address:');
    console.log(wallet.address);
    console.log('\n🔐 Private Key:');
    console.log(wallet.privateKey);
    console.log('\n🌱 Mnemonic Phrase:');
    console.log(wallet.mnemonic.phrase);

    console.log('\n\n💡 Next Steps:\n');
    console.log('1. Get Sepolia ETH from faucet:');
    console.log('   https://cloud.google.com/application/web3/faucet/ethereum/sepolia\n');
    console.log('2. Paste this address:');
    console.log('   ' + wallet.address + '\n');
    console.log('3. Once you have ETH, add this to your .env file:');
    console.log('   PRIVATE_KEY=' + wallet.privateKey + '\n');
    console.log('4. Or transfer ETH to your main wallet:');
    console.log('   0x656086A21073272533c8A3f56A94c1f3D8BCFcE2\n');

    console.log('⚠️  IMPORTANT: Save this information securely!\n');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
