/**
 * Test Base Mainnet Deployment
 * Verifies all contracts are deployed and configured correctly
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://mainnet.base.org';
const DEPLOYER_KEY = process.env.PRIVATE_KEY;

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║  TEST BASE MAINNET DEPLOYMENT                    ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);

    // Load addresses
    const addresses = JSON.parse(fs.readFileSync('./src/config/base-addresses.json', 'utf8'));

    console.log('📋 Testing contracts...\n');

    let passed = 0;
    let failed = 0;

    // Test 1: Check all contracts have code
    console.log('1️⃣  Checking contract deployments...');
    for (const [name, address] of Object.entries(addresses)) {
        if (name === 'usdc') continue; // Skip USDC, it's external

        try {
            const code = await provider.getCode(address);
            if (code === '0x') {
                console.log(`   ❌ ${name}: No code at ${address}`);
                failed++;
            } else {
                console.log(`   ✅ ${name}: Deployed at ${address}`);
                passed++;
            }
        } catch (error) {
            console.log(`   ❌ ${name}: Error checking ${address}`);
            failed++;
        }
    }
    console.log();

    // Test 2: Check ownership
    console.log('2️⃣  Checking contract ownership...');

    const registryAbi = JSON.parse(fs.readFileSync(
        './artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json',
        'utf8'
    )).abi;

    const rmAbi = JSON.parse(fs.readFileSync(
        './artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json',
        'utf8'
    )).abi;

    try {
        const registry = new ethers.Contract(addresses.agentRegistryV2, registryAbi, provider);
        const owner1 = await registry.owner();
        if (owner1.toLowerCase() === deployer.address.toLowerCase()) {
            console.log(`   ✅ AgentRegistryV2 owner: ${owner1}`);
            passed++;
        } else {
            console.log(`   ❌ AgentRegistryV2 owner mismatch: ${owner1}`);
            failed++;
        }

        const rm = new ethers.Contract(addresses.reputationManagerV3, rmAbi, provider);
        const owner2 = await rm.owner();
        if (owner2.toLowerCase() === deployer.address.toLowerCase()) {
            console.log(`   ✅ ReputationManagerV3 owner: ${owner2}`);
            passed++;
        } else {
            console.log(`   ❌ ReputationManagerV3 owner mismatch: ${owner2}`);
            failed++;
        }
    } catch (error) {
        console.log(`   ❌ Error checking ownership: ${error.message}`);
        failed++;
    }
    console.log();

    // Test 3: Check marketplace authorization
    console.log('3️⃣  Checking marketplace authorization...');
    try {
        const rm = new ethers.Contract(addresses.reputationManagerV3, rmAbi, provider);
        const isAuthorized = await rm.authorizedPools(addresses.agentLiquidityMarketplace);
        if (isAuthorized) {
            console.log(`   ✅ Marketplace authorized in ReputationManager`);
            passed++;
        } else {
            console.log(`   ❌ Marketplace NOT authorized`);
            failed++;
        }
    } catch (error) {
        console.log(`   ❌ Error checking authorization: ${error.message}`);
        failed++;
    }
    console.log();

    // Test 4: Check contract references
    console.log('4️⃣  Checking contract references...');
    try {
        const rm = new ethers.Contract(addresses.reputationManagerV3, rmAbi, provider);
        const registryAddr = await rm.agentRegistry();
        if (registryAddr.toLowerCase() === addresses.agentRegistryV2.toLowerCase()) {
            console.log(`   ✅ ReputationManager -> AgentRegistry: ${registryAddr}`);
            passed++;
        } else {
            console.log(`   ❌ ReputationManager -> AgentRegistry mismatch`);
            failed++;
        }

        const marketplaceAbi = JSON.parse(fs.readFileSync(
            './artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json',
            'utf8'
        )).abi;

        const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, marketplaceAbi, provider);
        const usdcAddr = await marketplace.usdcToken();
        if (usdcAddr.toLowerCase() === addresses.usdc.toLowerCase()) {
            console.log(`   ✅ Marketplace -> USDC: ${usdcAddr}`);
            passed++;
        } else {
            console.log(`   ❌ Marketplace -> USDC mismatch`);
            failed++;
        }
    } catch (error) {
        console.log(`   ❌ Error checking references: ${error.message}`);
        failed++;
    }
    console.log();

    // Test 5: Check network
    console.log('5️⃣  Checking network...');
    try {
        const network = await provider.getNetwork();
        if (network.chainId === 8453n) {
            console.log(`   ✅ Connected to Base Mainnet (Chain ID: ${network.chainId})`);
            passed++;
        } else {
            console.log(`   ❌ Wrong network: ${network.chainId}`);
            failed++;
        }
    } catch (error) {
        console.log(`   ❌ Error checking network: ${error.message}`);
        failed++;
    }
    console.log();

    // Summary
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║  TEST RESULTS                                    ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    console.log(`✅ Passed: ${passed}`);
    if (failed > 0) {
        console.log(`❌ Failed: ${failed}`);
    }

    const total = passed + failed;
    const percentage = ((passed / total) * 100).toFixed(1);
    console.log(`📊 Success Rate: ${percentage}%\n`);

    if (failed === 0) {
        console.log('🎉 All tests passed! Base deployment is ready!\n');

        console.log('📋 Deployed Contracts:\n');
        console.log(`   AgentRegistryV2: ${addresses.agentRegistryV2}`);
        console.log(`   https://basescan.org/address/${addresses.agentRegistryV2}\n`);

        console.log(`   ReputationManagerV3: ${addresses.reputationManagerV3}`);
        console.log(`   https://basescan.org/address/${addresses.reputationManagerV3}\n`);

        console.log(`   AgentLiquidityMarketplace: ${addresses.agentLiquidityMarketplace}`);
        console.log(`   https://basescan.org/address/${addresses.agentLiquidityMarketplace}\n`);

        console.log(`   DepositRouter: ${addresses.depositRouter}`);
        console.log(`   https://basescan.org/address/${addresses.depositRouter}\n`);

        console.log(`   ValidationRegistry: ${addresses.validationRegistry}`);
        console.log(`   https://basescan.org/address/${addresses.validationRegistry}\n`);

        console.log('🔜 Next Steps:\n');
        console.log('   1. Update Agent API to support Base');
        console.log('   2. Update dashboard with Base network');
        console.log('   3. Register first agent on Base');
        console.log('   4. Create first liquidity pool\n');
    } else {
        console.log('⚠️  Some tests failed. Please review and fix issues.\n');
        process.exit(1);
    }
}

main().catch(err => {
    console.error('\n❌ Test failed:', err.message);
    process.exit(1);
});
