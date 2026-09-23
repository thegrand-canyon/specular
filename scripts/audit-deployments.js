/**
 * Comprehensive Deployment Audit Script
 *
 * Verifies all deployed contracts on Arc Testnet and Base Mainnet:
 * 1. Contract existence at address
 * 2. Owner/access control verification
 * 3. Read function testing (totalAgents, getAgentScore, etc.)
 * 4. Contract integration verification
 * 5. Accounting and fund checks
 *
 * Usage:
 *   node scripts/audit-deployments.js
 */

const { ethers } = require('ethers');
require('dotenv').config();

// Contract ABIs (minimal for auditing)
const REGISTRY_ABI = [
    'function totalAgents() external view returns (uint256)',
    'function owner() external view returns (address)',
    'function paused() external view returns (bool)',
    'function agentPools(uint256) external view returns (uint256, address, uint256, uint256, uint256, uint256, bool)',
    'function addressToAgentId(address) external view returns (uint256)',
    'function isRegistered(address) external view returns (bool)',
    'function isAgentActive(address) external view returns (bool)',
    'function getAgentInfoById(uint256) external view returns (tuple(uint256, address, address, string, uint256, bool))'
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
    'function platformFeeRate() external view returns (uint256)',
    'function getAgentPool(uint256) external view returns (address, uint256, uint256, uint256, uint256, uint256, uint256)'
];

const REPUTATION_ABI = [
    'function owner() external view returns (address)',
    'function agentRegistry() external view returns (address)',
    'function authorizedPools(address) external view returns (bool)',
    'function getReputationScore(address) external view returns (uint256)',
    'function calculateCreditLimit(address) external view returns (uint256)',
    'function calculateCollateralRequirement(address) external view returns (uint256)',
    'function calculateInterestRate(address) external view returns (uint256)',
    'function onTimeRepaymentBonus() external view returns (uint256)',
    'function defaultPenaltyBase() external view returns (uint256)'
];

const ERC20_ABI = [
    'function name() external view returns (string)',
    'function symbol() external view returns (string)',
    'function decimals() external view returns (uint8)',
    'function totalSupply() external view returns (uint256)',
    'function balanceOf(address) external view returns (uint256)'
];

// Deployment configurations
const DEPLOYMENTS = {
    'Arc Testnet': {
        chainId: 5042002,
        rpcUrls: [
            process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org'
        ],
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
            'https://mainnet.base.org',
            process.env.BASE_RPC_URL
        ].filter(Boolean),
        contracts: {
            registry: '0xbd8210061bF24917Ca2F8098A1F3A4f76adA31fb',
            marketplace: '0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE',
            reputation: '0xe4D78A509daa8dc8bFB453cb76d61f1Cb1c4C3fF',
            usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
        }
    }
};

// Results tracker
const results = {
    'Arc Testnet': {},
    'Base Mainnet': {}
};

// Helper functions
function colorize(text, color) {
    const colors = {
        green: '\x1b[32m',
        red: '\x1b[31m',
        yellow: '\x1b[33m',
        cyan: '\x1b[36m',
        reset: '\x1b[0m'
    };
    return `${colors[color]}${text}${colors.reset}`;
}

function printSection(title) {
    console.log('\n' + '═'.repeat(80));
    console.log(`  ${title}`);
    console.log('═'.repeat(80) + '\n');
}

function formatUSDC(amount) {
    return (Number(amount) / 1e6).toFixed(2);
}

// Audit functions
async function checkContractExists(provider, address, name) {
    try {
        const code = await provider.getCode(address);
        if (code === '0x') {
            console.log(`  ${colorize('✗', 'red')} ${name}: No contract at address`);
            return false;
        }
        console.log(`  ${colorize('✓', 'green')} ${name}: Contract exists`);
        return true;
    } catch (error) {
        console.log(`  ${colorize('✗', 'red')} ${name}: Error checking existence - ${error.message}`);
        return false;
    }
}

