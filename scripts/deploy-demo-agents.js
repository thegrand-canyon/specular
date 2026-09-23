/**
 * Deploy Demo Agents Script
 *
 * Deploys multiple demo agents to showcase Specular Protocol
 * Each agent has a different strategy to demonstrate various use cases
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Network configuration
const NETWORK = process.env.NETWORK || 'base';
const NETWORKS = {
  base: {
    rpcUrl: 'https://mainnet.base.org',
    chainId: 8453,
    configPath: '../src/config/base-addresses.json'
  },
  arc: {
    rpcUrl: process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
    chainId: 5042002,
    configPath: '../src/config/arc-testnet-addresses.json'
  }
};

// Load contract ABIs
const AgentRegistryV2 = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')
));
const AgentLiquidityMarketplace = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')
));
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function balanceOf(address account) view returns (uint256)'
];

/**
 * Demo Agent Class
 */
class DemoAgent {
  constructor(privateKey, strategy, network) {
    this.strategy = strategy;
    this.network = network;

    const networkConfig = NETWORKS[network];
    const config = JSON.parse(fs.readFileSync(
      path.join(__dirname, networkConfig.configPath), 'utf8'
    ));

    this.provider = new ethers.JsonRpcProvider(networkConfig.rpcUrl, networkConfig.chainId, {
      batchMaxCount: 1
    });
    this.wallet = new ethers.Wallet(privateKey, this.provider);

    this.registry = new ethers.Contract(
      config.agentRegistryV2,
      AgentRegistryV2.abi,
      this.wallet
    );
    this.marketplace = new ethers.Contract(
      config.agentLiquidityMarketplace,
      AgentLiquidityMarketplace.abi,
      this.wallet
    );
    this.usdc = new ethers.Contract(
      config.usdc,
      ERC20_ABI,
      this.wallet
    );

    this.config = config;
  }

  async register() {
    console.log(`\n📝 Registering ${this.strategy.name}...`);
    console.log(`   Wallet: ${this.wallet.address}`);

    // Check if already registered
    const agentId = await this.registry.addressToAgentId(this.wallet.address);
    if (agentId > 0n) {
      console.log(`   ✅ Already registered with ID: ${agentId}`);
      return agentId;
    }

    // Register
    const metadata = JSON.stringify({
      name: this.strategy.name,
      description: this.strategy.description,
      strategy: this.strategy.type,
      version: '1.0.0'
    });

    const tx = await this.registry.register(`https://specular.demo/${this.wallet.address}`, []);
    const receipt = await tx.wait();

    const newAgentId = await this.registry.addressToAgentId(this.wallet.address);
    console.log(`   ✅ Registered with ID: ${newAgentId}`);
    console.log(`   TX: ${receipt.hash}`);

    return newAgentId;
  }

  async createPool() {
    console.log(`\n🏊 Creating liquidity pool...`);

    try {
      const tx = await this.marketplace.createAgentPool();
      const receipt = await tx.wait();
      console.log(`   ✅ Pool created`);
      console.log(`   TX: ${receipt.hash}`);
    } catch (error) {
      if (error.message.includes('Pool already exists')) {
        console.log(`   ✅ Pool already exists`);
      } else {
        console.error(`   ❌ Error: ${error.message}`);
      }
    }
  }

