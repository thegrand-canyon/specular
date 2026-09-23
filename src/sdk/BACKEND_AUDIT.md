# Backend API Server — Deep-Read Audit

**Scope**: `src/api/MultiNetworkAPI.js` (Railway entry point), cache layer
(`src/cache/BlockchainCache.js`, `src/cache/SyncWorker.js`), middleware
(`src/api/middleware/{requestLimiter,circuitBreaker,cacheManager}.js`), and
`backend/routes/virtuals.js`. Read-only review based on source as of audit
session.

**Method**: source review against deployed manifest (`/.well-known/specular.json`),
cross-checked against live-probe findings in `CROSS_NETWORK_AUDIT.md` §N6
(86.7 % sync failure rate) and §N11 (manifest endpoint 404s).

---

## §B0 — Severity scoreboard

| ID  | Severity | Component               | Issue                                                        |
| --- | -------- | ----------------------- | ------------------------------------------------------------ |
| B1  | **HIGH** | SyncWorker.fetchPool    | `totalLoaned` formula contradicts contract accounting model  |
| B2  | **HIGH** | MultiNetworkAPI routes  | Manifest claims 5 route families that don't exist            |
| B3  | **HIGH** | RequestLimiter          | `activeRequests` leaks on synchronous handler throw          |
| B4  | MED      | SyncWorker.fetchAgent   | N+1 RPC pattern: 49 agents × 40 pools = ~1960 calls/sync     |
| B5  | MED      | getContracts            | `batchMaxCount: 1` defeats Promise.all parallelism           |
| B6  | MED      | SyncWorker error path   | drpc 429 → cache stale 10 min → RPC fallback also 429s       |
| B7  | MED      | route-mounted limiter   | `/agent/:id`, `/pools/:id`, `/agent/:id/loans` uncapped      |
| B8  | MED      | validateNetwork mount   | Mounted as `app.use(route, ...)` — prefix-matches not exact  |
| B9  | MED      | backend/routes/virtuals | Dead code with 5 contract-interface mismatches               |
| B10 | LOW      | MultiNetworkAPI L62     | `DEFAULT_NETWORK` referenced before declaration              |
| B11 | LOW      | package.json deps       | `helmet`, `express-rate-limit` declared but never imported   |
| B12 | LOW      | /stats endpoint         | No Prometheus-style /metrics; counts hits but no histograms  |
| B13 | INFO     | architecture            | Server is read-only; manifest's `/tx/*` claim is misleading  |

---

## §B1 — HIGH: SyncWorker `totalLoaned` formula contradicts contract

**File**: `src/cache/SyncWorker.js:304`

```js
totalLoaned: Number(ethers.formatUnits(
    pool.totalLiquidity - pool.availableLiquidity, 6
)),
```

**Per `CONTRACT_SOURCE_AUDIT.md` §S1 + §N13**, the contract maintains:

```
availableLiquidity = totalLiquidity − totalLoaned + totalEarned − claimedSoFar
```

So solving for `totalLoaned`:

```
totalLoaned = totalLiquidity − availableLiquidity + totalEarned − claimedSoFar
```

The cached value `totalLiquidity − availableLiquidity` therefore equals
`trueLoaned − totalEarned + claimedSoFar`. For any pool that has accrued
interest with no withdrawals, the cached `totalLoaned` is **too small by
`totalEarned`**. For pools where lenders have called `claimInterest`, it is
too small by `totalEarned − claimedSoFar`.

### Live data showing the bug

From the cross-pool sweep (`tmp_pool_sweep.js`, Arc block 40,340,487):

| Pool | true totalLoaned (contract) | totalEarned | cache would compute    |
| ---- | --------------------------- | ----------- | ---------------------- |
| 43   | 0.00 USDC                   | 33.35       | −33.35 USDC (negative) |
| 44   | 0.00                        | 22.94       | −22.94                 |
| 45   | 165.00                      | 7.16        | 157.84                 |
| 46   | 40.00                       | 7.10        | 32.90                  |
| 5    | 120.00                      | 14.17       | 105.83                 |

Pool 43 would emit a **negative** `totalLoaned` to clients — a clear
correctness violation visible to anyone who hits `/pools?network=arc`.

### Why the live API doesn't show negatives today

The cache hasn't synced Arc successfully recently (per §N6, 86.7 % sync
failure). When the cache is stale, `/pools` falls through to the inline
`fetchPools()` in `MultiNetworkAPI.js:436-489`, which **also reads
`pool.totalLoaned` directly** (L463) — that path uses the contract's stored
field correctly. So the bug is dormant whenever Arc sync is failing, and
hot whenever it succeeds.

