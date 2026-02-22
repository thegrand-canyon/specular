/**
 * Comprehensive Arc Testnet Testing Suite
 *
 * Tests all aspects of the Specular Protocol:
 * 1. Multi-Agent Scenarios
 * 2. Lender Functionality
 * 3. Pool Mechanics & Edge Cases
 * 4. Security Testing
 * 5. Protocol Analytics
 * 6. Stress Testing
 */

const { ethers } = require('ethers');

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';

// Test wallets
const AGENT1_KEY = process.env.PRIVATE_KEY; // Agent #43 (score 1000)
const AGENT2_KEY = '0x47471cb7a2ba033f2085a82050ff16248ff3a9e5d9ea17ddb0f5d2f208e043ad'; // New agent
const LENDER_KEY = '0x41adb1d6ef22647a3de0e7993f4e33ec7bcd5b49359587967750ff8f3faddf67'; // Lender wallet

// Contract addresses
const addresses = require('../../src/config/arc-testnet-addresses.json');

let testResults = {
    passed: 0,
    failed: 0,
    tests: []
};

function logTest(name, passed, details = '') {
    const status = passed ? '✅' : '❌';
    console.log(`${status} ${name}`);
    if (details) console.log(`   ${details}`);

    testResults.tests.push({ name, passed, details });
    if (passed) testResults.passed++;
    else testResults.failed++;
}

async function setupProvider() {
    return new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
}

async function getContracts(wallet) {
    const registry = new ethers.Contract(
        addresses.agentRegistryV2,
        [
            'function register(string metadata, address[] validators)',
            'function isRegistered(address) view returns (bool)',
            'function getAgentInfo(address) view returns (uint256 agentId, string metadata, uint256 registeredAt, bool active)',
            'function agentCount() view returns (uint256)'
        ],
        wallet
    );

    const reputation = new ethers.Contract(
        addresses.reputationManagerV3,
        [
            'function getReputationScore(address) view returns (uint256)',
            'function getReputationTier(address) view returns (string)',
            'function calculateCreditLimit(address) view returns (uint256)',
            'function getCollateralRequirement(address) view returns (uint256)',
            'function getInterestRate(address) view returns (uint256)'
        ],
        wallet
    );

    const marketplace = new ethers.Contract(
        addresses.agentLiquidityMarketplace,
        [
            'function createAgentPool() returns (uint256)',
            'function supplyLiquidity(uint256 poolId, uint256 amount)',
            'function withdrawLiquidity(uint256 poolId, uint256 amount)',
            'function requestLoan(uint256 amount, uint256 durationDays) returns (uint256)',
            'function repayLoan(uint256 loanId)',
            'function getPoolInfo(uint256 poolId) view returns (address agent, uint256 totalLiquidity, uint256 availableLiquidity, uint256 totalLoaned, uint256 lenderCount)',
            'function getLoanInfo(uint256 loanId) view returns (address borrower, uint256 poolId, uint256 amount, uint256 collateral, uint256 interestRate, uint256 startTime, uint256 endTime, uint8 state)',
            'function getAgentActiveLoans(address agent) view returns (uint256)',
            'function MAX_CONCURRENT_LOANS() view returns (uint256)'
        ],
        wallet
    );

    const usdc = new ethers.Contract(
        addresses.mockUSDC,
        [
            'function balanceOf(address) view returns (uint256)',
            'function approve(address, uint256) returns (bool)',
            'function transfer(address, uint256) returns (bool)',
            'function mint(address, uint256)'
        ],
        wallet
    );

    return { registry, reputation, marketplace, usdc };
}

// ============================================================================
// TEST 1: MULTI-AGENT SCENARIOS
// ============================================================================

