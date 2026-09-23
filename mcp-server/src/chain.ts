/**
 * Read-only chain access: one cached JsonRpcProvider per network, contract
 * handles, and an RPC staleness check (block timestamp vs. wall clock).
 * Nothing in this module can sign.
 */
import { ethers } from 'ethers';
import { ABI, NetworkConfig, publicRpcUrlFor } from './networks.js';
import {
  getPool,
  isUpstreamUnavailable,
  ResilientJsonRpcProvider,
  rpcMaxAttempts,
  rpcTimeoutMs,
  UpstreamFailedError,
  UpstreamUnavailableError,
} from './rpc.js';
import { isRequestDeadlineError } from './deadline.js';
import { invalidateAllCaches } from './cache.js';

const providers = new Map<string, ethers.JsonRpcProvider>();

export const STALE_AFTER_SECONDS = 5 * 60;

/**
 * Upstream RPC bounds. 2026-09-20 (H-5) introduced a per-attempt timeout and an
 * attempt cap; 2026-09-22 moved the whole transport into rpc.ts, so the same two
 * knobs now govern a health-aware endpoint RING (a failure moves to the next
 * endpoint instead of retrying the dead one) and every attempt is additionally
 * clamped by the request deadline (deadline.ts).
 */
export { rpcTimeoutMs, rpcMaxAttempts };

/**
 * One provider per network, backed by the resilient multi-endpoint transport:
 * failover + health/backoff + circuit breaker + response cache + coalescing.
 * Every read path in the server — rpcStatus, every contract view, eth_call in
 * simulate — inherits all of it because the transport is the seam.
 */
export function getProvider(cfg: NetworkConfig): ethers.JsonRpcProvider {
  const key = `${cfg.name}|${cfg.rpcUrls.join(',')}`;
  const hit = providers.get(key);
  if (hit) return hit;
  const pool = getPool(cfg.name, cfg.rpcUrls, cfg.rpcUrls.map((u) => publicRpcUrlFor(cfg.name, u)));
  const p: ethers.JsonRpcProvider = new ResilientJsonRpcProvider(pool, { chainId: cfg.chainId, name: cfg.name });
  providers.set(key, p);
  return p;
}

