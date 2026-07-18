/**
 * Configure Base Sepolia Contracts
 *
 * Properly authorize the marketplace on ReputationManagerV3
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://sepolia.base.org';
const DEPLOYER_KEY = process.env.PRIVATE_KEY;

async function main() {
    console.log('\n🔧 CONFIGURING BASE SEPOLIA CONTRACTS\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);

    console.log(`Deployer: ${deployer.address}`);
    console.log(`Balance: ${ethers.formatEther(await provider.getBalance(deployer.address))} ETH\n`);

    // Load addresses
    const addresses = JSON.parse(
        fs.readFileSync('./src/config/base-sepolia-addresses.json', 'utf8')
    );

    // Load ABI
    const rmAbi = JSON.parse(
        fs.readFileSync('./artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json', 'utf8')
    ).abi;

    const rm = new ethers.Contract(addresses.ReputationManagerV3, rmAbi, deployer);

    console.log('═'.repeat(70));
    console.log('AUTHORIZE MARKETPLACE');
    console.log('═'.repeat(70) + '\n');

    // Check current state
    const isAuthorized = await rm.authorizedPools(addresses.AgentLiquidityMarketplace);
    console.log(`Marketplace currently authorized? ${isAuthorized}\n`);

    if (!isAuthorized) {
        console.log('🔧 Authorizing marketplace...\n');

        // Get gas price
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice * 120n / 100n;

        const tx = await rm.authorizePool(addresses.AgentLiquidityMarketplace, { gasPrice });
        const receipt = await tx.wait();

        console.log(`   ✅ Authorized!`);
        console.log(`   📋 Tx: ${receipt.hash}`);
        console.log(`   ⛽ Gas used: ${receipt.gasUsed.toString()}\n`);
    } else {
        console.log('   ✅ Already authorized!\n');
    }

    console.log('═'.repeat(70));
    console.log('CONFIGURATION COMPLETE');
    console.log('═'.repeat(70) + '\n');

    console.log('🎯 Next step: Run test-base-sepolia.js\n');
}

main().catch(err => {
    console.error('\n❌ Configuration failed:', err.message);
    process.exit(1);
});