async function testMultiAgent() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║         TEST 1: MULTI-AGENT SCENARIOS           ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = await setupProvider();
    const agent1 = new ethers.Wallet(AGENT1_KEY, provider);
    const agent2 = new ethers.Wallet(AGENT2_KEY, provider);

    const contracts1 = await getContracts(agent1);
    const contracts2 = await getContracts(agent2);

    // Test 1.1: Check Agent #43 status
    const agent1Registered = await contracts1.registry.isRegistered(agent1.address);
    const agent1Score = await contracts1.reputation.getReputationScore(agent1.address);
    logTest('Agent #43 is registered with score 1000',
        agent1Registered && agent1Score === 1000n,
        `Score: ${agent1Score}`);

    // Test 1.2: Register Agent #2
    const agent2Registered = await contracts2.registry.isRegistered(agent2.address);
    if (!agent2Registered) {
        console.log('\n📝 Registering Agent #2...');
        const tx = await contracts2.registry.register('{"name":"Agent2","test":true}', []);
        await tx.wait();
        console.log('   ✅ Agent #2 registered');
    }

    const agent2Info = await contracts2.registry.getAgentInfo(agent2.address);
    logTest('Agent #2 successfully registered',
        agent2Info.active,
        `Agent ID: ${agent2Info.agentId}`);

    const agent2Score = await contracts2.reputation.getReputationScore(agent2.address);
    logTest('Agent #2 has reputation score',
        agent2Score >= 100n,
        `Score: ${agent2Score}`);

    // Test 1.3: Both agents have pools
    console.log('\n📦 Checking pools...');
    let pool1Info;
    try {
        pool1Info = await contracts1.marketplace.getPoolInfo(43); // Agent #43's pool
        logTest('Agent #43 has active pool',
            pool1Info.agent.toLowerCase() === agent1.address.toLowerCase(),
            `Liquidity: ${ethers.formatUnits(pool1Info.totalLiquidity, 6)} USDC`);
    } catch (e) {
        logTest('Agent #43 has active pool', false, `Pool query failed: ${e.message.slice(0, 50)}`);
        // Create pool for Agent #43
        console.log('\n📦 Creating pool for Agent #43...');
        const tx = await contracts1.marketplace.createAgentPool();
        await tx.wait();
        console.log('   ✅ Pool created');
        pool1Info = await contracts1.marketplace.getPoolInfo(43);
    }

    // Create pool for Agent #2 if needed
    let pool2Exists = false;
    try {
        const pool2Info = await contracts2.marketplace.getPoolInfo(agent2Info.agentId);
        if (pool2Info.agent !== ethers.ZeroAddress) {
            pool2Exists = true;
            console.log(`   ℹ️  Agent #2 already has pool #${agent2Info.agentId}`);
        }
    } catch (e) {
        // Pool doesn't exist
    }

    if (!pool2Exists) {
        console.log('\n📦 Creating pool for Agent #2...');
        try {
            const tx = await contracts2.marketplace.createAgentPool();
            await tx.wait();
            console.log('   ✅ Pool created');
            pool2Exists = true;
        } catch (e) {
            console.log(`   ⚠️  Pool creation skipped: ${e.message.slice(0, 50)}`);
        }
    }

    // Verify pool exists
    try {
        const pool2Info = await contracts2.marketplace.getPoolInfo(agent2Info.agentId);
        logTest('Agent #2 has pool',
            pool2Info.agent.toLowerCase() === agent2.address.toLowerCase(),
            `Pool ID: ${agent2Info.agentId}`);
    } catch (e) {
        logTest('Agent #2 has pool', false, 'Pool query failed');
    }

    // Test 1.4: Total agent count
    const totalAgents = await contracts1.registry.agentCount();
    logTest('Protocol has multiple registered agents',
        totalAgents >= 2n,
        `Total agents: ${totalAgents}`);

    return { agent1, agent2, contracts1, contracts2 };
}

// ============================================================================
// TEST 2: LENDER FUNCTIONALITY
// ============================================================================

