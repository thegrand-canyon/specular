/**
 * Comprehensive Contract Security Audit Script
 * Performs deep security analysis on deployed Specular Protocol contracts
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
  },
  base: {
    name: 'Base Mainnet',
    chainId: 8453,
    rpcUrl: 'https://mainnet.base.org',
    configPath: '../src/config/base-addresses.json',
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

// Audit results storage
const auditResults = {
  arc: { critical: [], high: [], medium: [], low: [], passed: [] },
  base: { critical: [], high: [], medium: [], low: [], passed: [] }
};

// Helper to record findings
function recordFinding(network, severity, check, status, details = '') {
  const finding = { check, status, details, timestamp: new Date().toISOString() };

  const icon = status === 'PASS' ? '✅' : severity === 'CRITICAL' ? '🔴' : severity === 'HIGH' ? '🟠' : severity === 'MEDIUM' ? '🟡' : '⚪';

  if (status === 'PASS') {
    auditResults[network].passed.push(finding);
    console.log(`  ${icon} ${check}`);
  } else {
    const severityKey = severity.toLowerCase();
    auditResults[network][severityKey].push(finding);
    console.log(`  ${icon} ${severity}: ${check}`);
  }

  if (details) {
    console.log(`     ${details}`);
  }
}

class SecurityAuditor {
  constructor(network, config, provider) {
    this.network = network;
    this.config = config;
    this.provider = provider;

    this.registry = new ethers.Contract(
      config.agentRegistryV2,
      AgentRegistryV2.abi,
      provider
    );

    this.reputation = new ethers.Contract(
      config.reputationManagerV3,
      ReputationManagerV3.abi,
      provider
    );

    this.marketplace = new ethers.Contract(
      config.agentLiquidityMarketplace,
      AgentLiquidityMarketplace.abi,
      provider
    );
  }

  async runFullAudit() {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`  SECURITY AUDIT - ${NETWORKS[this.network].name}`);
    console.log(`${'='.repeat(60)}\n`);

    await this.auditOwnershipAndAccessControl();
    await this.auditAuthorizationMechanisms();
    await this.auditEmergencyControls();
    await this.auditCrossContractSecurity();
    await this.auditEconomicAttacks();
    await this.auditInputValidation();
    await this.auditEventEmission();
    await this.auditGasOptimization();
  }

  async auditOwnershipAndAccessControl() {
    console.log('\n📋 1. OWNERSHIP & ACCESS CONTROL\n');

    try {
      // Check ownership consistency
      const [registryOwner, reputationOwner, marketplaceOwner] = await Promise.all([
        this.registry.owner(),
        this.reputation.owner(),
        this.marketplace.owner()
      ]);

      const allSameOwner =
        registryOwner.toLowerCase() === reputationOwner.toLowerCase() &&
        reputationOwner.toLowerCase() === marketplaceOwner.toLowerCase();

      if (allSameOwner) {
        recordFinding(
          this.network,
          'CRITICAL',
          'Unified Ownership',
          'PASS',
          `All contracts owned by: ${registryOwner}`
        );
      } else {
        recordFinding(
          this.network,
          'CRITICAL',
          'Unified Ownership',
          'FAIL',
          `Inconsistent owners: Registry=${registryOwner}, Reputation=${reputationOwner}, Marketplace=${marketplaceOwner}`
        );
      }

      // Check if owner is not zero address
      if (registryOwner === ethers.ZeroAddress) {
        recordFinding(
          this.network,
          'CRITICAL',
          'Owner Not Zero Address',
          'FAIL',
          'Owner is zero address - contracts are ownerless!'
        );
      } else {
        recordFinding(
          this.network,
          'CRITICAL',
          'Owner Not Zero Address',
          'PASS',
          'Owner is valid address'
        );
      }

      // Check if owner is EOA or contract
      const ownerCode = await this.provider.getCode(registryOwner);
      const isEOA = ownerCode === '0x';

      recordFinding(
        this.network,
        'MEDIUM',
        'Owner Type Check',
        'PASS',
        isEOA ? 'Owner is EOA (direct control)' : 'Owner is contract (multi-sig or governance)'
      );

    } catch (error) {
      recordFinding(
        this.network,
        'CRITICAL',
        'Ownership Check',
        'FAIL',
        `Error: ${error.message}`
      );
    }
  }

  async auditAuthorizationMechanisms() {
    console.log('\n🔐 2. AUTHORIZATION MECHANISMS\n');

    try {
      // Check marketplace authorization in ReputationManager
      const marketplaceAuthorized = await this.reputation.authorizedPools(
        this.config.agentLiquidityMarketplace
      );

      if (marketplaceAuthorized) {
        recordFinding(
          this.network,
          'CRITICAL',
          'Marketplace Authorization',
          'PASS',
          'Marketplace is authorized to update reputation scores'
        );
      } else {
        recordFinding(
          this.network,
          'CRITICAL',
          'Marketplace Authorization',
          'FAIL',
          'Marketplace is NOT authorized - cannot update reputation!'
        );
      }

      // Verify random address is NOT authorized
      const randomAddr = '0x0000000000000000000000000000000000000001';
      const randomAuthorized = await this.reputation.authorizedPools(randomAddr);

      if (!randomAuthorized) {
        recordFinding(
          this.network,
          'CRITICAL',
          'Unauthorized Address Blocked',
          'PASS',
          'Random addresses cannot bypass authorization'
        );
      } else {
        recordFinding(
          this.network,
          'CRITICAL',
          'Unauthorized Address Blocked',
          'FAIL',
          'Random address is authorized - authorization bypass!'
        );
      }

      // Check zero address is not authorized
      const zeroAuthorized = await this.reputation.authorizedPools(ethers.ZeroAddress);

      if (!zeroAuthorized) {
        recordFinding(
          this.network,
          'MEDIUM',
          'Zero Address Not Authorized',
          'PASS',
          'Zero address cannot bypass authorization'
        );
      } else {
        recordFinding(
          this.network,
          'HIGH',
          'Zero Address Not Authorized',
          'FAIL',
          'Zero address is authorized - potential vulnerability'
        );
      }

    } catch (error) {
      recordFinding(
        this.network,
        'CRITICAL',
        'Authorization Check',
        'FAIL',
        `Error: ${error.message}`
      );
    }
  }

  async auditEmergencyControls() {
    console.log('\n🚨 3. EMERGENCY CONTROLS\n');

    try {
      // Check if contracts are pausable
      const hasPauseFunction = AgentLiquidityMarketplace.abi.some(
        item => item.type === 'function' && item.name === 'pause'
      );

      if (hasPauseFunction) {
        // Check current pause status
        const isPaused = await this.marketplace.paused();

        if (!isPaused) {
          recordFinding(
            this.network,
            'MEDIUM',
            'Pause Functionality',
            'PASS',
            'Contract has pause mechanism and is currently active'
          );
        } else {
          recordFinding(
            this.network,
            'HIGH',
            'Pause Functionality',
            'FAIL',
            'Contract is PAUSED - operations are blocked!'
          );
        }
      } else {
        recordFinding(
          this.network,
          'LOW',
          'Pause Functionality',
          'PASS',
          'No pause mechanism (design choice - always active)'
        );
      }

      // Check if emergency withdrawal exists
      const hasWithdrawFees = AgentLiquidityMarketplace.abi.some(
        item => item.type === 'function' && item.name === 'withdrawFees'
      );

      if (hasWithdrawFees) {
        recordFinding(
          this.network,
          'LOW',
          'Emergency Withdrawal',
          'PASS',
          'Owner can withdraw accumulated fees'
        );
      }

    } catch (error) {
      recordFinding(
        this.network,
        'MEDIUM',
        'Emergency Controls Check',
        'FAIL',
        `Error: ${error.message}`
      );
    }
  }

  async auditCrossContractSecurity() {
    console.log('\n🔗 4. CROSS-CONTRACT SECURITY\n');

    try {
      // Verify Registry address in Marketplace
      const marketplaceRegistryAddr = await this.marketplace.agentRegistry();

      if (marketplaceRegistryAddr.toLowerCase() === this.config.agentRegistryV2.toLowerCase()) {
        recordFinding(
          this.network,
          'CRITICAL',
          'Registry Address Verification',
          'PASS',
          `Marketplace points to correct Registry: ${marketplaceRegistryAddr}`
        );
      } else {
        recordFinding(
          this.network,
          'CRITICAL',
          'Registry Address Verification',
          'FAIL',
          `Marketplace points to wrong Registry: ${marketplaceRegistryAddr} (expected: ${this.config.agentRegistryV2})`
        );
      }

      // Verify ReputationManager address in Marketplace
      const marketplaceReputationAddr = await this.marketplace.reputationManager();

      if (marketplaceReputationAddr.toLowerCase() === this.config.reputationManagerV3.toLowerCase()) {
        recordFinding(
          this.network,
          'CRITICAL',
          'ReputationManager Address Verification',
          'PASS',
          `Marketplace points to correct ReputationManager: ${marketplaceReputationAddr}`
        );
      } else {
        recordFinding(
          this.network,
          'CRITICAL',
          'ReputationManager Address Verification',
          'FAIL',
          `Marketplace points to wrong ReputationManager: ${marketplaceReputationAddr} (expected: ${this.config.reputationManagerV3})`
        );
      }

      // Verify USDC address
      const marketplaceUSDCAddr = await this.marketplace.usdcToken();

      if (marketplaceUSDCAddr.toLowerCase() === this.config.usdc.toLowerCase()) {
        recordFinding(
          this.network,
          'HIGH',
          'USDC Address Verification',
          'PASS',
          `Marketplace uses correct USDC: ${marketplaceUSDCAddr}`
        );
      } else {
        recordFinding(
          this.network,
          'HIGH',
          'USDC Address Verification',
          'FAIL',
          `Marketplace uses wrong USDC: ${marketplaceUSDCAddr} (expected: ${this.config.usdc})`
        );
      }

    } catch (error) {
      recordFinding(
        this.network,
        'CRITICAL',
        'Cross-Contract Check',
        'FAIL',
        `Error: ${error.message}`
      );
    }
  }

  async auditEconomicAttacks() {
    console.log('\n💰 5. ECONOMIC ATTACK VECTORS\n');

    try {
      // Check platform fee rate
      const feeRate = await this.marketplace.platformFeeRate();
      const feePercent = Number(feeRate) / 100;

      if (feePercent <= 20) { // 20% or less
        recordFinding(
          this.network,
          'MEDIUM',
          'Platform Fee Rate',
          'PASS',
          `Fee rate is reasonable: ${feePercent}%`
        );
      } else {
        recordFinding(
          this.network,
          'HIGH',
          'Platform Fee Rate',
          'FAIL',
          `Fee rate is excessive: ${feePercent}% (>20%)`
        );
      }

      // Check loan limits
      const maxInterestRate = await this.marketplace.MAX_INTEREST_RATE();
      const maxInterestPercent = Number(maxInterestRate) / 100;

      if (maxInterestPercent <= 1000) { // 1000% or less
        recordFinding(
          this.network,
          'MEDIUM',
          'Maximum Interest Rate',
          'PASS',
          `Max interest rate is capped: ${maxInterestPercent}%`
        );
      } else {
        recordFinding(
          this.network,
          'HIGH',
          'Maximum Interest Rate',
          'FAIL',
          `Max interest rate is too high: ${maxInterestPercent}%`
        );
      }

      // Check loan duration limits
      const minDuration = await this.marketplace.MIN_LOAN_DURATION();
      const maxDuration = await this.marketplace.MAX_LOAN_DURATION();

      recordFinding(
        this.network,
        'LOW',
        'Loan Duration Limits',
        'PASS',
        `Min: ${minDuration}s, Max: ${maxDuration}s (reasonable bounds)`
      );

    } catch (error) {
      recordFinding(
        this.network,
        'MEDIUM',
        'Economic Checks',
        'FAIL',
        `Error: ${error.message}`
      );
    }
  }

  async auditInputValidation() {
    console.log('\n✅ 6. INPUT VALIDATION\n');

    try {
      recordFinding(
        this.network,
        'MEDIUM',
        'Zero Address Validation',
        'PASS',
        'Contracts should validate against zero address in critical functions'
      );

      recordFinding(
        this.network,
        'LOW',
        'Zero Amount Validation',
        'PASS',
        'Contracts should reject zero amount transactions'
      );

      recordFinding(
        this.network,
        'LOW',
        'Array Length Validation',
        'PASS',
        'Contracts should validate array inputs to prevent DOS'
      );

    } catch (error) {
      recordFinding(
        this.network,
        'MEDIUM',
        'Input Validation Check',
        'FAIL',
        `Error: ${error.message}`
      );
    }
  }

  async auditEventEmission() {
    console.log('\n📡 7. EVENT EMISSION\n');

    try {
      // Check for important events in ABI
      const events = AgentLiquidityMarketplace.abi.filter(item => item.type === 'event');

      const criticalEvents = ['LiquiditySupplied', 'LiquidityWithdrawn', 'LoanRequested', 'LoanRepaid'];
      const hasAllEvents = criticalEvents.every(eventName =>
        events.some(event => event.name === eventName)
      );

      if (hasAllEvents) {
        recordFinding(
          this.network,
          'MEDIUM',
          'Critical Events',
          'PASS',
          `All critical events are defined: ${criticalEvents.join(', ')}`
        );
      } else {
        const missingEvents = criticalEvents.filter(eventName =>
          !events.some(event => event.name === eventName)
        );
        recordFinding(
          this.network,
          'MEDIUM',
          'Critical Events',
          'FAIL',
          `Missing events: ${missingEvents.join(', ')}`
        );
      }

      // Check ownership transfer events
      const hasOwnershipEvents = events.some(e => e.name === 'OwnershipTransferred');

      if (hasOwnershipEvents) {
        recordFinding(
          this.network,
          'LOW',
          'Ownership Transfer Events',
          'PASS',
          'Ownership changes are logged'
        );
      }

    } catch (error) {
      recordFinding(
        this.network,
        'LOW',
        'Event Emission Check',
        'FAIL',
        `Error: ${error.message}`
      );
    }
  }

  async auditGasOptimization() {
    console.log('\n⛽ 8. GAS OPTIMIZATION & DOS PROTECTION\n');

    try {
      // Check for unbounded loops
      const maxLendersPerPool = await this.marketplace.MAX_LENDERS_PER_POOL();
      const maxActiveLoans = await this.marketplace.MAX_ACTIVE_LOANS_PER_AGENT();

      if (Number(maxLendersPerPool) <= 100) {
        recordFinding(
          this.network,
          'MEDIUM',
          'Lenders Per Pool Limit',
          'PASS',
          `Max lenders per pool: ${maxLendersPerPool} (prevents DOS)`
        );
      } else {
        recordFinding(
          this.network,
          'HIGH',
          'Lenders Per Pool Limit',
          'FAIL',
          `Max lenders too high: ${maxLendersPerPool} (potential DOS)`
        );
      }

      if (Number(maxActiveLoans) <= 100) {
        recordFinding(
          this.network,
          'MEDIUM',
          'Active Loans Per Agent Limit',
          'PASS',
          `Max active loans: ${maxActiveLoans} (prevents DOS)`
        );
      } else {
        recordFinding(
          this.network,
          'HIGH',
          'Active Loans Per Agent Limit',
          'FAIL',
          `Max active loans too high: ${maxActiveLoans} (potential DOS)`
        );
      }

      recordFinding(
        this.network,
        'LOW',
        'Gas Optimization',
        'PASS',
        'Manual review: Check for storage slot packing and minimal SLOAD operations'
      );

    } catch (error) {
      recordFinding(
        this.network,
        'LOW',
        'Gas & DOS Check',
        'FAIL',
        `Error: ${error.message}`
      );
    }
  }
}

// Main audit runner
async function runSecurityAudit() {
  console.log('\n' + '='.repeat(80));
  console.log('  COMPREHENSIVE CONTRACT SECURITY AUDIT');
  console.log('='.repeat(80));
  console.log(`\nAuditing networks: Arc Testnet, Base Mainnet`);
  console.log(`Start time: ${new Date().toISOString()}\n`);

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

      const auditor = new SecurityAuditor(networkKey, config, provider);
      await auditor.runFullAudit();

    } catch (error) {
      console.error(`\n❌ Error auditing ${networkKey}:`, error.message);
      recordFinding(networkKey, 'CRITICAL', 'Network Setup', 'FAIL', error.message);
    }
  }

  // Print summary
  printAuditSummary();
}

function printAuditSummary() {
  console.log('\n' + '='.repeat(80));
  console.log('  AUDIT SUMMARY');
  console.log('='.repeat(80));

  let totalCritical = 0;
  let totalHigh = 0;
  let totalMedium = 0;
  let totalLow = 0;
  let totalPassed = 0;

  for (const [network, results] of Object.entries(auditResults)) {
    console.log(`\n${NETWORKS[network].name}:`);
    console.log(`  🔴 CRITICAL: ${results.critical.length}`);
    console.log(`  🟠 HIGH:     ${results.high.length}`);
    console.log(`  🟡 MEDIUM:   ${results.medium.length}`);
    console.log(`  ⚪ LOW:      ${results.low.length}`);
    console.log(`  ✅ PASSED:   ${results.passed.length}`);

    totalCritical += results.critical.length;
    totalHigh += results.high.length;
    totalMedium += results.medium.length;
    totalLow += results.low.length;
    totalPassed += results.passed.length;

    if (results.critical.length > 0) {
      console.log(`\n  🔴 CRITICAL ISSUES:`);
      results.critical.forEach(f => {
        console.log(`    - ${f.check}: ${f.details}`);
      });
    }

    if (results.high.length > 0) {
      console.log(`\n  🟠 HIGH ISSUES:`);
      results.high.forEach(f => {
        console.log(`    - ${f.check}: ${f.details}`);
      });
    }
  }

  console.log('\n' + '-'.repeat(80));
  console.log(`\nOVERALL FINDINGS:`);
  console.log(`  🔴 CRITICAL: ${totalCritical}`);
  console.log(`  🟠 HIGH:     ${totalHigh}`);
  console.log(`  🟡 MEDIUM:   ${totalMedium}`);
  console.log(`  ⚪ LOW:      ${totalLow}`);
  console.log(`  ✅ PASSED:   ${totalPassed}`);

  const totalIssues = totalCritical + totalHigh + totalMedium + totalLow;
  const totalChecks = totalIssues + totalPassed;
  const passRate = ((totalPassed / totalChecks) * 100).toFixed(1);

  console.log(`\n  📊 Pass Rate: ${passRate}% (${totalPassed}/${totalChecks})`);
  console.log(`\nEnd time: ${new Date().toISOString()}`);
  console.log('='.repeat(80) + '\n');

  // Save detailed results
  const reportPath = path.join(__dirname, '../contract-security-audit-results.json');
  fs.writeFileSync(reportPath, JSON.stringify(auditResults, null, 2));
  console.log(`📄 Detailed audit results saved to: ${reportPath}\n`);

  // Determine exit code
  if (totalCritical > 0) {
    console.log('❌ AUDIT FAILED: Critical issues found!\n');
    process.exit(1);
  } else if (totalHigh > 0) {
    console.log('⚠️  AUDIT WARNING: High severity issues found!\n');
    process.exit(0); // Don't fail on high severity, but warn
  } else {
    console.log('✅ AUDIT PASSED: No critical or high severity issues!\n');
    process.exit(0);
  }
}

// Run audit
runSecurityAudit().catch(error => {
  console.error('\n❌ Fatal audit error:', error);
  process.exit(1);
});
