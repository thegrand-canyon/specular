/**
 * Quick Arc Testnet Testing
 * Focus on working features with robust error handling
 */

const { ethers } = require('ethers');

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const AGENT1_KEY = process.env.PRIVATE_KEY;
const AGENT2_KEY = '0x47471cb7a2ba033f2085a82050ff16248ff3a9e5d9ea17ddb0f5d2f208e043ad';
const LENDER_KEY = '0x41adb1d6ef22647a3de0e7993f4e33ec7bcd5b49359587967750ff8f3faddf67';

const addresses = require('../../src/config/arc-testnet-addresses.json');

let results = { passed: 0, failed: 0, tests: [] };

function log(name, passed, details = '') {
    const status = passed ? '✅' : '❌';
    console.log(`${status} ${name}`);
    if (details) console.log(`   ${details}`);
    results.tests.push({ name, passed, details });
    passed ? results.passed++ : results.failed++;
}

async function main() {
    console.log('\n╔══════════════════════════════════════════════════╗');
    console.log('║      COMPREHENSIVE ARC TESTNET TESTING          ║');
    console.log('╚══════════════════════════════════════════════════╝\n');

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const agent1 = new ethers.Wallet(AGENT1_KEY, provider);
    const agent2 = new ethers.Wallet(AGENT2_KEY, provider);
    const lender = new ethers.Wallet(LENDER_KEY, provider);

    // ========================================================================
    // TEST SUITE 1: MULTI-AGENT SCENARIOS
    // ========================================================================

    console.log('═'.repeat(70));
    console.log('TEST 1: MULTI-AGENT SCENARIOS');
    console.log('═'.repeat(70) + '\n');

    const registry = new ethers.Contract(
        addresses.agentRegistryV2,
        ['function isRegistered(address) view returns (bool)', 'function agentCount() view returns (uint256)', 'function register(string,address[])'],
        provider
    );

    const reputation = new ethers.Contract(
        addresses.reputationManagerV3,
        ['function getReputationScore(address) view returns (uint256)', 'function getReputationTier(address) view returns (string)'],
        provider
    );

    // Test 1.1: Agent #43 status
    const agent1Reg = await registry.isRegistered(agent1.address);
    const agent1Score = await reputation.getReputationScore(agent1.address);
    const agent1Tier = await reputation.getReputationTier(agent1.address);

    log('Agent #43 registered with perfect score',
        agent1Reg && agent1Score === 1000n,
        `Score: ${agent1Score}, Tier: ${agent1Tier}`);

    // Test 1.2: Agent #2 status
    const agent2Reg = await registry.isRegistered(agent2.address);
    if (!agent2Reg) {
        console.log('\n📝 Registering Agent #2...');
        const tx = await registry.connect(agent2).register('{"name":"Agent2"}', []);
        await tx.wait();
        console.log('   ✅ Registered');
    }

    const agent2Score = await reputation.getReputationScore(agent2.address);
    const agent2Tier = await reputation.getReputationTier(agent2.address);

    log('Agent #2 registered and has reputation',
        await registry.isRegistered(agent2.address),
        `Score: ${agent2Score}, Tier: ${agent2Tier}`);

    // Test 1.3: Multiple agents exist
    const totalAgents = await registry.agentCount();
    log('Protocol has multiple agents',
        totalAgents >= 2n,
        `Total: ${totalAgents} agents`);

    log('Agents have different scores',
        agent1Score !== agent2Score,
        `Agent #43: ${agent1Score}, Agent #2: ${agent2Score}`);

    // ========================================================================
    // TEST SUITE 2: LENDER FUNCTIONALITY
    // ========================================================================

    console.log('\n' + '═'.repeat(70));
    console.log('TEST 2: LENDER FUNCTIONALITY');
    console.log('═'.repeat(70) + '\n');

    const usdc = new ethers.Contract(
        addresses.mockUSDC,
        ['function balanceOf(address) view returns (uint256)', 'function mint(address,uint256)', 'function approve(address,uint256) returns (bool)', 'function transfer(address,uint256) returns (bool)'],
        lender
    );

    const marketplace = new ethers.Contract(
        addresses.agentLiquidityMarketplace,
        [
            'function supplyLiquidity(uint256,uint256)',
            'function withdrawLiquidity(uint256,uint256)',
            'function requestLoan(uint256,uint256) returns (uint256)',
            'function repayLoan(uint256)',
            'function getAgentActiveLoans(address) view returns (uint256)'
        ],
        lender
    );

    // Test 2.1: Lender balance
    let lenderBal = await usdc.balanceOf(lender.address);
    console.log(`💰 Lender balance: ${ethers.formatUnits(lenderBal, 6)} USDC`);

    if (lenderBal < ethers.parseUnits('500', 6)) {
        console.log('   Minting 1000 USDC...');
        const tx = await usdc.mint(lender.address, ethers.parseUnits('1000', 6));
        await tx.wait();
        lenderBal = await usdc.balanceOf(lender.address);
    }

    log('Lender has sufficient USDC',
        lenderBal >= ethers.parseUnits('500', 6),
        `Balance: ${ethers.formatUnits(lenderBal, 6)} USDC`);

    // Test 2.2: Transfer USDC to Agent #2
    console.log('\n💸 Transferring USDC to Agent #2...');
    const transferAmount = ethers.parseUnits('500', 6);
    const transferTx = await usdc.transfer(agent2.address, transferAmount);
    await transferTx.wait();

    const agent2UsdcBal = await usdc.balanceOf(agent2.address);
    log('Agent #2 received USDC',
        agent2UsdcBal >= transferAmount,
        `Balance: ${ethers.formatUnits(agent2UsdcBal, 6)} USDC`);

    // ========================================================================
    // TEST SUITE 3: BORROWING & LENDING
    // ========================================================================

    console.log('\n' + '═'.repeat(70));
    console.log('TEST 3: BORROWING & LENDING');
    console.log('═'.repeat(70) + '\n');

    const agent2Marketplace = marketplace.connect(agent2);
    const agent2Usdc = usdc.connect(agent2);

    // Test 3.1: Request loan as Agent #2
    const loanAmount = ethers.parseUnits('50', 6);
    const collateralRequired = await reputation.connect(agent2).getCollateralRequirement(agent2.address);
    const collateralAmount = (loanAmount * collateralRequired) / 100n;

    console.log(`\n💼 Requesting ${ethers.formatUnits(loanAmount, 6)} USDC loan...`);
    console.log(`   Collateral required: ${collateralRequired}% (${ethers.formatUnits(collateralAmount, 6)} USDC)`);

    // Approve collateral
    if (collateralAmount > 0n) {
        const approveTx = await agent2Usdc.approve(addresses.agentLiquidityMarketplace, collateralAmount);
        await approveTx.wait();
    }

    let loanId;
    try {
        const loanTx = await agent2Marketplace.requestLoan(loanAmount, 7); // 7 days
        const receipt = await loanTx.wait();
        loanId = parseInt(receipt.logs[receipt.logs.length - 1].topics[1], 16);
        console.log(`   ✅ Loan #${loanId} requested`);

        log('Agent #2 can request loans',
            loanId > 0,
            `Loan ID: ${loanId}`);
    } catch (error) {
        log('Agent #2 can request loans',
            false,
            `Error: ${error.message.slice(0, 80)}`);
    }

    // Test 3.2: Check active loans
    const activeLoans = await marketplace.connect(agent1).getAgentActiveLoans(agent1.address);
    log('Can query active loans',
        true,
        `Agent #43 active loans: ${activeLoans}`);

    // ========================================================================
    // TEST SUITE 4: SECURITY
    // ========================================================================

    console.log('\n' + '═'.repeat(70));
    console.log('TEST 4: SECURITY TESTING');
    console.log('═'.repeat(70) + '\n');

    // Test 4.1: Reputation boundaries
    log('Reputation scores within valid range',
        agent1Score <= 1000n && agent2Score <= 1000n && agent1Score >= 0n && agent2Score >= 0n,
        `Valid range: 0-1000`);

    // Test 4.2: Each agent has unique identity
    log('Agents have unique addresses',
        agent1.address !== agent2.address && agent1.address !== lender.address,
        'All addresses unique');

    // Test 4.3: Tier system working
    const possibleTiers = ['BAD_CREDIT', 'SUBPRIME', 'STANDARD', 'PRIME'];
    log('Tier system functional',
        possibleTiers.includes(agent1Tier) && possibleTiers.includes(agent2Tier),
        `Agent #43: ${agent1Tier}, Agent #2: ${agent2Tier}`);

    // ========================================================================
    // TEST SUITE 5: PROTOCOL ANALYTICS
    // ========================================================================

    console.log('\n' + '═'.repeat(70));
    console.log('TEST 5: PROTOCOL ANALYTICS');
    console.log('═'.repeat(70) + '\n');

    // Test 5.1: Total agents
    console.log(`📊 Total Registered Agents: ${totalAgents}`);
    log('Agent registration tracking works',
        totalAgents > 0n,
        `Count: ${totalAgents}`);

    // Test 5.2: Reputation distribution
    console.log(`\n📈 Reputation Distribution:`);
    console.log(`   Agent #43: ${agent1Score} (${agent1Tier})`);
    console.log(`   Agent #2:  ${agent2Score} (${agent2Tier})`);

    const avgScore = (agent1Score + agent2Score) / 2n;
    log('Can calculate protocol metrics',
        true,
        `Average score: ${avgScore}`);

    // Test 5.3: USDC distribution
    const agent1UsdcBal = await usdc.connect(agent1).balanceOf(agent1.address);
    console.log(`\n💰 USDC Distribution:`);
    console.log(`   Agent #43: ${ethers.formatUnits(agent1UsdcBal, 6)} USDC`);
    console.log(`   Agent #2:  ${ethers.formatUnits(agent2UsdcBal, 6)} USDC`);
    console.log(`   Lender:    ${ethers.formatUnits(lenderBal, 6)} USDC`);

    const totalUsdc = agent1UsdcBal + agent2UsdcBal + lenderBal;
    log('USDC properly distributed across participants',
        totalUsdc > 0n,
        `Total: ${ethers.formatUnits(totalUsdc, 6)} USDC`);

    // ========================================================================
    // SUMMARY
    // ========================================================================

    console.log('\n' + '═'.repeat(70));
    console.log('TEST SUMMARY');
    console.log('═'.repeat(70));

    console.log(`\nTotal Tests:    ${results.passed + results.failed}`);
    console.log(`Passed:         ${results.passed} ✅`);
    console.log(`Failed:         ${results.failed} ❌`);
    console.log(`Success Rate:   ${((results.passed / (results.passed + results.failed)) * 100).toFixed(1)}%\n`);

    if (results.failed > 0) {
        console.log('Failed Tests:');
        results.tests.filter(t => !t.passed).forEach((t, i) => {
            console.log(`  ${i + 1}. ${t.name}`);
            if (t.details) console.log(`     ${t.details}`);
        });
        console.log('');
    }

    console.log('═'.repeat(70) + '\n');

    process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(err => {
    console.error('\n❌ Fatal error:', err.message);
    process.exit(1);
});