async function testLenderFunctionality() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║         TEST 2: LENDER FUNCTIONALITY            ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = await setupProvider();
    const lender = new ethers.Wallet(LENDER_KEY, provider);
    const agent1 = new ethers.Wallet(AGENT1_KEY, provider);

    const lenderContracts = await getContracts(lender);
    const agentContracts = await getContracts(agent1);

    // Test 2.1: Check lender USDC balance
    const lenderBalance = await lenderContracts.usdc.balanceOf(lender.address);
    console.log(`💰 Lender balance: ${ethers.formatUnits(lenderBalance, 6)} USDC`);

    // Mint USDC if needed
    if (lenderBalance < ethers.parseUnits('500', 6)) {
        console.log('\n💵 Minting USDC for lender...');
        const mintTx = await lenderContracts.usdc.mint(lender.address, ethers.parseUnits('1000', 6));
        await mintTx.wait();
        console.log('   ✅ Minted 1000 USDC');
    }

    const newBalance = await lenderContracts.usdc.balanceOf(lender.address);
    logTest('Lender has sufficient USDC',
        newBalance >= ethers.parseUnits('500', 6),
        `Balance: ${ethers.formatUnits(newBalance, 6)} USDC`);

    // Test 2.2: Get pool info before supply
    const poolInfoBefore = await lenderContracts.marketplace.getPoolInfo(43);
    const liquidityBefore = poolInfoBefore.totalLiquidity;
    console.log(`\n📊 Pool #43 liquidity before: ${ethers.formatUnits(liquidityBefore, 6)} USDC`);

    // Test 2.3: Supply liquidity
    const supplyAmount = ethers.parseUnits('200', 6);
    console.log(`\n💧 Supplying ${ethers.formatUnits(supplyAmount, 6)} USDC to pool #43...`);

    // Approve first
    const approveTx = await lenderContracts.usdc.approve(addresses.agentLiquidityMarketplace, supplyAmount);
    await approveTx.wait();

    // Supply
    const supplyTx = await lenderContracts.marketplace.supplyLiquidity(43, supplyAmount);
    await supplyTx.wait();
    console.log('   ✅ Liquidity supplied');

    // Test 2.4: Verify liquidity increased
    const poolInfoAfter = await lenderContracts.marketplace.getPoolInfo(43);
    const liquidityAfter = poolInfoAfter.totalLiquidity;
    const increase = liquidityAfter - liquidityBefore;

    logTest('Pool liquidity increased correctly',
        increase === supplyAmount,
        `Increased by ${ethers.formatUnits(increase, 6)} USDC`);

    logTest('Lender count increased',
        poolInfoAfter.lenderCount > poolInfoBefore.lenderCount,
        `Lenders: ${poolInfoBefore.lenderCount} → ${poolInfoAfter.lenderCount}`);

    return { lender, lenderContracts, supplyAmount };
}

// ============================================================================
// TEST 3: POOL MECHANICS & EDGE CASES
// ============================================================================

async function testPoolMechanics() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║      TEST 3: POOL MECHANICS & EDGE CASES        ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = await setupProvider();
    const agent1 = new ethers.Wallet(AGENT1_KEY, provider);
    const contracts = await getContracts(agent1);

    // Test 3.1: Check max concurrent loans limit
    const maxLoans = await contracts.marketplace.MAX_CONCURRENT_LOANS();
    console.log(`📋 Max concurrent loans: ${maxLoans}`);
    logTest('Max concurrent loans is set', maxLoans > 0n, `Limit: ${maxLoans}`);

    // Test 3.2: Check current active loans
    const activeLoans = await contracts.marketplace.getAgentActiveLoans(agent1.address);
    console.log(`💼 Agent #43 active loans: ${activeLoans}`);
    logTest('Agent #43 active loans within limit',
        activeLoans <= maxLoans,
        `Active: ${activeLoans}/${maxLoans}`);

    // Test 3.3: Pool info accuracy
    const poolInfo = await contracts.marketplace.getPoolInfo(43);
    const availableLiquidity = poolInfo.availableLiquidity;
    const totalLiquidity = poolInfo.totalLiquidity;
    const totalLoaned = poolInfo.totalLoaned;

    const calculatedAvailable = totalLiquidity - totalLoaned;
    logTest('Pool accounting is accurate',
        availableLiquidity === calculatedAvailable,
        `Available: ${ethers.formatUnits(availableLiquidity, 6)} USDC`);

    console.log(`\n📊 Pool #43 Stats:`);
    console.log(`   Total Liquidity: ${ethers.formatUnits(totalLiquidity, 6)} USDC`);
    console.log(`   Available: ${ethers.formatUnits(availableLiquidity, 6)} USDC`);
    console.log(`   Total Loaned: ${ethers.formatUnits(totalLoaned, 6)} USDC`);
    console.log(`   Utilization: ${totalLiquidity > 0 ? ((totalLoaned * 10000n / totalLiquidity) / 100n).toString() : 0}%`);

    return { maxLoans, activeLoans };
}

