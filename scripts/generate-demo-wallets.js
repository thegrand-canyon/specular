/**
 * Generate Demo Agent Wallets
 * Creates 5 new wallets for demo agents
 * IMPORTANT: Save output securely and DO NOT commit to git!
 */

const { ethers } = require('ethers');

console.log('╔═══════════════════════════════════════════════════════╗');
console.log('║       Specular Demo Agent Wallet Generator           ║');
console.log('╚═══════════════════════════════════════════════════════╝\n');

console.log('⚠️  SECURITY WARNING:');
console.log('   - Save these keys in a secure location');
console.log('   - DO NOT commit to git');
console.log('   - Use for demo purposes only');
console.log('   - For production, use hardware wallets or KMS\n');

const agents = [
  { name: 'Conservative Lender', strategy: 'Lend to high-reputation agents' },
  { name: 'Active Borrower', strategy: 'Borrow, repay, build credit' },
  { name: 'Yield Optimizer', strategy: 'Dual-sided (lend + borrow)' },
  { name: 'Small Pool Tester', strategy: 'Small amounts, high frequency' },
  { name: 'Reputation Climber', strategy: '0 to 1000 reputation journey' }
];

console.log('Generating 5 demo agent wallets...\n');
console.log('═'.repeat(80));

for (let i = 0; i < agents.length; i++) {
  const wallet = ethers.Wallet.createRandom();
  const agent = agents[i];

  console.log(`\n🤖 AGENT ${i + 1}: ${agent.name}`);
  console.log(`   Strategy: ${agent.strategy}`);
  console.log(`   Address:  ${wallet.address}`);
  console.log(`   Private Key: ${wallet.privateKey}`);
  console.log(`\n   Environment Variable:`);
  console.log(`   AGENT${i + 1}_KEY=${wallet.privateKey}`);
  console.log(`   AGENT${i + 1}_ADDRESS=${wallet.address}`);
}

console.log('\n' + '═'.repeat(80));
console.log('\n📝 NEXT STEPS:\n');
console.log('1. Save these keys securely (password manager, .env file)');
console.log('2. Fund wallets with:');
console.log('   - Arc Testnet: ETH for gas + test USDC');
console.log('   - Base Mainnet: ETH for gas + real USDC');
console.log('3. Run deploy script:');
console.log('   AGENT1_KEY=0x... AGENT2_KEY=0x... ... node scripts/deploy-demo-agents.js');
console.log('\n⚠️  Remember: NEVER commit private keys to git!\n');

// Generate .env template
console.log('═'.repeat(80));
console.log('\n📄 .env Template (copy to your .env file):\n');
console.log('# Demo Agent Wallets - DO NOT COMMIT');
console.log('# Generated:', new Date().toISOString());
console.log('');

for (let i = 0; i < agents.length; i++) {
  const wallet = ethers.Wallet.createRandom();
  console.log(`AGENT${i + 1}_KEY=${wallet.privateKey}`);
}

console.log('\n# Network Configuration');
console.log('NETWORK=arc  # or "base" for mainnet');
console.log('ARC_TESTNET_RPC_URL=https://arc-testnet.drpc.org');
console.log('\n# Agent Configuration');
console.log('CYCLES=100  # Number of strategy cycles to run');
console.log('');
console.log('═'.repeat(80));
console.log('\n✅ Wallet generation complete!\n');
