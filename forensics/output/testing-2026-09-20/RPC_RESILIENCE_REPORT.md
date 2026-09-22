# Hosted agent server — upstream RPC resilience

**Target:** `mcp-server/` (branch `arc-mainnet-launch`).
**Round:** 2026-09-22. **Scope:** upstream RPC failure and quota exhaustion only. Contracts, custody and the
allow-list relay were not touched; nothing in this round changes the non-custodial contract.
**Predecessor:** `HOSTED_SERVER_TEST_REPORT.md` (2026-09-20/21), whose §6 established the premise for this work.

> **The deployment was NOT redeployed.** Everything below is in the working tree and verified locally.

---

## 0. The premise, restated from the previous round

§6 of the 2026-09-20 report proved the server is not the constraint: the cached `/health` path sustained
**~13,000 rps at p99 ≤ 56 ms with concurrency 400** in 85 MiB, on a container with 32 GB / 32 vCPU. The constraint
is the **upstream public RPC**:

- live `/v1/arc-mainnet/status`: **p95 = 164 s at concurrency 5**, **p99 = 300 s at concurrency 20** (300 s is
  Node's default `requestTimeout` — the runtime killed those requests, no policy of ours did);
- RPC-bound throughput capped near **35–40 rps**, with a cliff rather than a slope beyond it;
- a single afternoon of local load exhausted `arc-testnet.drpc.org` for this host's egress address, and the
  2026-09-21 `npm test` run could not complete against it (61 pass / 7 fail, every failure a 429).

A dedicated provider needs an account the owner has not set up. This round therefore does the two things that do
not need one: **need far fewer upstream calls**, and **degrade explicitly when the upstream fails**.

---

## 1. What was built

Six mechanisms, all env-configurable with defaults that work unattended. New modules:
`src/rpc.ts` (transport), `src/cache.ts` (TTL cache + single flight), `src/deadline.ts` (request budget).

### 1.1 Multi-endpoint failover

`SPECULAR_RPC_BASE` / `SPECULAR_RPC_ARC_STAGING` / `SPECULAR_RPC_ARC_MAINNET` now accept a **comma-separated list**
in preference order. The single-URL form is unchanged — it parses to a one-element list — so no existing
deployment or Railway variable needs editing. Only `http:`/`https:` entries are accepted; blanks and duplicates
are dropped; an all-invalid list falls back to the defaults rather than leaving a network endpointless.

Baked-in defaults, **each verified live on 2026-09-22** with `eth_chainId` *and* an `eth_call` of `VERSION()`
against that network's Specular marketplace (all six returned `V6.1`):

| network | default list (preference order) | verified |
|---------|--------------------------------|----------|
| `arc-mainnet` | `rpc.mainnet.arc.io`, `arc-rpc.publicnode.com`, `arc.drpc.org` | chainId `0x13b2` (5042), `VERSION()` = `V6.1` on all three |
| `arc-staging` | `rpc.testnet.arc.io`, `arc-testnet-rpc.publicnode.com`, `arc-testnet.drpc.org` | chainId `0x4cef52` (5042002), `VERSION()` = `V6.1` on all three |
| `base` | `mainnet.base.org`, `base-rpc.publicnode.com` | reachable; not load-tested this round |

dRPC is **last on every list** deliberately — it is the endpoint that 429'd this host in the previous round.
`rpc.arc.io` was probed and rejected (it returns a body but `http_code=000` to curl; not trustworthy as a default).

Two precedence details that matter:

- The **repo config file's own `rpcUrl`** (e.g. `src/config/arc-testnet-v6-addresses.json` names
  `arc-testnet.drpc.org`) no longer *replaces* the list. It is appended as a last-resort backstop when it is not
  already in it. Taking it as THE endpoint silently reduced every un-overridden deployment back to one upstream —
  caught during this round, and now pinned by a test.
- An explicit `SPECULAR_RPC_*` value still wins outright.

