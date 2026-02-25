/**
 * Debug Pool Creation Failure on Base Mainnet
 * Checks all requirements for pool creation
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

// Load configurations
const baseConfig = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../src/config/base-addresses.json'), 'utf8')
);

// Load ABIs
function loadAbi(name) {
  const abiPath = path.join(__dirname, '../abis', `${name}.json`);
  const abiFile = JSON.parse(fs.readFileSync(abiPath, 'utf8'));
  return Array.isArray(abiFile) ? abiFile : abiFile.abi;
}

const marketplaceAbi = loadAbi('AgentLiquidityMarketplace');
const registryAbi = loadAbi('AgentRegistryV2');
const reputationAbi = loadAbi('ReputationManagerV3');

async function debugPoolCreation() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║  Debug Pool Creation Failure - Base Mainnet     ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  // Setup provider and contracts
  const provider = new ethers.JsonRpcProvider('https://mainnet.base.org', 8453, { batchMaxCount: 1 });

  // Agent #2 wallet (the one that's having issues)
  const privateKey = process.env.PRIVATE_KEY || process.env.AGENT_KEY;
  if (!privateKey) {
    console.error('❌ Error: PRIVATE_KEY or AGENT_KEY environment variable not set');
    console.log('\nUsage:');
    console.log('  PRIVATE_KEY=0x... node scripts/debug-pool-creation.js');
    process.exit(1);
  }

  const wallet = new ethers.Wallet(privateKey, provider);
  console.log('🔍 Debugging for wallet:', wallet.address);
  console.log('');

  // Load contracts
  const marketplace = new ethers.Contract(baseConfig.agentLiquidityMarketplace, marketplaceAbi, wallet);
  const registry = new ethers.Contract(baseConfig.agentRegistryV2, registryAbi, provider);
  const reputation = new ethers.Contract(baseConfig.reputationManagerV3, reputationAbi, provider);

  console.log('📋 Contract Addresses:');
  console.log('  Registry:', baseConfig.agentRegistryV2);
  console.log('  Reputation:', baseConfig.reputationManagerV3);
  console.log('  Marketplace:', baseConfig.agentLiquidityMarketplace);
  console.log('');

  // Step 1: Check agent registration
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Step 1: Checking Agent Registration');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  const agentId = await registry.addressToAgentId(wallet.address);
  console.log('Agent ID:', agentId.toString());

  if (agentId === 0n) {
    console.log('❌ Agent NOT registered!');
    console.log('\n💡 Solution: Register the agent first:');
    console.log('   node scripts/register-base-agent.js');
    return;
  }

  console.log('✅ Agent is registered');
  const agent = await registry.agents(agentId);
  console.log('   Agent Address:', agent.agentAddress);
  console.log('   Registered At:', new Date(Number(agent.registeredAt) * 1000).toISOString());
  console.log('   Metadata:', agent.metadata || '(none)');
  console.log('');

  // Step 2: Check reputation score
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Step 2: Checking Reputation Score');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  try {
    const score = await reputation['getReputationScore(address)'](wallet.address);
    console.log('Reputation Score:', score.toString());

    if (score < 100n) {
      console.log('⚠️  Low reputation score (minimum might be required)');
    } else {
      console.log('✅ Reputation score looks good');
    }
  } catch (error) {
    console.log('❌ Error getting reputation score:', error.message);
  }
  console.log('');

  // Step 3: Check if pool already exists
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Step 3: Checking for Existing Pool');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  try {
    const poolId = await marketplace.agentToPoolId(agentId);
    console.log('Pool ID:', poolId.toString());

    if (poolId > 0n) {
      console.log('❌ Pool already exists!');
      console.log('\n💡 Pool ID:', poolId.toString());

      // Get pool details
      const pool = await marketplace.pools(poolId);
      console.log('\nPool Details:');
      console.log('  Agent ID:', pool.agentId.toString());
      console.log('  Total Liquidity:', ethers.formatUnits(pool.totalLiquidity, 6), 'USDC');
      console.log('  Available:', ethers.formatUnits(pool.availableLiquidity, 6), 'USDC');
      console.log('  Active:', pool.isActive);
      console.log('  Lender Count:', pool.lenderCount.toString());
      return;
    }

    console.log('✅ No existing pool found');
  } catch (error) {
    console.log('Error checking pool:', error.message);
  }
  console.log('');

  // Step 4: Check marketplace authorization
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Step 4: Checking Marketplace Authorization');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  try {
    const isAuthorized = await reputation.authorizedPools(marketplace.target);
    console.log('Marketplace authorized in ReputationManager:', isAuthorized);

    if (!isAuthorized) {
      console.log('❌ Marketplace NOT authorized!');
      console.log('\n💡 Solution: The contract owner needs to authorize the marketplace:');
      console.log('   const reputation = new ethers.Contract(REPUTATION_ADDRESS, ABI, ownerWallet);');
      console.log('   await reputation.authorizePool(MARKETPLACE_ADDRESS);');
      return;
    }

    console.log('✅ Marketplace is authorized');
  } catch (error) {
    console.log('Error checking authorization:', error.message);
    console.log('Note: This might be OK if the contract has a different authorization method');
  }
  console.log('');

  // Step 5: Try to create pool
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('Step 5: Attempting to Create Pool');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

  try {
    // Estimate gas first
    console.log('Estimating gas...');
    const gasEstimate = await marketplace.createAgentPool.estimateGas();
    console.log('✅ Gas estimate:', gasEstimate.toString());
    console.log('');

    console.log('Creating pool...');
    const tx = await marketplace.createAgentPool();
    console.log('✅ Transaction sent:', tx.hash);
    console.log('Waiting for confirmation...');

    const receipt = await tx.wait();
    console.log('✅ Pool created successfully!');
    console.log('   Block:', receipt.blockNumber);
    console.log('   Gas used:', receipt.gasUsed.toString());

    // Get the new pool ID
    const newPoolId = await marketplace.agentToPoolId(agentId);
    console.log('\n🎉 Pool ID:', newPoolId.toString());

  } catch (error) {
    console.log('❌ Error creating pool:', error.message);

    if (error.data) {
      console.log('\nError Data:', error.data);
    }

    if (error.reason) {
      console.log('Reason:', error.reason);
    }

    // Try to decode the error
    if (error.data && typeof error.data === 'string') {
      console.log('\n🔍 Attempting to decode error...');
      try {
        const iface = new ethers.Interface(marketplaceAbi);
        const decodedError = iface.parseError(error.data);
        console.log('Decoded Error:', decodedError);
      } catch (decodeError) {
        console.log('Could not decode error data');
      }
    }

    console.log('\n💡 Common Issues:');
    console.log('   1. Agent not registered (✓ already checked)');
    console.log('   2. Pool already exists (✓ already checked)');
    console.log('   3. Marketplace not authorized (✓ already checked)');
    console.log('   4. Insufficient gas');
    console.log('   5. Contract paused or has additional requirements');
    console.log('   6. Reputation score too low');
  }
}

debugPoolCreation()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