async function auditRegistry(provider, address, network) {
    const contract = new ethers.Contract(address, REGISTRY_ABI, provider);
    const issues = [];

    try {
        // Check owner
        const owner = await contract.owner();
        console.log(`  Owner: ${owner}`);

        // Check paused status
        const paused = await contract.paused();
        console.log(`  Paused: ${paused}`);
        if (paused) {
            issues.push('Contract is paused');
        }

        // Check total agents
        const totalAgents = await contract.totalAgents();
        console.log(`  Total Agents: ${totalAgents.toString()}`);

        if (totalAgents.toString() === '0') {
            issues.push('No agents registered');
        }

        return { success: true, issues };
    } catch (error) {
        console.log(`  ${colorize('✗', 'red')} Error: ${error.message}`);
        return { success: false, issues: [error.message] };
    }
}

async function auditMarketplace(provider, address, registryAddress, reputationAddress, usdcAddress, network) {
    const contract = new ethers.Contract(address, MARKETPLACE_ABI, provider);
    const issues = [];

    try {
        // Check owner
        const owner = await contract.owner();
        console.log(`  Owner: ${owner}`);

        // Check paused status
        const paused = await contract.paused();
        console.log(`  Paused: ${paused}`);
        if (paused) {
            issues.push('Contract is paused');
        }

        // Verify integrations
        const linkedRegistry = await contract.agentRegistry();
        const linkedReputation = await contract.reputationManager();
        const linkedUsdc = await contract.usdcToken();

        console.log(`  Linked Registry: ${linkedRegistry}`);
        console.log(`  Expected Registry: ${registryAddress}`);
        if (linkedRegistry.toLowerCase() !== registryAddress.toLowerCase()) {
            issues.push('Registry address mismatch');
        }

        console.log(`  Linked Reputation: ${linkedReputation}`);
        console.log(`  Expected Reputation: ${reputationAddress}`);
        if (linkedReputation.toLowerCase() !== reputationAddress.toLowerCase()) {
            issues.push('Reputation address mismatch');
        }

        console.log(`  Linked USDC: ${linkedUsdc}`);
        console.log(`  Expected USDC: ${usdcAddress}`);
        if (linkedUsdc.toLowerCase() !== usdcAddress.toLowerCase()) {
            issues.push('USDC address mismatch');
        }

        // Check pool metrics
        const totalPools = await contract.totalPools();
        const nextLoanId = await contract.nextLoanId();
        const accumulatedFees = await contract.accumulatedFees();
        const platformFeeRate = await contract.platformFeeRate();

        console.log(`  Total Pools: ${totalPools.toString()}`);
        console.log(`  Next Loan ID: ${nextLoanId.toString()}`);
        console.log(`  Accumulated Fees: ${formatUSDC(accumulatedFees)} USDC`);
        console.log(`  Platform Fee Rate: ${Number(platformFeeRate) / 100}%`);

        if (totalPools.toString() === '0') {
            issues.push('No pools created');
        }

        // Check USDC balance
        const usdcContract = new ethers.Contract(linkedUsdc, ERC20_ABI, provider);
        const balance = await usdcContract.balanceOf(address);
        console.log(`  USDC Balance: ${formatUSDC(balance)} USDC`);

        return { success: true, issues, metrics: {
            totalPools: totalPools.toString(),
            nextLoanId: nextLoanId.toString(),
            accumulatedFees: formatUSDC(accumulatedFees),
            balance: formatUSDC(balance)
        }};
    } catch (error) {
        console.log(`  ${colorize('✗', 'red')} Error: ${error.message}`);
        return { success: false, issues: [error.message] };
    }
}

