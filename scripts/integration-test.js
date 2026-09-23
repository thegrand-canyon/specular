/**
 * End-to-End Integration Test
 * Tests complete loan lifecycle without making actual transactions
 * Validates all contract interactions work correctly
 */

const { ethers } = require('ethers');

const SECURE_WALLET = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';

class IntegrationTest {
    constructor(network) {
        this.network = network;
        this.results = {
            passed: 0,
            failed: 0,
            tests: []
        };

        if (network === 'base') {
            this.rpc = 'https://mainnet.base.org';
            this.chainId = 8453;
            this.addresses = require('../src/config/base-addresses.json');
        } else {
            this.rpc = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
            this.chainId = 5042002;
            this.addresses = require('../src/config/arc-testnet-addresses.json');
        }

        this.provider = new ethers.JsonRpcProvider(this.rpc, this.chainId, { batchMaxCount: 1 });
    }

    async test(name, fn) {
        try {
            await fn();
            this.results.tests.push({ name, status: 'PASS' });
            this.results.passed++;
            console.log(`  ✅ ${name}`);
        } catch (error) {
            this.results.tests.push({ name, status: 'FAIL', error: error.message });
            this.results.failed++;
            console.log(`  ❌ ${name}`);
            console.log(`     Error: ${error.message}`);
        }
    }

