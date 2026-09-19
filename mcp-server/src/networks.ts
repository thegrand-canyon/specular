/**
 * Network registry for the Specular MCP/REST server.
 *
 * Addresses are resolved ONLY from the repo's src/config/*.json files (or the
 * copy shipped inside the container), never from request input. RPC URLs can
 * be overridden per network via env, addresses cannot.
 *
 * There is deliberately NO default network: every call must name one, because
 * `arc-mainnet` and `base` move real USDC.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

export type NetworkName = 'base' | 'arc-staging' | 'arc-mainnet';

export const ALL_NETWORKS: readonly NetworkName[] = ['base', 'arc-staging', 'arc-mainnet'] as const;

export interface NetworkConfig {
  name: NetworkName;
  chainId: number;
  rpcUrl: string;
  explorerTx: string;
  explorerAddress: string;
  /** True when the network moves real USDC. */
  realMoney: boolean;
  label: string;
  addresses: {
    marketplace: string;
    registry: string;
    reputation: string;
    usdc: string;
  };
  configFile: string;
  usdcDecimals: 6;
}

const here = path.dirname(fileURLToPath(import.meta.url));
// dist/networks.js -> mcp-server -> repo root
const MCP_ROOT = path.resolve(here, '..');
const REPO_ROOT = process.env.SPECULAR_REPO_ROOT
  ? path.resolve(process.env.SPECULAR_REPO_ROOT)
  : path.resolve(MCP_ROOT, '..');

interface NetworkSpec {
  file: string;
  chainId: number;
  defaultRpc: string;
  rpcEnv: string;
  explorerTx: string;
  explorerAddress: string;
  realMoney: boolean;
  label: string;
}

const SPECS: Record<NetworkName, NetworkSpec> = {
  base: {
    file: 'base-addresses.json',
    chainId: 8453,
    defaultRpc: 'https://mainnet.base.org',
    rpcEnv: 'SPECULAR_RPC_BASE',
    explorerTx: 'https://basescan.org/tx/',
    explorerAddress: 'https://basescan.org/address/',
    realMoney: true,
    label: 'Base Mainnet (REAL USDC)',
  },
  'arc-staging': {
    file: 'arc-testnet-v6-addresses.json',
    chainId: 5042002,
    defaultRpc: 'https://arc-testnet.drpc.org',
    rpcEnv: 'SPECULAR_RPC_ARC_STAGING',
    explorerTx: 'https://testnet.arcscan.app/tx/',
    explorerAddress: 'https://testnet.arcscan.app/address/',
    realMoney: false,
    label: 'Arc Testnet V6-staging (test USDC, no real value)',
  },
  'arc-mainnet': {
    file: 'arc-mainnet-addresses.json',
    chainId: 5042,
    defaultRpc: 'https://rpc.mainnet.arc.io',
    rpcEnv: 'SPECULAR_RPC_ARC_MAINNET',
    explorerTx: 'https://explorer.arc.io/tx/',
    explorerAddress: 'https://explorer.arc.io/address/',
    realMoney: true,
    label: 'Arc Mainnet (REAL USDC)',
  },
};

function findConfigFile(file: string): string {
  const candidates = [
    path.join(REPO_ROOT, 'src', 'config', file),
    path.join(MCP_ROOT, 'config', file), // container layout fallback
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error(`Specular config ${file} not found (looked in ${candidates.join(', ')})`);
}

function readAbi(name: string): ethers.InterfaceAbi {
  const candidates = [
    path.join(MCP_ROOT, 'abi', `${name}.json`),
    path.join(REPO_ROOT, 'artifacts', 'contracts', 'core', `${name}.sol`, `${name}.json`),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return JSON.parse(fs.readFileSync(c, 'utf8')).abi;
  }
  throw new Error(`ABI ${name} not found; run "node scripts/extract-abis.mjs" in mcp-server/`);
}

const cache = new Map<NetworkName, NetworkConfig>();

export function isNetworkName(x: unknown): x is NetworkName {
  return typeof x === 'string' && (ALL_NETWORKS as readonly string[]).includes(x);
}

/** Networks this process is allowed to serve (env SPECULAR_ENABLED_NETWORKS, comma separated). */
export function enabledNetworks(): NetworkName[] {
  const raw = process.env.SPECULAR_ENABLED_NETWORKS;
  if (!raw) return [...ALL_NETWORKS];
  const out: NetworkName[] = [];
  for (const part of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!isNetworkName(part)) throw new Error(`SPECULAR_ENABLED_NETWORKS: unknown network "${part}"`);
    out.push(part);
  }
  return out;
}