async function auditReputation(provider, address, registryAddress, marketplaceAddress, network) {
    const contract = new ethers.Contract(address, REPUTATION_ABI, provider);
    const issues = [];

    try {
        // Check owner
        const owner = await contract.owner();
        console.log(`  Owner: ${owner}`);

        // Verify registry integration
        const linkedRegistry = await contract.agentRegistry();
        console.log(`  Linked Registry: ${linkedRegistry}`);
        console.log(`  Expected Registry: ${registryAddress}`);
        if (linkedRegistry.toLowerCase() !== registryAddress.toLowerCase()) {
            issues.push('Registry address mismatch');
        }

        // Check if marketplace is authorized
        const isAuthorized = await contract.authorizedPools(marketplaceAddress);
        console.log(`  Marketplace Authorized: ${isAuthorized}`);
        if (!isAuthorized) {
            issues.push('Marketplace not authorized as pool');
        }

        // Check scoring parameters
        try {
            const onTimeBonus = await contract.onTimeRepaymentBonus();
            const defaultPenalty = await contract.defaultPenaltyBase();

            console.log(`  On-Time Repayment Bonus: ${onTimeBonus.toString()} points`);
            console.log(`  Default Penalty: ${defaultPenalty.toString()} points`);
        } catch (paramError) {
            console.log(`  ${colorize('⚠', 'yellow')} Could not read scoring parameters`);
        }

        return { success: true, issues };
    } catch (error) {
        console.log(`  ${colorize('✗', 'red')} Error: ${error.message}`);
        return { success: false, issues: [error.message] };
    }
}

async function auditUSDC(provider, address, network) {
    const contract = new ethers.Contract(address, ERC20_ABI, provider);
    const issues = [];

    try {
        const name = await contract.name();
        const symbol = await contract.symbol();
        const decimals = await contract.decimals();

        console.log(`  Name: ${name}`);
        console.log(`  Symbol: ${symbol}`);
        console.log(`  Decimals: ${decimals}`);

        // Verify it's actually USDC (or MockUSDC)
        if (network === 'Arc Testnet') {
            if (!name.includes('Mock') && !name.includes('USDC')) {
                issues.push('Unexpected token name for testnet');
            }
        } else if (network === 'Base Mainnet') {
            if (symbol !== 'USDC') {
                issues.push('Not the official USDC token');
            }
        }

        return { success: true, issues };
    } catch (error) {
        console.log(`  ${colorize('✗', 'red')} Error: ${error.message}`);
        return { success: false, issues: [error.message] };
    }
}

async function auditNetwork(networkName) {
    printSection(`AUDITING ${networkName.toUpperCase()}`);

    const config = DEPLOYMENTS[networkName];
    let provider = null;
    let connectedRpc = null;

    // Try each RPC URL until one works
    for (const rpcUrl of config.rpcUrls) {
        try {
            console.log(`Trying RPC: ${rpcUrl.substring(0, 40)}...`);
            provider = new ethers.JsonRpcProvider(rpcUrl);
            const network = await provider.getNetwork();
            console.log(`Connected to Chain ID: ${network.chainId}`);

            if (Number(network.chainId) !== config.chainId) {
                console.log(`${colorize('⚠', 'yellow')} Warning: Chain ID mismatch`);
            }
            connectedRpc = rpcUrl;
            break;
        } catch (error) {
            console.log(`${colorize('✗', 'red')} Failed: ${error.message}`);
            provider = null;
        }
    }

    if (!provider) {
        console.log(`${colorize('✗', 'red')} Failed to connect to any RPC endpoint`);
        return;
    }

    console.log(`${colorize('✓', 'green')} Connected via: ${connectedRpc}\n`);

    const networkResults = {};

    // 1. Check contract existence
    console.log('\n' + colorize('1. Contract Existence Check', 'cyan'));
    networkResults.registry = { exists: await checkContractExists(provider, config.contracts.registry, 'Registry') };
    networkResults.marketplace = { exists: await checkContractExists(provider, config.contracts.marketplace, 'Marketplace') };
    networkResults.reputation = { exists: await checkContractExists(provider, config.contracts.reputation, 'Reputation') };
    networkResults.usdc = { exists: await checkContractExists(provider, config.contracts.usdc, 'USDC') };

    // 2. Audit Registry
    if (networkResults.registry.exists) {
        console.log('\n' + colorize('2. Registry Audit', 'cyan'));
        const audit = await auditRegistry(provider, config.contracts.registry, networkName);
        networkResults.registry = { ...networkResults.registry, ...audit };
    }

    // 3. Audit Marketplace
    if (networkResults.marketplace.exists) {
        console.log('\n' + colorize('3. Marketplace Audit', 'cyan'));
        const audit = await auditMarketplace(
            provider,
            config.contracts.marketplace,
            config.contracts.registry,
            config.contracts.reputation,
            config.contracts.usdc,
            networkName
        );
        networkResults.marketplace = { ...networkResults.marketplace, ...audit };
    }

    // 4. Audit Reputation
    if (networkResults.reputation.exists) {
        console.log('\n' + colorize('4. Reputation Manager Audit', 'cyan'));
        const audit = await auditReputation(
            provider,
            config.contracts.reputation,
            config.contracts.registry,
            config.contracts.marketplace,
            networkName
        );
        networkResults.reputation = { ...networkResults.reputation, ...audit };
    }

    // 5. Audit USDC
    if (networkResults.usdc.exists) {
        console.log('\n' + colorize('5. USDC Token Audit', 'cyan'));
        const audit = await auditUSDC(provider, config.contracts.usdc, networkName);
        networkResults.usdc = { ...networkResults.usdc, ...audit };
    }

    results[networkName] = networkResults;
}

