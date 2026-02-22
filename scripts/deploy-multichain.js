/**
 * Deploy Multichain Infrastructure
 * Deploys CCTP bridges on source chains and routers on Arc
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    console.log('\n🌐 DEPLOYING MULTICHAIN INFRASTRUCTURE\n');
    console.log('═══════════════════════════════════════════════════════\n');

    const [deployer] = await ethers.getSigners();
    const network = await ethers.provider.getNetwork();
    const chainId = Number(network.chainId);

    console.log(`Deployer: ${deployer.address}`);
    console.log(`Network: ${network.name} (${chainId})\n`);

    // Load existing Arc addresses
    const arcAddressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
    let arcAddresses = {};
    try {
        arcAddresses = JSON.parse(fs.readFileSync(arcAddressesPath, 'utf8'));
    } catch (error) {
        console.log('⚠️  No Arc addresses found. Deploy to Arc first.\n');
    }

    // Deploy DepositRouter on Arc
    if (chainId === 5042002) {
        console.log('🔷 DEPLOYING ARC INFRASTRUCTURE\n');

        console.log('1️⃣  Deploying DepositRouter...');
        const DepositRouter = await ethers.getContractFactory('DepositRouter');
        const router = await DepositRouter.deploy(
            arcAddresses.mockUSDC,
            arcAddresses.agentLiquidityMarketplace
        );
        await router.waitForDeployment();
        const routerAddress = await router.getAddress();
        console.log(`   ✅ DepositRouter: ${routerAddress}\n`);

        // Save addresses
        const updatedAddresses = {
            ...arcAddresses,
            depositRouter: routerAddress
        };

        const addressesPath = path.join(__dirname, '..', 'src', 'config', 'arc-testnet-addresses.json');
        fs.writeFileSync(addressesPath, JSON.stringify(updatedAddresses, null, 2));

        console.log('✅ Arc infrastructure deployed!\n');
    }

    console.log('✅ Deployment complete! 🚀\n');
}

main().catch(error => {
    console.error('Deployment failed:', error);
    process.exit(1);
});
