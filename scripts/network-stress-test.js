/**
 * Network Stress Test
 * Tests network reliability, RPC performance, and contract responsiveness
 */

const { ethers } = require('ethers');

const TESTS = {
    base: {
        name: 'Base Mainnet',
        rpc: 'https://mainnet.base.org',
        chainId: 8453,
        addresses: require('../src/config/base-addresses.json')
    },
    arc: {
        name: 'Arc Testnet',
        rpc: process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
        chainId: 5042002,
        addresses: require('../src/config/arc-testnet-addresses.json')
    }
};

class NetworkTester {
    constructor(network) {
        this.network = network;
        this.config = TESTS[network];
        this.results = {
            passed: 0,
            failed: 0,
            warnings: 0,
            tests: []
        };
    }

    async test(name, fn) {
        const start = Date.now();
        try {
            await fn();
            const duration = Date.now() - start;
            this.results.tests.push({ name, status: 'PASS', duration });
            this.results.passed++;
            console.log(`  ✅ ${name} (${duration}ms)`);
        } catch (error) {
            const duration = Date.now() - start;
            this.results.tests.push({ name, status: 'FAIL', duration, error: error.message });
            this.results.failed++;
            console.log(`  ❌ ${name} - ${error.message}`);
        }
    }

    async warn(name, message) {
        this.results.tests.push({ name, status: 'WARN', message });
        this.results.warnings++;
        console.log(`  ⚠️  ${name} - ${message}`);
    }

    async runTests() {
        console.log(`\n${'═'.repeat(60)}`);
        console.log(`  NETWORK STRESS TEST - ${this.config.name.toUpperCase()}`);
        console.log(`${'═'.repeat(60)}\n`);

        const provider = new ethers.JsonRpcProvider(this.config.rpc, this.config.chainId, { batchMaxCount: 1 });

        // Test 1: Basic Connectivity
        console.log('🌐 Basic Connectivity Tests');
        await this.test('Get latest block number', async () => {
            const block = await provider.getBlockNumber();
            if (block < 1000) throw new Error('Block number too low');
        });

        await this.test('Get gas price', async () => {
            const gasPrice = await provider.getFeeData();
            if (!gasPrice.gasPrice) throw new Error('No gas price returned');
        });

        await this.test('Get chain ID', async () => {
            const network = await provider.getNetwork();
            if (Number(network.chainId) !== this.config.chainId) {
                throw new Error(`Wrong chain ID: ${network.chainId}`);
            }
        });

        // Test 2: Contract Calls
        console.log('\n📜 Smart Contract Read Tests');

        const registryAbi = ['function totalAgents() view returns (uint256)'];
        const registry = new ethers.Contract(
            this.config.addresses.agentRegistryV2,
            registryAbi,
            provider
        );

        await this.test('Read total agents', async () => {
            const total = await registry.totalAgents();
            if (total < 0) throw new Error('Invalid total agents');
        });

        const marketplaceAbi = [
            'function paused() view returns (bool)',
            'function nextLoanId() view returns (uint256)'
        ];
        const marketplace = new ethers.Contract(
            this.config.addresses.agentLiquidityMarketplace,
            marketplaceAbi,
            provider
        );

        await this.test('Check marketplace pause status', async () => {
            const paused = await marketplace.paused();
            // Just checking it returns a boolean
            if (typeof paused !== 'boolean') throw new Error('Invalid pause status');
        });

        await this.test('Read next loan ID', async () => {
            const loanId = await marketplace.nextLoanId();
            if (loanId < 0) throw new Error('Invalid loan ID');
        });

        // Test 3: Performance Tests
        console.log('\n⚡ Performance Tests');

        await this.test('Concurrent reads (10 requests)', async () => {
            const promises = [];
            for (let i = 0; i < 10; i++) {
                promises.push(provider.getBlockNumber());
            }
            await Promise.all(promises);
        });

        await this.test('Sequential contract calls (5 calls)', async () => {
            for (let i = 0; i < 5; i++) {
                await registry.totalAgents();
            }
        });

        // Test 4: Rate Limiting Detection
        console.log('\n🚦 Rate Limit Tests');

        const start = Date.now();
        let requestCount = 0;
        try {
            for (let i = 0; i < 50; i++) {
                await provider.getBlockNumber();
                requestCount++;
            }
            const duration = Date.now() - start;
            const rps = (requestCount / (duration / 1000)).toFixed(2);
            console.log(`  ✅ Handled 50 requests in ${duration}ms (${rps} req/s)`);
        } catch (error) {
            if (error.message.includes('rate limit') || error.message.includes('429')) {
                this.warn('Rate limiting detected', `After ${requestCount} requests`);
            } else {
                throw error;
            }
        }

        // Test 5: Block Range Queries
        console.log('\n📊 Block Range Tests');

        await this.test('Query recent blocks (last 10)', async () => {
            const currentBlock = await provider.getBlockNumber();
            const promises = [];
            for (let i = 0; i < 10; i++) {
                promises.push(provider.getBlock(currentBlock - i));
            }
            await Promise.all(promises);
        });

        // Test 6: Contract Event Logs (if any exist)
        console.log('\n📝 Event Log Tests');

        await this.test('Query recent events', async () => {
            const currentBlock = await provider.getBlockNumber();
            const filter = {
                address: this.config.addresses.agentLiquidityMarketplace,
                fromBlock: currentBlock - 1000,
                toBlock: currentBlock
            };
            await provider.getLogs(filter);
        });

        // Summary
        this.printSummary();
    }

    printSummary() {
        console.log(`\n${'═'.repeat(60)}`);
        console.log('  TEST SUMMARY');
        console.log(`${'═'.repeat(60)}`);
        console.log(`  Network:      ${this.config.name}`);
        console.log(`  RPC:          ${this.config.rpc}`);
        console.log(`  Passed:       ${this.results.passed}`);
        console.log(`  Failed:       ${this.results.failed}`);
        console.log(`  Warnings:     ${this.results.warnings}`);
        console.log(`${'═'.repeat(60)}\n`);

        if (this.results.failed > 0) {
            console.log('❌ Network test FAILED\n');
            return 1;
        } else if (this.results.warnings > 0) {
            console.log('⚠️  Network test passed with warnings\n');
            return 0;
        } else {
            console.log('✅ All tests PASSED\n');
            return 0;
        }
    }
}

async function main() {
    const network = process.env.DEFAULT_NETWORK || 'arc';

    if (!TESTS[network]) {
        console.error(`Unknown network: ${network}`);
        console.error('Available: base, arc');
        process.exit(1);
    }

    const tester = new NetworkTester(network);
    await tester.runTests();
}

main().catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
});
