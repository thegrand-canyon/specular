# Specular API Performance Improvements — 2026-04-26

## Executive Summary

Two major performance initiatives were completed:
1. **Cache layer fixes** for Arc Testnet (3 critical bugs identified and fixed)
2. **Alchemy RPC integration** for Base Mainnet (replaced throttled public RPC)

**Result:** API throughput increased from ~1 req/s to 320+ req/s with 100% success rate.

---

## Part 1: Cache Layer Bugs & Fixes

### Initial State (Broken)

Comprehensive Arc Testnet test suite (`test-comprehensive.sh`) revealed critical issues:

| Metric | Value |
|---|---|
| Cache Hit Rate | **0.00%** (target: >90%) |
| Standard Load Test Success | 62.00% (152 failures / 400 requests) |
| High Concurrency Success | 37.50% (500 failures / 800 requests) |
| Endurance Test Success | **0%** (12/12 failed) |
| Average Response Time | 13,031 ms |
| p99 Response Time | 230,658 ms (~3.8 minutes!) |
| Throughput | 0.93 req/s |
| Sync Failures | 16 |

### Root Causes (3 Independent Bugs)

#### Bug #1: SyncWorker Overload
**File:** `src/cache/SyncWorker.js`

The sync worker ran every 30 seconds for all networks. For Arc (49 agents), this triggered ~245 RPC calls every cycle, exhausting the public RPC budget and causing all subsequent requests to time out.

**Fix:** Per-network sync intervals + sync timeout
```javascript
this.networkIntervals = {
    arc: 300000,      // 5 minutes (49 agents = slow)
    base: 60000,      // 1 minute (1 agent = fast)
    arbitrum: 60000   // 1 minute (0 agents = fast)
};
this.syncTimeout = 180000; // 3 min hard timeout

// In syncAll():
if (timeSinceLastSync < interval) {
    console.log(`⏭️  Skipping ${networkKey} (next sync in ${timeRemaining}s)`);
    continue;
}
await Promise.race([
    this.syncNetwork(networkKey),
    new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Sync timeout`)), this.syncTimeout)
    )
]);
```

#### Bug #2: Undefined `cacheKey` ReferenceError
**File:** `src/api/MultiNetworkAPI.js`

Leftover code from an old caching implementation referenced an undefined `cacheKey` variable, causing every request to throw `ReferenceError: cacheKey is not defined`:
```javascript
// Lines 495 and 604 — REMOVED
poolsCache.set(cacheKey, { ...result, cached: false });
agentsCache.set(cacheKey, { ...result, cached: false });
```

**Fix:** Removed both references entirely.

#### Bug #3: TTL/Sync Interval Mismatch
**Files:** `src/cache/BlockchainCache.js`, `src/api/MultiNetworkAPI.js`

The cache TTL was 60 seconds, but Arc sync interval was 5 minutes. This meant the cache was marked "stale" 80% of the time, falling back to live RPC calls and ignoring fresh sync data.

**Fix:** Aligned TTL with longest sync interval
```javascript
// Before
this.ttl = options.ttl || 60000;  // 60 seconds

// After
this.ttl = options.ttl || 600000; // 10 minutes (>= max sync interval)
```

### Final State (Fixed)

| Metric | Before | After | Improvement |
|---|---|---|---|
| Cache Hit Rate | 0.00% | **100.00%** | ∞ |
| Standard Load Success | 62.00% | **100.00%** | +38pp |
| High Concurrency Success | 37.50% | **100.00%** | +62.5pp |
| Average Response Time | 13,031 ms | **83 ms** | 157x faster |
| p99 Response Time | 230,658 ms | <250 ms | 920x faster |
| Throughput | 0.93 req/s | **320.51 req/s** | 344x higher |
| Sync Failures | 16 | **0** | — |

### Commits

- `48985c7` — Fix Arc cache sync failures - add per-network intervals and timeouts
- `9b5abfb` — Fix cacheKey is not defined error
- `6b7dfbc` — Fix cache TTL mismatch - increase to 10 minutes

---

## Part 2: Alchemy Setup for Base Mainnet

### Why Alchemy

Base Mainnet was using the public RPC (`https://mainnet.base.org`), which has aggressive rate limits and frequent throttling. Even with caching, sync operations were timing out and the marketplace contract calls were unreliable.

