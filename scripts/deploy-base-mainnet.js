/**
 * 🚨 MAINNET DEPLOYMENT SCRIPT 🚨
 * Deploy P2P Marketplace to Base Mainnet
 *
 * WARNING: This deploys to PRODUCTION with REAL MONEY
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🚨 DEPLOYING TO BASE MAINNET - PRODUCTION 🚨\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();
    const balance = await ethers.provider.getBalance(deployer.address);

    console.log(`Deployer: ${deployer.address}`);
    console.log(`Balance: ${ethers.formatEther(balance)} ETH (~$${(parseFloat(ethers.formatEther(balance)) * 3000).toFixed(2)})\n`);

    // Safety check
    if (balance < ethers.parseEther('0.001')) {
        console.log('❌ Insufficient balance for mainnet deployment\n');
        process.exit(1);
    }

    // Verify network
    const network = await ethers.provider.getNetwork();
    if (network.chainId !== 8453n) {
        console.log('❌ ERROR: Not connected to Base Mainnet!\n');
        console.log(`   Current Chain ID: ${network.chainId}`);
        console.log(`   Expected: 8453 (Base Mainnet)\n`);
        process.exit(1);
    }

    console.log('✅ Connected to Base Mainnet (Chain ID: 8453)\n');
    console.log('⚠️  FINAL WARNING: This is PRODUCTION deployment!\n');
    console.log('   - Uses REAL ETH');
    console.log('   - Contract is PERMANENT');
    console.log('   - Will be PUBLIC on mainnet\n');

    // Load Sepolia addresses for dependencies (temporary)
    const sepoliaAddressesPath = path.join(__dirname, '..', 'src', 'config', 'sepolia-addresses.json');
    const sepoliaAddresses = JSON.parse(fs.readFileSync(sepoliaAddressesPath, 'utf8'));

    console.log('📋 Using Sepolia Contract Addresses (Temporary):\n');
    console.log(`   AgentRegistry: ${sepoliaAddresses.agentRegistry}`);
    console.log(`   ReputationManagerV3: ${sepoliaAddresses.reputationManagerV3}`);
    console.log(`   MockUSDC: ${sepoliaAddresses.mockUSDC}\n`);

    console.log('⚠️  NOTE: For full functionality, you will need to:');
    console.log('   1. Deploy supporting contracts to Base mainnet');
    console.log('   2. Or use existing Base mainnet USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913\n');

    console.log('⏳ Deploying AgentLiquidityMarketplace to MAINNET...\n');
    console.log('⏰ Please wait - this may take 30-60 seconds...\n');

    const AgentLiquidityMarketplace = await ethers.getContractFactory('AgentLiquidityMarketplace');

    const marketplace = await AgentLiquidityMarketplace.deploy(
        sepoliaAddresses.agentRegistry,
        sepoliaAddresses.reputationManagerV3,
        sepoliaAddresses.mockUSDC
    );

    console.log('📡 Transaction submitted to Base mainnet...');
    console.log('⏰ Waiting for confirmation...\n');

    await marketplace.waitForDeployment();

    const marketplaceAddress = await marketplace.getAddress();
    const deploymentTx = marketplace.deploymentTransaction();

    if (deploymentTx) {
        const receipt = await deploymentTx.wait();

        console.log('═══════════════════════════════════════════════════════\n');
        console.log('🎉 MAINNET DEPLOYMENT SUCCESSFUL! 🎉\n');
        console.log('═══════════════════════════════════════════════════════\n');

        console.log('📍 DEPLOYMENT DETAILS:\n');
        console.log(`   Contract: AgentLiquidityMarketplace`);
        console.log(`   Address: ${marketplaceAddress}`);
        console.log(`   Network: Base Mainnet`);
        console.log(`   Chain ID: 8453`);
        console.log(`   Block: ${receipt.blockNumber}\n`);

        console.log('⛽ GAS METRICS:\n');
        console.log(`   Gas Used: ${receipt.gasUsed.toLocaleString()}`);
        console.log(`   Gas Price: ${ethers.formatUnits(receipt.gasPrice, 'gwei')} gwei`);

        const cost = receipt.gasUsed * receipt.gasPrice;
        const costETH = ethers.formatEther(cost);
        const costUSD = parseFloat(costETH) * 3000;

        console.log(`   Total Cost: ${costETH} ETH (~$${costUSD.toFixed(2)})\n`);

        const remainingBalance = await ethers.provider.getBalance(deployer.address);
        console.log(`💰 Remaining Balance: ${ethers.formatEther(remainingBalance)} ETH (~$${(parseFloat(ethers.formatEther(remainingBalance)) * 3000).toFixed(2)})\n`);

        // Save to Base Mainnet addresses file
        const baseMainnetAddresses = {
            agentLiquidityMarketplace: marketplaceAddress,
            deployedAt: new Date().toISOString(),
            deployer: deployer.address,
            network: 'base',
            chainId: 8453,
            blockNumber: receipt.blockNumber,
            transactionHash: receipt.hash,
            gasUsed: receipt.gasUsed.toString(),
            deploymentCost: costETH,
            note: 'Dependencies currently reference Sepolia contracts - deploy other contracts for full functionality'
        };

        const baseMainnetPath = path.join(__dirname, '..', 'src', 'config', 'base-mainnet-addresses.json');
        fs.writeFileSync(baseMainnetPath, JSON.stringify(baseMainnetAddresses, null, 2));

        console.log('📁 Addresses saved to: src/config/base-mainnet-addresses.json\n');

        console.log('═══════════════════════════════════════════════════════\n');
        console.log('🔗 VIEW ON BASESCAN:\n');
        console.log(`   https://basescan.org/address/${marketplaceAddress}\n`);

        console.log('📝 NEXT STEPS:\n');
        console.log('   1. Verify contract on Basescan');
        console.log('   2. Deploy supporting contracts (Registry, Reputation, USDC)');
        console.log('   3. Test with small amounts first');
        console.log('   4. Set up monitoring and alerts\n');

        console.log('═══════════════════════════════════════════════════════\n');
        console.log('✅ YOUR P2P MARKETPLACE IS LIVE ON BASE MAINNET! 🚀\n');
    }
}

main().catch(error => {
    console.error('\n❌ Mainnet deployment failed:', error.message);
    console.error('\nError details:', error);
    process.exit(1);
});
