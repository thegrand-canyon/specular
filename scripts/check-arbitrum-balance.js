const { ethers } = require('ethers');

const DEPLOYER = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';

async function checkArbitrumBalance() {
  console.log('\n╔═══════════════════════════════════════╗');
  console.log('║   Arbitrum Deployment Check          ║');
  console.log('╚═══════════════════════════════════════╝\n');

  const provider = new ethers.JsonRpcProvider('https://arb1.arbitrum.io/rpc', 42161);

  console.log('Deployer:', DEPLOYER);
  console.log('Network: Arbitrum One (Chain ID: 42161)\n');

  const balance = await provider.getBalance(DEPLOYER);
  const balanceEth = ethers.formatEther(balance);

  console.log('💰 ETH Balance:', balanceEth, 'ETH');

  const estimatedCost = 0.005; // Estimated deployment cost
  console.log('📊 Estimated deployment cost: ~0.005 ETH');

  if (parseFloat(balanceEth) >= estimatedCost) {
    console.log('✅ Sufficient balance for deployment!\n');
    return true;
  } else if (parseFloat(balanceEth) > 0) {
    console.log('⚠️  Low balance. Deployment might fail.');
    console.log('   Recommended: Bridge 0.01 ETH to Arbitrum\n');
    return false;
  } else {
    console.log('❌ No ETH on Arbitrum.');
    console.log('   Bridge ETH: https://bridge.arbitrum.io/\n');
    return false;
  }
}

checkArbitrumBalance().catch((e) => { console.error(e); process.exit(1); });