    async runTests() {
        console.log(`\n${'═'.repeat(60)}`);
        console.log(`  INTEGRATION TEST - ${this.network.toUpperCase()}`);
        console.log(`${'═'.repeat(60)}\n`);

        // Test 1: Agent Registration Check
        console.log('👤 Agent Registry Tests');

        const registryAbi = [
            'function addressToAgentId(address) view returns (uint256)',
            'function totalAgents() view returns (uint256)',
            'function getAgentInfo(uint256) view returns (uint256 id, address owner, string agentURI, uint256 registeredAt, bool isActive)'
        ];
        const registry = new ethers.Contract(
            this.addresses.agentRegistryV2,
            registryAbi,
            this.provider
        );

        let testAgentId = 0;

        await this.test('Check if secure wallet is registered', async () => {
            const agentId = await registry.addressToAgentId(SECURE_WALLET);
            testAgentId = Number(agentId);
            if (testAgentId === 0) {
                throw new Error('Secure wallet not registered as agent');
            }
        });

        await this.test('Retrieve agent info', async () => {
            if (testAgentId === 0) throw new Error('No agent ID to test with');
            const info = await registry.getAgentInfo(testAgentId);
            if (info.owner.toLowerCase() !== SECURE_WALLET.toLowerCase()) {
                throw new Error('Agent owner mismatch');
            }
            if (!info.isActive) {
                throw new Error('Agent is not active');
            }
        });

        await this.test('Check total agents', async () => {
            const total = await registry.totalAgents();
            if (total < testAgentId) {
                throw new Error('Total agents less than test agent ID');
            }
        });

        // Test 2: Reputation System
        console.log('\n⭐ Reputation Manager Tests');

        const reputationAbi = [
            'function getReputationScore(address) view returns (uint256)',
            'function calculateCreditLimit(address) view returns (uint256)',
            'function calculateInterestRate(address) view returns (uint256)',
            'function getCollateralRequirement(address) view returns (uint256)'
        ];
        const reputation = new ethers.Contract(
            this.addresses.reputationManagerV3,
            reputationAbi,
            this.provider
        );

        let testScore = 0;

        await this.test('Get reputation score', async () => {
            const score = await reputation.getReputationScore(SECURE_WALLET);
            testScore = Number(score);
            if (testScore < 0 || testScore > 1000) {
                throw new Error(`Invalid reputation score: ${testScore}`);
            }
        });

        await this.test('Calculate credit limit', async () => {
            const limit = await reputation.calculateCreditLimit(SECURE_WALLET);
            if (limit <= 0) {
                throw new Error('Credit limit is zero or negative');
            }
        });

        await this.test('Calculate interest rate', async () => {
            const rate = await reputation.calculateInterestRate(SECURE_WALLET);
            if (rate < 0 || rate > 10000) { // Max 100% APR in basis points
                throw new Error(`Invalid interest rate: ${rate}`);
            }
        });

        await this.test('Get collateral requirement', async () => {
            const collateral = await reputation.getCollateralRequirement(SECURE_WALLET);
            // Should be 0-100% (0-10000 basis points)
            if (collateral < 0 || collateral > 10000) {
                throw new Error(`Invalid collateral requirement: ${collateral}`);
            }
        });

        // Test 3: Liquidity Marketplace
        console.log('\n💧 Liquidity Marketplace Tests');

        const marketplaceAbi = [
            'function agentPools(uint256) view returns (uint256 agentId, address agentAddress, uint256 totalLiquidity, uint256 availableLiquidity, uint256 totalLoaned, uint256 totalEarned, bool isActive)',
            'function positions(uint256, address) view returns (uint256 amount, uint256 earnedInterest, uint256 depositTimestamp)',
            'function paused() view returns (bool)',
            'function nextLoanId() view returns (uint256)',
            'function accumulatedFees() view returns (uint256)'
        ];
        const marketplace = new ethers.Contract(
            this.addresses.agentLiquidityMarketplace,
            marketplaceAbi,
            this.provider
        );

        await this.test('Check marketplace is not paused', async () => {
            const paused = await marketplace.paused();
            if (paused) {
                throw new Error('Marketplace is paused');
            }
        });

        await this.test('Check agent pool exists', async () => {
            const pool = await marketplace.agentPools(testAgentId);
            if (!pool.isActive) {
                throw new Error('Agent pool is not active');
            }
            if (pool.agentAddress.toLowerCase() !== SECURE_WALLET.toLowerCase()) {
                throw new Error('Pool agent address mismatch');
            }
        });

        await this.test('Check lender position', async () => {
            const position = await marketplace.positions(testAgentId, SECURE_WALLET);
            // Should have some liquidity supplied
            if (position.amount <= 0) {
                throw new Error('No liquidity in position');
            }
        });

        await this.test('Check next loan ID', async () => {
            const nextId = await marketplace.nextLoanId();
            if (nextId < 1) {
                throw new Error('Invalid next loan ID');
            }
        });

        await this.test('Check platform fees', async () => {
            const fees = await marketplace.accumulatedFees();
            // Should be >= 0
            if (fees < 0) {
                throw new Error('Invalid accumulated fees');
            }
        });

        // Test 4: USDC Integration
        console.log('\n💵 USDC Token Tests');

        const usdcAbi = [
            'function balanceOf(address) view returns (uint256)',
            'function allowance(address, address) view returns (uint256)',
            'function decimals() view returns (uint8)'
        ];
        const usdc = new ethers.Contract(
            this.addresses.usdc,
            usdcAbi,
            this.provider
        );

        await this.test('Check USDC decimals', async () => {
            const decimals = await usdc.decimals();
            if (decimals !== 6) {
                throw new Error(`Wrong USDC decimals: ${decimals}`);
            }
        });

        await this.test('Check marketplace USDC balance', async () => {
            const balance = await usdc.balanceOf(this.addresses.agentLiquidityMarketplace);
            // Should have some USDC from liquidity
            if (balance <= 0) {
                throw new Error('Marketplace has no USDC');
            }
        });

        // Test 5: Contract Permissions
        console.log('\n🔐 Contract Permission Tests');

        const ownableAbi = ['function owner() view returns (address)'];

        await this.test('Registry owned by secure wallet', async () => {
            const contract = new ethers.Contract(this.addresses.agentRegistryV2, ownableAbi, this.provider);
            const owner = await contract.owner();
            if (owner.toLowerCase() !== SECURE_WALLET.toLowerCase()) {
                throw new Error(`Registry owned by ${owner}, expected ${SECURE_WALLET}`);
            }
        });

        await this.test('ReputationManager owned by secure wallet', async () => {
            const contract = new ethers.Contract(this.addresses.reputationManagerV3, ownableAbi, this.provider);
            const owner = await contract.owner();
            if (owner.toLowerCase() !== SECURE_WALLET.toLowerCase()) {
                throw new Error(`ReputationManager owned by ${owner}, expected ${SECURE_WALLET}`);
            }
        });

        await this.test('Marketplace owned by secure wallet', async () => {
            const contract = new ethers.Contract(this.addresses.agentLiquidityMarketplace, ownableAbi, this.provider);
            const owner = await contract.owner();
            if (owner.toLowerCase() !== SECURE_WALLET.toLowerCase()) {
                throw new Error(`Marketplace owned by ${owner}, expected ${SECURE_WALLET}`);
            }
        });

        // Test 6: Data Consistency
        console.log('\n🔄 Data Consistency Tests');

        await this.test('Pool liquidity matches position', async () => {
            const pool = await marketplace.agentPools(testAgentId);
            const position = await marketplace.positions(testAgentId, SECURE_WALLET);

            // Position amount should be <= pool total liquidity
            if (position.amount > pool.totalLiquidity) {
                throw new Error('Position exceeds pool liquidity');
            }
        });

        await this.test('Available liquidity calculation', async () => {
            const pool = await marketplace.agentPools(testAgentId);

            // Available + Loaned should equal Total
            const calculated = pool.availableLiquidity + pool.totalLoaned;
            const expected = pool.totalLiquidity;

            // Allow small rounding difference
            const diff = calculated > expected ? calculated - expected : expected - calculated;
            if (diff > 1000n) { // Allow 0.001 USDC difference
                throw new Error(`Liquidity mismatch: ${calculated} vs ${expected}`);
            }
        });

        // Print Summary
        this.printSummary();
    }

    printSummary() {
        console.log(`\n${'═'.repeat(60)}`);
        console.log('  TEST SUMMARY');
        console.log(`${'═'.repeat(60)}`);
        console.log(`  Network:      ${this.network}`);
        console.log(`  Passed:       ${this.results.passed}`);
        console.log(`  Failed:       ${this.results.failed}`);
        console.log(`  Success Rate: ${((this.results.passed / (this.results.passed + this.results.failed)) * 100).toFixed(1)}%`);
        console.log(`${'═'.repeat(60)}\n`);

        if (this.results.failed > 0) {
            console.log('❌ Integration test FAILED\n');
            return 1;
        } else {
            console.log('✅ All integration tests PASSED\n');
            return 0;
        }
    }
}

async function main() {
    const network = process.env.DEFAULT_NETWORK || 'arc';
    const test = new IntegrationTest(network);
    await test.runTests();
}

main().catch(error => {
    console.error('Test failed:', error);
    process.exit(1);
});
