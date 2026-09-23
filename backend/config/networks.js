/**
 * Network Configuration for Specular API
 * Supports: Arc Testnet, Arc Mainnet, Base Mainnet, Arbitrum One
 *
 * ⚠️ NOT THE SOURCE OF TRUTH. Nothing currently imports this module (verified
 * 2026-09-21); the live APIs read `src/config/*-addresses.json` instead, and the
 * hosted agent server (mcp-server/) resolves addresses ONLY from those files.
 * If you revive this module, re-check every address against src/config/ first —
 * these were stale and pointed Base at a PAUSED archived marketplace until
 * 2026-09-21.
 */

export const NETWORKS = {
  arc: {
    name: 'Arc Testnet',
    chainId: 5042002,
    rpcUrl: process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
    explorer: 'https://testnet.arcscan.app',
    contracts: {
      registry: '0x741C03c0d95d2c15E479CE1c7E69B3196d86faD7',
      reputation: '0x94F2fa47c4488202a46dAA9038Ed9C9c4c07467F',
      marketplace: '0x048363A325A5B188b7FF157d725C5e329f0171D3',
      usdc: '0xf2807051e292e945751A25616705a9aadfb39895'
    },
    isTestnet: true
  },

  // Arc Mainnet (chainId 5042). USDC is the native gas token; the 6-decimal
  // ERC-20 view at 0x3600…0000 is what the protocol uses.
  'arc-mainnet': {
    name: 'Arc Mainnet',
    chainId: 5042,
    rpcUrl: process.env.ARC_MAINNET_RPC_URL || 'https://rpc.mainnet.arc.io',
    explorer: 'https://explorer.arc.io',
    contracts: {
      registry: '0x6F1EbF50290f6D4A9947E9EB77f98a683684fBF5',
      reputation: '0x1577Eb9985CcA859F25ED2EDaeD16A464ADFaE5e',
      marketplace: '0x358c5E69f712A4b3558333090a45A054bAeEb282', // V6.1
      usdc: '0x3600000000000000000000000000000000000000'
    },
    isTestnet: false
  },

  base: {
    name: 'Base Mainnet',
    chainId: 8453,
    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    explorer: 'https://basescan.org',
    contracts: {
      registry: '0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa',
      reputation: '0xf19b1780A84668C8dfB6b4E84C08e457dB3B0527',
      // Canonical Base V6 (2026-05-17 migration). The previous value here,
      // 0xd7b4dEE74C61844DFA75aEbe224e4635463b1C8f, is the v4 marketplace that
      // has been PAUSED since that migration — using it would have failed every write.
      marketplace: '0x0a4e3C745aB95aceb45B05C28D89fe4Db8815F9a',
      usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
    },
    isTestnet: false
  },

  arbitrum: {
    name: 'Arbitrum One',
    chainId: 42161,
    rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
    explorer: 'https://arbiscan.io',
    contracts: {
      registry: '0x6F1EbF50290f6D4A9947E9EB77f98a683684fBF5',
      reputation: '0x1577Eb9985CcA859F25ED2EDaeD16A464ADFaE5e',
      marketplace: '0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa',
      usdc: '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
    },
    isTestnet: false
  }
};

// Default network
export const DEFAULT_NETWORK = process.env.DEFAULT_NETWORK || 'base';

// Validate network name
export function isValidNetwork(network) {
  return Object.keys(NETWORKS).includes(network);
}

// Get network config
export function getNetwork(network) {
  if (!isValidNetwork(network)) {
    throw new Error(`Invalid network: ${network}. Valid networks: ${Object.keys(NETWORKS).join(', ')}`);
  }
  return NETWORKS[network];
}

// Get all networks
export function getAllNetworks() {
  return NETWORKS;
}

// Get mainnet networks only
export function getMainnetNetworks() {
  return Object.entries(NETWORKS)
    .filter(([_, config]) => !config.isTestnet)
    .reduce((acc, [key, config]) => ({ ...acc, [key]: config }), {});
}

// Get testnet networks only
export function getTestnetNetworks() {
  return Object.entries(NETWORKS)
    .filter(([_, config]) => config.isTestnet)
    .reduce((acc, [key, config]) => ({ ...acc, [key]: config }), {});
}

export default NETWORKS;