/** Test/ops hook: drop cached providers so a changed endpoint list takes effect. */
export function _clearProviderCache(): void {
  providers.clear();
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
  reputationCapabilityCache.delete(network);
  // Swapping the contracts invalidates every cached answer (JSON-RPC level and
  // read-route level); without this a suite that re-mocks the same call would
  // be served the previous mock's result.
  invalidateAllCaches();
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
// Capability detection — THREE marketplace generations, TWO reputation ones
//
//  | generation | VERSION()  | v61 | v62 | adds                                          |
//  |------------|------------|-----|-----|-----------------------------------------------|
//  | V6         | (absent)   |  no |  no | baseline                                      |
//  | V6.1       | "V6.1"     | yes |  no | previewRepayment/canTopUp/getActiveLoanIds,   |
//  |            |            |     |     | LATE_INTEREST_CAP, elapsed-time late interest |
//  | V6.2 (V7)  | "V6.2"     | yes | yes | requiredSelfStake/selfStake, first-loss lock, |
//  |            |            |     |     | creator exempt from minSupplyAmount           |
//
//  | reputation | VERSION()  | v4  | adds                                                |
//  |------------|------------|-----|-----------------------------------------------------|
//  | V3         | (absent)   |  no | tier table compiled in (25,000 / 50,000)            |
//  | V4 (V7)    | "V4"       | yes | tier table ON CHAIN + owner-settable, credit ladder,|
//  |            |            |     | post-default lockout, MAX_TIER_LIMIT ceiling        |
//
// Base mainnet and the current Arc deployments are V6.1/V3 — nothing may assume
// V6.2/V4. Detection is one VERSION() call per contract per network, cached for
// the process (contracts are not proxied, so a version cannot change under us).
// ---------------------------------------------------------------------------

/**
 * [X-1 2026-09-23] Did this failure mean "the deployed bytecode has no such
 * function", or "the RPC failed while I asked"?
 *
 * Only the former may answer a capability question. ethers v6 collapses BOTH a
 * JSON-RPC `-32005 rate limit exceeded` and a genuine data-less revert into the
 * same `CALL_EXCEPTION: missing revert data`, so the error class alone cannot
 * decide it — but the underlying JSON-RPC error code can, and ethers preserves
 * it on `info.error.code`. Measured on the live Arc endpoints 2026-09-23:
 *   missing selector / array out of bounds -> {code: 3,      "execution reverted"}
 *   rate limit                             -> {code: -32005, "rate limit exceeded"}
 * Anything transport-shaped (HTTP 5xx, timeout, socket reset, our own transport
 * errors) is transient by construction.
 */
const TRANSIENT_RPC_CODES = new Set([-32005, -32016, -32002, -32029, -32603, 429]);

export function isTransientRpcFailure(e: unknown): boolean {
  if (!e) return false;
  if (isUpstreamUnavailable(e) || e instanceof UpstreamFailedError || isRequestDeadlineError(e)) return true;
  const any = e as any;
  // a revert that carries a payload is a definite contract-level answer
  if (any.code === 'CALL_EXCEPTION' && ((any.data && any.data !== '0x') || any.reason)) return false;
  const rpcCode = any?.info?.error?.code ?? any?.error?.code ?? any?.cause?.info?.error?.code;
  if (typeof rpcCode === 'number') {
    if (TRANSIENT_RPC_CODES.has(rpcCode)) return true;
    if (rpcCode === 3) return false; // "execution reverted" — a definite answer
  }
  const msg = `${any.message ?? ''} ${any.shortMessage ?? ''} ${any?.info?.error?.message ?? ''}`;
  if (/rate limit|too many requests|throttl|capacity|overloaded|try again|timeout|timed out|socket hang up|ECONN|EAI_AGAIN|fetch failed|network error|\b(429|500|502|503|504)\b/i.test(msg)) return true;
  return ['TIMEOUT', 'NETWORK_ERROR', 'SERVER_ERROR', 'UNKNOWN_ERROR'].includes(any.code);
}

/** Raised when the chain could not be asked what generation it is. Never cached. */
export class CapabilityUnknownError extends Error {
  readonly status = 503;
  constructor(cfg: NetworkConfig, which: 'marketplace' | 'reputation', address: string, cause: unknown) {
    super(
      `Could not determine the ${which} generation of ${cfg.name} ${address}: the RPC failed while probing it ` +
      `(${describeRpcError(cause)}). Refusing to guess — guessing the older generation would publish a stale, ` +
      'hardcoded credit-tier table and refuse the V7 views. Retry shortly.',
    );
    (this as any).cause = cause;
  }
}

/** 'V6' -> 6, 'V6.1' -> 6.1, 'V6.2' -> 6.2. Unrecognised strings sort as 6 (most conservative). */
export function versionOrdinal(v: string): number {
  const m = /^V(\d+)(?:\.(\d+))?$/.exec(String(v ?? '').trim());
  if (!m) return 6;
  return Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0);
}

export interface MarketplaceCapabilities {
  /** 'V6' when VERSION() is absent, otherwise the string the contract reports (e.g. 'V6.1', 'V6.2'). */
  version: string;
  /** Numeric ordering of `version`, so gates are `>=` comparisons rather than string equality. */
  ordinal: number;
  /** previewRepayment / canTopUp / getActiveLoanIds / LATE_INTEREST_CAP present; repayLoan charges elapsed-time interest when late. */
  v61: boolean;
  /** requiredSelfStake / selfStake present; first-loss self-stake gate + withdrawal lock; creator exempt from minSupplyAmount. */
  v62: boolean;
  /** seconds; 30 days on V6.1+, null on V6 (no late interest at all). */
  lateInterestCapSeconds: number | null;
}

export interface ReputationCapabilities {
  /** 'V3' when VERSION() is absent, otherwise the string the contract reports ('V4'). */
  version: string;
  /** Tier table is on-chain state (tierLimits/tierCollateralPct/tierInterestBps) rather than a compiled-in constant. */
  v4: boolean;
}

const capabilityCache = new Map<string, MarketplaceCapabilities>();
const reputationCapabilityCache = new Map<string, ReputationCapabilities>();

