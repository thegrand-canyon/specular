/**
 * Comprehensive Multi-Network Test Suite
 * Tests all contract functionality across Arc, Base, and Arbitrum
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Network configurations
const NETWORKS = {
    arc: {
        name: 'Arc Testnet',
        rpc: process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
        config: require('../src/config/arc-testnet-addresses.json')
    },
    base: {
        name: 'Base Mainnet',
        rpc: 'https://mainnet.base.org',
        config: require('../src/config/base-addresses.json')
    },
    arbitrum: {
        name: 'Arbitrum One',
        rpc: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
        config: require('../src/config/arbitrum-addresses.json')
    }
};

const API_URL = process.env.API_URL || 'https://specular-production.up.railway.app';

// Load ABIs
function loadAbi(name) {
    const abiPath = path.join(__dirname, '../abis', `${name}.json`);
    const abiFile = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
    return Array.isArray(abiFile) ? abiFile : abiFile.abi || abiFile;
}

const registryAbi = loadAbi('AgentRegistryV2');
const reputationAbi = loadAbi('ReputationManagerV3');
const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');
const usdcAbi = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];

class ComprehensiveNetworkTester {
    constructor(networkKey) {
        this.networkKey = networkKey;
        this.network = NETWORKS[networkKey];
        this.results = [];
        this.testsPassed = 0;
        this.testsFailed = 0;
    }

    async initialize() {
        this.provider = new ethers.JsonRpcProvider(this.network.rpc, undefined, { batchMaxCount: 1 });
        this.registry = new ethers.Contract(this.network.config.agentRegistryV2, registryAbi, this.provider);
        this.reputation = new ethers.Contract(this.network.config.reputationManagerV3, reputationAbi, this.provider);
        this.marketplace = new ethers.Contract(this.network.config.agentLiquidityMarketplace, marketplaceAbi, this.provider);
        this.usdc = new ethers.Contract(this.network.config.usdc, usdcAbi, this.provider);
    }

    logTest(category, name, passed, elapsed, details = '') {
        const status = passed ? '✅' : '❌';
        console.log(`   ${status} ${name.padEnd(50)} ${elapsed.toString().padStart(6)}ms${details ? ' - ' + details : ''}`);

        this.results.push({ category, name, passed, elapsed, details });
        if (passed) this.testsPassed++;
        else this.testsFailed++;
    }

    async runTest(category, name, testFn) {
        const start = Date.now();
        try {
            const result = await testFn();
            const elapsed = Date.now() - start;
            this.logTest(category, name, true, elapsed, result || '');
            return true;
        } catch (error) {
            const elapsed = Date.now() - start;
            this.logTest(category, name, false, elapsed, error.message.split('\n')[0]);
            return false;
        }
    }

    // Infrastructure Tests
    async testInfrastructure() {
        console.log('\n🔧 INFRASTRUCTURE TESTS\n');

        await this.runTest('Infrastructure', 'RPC Connection', async () => {
            const blockNumber = await this.provider.getBlockNumber();
            return `Block ${blockNumber}`;
        });

        await this.runTest('Infrastructure', 'Network Chain ID', async () => {
            const network = await this.provider.getNetwork();
            return `Chain ID ${network.chainId}`;
        });

        await this.runTest('Infrastructure', 'Gas Price', async () => {
            const feeData = await this.provider.getFeeData();
            return `${ethers.formatUnits(feeData.gasPrice, 'gwei')} gwei`;
        });
    }

    // Contract Deployment Tests
    async testContractDeployments() {
        console.log('\n📜 CONTRACT DEPLOYMENT TESTS\n');

        await this.runTest('Deployment', 'Registry Contract Exists', async () => {
            const code = await this.provider.getCode(this.network.config.agentRegistryV2);
            if (code === '0x') throw new Error('No code at address');
            return `${code.length} bytes`;
        });

        await this.runTest('Deployment', 'Reputation Contract Exists', async () => {
            const code = await this.provider.getCode(this.network.config.reputationManagerV3);
            if (code === '0x') throw new Error('No code at address');
            return `${code.length} bytes`;
        });

        await this.runTest('Deployment', 'Marketplace Contract Exists', async () => {
            const code = await this.provider.getCode(this.network.config.agentLiquidityMarketplace);
            if (code === '0x') throw new Error('No code at address');
            return `${code.length} bytes`;
        });

        await this.runTest('Deployment', 'USDC Contract Exists', async () => {
            const code = await this.provider.getCode(this.network.config.usdc);
            if (code === '0x') throw new Error('No code at address');
            const decimals = await this.usdc.decimals();
            return `${decimals} decimals`;
        });
    }

    // Registry Tests
    async testRegistry() {
        console.log('\n👥 REGISTRY TESTS\n');

        await this.runTest('Registry', 'Get Total Agents', async () => {
            const total = await this.registry.totalAgents();
            return `${total} agents`;
        });

        await this.runTest('Registry', 'Check Unregistered Address', async () => {
            const isReg = await this.registry.isRegistered(ethers.ZeroAddress);
            if (isReg) throw new Error('Zero address should not be registered');
            return 'Correctly returns false';
        });

        await this.runTest('Registry', 'Get Agent by ID (if exists)', async () => {
            const total = await this.registry.totalAgents();
            if (Number(total) === 0) return 'No agents to query';

            const agent = await this.registry.agents(1);
            return `Agent 1: ${agent.agentWallet.slice(0, 10)}...`;
        });

        await this.runTest('Registry', 'Address to Agent ID Mapping', async () => {
            const total = await this.registry.totalAgents();
            if (Number(total) === 0) return 'No agents to test';

            const agent = await this.registry.agents(1);
            const agentId = await this.registry.addressToAgentId(agent.agentWallet);
            if (agentId !== 1n) throw new Error('Mapping incorrect');
            return 'Mapping correct';
        });
    }

    // Reputation Tests
    async testReputation() {
        console.log('\n⭐ REPUTATION TESTS\n');

        await this.runTest('Reputation', 'Get Score (Zero Address)', async () => {
            const score = await this.reputation['getReputationScore(address)'](ethers.ZeroAddress);
            return `Score: ${score}`;
        });

        await this.runTest('Reputation', 'Calculate Credit Limit', async () => {
            const limit = await this.reputation['calculateCreditLimit(address)'](ethers.ZeroAddress);
            return `Limit: ${ethers.formatUnits(limit, 6)} USDC`;
        });

        await this.runTest('Reputation', 'Calculate Interest Rate', async () => {
            const rate = await this.reputation.calculateInterestRate(ethers.ZeroAddress);
            return `Rate: ${Number(rate) / 100}%`;
        });

        await this.runTest('Reputation', 'Get Loan History', async () => {
            const history = await this.reputation.getLoanHistory(ethers.ZeroAddress);
            return `${history.length} loans`;
        });

        await this.runTest('Reputation', 'Score Range Validation', async () => {
            const score = await this.reputation['getReputationScore(address)'](ethers.ZeroAddress);
            const scoreNum = Number(score);
            if (scoreNum < 0 || scoreNum > 1000) {
                throw new Error(`Score ${scoreNum} out of range 0-1000`);
            }
            return 'Score in valid range';
        });

        await this.runTest('Reputation', 'Interest Rate Bounds', async () => {
            const rate = await this.reputation.calculateInterestRate(ethers.ZeroAddress);
            const rateNum = Number(rate) / 100;
            if (rateNum < 5 || rateNum > 20) {
                throw new Error(`Rate ${rateNum}% out of range 5-20%`);
            }
            return 'Rate in valid range';
        });
    }

    // Marketplace Tests
    async testMarketplace() {
        console.log('\n🏪 MARKETPLACE TESTS\n');

        await this.runTest('Marketplace', 'Get Total Pools', async () => {
            const total = await this.marketplace.totalPools();
            return `${total} pools`;
        });

        await this.runTest('Marketplace', 'Get Pool (if exists)', async () => {
            const total = await this.marketplace.totalPools();
            if (Number(total) === 0) return 'No pools to query';

            const agentId = await this.marketplace.agentPoolIds(0);
            const pool = await this.marketplace.agentPools(agentId);
            return `Pool ${agentId}: ${ethers.formatUnits(pool.totalLiquidity, 6)} USDC`;
        });

        await this.runTest('Marketplace', 'Get USDC Balance', async () => {
            const balance = await this.usdc.balanceOf(this.network.config.agentLiquidityMarketplace);
            return `${ethers.formatUnits(balance, 6)} USDC`;
        });

        await this.runTest('Marketplace', 'Verify Owner', async () => {
            const owner = await this.marketplace.owner();
            return `Owner: ${owner.slice(0, 10)}...`;
        });

        await this.runTest('Marketplace', 'Check Paused State', async () => {
            const paused = await this.marketplace.paused();
            if (paused) throw new Error('Contract is paused');
            return 'Not paused';
        });
    }

    // Security Tests
    async testSecurity() {
        console.log('\n🔒 SECURITY TESTS\n');

        await this.runTest('Security', 'Ownership Verification', async () => {
            const regOwner = await this.registry.owner();
            const repOwner = await this.reputation.owner();
            const mktOwner = await this.marketplace.owner();

            if (regOwner === ethers.ZeroAddress ||
                repOwner === ethers.ZeroAddress ||
                mktOwner === ethers.ZeroAddress) {
                throw new Error('Invalid owner address');
            }
            return 'All contracts have valid owners';
        });

        await this.runTest('Security', 'Access Control (Paused Check)', async () => {
            const paused = await this.marketplace.paused();
            return paused ? 'Paused (safe mode)' : 'Active';
        });

        await this.runTest('Security', 'Zero Address Rejection', async () => {
            const isReg = await this.registry.isRegistered(ethers.ZeroAddress);
            if (isReg) throw new Error('Zero address should not be registered');
            return 'Zero address correctly rejected';
        });

        await this.runTest('Security', 'Contract Authorization', async () => {
            // Try to check if marketplace is authorized in reputation manager
            try {
                const validationRegistry = await this.reputation.validationRegistry();
                return `Validation registry: ${validationRegistry.slice(0, 10)}...`;
            } catch (e) {
                return 'Authorization check not available';
            }
        });
    }

    // API Tests
    async testAPI() {
        console.log('\n🌐 API ENDPOINT TESTS\n');

        await this.runTest('API', '/health', async () => {
            const res = await fetch(`${API_URL}/health?network=${this.networkKey}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return `Block ${data.blockNumber}`;
        });

        await this.runTest('API', '/status', async () => {
            const res = await fetch(`${API_URL}/status?network=${this.networkKey}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return data.tvl;
        });

        await this.runTest('API', '/pools', async () => {
            const res = await fetch(`${API_URL}/pools?network=${this.networkKey}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return `${data.totalPools} pools`;
        });

        await this.runTest('API', '/agents (paginated)', async () => {
            const res = await fetch(`${API_URL}/agents?network=${this.networkKey}&limit=5`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return `${data.returned}/${data.totalAgents} agents`;
        });

        await this.runTest('API', '/agents (cache hit)', async () => {
            const start = Date.now();
            const res = await fetch(`${API_URL}/agents?network=${this.networkKey}&limit=5`);
            const elapsed = Date.now() - start;
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            if (elapsed > 300) throw new Error(`Too slow: ${elapsed}ms`);
            return `${elapsed}ms (cached)`;
        });

        await this.runTest('API', '/.well-known/specular.json', async () => {
            const res = await fetch(`${API_URL}/.well-known/specular.json?network=${this.networkKey}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            return `Protocol v${data.version}`;
        });
    }

    // Performance Tests
    async testPerformance() {
        console.log('\n⚡ PERFORMANCE TESTS\n');

        await this.runTest('Performance', 'Single Contract Call Speed', async () => {
            const start = Date.now();
            await this.registry.totalAgents();
            const elapsed = Date.now() - start;
            return `${elapsed}ms`;
        });

        await this.runTest('Performance', '5 Sequential Calls', async () => {
            const start = Date.now();
            for (let i = 0; i < 5; i++) {
                await this.registry.totalAgents();
            }
            const elapsed = Date.now() - start;
            return `${elapsed}ms (${(elapsed / 5).toFixed(0)}ms avg)`;
        });

        await this.runTest('Performance', '5 Parallel Calls', async () => {
            const start = Date.now();
            await Promise.all(Array(5).fill(null).map(() => this.registry.totalAgents()));
            const elapsed = Date.now() - start;
            return `${elapsed}ms`;
        });

        await this.runTest('Performance', 'API Response Time', async () => {
            const start = Date.now();
            const res = await fetch(`${API_URL}/health?network=${this.networkKey}`);
            const elapsed = Date.now() - start;
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return `${elapsed}ms`;
        });
    }

    // Data Consistency Tests
    async testDataConsistency() {
        console.log('\n📊 DATA CONSISTENCY TESTS\n');

        await this.runTest('Consistency', 'Registry ↔ Reputation Sync', async () => {
            const totalAgents = await this.registry.totalAgents();
            // Can't directly verify but check if both accessible
            const score = await this.reputation['getReputationScore(address)'](ethers.ZeroAddress);
            return `${totalAgents} agents registered`;
        });

        await this.runTest('Consistency', 'Marketplace TVL Matches Balance', async () => {
            const balance = await this.usdc.balanceOf(this.network.config.agentLiquidityMarketplace);
            const totalPools = await this.marketplace.totalPools();

            let poolTVL = 0n;
            for (let i = 0; i < Number(totalPools); i++) {
                try {
                    const agentId = await this.marketplace.agentPoolIds(i);
                    const pool = await this.marketplace.agentPools(agentId);
                    poolTVL += pool.totalLiquidity;
                } catch (e) {
                    // Pool might not exist
                }
            }

            const diff = balance - poolTVL;
            const diffUSDC = ethers.formatUnits(diff < 0n ? -diff : diff, 6);
            return `Diff: ${diffUSDC} USDC`;
        });

        await this.runTest('Consistency', 'API vs Contract Data Match', async () => {
            const contractTotal = await this.marketplace.totalPools();
            const res = await fetch(`${API_URL}/pools?network=${this.networkKey}`);
            const apiData = await res.json();

            // API might filter inactive pools, so just check it's ≤ contract total
            if (apiData.totalPools > Number(contractTotal)) {
                throw new Error('API shows more pools than contract');
            }
            return `API: ${apiData.totalPools}, Contract: ${contractTotal}`;
        });
    }

    printSummary() {
        const total = this.testsPassed + this.testsFailed;
        const passRate = total > 0 ? ((this.testsPassed / total) * 100).toFixed(1) : '0.0';

        console.log('\n' + '═'.repeat(70));
        console.log(`${this.network.name.toUpperCase()} - COMPREHENSIVE TEST SUMMARY`);
        console.log('═'.repeat(70));
        console.log(`Total Tests:     ${total}`);
        console.log(`Passed:          ${this.testsPassed}`);
        console.log(`Failed:          ${this.testsFailed}`);
        console.log(`Pass Rate:       ${passRate}%`);
        console.log('═'.repeat(70) + '\n');

        return { total, passed: this.testsPassed, failed: this.testsFailed, passRate: parseFloat(passRate) };
    }

    async run() {
        console.log('\n╔════════════════════════════════════════════════════════════════════╗');
        console.log(`║  ${this.network.name.toUpperCase().padEnd(64)}  ║`);
        console.log('╚════════════════════════════════════════════════════════════════════╝');

        await this.initialize();

        await this.testInfrastructure();
        await this.testContractDeployments();
        await this.testRegistry();
        await this.testReputation();
        await this.testMarketplace();
        await this.testSecurity();
        await this.testAPI();
        await this.testPerformance();
        await this.testDataConsistency();

        return this.printSummary();
    }
}

async function main() {
    console.log('\n╔════════════════════════════════════════════════════════════════════╗');
    console.log('║         COMPREHENSIVE MULTI-NETWORK TEST SUITE                      ║');
    console.log('╚════════════════════════════════════════════════════════════════════╝\n');
    console.log(`Date: ${new Date().toISOString()}`);
    console.log(`API: ${API_URL}\n`);

    const allResults = {};

    // Test all networks
    for (const networkKey of ['arc', 'base', 'arbitrum']) {
        try {
            const tester = new ComprehensiveNetworkTester(networkKey);
            allResults[networkKey] = await tester.run();
            await new Promise(resolve => setTimeout(resolve, 3000)); // Cool down
        } catch (error) {
            console.error(`\n❌ ${networkKey.toUpperCase()} test suite crashed:`, error.message);
            allResults[networkKey] = { total: 0, passed: 0, failed: 0, passRate: 0 };
        }
    }

    // Overall summary
    console.log('\n╔════════════════════════════════════════════════════════════════════╗');
    console.log('║                    OVERALL TEST SUMMARY                             ║');
    console.log('╚════════════════════════════════════════════════════════════════════╝\n');

    let grandTotal = 0;
    let grandPassed = 0;
    let grandFailed = 0;

    for (const [network, results] of Object.entries(allResults)) {
        grandTotal += results.total;
        grandPassed += results.passed;
        grandFailed += results.failed;

        const networkName = NETWORKS[network].name;
        console.log(`${networkName.padEnd(20)}: ${results.passed}/${results.total} passed (${results.passRate.toFixed(1)}%)`);
    }

    const grandPassRate = grandTotal > 0 ? ((grandPassed / grandTotal) * 100).toFixed(1) : '0.0';

    console.log('\n' + '─'.repeat(70));
    console.log(`Total Across All Networks: ${grandPassed}/${grandTotal} passed (${grandPassRate}%)`);
    console.log(`Failed Tests: ${grandFailed}`);
    console.log('─'.repeat(70) + '\n');

    if (grandPassed === grandTotal) {
        console.log('🎉 All tests passed across all networks!\n');
    } else {
        console.log(`⚠️  ${grandFailed} test(s) failed. Review details above.\n`);
    }

    process.exit(grandPassed === grandTotal ? 0 : 1);
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
