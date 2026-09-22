/**
 * Resilient JSON-RPC transport (2026-09-22 RPC-resilience round).
 *
 * WHY: the 2026-09-20 hosted-server report established that the server is not
 * the constraint — cached routes sustain ~13k rps at 85 MiB — the upstream
 * public RPC is. Live `/v1/arc-mainnet/status` measured p95 = 164 s at
 * concurrency 5, and one machine exhausted two public Arc providers in an
 * afternoon. A single `/v1/{net}/status` read fans out ~27 `eth_call`s, so
 * twenty concurrent callers asked the upstream the same ~540 questions.
 *
 * WHAT: this module replaces ethers' single-endpoint FetchRequest transport with
 *
 *   1. multi-endpoint failover     — comma-separated list per network, health-aware
 *   2. health tracking + backoff   — 429/timeout/5xx mark an endpoint cold, exponentially
 *   3. a per-method response cache — network|method|params, per-method TTLs
 *   4. request coalescing          — identical concurrent upstream reads share one promise
 *   5. bounded waits               — per-attempt timeout clamped by the request deadline
 *   6. a per-network circuit breaker — all endpoints cold => fail fast, no queueing
 *
 * Nothing here can sign. Write methods (`eth_sendRawTransaction`, nonce reads)
 * are explicitly never cached and never coalesced.
 */
import { ethers } from 'ethers';
import { registerCache, stableKey, TtlCache, CacheStats } from './cache.js';
import { assertBudget, attemptBudgetMs, isRequestDeadlineError, RequestDeadlineError } from './deadline.js';

// --------------------------------------------------------------------- env
const num = (name: string, dflt: number, min = 0): number => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n >= min ? n : dflt;
};
const flag = (name: string, dflt: boolean): boolean => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  return !/^(0|false|off|no)$/i.test(raw.trim());
};

/** Per-attempt upstream timeout. Lowered from 15 s to 8 s in this round: with failover, one slow endpoint must not eat the whole request budget. */
export const rpcTimeoutMs = (): number => num('SPECULAR_RPC_TIMEOUT_MS', 8_000, 1);
/** Total upstream attempts for ONE JSON-RPC call, walking the endpoint ring. */
export const rpcMaxAttempts = (): number => Math.max(1, Math.trunc(num('SPECULAR_RPC_MAX_ATTEMPTS', 3, 1)));
/** Consecutive non-429 failures before an endpoint is taken out of rotation. A 429 takes it out immediately. */
export const failureThreshold = (): number => Math.max(1, Math.trunc(num('SPECULAR_RPC_FAILURE_THRESHOLD', 2, 1)));
export const backoffBaseMs = (): number => num('SPECULAR_RPC_BACKOFF_MS', 1_000, 1);
export const backoffMaxMs = (): number => num('SPECULAR_RPC_BACKOFF_MAX_MS', 30_000, 1);

export const cacheEnabled = (): boolean => flag('SPECULAR_RPC_CACHE', true);
export const coalesceEnabled = (): boolean => flag('SPECULAR_RPC_COALESCE', true);
const ttlHead = () => num('SPECULAR_RPC_CACHE_HEAD_MS', 2_000);
const ttlCall = () => num('SPECULAR_RPC_CACHE_CALL_MS', 4_000);
const ttlStatic = () => num('SPECULAR_RPC_CACHE_STATIC_MS', 3_600_000);
const ttlImmutable = () => num('SPECULAR_RPC_CACHE_IMMUTABLE_MS', 300_000);

// ------------------------------------------------------------ error classes
export type RpcErrorClass = 'rate_limited' | 'timeout' | 'connection' | 'server_error' | 'bad_response' | 'other';

/** All endpoints for a network are cold (circuit open). Mapped to HTTP 503. */
export class UpstreamUnavailableError extends Error {
  readonly kind = 'upstream_unavailable';
  constructor(readonly network: string, readonly retryAfterSeconds: number, message?: string) {
    super(message ?? `Network "${network}" is temporarily unavailable: every configured RPC endpoint is cold. Retry in ${retryAfterSeconds}s.`);
    this.name = 'UpstreamUnavailableError';
  }
}
/** Every attempt for this call failed (endpoints still in rotation). Mapped to HTTP 502. */
export class UpstreamFailedError extends Error {
  readonly kind = 'upstream_failed';
  constructor(readonly network: string, readonly errorClass: RpcErrorClass, message: string) {
    super(message);
    this.name = 'UpstreamFailedError';
  }
}