### Recommendation (analysis only)

Read `pool.totalLoaned` directly (the contract maintains this field
explicitly via `requestLoan`/`repayLoan`). The synthetic subtraction is
unnecessary and structurally wrong.

---

## §B2 — HIGH: Manifest claims routes that do not exist

**File**: `src/api/MultiNetworkAPI.js`, route registrations L209–880

The deployed `/.well-known/specular.json` and root `/` advertise the API
surface. §N11 probed 30+ endpoints; the following families return 404
because **no `app.METHOD(path, ...)` registration exists in the source**:

| Claimed family                     | Status in source         |
| ---------------------------------- | ------------------------ |
| `GET /loans`                       | not implemented anywhere |
| `GET /loans?network=*`             | not implemented          |
| `GET /leaderboard`                 | not implemented          |
| `GET /leaderboard?network=*`       | not implemented          |
| `GET /credit/:address`             | not implemented          |
| `POST /credit/:address`            | not implemented          |
| `POST /tx/register`                | not implemented          |
| `POST /tx/request-loan`            | not implemented          |
| `POST /tx/repay-loan`              | not implemented          |
| `POST /virtuals/credit-check`      | not wired (see §B9)      |
| `POST /virtuals/apply`             | not wired                |
| `POST /virtuals/confirm`           | not wired                |
| `GET /virtuals/agent/:address`     | not wired                |
| `GET /virtuals/pools`              | not wired                |

**Confirmed implemented routes** (full list from L209–880):

```
GET  /                            GET  /agent/:id/loans
GET  /dashboard                   GET  /agents
GET  /build                       GET  /agents/:address
GET  /.well-known/specular.json   GET  /networks
GET  /health                      GET  /network/:network
GET  /status                      GET  /stats
GET  /pools                       GET  /pools/:id
GET  /agent/:id
```

15 routes total. Manifest implies ~30. **The protocol is read-only** — there
are zero POST endpoints. Clients perform writes via direct on-chain calls,
which contradicts the manifest's advertised `/tx/*` and `/credit/*` POST
routes.

### Cross-impact

- Any third-party agent that trusts `/.well-known/specular.json` will fail
  silently when calling `/credit/:address` or `/tx/register`
- The "Specular agent integration guide" (frontend `build.html`?) likely
  references these routes
- The Virtuals Protocol integration is documented in
  `backend/routes/virtuals.js` but never reachable

### Recommendation (analysis only)

Either implement the missing routes or strip them from the manifest. The
structural choice (read-only API + direct on-chain writes) is fine; the
documentation drift is the bug.

---

## §B3 — HIGH: RequestLimiter `activeRequests` leak on sync throw

**File**: `src/api/middleware/requestLimiter.js:66-78`

```js
processRequest(req, res, next) {
    const originalEnd = res.end;
    const limiter = this;
    res.end = function(...args) {
        limiter.activeRequests--;       // ← only fires if res.end() is called
        limiter.processNext();
        return originalEnd.apply(this, args);
    };
    next();
}
```

The decrement only happens if a route handler eventually calls `res.end()`
(directly or via `res.json()`). Failure modes that skip it:

1. **Synchronous `throw`** in a handler before `res.json` — Express catches
   it and emits a 500 via its own default error handler, which calls a
   different `res.end` path on the prototype (the override is on the
   instance).  Counter never decrements.
2. **Unhandled promise rejection** — same path, default error handler.
3. **Client disconnect mid-response** — `res.end` may not be called by
   Express in all edge cases.

After 20 such failures, `activeRequests === maxConcurrent`; every new
request goes to the queue; queue fills to 50; everything else gets 503
"Server overloaded" until process restart.

The circuit breaker (B12 above) won't help because heap usage is unrelated
to the leak.

### Live impact

Currently mounted only on 4 routes (L55: `/health`, `/status`, `/agents`,
`/pools`). `/health` and `/status` rarely throw. `/agents` and `/pools` can
throw if the cache returns a malformed entry, but the cache code looks
defensive. Risk is latent rather than acute.

### Recommendation (analysis only)

Decrement in a `res.on('finish')` and `res.on('close')` listener instead of
overriding `res.end`. Or wrap `next()` in a try/catch and call
`processNext()` in `finally`.

---

## §B4 — MED: N+1 RPC pattern in `SyncWorker.fetchAgent`

