/**
 * Final Comprehensive Audit with CORRECTED Base Mainnet Addresses
 *
 * This audit uses the CORRECT addresses after investigation revealed
 * the user provided an incorrect Reputation Manager address.
 *
 * Usage:
 *   node scripts/final-audit.js
 */

const { ethers } = require('ethers');
require('dotenv').config();

// Contract ABIs (minimal for auditing)
const REGISTRY_ABI = [
    'function totalAgents() external view returns (uint256)',
    'function owner() external view returns (address)',
    'function paused() external view returns (bool)',
    'function isRegistered(address) external view returns (bool)',
    'function isAgentActive(address) external view returns (bool)'
];

const MARKETPLACE_ABI = [
    'function owner() external view returns (address)',
    'function paused() external view returns (bool)',
    'function agentRegistry() external view returns (address)',
    'function reputationManager() external view returns (address)',
    'function usdcToken() external view returns (address)',
    'function totalPools() external view returns (uint256)',
    'function nextLoanId() external view returns (uint256)',
    'function accumulatedFees() external view returns (uint256)',
    'function platformFeeRate() external view returns (uint256)'
];

const REPUTATION_ABI = [
    'function owner() external view returns (address)',
    'function agentRegistry() external view returns (address)',
    'function authorizedPools(address) external view returns (bool)',
    'function onTimeRepaymentBonus() external view returns (uint256)',
    'function defaultPenaltyBase() external view returns (uint256)'
];

const ERC20_ABI = [
    'function name() external view returns (string)',
    'function symbol() external view returns (string)',
    'function decimals() external view returns (uint8)',
    'function balanceOf(address) external view returns (uint256)'
];

// CORRECTED deployment configurations
const DEPLOYMENTS = {
    'Arc Testnet': {
        chainId: 5042002,
        rpcUrl: process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
        contracts: {
            registry: '0x741C03c0d95d2c15E479CE1c7E69B3196d86faD7',
            marketplace: '0x048363A325A5B188b7FF157d725C5e329f0171D3',
            reputation: '0x94F2fa47c4488202a46dAA9038Ed9C9c4c07467F',
            usdc: '0xf2807051e292e945751A25616705a9aadfb39895'
        }
    },
    'Base Mainnet': {
        chainId: 8453,
        rpcUrls: [
            'https://base.gateway.tenderly.co',
            'https://base.llamarpc.com',
            'https://mainnet.base.org'
        ],
        contracts: {
            registry: '0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb',
            marketplace: '0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE',
            reputation: '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF', // CORRECTED
            usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
        }
    }
};

function colorize(text, color) {
    const colors = {
        green: '\x1b[32m',
        red: '\x1b[31m',
        yellow: '\x1b[33m',
        cyan: '\x1b[36m',
        bold: '\x1b[1m',
        reset: '\x1b[0m'
    };
    return `${colors[color]}${text}${colors.reset}`;
}

function printHeader(title) {
    console.log('\n' + colorize('═'.repeat(80), 'cyan'));
    console.log(colorize(`  ${title}`, 'bold'));
    console.log(colorize('═'.repeat(80), 'cyan') + '\n');
}

function formatUSDC(amount) {
    return (Number(amount) / 1e6).toFixed(2);
}