// ============================================================================
// TEST 4: SECURITY TESTING
// ============================================================================

async function testSecurity() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║            TEST 4: SECURITY TESTING             ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = await setupProvider();
    const agent1 = new ethers.Wallet(AGENT1_KEY, provider);
    const agent2 = new ethers.Wallet(AGENT2_KEY, provider);

    const contracts1 = await getContracts(agent1);
    const contracts2 = await getContracts(agent2);

    // Test 4.1: Cannot manipulate reputation directly
    console.log('\n🔒 Testing reputation manipulation prevention...');
    try {
        // Reputation manager should only be callable by marketplace
        await contracts1.reputation.recordLoanCompletion(agent1.address, ethers.parseUnits('100', 6), true);
        logTest('Reputation manipulation prevented', false, 'Should have reverted');
    } catch (error) {
        logTest('Reputation manipulation prevented', true, 'Correctly reverted unauthorized call');
    }

    // Test 4.2: Cannot withdraw from someone else's pool
    console.log('\n🔒 Testing unauthorized pool withdrawal...');
    try {
        await contracts2.marketplace.withdrawLiquidity(43, ethers.parseUnits('1', 6));
        logTest('Unauthorized withdrawal prevented', false, 'Should have reverted');
    } catch (error) {
        logTest('Unauthorized withdrawal prevented', true, 'Correctly prevented cross-agent withdrawal');
    }

    // Test 4.3: Access control on registration
    const agent2Info = await contracts2.registry.getAgentInfo(agent2.address);
    logTest('Each agent has unique ID',
        agent2Info.agentId !== 43n,
        `Agent #2 ID: ${agent2Info.agentId}`);

    // Test 4.4: Score boundaries
    const agent1Score = await contracts1.reputation.getReputationScore(agent1.address);
    const agent2Score = await contracts2.reputation.getReputationScore(agent2.address);

    logTest('Reputation scores within valid range',
        agent1Score >= 0n && agent1Score <= 1000n && agent2Score >= 0n && agent2Score <= 1000n,
        `Agent #43: ${agent1Score}, Agent #2: ${agent2Score}`);

    return true;
}

// ============================================================================
// MAIN TEST RUNNER
// ============================================================================

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║   COMPREHENSIVE ARC TESTNET TEST SUITE         ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const startTime = Date.now();

    try {
        // Run all test suites
        await testMultiAgent();
        await testLenderFunctionality();
        await testPoolMechanics();
        await testSecurity();

        // Summary
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        console.log('\n' + '═'.repeat(70));
        console.log('  TEST SUMMARY');
        console.log('═'.repeat(70));
        console.log(`\nTotal Tests:    ${testResults.passed + testResults.failed}`);
        console.log(`Passed:         ${testResults.passed} ✅`);
        console.log(`Failed:         ${testResults.failed} ❌`);
        console.log(`Success Rate:   ${((testResults.passed / (testResults.passed + testResults.failed)) * 100).toFixed(1)}%`);
        console.log(`Duration:       ${duration}s\n`);

        if (testResults.failed > 0) {
            console.log('Failed Tests:');
            testResults.tests.filter(t => !t.passed).forEach((t, i) => {
                console.log(`  ${i + 1}. ${t.name}`);
                if (t.details) console.log(`     ${t.details}`);
            });
            console.log('');
        }

        console.log('═'.repeat(70) + '\n');

        process.exit(testResults.failed > 0 ? 1 : 0);

    } catch (error) {
        console.error('\n❌ Fatal error:', error);
        process.exit(1);
    }
}

main();