**File**: `src/cache/SyncWorker.js:215-234`

```js
const totalPools = await marketplace.totalPools();   // call #1
const agentPools = [];
for (let i = 0; i < Number(totalPools); i++) {
    const poolAgentId = await marketplace.agentPoolIds(i);    // ← N more
    if (poolAgentId === BigInt(agentId)) {
        const pool = await marketplace.agentPools(poolAgentId); // ← +1 if match
        ...
    }
}
```

Per agent: `1 + totalPools + matches` calls. With 49 Arc agents × 40 pools:

```
49 agents × (1 + 40 + ~1)   = 2058 RPC calls per Arc sync cycle
+ 4 per-agent reputation calls × 49 = 196
+ 40 pool-lookups in fetchAllPools  =  80 (agentPoolIds + agentPools)
                                   ─────
                                    2334 RPC calls every 5 minutes
                            ≈ 7.8 calls/sec sustained
```

drpc free tier limits are well below this. This explains the 86.7 % sync
failure rate observed in §N6.

### Why the design is structurally wrong

`agentPoolIds(i)` is iterated to find pools for a specific agent. But the
contract's own `getAgentPool(agentId)` returns the pool for an agent
directly — no scan needed. The cache could replace the inner loop with a
single `getAgentPool(agentId)` call:

```
49 × (1 reputation + 1 credit + 1 interest + 1 getAgentPool) = 196 calls
```

A 12× reduction. Combined with proper batch usage (B5) → ~30 RPC requests
per sync.

### Recommendation (analysis only)

Replace the per-agent pool loop with `getAgentPool(agentId)`. Or invert the
sync: fetch all pools once, build an `agentId → pool` map, then attach.

---

## §B5 — MED: `batchMaxCount: 1` defeats Promise.all parallelism

**File**: `src/api/MultiNetworkAPI.js:179`

```js
const provider = new ethers.JsonRpcProvider(network.rpcUrl, undefined,
    { batchMaxCount: 1 });
```

This disables JSON-RPC batching: every contract call becomes a separate
HTTP request. SyncWorker uses `Promise.all` with `batchSize: 10`
(L177-188), expecting 10 calls to bundle into one HTTP POST.  With
`batchMaxCount: 1`, they instead fire 10 separate HTTPS requests — drpc
sees 10 distinct connections, each counts against the rate limit.

**Why the setting was added**: per `src/sdk/SETUP_GUIDE.md` and prior
debugging notes, drpc was returning 400s when ethers tried to batch.
Disabling batching fixed the 400s but transferred the cost to rate-limit
exhaustion.

### Net effect

Every "parallel" `Promise.all` is actually **n sequential HTTPS RTTs from
the client perspective** (browser/Railway → drpc), capped only by the
TCP/HTTPS connection pool. With Node's default agent (5 sockets per host),
10 parallel calls = 2 RTT batches → 200-400 ms total.

### Recommendation (analysis only)

Investigate which RPC providers reject batching (drpc was the trigger).
Use a fallback chain: try batched call → on 400, fall back to per-call.
Or use a different RPC (Alchemy/QuickNode/own node) that supports
batching.

---

## §B6 — MED: Silent sync failure mode

**File**: `src/cache/SyncWorker.js:126-130` + `BlockchainCache.js:184-189`

When `syncNetwork(networkKey)` throws (e.g., 429 from drpc):

1. `catch` block records `recordSync(networkKey, false)` (L129)
2. `setAgents`/`setPools` were **never called** (the throw happened
   before line 157-158)
3. Therefore `metadata.lastSync` was **never updated** for this cycle
4. Next request hits `getAgents(network)` → `isStale(metadata.lastSync)`
   compares against the *previous successful* sync timestamp
5. After TTL (10 min) expires, cache returns null → MultiNetworkAPI falls
   through to direct RPC (which is also rate-limited) → 504 timeout

There is no exponential backoff, no fallback RPC URL, no circuit-breaker
on the sync side. A single drpc 429 puts that network in degraded mode for
the next 5 minutes (next sync attempt).

### Live evidence

Per §N6: "86.7 % sync failure rate, lastSync timestamps stale by hours."
Confirmed by the source path above — there is no mechanism to recover
once 429s start arriving.

### Recommendation (analysis only)

Add a fallback RPC URL list per network, retry with exponential backoff
inside `syncNetwork`, and consider serving slightly-stale cache (with a
header flag) rather than null when sync fails.

---