async function auditNetwork(networkName, config) {
    printHeader(`${networkName.toUpperCase()} - FINAL AUDIT`);

    const rpcUrls = config.rpcUrls || [config.rpcUrl];
    let provider = null;

    // Try RPCs
    for (const rpcUrl of rpcUrls) {
        try {
            provider = new ethers.JsonRpcProvider(rpcUrl);
            await provider.getNetwork();
            console.log(`${colorize('✓', 'green')} Connected via: ${rpcUrl.substring(0, 40)}...`);
            break;
        } catch (error) {
            provider = null;
        }
    }

    if (!provider) {
        console.log(`${colorize('✗', 'red')} Failed to connect to any RPC\n`);
        return false;
    }

    let allPass = true;

    // 1. Check Registry
    console.log('\n' + colorize('1. Registry Verification', 'cyan'));
    try {
        const registry = new ethers.Contract(config.contracts.registry, REGISTRY_ABI, provider);
        const totalAgents = await registry.totalAgents();
        const owner = await registry.owner();
        const paused = await registry.paused();

        console.log(`  Address: ${config.contracts.registry}`);
        console.log(`  Owner: ${owner}`);
        console.log(`  Total Agents: ${totalAgents.toString()}`);
        console.log(`  Paused: ${paused ? colorize('YES', 'red') : colorize('NO', 'green')}`);
        console.log(`  ${colorize('✓', 'green')} Registry working correctly`);
    } catch (error) {
        console.log(`  ${colorize('✗', 'red')} Registry error: ${error.message}`);
        allPass = false;
    }

    // 2. Check Marketplace
    console.log('\n' + colorize('2. Marketplace Verification', 'cyan'));
    try {
        const marketplace = new ethers.Contract(config.contracts.marketplace, MARKETPLACE_ABI, provider);
        const owner = await marketplace.owner();
        const paused = await marketplace.paused();
        const linkedRegistry = await marketplace.agentRegistry();
        const linkedReputation = await marketplace.reputationManager();
        const linkedUsdc = await marketplace.usdcToken();
        const totalPools = await marketplace.totalPools();
        const nextLoanId = await marketplace.nextLoanId();
        const fees = await marketplace.accumulatedFees();
        const feeRate = await marketplace.platformFeeRate();

        console.log(`  Address: ${config.contracts.marketplace}`);
        console.log(`  Owner: ${owner}`);
        console.log(`  Paused: ${paused ? colorize('YES', 'red') : colorize('NO', 'green')}`);
        console.log(`  Total Pools: ${totalPools.toString()}`);
        console.log(`  Loans Processed: ${Number(nextLoanId) - 1}`);
        console.log(`  Accumulated Fees: ${formatUSDC(fees)} USDC`);
        console.log(`  Platform Fee Rate: ${Number(feeRate) / 100}%`);

        // Check USDC balance
        const usdcContract = new ethers.Contract(linkedUsdc, ERC20_ABI, provider);
        const balance = await usdcContract.balanceOf(config.contracts.marketplace);
        console.log(`  USDC Balance: ${formatUSDC(balance)} USDC`);

        // Verify integrations
        console.log('\n  Integration Checks:');
        const registryMatch = linkedRegistry.toLowerCase() === config.contracts.registry.toLowerCase();
        const reputationMatch = linkedReputation.toLowerCase() === config.contracts.reputation.toLowerCase();
        const usdcMatch = linkedUsdc.toLowerCase() === config.contracts.usdc.toLowerCase();

        console.log(`    Registry: ${registryMatch ? colorize('✓ CORRECT', 'green') : colorize('✗ MISMATCH', 'red')}`);
        if (!registryMatch) {
            console.log(`      Expected: ${config.contracts.registry}`);
            console.log(`      Actual:   ${linkedRegistry}`);
            allPass = false;
        }

        console.log(`    Reputation: ${reputationMatch ? colorize('✓ CORRECT', 'green') : colorize('✗ MISMATCH', 'red')}`);
        if (!reputationMatch) {
            console.log(`      Expected: ${config.contracts.reputation}`);
            console.log(`      Actual:   ${linkedReputation}`);
            allPass = false;
        }

        console.log(`    USDC: ${usdcMatch ? colorize('✓ CORRECT', 'green') : colorize('✗ MISMATCH', 'red')}`);
        if (!usdcMatch) {
            console.log(`      Expected: ${config.contracts.usdc}`);
            console.log(`      Actual:   ${linkedUsdc}`);
            allPass = false;
        }

        if (registryMatch && reputationMatch && usdcMatch) {
            console.log(`\n  ${colorize('✓', 'green')} Marketplace working correctly`);
        }
    } catch (error) {
        console.log(`  ${colorize('✗', 'red')} Marketplace error: ${error.message}`);
        allPass = false;
    }

    // 3. Check Reputation Manager
    console.log('\n' + colorize('3. Reputation Manager Verification', 'cyan'));
    try {
        const reputation = new ethers.Contract(config.contracts.reputation, REPUTATION_ABI, provider);
        const owner = await reputation.owner();
        const linkedRegistry = await reputation.agentRegistry();
        const isMarketplaceAuthorized = await reputation.authorizedPools(config.contracts.marketplace);

        console.log(`  Address: ${config.contracts.reputation}`);
        console.log(`  Owner: ${owner}`);

        try {
            const onTimeBonus = await reputation.onTimeRepaymentBonus();
            const defaultPenalty = await reputation.defaultPenaltyBase();
            console.log(`  On-Time Bonus: ${onTimeBonus.toString()} points`);
            console.log(`  Default Penalty: ${defaultPenalty.toString()} points`);
        } catch (e) {
            console.log(`  ${colorize('⚠', 'yellow')} Could not read scoring parameters`);
        }

        console.log('\n  Integration Checks:');
        const registryMatch = linkedRegistry.toLowerCase() === config.contracts.registry.toLowerCase();

        console.log(`    Registry: ${registryMatch ? colorize('✓ CORRECT', 'green') : colorize('✗ MISMATCH', 'red')}`);
        if (!registryMatch) {
            console.log(`      Expected: ${config.contracts.registry}`);
            console.log(`      Actual:   ${linkedRegistry}`);
            allPass = false;
        }

        console.log(`    Marketplace Auth: ${isMarketplaceAuthorized ? colorize('✓ AUTHORIZED', 'green') : colorize('✗ NOT AUTHORIZED', 'red')}`);
        if (!isMarketplaceAuthorized) {
            allPass = false;
        }

        if (registryMatch && isMarketplaceAuthorized) {
            console.log(`\n  ${colorize('✓', 'green')} Reputation Manager working correctly`);
        }
    } catch (error) {
        console.log(`  ${colorize('✗', 'red')} Reputation Manager error: ${error.message}`);
        allPass = false;
    }

    // 4. Check USDC Token
    console.log('\n' + colorize('4. USDC Token Verification', 'cyan'));
    try {
        const usdc = new ethers.Contract(config.contracts.usdc, ERC20_ABI, provider);
        const name = await usdc.name();
        const symbol = await usdc.symbol();
        const decimals = await usdc.decimals();

        console.log(`  Address: ${config.contracts.usdc}`);
        console.log(`  Name: ${name}`);
        console.log(`  Symbol: ${symbol}`);
        console.log(`  Decimals: ${decimals}`);
        console.log(`  ${colorize('✓', 'green')} USDC token valid`);
    } catch (error) {
        console.log(`  ${colorize('✗', 'red')} USDC error: ${error.message}`);
        allPass = false;
    }

    return allPass;
}