export class NetworkError extends Error {
  readonly status = 400;
}

/**
 * Resolve a network by name. Throws a NetworkError with an actionable message
 * when the name is missing, unknown, or disabled on this deployment.
 */
export function getNetwork(name: unknown): NetworkConfig {
  if (name === undefined || name === null || name === '') {
    throw new NetworkError(
      `"network" is required (one of: ${ALL_NETWORKS.join(', ')}). There is no default: base and arc-mainnet move real USDC; use arc-staging to test.`,
    );
  }
  if (!isNetworkName(name)) {
    throw new NetworkError(`Unknown network "${String(name)}". Valid: ${ALL_NETWORKS.join(', ')}.`);
  }
  if (!enabledNetworks().includes(name)) {
    throw new NetworkError(`Network "${name}" is not enabled on this server (enabled: ${enabledNetworks().join(', ')}).`);
  }
  const hit = cache.get(name);
  if (hit) return hit;

  const spec = SPECS[name];
  const file = findConfigFile(spec.file);
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (json.chainId !== undefined && Number(json.chainId) !== spec.chainId) {
    throw new Error(`chainId mismatch for ${name}: config says ${json.chainId}, server expects ${spec.chainId}`);
  }
  const marketplace = json.agentLiquidityMarketplace_v6 || json.agentLiquidityMarketplace;
  const addresses = {
    marketplace: ethers.getAddress(marketplace),
    registry: ethers.getAddress(json.agentRegistryV2),
    reputation: ethers.getAddress(json.reputationManagerV3),
    usdc: ethers.getAddress(json.usdc),
  };
  const cfg: NetworkConfig = {
    name,
    chainId: spec.chainId,
    rpcUrl: process.env[spec.rpcEnv] || json.rpcUrl || spec.defaultRpc,
    explorerTx: spec.explorerTx,
    explorerAddress: spec.explorerAddress,
    realMoney: spec.realMoney,
    label: spec.label,
    addresses,
    configFile: path.relative(REPO_ROOT, file),
    usdcDecimals: 6,
  };
  cache.set(name, cfg);
  return cfg;
}

/** Contract ABIs (bundled in mcp-server/abi, refreshed from hardhat artifacts by scripts/extract-abis.mjs). */
export const ABI = {
  marketplace: readAbi('AgentLiquidityMarketplaceV6'),
  registry: readAbi('AgentRegistryV2'),
  reputation: readAbi('ReputationManagerV3'),
  usdc: [
    'function balanceOf(address owner) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function decimals() view returns (uint8)',
  ] as string[],
};

export const IFACE = {
  marketplace: new ethers.Interface(ABI.marketplace),
  registry: new ethers.Interface(ABI.registry),
  reputation: new ethers.Interface(ABI.reputation),
  usdc: new ethers.Interface(ABI.usdc),
};

export function publicNetworkInfo(cfg: NetworkConfig) {
  return {
    network: cfg.name,
    label: cfg.label,
    chainId: cfg.chainId,
    realMoney: cfg.realMoney,
    rpcUrl: cfg.rpcUrl,
    explorerTx: cfg.explorerTx,
    contracts: { ...cfg.addresses },
    usdcDecimals: cfg.usdcDecimals,
    addressSource: cfg.configFile,
  };
}