## §B7 — MED: Route limiter coverage is incomplete

**File**: `src/api/MultiNetworkAPI.js:55-58`

```js
const apiLimiterRoutes = ['/health', '/status', '/agents', '/pools'];
apiLimiterRoutes.forEach(route => {
    app.use(route, requestLimiter.middleware());
});
```

By Express prefix matching, this **also** covers `/agents/:address` and
`/pools/:id` (good). But it does **not** cover:

- `/agent/:id` (singular — different prefix)
- `/agent/:id/loans`
- `/.well-known/specular.json`
- `/networks`, `/network/:network`, `/stats`
- `/dashboard`, `/build`, `/`

The `/agent/:id` endpoint is the one actually called by the front-end's
agent-detail page and by the MoltBook integration. It's also the
slowest cache-miss path (loops over all pools, like `fetchAgent` in §B4).

### Live impact

Bot traffic (or a stress test) hitting `/agent/:id` can saturate the
process without ever incrementing `requestLimiter.activeRequests` —
bypassing the protection that exists.

### Recommendation (analysis only)

Apply the limiter as a global `app.use(requestLimiter.middleware())` and
exempt only `/dashboard`, `/build`, and `/` (static-ish content). Or
explicitly list `/agent`, `/agent/:id/loans` in `apiLimiterRoutes`.

---

## §B8 — MED: `validateNetwork` mounted as prefix middleware

**File**: `src/api/MultiNetworkAPI.js:99-110`

```js
const validateNetworkRoutes = [
    '/health', '/status', '/agents', '/agents/:address',
    '/pools', '/pools/:id', '/.well-known/specular.json'
];
validateNetworkRoutes.forEach(route => {
    app.use(route, validateNetwork);
});
```

`app.use(path, mw)` matches any URL whose path **starts with** `path`. So
mounting on `/agents` also captures `/agents/0xabc/anything` and any
child path. The route-table `/agents/:address` mount is therefore
redundant. Conversely, `/agent/:id` (singular) is not in the list at all
— it has its own inline `validateNetwork` at L695. `/agent/:id/loans`
also has inline (L771). This works but is fragile: if someone later
removes the inline middleware thinking the prefix mount covers it, the
route silently accepts garbage networks.

### Recommendation (analysis only)

Use `app.param('network', ...)` or a single global middleware. The
current mix of prefix-mount and per-route inline registration is hard to
audit (took several minutes to confirm coverage during this review).

---

## §B9 — MED: `backend/routes/virtuals.js` is dead code with 5 mismatches

**File**: `backend/routes/virtuals.js`

This 465-line file claims to implement the Virtuals Protocol integration.
Multiple structural reasons it cannot work:

1. **Wrong module system**: uses `import express from 'express'` (ESM)
   while host is CommonJS (`package.json:type: "commonjs"`). Cannot be
   `require()`'d.
2. **Never imported**: `MultiNetworkAPI.js` has zero references to
   `virtuals` (confirmed via grep, 0 matches).
3. **Wrong `getPool` ABI** (L34): contract has `getAgentPool(uint256)`,
   not `getPool(uint256)`. Returned tuple shape also wrong (claims
   `interestRate` field; contract has no such field on the pool).
