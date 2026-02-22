/**
 * Diagnose Base Sepolia Contract Configuration
 *
 * Checks what configuration is missing that's blocking agent registration
 */

const { ethers } = require('ethers');
const fs = require('fs');

const RPC_URL = 'https://sepolia.base.org';
const AGENT_KEY = process.env.PRIVATE_KEY || '0x0000000000000000000000000000000000000000000000000000000000000000';

async function main() {
    console.log('\n🔍 DIAGNOSING BASE SEPOLIA CONFIGURATION\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const agent = new ethers.Wallet(AGENT_KEY, provider);

    console.log(`Agent: ${agent.address}\n`);

    // Load addresses
    const addresses = JSON.parse(
        fs.readFileSync('./src/config/base-sepolia-addresses.json', 'utf8')
    );

    // Load ABIs
    function loadAbi(name) {
        const paths = [
            `./artifacts/contracts/${name}.sol/${name}.json`,
            `./artifacts/contracts/core/${name}.sol/${name}.json`,
        ];
        for (const p of paths) {
            try {
                return JSON.parse(fs.readFileSync(p, 'utf8')).abi;
            } catch {}
        }
        throw new Error(`Cannot find ABI for ${name}`);
    }

    const registryAbi = loadAbi('AgentRegistryV2');
    const rmAbi = loadAbi('ReputationManagerV3');
    const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');

    const registry = new ethers.Contract(addresses.AgentRegistryV2, registryAbi, provider);
    const rm = new ethers.Contract(addresses.ReputationManagerV3, rmAbi, provider);
    const marketplace = new ethers.Contract(addresses.AgentLiquidityMarketplace, marketplaceAbi, provider);

    console.log('═'.repeat(70));
    console.log('1. AGENT REGISTRY CHECKS');
    console.log('═'.repeat(70) + '\n');

    try {
        const owner = await registry.owner();
        console.log(`✅ Registry owner: ${owner}`);
        console.log(`   Is agent owner? ${owner.toLowerCase() === agent.address.toLowerCase()}\n`);
    } catch (err) {
        console.log(`❌ Failed to get owner: ${err.message}\n`);
    }

    try {
        const isRegistered = await registry.isRegistered(agent.address);
        console.log(`   Agent registered? ${isRegistered}\n`);
    } catch (err) {
        console.log(`❌ Failed to check registration: ${err.message}\n`);
    }

    // Check if there's a validationRegistry requirement
    try {
        const vr = await registry.validationRegistry();
        console.log(`   ValidationRegistry: ${vr}`);
        console.log(`   Is zero address? ${vr === ethers.ZeroAddress}\n`);
    } catch (err) {
        console.log(`   No validationRegistry field (expected)\n`);
    }

    console.log('═'.repeat(70));
    console.log('2. REPUTATION MANAGER CHECKS');
    console.log('═'.repeat(70) + '\n');

    try {
        const owner = await rm.owner();
        console.log(`✅ RM owner: ${owner}`);
        console.log(`   Is agent owner? ${owner.toLowerCase() === agent.address.toLowerCase()}\n`);
    } catch (err) {
        console.log(`❌ Failed to get owner: ${err.message}\n`);
    }

    try {
        const isTrusted = await rm.trustedCallers(addresses.AgentLiquidityMarketplace);
        console.log(`   Marketplace is trusted caller? ${isTrusted}\n`);
    } catch (err) {
        console.log(`❌ Failed to check trusted caller: ${err.message}\n`);
    }

    // Check if RM has a validationRegistry
    try {
        const vr = await rm.validationRegistry();
        console.log(`   RM ValidationRegistry: ${vr}`);
        console.log(`   Is zero address? ${vr === ethers.ZeroAddress}\n`);

        if (vr !== ethers.ZeroAddress) {
            console.log(`   ⚠️  NON-ZERO ValidationRegistry - this might be blocking registration!\n`);
        }
    } catch (err) {
        console.log(`   No validationRegistry field on RM\n`);
    }

    console.log('═'.repeat(70));
    console.log('3. MARKETPLACE CHECKS');
    console.log('═'.repeat(70) + '\n');

    try {
        const regAddr = await marketplace.agentRegistry();
        console.log(`✅ Marketplace.agentRegistry: ${regAddr}`);
        console.log(`   Matches deployed? ${regAddr.toLowerCase() === addresses.AgentRegistryV2.toLowerCase()}\n`);
    } catch (err) {
        console.log(`❌ Failed to get agentRegistry: ${err.message}\n`);
    }

    try {
        const rmAddr = await marketplace.reputationManager();
        console.log(`✅ Marketplace.reputationManager: ${rmAddr}`);
        console.log(`   Matches deployed? ${rmAddr.toLowerCase() === addresses.ReputationManagerV3.toLowerCase()}\n`);
    } catch (err) {
        console.log(`❌ Failed to get reputationManager: ${err.message}\n`);
    }

    try {
        const usdcAddr = await marketplace.usdc();
        console.log(`✅ Marketplace.usdc: ${usdcAddr}`);
        console.log(`   Matches deployed? ${usdcAddr.toLowerCase() === addresses.MockUSDC.toLowerCase()}\n`);
    } catch (err) {
        console.log(`❌ Failed to get usdc: ${err.message}\n`);
    }

    console.log('═'.repeat(70));
    console.log('4. TRY REGISTRATION (SIMULATE)');
    console.log('═'.repeat(70) + '\n');

    try {
        console.log('Estimating gas for registration...\n');
        const gasEstimate = await registry.connect(agent).register.estimateGas('{"name":"Diagnostic Test"}');
        console.log(`✅ Gas estimate succeeded: ${gasEstimate.toString()}`);
        console.log(`   Registration should work!\n`);
    } catch (err) {
        console.log(`❌ Gas estimation failed: ${err.shortMessage || err.message}\n`);

        // Try to get more detail
        if (err.data) {
            console.log(`   Error data: ${err.data}\n`);
        }

        // Check if it's a require(false) or specific revert
        const errorMsg = err.message || '';
        if (errorMsg.includes('require')) {
            console.log(`   ⚠️  Appears to be a require() failure in the contract\n`);
        }
        if (errorMsg.includes('ValidationRegistry')) {
            console.log(`   ⚠️  ValidationRegistry is likely the blocker!\n`);
        }
    }

    console.log('═'.repeat(70));
    console.log('DIAGNOSTIC COMPLETE');
    console.log('═'.repeat(70) + '\n');
}

main().catch(err => {
    console.error('\n❌ Diagnostic failed:', err.message);
    process.exit(1);
});
