/**
 * Simple Base Sepolia Deployment (handles gas better)
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC_URL = 'https://sepolia.base.org';
const DEPLOYER_KEY = '0x4fd4d9c9340c0dcd1f4845483e488afde4c69685f9ff5deec756fbfc1afb02ac';

// Already deployed:
const DEPLOYED = {
    AgentRegistryV2: '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF'
};

async function main() {
    console.log('\n🚀 Continuing Base Sepolia Deployment...\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);

    console.log(`Deployer: ${deployer.address}`);
    console.log(`Balance: ${ethers.formatEther(await provider.getBalance(deployer.address))} ETH\n`);

    const deployedAddresses = { ...DEPLOYED };

    // Helper to load artifact
    function loadArtifact(name) {
        const paths = [
            `./artifacts/contracts/${name}.sol/${name}.json`,
            `./artifacts/contracts/core/${name}.sol/${name}.json`,
            `./artifacts/contracts/tokens/${name}.sol/${name}.json`
        ];

        for (const p of paths) {
            try {
                return JSON.parse(fs.readFileSync(p, 'utf8'));
            } catch {}
        }
        throw new Error(`Cannot find ${name}`);
    }

    // Deploy with proper gas settings
    async function deploy(name, args = []) {
        if (deployedAddresses[name]) {
            console.log(`✅ ${name} already deployed: ${deployedAddresses[name]}\n`);
            return;
        }

        console.log(`📦 Deploying ${name}...`);

        const artifact = loadArtifact(name);
        const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);

        // Get current gas price and add 20%
        const feeData = await provider.getFeeData();
        const gasPrice = feeData.gasPrice * 120n / 100n;

        const contract = await factory.deploy(...args, { gasPrice });
        await contract.waitForDeployment();

        const address = await contract.getAddress();
        console.log(`   ✅ ${address}`);
        console.log(`   🔗 https://sepolia.basescan.org/address/${address}\n`);

        deployedAddresses[name] = address;
        await new Promise(r => setTimeout(r, 2000)); // Wait 2s between deploys
    }

    // Continue deployment
    await deploy('ReputationManagerV3', [deployedAddresses.AgentRegistryV2]);
    await deploy('MockUSDC');
    await deploy('AgentLiquidityMarketplace', [
        deployedAddresses.AgentRegistryV2,
        deployedAddresses.ReputationManagerV3,
        deployedAddresses.MockUSDC
    ]);
    await deploy('DepositRouter', [
        deployedAddresses.AgentLiquidityMarketplace,
        deployedAddresses.MockUSDC
    ]);
    await deploy('ValidationRegistry');

    // Configure
    console.log('🔧 Configuring...');
    const rm = new ethers.Contract(
        deployedAddresses.ReputationManagerV3,
        loadArtifact('ReputationManagerV3').abi,
        deployer
    );

    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice * 120n / 100n;

    const tx = await rm.setTrustedCaller(deployedAddresses.AgentLiquidityMarketplace, true, { gasPrice });
    await tx.wait();
    console.log('   ✅ Marketplace authorized\n');

    // Save
    fs.writeFileSync(
        './src/config/base-sepolia-addresses.json',
        JSON.stringify(deployedAddresses, null, 2)
    );

    console.log('✅ DEPLOYMENT COMPLETE!\n');
    console.log('Addresses saved to: src/config/base-sepolia-addresses.json\n');
}

main().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});
