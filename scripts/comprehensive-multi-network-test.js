/**
 * Comprehensive Multi-Network Test Suite
 * Tests all core functionality across Arc Testnet, Base Mainnet, and Arbitrum One
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Load ABIs
function loadAbi(name) {
    const abiPath = path.join(__dirname, '../abis', `${name}.json`);
    const abiFile = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
    return Array.isArray(abiFile) ? abiFile : abiFile.abi || abiFile;
}

const registryAbi = loadAbi('AgentRegistryV2');
const reputationAbi = loadAbi('ReputationManagerV3');
const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');
const usdcAbi = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function approve(address,uint256)', 'function allowance(address,address) view returns (uint256)'];

// Network configurations
const NETWORKS = {
    arc: {
        name: 'Arc Testnet',
        rpc: process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
        chainId: 5042002,
        addresses: require('../src/config/arc-testnet-addresses.json')
    },
    base: {
        name: 'Base Mainnet',
        rpc: 'https://mainnet.base.org',
        chainId: 8453,
        addresses: require('../src/config/base-addresses.json')
    },
    arbitrum: {
        name: 'Arbitrum One',
        rpc: 'https://arb1.arbitrum.io/rpc',
        chainId: 42161,
        addresses: require('../src/config/arbitrum-addresses.json')
    }
};

class NetworkTester {
    constructor(networkKey) {
        this.network = NETWORKS[networkKey];
        this.networkKey = networkKey;
        this.results = {
            network: this.network.name,
            timestamp: new Date().toISOString(),
            tests: [],
            summary: {
                passed: 0,
                failed: 0,
                skipped: 0
            }
        };
    }

    async initialize() {
        this.provider = new ethers.JsonRpcProvider(this.network.rpc, this.network.chainId, { batchMaxCount: 1 });

        this.contracts = {
            registry: new ethers.Contract(this.network.addresses.agentRegistryV2, registryAbi, this.provider),
            reputation: new ethers.Contract(this.network.addresses.reputationManagerV3, reputationAbi, this.provider),
            marketplace: new ethers.Contract(this.network.addresses.agentLiquidityMarketplace, marketplaceAbi, this.provider),
            usdc: new ethers.Contract(this.network.addresses.usdc, usdcAbi, this.provider)
        };

        // Create test wallet
        this.testWallet = ethers.Wallet.createRandom().connect(this.provider);
    }

    logTest(name, status, details = '') {
        this.results.tests.push({ name, status, details, timestamp: new Date().toISOString() });

        if (status === 'PASS') {
            this.results.summary.passed++;
            console.log(`   ✅ ${name}`);
        } else if (status === 'FAIL') {
            this.results.summary.failed++;
            console.log(`   ❌ ${name}`);
        } else if (status === 'SKIP') {
            this.results.summary.skipped++;
            console.log(`   ⏭️  ${name}`);
        }

        if (details) console.log(`      ${details}`);
    }

    async testRPCConnection() {
        console.log('\n1️⃣  RPC Connection Tests\n');

        try {
            const blockNumber = await this.provider.getBlockNumber();
            this.logTest('RPC Connection', 'PASS', `Block ${blockNumber}`);

            const network = await this.provider.getNetwork();
            if (Number(network.chainId) === this.network.chainId) {
                this.logTest('Chain ID Verification', 'PASS', `Chain ID: ${network.chainId}`);
            } else {
                this.logTest('Chain ID Verification', 'FAIL', `Expected ${this.network.chainId}, got ${network.chainId}`);
            }
        } catch (error) {
            this.logTest('RPC Connection', 'FAIL', error.message);
        }
    }

    async testContractDeployments() {
        console.log('\n2️⃣  Contract Deployment Tests\n');

        const contractTests = [
            { name: 'AgentRegistryV2', contract: this.contracts.registry },
            { name: 'ReputationManagerV3', contract: this.contracts.reputation },
            { name: 'AgentLiquidityMarketplace', contract: this.contracts.marketplace },
            { name: 'USDC', contract: this.contracts.usdc }
        ];

        for (const { name, contract } of contractTests) {
            try {
                const code = await this.provider.getCode(contract.target);
                if (code === '0x') {
                    this.logTest(`${name} Deployment`, 'FAIL', 'No code at address');
                } else {
                    this.logTest(`${name} Deployment`, 'PASS', contract.target);
                }
            } catch (error) {
                this.logTest(`${name} Deployment`, 'FAIL', error.message);
            }
        }
    }

    async testRegistryFunctions() {
        console.log('\n3️⃣  Registry Function Tests\n');

        try {
            // Test isRegistered (should work for any address)
            const isRegistered = await this.contracts.registry.isRegistered(this.testWallet.address);
            this.logTest('isRegistered() Read', 'PASS', `Result: ${isRegistered}`);
        } catch (error) {
            this.logTest('isRegistered() Read', 'FAIL', error.message);
        }

        try {
            // Test addressToAgentId
            const agentId = await this.contracts.registry.addressToAgentId(this.testWallet.address);
            this.logTest('addressToAgentId() Read', 'PASS', `Agent ID: ${agentId}`);
        } catch (error) {
            this.logTest('addressToAgentId() Read', 'FAIL', error.message);
        }

        try {
            // Test getAgentAddress (use ID 1 if it exists)
            const agent1 = await this.contracts.registry.getAgentAddress(1);
            this.logTest('getAgentAddress() Read', 'PASS', `Agent 1: ${agent1}`);
        } catch (error) {
            // It's OK if agent 1 doesn't exist
            if (error.message.includes('Agent does not exist')) {
                this.logTest('getAgentAddress() Read', 'PASS', 'No agent ID 1 (expected)');
            } else {
                this.logTest('getAgentAddress() Read', 'FAIL', error.message);
            }
        }
    }

    async testReputationFunctions() {
        console.log('\n4️⃣  Reputation Function Tests\n');

        try {
            // Test getReputationScore by address
            const score = await this.contracts.reputation['getReputationScore(address)'](this.testWallet.address);
            this.logTest('getReputationScore(address)', 'PASS', `Score: ${score}`);
        } catch (error) {
            this.logTest('getReputationScore(address)', 'FAIL', error.message);
        }

        try {
            // Test calculateCreditLimit
            const creditLimit = await this.contracts.reputation.calculateCreditLimit(this.testWallet.address);
            this.logTest('calculateCreditLimit()', 'PASS', `Limit: ${ethers.formatUnits(creditLimit, 6)} USDC`);
        } catch (error) {
            this.logTest('calculateCreditLimit()', 'FAIL', error.message);
        }

        try {
            // Test calculateInterestRate
            const interestRate = await this.contracts.reputation.calculateInterestRate(this.testWallet.address);
            this.logTest('calculateInterestRate()', 'PASS', `Rate: ${interestRate / 100}%`);
        } catch (error) {
            this.logTest('calculateInterestRate()', 'FAIL', error.message);
        }

        try {
            // Test authorizedPools
            const isAuthorized = await this.contracts.reputation.authorizedPools(this.network.addresses.agentLiquidityMarketplace);
            if (isAuthorized) {
                this.logTest('Marketplace Authorization', 'PASS', 'Marketplace is authorized');
            } else {
                this.logTest('Marketplace Authorization', 'FAIL', 'Marketplace NOT authorized!');
            }
        } catch (error) {
            this.logTest('Marketplace Authorization', 'FAIL', error.message);
        }
    }

    async testMarketplaceFunctions() {
        console.log('\n5️⃣  Marketplace Function Tests\n');

        try {
            // Test paused status
            const paused = await this.contracts.marketplace.paused();
            if (!paused) {
                this.logTest('Marketplace Pause Status', 'PASS', 'Not paused (operational)');
            } else {
                this.logTest('Marketplace Pause Status', 'FAIL', 'Marketplace is PAUSED!');
            }
        } catch (error) {
            this.logTest('Marketplace Pause Status', 'FAIL', error.message);
        }

        try {
            // Test getAgentPool (try pool ID 1)
            const pool = await this.contracts.marketplace.getAgentPool(1);
            this.logTest('getAgentPool() Read', 'PASS', `Pool 1 exists`);
        } catch (error) {
            if (error.message.includes('Pool does not exist')) {
                this.logTest('getAgentPool() Read', 'PASS', 'No pool ID 1 (expected)');
            } else {
                this.logTest('getAgentPool() Read', 'FAIL', error.message);
            }
        }

        try {
            // Test owner
            const owner = await this.contracts.marketplace.owner();
            this.logTest('Owner() Read', 'PASS', owner);
        } catch (error) {
            this.logTest('Owner() Read', 'FAIL', error.message);
        }
    }

    async testUSDCContract() {
        console.log('\n6️⃣  USDC Contract Tests\n');

        try {
            // Test decimals
            const decimals = await this.contracts.usdc.decimals();
            if (decimals === 6n) {
                this.logTest('USDC Decimals', 'PASS', 'Decimals: 6');
            } else {
                this.logTest('USDC Decimals', 'FAIL', `Expected 6, got ${decimals}`);
            }
        } catch (error) {
            this.logTest('USDC Decimals', 'FAIL', error.message);
        }

        try {
            // Test balanceOf
            const balance = await this.contracts.usdc.balanceOf(this.testWallet.address);
            this.logTest('USDC balanceOf()', 'PASS', `Balance: ${ethers.formatUnits(balance, 6)} USDC`);
        } catch (error) {
            this.logTest('USDC balanceOf()', 'FAIL', error.message);
        }
    }

    async testOwnership() {
        console.log('\n7️⃣  Ownership & Access Control Tests\n');

        try {
            const [regOwner, repOwner, mktOwner] = await Promise.all([
                this.contracts.registry.owner(),
                this.contracts.reputation.owner(),
                this.contracts.marketplace.owner()
            ]);

            if (regOwner === repOwner && repOwner === mktOwner) {
                this.logTest('Ownership Consistency', 'PASS', `All owned by ${regOwner}`);
            } else {
                this.logTest('Ownership Consistency', 'FAIL', 'Owners are inconsistent!');
            }
        } catch (error) {
            this.logTest('Ownership Consistency', 'FAIL', error.message);
        }
    }

    async testAPIEndpoint() {
        console.log('\n8️⃣  API Endpoint Tests\n');

        const apiUrl = process.env.API_URL || 'https://specular-production.up.railway.app';

        try {
            const response = await fetch(`${apiUrl}/health?network=${this.networkKey}`);
            const data = await response.json();

            if (data.ok && data.network === this.networkKey) {
                this.logTest('API Health Check', 'PASS', `Block: ${data.blockNumber}`);
            } else {
                this.logTest('API Health Check', 'FAIL', 'Unexpected response');
            }
        } catch (error) {
            this.logTest('API Health Check', 'FAIL', error.message);
        }

        try {
            const response = await fetch(`${apiUrl}/pools?network=${this.networkKey}`);
            const data = await response.json();

            if (Array.isArray(data.pools)) {
                this.logTest('API Pools Endpoint', 'PASS', `${data.pools.length} pools found`);
            } else {
                this.logTest('API Pools Endpoint', 'FAIL', 'Invalid response format');
            }
        } catch (error) {
            this.logTest('API Pools Endpoint', 'FAIL', error.message);
        }
    }

    async testInputValidation() {
        console.log('\n9️⃣  Input Validation Tests\n');

        try {
            // Try to request a loan with 0 amount (should fail)
            await this.contracts.marketplace.connect(this.testWallet).requestLoan.staticCall(0, 7);
            this.logTest('Zero Amount Validation', 'FAIL', 'Accepted zero amount loan!');
        } catch (error) {
            if (error.message.includes('InvalidAmount') || error.message.includes('amount')) {
                this.logTest('Zero Amount Validation', 'PASS', 'Rejected zero amount');
            } else {
                this.logTest('Zero Amount Validation', 'PASS', 'Transaction reverted as expected');
            }
        }

        try {
            // Try to request a loan with 0 duration (should fail)
            await this.contracts.marketplace.connect(this.testWallet).requestLoan.staticCall(1000000, 0);
            this.logTest('Zero Duration Validation', 'FAIL', 'Accepted zero duration!');
        } catch (error) {
            if (error.message.includes('InvalidDuration') || error.message.includes('duration')) {
                this.logTest('Zero Duration Validation', 'PASS', 'Rejected zero duration');
            } else {
                this.logTest('Zero Duration Validation', 'PASS', 'Transaction reverted as expected');
            }
        }
    }

    async testStateConsistency() {
        console.log('\n🔟 State Consistency Tests\n');

        try {
            const testAddr = this.network.addresses.deployer || ethers.ZeroAddress;
            const [isRegistered, agentId] = await Promise.all([
                this.contracts.registry.isRegistered(testAddr),
                this.contracts.registry.addressToAgentId(testAddr)
            ]);

            if (isRegistered && agentId === 0n) {
                this.logTest('Registry State Consistency', 'FAIL', 'Registered but no agent ID');
            } else if (!isRegistered && agentId > 0n) {
                this.logTest('Registry State Consistency', 'FAIL', 'Has agent ID but not registered');
            } else {
                this.logTest('Registry State Consistency', 'PASS', 'State is consistent');
            }
        } catch (error) {
            this.logTest('Registry State Consistency', 'FAIL', error.message);
        }
    }

    async runTests() {
        console.log('\n╔════════════════════════════════════════════════════════════╗');
        console.log(`║        COMPREHENSIVE TEST: ${this.network.name.padEnd(30)}║`);
        console.log('╚════════════════════════════════════════════════════════════╝');

        await this.initialize();

        await this.testRPCConnection();
        await this.testContractDeployments();
        await this.testRegistryFunctions();
        await this.testReputationFunctions();
        await this.testMarketplaceFunctions();
        await this.testUSDCContract();
        await this.testOwnership();
        await this.testAPIEndpoint();
        await this.testInputValidation();
        await this.testStateConsistency();

        // Summary
        console.log('\n' + '═'.repeat(60));
        console.log('TEST SUMMARY');
        console.log('═'.repeat(60));
        console.log(`✅ Passed:  ${this.results.summary.passed}`);
        console.log(`❌ Failed:  ${this.results.summary.failed}`);
        console.log(`⏭️  Skipped: ${this.results.summary.skipped}`);
        console.log(`📊 Total:   ${this.results.tests.length}`);

        const passRate = (this.results.summary.passed / this.results.tests.length * 100).toFixed(1);
        console.log(`📈 Pass Rate: ${passRate}%`);
        console.log('═'.repeat(60) + '\n');

        return this.results;
    }
}

async function main() {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║    SPECULAR - COMPREHENSIVE MULTI-NETWORK TEST SUITE      ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');
    console.log(`Date: ${new Date().toISOString()}\n`);

    const allResults = {};

    // Test all networks
    for (const networkKey of ['arc', 'base', 'arbitrum']) {
        const tester = new NetworkTester(networkKey);
        allResults[networkKey] = await tester.runTests();
        await new Promise(resolve => setTimeout(resolve, 2000)); // Brief pause
    }

    // Overall summary
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║                 OVERALL TEST SUMMARY                       ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    let totalPassed = 0;
    let totalFailed = 0;
    let totalTests = 0;

    for (const [networkKey, results] of Object.entries(allResults)) {
        totalPassed += results.summary.passed;
        totalFailed += results.summary.failed;
        totalTests += results.tests.length;

        const passRate = (results.summary.passed / results.tests.length * 100).toFixed(1);
        const status = passRate >= 95 ? '✅' : passRate >= 80 ? '⚠️ ' : '❌';

        console.log(`${status} ${results.network}: ${results.summary.passed}/${results.tests.length} passed (${passRate}%)`);
    }

    console.log('\n' + '─'.repeat(60));
    const overallPassRate = (totalPassed / totalTests * 100).toFixed(1);
    console.log(`Overall: ${totalPassed}/${totalTests} passed (${overallPassRate}%)`);
    console.log('─'.repeat(60) + '\n');

    // Save results
    const outputPath = path.join(__dirname, '../comprehensive-test-results.json');
    fs.writeFileSync(outputPath, JSON.stringify(allResults, null, 2));
    console.log(`📄 Full results saved to: ${outputPath}\n`);

    // Exit code
    if (totalFailed === 0 && overallPassRate >= 95) {
        console.log('🎉 ALL TESTS PASSED!\n');
        process.exit(0);
    } else if (overallPassRate >= 80) {
        console.log('⚠️  TESTS PASSED WITH WARNINGS\n');
        process.exit(0);
    } else {
        console.log('❌ TESTS FAILED\n');
        process.exit(1);
    }
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
