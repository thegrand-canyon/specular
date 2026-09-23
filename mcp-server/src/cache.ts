/**
 * TTL cache + request coalescing (single flight), with counters for /rpc-health.
 *
 * 2026-09-22 RPC-resilience round. Two instances of this exist:
 *   - one inside rpc.ts, keyed by network|method|params (JSON-RPC level)
 *   - one inside tools.ts, keyed by tool|args (read-route level, per-route TTL)
 *
 * Coalescing matters as much as caching here: a single `/v1/{net}/status` read
 * fans out ~27 `eth_call`s, so 20 concurrent callers previously produced ~540
 * upstream calls for what is one answer. With single flight they produce one
 * set, and every later caller inside the TTL produces none.
 */

export interface CacheStats {
  hits: number;
  misses: number;
  coalesced: number;
  stores: number;
  evictions: number;
  entries: number;
  hitRate: number;
}

interface Entry<V> {
  value: V;
  expiresAt: number;
  storedAt: number;
}

export class TtlCache<V> {
  private map = new Map<string, Entry<V>>();
  private inflight = new Map<string, Promise<V>>();
  private hits = 0;
  private misses = 0;
  private coalesced = 0;
  private stores = 0;
  private evictions = 0;

  constructor(private readonly maxEntries = 5_000) {}

  /** Cached value with its age, or null when absent/expired. */
  peek(key: string): { value: V; ageMs: number } | null {
    const e = this.map.get(key);
    if (!e) return null;
    const now = Date.now();
    if (e.expiresAt <= now) {
      this.map.delete(key);
      return null;
    }
    return { value: e.value, ageMs: now - e.storedAt };
  }

  set(key: string, value: V, ttlMs: number): void {
    if (!(ttlMs > 0)) return;
    const now = Date.now();
    this.map.set(key, { value, expiresAt: now + ttlMs, storedAt: now });
    this.stores++;
    if (this.map.size > this.maxEntries) this.sweep(now);
  }

  /**
   * Cache-and-coalesce. `ttlFor` receives the produced value so a route can pick
   * a long TTL for something immutable (a REPAID loan, a mined receipt) and a
   * short one for live state. Returning 0 stores nothing.
   *
   * `onHit` lets the caller adjust the value it hands back (e.g. stamp
   * `cached: true, cacheAgeMs`) without mutating what is stored.
   */
  async wrap(
    key: string,
    ttlFor: (value: V) => number,
    produce: () => Promise<V>,
    onHit?: (value: V, ageMs: number) => V,
  ): Promise<V> {
    const hit = this.peek(key);
    if (hit) {
      this.hits++;
      return onHit ? onHit(hit.value, hit.ageMs) : hit.value;
    }
    const pending = this.inflight.get(key);
    if (pending) {
      this.coalesced++;
      const v = await pending;
      return onHit ? onHit(v, 0) : v;
    }
    this.misses++;
    const p = (async () => {
      const v = await produce();
      this.set(key, v, ttlFor(v));
      return v;
    })();
    this.inflight.set(key, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** Number of callers currently sharing an in-flight producer. */
  inflightCount(): number {
    return this.inflight.size;
  }

  clear(): void {
    this.map.clear();
    this.inflight.clear();
  }

  resetStats(): void {
    this.hits = this.misses = this.coalesced = this.stores = this.evictions = 0;
  }

  stats(): CacheStats {
    const total = this.hits + this.misses + this.coalesced;
    return {
      hits: this.hits,
      misses: this.misses,
      coalesced: this.coalesced,
      stores: this.stores,
      evictions: this.evictions,
      entries: this.map.size,
      hitRate: total === 0 ? 0 : Number(((this.hits + this.coalesced) / total).toFixed(4)),
    };
  }

  private sweep(now: number): void {
    for (const [k, e] of this.map) {
      if (e.expiresAt <= now) {
        this.map.delete(k);
        this.evictions++;
      }
    }
    // Still over the cap after dropping expired entries: drop oldest-inserted first.
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next();
      if (oldest.done) break;
      this.map.delete(oldest.value);
      this.evictions++;
    }
  }
}

// ---------------------------------------------------------------------------
// Registry, so a single hook can drop every cached answer at once. Used by
// chain.ts's `_setContractsForTest`: swapping the contracts under the server
// invalidates every cached read, and by any future operator "flush" action.
// ---------------------------------------------------------------------------
const registry = new Set<TtlCache<unknown>>();

export function registerCache(c: TtlCache<never>): void {
  registry.add(c as unknown as TtlCache<unknown>);
}

export function invalidateAllCaches(): void {
  for (const c of registry) {
    c.clear();
    c.resetStats();
  }
}

/** Stable stringify for cache keys: object key order must not change the key. */
export function stableKey(x: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'bigint') return `${v}n`;
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[circular]';
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = walk((v as Record<string, unknown>)[k]);
    return out;
  };
  try {
    return JSON.stringify(walk(x)) ?? 'undefined';
  } catch {
    return String(x);
  }
}