export async function marketplaceCapabilities(cfg: NetworkConfig): Promise<MarketplaceCapabilities> {
  const hit = capabilityCache.get(cfg.name);
  if (hit) return hit;
  const c = getContracts(cfg);
  let version = 'V6';
  try {
    version = String(await c.marketplace.VERSION());
  } catch (e) {
    // [X-1] Only a DEFINITE "no such selector" may answer this. A transient RPC
    // failure is surfaced and NOT cached; caching it downgraded a V6.2/V4
    // deployment to V6/V3 for the life of the process.
    if (isTransientRpcFailure(e)) throw new CapabilityUnknownError(cfg, 'marketplace', cfg.addresses.marketplace, e);
    version = 'V6'; // selector absent -> pre-V6.1 deployment (empty revert / BAD_DATA)
  }
  const ordinal = versionOrdinal(version);
  const v61 = version !== 'V6';
  let v62 = ordinal >= 6.2;
  if (v62) {
    // Belt and braces: confirm the self-stake view actually answers, so a
    // mislabelled or partially-migrated deployment cannot make the server skip
    // the pre-checks that exist to stop an "Insufficient self-stake" revert.
    try {
      await c.marketplace.requiredSelfStake(0, 0);
    } catch (e) {
      if (isTransientRpcFailure(e)) throw new CapabilityUnknownError(cfg, 'marketplace', cfg.addresses.marketplace, e);
      v62 = false;
    }
  }
  let lateInterestCapSeconds: number | null = null;
  if (v61) {
    try {
      lateInterestCapSeconds = Number((await c.marketplace.LATE_INTEREST_CAP()) as bigint);
    } catch {
      lateInterestCapSeconds = 30 * 86400;
    }
  }
  const caps = { version, ordinal, v61, v62, lateInterestCapSeconds };
  capabilityCache.set(cfg.name, caps);
  return caps;
}

/** Reputation manager generation. V4 publishes the credit tier table as on-chain state. */
export async function reputationCapabilities(cfg: NetworkConfig): Promise<ReputationCapabilities> {
  const hit = reputationCapabilityCache.get(cfg.name);
  if (hit) return hit;
  const c = getContracts(cfg);
  let version = 'V3';
  try {
    version = String(await c.reputation.VERSION());
  } catch (e) {
    // [X-1] see marketplaceCapabilities: a transient failure here would publish
    // the v3-constant tier table (25,000 / 50,000 USDC) for a V4 deployment
    // whose real on-chain limits are 2,500 / 5,000.
    if (isTransientRpcFailure(e)) throw new CapabilityUnknownError(cfg, 'reputation', cfg.addresses.reputation, e);
    version = 'V3'; // selector absent -> pre-V7 reputation manager
  }
  const caps = { version, v4: version !== 'V3' };
  reputationCapabilityCache.set(cfg.name, caps);
  return caps;
}

/** Message used when a newer-generation view is requested on an older deployment. */
export function unsupportedMessage(cfg: NetworkConfig, caps: { version: string }, what: string, requires = 'V6.1'): string {
  return `${what} is not supported on this deployment: the ${cfg.name} marketplace ${cfg.addresses.marketplace} reports version ${caps.version} (requires ${requires} or later).`;
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
  // Our own transport errors already carry a safe, actionable message.
  if (isUpstreamUnavailable(e)) return (e as UpstreamUnavailableError).message;
  if (isRequestDeadlineError(e)) return 'Request exceeded the server time budget before the chain answered; try again shortly.';
  if (e instanceof UpstreamFailedError) return e.message;
  const msg = e instanceof Error ? e.message : String(e);
  if (/ECONNREFUSED|ENOTFOUND|ECONNRESET|ETIMEDOUT|fetch failed|network error|timeout|timed out|socket hang up/i.test(msg)) {
    return 'RPC endpoint unreachable or timed out; try again shortly.';
  }
  if (/rate limit|429|too many requests|throttl/i.test(msg)) return 'RPC endpoint rate-limited this server; try again shortly.';
  // Never echo upstream details (URLs, library versions) to clients.
  const cleaned = msg.replace(/\(.*?version=6\.[\d.]+\)/g, '').replace(/https?:\/\/\S+/g, '[rpc]').trim();
  return cleaned.length > 300 ? cleaned.slice(0, 300) + '…' : cleaned || 'upstream RPC error';
}