function generateReport() {
    printSection('AUDIT SUMMARY');

    const report = {
        timestamp: new Date().toISOString(),
        networks: {}
    };

    for (const [networkName, networkResults] of Object.entries(results)) {
        console.log(`\n${colorize(networkName, 'cyan')}`);
        console.log('─'.repeat(80));

        const networkIssues = [];

        for (const [contractName, contractData] of Object.entries(networkResults)) {
            const status = contractData.exists && contractData.success !== false
                ? colorize('✓', 'green')
                : colorize('✗', 'red');

            console.log(`  ${status} ${contractName.charAt(0).toUpperCase() + contractName.slice(1)}`);

            if (contractData.issues && contractData.issues.length > 0) {
                contractData.issues.forEach(issue => {
                    console.log(`      ${colorize('⚠', 'yellow')} ${issue}`);
                    networkIssues.push(`${contractName}: ${issue}`);
                });
            }
        }

        // Network summary
        const totalContracts = Object.keys(networkResults).length;
        const workingContracts = Object.values(networkResults).filter(
            c => c.exists && c.success !== false
        ).length;

        console.log(`\n  Total Contracts: ${totalContracts}`);
        console.log(`  Working: ${workingContracts}`);
        console.log(`  Issues: ${networkIssues.length}`);

        report.networks[networkName] = {
            totalContracts,
            workingContracts,
            issues: networkIssues,
            contracts: DEPLOYMENTS[networkName].contracts
        };
    }

    return report;
}

async function main() {
    console.log(colorize('\n╔═════════════════════════════════════════════════════════════════╗', 'cyan'));
    console.log(colorize('║         SPECULAR DEPLOYMENT AUDIT                               ║', 'cyan'));
    console.log(colorize('╚═════════════════════════════════════════════════════════════════╝', 'cyan'));
    console.log(`\nAudit started at: ${new Date().toISOString()}\n`);

    // Audit both networks
    await auditNetwork('Arc Testnet');
    await auditNetwork('Base Mainnet');

    // Generate and display report
    const report = generateReport();

    // Print final verdict
    printSection('FINAL VERDICT');

    let allClear = true;
    for (const [networkName, networkData] of Object.entries(report.networks)) {
        const status = networkData.workingContracts === networkData.totalContracts && networkData.issues.length === 0
            ? colorize('✓ OPERATIONAL', 'green')
            : colorize('⚠ ISSUES DETECTED', 'yellow');

        console.log(`${networkName}: ${status}`);

        if (networkData.issues.length > 0) {
            allClear = false;
        }
    }

    console.log('\n' + '═'.repeat(80) + '\n');

    // Save report to file
    const fs = require('fs');
    const reportPath = '/Users/peterschroeder/Specular/DEPLOYMENT_AUDIT.json';
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`Full audit report saved to: ${reportPath}\n`);

    return allClear;
}

// Run audit
main()
    .then(success => {
        process.exit(success ? 0 : 1);
    })
    .catch(error => {
        console.error(`\n${colorize('✗', 'red')} Fatal error:`, error);
        process.exit(1);
    });