  async executeStrategy(cycles = 5) {
    console.log(`\n🤖 Executing ${this.strategy.name} strategy...`);
    console.log(`   Type: ${this.strategy.type}`);
    console.log(`   Cycles: ${cycles}`);

    for (let i = 1; i <= cycles; i++) {
      console.log(`\n   Cycle ${i}/${cycles}:`);

      try {
        if (this.strategy.type === 'conservative_lender') {
          await this.lendToTopAgent();
        } else if (this.strategy.type === 'active_borrower') {
          await this.borrowAndRepay();
        } else if (this.strategy.type === 'yield_optimizer') {
          await this.optimizeYield();
        }

        // Wait between cycles
        if (i < cycles) {
          const waitTime = 10000; // 10 seconds
          console.log(`   ⏳ Waiting ${waitTime/1000}s before next cycle...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      } catch (error) {
        console.error(`   ❌ Error in cycle ${i}: ${error.message}`);
      }
    }

    console.log(`\n✅ ${this.strategy.name} completed ${cycles} cycles`);
  }

  async lendToTopAgent() {
    console.log(`   💰 Conservative Lender Strategy`);

    // Get current balance
    const balance = await this.usdc.balanceOf(this.wallet.address);
    if (balance === 0n) {
      console.log(`   ⚠️  No USDC balance`);
      return;
    }

    // Supply 10% of balance to agent #1 (or random high-rep agent)
    const supplyAmount = balance / 10n;
    const agentId = 1; // Could query API for high-reputation agents

    console.log(`   Supplying ${ethers.formatUnits(supplyAmount, 6)} USDC to agent ${agentId}...`);

    // Approve
    const approveTx = await this.usdc.approve(this.config.agentLiquidityMarketplace, supplyAmount);
    await approveTx.wait();

    // Supply
    const tx = await this.marketplace.supplyLiquidity(agentId, supplyAmount);
    const receipt = await tx.wait();
    console.log(`   ✅ Supplied liquidity - TX: ${receipt.hash}`);
  }

  async borrowAndRepay() {
    console.log(`   📈 Active Borrower Strategy`);

    const loanAmount = 50_000000; // 50 USDC
    const duration = 7 * 24 * 60 * 60; // 7 days

    // Request loan
    console.log(`   Requesting ${ethers.formatUnits(loanAmount, 6)} USDC loan for 7 days...`);

    try {
      const tx = await this.marketplace.requestLoan(loanAmount, duration, 2000);
      const receipt = await tx.wait();
      console.log(`   ✅ Loan requested - TX: ${receipt.hash}`);

      // Get loan ID from events
      const event = receipt.logs.find(log => {
        try {
          const parsed = this.marketplace.interface.parseLog(log);
          return parsed.name === 'LoanRequested';
        } catch {
          return false;
        }
      });

      if (event) {
        const parsed = this.marketplace.interface.parseLog(event);
        const loanId = parsed.args.loanId;

        console.log(`   Loan ID: ${loanId}`);

        // Wait a bit (simulate work)
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Repay
        console.log(`   Repaying loan ${loanId}...`);

        // Get loan details
        const loan = await this.marketplace.getLoan(loanId);
        const repayAmount = loan.principal + loan.interest;

        // Approve repayment
        const approveTx = await this.usdc.approve(this.config.agentLiquidityMarketplace, repayAmount);
        await approveTx.wait();

        // Repay
        const repayTx = await this.marketplace.repayLoan(loanId);
        const repayReceipt = await repayTx.wait();
        console.log(`   ✅ Loan repaid - TX: ${repayReceipt.hash}`);
        console.log(`   📈 Reputation increased!`);
      }
    } catch (error) {
      console.error(`   ❌ Loan error: ${error.message}`);
    }
  }

  async optimizeYield() {
    console.log(`   ⚡ Yield Optimizer Strategy`);

    // Check if we should lend or borrow
    const balance = await this.usdc.balanceOf(this.wallet.address);

    if (balance > 100_000000) { // > 100 USDC
      // Lend excess
      await this.lendToTopAgent();
    } else {
      // Borrow for opportunities
      await this.borrowAndRepay();
    }
  }
}

/**
 * Demo Agent Strategies
 */
const STRATEGIES = {
  conservative_lender: {
    name: 'Conservative Lender Bot',
    description: 'Supplies liquidity to high-reputation agents to earn steady yield',
    type: 'conservative_lender'
  },
  active_borrower: {
    name: 'Active Borrower Bot',
    description: 'Borrows USDC for short-term opportunities and repays on time to build credit',
    type: 'active_borrower'
  },
  yield_optimizer: {
    name: 'Yield Optimizer Bot',
    description: 'Dual-sided strategy: lends when idle, borrows for profitable opportunities',
    type: 'yield_optimizer'
  }
};

/**
 * Main deployment function
 */
async function deployDemoAgents() {
  console.log('╔═══════════════════════════════════════════════════════╗');
  console.log('║         Specular Protocol - Demo Agent Deployer      ║');
  console.log('╚═══════════════════════════════════════════════════════╝');

  const network = process.env.NETWORK || 'arc'; // Default to testnet
  console.log(`\n🌐 Network: ${network === 'base' ? 'Base Mainnet' : 'Arc Testnet'}`);

  // Check for required env vars
  const requiredKeys = ['AGENT1_KEY', 'AGENT2_KEY', 'AGENT3_KEY'];
  const missingKeys = requiredKeys.filter(key => !process.env[key]);

  if (missingKeys.length > 0) {
    console.log('\n⚠️  Missing private keys. Please set:');
    missingKeys.forEach(key => console.log(`   - ${key}`));
    console.log('\nExample:');
    console.log('AGENT1_KEY=0x... AGENT2_KEY=0x... AGENT3_KEY=0x... node scripts/deploy-demo-agents.js');
    process.exit(1);
  }

  // Create demo agents
  const agents = [
    new DemoAgent(process.env.AGENT1_KEY, STRATEGIES.conservative_lender, network),
    new DemoAgent(process.env.AGENT2_KEY, STRATEGIES.active_borrower, network),
    new DemoAgent(process.env.AGENT3_KEY, STRATEGIES.yield_optimizer, network)
  ];

  console.log(`\n📋 Deploying ${agents.length} demo agents...`);

  // Register all agents
  for (const agent of agents) {
    await agent.register();
    await agent.createPool();
  }

  console.log('\n✅ All agents registered and pools created!');

  // Ask if user wants to run strategies
  console.log('\n🤖 Ready to execute agent strategies?');
  console.log('   This will continuously run the agents to generate network activity.');
  console.log('   Press Ctrl+C to stop.');

  // Run strategies (could be run in parallel)
  const cycles = parseInt(process.env.CYCLES || '5');

  console.log(`\n🚀 Executing strategies (${cycles} cycles each)...`);

  // Run agents sequentially (could be parallel with Promise.all)
  for (const agent of agents) {
    await agent.executeStrategy(cycles);
  }

  console.log('\n╔═══════════════════════════════════════════════════════╗');
  console.log('║              Demo Agents Deployment Complete          ║');
  console.log('╚═══════════════════════════════════════════════════════╝');
  console.log('\n📊 Check the results:');
  console.log(`   - API: https://specular-production.up.railway.app/status?network=${network}`);
  console.log(`   - Pools: https://specular-production.up.railway.app/pools?network=${network}`);
  console.log(`   - Agents: https://specular-production.up.railway.app/agents?network=${network}`);
}

// Run if called directly
if (require.main === module) {
  deployDemoAgents().catch(error => {
    console.error('\n❌ Error:', error);
    process.exit(1);
  });
}

module.exports = { DemoAgent, STRATEGIES };