async function main() {
    console.log(colorize('\n╔════════════════════════════════════════════════════════════════╗', 'cyan'));
    console.log(colorize('║       SPECULAR FINAL COMPREHENSIVE AUDIT                       ║', 'cyan'));
    console.log(colorize('║       (With Corrected Base Mainnet Addresses)                  ║', 'cyan'));
    console.log(colorize('╚════════════════════════════════════════════════════════════════╝', 'cyan'));
    console.log(`\nAudit started: ${new Date().toISOString()}\n`);

    const results = {};

    // Audit Arc Testnet
    results.arcTestnet = await auditNetwork('Arc Testnet', DEPLOYMENTS['Arc Testnet']);

    // Audit Base Mainnet
    results.baseMainnet = await auditNetwork('Base Mainnet', DEPLOYMENTS['Base Mainnet']);

    // Final Summary
    printHeader('FINAL AUDIT SUMMARY');

    const arcStatus = results.arcTestnet
        ? colorize('✓ OPERATIONAL', 'green')
        : colorize('✗ ISSUES DETECTED', 'red');

    const baseStatus = results.baseMainnet
        ? colorize('✓ OPERATIONAL', 'green')
        : colorize('✗ ISSUES DETECTED', 'red');

    console.log(`Arc Testnet:  ${arcStatus}`);
    console.log(`Base Mainnet: ${baseStatus}`);

    console.log('\n' + '═'.repeat(80) + '\n');

    const allPass = results.arcTestnet && results.baseMainnet;

    if (allPass) {
        console.log(colorize('✓ ALL SYSTEMS OPERATIONAL', 'green'));
        console.log(colorize('  All contracts verified and working correctly', 'green'));
    } else {
        console.log(colorize('✗ ISSUES DETECTED', 'red'));
        console.log(colorize('  Review audit output for details', 'red'));
    }

    console.log('\n' + '═'.repeat(80) + '\n');

    return allPass;
}

main()
    .then(success => {
        process.exit(success ? 0 : 1);
    })
    .catch(error => {
        console.error(`\n${colorize('✗', 'red')} Fatal error:`, error);
        process.exit(1);
    });