export const isUpstreamUnavailable = (e: unknown): e is UpstreamUnavailableError =>
  typeof e === 'object' && e !== null && (e as { kind?: string }).kind === 'upstream_unavailable';

function classify(e: unknown): RpcErrorClass {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  if (/abort|timeouterror|timed out|timeout|headers timeout/i.test(msg)) return 'timeout';
  if (/econnrefused|enotfound|econnreset|epipe|eai_again|socket hang up|fetch failed|other side closed|network/i.test(msg)) return 'connection';
  return 'other';
}

// ------------------------------------------------------------ endpoint list
/**
 * Parse a comma-separated endpoint list. The single-URL form keeps working
 * (it parses to a one-element list). Duplicates and blanks are dropped; only
 * http(s) is accepted so a stray value cannot make the server speak to a file
 * or an unexpected scheme.
 */
export function parseEndpointList(raw: string | undefined, fallback: readonly string[]): string[] {
  const parts = String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  for (const p of parts.length ? parts : fallback) {
    let u: URL;
    try {
      u = new URL(p);
    } catch {
      continue;
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    if (!out.includes(p)) out.push(p);
  }
  if (out.length === 0) {
    for (const f of fallback) if (!out.includes(f)) out.push(f);
  }
  return out;
}

// --------------------------------------------------------------- endpoints
export interface EndpointHealth {
  /** redacted label — never the full URL when the operator configured it (H-3) */
  endpoint: string;
  state: 'up' | 'cold' | 'probing';
  consecutiveFailures: number;
  coldForMs: number;
  lastErrorClass: RpcErrorClass | null;
  lastErrorAt: string | null;
  calls: number;
  successes: number;
  failures: number;
}

class Endpoint {
  consecutiveFailures = 0;
  coldStreak = 0;
  coldUntil = 0;
  lastErrorClass: RpcErrorClass | null = null;
  lastErrorAt = 0;
  calls = 0;
  successes = 0;
  failures = 0;
  constructor(readonly url: string, readonly label: string) {}

  eligible(now: number): boolean {
    return this.coldUntil <= now;
  }
  markSuccess(): void {
    this.successes++;
    this.consecutiveFailures = 0;
    this.coldStreak = 0;
    this.coldUntil = 0;
  }
  markFailure(cls: RpcErrorClass, retryAfterSec?: number): void {
    this.failures++;
    this.consecutiveFailures++;
    this.lastErrorClass = cls;
    this.lastErrorAt = Date.now();
    const now = Date.now();
    if (this.coldUntil > now) {
      // Already cold: this is an in-flight call that had picked the endpoint
      // before it was taken out. Do NOT escalate the backoff for it, or a burst
      // of concurrent requests would walk a brief blip up to the 30 s ceiling.
      return;
    }
    // A 429 is an explicit "stop": take the endpoint out on the first one.
    // Anything else needs `failureThreshold` consecutive failures, so a single
    // blip on a single-endpoint deployment does not open the circuit.
    if (cls === 'rate_limited' || this.consecutiveFailures >= failureThreshold()) {
      this.coldStreak++;
      const backoff = Math.min(backoffBaseMs() * 2 ** (this.coldStreak - 1), backoffMaxMs());
      const hinted = retryAfterSec !== undefined ? Math.min(retryAfterSec * 1000, backoffMaxMs()) : 0;
      this.coldUntil = now + Math.max(backoff, hinted);
    }
  }
  health(now: number): EndpointHealth {
    return {
      endpoint: this.label,
      state: this.coldUntil > now ? 'cold' : this.coldStreak > 0 ? 'probing' : 'up',
      consecutiveFailures: this.consecutiveFailures,
      coldForMs: Math.max(0, this.coldUntil - now),
      lastErrorClass: this.lastErrorClass,
      lastErrorAt: this.lastErrorAt ? new Date(this.lastErrorAt).toISOString() : null,
      calls: this.calls,
      successes: this.successes,
      failures: this.failures,
    };
  }
}

export class EndpointPool {
  readonly endpoints: Endpoint[];
  circuitOpens = 0;
  constructor(readonly network: string, urls: string[], labels: string[]) {
    this.endpoints = urls.map((u, i) => new Endpoint(u, labels[i] ?? u));
  }
  /** Endpoints usable right now, in configured order (preference = order in the env list). */
  live(now = Date.now()): Endpoint[] {
    return this.endpoints.filter((e) => e.eligible(now));
  }
  /** Milliseconds until the first endpoint becomes eligible again. */
  nextEligibleInMs(now = Date.now()): number {
    return Math.max(0, Math.min(...this.endpoints.map((e) => e.coldUntil - now)));
  }
  health(): { network: string; endpoints: EndpointHealth[]; circuitOpen: boolean; circuitOpens: number; retryAfterSeconds: number } {
    const now = Date.now();
    const open = this.live(now).length === 0;
    return {
      network: this.network,
      endpoints: this.endpoints.map((e) => e.health(now)),
      circuitOpen: open,
      circuitOpens: this.circuitOpens,
      retryAfterSeconds: open ? Math.max(1, Math.ceil(this.nextEligibleInMs(now) / 1000)) : 0,
    };
  }
}

const pools = new Map<string, EndpointPool>();

export function getPool(network: string, urls: string[], labels: string[]): EndpointPool {
  const key = `${network}|${urls.join(',')}`;
  let p = pools.get(key);
  if (!p) {
    p = new EndpointPool(network, urls, labels);
    pools.set(key, p);
  }
  return p;
}

/** Test/ops hook: forget every pool and cached response. */
export function resetRpcState(): void {
  pools.clear();
  responseCache.clear();
  responseCache.resetStats();
}

// ------------------------------------------------------------------- cache
const responseCache = new TtlCache<unknown>(Number(process.env.SPECULAR_RPC_CACHE_MAX_ENTRIES || 20_000));
registerCache(responseCache as unknown as TtlCache<never>);

export function rpcCacheStats(): CacheStats {
  return responseCache.stats();
}

const NEVER_CACHE = new Set([
  'eth_sendRawTransaction',
  'eth_sendTransaction',
  'eth_getTransactionCount', // nonce: must be live for broadcast sequencing
  'eth_accounts',
  'eth_sign',
  'eth_signTransaction',
  'personal_sign',
  'eth_newFilter',
  'eth_getFilterChanges',
  'eth_uninstallFilter',
]);
const STATIC_METHODS = new Set(['eth_chainId', 'net_version', 'web3_clientVersion', 'eth_getCode', 'eth_getBlockByHash']);
const HEAD_METHODS = new Set([
  'eth_blockNumber',
  'eth_gasPrice',
  'eth_maxPriorityFeePerGas',
  'eth_feeHistory',
  'eth_estimateGas',
  'eth_getBalance',
  'eth_getLogs',
  'eth_getStorageAt',
]);
const HASH_METHODS = new Set(['eth_getTransactionByHash', 'eth_getTransactionReceipt']);

const PINNED_BLOCK = (tag: unknown): boolean => typeof tag === 'string' && /^0x[0-9a-fA-F]+$/.test(tag);

export function isCacheableMethod(method: string): boolean {
  if (NEVER_CACHE.has(method)) return false;
  return STATIC_METHODS.has(method) || HEAD_METHODS.has(method) || HASH_METHODS.has(method) || method === 'eth_call' || method === 'eth_getBlockByNumber';
}

/**
 * TTL for one JSON-RPC result.
 *
 * Chain head and anything read against `latest` gets a short TTL; anything
 * pinned to a block number, a block hash or a mined transaction is immutable
 * and gets a long one. A null receipt (pending/unknown tx) is never cached —
 * caching "not found" would make a freshly broadcast tx invisible.
 */
export function cacheTtlFor(method: string, params: unknown[], result: unknown): number {
  if (!isCacheableMethod(method)) return 0;
  if (STATIC_METHODS.has(method)) return ttlStatic();
  if (HASH_METHODS.has(method)) {
    if (result === null || result === undefined) return 0;
    const bn = (result as { blockNumber?: unknown }).blockNumber;
    return bn !== null && bn !== undefined ? ttlImmutable() : 0;
  }
  if (method === 'eth_getBlockByNumber') return PINNED_BLOCK(params[0]) ? ttlStatic() : ttlHead();
  if (method === 'eth_call') {
    const blockTag = params[1];
    if (PINNED_BLOCK(blockTag)) return ttlStatic();
    if (blockTag === 'pending') return 0;
    return ttlCall();
  }
  return ttlHead();
}

// ------------------------------------------------------------- the transport
interface JsonRpcCall {
  id: number | string;
  method: string;
  params?: unknown[];
  jsonrpc?: string;
}
interface JsonRpcReply {
  id: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

/** A JSON-RPC error body that really means "you are being throttled". */
function isRateLimitBody(err: { code?: number; message?: string } | undefined): boolean {
  if (!err) return false;
  if (err.code === 429 || err.code === -32005) return true;
  return /rate ?limit|too many requests|throttl|quota|capacity/i.test(String(err.message ?? ''));
}

interface AttemptOk {
  ok: true;
  reply: JsonRpcReply;
}
interface AttemptFail {
  ok: false;
  cls: RpcErrorClass;
  message: string;
  retryAfterSec?: number;
}

async function attempt(ep: Endpoint, call: JsonRpcCall, timeoutMs: number): Promise<AttemptOk | AttemptFail> {
  ep.calls++;
  let res: globalThis.Response;
  try {
    res = await fetch(ep.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: call.id, method: call.method, params: call.params ?? [] }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, cls: classify(e), message: e instanceof Error ? e.message : String(e) };
  }

  if (res.status === 429) {
    const ra = Number(res.headers.get('retry-after'));
    void res.body?.cancel();
    return { ok: false, cls: 'rate_limited', message: 'upstream returned 429', retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : undefined };
  }
  if (res.status >= 500) {
    void res.body?.cancel();
    return { ok: false, cls: 'server_error', message: `upstream returned ${res.status}` };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch (e) {
    return { ok: false, cls: 'bad_response', message: `upstream returned non-JSON (${res.status}): ${e instanceof Error ? e.message : 'parse error'}` };
  }
  if (res.status >= 400) {
    // 4xx that is not 429: our payload, not the endpoint's health.
    const err = (body as JsonRpcReply)?.error;
    if (err) return { ok: true, reply: { id: call.id, error: err } };
    return { ok: false, cls: 'bad_response', message: `upstream returned ${res.status}` };
  }
  const reply = (Array.isArray(body) ? body[0] : body) as JsonRpcReply | undefined;
  if (!reply || typeof reply !== 'object') return { ok: false, cls: 'bad_response', message: 'upstream returned an unrecognisable JSON-RPC body' };
  if (isRateLimitBody(reply.error)) {
    return { ok: false, cls: 'rate_limited', message: String(reply.error?.message ?? 'rate limited') };
  }
  return { ok: true, reply: { id: call.id, result: reply.result, ...(reply.error ? { error: reply.error } : {}) } };
}

/**
 * Dispatch ONE JSON-RPC call with failover, backoff, coalescing and caching.
 * Returns the JSON-RPC reply (a contract revert is a reply with `error`, which
 * is the caller's business, not an endpoint fault).
 */
export async function rpcCall(pool: EndpointPool, call: JsonRpcCall): Promise<JsonRpcReply> {
  const params = call.params ?? [];
  const cacheable = isCacheableMethod(call.method);
  const key = cacheable ? `${pool.network}|${call.method}|${stableKey(params)}` : '';

  const produce = async (): Promise<unknown> => {
    const reply = await dispatch(pool, call);
    if (reply.error) throw new JsonRpcReplyError(reply.error);
    return reply.result;
  };

  if (!cacheable || (!cacheEnabled() && !coalesceEnabled())) {
    return dispatch(pool, call);
  }

  try {
    let result: unknown;
    if (!coalesceEnabled()) {
      const hit = cacheEnabled() ? responseCache.peek(key) : null;
      if (hit) result = hit.value;
      else {
        result = await produce();
        if (cacheEnabled()) responseCache.set(key, result, cacheTtlFor(call.method, params, result));
      }
    } else {
      result = await responseCache.wrap(
        key,
        (v) => (cacheEnabled() ? cacheTtlFor(call.method, params, v) : 0),
        produce,
      );
    }
    return { id: call.id, result };
  } catch (e) {
    if (e instanceof JsonRpcReplyError) return { id: call.id, error: e.rpcError };
    throw e;
  }
}

class JsonRpcReplyError extends Error {
  constructor(readonly rpcError: { code?: number; message?: string; data?: unknown }) {
    super(String(rpcError?.message ?? 'json-rpc error'));
    this.name = 'JsonRpcReplyError';
  }
}

async function dispatch(pool: EndpointPool, call: JsonRpcCall): Promise<JsonRpcReply> {
  const maxAttempts = rpcMaxAttempts();
  const perCall = rpcTimeoutMs();
  let last: AttemptFail | null = null;

  for (let i = 0; i < maxAttempts; i++) {
    const now = Date.now();
    const live = pool.live(now);
    if (live.length === 0) {
      // circuit open: every endpoint is cold. Fail fast rather than queue (§5).
      pool.circuitOpens++;
      const retryAfter = Math.max(1, Math.ceil(pool.nextEligibleInMs(now) / 1000));
      throw new UpstreamUnavailableError(pool.network, retryAfter);
    }
    const ep = live[i % live.length];
    assertBudget(`an upstream ${call.method} call`);
    const budget = attemptBudgetMs(perCall);
    const r = await attempt(ep, call, budget);
    if (r.ok) {
      ep.markSuccess();
      return r.reply;
    }
    ep.markFailure(r.cls, r.retryAfterSec);
    last = r;
  }

  const cls = last?.cls ?? 'other';
  throw new UpstreamFailedError(
    pool.network,
    cls,
    cls === 'rate_limited'
      ? 'RPC endpoint rate-limited this server; try again shortly.'
      : cls === 'timeout'
        ? 'RPC endpoint timed out; try again shortly.'
        : cls === 'connection'
          ? 'RPC endpoint unreachable or timed out; try again shortly.'
          : `upstream RPC error (${cls})`,
  );
}

/**
 * ethers provider whose entire transport is the pool above. Overriding `_send`
 * (rather than handing ethers a FetchRequest) is what makes failover, caching
 * and coalescing apply to EVERY read path — `rpcStatus`, every contract view,
 * `eth_call` in simulate — without touching reads.ts or prepare.ts.
 */
export class ResilientJsonRpcProvider extends ethers.JsonRpcProvider {
  constructor(readonly pool: EndpointPool, network: ethers.Networkish) {
    super(pool.endpoints[0]?.url ?? 'http://127.0.0.1:0', network, { staticNetwork: true, batchMaxCount: 1 });
  }

  // ethers types _send as returning JsonRpcResult[]; at runtime it accepts
  // JsonRpcError members too (that is how a revert reaches the caller), so the
  // error members are cast through.
  async _send(payload: ethers.JsonRpcPayload | Array<ethers.JsonRpcPayload>): Promise<Array<ethers.JsonRpcResult>> {
    const calls = (Array.isArray(payload) ? payload : [payload]) as unknown as JsonRpcCall[];
    const replies = await Promise.all(calls.map((c) => rpcCall(this.pool, c)));
    return replies.map((r) =>
      r.error
        ? ({ id: r.id, error: { code: r.error.code ?? -32000, message: r.error.message ?? 'error', data: r.error.data } } as unknown as ethers.JsonRpcResult)
        : ({ id: r.id, result: r.result } as ethers.JsonRpcResult),
    );
  }
}

// ------------------------------------------------------------ observability
export interface RpcHealthSnapshot {
  cache: CacheStats;
  networks: Array<ReturnType<EndpointPool['health']>>;
  config: {
    perCallTimeoutMs: number;
    maxAttempts: number;
    failureThreshold: number;
    backoffMs: number;
    backoffMaxMs: number;
    cacheEnabled: boolean;
    coalesceEnabled: boolean;
    ttlMs: { head: number; call: number; static: number; immutable: number };
  };
}

export function rpcHealth(): RpcHealthSnapshot {
  return {
    cache: responseCache.stats(),
    networks: [...pools.values()].map((p) => p.health()),
    config: {
      perCallTimeoutMs: rpcTimeoutMs(),
      maxAttempts: rpcMaxAttempts(),
      failureThreshold: failureThreshold(),
      backoffMs: backoffBaseMs(),
      backoffMaxMs: backoffMaxMs(),
      cacheEnabled: cacheEnabled(),
      coalesceEnabled: coalesceEnabled(),
      ttlMs: { head: ttlHead(), call: ttlCall(), static: ttlStatic(), immutable: ttlImmutable() },
    },
  };
}

export { RequestDeadlineError, isRequestDeadlineError };