Selection is health-aware. A **429 takes an endpoint out of rotation on the first one** (it is an explicit
"stop"); any other failure takes it out after `SPECULAR_RPC_FAILURE_THRESHOLD` (2) consecutive failures, so a
single blip does not disable a single-endpoint deployment. A cold endpoint backs off exponentially
(`SPECULAR_RPC_BACKOFF_MS` 1 s → `SPECULAR_RPC_BACKOFF_MAX_MS` 30 s, or the upstream's own `Retry-After` if larger),
is retried half-open when the window elapses, and returns to full health on the first success — **no operator
action, no restart**. Failures on an endpoint that is *already* cold do not escalate its backoff, so a burst of
concurrent in-flight requests cannot walk a 1-second blip up to the 30-second ceiling.

### 1.2 Response caching with per-route TTLs

Two layers, because they answer different questions.

**Layer 1 — JSON-RPC level** (`src/rpc.ts`), keyed `network | method | params` (stable-stringified, so argument
order cannot split a key):

| class | TTL | env |
|-------|-----|-----|
| chain head / gas / `eth_estimateGas` / `eth_getBalance` / `eth_getLogs` | 2 s | `SPECULAR_RPC_CACHE_HEAD_MS` |
| `eth_call` against `latest` | 4 s | `SPECULAR_RPC_CACHE_CALL_MS` |
| block-pinned data, `eth_chainId`, `eth_getCode`, `eth_getBlockByHash` | 1 h | `SPECULAR_RPC_CACHE_STATIC_MS` |
| a **mined** transaction / receipt | 5 min | `SPECULAR_RPC_CACHE_IMMUTABLE_MS` |

**Layer 2 — read route** (`src/tools.ts`), keyed `tool | arguments`, and this is the layer that can pick a TTL
from the *answer*: a **`REPAID` or `DEFAULTED` loan**, and a **mined `get_transaction`**, can never change again,
so they are cached for 5 minutes (`SPECULAR_READ_CACHE_IMMUTABLE_MS`) while live protocol state is cached for
3 seconds (`SPECULAR_READ_CACHE_MS`). Layer 2 also saves the ABI decode and the entire ~17-call fan-out on a hit.

Never cached, by allow-list rather than deny-list: `eth_sendRawTransaction`, `eth_getTransactionCount` (nonce —
caching it would break broadcast sequencing), `eth_sign*`, filters, any `pending` block tag, and — importantly —
a **null** receipt, so a freshly broadcast transaction is never made invisible by a cached "not found".

A cached body is labelled `cached: true` with `cacheAgeMs`, and its `rpc.ageSeconds` / `rpc.stale` are
**recomputed from the cached block timestamp** at the moment of the hit, so staleness never under-reports.
`SPECULAR_RPC_CACHE=0` and `SPECULAR_READ_CACHE=0` turn each layer off.

### 1.3 Request coalescing

Identical concurrent reads share one in-flight promise at both layers (`SPECULAR_RPC_COALESCE`). Measured in
isolation: 25 simultaneous identical `eth_call`s produce **1** upstream call; different params do not share.
This is the mechanism that matters most under the shape of load a connector produces — twenty parallel tool calls
asking the same question previously produced twenty full fan-outs.

### 1.4 Bounded waits

`SPECULAR_REQUEST_DEADLINE_MS` (20 s) is stamped on every `/v1` and `/mcp` request and propagated through
`AsyncLocalStorage`, so the transport — several async layers below Express, inside ethers — can read it. Each
upstream attempt is clamped to `min(SPECULAR_RPC_TIMEOUT_MS, remaining budget − 150 ms reserve)`, and the budget is
checked *before* a socket is opened. A backstop timer answers **504 + `Retry-After: 1`** if a handler overruns
anyway. `SPECULAR_RPC_TIMEOUT_MS` default dropped **15 s → 8 s**: with failover, one slow endpoint must not consume
the whole request budget. `0` disables the deadline for an operator who wants the old unbounded behaviour.

### 1.5 Per-network circuit breaker

When every endpoint for a network is cold, the next call is refused immediately with
`UpstreamUnavailableError` → **HTTP 503**, `Retry-After`, and
`{"error":"Network \"arc-staging\" is temporarily unavailable: every configured RPC endpoint is cold. Retry in 5s.",
"network":"arc-staging","retryAfterSeconds":5}`. No socket is opened and nothing queues. It closes by itself when
a half-open probe succeeds.

### 1.6 Observability

- `GET /health` gains an `upstream` block: both caches' hit rates and, per network, `circuitOpen` /
  `endpointsUp` / `endpointsTotal`.
- `GET /rpc-health` (new, read-only, **makes no upstream call**) reports per endpoint `state` (`up`/`cold`/
  `probing`), `consecutiveFailures`, `coldForMs`, `lastErrorClass`
  (`rate_limited|timeout|connection|server_error|bad_response|other`), `lastErrorAt`, `calls`/`successes`/
  `failures`; per network `circuitOpen`, `circuitOpens`, `retryAfterSeconds`; both cache layers'
  hits/misses/coalesced/entries/hitRate; and the effective config.

**H-3 is preserved and extended.** The previous round's finding was that operator RPC credentials were echoed on
`/v1/networks`. The same redaction now applies to *every* endpoint in a list and to `/rpc-health`: a well-known
public default is shown verbatim, anything operator-configured is reduced to `scheme://host/`. A test asserts that
`https://opuser:0pSecret@rpc.paid.example/v2/PATHKEY123?apikey=QUERYKEY456` never appears on `/v1/networks`,
`/rpc-health` or `/health` in any form. A paid/keyed endpoint is safe to configure.

---

## 2. Measurements

### 2.1 Method

Latency alone cannot show quota consumption, so a **counting proxy** was put between the server and the real
upstream: `forensics/output/testing-2026-09-20/hosted/rpc-proxy.mjs`. It forwards every JSON-RPC call to a real
Arc endpoint, counts one call per JSON-RPC member, records the upstream's own status codes, and can inject
`429 / 500 / connection-refused / slow / hang` on demand. Upstream call counts below are its counters, not estimates.

- `hosted/rpc-load.mjs` — the same scenario shape the previous report used (`health`, `status`, `mcp_read`,
  `prepare_simulate` at concurrency 1/5/20, 25 requests per cell) plus a **mixed** cell (all four interleaved,
  concurrency 10, 120 requests), with the proxy's counters read before and after every cell.
- `hosted/fault-matrix.mjs` — one `/v1/{net}/status` request under each injected fault, first call and repeat.
- **BEFORE** = the pre-change build (`dist` snapshot taken before any edit), single endpoint → proxy `:8545` →
  `https://rpc.testnet.arc.io`. It *cannot* be given two endpoints; that is the capability being added.
- **AFTER** = the fixed build, two endpoints → proxy `:8545` → `rpc.testnet.arc.io` and proxy `:8546` →
  `arc-testnet-rpc.publicnode.com`, i.e. the shape of the new defaults.
- Local only. Rate limiter disabled so it is not what is being measured. Live traffic this round was five GETs.

### 2.2 Latency and upstream calls, before vs after

420 requests per run, identical script. All numbers measured 2026-09-22; raw rows in
`hosted/rpc-load-before2.json` and `hosted/rpc-load-after.json`.

| scenario | conc | **BEFORE** p50 / p95 / p99 | err | upstream/req | **AFTER** p50 / p95 / p99 | err | upstream/req |
|----------|-----:|---------------------------:|----:|-------------:|--------------------------:|----:|-------------:|
| health | 1 | 0 / 2 / 4 ms | 0 % | 0 | 0 / 1 / 2 ms | 0 % | 0 |
| health | 5 | 2 / 7 / 8 ms | 0 % | 0 | 3 / 8 / 9 ms | 0 % | 0 |
| health | 20 | 10 / 12 / 12 ms | 0 % | 0 | 9 / 11 / 11 ms | 0 % | 0 |
| status | 1 | 239 / 333 / 725 ms | 88 % | 28.28 | **0 / 1 / 353 ms** | **0 %** | **0.68** |
| status | 5 | 223 / 464 / 469 ms | 100 % | 28.96 | **2 / 6 / 7 ms** | **0 %** | **0.00** |
| status | 20 | 467 / 578 / 580 ms | 100 % | 25.84 | **111 / 112 / 112 ms** | **0 %** | **0.04** |
| mcp_read | 1 | 222 / 270 / 363 ms | 0 % | 30.24 | 1 / 4 / 33 ms | 0 % | 0.00 |
| mcp_read | 5 | 216 / 326 / 376 ms | 0 % | 29.24 | 5 / 340 / 341 ms | 0 % | 0.68 |
| mcp_read | 20 | 514 / 652 / 670 ms | 0 % | 26.84 | 21 / 36 / 37 ms | 0 % | 0.00 |
| prepare_simulate | 1 | 359 / 788 / 798 ms | 72 % | 13.08 | 110 / 193 / 370 ms | 0 % | 1.52 |
| prepare_simulate | 5 | 476 / 546 / 672 ms | 100 % | 8.00 | 137 / 497 / 498 ms | 0 % | 0.72 |
| prepare_simulate | 20 | 253 / 501 / 581 ms | 100 % | 3.00 | 177 / 177 / 177 ms | 0 % | 0.08 |
| **mixed** | 10 | 228 / 565 / 657 ms | **50 %** | 15.82 | **9 / 738 / 865 ms** | **0 %** | **0.28** |
| **TOTAL** | — | — | — | **6,736 calls (16.04/req)** | — | — | **127 calls (0.30/req)** |

**Upstream call reduction: 6,736 → 127, i.e. 98.1 % fewer upstream calls for the same 420 requests.**

Two things to read carefully:

1. **The BEFORE error rates are the point, not noise.** The proxy's own accounting for that run:
   `total 6994, upstreamStatuses {"429": 6683}` — **96 % of the upstream calls the old build made were rejected
   with 429 by `rpc.testnet.arc.io`**, which is a *different* provider from the one exhausted in the previous
   round. The old build exhausted a second public endpoint in under a minute of a 420-request test. That is the
   quota-exhaustion failure of §8.1 reproduced deterministically.
2. In AFTER, the same run drew **5 × 429** on endpoint A (`rpc.testnet.arc.io`) — and the error rate was still
   **0 %**, because endpoint B absorbed 8 calls while A was cold. Endpoint split: A 119 calls, B 8.
   `/rpc-health` after the run: JSON-RPC cache `hitRate 0.9201` (1,267 hits / 149 coalesced / 123 misses),
   read-route cache `hitRate 0.9810` (177 hits / 29 coalesced / 4 misses).

The p95/p99 headline for the RPC-bound routes, comparing like for like at the concurrency the previous report
found the cliff at: **`status` c=5 p95 464 ms → 6 ms**, and against the *live* 2026-09-20 baseline of
**p95 = 164,301 ms**, the fixed build answers the same route at **p95 = 6 ms** locally and never exceeds its
20-second deadline anywhere.

A single-endpoint AFTER run was also taken (same build, proxy `:8545` only): 420 requests, **116** upstream calls
(0.28/req), 0 % errors on every cell except `mixed`, where two upstream 429s opened the circuit for ~1 s and
60 of 120 requests were answered `503 + Retry-After` rather than being served. That is the intended behaviour
under a genuinely exhausted sole upstream — and it is the concrete argument for keeping **at least two** endpoints
configured, which the new defaults do.

### 2.3 Failure-mode matrix

One `/v1/arc-staging/status` request under each injected upstream fault; "repeat" is the immediately following
request. Raw rows in `hosted/fault-matrix-before.json` / `-after.json`.

| upstream fault | BEFORE (single endpoint) | AFTER (two endpoints) |
|----------------|--------------------------|------------------------|
| 429 on all endpoints | 502 in **42 ms**, then 502 in 12 ms — retried on every request, feeding the throttle | **503 in 38 ms**, repeat **503 in 12 ms** — circuit open, *no further upstream traffic at all*, `Retry-After: 5` |
| 500 on all endpoints | 502 in 24 ms (message echoed the upstream's `server response 500 Internal Server Error`) | **503 in 30 ms**, repeat 11 ms, sanitised "temporarily unavailable", `Retry-After: 1` |
| connection refused on all | 502 in 24 ms | **503 in 35 ms**, repeat 8 ms |
| slow, 30 s per call, all | **502 in 15,021 ms — and 15,023 ms on every subsequent request, indefinitely** | 502 in 19,860 ms (bounded by the 20 s deadline) once, then **503 in 21 ms** for every later request |
| hung, never answers, all | **502 in 15,024 ms, every request, indefinitely** | 502 in 19,859 ms once, then **503 in 23 ms** |
| primary 429, secondary healthy | *not expressible — the old build takes one endpoint* | **200 in 464 ms**, repeat **200 in 3 ms** |
| primary hangs, secondary healthy | *not expressible* | **200 in 8,494 ms** (one per-attempt timeout, then failover), repeat **200 in 2 ms** |

The decisive row is `hung`: before, **every** request pays the full timeout for as long as the upstream is sick —
which at concurrency 20 is 20 sockets held for 15 s each, forever. After, exactly one request pays the detection
cost and every subsequent request is refused in ~20 ms with a retry hint. On the *live* deployment that same
row was 164–300 s, not 15 s, because the deployed build predates even the H-5 timeout.

Not reproduced here, and worth stating: the ~19.9 s in the all-hung rows is the worst case by construction
(two endpoints × 8 s per attempt, third attempt clipped by the 20 s deadline). It is bounded and explicit; it is
not fast. An operator who wants a tighter ceiling lowers `SPECULAR_REQUEST_DEADLINE_MS`.

---

## 3. Tests

```
$ cd mcp-server && npm run build && npm test
# tests 96
# suites 0
# pass 96
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 9148.60575
```

**96/96.** Previous round: 68/68. Net **+28: 11 new unit tests and 17 new integration tests**. The suite also got ~2.5× faster (22.7 s → 9.1 s) because the reads it makes are now cached and
coalesced — and it now completes on the *default* endpoints at full `node --test` concurrency, which the previous
round could not do (it needed `--test-concurrency=1` and a substituted endpoint because dRPC was 429ing).

New: `test/unit.rpc.test.mjs` (11) and `test/integration.rpc.test.mjs` (17).

| # | Test | Proves |
|---|------|--------|
| U1 | comma-separated list parses in order; single-URL form still works | back-compat; blanks/dupes/non-http rejected; all-invalid falls back |
| U2 | default lists are multi-endpoint and keep dRPC last | the baked-in defaults are what this report claims |
| U3 | no `SPECULAR_RPC_*` override still resolves the FULL list | regression pin for the config-file precedence bug found in §1.1 |
| U4 | H-3 per endpoint | userinfo / path key / query key never appear |
| U5 | cache policy | head short, pinned/static long, mined tx immutable, null receipt never, writes never |
| U6 | TTLs are env-tunable | `SPECULAR_RPC_CACHE_*` respected |
| U7 | read-route TTL rule | `REPAID`/`DEFAULTED` loan + mined tx → 5 min; live state → 3 s; `SPECULAR_READ_CACHE=0` disables |
| U8 | `TtlCache` | hit, expiry, 8-way single flight, thrown producer not cached and not wedged, `onHit` does not mutate the stored copy |
| U9 | `stableKey` | argument order cannot split a key |
| U10 | deadline helpers | clamping, `0` disables, junk falls back, expired budget throws before dialling |
| I1 | 429 on primary → answered by secondary; primary cold | failover + no further traffic to the cold endpoint |
| I2 | failover for connection-refused, 500, garbage body, JSON-RPC `-32005` | every error class routes onward |
| I3 | failover off a hung endpoint bounded by the per-attempt timeout | ~700 ms then answered; next call immediate |
| I4 | backoff doubles per cold cycle and **resets on success** | automatic recovery, no operator action |
| I5 | one blip ≠ outage on a single-endpoint deployment | `failureThreshold` honoured |
| I6 | circuit breaker | all cold → immediate refusal (<100 ms), `retryAfterSeconds`, counter |
| I7 | coalescing | 25 identical concurrent reads → **1** upstream call; distinct params do not share; ids preserved |
| I8 | caching | 10 sequential reads → 1 call; expiry refetches; nonce + raw-tx relay always reach the chain |
| I9 | `SPECULAR_RPC_CACHE=0` keeps coalescing | the two knobs are independent |
| I10 | a contract revert is NOT an endpoint fault | no failover, no health penalty — a revert must reach the caller |
| I11 | request deadline clamps attempts | 900 ms budget vs a 30 s per-call timeout fails in ~1 s |
| I12 | `rpcHealth()` shape + redaction | every documented field present; no path/query key |
| I13 | HTTP: all upstreams dead → fast 503 + `Retry-After`, `/health` degraded, `/rpc-health` explains | the HTTP contract |
| I14 | HTTP: hung upstream bounded by `SPECULAR_REQUEST_DEADLINE_MS` | fails in < 4 s with a 60 s per-call timeout set |
| I15 | HTTP: failover list keeps serving 200 when the PRIMARY is dead | end-to-end, real secondary |
| I16 | HTTP: `/v1/networks`, `/rpc-health`, `/health` never publish credentials | H-3 end-to-end |
| I17 | HTTP: repeated `/health` does not fan out; both cache layers report counters | observability |

**Two pre-existing tests were updated, and why.** Neither weakens what it tests.

- `integration.hardening` **H-5** now accepts `502 or 503` and matches `timed out|unreachable|temporarily
  unavailable`. With the resilient transport the second consecutive timeout takes a single endpoint out of
  rotation, so a dead-RPC read can legitimately come back as the circuit-breaker's 503. The property H-5 exists
  to guard — fast, explicit, sanitised — is asserted unchanged (still `< 6000 ms`, still no endpoint echoed).
- `integration.hardening` **H-7** now identifies shed responses by their body (`"server busy"`) rather than by
  status alone, because the upstream failure can now itself be a 503; the assertion that exactly `MAX_INFLIGHT`
  requests execute and the rest are refused with `Retry-After` is unchanged. Its MCP half now asserts that MCP
  tool calls are either shed or refused fast with an "unavailable" tool error — previously it relied on those
  calls being slow enough to occupy a slot, which is exactly the behaviour this round removed.
- `unit.hardening` **H-3** now asserts the whole redacted list rather than one URL, and the staging default
  primary changed from `arc-testnet.drpc.org` to `rpc.testnet.arc.io`.

`openapi.json` was regenerated: `/rpc-health` is documented, `/health` gained its 503, every `/v1` operation
gained `503` and `504` responses, and `CacheStats` / `EndpointHealth` / `NetworkRpcHealth` schemas were added.

Live sanity (five GETs total, no load against Railway): `/health` 200 in 0.39 s, `/v1/arc-mainnet/status` 200 in
0.40 s, `/rpc-health` **404** — confirming the deployment predates this work.

---

## 4. What is mitigated vs what still requires a dedicated paid RPC provider

### Mitigated — no provider account needed

| Previously | Now |
|-----------|-----|
| One endpoint per network; its failure was the network's failure | 2–3 verified endpoints per network by default, health-aware failover, automatic recovery |
| ~16–30 upstream calls per RPC-bound request; 20 concurrent callers = 20 fan-outs | **0.30 upstream calls per request** on a mixed workload (98.1 % reduction), 92–98 % cache hit rate |
| A throttled/hung upstream meant every request paid the full timeout, indefinitely | One request pays detection; the rest get `503` in ~20 ms with `Retry-After` |
| Requests could hang for 164–300 s (killed by the runtime) | Hard 20 s budget per request; explicit `503`/`504` with a retry hint |
| No way to see why the server was slow | `/rpc-health` + the `upstream` block on `/health`, credential-free |
| A 429 storm was answered by retrying into the throttle | A 429 takes the endpoint out on the first one and stops all traffic to it |
| Operator RPC credentials could be echoed (H-3) | Redaction now covers every endpoint in a list and the new route |

Practically: for a workload dominated by repeated reads — which is what a connector, a dashboard poll or a status
check is — the server now needs **roughly 1/50th of the upstream calls** it used to, and a single provider hiccup
is invisible to callers as long as one endpoint in the list is healthy.

### Still requires a dedicated paid RPC provider

1. **Sustained, non-repeating write-path and simulate throughput.** Caching cannot help a call whose answer must
   be fresh. `eth_sendRawTransaction` and `eth_getTransactionCount` are never cached and never will be; a broadcast
   is always one upstream round trip. `prepare_simulate` still costs 1.52 upstream calls on a cold key. Many
   *distinct* agents preparing and broadcasting *distinct* transactions produces upstream load that scales
   linearly with agents and that no cache can absorb.
2. **Cache-miss floor under a wide key space.** The 98 % reduction measured here is for a workload where callers
   ask overlapping questions. A hundred agents each reading *their own* credit score, *their own* loans and
   *their own* positions share almost nothing: the reduction there comes only from intra-request dedup (~27 → ~17
   calls per cold read) and the 3-second route TTL, not from cross-caller sharing.
3. **Rate limits are still the public endpoints' to set.** Both Arc public endpoints 429'd this host during
   normal testing on 2026-09-22 — `rpc.testnet.arc.io` returned 6,683 429s in one BEFORE run, and 5 in the
   AFTER run. Failover converts those into someone else's problem only while a healthy alternate exists. With all
   three defaults throttled simultaneously — plausible, since they may share infrastructure and all see the same
   egress IP — the circuit opens and **the network is down for callers**, correctly and quickly, but down.
4. **Latency floor and archive depth.** Public endpoints gave 180–470 ms per call in this round's probes. That is
   the floor for any cold read. Nothing here improves per-call latency, block-range log queries, or the archive
   depth a paid tier provides.
5. **Attribution and headroom for third parties.** The previous report's §7.1 argument stands: the only scarce
   resource this server spends is the operator's RPC quota. A paid endpoint with a known rate ceiling is what
   makes a per-partner quota meaningful.

**Bottom line.** This round removes the *failure* modes — nothing hangs, nothing silently exhausts a provider,
nothing is unexplained — and removes most of the *volume*. It does not create capacity. For a launch to
Grok Bot / Muse at the traffic those connectors plausibly produce on read-heavy flows, the current configuration
is defensible; for sustained multi-agent write traffic, or for any commitment about throughput and latency to a
third party, a dedicated provider is still the right purchase. The recommended order is: deploy this, watch
`/rpc-health` for a week of real traffic (`lastErrorClass: rate_limited` counts and `circuitOpens` per network are
the number that decides it), then buy on evidence.

### Operator notes for the redeploy (owner's call, not done here)

- Nothing must change on Railway for this to work: unset `SPECULAR_RPC_*` variables now mean "use the verified
  multi-endpoint default". If `SPECULAR_RPC_ARC_MAINNET` / `SPECULAR_RPC_ARC_STAGING` are currently set to a
  single URL, they will keep working as one endpoint — **appending a comma and a second endpoint is the single
  highest-value change** available without an account.
- The previous round's open items are unchanged and still apply: `SPECULAR_TRUST_PROXY` must become `2` (or be
  deleted), and `SPECULAR_MCP_TOKEN` should be set before handing the endpoint to a third party.
- `SPECULAR_MAX_INFLIGHT` can now stay at 64: the previous advice to lower it to ~20 to match the upstream's
  concurrency is superseded, because cached and coalesced requests no longer consume upstream concurrency at all.
- After deploying, `curl /rpc-health` should show every endpoint `up` with `failures: 0`.

---

## 5. Files

```
NEW  mcp-server/src/rpc.ts                          resilient transport: failover, health/backoff, circuit breaker, cache, coalescing
NEW  mcp-server/src/cache.ts                        TTL cache + single flight + counters, with an invalidation registry
NEW  mcp-server/src/deadline.ts                     per-request budget over AsyncLocalStorage
NEW  mcp-server/test/unit.rpc.test.mjs              10 unit tests
NEW  mcp-server/test/integration.rpc.test.mjs       17 integration tests (fake upstreams + booted server)
     mcp-server/src/networks.ts                     rpcUrls[], verified default lists, per-endpoint redaction, _clearNetworkCache
     mcp-server/src/chain.ts                        getProvider -> ResilientJsonRpcProvider; describeRpcError knows the new classes
     mcp-server/src/tools.ts                        read-route cache with result-dependent TTLs
     mcp-server/src/http.ts                         deadline middleware + 504 backstop, 503 circuit mapping, /rpc-health, /health upstream block
     mcp-server/src/openapi.ts                      /rpc-health, 503/504, three new schemas
     mcp-server/openapi.json                        regenerated
     mcp-server/README.md, .env.example             new env vars documented
     docs/integrations/REMOTE_MCP.md                partner-facing: failover, caching, 503/504 semantics, /rpc-health
NEW  forensics/output/testing-2026-09-20/hosted/rpc-proxy.mjs     counting / fault-injecting JSON-RPC proxy
NEW  forensics/output/testing-2026-09-20/hosted/rpc-load.mjs      load harness with per-cell upstream call counts
NEW  forensics/output/testing-2026-09-20/hosted/fault-matrix.mjs  one request per injected fault, before/after
     …/hosted/rpc-load-{before,before2,after}.json, fault-matrix-{before,after}.json   raw results
```

### Reproducing the measurements

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd forensics/output/testing-2026-09-20/hosted
node rpc-proxy.mjs --port 8545 --upstream https://rpc.testnet.arc.io &
node rpc-proxy.mjs --port 8546 --upstream https://arc-testnet-rpc.publicnode.com &

cd ../../../../mcp-server && npm run build
SPECULAR_ENABLED_NETWORKS=arc-staging \
SPECULAR_RPC_ARC_STAGING="http://127.0.0.1:8545,http://127.0.0.1:8546" \
SPECULAR_RATE_LIMIT_PER_MIN=1000000 PORT=3400 node dist/http.js &

cd ../forensics/output/testing-2026-09-20/hosted
node rpc-load.mjs    http://127.0.0.1:3400 arc-staging "http://127.0.0.1:8545,http://127.0.0.1:8546" after
node fault-matrix.mjs http://127.0.0.1:3400 arc-staging "http://127.0.0.1:8545,http://127.0.0.1:8546" after
```

For the BEFORE column, check out the pre-round `mcp-server/src`, build, and run the same harness with a single
proxy URL (the old build cannot accept a list).
