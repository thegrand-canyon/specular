/**
 * Read-only chain access: one cached JsonRpcProvider per network, contract
 * handles, and an RPC staleness check (block timestamp vs. wall clock).
 * Nothing in this module can sign.
 */
import { ethers } from 'ethers';
import { ABI, NetworkConfig } from './networks.js';

const providers = new Map<string, ethers.JsonRpcProvider>();

export const STALE_AFTER_SECONDS = 5 * 60;

export function getProvider(cfg: NetworkConfig): ethers.JsonRpcProvider {
  const key = `${cfg.name}|${cfg.rpcUrl}`;
  let p = providers.get(key);
  if (!p) {
    p = new ethers.JsonRpcProvider(cfg.rpcUrl, { chainId: cfg.chainId, name: cfg.name }, {
      staticNetwork: true,
      batchMaxCount: 1,
    });
    providers.set(key, p);
  }
  return p;
}

export interface Contracts {
  provider: ethers.JsonRpcProvider;
  marketplace: ethers.Contract;
  registry: ethers.Contract;
  reputation: ethers.Contract;
  usdc: ethers.Contract;
}

/** Test hook: per-network replacement for getContracts() (mock contracts, no RPC). Never set in production. */
const contractsOverride = new Map<string, Contracts>();
export function _setContractsForTest(network: string, contracts: Contracts | null): void {
  if (contracts) contractsOverride.set(network, contracts);
  else contractsOverride.delete(network);
  capabilityCache.delete(network);
}

export function getContracts(cfg: NetworkConfig): Contracts {
  const o = contractsOverride.get(cfg.name);
  if (o) return o;
  const provider = getProvider(cfg);
  return {
    provider,
    marketplace: new ethers.Contract(cfg.addresses.marketplace, ABI.marketplace, provider),
    registry: new ethers.Contract(cfg.addresses.registry, ABI.registry, provider),
    reputation: new ethers.Contract(cfg.addresses.reputation, ABI.reputation, provider),
    usdc: new ethers.Contract(cfg.addresses.usdc, ABI.usdc, provider),
  };
}

// ---------------------------------------------------------------------------
// Marketplace capability detection (V6 vs V6.1)
//
// V6.1 (2026-09 audit fixes) added VERSION(), previewRepayment, canTopUp,
// getActiveLoanIds, LATE_INTEREST_CAP and changed repayLoan to charge interest
// on max(duration, elapsed) capped at duration + LATE_INTEREST_CAP. The
// deployed V6 stacks (Arc testnet V6-staging, Base canonical) have none of
// those selectors: a call to one reverts with empty data. Detection is one
// VERSION() call per network, cached for the process (contracts are not
// proxied, so a deployment's version cannot change under us).
// ---------------------------------------------------------------------------

export interface MarketplaceCapabilities {
  /** 'V6' when VERSION() is absent, otherwise the string the contract reports (e.g. 'V6.1'). */
  version: string;
  /** previewRepayment / canTopUp / getActiveLoanIds / LATE_INTEREST_CAP present; repayLoan charges elapsed-time interest when late. */
  v61: boolean;
  /** seconds; 30 days on V6.1, null on V6 (no late interest at all). */
  lateInterestCapSeconds: number | null;
}

const capabilityCache = new Map<string, MarketplaceCapabilities>();

export async function marketplaceCapabilities(cfg: NetworkConfig): Promise<MarketplaceCapabilities> {
  const hit = capabilityCache.get(cfg.name);
  if (hit) return hit;
  const c = getContracts(cfg);
  let version = 'V6';
  try {
    version = String(await c.marketplace.VERSION());
  } catch {
    version = 'V6'; // selector absent -> pre-V6.1 deployment (empty revert / BAD_DATA)
  }
  const v61 = version !== 'V6';
  let lateInterestCapSeconds: number | null = null;
  if (v61) {
    try {
      lateInterestCapSeconds = Number((await c.marketplace.LATE_INTEREST_CAP()) as bigint);
    } catch {
      lateInterestCapSeconds = 30 * 86400;
    }
  }
  const caps = { version, v61, lateInterestCapSeconds };
  capabilityCache.set(cfg.name, caps);
  return caps;
}

/** Message used when a V6.1-only view is requested on a V6 deployment. */
export function unsupportedMessage(cfg: NetworkConfig, caps: MarketplaceCapabilities, what: string): string {
  return `${what} is not supported on this deployment: the ${cfg.name} marketplace ${cfg.addresses.marketplace} reports version ${caps.version} (requires V6.1 or later).`;
}

export interface RpcStatus {
  blockNumber: number;
  blockTimestamp: number;
  ageSeconds: number;
  stale: boolean;
  warning?: string;
}

/** Compare the latest block timestamp to now; flag > 5 min as stale. */
export async function rpcStatus(cfg: NetworkConfig): Promise<RpcStatus> {
  const block = await getContracts(cfg).provider.getBlock('latest');
  if (!block) throw new Error(`RPC for ${cfg.name} returned no latest block`);
  const now = Math.floor(Date.now() / 1000);
  const ageSeconds = Math.max(0, now - block.timestamp);
  const stale = ageSeconds > STALE_AFTER_SECONDS;
  return {
    blockNumber: block.number,
    blockTimestamp: block.timestamp,
    ageSeconds,
    stale,
    ...(stale
      ? { warning: `RPC data may be stale: latest block is ${ageSeconds}s old (> ${STALE_AFTER_SECONDS}s). Values below may not reflect current chain state.` }
      : {}),
  };
}

/** Wraps an RPC error into a plain-language message without leaking internals. */
export function describeRpcError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|network error|timeout/i.test(msg)) {
    return 'RPC endpoint unreachable or timed out; try again shortly.';
  }
  if (/rate limit|429|too many requests/i.test(msg)) return 'RPC endpoint rate-limited this server; try again shortly.';
  return msg.length > 300 ? msg.slice(0, 300) + '…' : msg;
}
