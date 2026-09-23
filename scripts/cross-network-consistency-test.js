/**
 * Cross-Network Consistency Test
 * Verifies that both networks maintain consistent behavior and configuration
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

const AgentLiquidityMarketplace = JSON.parse(fs.readFileSync(
  path.join(__dirname, '../artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')
));

const results = [];

function recordResult(test, passed, details) {
  results.push({ test, passed, details, timestamp: new Date().toISOString() });
  console.log(`  ${passed ? '✅' : '❌'} ${test}`);
  if (details) console.log(`     ${details}`);
}

async function runCrossNetworkTests() {
  console.log('\n' + '='.repeat(80));
  console.log('  CROSS-NETWORK CONSISTENCY TEST');
  console.log('='.repeat(80));
  console.log(`\nStart time: ${new Date().toISOString()}\n`);

  // Load configurations
  const arcConfig = JSON.parse(fs.readFileSync(
    path.join(__dirname, NETWORKS.arc.configPath), 'utf8'
  ));
  const baseConfig = JSON.parse(fs.readFileSync(
    path.join(__dirname, NETWORKS.base.configPath), 'utf8'
  ));

  // Create providers
  const arcProvider = new ethers.JsonRpcProvider(NETWORKS.arc.rpcUrl, NETWORKS.arc.chainId, { batchMaxCount: 1 });
  const baseProvider = new ethers.JsonRpcProvider(NETWORKS.base.rpcUrl, NETWORKS.base.chainId, { batchMaxCount: 1 });

  // Create contract instances
  const arcMarketplace = new ethers.Contract(arcConfig.agentLiquidityMarketplace, AgentLiquidityMarketplace.abi, arcProvider);
  const baseMarketplace = new ethers.Contract(baseConfig.agentLiquidityMarketplace, AgentLiquidityMarketplace.abi, baseProvider);

  console.log('\n📊 1. CONFIGURATION CONSISTENCY\n');

  // Test 1: Same platform fee rate
  try {
    const [arcFee, baseFee] = await Promise.all([
      arcMarketplace.platformFeeRate(),
      baseMarketplace.platformFeeRate()
    ]);

    recordResult(
      'Platform Fee Rate Consistent',
      arcFee === baseFee,
      `Arc: ${Number(arcFee)/100}%, Base: ${Number(baseFee)/100}%`
    );
  } catch (error) {
    recordResult('Platform Fee Rate Consistency', false, error.message);
  }

  // Test 2: Same max interest rate
  try {
    const [arcMaxInterest, baseMaxInterest] = await Promise.all([
      arcMarketplace.MAX_INTEREST_RATE(),
      baseMarketplace.MAX_INTEREST_RATE()
    ]);

    recordResult(
      'Max Interest Rate Consistent',
      arcMaxInterest === baseMaxInterest,
      `Arc: ${Number(arcMaxInterest)/100}%, Base: ${Number(baseMaxInterest)/100}%`
    );
  } catch (error) {
    recordResult('Max Interest Rate Consistency', false, error.message);
  }

  // Test 3: Same loan duration limits
  try {
    const [arcMin, arcMax, baseMin, baseMax] = await Promise.all([
      arcMarketplace.MIN_LOAN_DURATION(),
      arcMarketplace.MAX_LOAN_DURATION(),
      baseMarketplace.MIN_LOAN_DURATION(),
      baseMarketplace.MAX_LOAN_DURATION()
    ]);

    recordResult(
      'Loan Duration Limits Consistent',
      arcMin === baseMin && arcMax === baseMax,
      `Min: ${arcMin === baseMin ? arcMin : `Arc ${arcMin}, Base ${baseMin}`}, Max: ${arcMax === baseMax ? arcMax : `Arc ${arcMax}, Base ${baseMax}`}`
    );
  } catch (error) {
    recordResult('Loan Duration Consistency', false, error.message);
  }

  // Test 4: Same max active loans per agent
  try {
    const [arcMaxLoans, baseMaxLoans] = await Promise.all([
      arcMarketplace.MAX_ACTIVE_LOANS_PER_AGENT(),
      baseMarketplace.MAX_ACTIVE_LOANS_PER_AGENT()
    ]);

    recordResult(
      'Max Active Loans Consistent',
      arcMaxLoans === baseMaxLoans,
      `Arc: ${arcMaxLoans}, Base: ${baseMaxLoans}`
    );
  } catch (error) {
    recordResult('Max Active Loans Consistency', false, error.message);
  }

  // Test 5: Owner consistency (should be same address)
  try {
    const [arcOwner, baseOwner] = await Promise.all([
      arcMarketplace.owner(),
      baseMarketplace.owner()
    ]);

    recordResult(
      'Marketplace Owner Consistent',
      arcOwner.toLowerCase() === baseOwner.toLowerCase(),
      `Arc: ${arcOwner}, Base: ${baseOwner}`
    );
  } catch (error) {
    recordResult('Owner Consistency', false, error.message);
  }

  console.log('\n🌐 2. API CONSISTENCY\n');

  // Test 6: API endpoints return correct network identifiers
  try {
    const [arcStatus, baseStatus] = await Promise.all([
      fetch(`${NETWORKS.arc.apiUrl}/status?network=arc`).then(r => r.json()),
      fetch(`${NETWORKS.base.apiUrl}/status?network=base`).then(r => r.json())
    ]);

    recordResult(
      'API Network Identifiers Correct',
      arcStatus.network === 'arc' && baseStatus.network === 'base',
      `Arc API: ${arcStatus.network}, Base API: ${baseStatus.network}`
    );

    recordResult(
      'API Chain IDs Correct',
      arcStatus.chainId === NETWORKS.arc.chainId && baseStatus.chainId === NETWORKS.base.chainId,
      `Arc: ${arcStatus.chainId}, Base: ${baseStatus.chainId}`
    );
  } catch (error) {
    recordResult('API Consistency', false, error.message);
  }

  console.log('\n🔗 3. CONTRACT BYTECODE CONSISTENCY\n');

  // Test 7: Same marketplace bytecode (deployments should be identical)
  try {
    const [arcCode, baseCode] = await Promise.all([
      arcProvider.getCode(arcConfig.agentLiquidityMarketplace),
      baseProvider.getCode(baseConfig.agentLiquidityMarketplace)
    ]);

    const arcSize = (arcCode.length - 2) / 2;
    const baseSize = (baseCode.length - 2) / 2;

    recordResult(
      'Marketplace Bytecode Size Consistent',
      arcSize === baseSize,
      `Arc: ${arcSize} bytes, Base: ${baseSize} bytes`
    );
  } catch (error) {
    recordResult('Bytecode Consistency', false, error.message);
  }

  console.log('\n⚙️  4. STATE CONSISTENCY\n');

  // Test 8: Both marketplaces not paused
  try {
    const [arcPaused, basePaused] = await Promise.all([
      arcMarketplace.paused(),
      baseMarketplace.paused()
    ]);

    recordResult(
      'Both Marketplaces Operational',
      !arcPaused && !basePaused,
      `Arc paused: ${arcPaused}, Base paused: ${basePaused}`
    );
  } catch (error) {
    recordResult('Pause State Consistency', false, error.message);
  }

  // Test 9: Both have accumulated some fees or not
  try {
    const [arcFees, baseFees] = await Promise.all([
      arcMarketplace.accumulatedFees(),
      baseMarketplace.accumulatedFees()
    ]);

    recordResult(
      'Accumulated Fees Readable',
      arcFees >= 0n && baseFees >= 0n,
      `Arc: ${ethers.formatUnits(arcFees, 6)} USDC, Base: ${ethers.formatUnits(baseFees, 6)} USDC`
    );
  } catch (error) {
    recordResult('Accumulated Fees Check', false, error.message);
  }

  // Print summary
  console.log('\n' + '='.repeat(80));
  console.log('  TEST SUMMARY');
  console.log('='.repeat(80));

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  console.log(`\n  ✅ Passed: ${passed}`);
  console.log(`  ❌ Failed: ${failed}`);
  console.log(`  📊 Total:  ${results.length}`);
  console.log(`  📈 Success Rate: ${((passed / results.length) * 100).toFixed(1)}%`);

  if (failed > 0) {
    console.log('\n  Failed tests:');
    results.filter(r => !r.passed).forEach(r => {
      console.log(`    ❌ ${r.test}: ${r.details}`);
    });
  }

  console.log(`\nEnd time: ${new Date().toISOString()}`);
  console.log('='.repeat(80) + '\n');

  // Save results
  const reportPath = path.join(__dirname, '../cross-network-test-results.json');
  fs.writeFileSync(reportPath, JSON.stringify(results, null, 2));
  console.log(`📄 Results saved to: ${reportPath}\n`);
}

runCrossNetworkTests().catch((e) => { console.error(e); process.exit(1); });