4. **Wrong `requestLoan` signature** (L35): claims
   `requestLoan(uint256 poolId, uint256 amount, uint256 duration)` but
   actual is `requestLoan(uint256 amount, uint256 durationDays)` — no
   `poolId` parameter (the agent's pool is implicit).
5. **Wrong reputation calls** (L29-30): `getAgentReputation(address)`
   returning a struct, and `getTier(address) returns string` — neither
   exists on `ReputationManagerV3` (which has
   `getReputationScore(address)`, `calculateCreditLimit(address)`,
   `calculateInterestRate(address)`).

Even if it were wired in, every contract call would revert with
"unknown function selector".

### Recommendation (analysis only)

Either delete the file (preferred — it's misleading) or rewrite against
the actual deployed ABIs and wire it in. Until then it provides false
confidence that "the Virtuals integration exists."

---

## §B10 — LOW: `DEFAULT_NETWORK` referenced before declaration

**File**: `src/api/MultiNetworkAPI.js:62, 138`

`validateNetwork` (L62) reads `DEFAULT_NETWORK`, declared at L138. Works
because the function isn't called until requests arrive (after module
initialization completes). But the order is non-obvious and a future
refactor could break it.

---

## §B11 — LOW: Declared dependencies not used

**File**: `package.json:54-55`

```
"helmet": "^8.1.0",
"express-rate-limit": "^8.2.1"
```

Neither is `require()`'d in any `src/` file. They consume install time
and disk space without contributing security. The custom middleware
duplicates `express-rate-limit`'s function (limiter) but lacks
`helmet`'s security headers entirely (no CSP, X-Frame-Options, etc.).

---

## §B12 — LOW: `/stats` lacks histogram metrics

**File**: `src/api/MultiNetworkAPI.js:857-880`

The `/stats` endpoint reports counters and current values (memory, hits,
misses, syncs, syncFailures). Missing for production observability:

- Per-route latency histograms (p50/p95/p99)
- Per-network sync duration histograms
- Per-RPC-call success/failure counters
- Cache hit-rate over time (current value is lifetime cumulative)

This blocks effective alerting and capacity planning. Not security-
relevant.

---

## §B13 — INFO: Architecture is read-only by design

The server has zero `app.post(...)` registrations. All state-mutating
operations (register, requestLoan, repayLoan, supply, claim) require the
client to construct, sign, and broadcast its own transaction.  This is
fine architecturally — keeps the server stateless, no key custody, no
nonce conflicts — but it makes the manifest's `POST /tx/*` advertisements
actively misleading.

The MoltBook integration (per `MOLTBOOK_INTEGRATION.md` if present)
likely already understands this. Third-party agents reading the manifest
do not.

---

## §B14 — Things checked OK

The following are present and correct:

- **CORS**: enabled globally (L48). Not restricted by origin (open API,
  intentional).
- **Network parameter validation**: rejects unknown networks with 400
  (L65-69).
- **Pagination**: `/agents`, `/pools` enforce `limit ≤ 50` (L516, L404).
- **Timeouts**: `/agents` 10 s (L544), `/pools` 30 s (L433). Prevents
  hanging requests under sync failure.
- **Pool ID validation**: `/pools/:id` rejects non-positive integers
  (L624).
- **Inactive agent handling**: `/agent/:id` returns 404 for
  zero-address agents (L720-726).
- **Memory limit enforced**: `node --max-old-space-size=512` in start
  script (`package.json:7`).
- **Reputation tier translation**: interest rate correctly divided by
  100 for basis-points → percent (L389, L760).

---

## §B15 — Cross-check against live findings

| Live finding (CROSS_NETWORK_AUDIT.md)            | Backend explanation        |
| ------------------------------------------------ | -------------------------- |
| §N6: 86.7 % Arc sync failure                     | §B4 + §B5 + §B6 combined   |
| §N11: `/loans`, `/leaderboard`, `/credit/*` 404  | §B2 (not implemented)      |
| §N11: `/virtuals/*` 404                          | §B2 + §B9 (dead code)      |
| §N11: `/tx/*` 404                                | §B2 + §B13 (no POST routes)|
| §N6: cache stale > hours                         | §B6 (no fallback RPC)      |

Every live anomaly traces to a structural source-level cause. No
"mystery" failures remain.

---

## §B16 — Method

1. Read `package.json` start script → identified entry `MultiNetworkAPI.js`
2. Read MultiNetworkAPI.js (914 lines, full file)
3. Read all referenced modules: BlockchainCache, SyncWorker,
   requestLimiter, circuitBreaker
4. Read backend/routes/virtuals.js to assess Virtuals integration
5. Grepped for route registrations to enumerate the actual API surface
6. Cross-referenced findings against §N6/§N11 live data
7. Checked claimed-vs-implemented invariants (manifest vs route table,
   contract ABI vs `virtuals.js` ABI, sync formula vs contract storage)

---

## §B17 — Cross-references

- `CROSS_NETWORK_AUDIT.md` §N6 (sync health), §N11 (manifest endpoints),
  §N13 (pool 43 accounting model)
- `CONTRACT_SOURCE_AUDIT.md` §S1 (`claimInterest` non-decrement, the
  basis for the §B1 formula bug)
- `tmp_pool_sweep.js` — invariant data backing §B1's negative-loaned
  example
- `package.json:7` — Railway entry point

---

**Summary**: Backend has 3 HIGH issues (B1 cached-totalLoaned formula, B2
manifest drift, B3 limiter counter leak), all latent today because the
upstream RPC (drpc) is so rate-limited that the sync rarely succeeds.
Fix the RPC story (§B5 + §B6) and B1 + B3 immediately become user-visible.
B9 (Virtuals dead code) is harmless but actively misleading.
