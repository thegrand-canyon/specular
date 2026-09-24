// READ-ONLY: verify every address a user can see on the public site / in frontend code
// against the chain. No transactions.
require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
const { ethers } = require('ethers');

const RPCS = {
  base:        'https://mainnet.base.org',
  arbitrum:    'https://arb1.arbitrum.io/rpc',
  arcMainnet:  process.env.ARC_MAINNET_RPC_URL || 'https://rpc.mainnet.arc.io',
  arcTestnet:  process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
};

const TARGETS = [
  // [label, network, address, expectedKind]
  ['LIVE site Base AgentRegistryV2',       'base',       '0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa', 'registry'],
  ['LIVE site Base ReputationManagerV3',   'base',       '0xf19b1780A84668C8dfB6b4E84C08e457dB3B0527', 'reputation'],
  ['LIVE site Base LiquidityMarketplace',  'base',       '0xd7b4dEE74C61844DFA75aEbe224e4635463b1C8f', 'marketplace'],
  ['CONFIG  Base canonical V6 marketplace','base',       '0x0a4e3C745aB95aceb45B05C28D89fe4Db8815F9a', 'marketplace'],
  ['LIVE site Base USDC',                  'base',       '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'token'],
  ['LIVE site Arbitrum AgentRegistryV2',   'arbitrum',   '0x6F1EbF50290f6D4A9947E9EB77f98a683684fBF5', 'registry'],
  ['LIVE site Arbitrum ReputationMgrV3',   'arbitrum',   '0x1577Eb9985CcA859F25ED2EDaeD16A464ADFaE5e', 'reputation'],
  ['LIVE site Arbitrum Marketplace',       'arbitrum',   '0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa', 'marketplace'],
  ['LIVE site Arbitrum USDC',              'arbitrum',   '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', 'token'],
  ['CONFIG  ArcMainnet RegistryV2',        'arcMainnet', '0x6F1EbF50290f6D4A9947E9EB77f98a683684fBF5', 'registry'],
  ['CONFIG  ArcMainnet ReputationV4',      'arcMainnet', '0x12953e732e5D1aFdA640554125367d1CEC2ac4FB', 'reputation'],
  ['CONFIG  ArcMainnet Marketplace V6.2',  'arcMainnet', '0xCb23f2fb03Bfd4775Cc0e76E28f64c1e545071be', 'marketplace'],
  ['GetStarted.jsx Arc "mainnet" mktpl',   'arcMainnet', '0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa', 'marketplace'],
  ['GetStarted.jsx Arc "mainnet" reput.',  'arcMainnet', '0x1577Eb9985CcA859F25ED2EDaeD16A464ADFaE5e', 'reputation'],
  ['LIVE site ArcTestnet Registry',        'arcTestnet', '0x741C03c0d95d2c15E479CE1c7E69B3196d86faD7', 'registry'],
  ['LIVE site ArcTestnet ReputationV3',    'arcTestnet', '0x94F2fa47c4488202a46dAA9038Ed9C9c4c07467F', 'reputation'],
  ['LIVE site ArcTestnet Marketplace v4',  'arcTestnet', '0x048363A325A5B188b7FF157d725C5e329f0171D3', 'marketplace'],
  ['LIVE site ArcTestnet MockUSDC',        'arcTestnet', '0xf2807051e292e945751A25616705a9aadfb39895', 'token'],
];

const PROBE = [
  'function owner() view returns (address)',
  'function paused() view returns (bool)',
  'function totalAgents() view returns (uint256)',
  'function loanCounter() view returns (uint256)',
  'function symbol() view returns (string)',
  'function getReputationScore(address) view returns (uint256)',
  'function calculateCreditLimit(address) view returns (uint256)',
  'function calculateInterestRate(address) view returns (uint256)',
  'function calculateCollateralRequirement(address) view returns (uint256)',
];

(async () => {
  const providers = {};
  for (const [k, url] of Object.entries(RPCS)) {
    try {
      providers[k] = new ethers.JsonRpcProvider(url, undefined, { batchMaxCount: 1 });
      const n = await providers[k].getNetwork();
      console.log(`RPC ${k.padEnd(11)} ok chainId=${n.chainId} (${url})`);
    } catch (e) { console.log(`RPC ${k.padEnd(11)} FAIL ${e.shortMessage || e.message}`); providers[k] = null; }
  }
  console.log('');
  const ZERO = '0x0000000000000000000000000000000000000001';
  for (const [label, net, addr, kind] of TARGETS) {
    const p = providers[net];
    if (!p) { console.log(`${label.padEnd(40)} | ${net.padEnd(10)} | RPC UNAVAILABLE`); continue; }
    let code = '0x';
    try { code = await p.getCode(addr); } catch (e) { console.log(`${label.padEnd(40)} | ${net.padEnd(10)} | getCode error ${e.shortMessage||e.message}`); continue; }
    const has = code && code !== '0x';
    const c = new ethers.Contract(addr, PROBE, p);
    const facts = [];
    if (has) {
      for (const fn of ['owner','paused','symbol','totalAgents','loanCounter']) {
        try { const v = await c[fn](); facts.push(`${fn}=${v}`); } catch {}
      }
      if (kind === 'reputation') {
        for (const fn of ['calculateCreditLimit','calculateInterestRate','calculateCollateralRequirement']) {
          try { const v = await c[fn](ZERO); facts.push(`${fn}(0x..01)=${v}`); } catch {}
        }
      }
    }
    console.log(`${label.padEnd(40)} | ${net.padEnd(10)} | code=${has ? (code.length/2-1)+'B' : 'NONE ***'} | ${facts.join(' ')}`);
  }
})();
