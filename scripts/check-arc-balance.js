/**
 * Check Arc Testnet Balance
 * Note: Arc uses USDC as native gas token!
 */

const { ethers } = require('hardhat');

async function main() {
    console.log('\n💰 ARC TESTNET BALANCE CHECK\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();

    console.log(`Address: ${deployer.address}\n`);

    // Get USDC balance (native gas on Arc - 18 decimals!)
    const balance = await ethers.provider.getBalance(deployer.address);

    console.log('💵 USDC Balance (Native Gas):');
    console.log(`   ${ethers.formatEther(balance)} USDC\n`);

    if (balance < ethers.parseEther('1')) {
        console.log('⚠️  Low USDC! You need USDC for gas on Arc testnet.\n');
        console.log('🚰 Get USDC from faucet:');
        console.log('   https://faucet.circle.com\n');
        console.log('Steps:');
        console.log('1. Go to https://faucet.circle.com');
        console.log('2. Select "Arc Testnet"');
        console.log(`3. Enter your address: ${deployer.address}`);
        console.log('4. Request testnet USDC\n');
    } else {
        console.log('✅ Sufficient USDC for deployment!\n');
        console.log(`💡 On Arc testnet, USDC is the native gas token.`);
        console.log('   No need for ETH - gas fees are paid in USDC!\n');
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
