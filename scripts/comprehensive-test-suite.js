/**
 * Comprehensive Test Suite for Specular Protocol
 * Runs extensive tests across all networks
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Network configurations
const NETWORKS = {
  arc: {
    name: 'Arc Testnet',
    chainId: 5042002,
    rpcUrl: process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
    configPath: '../src/config/arc-testnet-addresses.json',
    apiUrl: 'https://specular-production.up.railway.app',
  },
  base: {
    name: 'Base Mainnet',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    configPath: '../src/config/base-addresses.json',
    apiUrl: 'https://specular-production.up.railway.app',
  }
};

// Load ABIs
const AgentRegistryV2 = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')
));
const ReputationManagerV3 = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json')
));
const AgentLiquidityMarketplace = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')
));
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function name() view returns (string)',
  'function symbol() view returns (string)'
];

// Test results storage
const testResults = {
  arc: { passed: 0, failed: 0, total: 0, categories: {} },
  base: { passed: 0, failed: 0, total: 0, categories: {} }
};

// Helper to record test result
function recordTest(network, category, testName, passed, details = '', duration = 0) {
  if (!testResults[network].categories[category]) {
    testResults[network].categories[category] = { passed: 0, failed: 0, tests: [] };
  }

  const result = { testName, passed, details, duration, timestamp: new Date().toISOString() };
  testResults[network].categories[category].tests.push(result);
  testResults[network].total++;

  if (passed) {
    testResults[network].passed++;
    testResults[network].categories[category].passed++;
    console.log(`  ✅ ${testName} ${duration ? `(${duration}ms)` : ''}`);
  } else {
    testResults[network].failed++;
    testResults[network].categories[category].failed++;
    console.log(`  ❌ ${testName}`);
  }

  if (details) {
    console.log(`     ${details}`);
  }
}

class ComprehensiveTester {
  constructor(network, config, provider) {
    this.network = network;
    this.config = config;
    this.provider = provider;
    this.apiUrl = NETWORKS[network].apiUrl;

    this.registry = new ethers.Contract(config.agentRegistryV2, AgentRegistryV2.abi, provider);
    this.reputation = new ethers.Contract(config.reputationManagerV3, ReputationManagerV3.abi, provider);
    this.marketplace = new ethers.Contract(config.agentLiquidityMarketplace, AgentLiquidityMarketplace.abi, provider);
    this.usdc = new ethers.Contract(config.usdc, ERC20_ABI, provider);
  }

  async runAllTests() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  COMPREHENSIVE TEST SUITE - ${NETWORKS[this.network].name}`);
    console.log(`${'='.repeat(60)}\n`);

    await this.testContractDeployment();
    await this.testContractState();
    await this.testRegistryFunctions();
    await this.testReputationSystem();
    await this.testMarketplaceFunctions();
    await this.testAPIEndpoints();
    await this.testDataConsistency();
    await this.testEdgeCases();
    await this.testPerformance();
    await this.testERC20Token();
  }

  async testContractDeployment() {
    console.log('\n📦 1. CONTRACT DEPLOYMENT TESTS\n');
    const category = 'Contract Deployment';

    try {
      const start = Date.now();
      const [registryCode, reputationCode, marketplaceCode] = await Promise.all([
        this.provider.getCode(this.config.agentRegistryV2),
        this.provider.getCode(this.config.reputationManagerV3),
        this.provider.getCode(this.config.agentLiquidityMarketplace)
      ]);
      const duration = Date.now() - start;

      recordTest(this.network, category, 'Registry Contract Deployed',
        registryCode !== '0x', `Address: ${this.config.agentRegistryV2}`, duration);

      recordTest(this.network, category, 'ReputationManager Contract Deployed',
        reputationCode !== '0x', `Address: ${this.config.reputationManagerV3}`, duration);

      recordTest(this.network, category, 'Marketplace Contract Deployed',
        marketplaceCode !== '0x', `Address: ${this.config.agentLiquidityMarketplace}`, duration);

      const registrySize = (registryCode.length - 2) / 2;
      const reputationSize = (reputationCode.length - 2) / 2;
      const marketplaceSize = (marketplaceCode.length - 2) / 2;

      recordTest(this.network, category, 'Contract Bytecode Size Check',
        registrySize > 0 && reputationSize > 0 && marketplaceSize > 0,
        `Registry: ${registrySize} bytes, Reputation: ${reputationSize} bytes, Marketplace: ${marketplaceSize} bytes`);

    } catch (error) {
      recordTest(this.network, category, 'Contract Deployment Check', false, error.message);
    }
  }

  async testContractState() {
    console.log('\n🔍 2. CONTRACT STATE TESTS\n');
    const category = 'Contract State';

    try {
      // Test ownership
      const start1 = Date.now();
      const [regOwner, repOwner, mktOwner] = await Promise.all([
        this.registry.owner(),
        this.reputation.owner(),
        this.marketplace.owner()
      ]);
      const duration1 = Date.now() - start1;

      recordTest(this.network, category, 'Ownership Consistency',
        regOwner === repOwner && repOwner === mktOwner,
        `Owner: ${regOwner}`, duration1);

      // Test pause state
      const start2 = Date.now();
      const isPaused = await this.marketplace.paused();
      const duration2 = Date.now() - start2;

      recordTest(this.network, category, 'Marketplace Not Paused',
        !isPaused, 'Marketplace is operational', duration2);

      // Test authorization
      const start3 = Date.now();
      const isAuthorized = await this.reputation.authorizedPools(this.config.agentLiquidityMarketplace);
      const duration3 = Date.now() - start3;

      recordTest(this.network, category, 'Marketplace Authorization',
        isAuthorized, 'Marketplace can update reputation', duration3);

      // Test platform fee
      const start4 = Date.now();
      const feeRate = await this.marketplace.platformFeeRate();
      const duration4 = Date.now() - start4;

      recordTest(this.network, category, 'Platform Fee Rate Valid',
        feeRate >= 0n && feeRate <= 2000n,
        `Fee: ${Number(feeRate) / 100}%`, duration4);

    } catch (error) {
      recordTest(this.network, category, 'Contract State Check', false, error.message);
    }
  }

  async testRegistryFunctions() {
    console.log('\n📋 3. REGISTRY FUNCTION TESTS\n');
    const category = 'Registry Functions';

    try {
      // Test total agents
      const start1 = Date.now();
      const totalAgents = await this.registry.totalAgents();
      const duration1 = Date.now() - start1;

      recordTest(this.network, category, 'Read Total Agents',
        totalAgents >= 0n, `Total: ${totalAgents}`, duration1);

      // Test agent retrieval if agents exist
      if (totalAgents > 0n) {
        const start2 = Date.now();
        const agent1 = await this.registry.getAgentInfoById(1);
        const duration2 = Date.now() - start2;

        recordTest(this.network, category, 'Get Agent By ID',
          agent1.owner !== ethers.ZeroAddress,
          `Agent 1 owner: ${agent1.owner}`, duration2);

        // Test address to agent ID mapping
        const start3 = Date.now();
        const agentId = await this.registry.addressToAgentId(agent1.owner);
        const duration3 = Date.now() - start3;

        recordTest(this.network, category, 'Address to Agent ID Mapping',
          agentId > 0n, `Owner ${agent1.owner} -> Agent ${agentId}`, duration3);

        // Test agent active status
        const start4 = Date.now();
        const isActive = await this.registry.isAgentActive(1);
        const duration4 = Date.now() - start4;

        recordTest(this.network, category, 'Agent Active Status Check',
          typeof isActive === 'boolean', `Agent 1 active: ${isActive}`, duration4);
      }

      // Test name and symbol
      const start5 = Date.now();
      const [name, symbol] = await Promise.all([
        this.registry.name(),
        this.registry.symbol()
      ]);
      const duration5 = Date.now() - start5;

      recordTest(this.network, category, 'Registry Token Metadata',
        name.length > 0 && symbol.length > 0,
        `Name: ${name}, Symbol: ${symbol}`, duration5);

    } catch (error) {
      recordTest(this.network, category, 'Registry Functions Check', false, error.message);
    }
  }

  async testReputationSystem() {
    console.log('\n⭐ 4. REPUTATION SYSTEM TESTS\n');
    const category = 'Reputation System';

    try {
      const totalAgents = await this.registry.totalAgents();

      if (totalAgents > 0n) {
        // Test reputation score retrieval
        const start1 = Date.now();
        const score = await this.reputation['getReputationScore(uint256)'](1n);
        const duration1 = Date.now() - start1;

        recordTest(this.network, category, 'Get Reputation Score',
          score >= 0n, `Agent 1 score: ${score}`, duration1);

        // Test reputation score by address
        const agent1 = await this.registry.getAgentInfoById(1);
        const start2 = Date.now();
        const scoreByAddr = await this.reputation['getReputationScore(address)'](agent1.owner);
        const duration2 = Date.now() - start2;

        recordTest(this.network, category, 'Get Reputation Score by Address',
          scoreByAddr === score, `Score matches: ${scoreByAddr}`, duration2);

        // Test authorization check
        const start3 = Date.now();
        const isAuthorized = await this.reputation.authorizedPools(this.config.agentLiquidityMarketplace);
        const duration3 = Date.now() - start3;

        recordTest(this.network, category, 'Pool Authorization Check',
          isAuthorized, 'Marketplace is authorized pool', duration3);

        // Test unauthorized address
        const start4 = Date.now();
        const notAuthorized = await this.reputation.authorizedPools(ethers.ZeroAddress);
        const duration4 = Date.now() - start4;

        recordTest(this.network, category, 'Unauthorized Address Rejected',
          !notAuthorized, 'Zero address not authorized', duration4);
      }

    } catch (error) {
      recordTest(this.network, category, 'Reputation System Check', false, error.message);
    }
  }

  async testMarketplaceFunctions() {
    console.log('\n💰 5. MARKETPLACE FUNCTION TESTS\n');
    const category = 'Marketplace Functions';

    try {
      // Test total pools
      const start1 = Date.now();
      const totalPools = await this.marketplace.totalPools();
      const duration1 = Date.now() - start1;

      recordTest(this.network, category, 'Read Total Pools',
        totalPools >= 0n, `Total: ${totalPools}`, duration1);

      // Test pool retrieval if pools exist
      if (totalPools > 0n) {
        // Find an agent with a pool
        let poolFound = false;
        for (let agentId = 1; agentId <= 10 && !poolFound; agentId++) {
          try {
            const start2 = Date.now();
            const pool = await this.marketplace.getAgentPool(agentId);
            const duration2 = Date.now() - start2;

            if (pool[1] > 0n || pool[2] > 0n) { // has supply or borrowed
              poolFound = true;
              recordTest(this.network, category, 'Get Agent Pool',
                true,
                `Agent ${agentId}: Supplied ${ethers.formatUnits(pool[1], 6)} USDC, Borrowed ${ethers.formatUnits(pool[2], 6)} USDC`,
                duration2);
            }
          } catch (e) {
            // Skip agents without pools
          }
        }
      }

      // Test constants
      const start3 = Date.now();
      const [maxInterest, minDuration, maxDuration, maxLoans, maxLenders] = await Promise.all([
        this.marketplace.MAX_INTEREST_RATE(),
        this.marketplace.MIN_LOAN_DURATION(),
        this.marketplace.MAX_LOAN_DURATION(),
        this.marketplace.MAX_ACTIVE_LOANS_PER_AGENT(),
        this.marketplace.MAX_LENDERS_PER_POOL()
      ]);
      const duration3 = Date.now() - start3;

      recordTest(this.network, category, 'Marketplace Constants Valid',
        maxInterest > 0n && minDuration > 0n && maxDuration > minDuration,
        `Max Interest: ${maxInterest / 100n}%, Duration: ${minDuration}s-${maxDuration}s, Max Loans: ${maxLoans}, Max Lenders: ${maxLenders}`,
        duration3);

      // Test contract references
      const start4 = Date.now();
      const [registryAddr, reputationAddr, usdcAddr] = await Promise.all([
        this.marketplace.agentRegistry(),
        this.marketplace.reputationManager(),
        this.marketplace.usdcToken()
      ]);
      const duration4 = Date.now() - start4;

      recordTest(this.network, category, 'Contract References Correct',
        registryAddr === this.config.agentRegistryV2 &&
        reputationAddr === this.config.reputationManagerV3 &&
        usdcAddr === this.config.usdc,
        'All contract addresses match config', duration4);

    } catch (error) {
      recordTest(this.network, category, 'Marketplace Functions Check', false, error.message);
    }
  }

  async testAPIEndpoints() {
    console.log('\n🌐 6. API ENDPOINT TESTS\n');
    const category = 'API Endpoints';

    try {
      // Test status endpoint
      const start1 = Date.now();
      const statusResp = await fetch(`${this.apiUrl}/status?network=${this.network}`);
      const statusData = await statusResp.json();
      const duration1 = Date.now() - start1;

      recordTest(this.network, category, 'Status Endpoint',
        statusResp.ok && statusData.network === this.network,
        `TVL: ${statusData.tvl}, Pools: ${statusData.totalPools}`, duration1);

      // Test agents endpoint
      const start2 = Date.now();
      const agentsResp = await fetch(`${this.apiUrl}/agents?network=${this.network}`);
      const agentsData = await agentsResp.json();
      const duration2 = Date.now() - start2;

      recordTest(this.network, category, 'Agents Endpoint',
        agentsResp.ok && Array.isArray(agentsData.agents),
        `Total agents: ${agentsData.totalAgents}`, duration2);

      // Test pools endpoint
      const start3 = Date.now();
      const poolsResp = await fetch(`${this.apiUrl}/pools?network=${this.network}`);
      const poolsData = await poolsResp.json();
      const duration3 = Date.now() - start3;

      recordTest(this.network, category, 'Pools Endpoint',
        poolsResp.ok && Array.isArray(poolsData.pools),
        `Total pools: ${poolsData.totalPools}`, duration3);

      // Test API response time
      recordTest(this.network, category, 'API Response Time Acceptable',
        duration1 < 10000 && duration2 < 10000 && duration3 < 10000,
        `Average: ${Math.round((duration1 + duration2 + duration3) / 3)}ms`);

    } catch (error) {
      recordTest(this.network, category, 'API Endpoints Check', false, error.message);
    }
  }

  async testDataConsistency() {
    console.log('\n🔄 7. DATA CONSISTENCY TESTS\n');
    const category = 'Data Consistency';

    try {
      // Compare on-chain vs API data
      const start1 = Date.now();
      const [onChainTotal, apiData] = await Promise.all([
        this.registry.totalAgents(),
        fetch(`${this.apiUrl}/agents?network=${this.network}`).then(r => r.json())
      ]);
      const duration1 = Date.now() - start1;

      recordTest(this.network, category, 'Agent Count Consistency',
        Number(onChainTotal) === apiData.totalAgents,
        `On-chain: ${onChainTotal}, API: ${apiData.totalAgents}`, duration1);

      // Compare pool counts
      const start2 = Date.now();
      const [onChainPools, poolsData] = await Promise.all([
        this.marketplace.totalPools(),
        fetch(`${this.apiUrl}/pools?network=${this.network}`).then(r => r.json())
      ]);
      const duration2 = Date.now() - start2;

      recordTest(this.network, category, 'Pool Count Consistency',
        Number(onChainPools) === poolsData.totalPools,
        `On-chain: ${onChainPools}, API: ${poolsData.totalPools}`, duration2);

      // Test network ID consistency
      const start3 = Date.now();
      const chainId = await this.provider.getNetwork().then(n => n.chainId);
      const duration3 = Date.now() - start3;

      recordTest(this.network, category, 'Chain ID Consistency',
        Number(chainId) === NETWORKS[this.network].chainId,
        `Expected: ${NETWORKS[this.network].chainId}, Got: ${chainId}`, duration3);

    } catch (error) {
      recordTest(this.network, category, 'Data Consistency Check', false, error.message);
    }
  }

  async testEdgeCases() {
    console.log('\n🎯 8. EDGE CASE TESTS\n');
    const category = 'Edge Cases';

    try {
      // Test non-existent agent
      const start1 = Date.now();
      try {
        const totalAgents = await this.registry.totalAgents();
        const nonExistentAgent = await this.registry.getAgentInfoById(Number(totalAgents) + 100);
        const duration1 = Date.now() - start1;

        // If we get here, check if owner is zero address (expected for non-existent)
        recordTest(this.network, category, 'Non-Existent Agent Returns Zero',
          nonExistentAgent.owner === ethers.ZeroAddress,
          'Non-existent agent returns zero address', duration1);
      } catch (e) {
        const duration1 = Date.now() - start1;
        // Either reverts or returns zero - both acceptable
        recordTest(this.network, category, 'Non-Existent Agent Handled',
          true, 'Contract handles non-existent agent correctly', duration1);
      }

      // Test zero address lookup
      const start2 = Date.now();
      const zeroAgentId = await this.registry.addressToAgentId(ethers.ZeroAddress);
      const duration2 = Date.now() - start2;

      recordTest(this.network, category, 'Zero Address Not Registered',
        zeroAgentId === 0n, 'Zero address has no agent ID', duration2);

      // Test reputation score for non-existent agent
      const start3 = Date.now();
      const totalAgents = await this.registry.totalAgents();
      const nonExistentScore = await this.reputation['getReputationScore(uint256)'](Number(totalAgents) + 100);
      const duration3 = Date.now() - start3;

      recordTest(this.network, category, 'Non-Existent Agent Has Zero Reputation',
        nonExistentScore === 0n, 'Non-registered agents have 0 reputation', duration3);

    } catch (error) {
      recordTest(this.network, category, 'Edge Cases Check', false, error.message);
    }
  }

  async testPerformance() {
    console.log('\n⚡ 9. PERFORMANCE TESTS\n');
    const category = 'Performance';

    try {
      // Test multiple reads in parallel
      const start1 = Date.now();
      await Promise.all([
        this.registry.totalAgents(),
        this.marketplace.totalPools(),
        this.marketplace.platformFeeRate(),
        this.usdc.balanceOf(this.config.agentLiquidityMarketplace),
        this.provider.getBlockNumber()
      ]);
      const duration1 = Date.now() - start1;

      recordTest(this.network, category, 'Parallel Read Performance',
        duration1 < 5000, `5 parallel reads: ${duration1}ms`, duration1);

      // Test sequential reads
      const start2 = Date.now();
      await this.registry.totalAgents();
      await this.marketplace.totalPools();
      await this.marketplace.platformFeeRate();
      const duration2 = Date.now() - start2;

      recordTest(this.network, category, 'Sequential Read Performance',
        duration2 < 3000, `3 sequential reads: ${duration2}ms`, duration2);

      // Test RPC latency
      const start3 = Date.now();
      await this.provider.getBlockNumber();
      const duration3 = Date.now() - start3;

      recordTest(this.network, category, 'RPC Latency',
        duration3 < 1000, `Block number fetch: ${duration3}ms`, duration3);

    } catch (error) {
      recordTest(this.network, category, 'Performance Tests', false, error.message);
    }
  }

  async testERC20Token() {
    console.log('\n💵 10. ERC20 TOKEN TESTS\n');
    const category = 'ERC20 Token';

    try {
      // Test USDC metadata
      const start1 = Date.now();
      const [name, symbol, decimals] = await Promise.all([
        this.usdc.name(),
        this.usdc.symbol(),
        this.usdc.decimals()
      ]);
      const duration1 = Date.now() - start1;

      recordTest(this.network, category, 'USDC Token Metadata',
        name.includes('USD') && symbol === 'USDC' && decimals === 6,
        `${name} (${symbol}), ${decimals} decimals`, duration1);

      // Test marketplace USDC balance
      const start2 = Date.now();
      const balance = await this.usdc.balanceOf(this.config.agentLiquidityMarketplace);
      const duration2 = Date.now() - start2;

      recordTest(this.network, category, 'Marketplace USDC Balance',
        balance >= 0n, `Balance: ${ethers.formatUnits(balance, 6)} USDC`, duration2);

      // Test total supply
      const start3 = Date.now();
      const totalSupply = await this.usdc.totalSupply();
      const duration3 = Date.now() - start3;

      recordTest(this.network, category, 'USDC Total Supply',
        totalSupply > 0n, `Total Supply: ${ethers.formatUnits(totalSupply, 6)} USDC`, duration3);

    } catch (error) {
      recordTest(this.network, category, 'ERC20 Token Tests', false, error.message);
    }
  }
}

// Main test runner
async function runAllTests() {
  console.log('\n' + '='.repeat(80));
  console.log('  COMPREHENSIVE TEST SUITE');
  console.log('  Testing all functionality across both networks');
  console.log('='.repeat(80));
  console.log(`\nStart time: ${new Date().toISOString()}\n`);

  for (const [networkKey, networkConfig] of Object.entries(NETWORKS)) {
    console.log(`\n${'#'.repeat(80)}`);
    console.log(`#  ${networkConfig.name.toUpperCase()} (Chain ${networkConfig.chainId})`);
    console.log(`${'#'.repeat(80)}`);

    try {
      const configPath = path.join(__dirname, networkConfig.configPath);
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

      const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl, networkConfig.chainId, {
        batchMaxCount: 1
      });

      const tester = new ComprehensiveTester(networkKey, config, provider);
      await tester.runAllTests();

    } catch (error) {
      console.error(`\n❌ Error testing ${networkKey}:`, error.message);
      recordTest(networkKey, 'Setup', 'Network Configuration', false, error.message);
    }
  }

  // Print summary
  printSummary();
}

function printSummary() {
  console.log('\n' + '='.repeat(80));
  console.log('  TEST SUMMARY');
  console.log('='.repeat(80));

  let totalPassed = 0;
  let totalFailed = 0;
  let totalTests = 0;

  for (const [network, results] of Object.entries(testResults)) {
    console.log(`\n${NETWORKS[network].name}:`);
    console.log(`  ✅ Passed: ${results.passed}`);
    console.log(`  ❌ Failed: ${results.failed}`);
    console.log(`  📊 Total:  ${results.total}`);
    console.log(`  📈 Pass Rate: ${((results.passed / results.total) * 100).toFixed(1)}%`);

    console.log('\n  Category Breakdown:');
    for (const [category, categoryResults] of Object.entries(results.categories)) {
      const passRate = ((categoryResults.passed / categoryResults.tests.length) * 100).toFixed(0);
      console.log(`    ${category}: ${categoryResults.passed}/${categoryResults.tests.length} (${passRate}%)`);
    }

    totalPassed += results.passed;
    totalFailed += results.failed;
    totalTests += results.total;

    if (results.failed > 0) {
      console.log(`\n  Failed tests:`);
      for (const [category, categoryResults] of Object.entries(results.categories)) {
        const failed = categoryResults.tests.filter(t => !t.passed);
        if (failed.length > 0) {
          console.log(`    ${category}:`);
          failed.forEach(t => {
            console.log(`      ❌ ${t.testName}: ${t.details}`);
          });
        }
      }
    }
  }

  console.log('\n' + '-'.repeat(80));
  console.log(`\nOVERALL:`);
  console.log(`  ✅ Total Passed: ${totalPassed}`);
  console.log(`  ❌ Total Failed: ${totalFailed}`);
  console.log(`  📊 Total Tests:  ${totalTests}`);
  console.log(`  📈 Success Rate: ${((totalPassed / totalTests) * 100).toFixed(1)}%`);
  console.log(`\nEnd time: ${new Date().toISOString()}`);
  console.log('='.repeat(80) + '\n');

  // Save detailed results
  const reportPath = path.join(__dirname, '../comprehensive-test-results.json');
  fs.writeFileSync(reportPath, JSON.stringify(testResults, null, 2));
  console.log(`📄 Detailed results saved to: ${reportPath}\n`);

  // Exit with error code if any tests failed
  if (totalFailed > 0) {
    process.exit(1);
  }
}

// Run tests
runAllTests().catch(error => {
  console.error('\n❌ Fatal error:', error);
  process.exit(1);
});