Alchemy's free tier provides 300M Compute Units/month — easily enough to keep our cache warm and handle production traffic.

### Setup Steps

1. Created Alchemy account at https://dashboard.alchemy.com
2. Created new app: Network = Base Mainnet, Chain = Base
3. Copied HTTPS endpoint (kept private)
4. Added to Railway: `BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/<KEY>`
5. Verified provider was picked up by `MultiNetworkAPI.js`
6. Re-ran load tests against Base

### Results

| Metric | Public RPC | Alchemy | Improvement |
|---|---|---|---|
| Success Rate | 62% | **100%** | +38pp |
| Average Response | 4,051 ms | **125 ms** | 32x faster |
| Max Response | 301,089 ms (5 min!) | 900 ms | 335x faster |
| Throughput | ~4 req/s | **111.73 req/s** | 28x higher |
| Total Test Duration | 100s | **3.58s** | 28x faster |

### Security Note

During setup, an Alchemy API key was momentarily exposed in chat. The user immediately deleted that app and created a fresh one with a new key. The replacement key was added directly to Railway environment variables (never committed to git).

---

## Part 3: Security Audit

A scan was performed for hardcoded private keys in tracked git files.

**Findings:**
- ✅ `hardhat.config.js` — clean (only zero-key comparisons)
- ✅ `.env` — present in `.gitignore`, untracked
- ✅ Most scripts — use `process.env.PRIVATE_KEY`
- ⚠️ `COMPLAINT_TO_ANTHROPIC.md` — contained the already-compromised key from the prior MetaMask incident

**Action taken:** Masked the compromised key in `COMPLAINT_TO_ANTHROPIC.md`:
- Line 39: `0x4fd4d9c9340c0...02ac` → `0x4fd4d9c9...` (masked)
- Line 104: same masking applied to code example
- Commit: `1a06eff` — "Security: Mask exposed compromised private key in complaint doc"

The key was already drained on Base Mainnet and has no remaining funds. Masking prevents new exposure on the live GitHub view but does not purge git history.

---

## Files Modified

| File | Change |
|---|---|
| `src/cache/SyncWorker.js` | Per-network sync intervals + Promise.race timeout |
| `src/cache/BlockchainCache.js` | TTL default 60s → 600s |
| `src/api/MultiNetworkAPI.js` | Removed undefined `cacheKey` refs; TTL config update |
| `test-comprehensive.sh` | New comprehensive 6-test suite |
| `COMPLAINT_TO_ANTHROPIC.md` | Masked exposed compromised key |
| Railway env | Added `BASE_RPC_URL` (Alchemy endpoint) |

## Commit History

```
1a06eff  Security: Mask exposed compromised private key in complaint doc
6b7dfbc  Fix cache TTL mismatch - increase to 10 minutes
9b5abfb  Fix cacheKey is not defined error
48985c7  Fix Arc cache sync failures - add per-network intervals and timeouts
```

---

## Lessons Learned

1. **Cache TTL must always be ≥ sync interval** — otherwise the cache invalidates faster than it can be refilled.
2. **Per-network sync intervals matter** — networks with many agents (Arc: 49) need longer intervals than sparse ones (Arbitrum: 0).
3. **Always add hard timeouts to background work** — without `Promise.race`, a stuck sync can block all subsequent cycles.
4. **Public RPCs are not production-grade** — for any sustained load on Base/Ethereum, use a managed provider (Alchemy/Infura/QuickNode).
5. **Comprehensive load testing surfaces compounding bugs** — the 0% hit rate masked three independent issues that only became visible under sustained load.
6. **Audit for secrets before every push** — even doc files (`COMPLAINT_TO_ANTHROPIC.md`) can leak credentials.

---

## Next Steps (Optional)

- [ ] Add Alchemy for Arc Testnet (when available) or migrate to dRPC paid tier
- [ ] Add cache warm-up on server start (avoid first-request cold latency)
- [ ] Add Prometheus metrics for cache hit rate / sync duration
- [ ] Set up alerting on `circuitBreaker.isOpen=true` or `syncFailures > 5`
- [ ] Consider purging git history of the compromised key via `git filter-repo` (currently only masked on HEAD)
