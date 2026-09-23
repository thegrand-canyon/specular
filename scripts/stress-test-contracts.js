/**
 * Stress Test Suite for Specular Protocol
 * Tests contract behavior under load and edge conditions
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const NETWORKS = {
  arc: {
    name: 'Arc Testnet',
    chainId: 5042002,
    rpcUrl: process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
    configPath: '../src/config/arc-testnet-addresses.json',
  },
  base: {
    name: 'Base Mainnet',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    configPath: '../src/config/base-addresses.json',
  }
};

const AgentRegistryV2 = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')
));
const ReputationManagerV3 = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json')
));
const AgentLiquidityMarketplace = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')
));

const results = { arc: [], base: [] };

function recordResult(network, test, passed, details) {
  results[network].push({ test, passed, details, timestamp: new Date().toISOString() });
  console.log(`  ${passed ? '✅' : '❌'} ${test}: ${details}`);
}

class StressTester {
  constructor(network, config, provider) {
    this.network = network;
    this.config = config;
    this.provider = provider;

    this.registry = new ethers.Contract(config.agentRegistryV2, AgentRegistryV2.abi, provider);
    this.reputation = new ethers.Contract(config.reputationManagerV3, ReputationManagerV3.abi, provider);
    this.marketplace = new ethers.Contract(config.agentLiquidityMarketplace, AgentLiquidityMarketplace.abi, provider);
  }

  async runStressTests() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  STRESS TESTS - ${NETWORKS[this.network].name}`);
    console.log(`${'='.repeat(60)}\n`);

    await this.testMassiveParallelReads();
    await this.testSequentialLoadTest();
    await this.testBoundaryConditions();
    await this.testLargeNumberQueries();
  }

  async testMassiveParallelReads() {
    console.log('\n🔥 1. MASSIVE PARALLEL READ TEST\n');

    try {
      const start = Date.now();
      const promises = [];

      // Create 50 parallel read requests
      for (let i = 0; i < 50; i++) {
        promises.push(this.registry.totalAgents());
        promises.push(this.marketplace.totalPools());
        promises.push(this.provider.getBlockNumber());
      }

      await Promise.all(promises);
      const duration = Date.now() - start;

      recordResult(
        this.network,
        '50 Parallel Reads',
        duration < 30000,
        `150 parallel requests completed in ${duration}ms (${Math.round(150000/duration)} req/sec)`
      );

    } catch (error) {
      recordResult(this.network, 'Massive Parallel Reads', false, error.message);
    }
  }

  async testSequentialLoadTest() {
    console.log('\n⚡ 2. SEQUENTIAL LOAD TEST\n');

    try {
      const start = Date.now();
      let successCount = 0;

      for (let i = 0; i < 100; i++) {
        await this.registry.totalAgents();
        successCount++;
      }

      const duration = Date.now() - start;

      recordResult(
        this.network,
        '100 Sequential Reads',
        successCount === 100,
        `${successCount}/100 successful in ${duration}ms (avg: ${Math.round(duration/100)}ms per read)`
      );

    } catch (error) {
      recordResult(this.network, 'Sequential Load Test', false, error.message);
    }
  }

  async testBoundaryConditions() {
    console.log('\n🎯 3. BOUNDARY CONDITION TESTS\n');

    try {
      // Test maximum safe integer
      const maxSafeInt = Number.MAX_SAFE_INTEGER;
      const score = await this.reputation['getReputationScore(uint256)'](maxSafeInt);

      recordResult(
        this.network,
        'Maximum Integer Query',
        score === 0n,
        `Query with ${maxSafeInt} returned score: ${score}`
      );

      // Test with 0
      const zeroScore = await this.reputation['getReputationScore(uint256)'](0);
      recordResult(
        this.network,
        'Zero Value Query',
        zeroScore === 0n,
        `Query with 0 returned score: ${zeroScore}`
      );

      // Test total agents retrieval multiple times
      const [count1, count2, count3] = await Promise.all([
        this.registry.totalAgents(),
        this.registry.totalAgents(),
        this.registry.totalAgents()
      ]);

      recordResult(
        this.network,
        'Consistent State Reads',
        count1 === count2 && count2 === count3,
        `All reads returned same value: ${count1}`
      );

    } catch (error) {
      recordResult(this.network, 'Boundary Conditions', false, error.message);
    }
  }

  async testLargeNumberQueries() {
    console.log('\n📊 4. LARGE NUMBER QUERY TESTS\n');

    try {
      const totalAgents = await this.registry.totalAgents();

      if (totalAgents > 10n) {
        // Query multiple agents in parallel
        const start = Date.now();
        const promises = [];

        for (let i = 1; i <= Math.min(Number(totalAgents), 20); i++) {
          promises.push(this.reputation['getReputationScore(uint256)'](i));
        }

        const scores = await Promise.all(promises);
        const duration = Date.now() - start;

        recordResult(
          this.network,
          `Query ${promises.length} Agent Scores`,
          scores.length === promises.length,
          `Retrieved ${scores.length} scores in ${duration}ms`
        );
      } else {
        recordResult(
          this.network,
          'Large Number Queries',
          true,
          `Only ${totalAgents} agents - skipping mass query test`
        );
      }

    } catch (error) {
      recordResult(this.network, 'Large Number Queries', false, error.message);
    }
  }
}

async function runStressTests() {
  console.log('\n' + '='.repeat(80));
  console.log('  CONTRACT STRESS TEST SUITE');
  console.log('='.repeat(80));
  console.log(`\nStart time: ${new Date().toISOString()}\n`);

  for (const [networkKey, networkConfig] of Object.entries(NETWORKS)) {
    console.log(`\n${'#'.repeat(80)}`);
    console.log(`#  ${networkConfig.name.toUpperCase()}`);
    console.log(`${'#'.repeat(80)}`);

    try {
      const configPath = path.join(__dirname, networkConfig.configPath);
      const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

      const provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl, networkConfig.chainId, {
        batchMaxCount: 1
      });

      const tester = new StressTester(networkKey, config, provider);
      await tester.runStressTests();

    } catch (error) {
      console.error(`\n❌ Error testing ${networkKey}:`, error.message);
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(80));
  console.log('  STRESS TEST SUMMARY');
  console.log('='.repeat(80));

  let totalPassed = 0;
  let totalFailed = 0;

  for (const [network, tests] of Object.entries(results)) {
    const passed = tests.filter(t => t.passed).length;
    const failed = tests.filter(t => !t.passed).length;

    console.log(`\n${NETWORKS[network].name}:`);
    console.log(`  ✅ Passed: ${passed}`);
    console.log(`  ❌ Failed: ${failed}`);
    console.log(`  📊 Total:  ${tests.length}`);

    if (failed > 0) {
      console.log('\n  Failed tests:');
      tests.filter(t => !t.passed).forEach(t => {
        console.log(`    ❌ ${t.test}: ${t.details}`);
      });
    }

    totalPassed += passed;
    totalFailed += failed;
  }

  console.log(`\n${'='.repeat(80)}`);
  console.log(`OVERALL: ${totalPassed}/${totalPassed + totalFailed} passed (${((totalPassed/(totalPassed+totalFailed))*100).toFixed(1)}%)`);
  console.log(`End time: ${new Date().toISOString()}`);
  console.log('='.repeat(80) + '\n');

  // Save results
  const reportPath = path.join(__dirname, '../stress-test-results.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`📄 Results saved to: ${reportPath}\n`);
}

runStressTests().catch((e) => { console.error(e); process.exit(1); });
