/**
 * Comprehensive Base Mainnet Contract Tests
 */

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org', 8453, { batchMaxCount: 1 });
const addresses = JSON.parse(fs.readFileSync('./src/config/base-addresses.json'));

const registryAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')).abi;
const reputationAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json')).abi;
const marketplaceAbi = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;
const usdcAbi = ['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)', 'function decimals() view returns (uint8)'];

const registry = new ethers.Contract(addresses.agentRegistryV2 || addresses.agentRegistry, registryAbi, provider);
const reputation = new ethers.Contract(addresses.reputationManagerV3 || addresses.reputationManager, reputationAbi, provider);
const marketplace = new ethers.Contract(addresses.agentLiquidityMarketplace, marketplaceAbi, provider);
const usdc = new ethers.Contract(addresses.usdc, usdcAbi, provider);

let passed = 0;
let failed = 0;

function pass(test) {
    console.log(`  ✅ ${test}`);
    passed++;
}

function fail(test, error) {
    console.log(`  ❌ ${test}`);
    console.log(`     Error: ${error}`);
    failed++;
}

async function runTests() {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  BASE MAINNET CONTRACT TESTS');
    console.log('═══════════════════════════════════════════════════════════════\n');

    // Test 1: Contract Deployment
    console.log('1️⃣  CONTRACT DEPLOYMENT CHECKS\n');

    try {
        const code = await provider.getCode(addresses.agentRegistryV2 || addresses.agentRegistry);
        if (code !== '0x') pass('AgentRegistry deployed');
        else fail('AgentRegistry deployed', 'No code at address');
    } catch (e) {
        fail('AgentRegistry deployed', e.message);
    }

    try {
        const code = await provider.getCode(addresses.reputationManagerV3 || addresses.reputationManager);
        if (code !== '0x') pass('ReputationManager deployed');
        else fail('ReputationManager deployed', 'No code at address');
    } catch (e) {
        fail('ReputationManager deployed', e.message);
    }

    try {
        const code = await provider.getCode(addresses.agentLiquidityMarketplace);
        if (code !== '0x') pass('Marketplace deployed');
        else fail('Marketplace deployed', 'No code at address');
    } catch (e) {
        fail('Marketplace deployed', e.message);
    }

    console.log('');

    // Test 2: Contract Ownership
    console.log('2️⃣  CONTRACT OWNERSHIP\n');

    try {
        const owner = await registry.owner();
        console.log(`  Registry owner: ${owner}`);
        if (owner !== '0x0000000000000000000000000000000000000000') {
            pass('Registry has owner');
        } else {
            fail('Registry has owner', 'Owner is zero address');
        }
    } catch (e) {
        fail('Registry has owner', e.message);
    }

    try {
        const owner = await reputation.owner();
        console.log(`  Reputation owner: ${owner}`);
        if (owner !== '0x0000000000000000000000000000000000000000') {
            pass('Reputation has owner');
        } else {
            fail('Reputation has owner', 'Owner is zero address');
        }
    } catch (e) {
        fail('Reputation has owner', e.message);
    }

    try {
        const owner = await marketplace.owner();
        console.log(`  Marketplace owner: ${owner}`);
        if (owner !== '0x0000000000000000000000000000000000000000') {
            pass('Marketplace has owner');
        } else {
            fail('Marketplace has owner', 'Owner is zero address');
        }
    } catch (e) {
        fail('Marketplace has owner', e.message);
    }

    console.log('');

    // Test 3: Contract State
    console.log('3️⃣  CONTRACT STATE\n');

    try {
        const totalAgents = await registry.totalAgents();
        console.log(`  Total agents: ${totalAgents}`);
        pass('Registry readable');
    } catch (e) {
        fail('Registry readable', e.message);
    }

    try {
        const totalPools = await marketplace.totalPools();
        console.log(`  Total pools: ${totalPools}`);
        pass('Marketplace readable');
    } catch (e) {
        fail('Marketplace readable', e.message);
    }

    try {
        const paused = await marketplace.paused();
        console.log(`  Marketplace paused: ${paused}`);
        if (!paused) pass('Marketplace not paused');
        else fail('Marketplace not paused', 'Contract is paused');
    } catch (e) {
        fail('Marketplace not paused', e.message);
    }

    console.log('');

    // Test 4: USDC Integration
    console.log('4️⃣  USDC TOKEN\n');

    try {
        const decimals = await usdc.decimals();
        console.log(`  USDC decimals: ${decimals}`);
        if (decimals === 6) pass('USDC has 6 decimals');
        else fail('USDC has 6 decimals', `Has ${decimals} decimals`);
    } catch (e) {
        fail('USDC has 6 decimals', e.message);
    }

    try {
        const balance = await usdc.balanceOf(addresses.agentLiquidityMarketplace);
        console.log(`  Marketplace USDC: ${ethers.formatUnits(balance, 6)}`);
        pass('Can read USDC balance');
    } catch (e) {
        fail('Can read USDC balance', e.message);
    }

    console.log('');

    // Test 5: Authorization
    console.log('5️⃣  AUTHORIZATION\n');

    try {
        const authorized = await reputation.authorizedPools(addresses.agentLiquidityMarketplace);
        console.log(`  Marketplace authorized: ${authorized}`);
        if (authorized) pass('Marketplace authorized in Reputation');
        else fail('Marketplace authorized in Reputation', 'Not authorized');
    } catch (e) {
        fail('Marketplace authorized in Reputation', e.message);
    }

    console.log('');

    // Test 6: Current Statistics
    console.log('6️⃣  CURRENT STATISTICS\n');

    try {
        const totalAgents = await registry.totalAgents();
        const totalPools = await marketplace.totalPools();
        const marketplaceBalance = await usdc.balanceOf(addresses.agentLiquidityMarketplace);

        console.log(`  Total Agents: ${totalAgents}`);
        console.log(`  Total Pools: ${totalPools}`);
        console.log(`  Available Liquidity: ${ethers.formatUnits(marketplaceBalance, 6)} USDC`);

        pass('Can query statistics');
    } catch (e) {
        fail('Can query statistics', e.message);
    }

    console.log('');

    // Summary
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  TEST SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════\n');

    console.log(`  Total Tests: ${passed + failed}`);
    console.log(`  Passed: ${passed}`);
    console.log(`  Failed: ${failed}`);
    console.log('');

    if (failed === 0) {
        console.log('  ✅ ALL TESTS PASSED\n');
        console.log('═══════════════════════════════════════════════════════════════\n');
        process.exit(0);
    } else {
        console.log(`  ❌ ${failed} TESTS FAILED\n`);
        console.log('═══════════════════════════════════════════════════════════════\n');
        process.exit(1);
    }
}

runTests().catch((e) => { console.error(e); process.exit(1); });
