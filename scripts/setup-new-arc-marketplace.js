/**
 * Setup New Arc Marketplace
 *
 * 1. Grant marketplace role in ReputationManager
 * 2. Create agent pool
 * 3. Supply liquidity
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://arc-testnet.drpc.org';
const DEPLOYER_KEY = process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000';

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║    SETUP NEW ARC MARKETPLACE                    ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const deployer = new ethers.Wallet(DEPLOYER_KEY, provider);

    console.log(`Deployer: ${deployer.address}\n`);

    const addresses = JSON.parse(
        fs.readFileSync('./src/config/arc-testnet-addresses.json', 'utf8')
    );

    function loadAbi(name) {
        const paths = [
            `./artifacts/contracts/${name}.sol/${name}.json`,
            `./artifacts/contracts/core/${name}.sol/${name}.json`,
            `./artifacts/contracts/tokens/${name}.sol/${name}.json`,
        ];
        for (const p of paths) {
            try {
                return JSON.parse(fs.readFileSync(p, 'utf8')).abi;
            } catch {}
        }
        throw new Error(`Cannot find ABI for ${name}`);
    }

    const registryAbi = loadAbi('AgentRegistryV2');
    const reputationAbi = loadAbi('ReputationManagerV3');
    const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');
    const usdcAbi = loadAbi('MockUSDC');

    const registry = new ethers.Contract(addresses.agentRegistryV2, registryAbi, deployer);
    const reputation = new ethers.Contract(addresses.reputationManagerV3, reputationAbi, deployer);
    const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, marketplaceAbi, deployer);
    const usdc = new ethers.Contract(addresses.mockUSDC, usdcAbi, deployer);

    // Step 1: Grant marketplace role
    console.log('═'.repeat(70));
    console.log('STEP 1: GRANT MARKETPLACE ROLE');
    console.log('═'.repeat(70) + '\n');

    const MARKETPLACE_ROLE = ethers.keccak256(ethers.toUtf8Bytes('MARKETPLACE_ROLE'));
    console.log(`Marketplace Role: ${MARKETPLACE_ROLE}\n`);

    try {
        const hasRole = await reputation.hasRole(MARKETPLACE_ROLE, addresses.agentLiquidityMarketplace);

        if (hasRole) {
            console.log('✅ Marketplace already has role\n');
        } else {
            console.log('Granting role...\n');
            let nonce = await provider.getTransactionCount(deployer.address);
            const grantTx = await reputation.grantRole(MARKETPLACE_ROLE, addresses.agentLiquidityMarketplace, { nonce });
            await grantTx.wait();
            console.log('✅ Role granted\n');
        }
    } catch (error) {
        console.log(`⚠️  Role grant error: ${error.message}\n`);
    }

    // Step 2: Check if agent is registered
    console.log('═'.repeat(70));
    console.log('STEP 2: CHECK AGENT REGISTRATION');
    console.log('═'.repeat(70) + '\n');

    const isRegistered = await registry.isRegistered(deployer.address);
    console.log(`Agent registered: ${isRegistered ? '✅ Yes' : '❌ No'}`);

    if (!isRegistered) {
        console.log('⚠️  Agent not registered - cannot create pool\n');
        console.log('Run: node scripts/register-agent.js first\n');
        return;
    }

    const agentId = await registry.addressToAgentId(deployer.address);
    console.log(`Agent ID: ${agentId}\n`);

    // Step 3: Create pool
    console.log('═'.repeat(70));
    console.log('STEP 3: CREATE AGENT POOL');
    console.log('═'.repeat(70) + '\n');

    // Check if pool already exists
    try {
        const existingPool = await marketplace.getAgentPool(agentId);
        if (Number(existingPool.totalLiquidity) > 0 || existingPool.agentId == agentId) {
            console.log('✅ Pool already exists\n');
            console.log(`  Total Liquidity: ${ethers.formatUnits(existingPool.totalLiquidity, 6)} USDC`);
            console.log(`  Available: ${ethers.formatUnits(existingPool.availableLiquidity, 6)} USDC\n`);
        } else {
            throw new Error('Pool does not exist');
        }
    } catch (error) {
        console.log('Creating new pool...\n');
        let nonce = await provider.getTransactionCount(deployer.address);
        const createPoolTx = await marketplace.createAgentPool({ nonce });
        await createPoolTx.wait();
        console.log('✅ Pool created\n');
    }

    // Step 4: Supply liquidity
    console.log('═'.repeat(70));
    console.log('STEP 4: SUPPLY LIQUIDITY');
    console.log('═'.repeat(70) + '\n');

    const supplyAmount = '1000'; // 1000 USDC
    console.log(`Supplying ${supplyAmount} USDC to pool...\n`);

    // Approve USDC
    let nonce = await provider.getTransactionCount(deployer.address);
    const approveTx = await usdc.approve(
        addresses.agentLiquidityMarketplace,
        ethers.parseUnits(supplyAmount, 6),
        { nonce }
    );
    await approveTx.wait();
    console.log('✅ USDC approved\n');

    // Supply liquidity
    nonce = await provider.getTransactionCount(deployer.address);
    const supplyTx = await marketplace.supplyLiquidity(
        agentId,
        ethers.parseUnits(supplyAmount, 6),
        { nonce }
    );
    await supplyTx.wait();
    console.log('✅ Liquidity supplied\n');

    // Final pool status
    console.log('═'.repeat(70));
    console.log('FINAL POOL STATUS');
    console.log('═'.repeat(70) + '\n');

    const finalPool = await marketplace.getAgentPool(agentId);
    console.log(`Agent ID: ${agentId}`);
    console.log(`Total Liquidity: ${ethers.formatUnits(finalPool.totalLiquidity, 6)} USDC`);
    console.log(`Available: ${ethers.formatUnits(finalPool.availableLiquidity, 6)} USDC`);
    console.log(`Total Loaned: ${ethers.formatUnits(finalPool.totalLoaned, 6)} USDC\n`);

    console.log('═'.repeat(70));
    console.log('✅ SETUP COMPLETE');
    console.log('═'.repeat(70) + '\n');

    console.log('Next step: Test loan cycle\n');
    console.log('Run: ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org node scripts/comprehensive-arc-test.js\n');
}

main().catch(err => {
    console.error('\n❌ Setup failed:', err.message);
    console.error(err);
    process.exit(1);
});
