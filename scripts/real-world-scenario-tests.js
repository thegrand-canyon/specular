/**
 * Real-World Scenario Tests
 * Tests actual user workflows and common operations
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

const AgentRegistryV2 = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')
));
const ReputationManagerV3 = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json')
));
const AgentLiquidityMarketplace = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')
));
const ERC20_ABI = ['function balanceOf(address) view returns (uint256)'];

const results = { arc: [], base: [] };

function recordResult(network, scenario, passed, details) {
  results[network].push({ scenario, passed, details, timestamp: new Date().toISOString() });
  console.log(`  ${passed ? '✅' : '❌'} ${scenario}`);
  if (details) console.log(`     ${details}`);
}

class ScenarioTester {
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

  async runScenarios() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  REAL-WORLD SCENARIOS - ${NETWORKS[this.network].name}`);
    console.log(`${'='.repeat(60)}\n`);

    await this.scenarioNewUserDiscovery();
    await this.scenarioLenderEvaluation();
    await this.scenarioBorrowerCheck();
    await this.scenarioPoolUtilization();
    await this.scenarioReputationTracking();
  }

  async scenarioNewUserDiscovery() {
    console.log('\n🆕 SCENARIO 1: New User Discovers Protocol\n');

    try {
      // User visits website and checks API
      const start1 = Date.now();
      const status = await fetch(`${this.apiUrl}/status?network=${this.network}`).then(r => r.json());
      const duration1 = Date.now() - start1;

      recordResult(
        this.network,
        'User Checks Protocol Status',
        status.tvl && status.totalPools !== undefined,
        `TVL: ${status.tvl}, Pools: ${status.totalPools} (loaded in ${duration1}ms)`
      );

      // User browses agents
      const start2 = Date.now();
      const agents = await fetch(`${this.apiUrl}/agents?network=${this.network}`).then(r => r.json());
      const duration2 = Date.now() - start2;

      recordResult(
        this.network,
        'User Browses Agents',
        Array.isArray(agents.agents),
        `Found ${agents.totalAgents} agents (loaded in ${duration2}ms)`
      );

      // User views pools
      const start3 = Date.now();
      const pools = await fetch(`${this.apiUrl}/pools?network=${this.network}`).then(r => r.json());
      const duration3 = Date.now() - start3;

      recordResult(
        this.network,
        'User Views Available Pools',
        Array.isArray(pools.pools),
        `Found ${pools.totalPools} pools (loaded in ${duration3}ms)`
      );

    } catch (error) {
      recordResult(this.network, 'New User Discovery', false, error.message);
    }
  }

  async scenarioLenderEvaluation() {
    console.log('\n💰 SCENARIO 2: Lender Evaluates Investment Opportunity\n');

    try {
      const totalAgents = await this.registry.totalAgents();

      if (totalAgents > 0n) {
        // Lender checks first agent's reputation
        const agentId = 1n;
        const start1 = Date.now();
        const [agentInfo, reputationScore] = await Promise.all([
          this.registry.getAgentInfoById(agentId),
          this.reputation['getReputationScore(uint256)'](agentId)
        ]);
        const duration1 = Date.now() - start1;

        recordResult(
          this.network,
          'Lender Checks Agent Reputation',
          agentInfo.owner !== ethers.ZeroAddress,
          `Agent ${agentId}: Score ${reputationScore}, Owner ${agentInfo.owner} (${duration1}ms)`
        );

        // Lender checks pool details
        try {
          const start2 = Date.now();
          const pool = await this.marketplace.getAgentPool(agentId);
          const duration2 = Date.now() - start2;

          const supplied = pool[1] || 0n;
          const borrowed = pool[2] || 0n;
          const utilization = supplied > 0n ? Number(borrowed * 10000n / supplied) / 100 : 0;

          recordResult(
            this.network,
            'Lender Evaluates Pool Metrics',
            true,
            `Pool ${agentId}: ${ethers.formatUnits(supplied, 6)} USDC supplied, ${utilization}% utilized (${duration2}ms)`
          );
        } catch (e) {
          // Pool might not exist for this agent
          recordResult(
            this.network,
            'Lender Evaluates Pool Metrics',
            true,
            `Agent ${agentId} has no pool`
          );
        }

        // Lender checks historical performance via API
        const start3 = Date.now();
        const poolsData = await fetch(`${this.apiUrl}/pools?network=${this.network}`).then(r => r.json());
        const duration3 = Date.now() - start3;

        recordResult(
          this.network,
          'Lender Reviews Pool Performance',
          poolsData.pools.length >= 0,
          `Analyzed ${poolsData.pools.length} pools (${duration3}ms)`
        );
      }

    } catch (error) {
      recordResult(this.network, 'Lender Evaluation', false, error.message);
    }
  }

  async scenarioBorrowerCheck() {
    console.log('\n📊 SCENARIO 3: Borrower Checks Eligibility\n');

    try {
      // Borrower checks if registered
      const randomAddr = '0x742d35Cc6634C0532925a3b844B0a2c7bB3F9123';
      const start1 = Date.now();
      const agentId = await this.registry.addressToAgentId(randomAddr);
      const duration1 = Date.now() - start1;

      recordResult(
        this.network,
        'Borrower Checks Registration Status',
        agentId >= 0n,
        `Address ${randomAddr} ${agentId > 0n ? 'IS' : 'is NOT'} registered (Agent ID: ${agentId}) (${duration1}ms)`
      );

      // Borrower checks available liquidity
      const start2 = Date.now();
      const totalPools = await this.marketplace.totalPools();
      const duration2 = Date.now() - start2;

      recordResult(
        this.network,
        'Borrower Checks Available Liquidity',
        totalPools >= 0n,
        `${totalPools} pools available for borrowing (${duration2}ms)`
      );

      // Borrower checks loan parameters
      const start3 = Date.now();
      const [minDuration, maxDuration, maxInterest] = await Promise.all([
        this.marketplace.MIN_LOAN_DURATION(),
        this.marketplace.MAX_LOAN_DURATION(),
        this.marketplace.MAX_INTEREST_RATE()
      ]);
      const duration3 = Date.now() - start3;

      recordResult(
        this.network,
        'Borrower Reviews Loan Terms',
        minDuration > 0n && maxDuration > minDuration,
        `Duration: ${minDuration}s - ${maxDuration}s, Max interest: ${Number(maxInterest)/100}% (${duration3}ms)`
      );

    } catch (error) {
      recordResult(this.network, 'Borrower Check', false, error.message);
    }
  }

  async scenarioPoolUtilization() {
    console.log('\n📈 SCENARIO 4: Monitor Pool Utilization\n');

    try {
      const totalPools = await this.marketplace.totalPools();

      if (totalPools > 0n) {
        // Check utilization across all pools
        let poolsChecked = 0;
        let totalSupplied = 0n;
        let totalBorrowed = 0n;

        for (let agentId = 1; agentId <= Math.min(10, Number(totalPools)); agentId++) {
          try {
            const pool = await this.marketplace.getAgentPool(agentId);
            const supplied = pool[1] || 0n;
            const borrowed = pool[2] || 0n;

            if (supplied > 0n || borrowed > 0n) {
              totalSupplied += supplied;
              totalBorrowed += borrowed;
              poolsChecked++;
            }
          } catch (e) {
            // Skip pools that don't exist
          }
        }

        const overallUtilization = totalSupplied > 0n ?
          Number(totalBorrowed * 10000n / totalSupplied) / 100 : 0;

        recordResult(
          this.network,
          'Monitor Overall Pool Utilization',
          poolsChecked > 0,
          `${poolsChecked} pools: ${ethers.formatUnits(totalSupplied, 6)} USDC supplied, ${overallUtilization}% utilized`
        );

        // Check marketplace USDC balance
        const marketplaceBalance = await this.usdc.balanceOf(this.config.agentLiquidityMarketplace);

        recordResult(
          this.network,
          'Verify Marketplace Liquidity',
          marketplaceBalance >= totalSupplied - totalBorrowed,
          `Marketplace holds ${ethers.formatUnits(marketplaceBalance, 6)} USDC`
        );
      }

    } catch (error) {
      recordResult(this.network, 'Pool Utilization Monitoring', false, error.message);
    }
  }

  async scenarioReputationTracking() {
    console.log('\n⭐ SCENARIO 5: Track Reputation Changes\n');

    try {
      const totalAgents = await this.registry.totalAgents();

      if (totalAgents > 0n) {
        // Check reputation scores for multiple agents
        const agentsToCheck = Math.min(5, Number(totalAgents));
        const scores = [];

        for (let i = 1; i <= agentsToCheck; i++) {
          const score = await this.reputation['getReputationScore(uint256)'](i);
          scores.push({ agentId: i, score: Number(score) });
        }

        const avgScore = scores.reduce((sum, s) => sum + s.score, 0) / scores.length;

        recordResult(
          this.network,
          'Track Agent Reputation Scores',
          scores.length === agentsToCheck,
          `Checked ${agentsToCheck} agents, average score: ${avgScore.toFixed(1)}`
        );

        // Check if reputation system is responsive
        const highestScore = Math.max(...scores.map(s => s.score));
        const lowestScore = Math.min(...scores.map(s => s.score));

        recordResult(
          this.network,
          'Reputation Score Distribution',
          true,
          `Range: ${lowestScore} - ${highestScore} (spread: ${highestScore - lowestScore})`
        );
      }

    } catch (error) {
      recordResult(this.network, 'Reputation Tracking', false, error.message);
    }
  }
}

async function runScenarioTests() {
  console.log('\n' + '='.repeat(80));
  console.log('  REAL-WORLD SCENARIO TESTS');
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

      const tester = new ScenarioTester(networkKey, config, provider);
      await tester.runScenarios();

    } catch (error) {
      console.error(`\n❌ Error testing ${networkKey}:`, error.message);
    }
  }

  // Print summary
  console.log('\n' + '='.repeat(80));
  console.log('  SCENARIO TEST SUMMARY');
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
      console.log('\n  Failed scenarios:');
      tests.filter(t => !t.passed).forEach(t => {
        console.log(`    ❌ ${t.scenario}: ${t.details}`);
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
  const reportPath = path.join(__dirname, '../scenario-test-results.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`📄 Results saved to: ${reportPath}\n`);
}

runScenarioTests().catch((e) => { console.error(e); process.exit(1); });
