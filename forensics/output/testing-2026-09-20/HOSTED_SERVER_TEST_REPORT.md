# Hosted agent server — security, conformance and load test report

**Target:** `mcp-server/` — MCP Streamable HTTP + REST/OpenAPI, deployed at
`https://specular-agent-api-production.up.railway.app`
(Railway project `resplendent-determination`, service `specular-agent-api`).

**Round:** 2026-09-20 (first pass, cut off before writing up) + 2026-09-21 (completion).
**Branch:** `arc-mainnet-launch`. **Scope:** the hosted server only — contracts were not re-audited here
(that track is `CONTRACTS_V6.1_TEST_REPORT.md` in this directory).

---

## ⚠️ THE LIVE DEPLOYMENT NEEDS A REDEPLOY

**Yes — a redeploy is required.** `mcp-server/src/**` changed in 9 of its 13 files. The running deployment is

```
$ railway deployment list --service specular-agent-api
Recent Deployments
  b51a2f4f-03b3-4341-9ba0-c7f772beafdb | SUCCESS | 2026-09-19 19:14:03 -07:00
```

i.e. it predates **every** fix in this round. This is not a theoretical gap — the live endpoint fails
16 of 56 MCP conformance checks and 7 of 205 hardening probes that the fixed build passes (§5, §6).
**I did not redeploy.** `railway up --service specular-agent-api --ci` from the repo root, per CLAUDE.md.

**A redeploy alone is not enough.** The Railway service has `SPECULAR_TRUST_PROXY=1` set as an
explicit environment variable, which **overrides** the corrected default and leaves H-10 (shared
rate-limit bucket) live. See §7 "Deploy checklist".

---

## 1. Findings

Severity is about this server, not the protocol: nothing here can move funds — the server holds no key
and refuses to boot with one (`integration.http.test.mjs`, "refuses to start the remote server with a
private key in env"). The worst outcomes are **relaying a transaction the operator promised not to
relay**, **denial of service**, and **information disclosure**.

| § | Severity | Mechanism | Status | Test reference |
|---|----------|-----------|--------|----------------|
| **H-1** | **High** | **Relay bypass.** `validateSignedTx` decoded the calldata, checked the function against the allow-list, and relayed the *raw bytes*. The ABI decoder tolerates trailing bytes, so `requestLoan(…) ‖ <arbitrary junk>` decoded cleanly as an allow-listed call and was forwarded verbatim. Any calldata suffix a future/proxied contract might interpret rode straight through the allow-list. | **FIXED** — the decoded call is re-encoded and compared byte-for-byte; only the canonical encoding relays. | `test/unit.hardening.test.mjs` H-1; `probe.mjs` C8/C8b |
| **H-2** | Low | `getNetwork()` interpolated a hostile `network` value with `String(x)`. `{"toString":"x"}` or a null-prototype object throws `TypeError: Cannot convert object to primitive value` → HTTP 502 instead of a 400. | **FIXED** — `describeValue()` stringifies safely. | `unit.hardening.test.mjs` H-2; `probe.mjs` B "network: null-prototype object" |
| **H-3** | **Medium** | **Credential disclosure.** `publicNetworkInfo()` echoed `cfg.rpcUrl` verbatim on `/v1/networks` and `get_network_info`. An operator RPC override (`SPECULAR_RPC_*`) with userinfo, a path key or an `?apikey=` — the normal shape for Alchemy/Infura/dRPC paid endpoints — was published to every anonymous caller. | **FIXED** — a well-known default RPC is shown verbatim; anything operator-configured is reduced to `scheme://host/`. | `unit.hardening.test.mjs` H-3 (asserts a URL with user:pass + path key + query key never appears); `probe.mjs` D6 |
| **H-4** | Low | `get_available_liquidity` passed `minAvailableUsdc` / `limit` straight through. `0.1234567` reached `ethers.parseUnits` → 502 carrying ethers internals; `1e3` was silently accepted; `limit=1.5` was accepted and used as a fractional `slice()` bound. | **FIXED** — `optionalUsdc` / `optionalInteger` validate before any RPC. | `unit.hardening.test.mjs` H-4; `probe.mjs` A "pools query" |
| **H-5** | **High** (availability) | **Unbounded upstream.** No per-attempt timeout and ethers' default throttle policy (up to 12 attempts, exponential). A hung or 429-ing RPC held requests open for minutes while sockets and buffers accumulated. **Measured on the live deployment: `p95 = 164 s`, `p99 = 300 s` on `/v1/arc-mainnet/status` at concurrency 5–20** (§6). | **FIXED** — `FetchRequest.timeout` (15 s) + `setThrottleParams({maxAttempts: 3})`; a dead RPC now 502s in under 6 s. | `integration.hardening.test.mjs` H-5 |
| **H-6** | Medium (availability) | `/health` is unauthenticated **and exempt from the rate limiter**, and fanned out one `eth_getBlockByNumber` per enabled network per request — a free, un-throttled amplifier against the operator's RPC quota. | **FIXED** — 10 s result cache + single-flight; the response now carries `cached`/`cacheAgeMs`. | `integration.hardening.test.mjs` H-6 |
| **H-7** | Medium (availability) | No concurrency bound. Excess RPC-bound requests queued behind the upstream instead of being shed, turning a slow RPC into an unbounded memory/latency pile-up. | **FIXED** — `SPECULAR_MAX_INFLIGHT` (64) on `/v1` and `/mcp`; excess gets `503` + `Retry-After: 1`. | `integration.hardening.test.mjs` H-7; observed shedding under local load (§6) |
| **H-8** | Low (interop) | The MCP SDK answers **406** unless `Accept` lists *both* `application/json` and `text/event-stream`. Clients sending only `application/json`, `*/*`, or no `Accept` (curl, many agent frameworks) could not call the server at all. | **FIXED** — `normalizeAccept()`; the server is stateless and always answers JSON. | `integration.hardening.test.mjs` H-8; `mcp-conformance.mjs` accept/* |
| **H-9** | Low | Unknown tool and malformed `tools/call` params surfaced as `-32603 Internal error` carrying **the raw zod issue array** — wrong code per spec, and it published the internal validator's structure. | **FIXED** — pre-check → `-32602 Invalid params`; unknown tool throws `McpError(InvalidParams)`. | `integration.hardening.test.mjs` H-9; `mcp-conformance.mjs` errors/* |
| **H-10** | **High** | **Rate-limit key is the proxy, not the client.** With the wrong `trust proxy` hop count `req.ip` resolves to Railway's edge, so the "per-IP" 120/min bucket is shared by *everyone* behind that edge: one caller can lock out all other agents, and a caller can multiply their own quota by the number of edge IPs. **Confirmed on production** (§4.1). | **FIXED in code** (default 2, optional `SPECULAR_CLIENT_IP_HEADER`, raw `xff` chain logged for verification) — **OPEN in production** until `SPECULAR_TRUST_PROXY=1` is removed/changed on the Railway service. | `integration.hardening.test.mjs` H-10 (asserts spoofed XFF prefixes cannot change the key, and documents the hop=1 bug) |
| **DEP** | High + Moderate | `ws@8.17.1` reached transitively through `ethers@6.16.0`: GHSA-58qx-3vcg-4xpx (uninitialised memory disclosure, **high**) and GHSA-96hv-2xvq-fx4p (memory-exhaustion DoS from tiny fragments, **moderate**). This is the "1 high + 1 moderate" the Railway build reported. | **FIXED** — `"overrides": {"ws": "8.21.3"}`. Exploitability here was nil (the server uses `JsonRpcProvider` over HTTP, never `WebSocketProvider`), but the override is free. | §3 |
| **H-11** | Low | **Library/input echo.** `signedTransaction could not be decoded: …` and `explainRevert`'s fallback passed ethers' parenthetical detail block to the client: `(buffer=0xdeadbeef, length=4, offset=31, code=BUFFER_OVERRUN, version=6.16.0)` — exact library build (fingerprinting) plus a reflection of raw input. | **FIXED (new)** — `cleanErrorText()` strips ethers detail blocks, URLs and host:port. | `unit.hardening.test.mjs` H-11 (×2); `integration.hardening.test.mjs` H-11 |
| **H-12** | **Medium** | **Transport failure reported as a contract revert.** `simulateCall` funnelled *every* error through `explainRevert`, so a dead/throttling RPC returned `200 {ok:false, revertReason:"connect ECONNREFUSED <host:port>", plainLanguage:"The transaction would revert: …"}`. Two problems: it disclosed the operator's upstream endpoint, and it told an agent its **valid** loan/repay would revert when the chain was never consulted — a correctness bug an agent acts on. | **FIXED (new)** — `isExecutionRevert()` gates the revert path; transport errors rethrow and become a sanitised 502. | `integration.hardening.test.mjs` H-12 |
| **H-13** | **Medium** | **MCP error channel unsanitised.** `mcp.ts` returned `e.message` verbatim for any non-`ValidationError`, so every RPC failure leaked upstream details over MCP. The REST path had already been sanitised through `describeRpcError`; the MCP path had not. | **FIXED (new)** — only our own validation messages echo; everything else goes through `describeRpcError`. | `integration.hardening.test.mjs` H-12 (MCP half) |
| **H-14** | Low | **JSON-RPC batch path bypassed the H-9 fix and broke §6 of the spec.** (a) a batch whose members produce exactly one response returned a **bare object**, not a 1-element array; (b) an empty batch `[]` returned `202` instead of `-32600 Invalid Request`; (c) batch members skipped the single-request pre-check, so a malformed `tools/call` *inside a batch* still returned `-32603` **with the raw zod dump**. | **FIXED (new)** — empty-batch guard + a response-level normaliser that rewrites zod-dump `-32603`s to `-32602` and keeps batch replies arrays. | `integration.hardening.test.mjs` H-14 |
| **H-15** | Low (correctness) | **Deployed `canTopUp()` is off by one** on both Arc mainnet (`0x358c5E69`) and Arc staging (`0xB2d88bbF`): it evaluates the second window half-open against *its own* block, so an ACTIVE loan that started in the current block falls outside it and the view answers `true` — while `supplyLiquidity`, mined a block later, sees that loan inside `[pending.ts, tx.ts)` and reverts "Top-up would forfeit in-flight interest". The fix is in repo source only; the marketplace is deliberately not being redeployed for it. | **MITIGATED (new)** — the server no longer treats the on-chain view as authoritative. | §2.3 |

### Process findings (worth recording)

| Item | Detail |
|------|--------|
| The 2026-09-20 hardening unit suite **had never executed** | `test/unit.hardening.test.mjs` had `await` inside a non-`async` arrow at lines 38/42 → `SyntaxError: Unexpected reserved word`, so node:test failed the whole file. H-1…H-4 were written but never ran. Fixed by hoisting the awaits; all four now pass. |
| Two suites pinned a stale contract address | `unit.validate.test.mjs` and `integration.http.test.mjs` hard-coded the V6.0 staging marketplace `0xDbDf60AE…`; staging was redeployed to V6.1 `0xB2d88bbF…` on 2026-09-19 (commit `07fb780`). Both now read the address from `src/config/arc-testnet-v6-addresses.json`, the same file the server resolves, so a staging redeploy cannot silently break them again. |
| A stale local server poisoned the first probe run | A leftover `node dist/http.js` from the previous session served the *old* build on port 3400, producing 8 phantom "regressions". All numbers in this report come from runs against a freshly built, freshly started process. Noted because it is an easy trap for the next round. |

---

## 2. What changed in `mcp-server/src`, and why

`git diff --stat mcp-server/` at the end of this round:

```
mcp-server/.env.example                   |  15 +-
 mcp-server/README.md                      |  22 ++-
 mcp-server/openapi.json                   |   2 +-
 mcp-server/package-lock.json              |  17 +-
 mcp-server/package.json                   |   3 +
 mcp-server/src/broadcast.ts               |  14 +-
 mcp-server/src/chain.ts                   |  28 ++-
 mcp-server/src/http.ts                    | 271 ++++++++++++++++++++++++++++--
 mcp-server/src/mcp.ts                     |  20 ++-
 mcp-server/src/networks.ts                |  27 ++-
 mcp-server/src/prepare.ts                 |  76 ++++++++-
 mcp-server/src/reads.ts                   |  77 ++++++++-
 mcp-server/src/tools.ts                   |  23 ++-
 mcp-server/src/validate.ts                |  35 ++++
 mcp-server/test/integration.http.test.mjs |   9 +-
 mcp-server/test/unit.validate.test.mjs    |  14 +-
 16 files changed, 596 insertions(+), 57 deletions(-)
 (+ new) test/unit.hardening.test.mjs, test/integration.hardening.test.mjs
```

### 2.1 Fixes carried over from the 2026-09-20 pass (H-1 … H-10, DEP)

- **`broadcast.ts`** — canonical-encoding check (H-1). `encodeCalldata(target, name, args)` is compared
  to `tx.data`; any divergence is a 400 naming the number of unexpected bytes.
- **`prepare.ts`** — exported `encodeCalldata` for that check.
- **`networks.ts`** — `describeValue()` (H-2) and `publicRpcUrl()` (H-3).
- **`tools.ts` / `validate.ts`** — `optionalUsdc` / `optionalInteger`, validated *before* `net(args)`
  does any RPC work (H-4).
- **`chain.ts`** — `rpcTimeoutMs()` / `rpcMaxAttempts()` wired into a `FetchRequest` (H-5); a wider
  `describeRpcError` that also strips URLs and ethers version strings.
- **`http.ts`** — `/health` cache + single-flight (H-6); `shed()` in-flight cap (H-7);
  `normalizeAccept()` (H-8); `jsonRpcParamError()` (H-9); `clientIp()` + `trust proxy` default 2 +
  `SPECULAR_CLIENT_IP_HEADER` + the raw `xff` chain in the access log (H-10); an `/openapi.json`
  cache; `headersTimeout`/`requestTimeout` for slowloris hygiene; path/method/tool truncation in logs.
- **`mcp.ts`** — unknown tool → `McpError(InvalidParams)` (H-9).
- **`package.json`** — `overrides: { ws: 8.21.3 }` (DEP).

### 2.2 Fixes added in this pass (H-11 … H-14)

- **`validate.ts` → `cleanErrorText()`** (H-11). Strips any parenthetical block containing
  `code=`/`version=`/`operation=`/`buffer=`/`payload=`/`request=`/`argument=`, then replaces URLs,
  bare IP:port and hostnames with `[rpc]`. Used by the broadcast decoder and by `explainRevert`'s
  fallback — *not* by the contract-revert path, where the `require()` string must survive verbatim.
- **`prepare.ts` → `isExecutionRevert()`** (H-12). `simulateCall` now only reports a revert when the
  error is one the EVM produced (`CALL_EXCEPTION`, a `reason`, revert `data`, or a message that says
  so). Everything else rethrows and is mapped by the existing 502 handler.
- **`mcp.ts`** (H-13). `const message = expected ? (e as Error).message : describeRpcError(e)`.
- **`http.ts` → `normalizeRpcErrors()` + `interceptJsonBody()`** (H-14). The SDK transport writes
  straight to the Node response through `@hono/node-server`, so Express's `res.json` is never called;
  the interceptor buffers the single JSON document, rewrites zod-dump `-32603`s to `-32602`, and
  re-wraps a batch reply as an array. Non-JSON/streamed responses and all `/v1` routes are untouched.

### 2.3 H-15 — `can_top_up` is no longer presented as authoritative

Raised by the contracts track mid-round. The deployed bytecode on **both** Arc mainnet and Arc staging
evaluates `canTopUp`'s second window as half-open against its own block:

```solidity
// deployed
return !_activeLoanStartedIn(agentId, pt.timestamp, block.timestamp);
// repo source (fixed, NOT deployed)
return !_activeLoanStartedIn(agentId, pt.timestamp, block.timestamp + 1);
```

A loan that starts in the block the view is read against is excluded, so the view says *yes*; the
`supplyLiquidity` tx lands in a later block, where that loan **is** inside `[pt.timestamp, tx.timestamp)`,
and reverts. No funds are at risk — the failure mode is a reverted tx and wasted gas.

`reads.ts` now carries `correctedCanTopUp()`, an off-chain replication of the *corrected* predicate.
Its upper bound is effectively open-ended, which is exactly right: every currently-ACTIVE loan started
at or before "now", and the supply tx is mined strictly after "now", so any active loan with
`startTime >= pending.timestamp` will fall inside the tx's window.

- **`can_top_up`** now returns `canTopUp: onChainView && correctedPredicate` — the conservative answer —
  alongside `onChainView`, `correctedPredicate`, `viewDisagrees`, `activeLoansInPool` and a `warnings[]`.
- On disagreement the warnings lead with `TOP_UP_VIEW_BUG_WARNING`, which states plainly that the
  deployed view is wrong and the server is answering conservatively.
- **`TOP_UP_RACE_WARNING` is attached even when both agree**, because the genuine race remains: a loan
  can start in the pool between the check and the supply tx.
- **`prepare_supply_liquidity`** runs the same predicate whenever the caller already has a position and
  pushes the warnings into the prepared tx's `warnings[]` — `TOP-UP WILL REVERT: …` when the on-chain
  view disagrees, plus the race warning. It is V6.1-gated and wrapped in try/catch: an advisory check
  never blocks a prepare (on failure it says so and tells the caller to simulate).

---

## 3. Dependency audit

Before (committed lockfile, reproduced in a clean directory):

```
$ npm audit
# npm audit report

ws  8.0.0 - 8.20.1
Severity: high
ws: Uninitialized memory disclosure - https://github.com/advisories/GHSA-58qx-3vcg-4xpx
ws: Memory exhaustion DoS from tiny fragments and data chunks - https://github.com/advisories/GHSA-96hv-2xvq-fx4p
fix available via `npm audit fix`
node_modules/ws
  ethers  6.0.0-beta.1 - 6.16.0
  Depends on vulnerable versions of ws
  node_modules/ethers

2 vulnerabilities (1 moderate, 1 high)
```

After (`"overrides": {"ws": "8.21.3"}`, installed version confirmed `8.21.3`):

```
$ npm audit
found 0 vulnerabilities

$ npm audit --json | metadata
{"vulnerabilities": {"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0},
 "dependencies": {"prod":104,"dev":13,"total":116}}
```

Fixing by override rather than an ethers bump was the safe choice: `ws` is only reachable through
`ethers`' `WebSocketProvider`, which this server never constructs, and pinning avoids a major-range
dependency change days before launch.

---

## 4. Live-deployment observations

### 4.1 H-10 confirmed on production

The rate limiter keys on the Railway edge, not the caller. One request, with the client's real public
address known:

```
MY PUBLIC IP: 172.56.153.23
$ curl -s -o /dev/null "https://…up.railway.app/v1/nope-probe-1790034630/status"

$ railway logs --service specular-agent-api | grep probe-1790034630
2026-09-21T23:50:32Z [INFO] http … path="/v1/nope-probe-1790034630/status" status=400 ms=1 ip="152.233.76.10"
```

`172.56.153.23` ≠ `152.233.76.10`. Across the last 500 log lines the "client" IP is always one of five
Railway edge addresses:

```
$ railway logs --service specular-agent-api | grep -o 'ip="[0-9.]*"' | sort | uniq -c | sort -rn
 113 ip="152.233.76.11"
 108 ip="152.233.76.10"
  67 ip="79.127.217.66"
  65 ip="152.233.76.9"
  58 ip="79.127.217.65"
```

So today the public endpoint has **five shared 120/min buckets for the entire internet**. One noisy
caller denies service to every other agent routed through the same edge; conversely a caller spread
across edges gets ~600/min. The fix is in code, but the service variable overrides it:

```
$ railway variables --service specular-agent-api
… SPECULAR_TRUST_PROXY │ 1
```

Note the express semantics that make `2` the right value: with hop count 1 the resolved address is the
*last* XFF entry (the edge), which is what we observe; the client sits one entry further left, i.e.
`X-Forwarded-For: <client>, <edge>`. The `integration.hardening.test.mjs` H-10 test pins both
behaviours. **This must still be verified from the new `xff` log field after deploying** — and if
Railway turns out to overwrite XFF rather than append, set `SPECULAR_CLIENT_IP_HEADER=x-real-ip`
instead of changing the hop count.

### 4.2 Container resources (Railway)

Read directly from the running container:

```
$ railway ssh --service specular-agent-api "cat /sys/fs/cgroup/memory.max; cat /sys/fs/cgroup/memory.current; nproc"
32000000000
89145344
48

$ railway ssh … "cat /sys/fs/cgroup/cpu.max; cat /sys/fs/cgroup/memory.peak; grep VmRSS /proc/1/status; node -v"
3200000 100000
92983296
VmRSS:	  139108 kB
v22.23.2
```

- **Memory limit 32 GB**, current use **85 MiB**, peak since container start **88.7 MiB**.
- **CPU quota 32 vCPU** (`3200000/100000`), 48 cores visible.

**The hard memory ceiling that previously constrained this project is gone** — the service is on a plan
with 32 GB / 32 vCPU and is using roughly 0.3 % of it. Memory is not a limiting factor for opening the
server to more agents; the upstream RPC is (§6).

### 4.3 Unrelated live traffic

The live server was serving real `broadcast_signed_transaction` / `prepare_*` MCP traffic on arc-staging
during this round (other sessions in this workspace). Live latency numbers below therefore include some
background load; the local numbers do not.

---

## 5. MCP conformance matrix

Suite: `forensics/output/testing-2026-09-20/hosted/mcp-conformance.mjs` — half the checks drive the
official `@modelcontextprotocol/sdk` `Client` over `StreamableHTTPClientTransport`, half are raw
JSON-RPC probes for the wire rules the SDK hides.

```
FIXED BUILD (local)   PASS 56  FAIL 0   total 56   (23 tools)
LIVE DEPLOYMENT       PASS 40  FAIL 16  total 56   (23 tools)
```

| Area | Requirement | Fixed build | Live (2026-09-19 build) |
|------|-------------|-------------|--------------------------|
| lifecycle | SDK `Client.connect()` completes the initialize handshake | ✅ | ✅ |
| lifecycle | server advertises the `tools` capability | ✅ | ✅ |
| lifecycle | `ping` round-trips | ✅ | ✅ |
| tools/list | non-empty list, every tool has `name` + object `inputSchema` | ✅ (23) | ✅ (23) |
| tools/list | every tool has a description | ✅ | ✅ |
| tools/list | read/prepare/simulate carry `readOnlyHint`; broadcast does not | ✅ | ✅ |
| tools/list | single page, no `nextCursor` surprise | ✅ | ✅ |
| tools/call | `content[]` + `structuredContent`, and they agree | ✅ | ✅ |
| tools/call | tool-level validation failure is `isError: true`, not a protocol error | ✅ | ✅ |
| tools/call | **unknown tool → protocol error `-32602`** | ✅ | ❌ returns an `isError` tool result |
| tools/call | read tool over raw JSON-RPC returns `structuredContent` | ✅ | ✅ |
| tools/call | `prepare_*` returns an unsigned tx (`value:"0"`, no signature) | ✅ | ✅ |
| version | `initialize` negotiates `2024-11-05` / `2025-03-26` / `2025-06-18` | ✅ | ✅ |
| version | an unsupported version negotiates down rather than failing hard | ✅ | ✅ |
| version | **non-string `protocolVersion` → `-32602`** | ✅ | ❌ `-32603` + zod dump |
| version | `Mcp-Protocol-Version` request header honoured | ✅ | ✅ |
| version | garbage `Mcp-Protocol-Version` → 400, no crash | ✅ | ✅ |
| accept | `application/json, text/event-stream` → 200 JSON | ✅ | ✅ |
| accept | **`application/json` only → 200 JSON** | ✅ | ❌ **406** |
| accept | **`*/*` → 200 JSON** | ✅ | ❌ **406** |
| accept | **no `Accept` header → 200 JSON** | ✅ | ❌ **406** |
| accept | **`text/event-stream` only → 200 JSON** | ✅ | ❌ **406** |
| accept | **`text/html` (hostile) → 200 JSON** | ✅ | ❌ **406** |
| session | `initialize` issues no `Mcp-Session-Id` (stateless) | ✅ | ✅ |
| session | a bogus `Mcp-Session-Id` is ignored, not 404 | ✅ | ✅ |
| session | `tools/list` works with no prior `initialize` | ✅ | ✅ |
| session | `GET /mcp` → 405, `DELETE /mcp` → 405 | ✅ | ✅ |
| jsonrpc | notification (no `id`) → 202, empty body | ✅ | ✅ |
| jsonrpc | string / 0 / negative / large ids echoed unchanged | ✅ | ✅ |
| batch | batch of 3 → 3 correlated responses | ✅ | ✅ |
| batch | batch of 30 pings answered in full | ✅ | ✅ |
| batch | **mixed batch answers with an ARRAY** | ✅ | ❌ bare object |
| batch | **empty batch → `-32600`** | ✅ | ❌ 202 |
| errors | unknown method → `-32601` | ✅ | ✅ |
| errors | **unknown tool → `-32602`** | ✅ | ❌ |
| errors | **`tools/call` without params → `-32602`, no zod dump** | ✅ | ❌ `-32603` + dump |
| errors | **`tools/call` `name` not a string → `-32602`, no zod dump** | ✅ | ❌ `-32603` + dump |
| errors | **`tools/call` `arguments` as array → `-32602`, no zod dump** | ✅ | ❌ `-32603` + dump |
| errors | malformed JSON → 400 JSON body, no stack | ✅ | ✅ |
| errors | missing / wrong `jsonrpc` member rejected | ✅ | ✅ |
| errors | `tools/call` with omitted `arguments` accepted (defaults to `{}`) | ✅ | ✅ |
| cors | preflight `OPTIONS` answered with `Access-Control-Allow-Origin` | ✅ | ✅ |
| cors | `Mcp-Session-Id` / rate-limit headers exposed to browsers | ✅ | ✅ |

**SSE.** The server is stateless with `enableJsonResponse`, so it never opens an SSE stream: a client
sending `Accept: text/event-stream` gets `200` with `content-type: application/json` (verified), and
`GET /mcp` — the spec's server-initiated stream — is a deliberate `405`. Any MCP host that *requires*
a listening stream will not work; every host that accepts buffered JSON responses will.

---

## 6. Load

### 6.1 Live deployment — moderate, paced, budgeted

`load.mjs <url> live arc-mainnet`: 4 scenarios × concurrency {1, 5, 20} × 25 requests, 20 s between
cells. Total live traffic for the whole round (load + conformance + probe + single verification calls)
was well under the 2,000-request budget and never attempted to exhaust the service.

```
scenario          conc     n  p50        p95        p99        max        rps    err   statuses
health            c=  1   25     71ms     270ms      354ms      354ms     9.6    0%    {"200":25}
health            c=  5   25     91ms     333ms      335ms      335ms    30.6    0%    {"200":25}
health            c= 20   25    313ms     429ms      438ms      438ms    42.4    0%    {"200":25}
status            c=  1   25    277ms    2414ms     3646ms     3646ms     1.1    0%    {"200":25}
status            c=  5   25   1068ms  164301ms   166321ms   166321ms     0.2    0%    {"200":25}
status            c= 20   25 139388ms  286781ms   300217ms   300217ms     0.1    8%    {"200":23,"502":2}
mcp_read          c=  1   25    316ms    2378ms     2406ms     2406ms     1.2    0%    {"200":25}
mcp_read          c=  5   25   1650ms   96321ms    97081ms    97081ms     0.2    0%    {"200":25}
mcp_read          c= 20   25 119759ms  222859ms   241760ms   241760ms     0.1    0%    {"200":25}
prepare_simulate  c=  1   25    521ms    4258ms    32686ms    32686ms     0.4    0%    {"200":25}
prepare_simulate  c=  5   25   1191ms  158029ms   158234ms   158234ms     0.1    0%    {"200":25}
prepare_simulate  c= 20   25  76868ms  170054ms   287003ms   287003ms     0.1    0%    {"200":25}
```

Note the **zero 429s** across all 300 requests: the public per-IP limiter never engaged, because (§4.1)
it is not keyed on the caller at all.

**Reading of these numbers.** The `health` cells ran first, against an upstream that was still fresh —
note that the live build has **no** health cache yet (H-6), so each of those requests did fan out one
RPC call per network; that per-request amplifier is exactly what the fix removes. Every RPC-bound
route then collapses at **concurrency 5**: `p95 = 164 s` and a `max` of
**300.2 s** — which is precisely Node's default `requestTimeout`, i.e. requests were killed by the
runtime rather than by any policy of ours. Twenty-five requests at concurrency 20 is a trivial load;
a single Grok Bot or Muse connector issuing parallel tool calls can produce it. This is H-5 and H-7
observed in production, and it is the single most important reason to redeploy.

### 6.2 Local — heavy ramp on the fixed build, to find the breaking point

`load.mjs http://127.0.0.1:3400 local arc-staging`, `SPECULAR_MAX_INFLIGHT` at its default 64, rate
limiter disabled so the limiter is not the thing being measured.

```
scenario          conc     n   p50     p95      p99      max      rps      err     statuses
health            c=  1   200    0ms     1ms      1ms    262ms    619.2     0%     {"200":200}
health            c=  5   200    1ms     2ms      3ms      4ms   6060.6     0%     {"200":200}
health            c= 20   200    2ms     4ms      5ms      5ms  10000.0     0%     {"200":200}
health            c= 50   250    4ms     8ms      8ms      9ms  10869.6     0%     {"200":250}
health            c=100   500    7ms    17ms     18ms     19ms  11904.8     0%     {"200":500}
health            c=200  1000    7ms    56ms     56ms     59ms  14705.9     0%     {"200":1000}
health            c=400  2000   25ms    44ms     49ms    137ms  12987.0     0%     {"200":2000}
status            c=  1    60  241ms   437ms    568ms    568ms      3.6     0%     {"200":60}
status            c=  5    60  261ms   451ms    492ms    492ms     16.9     0%     {"200":60}
status            c= 20    60  351ms   946ms   1003ms   1003ms     38.2     0%     {"200":60}
status            c= 50   150 7286ms  7876ms   8263ms   8327ms      6.6    69.3%   {"200":46,"502":104}
status            c=100   300    4ms  7658ms   7659ms   7659ms     39.2   100%     {"502":64,"503":236}
mcp_read          c=  1    60 3691ms  7298ms   7405ms   7405ms      0.2     0%     {"200":60}
mcp_read          c=  5    60 6732ms  7516ms   7747ms   7747ms      0.8     0%     {"200":60}
mcp_read          c= 20    60 6857ms  7641ms   7673ms   7673ms      2.9     0%     {"200":60}
mcp_read          c= 50   150 6743ms  7213ms   7237ms   7409ms      7.2     0%     {"200":150}
prepare_simulate  c=  1    30 6344ms  6577ms   6580ms   6580ms      0.2   100%     {"502":30}
prepare_simulate  c=  5    30 6178ms  6272ms   6359ms   6359ms      0.8   100%     {"502":30}
```

**Where the breaking point actually is.** The server itself is not the bottleneck: the cached `/health`
path sustains **~13,000 rps with p99 ≤ 56 ms at concurrency 400** and zero errors. Everything
RPC-bound degrades at **concurrency ≈ 20–50**, and the server log says why — the *upstream public RPC*
throttles:

```
$ grep -o '"error":"[^"]*"' local-load.log | sort | uniq -c | sort -rn | head -1
 538 "error":"exceeded maximum retry limit (request={  }, response={  }, error=null, info={ "
       "requestUrl": "https://arc-testnet.drpc.org",
       "responseBody": "{\"error\":{\"code\":429,\"message\":\"Too many requests\"}}",
       "responseStatus": "599 CLIENT ESCALATED SERVER ERROR (429 Too Many …
```

Two things the fixes do here, both visible in the table:

1. **Failures are now fast and bounded.** Under the same upstream exhaustion the *live* build hangs for
   up to 300 s; the fixed build fails at ~7 s (the 15 s timeout × 3 attempts ceiling, hit earlier by
   the upstream's own 429s). That error text reaches the client as the clean
   `"RPC endpoint rate-limited this server; try again shortly."` — verified: no URL, no library version.
2. **Overload sheds instead of piling up.** At c=100, 236 of 300 requests got an immediate
   `503 + Retry-After: 1` from the in-flight cap rather than queueing behind the upstream.

**Operational conclusion: the constraint on how many agents this server can carry is the upstream RPC
quota, not the container.** With the free public endpoints (`arc-testnet.drpc.org`,
`rpc.mainnet.arc.io`) sustained RPC-bound throughput is roughly **35–40 req/s at concurrency ≤ 20**,
and the fall-off beyond that is a cliff, not a slope.

---

## 7. Before opening the server to Grok Bot / Muse

### Must do

1. **Redeploy.** `railway up --service specular-agent-api --ci` from the repo root. Everything in §1 is
   fixed in the working tree and absent from production. Without it, external hosts hit the 406
   `Accept` rejection (H-8) and the 300-second hangs (H-5) on their very first parallel tool call.
2. **Fix the trust-proxy variable.** Set `SPECULAR_TRUST_PROXY=2` (or delete it so the new default
   applies) on the Railway service. While it stays `1`, rate limiting is per-edge, not per-client, and
   any single caller can lock out every other agent (§4.1).
3. **Verify the hop count from the access log immediately after deploying.** The new log line carries
   both `ip` and the raw `xff` chain; `ip` must equal your real address. If Railway turns out to
   *overwrite* `X-Forwarded-For` rather than append to it, set `SPECULAR_CLIENT_IP_HEADER=x-real-ip`
   instead of changing the hop count.
4. **Move off the free public RPC endpoints, or lower the caps to match them.** §6 shows RPC-bound
   routes are the constraint. Either point `SPECULAR_RPC_ARC_MAINNET` / `SPECULAR_RPC_ARC_STAGING` at a
   paid endpoint, or set `SPECULAR_MAX_INFLIGHT` to something near the upstream's real concurrency
   (≈ 20) so the server sheds early with a `503 + Retry-After` instead of letting every caller wait.
   H-3 keeps a keyed RPC URL out of responses, so a paid endpoint is safe to configure.

### Recommended

5. **Set `SPECULAR_MCP_TOKEN` — yes, require a bearer token. See §7.1.**
6. Narrow `SPECULAR_ALLOWED_ORIGINS` from `*` to the origins that actually need browser access.
7. Keep `SPECULAR_ENABLED_NETWORKS` as it is, and point partner onboarding at `arc-staging` first —
   `arc-mainnet` moves real USDC and every response already flags `realMoney: true`.
8. Re-run `forensics/output/testing-2026-09-20/hosted/probe.mjs <url> --live` and
   `mcp-conformance.mjs <url>` against the new deployment. Expect 205/205 and 56/56; anything less means
   the deploy did not pick up the build.
9. **Do not redeploy the marketplace for H-15.** The server-side mitigation (§2.3) is the agreed
   handling. Partners should be told that `can_top_up` is advisory and that `prepare_supply_liquidity`
   with `simulate: true` immediately before signing is the reliable check.

### 7.1 Should `SPECULAR_MCP_TOKEN` be required? — **Yes, for Grok Bot and Muse specifically.**

The custody argument for leaving it open is sound and unchanged: the server holds no key, refuses to
boot with one, prepares only unsigned transactions, and relays only the canonical encoding of an
allow-listed call to a pinned contract (H-1). An anonymous caller cannot make it move anyone's money.
Section C of `probe.mjs` fires 24 adversarial signed transactions from a throwaway key — foreign
targets, foreign approve spenders, `MaxUint256` approves, `setPlatformFeeRate`/`pause`/`withdrawFees`,
wrong chainId, cross-network replay, `value > 0`, contract creation, non-canonical calldata, unsigned
and garbage RLP — and **every one is refused 4xx without reaching the chain**.

The argument for a token is not custody, it is **availability and attribution**:

- The only real resource this server spends is the operator's **RPC quota**, and §6 shows that a
  handful of concurrent callers exhausts it. Anonymous access means anyone can spend it.
- The rate limiter is the only defence, and it is per-IP — cheap to evade with a few addresses, and
  today (§4.1) not even per-IP.
- With named tokens per integration you can attribute load, revoke one partner without touching the
  others, and raise limits selectively. With no token you have one global dial.

Concrete recommendation: **issue a distinct token to each connector** (`grok-bot`, `muse`, …), keep the
open endpoint available for `arc-staging` only if you want a frictionless demo path, and require the
token for `arc-mainnet`. The bearer check is already implemented with `timingSafeEqual` and is exercised
by `integration.http.test.mjs` ("auth + rate limit when configured"); turning it on is one environment
variable. If a single shared token is chosen instead, it is still a large improvement over open —
but it gives up per-partner revocation, which is the main thing you want when opening to third parties.

---

## 8. Test inventory and results

### 8.1 `mcp-server` suite

```
$ cd mcp-server && npm run build && npm test
```

```
# tests 68
# suites 0
# pass 68
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 22688.189458
```

**68/68 pass** — 52 pre-existing tests + 16 hardening regressions (9 integration, 7 unit), the two
hardening suites now covering H-1…H-15. Before this round the same command reported
**59 tests, 56 pass, 3 fail**: `unit.hardening.test.mjs` would not parse (so H-1…H-4 never ran) and two
suites asserted a staging marketplace address that had been redeployed.

Two environment notes on that run, neither of which affects what is being tested:

- It was executed as `node --test --test-concurrency=1 "test/*.test.mjs"` with
  `SPECULAR_RPC_ARC_STAGING=https://arc-testnet-rpc.publicnode.com`. The default public RPC
  (`arc-testnet.drpc.org`) was returning `429 Too many requests` to this machine's IP for the rest of
  the session — exhausted by **our own** local load test (§6.2), which is itself the point that section
  makes. `--test-concurrency=1` keeps the suite from bursting the substitute endpoint.
- `unit.hardening.test.mjs` now deletes any ambient `SPECULAR_RPC_ARC_STAGING` at the top, so H-3's
  "the public default RPC is shown verbatim" assertion is hermetic regardless of the environment.

Hardening regressions specifically (all green):

```
ok 1 - H-5: hung RPC -> fast 502 on reads and 503 on /health (SPECULAR_RPC_TIMEOUT_MS)
ok 2 - H-6: /health is cached for a short window
ok 3 - H-7: in-flight cap sheds load with 503 + Retry-After instead of queueing
ok 4 - H-8: MCP tolerates Accept without text/event-stream (and no Accept at all)
ok 5 - H-9: MCP protocol errors use -32602 for unknown tool / malformed tools/call
ok 6 - H-10: trust-proxy hop count keys the limiter on the real client, spoofed XFF entries are ignored, chain is logged
ok 7 - H-12: a dead/hung RPC is a 502, never a fabricated "transaction would revert" carrying the endpoint
ok 8 - H-11: REST/MCP error bodies never carry ethers internals
ok 9 - H-14: JSON-RPC batch conformance — array shape, empty batch, and no zod dumps inside a batch
ok 27 - H-1: calldata must be the canonical ABI encoding (no trailing bytes, no padding tricks)
ok 28 - H-2: non-string network values produce a NetworkError, not a TypeError
ok 29 - H-3: operator RPC URL credentials are never exposed to clients
ok 30 - H-4: get_available_liquidity validates query values before any RPC
ok 31 - H-11: broadcast decode errors carry no library internals or upstream host
ok 32 - H-11: cleanErrorText strips ethers detail blocks, URLs and hosts
ok 33 - H-15: correctedCanTopUp mirrors the FIXED predicate, not the deployed off-by-one view
```

### 8.2 Adversarial probe — `hosted/probe.mjs`

```
FIXED BUILD (local, all sections A–E)   PASS 269  FAIL 0   total 269
LIVE DEPLOYMENT (A, B, D, E only)       PASS 198  FAIL 7   total 205
```

The 7 live failures are exactly H-4 (`limit=1.5` accepted, `minAvailableUsdc=1e3` accepted,
7-decimal value → 502), H-9 (unknown tool returned as a tool result) and H-11 (ethers internals in the
broadcast decode error) — each already fixed in the working tree. Section C (signed-transaction relay)
is skipped against live by design.

Coverage by section:

- **A — REST input validation (≈150 cases).** Addresses: short, un-prefixed, 41 nibbles, non-hex, bad
  EIP-55 checksum, ENS name, URL-encoded traversal; all-lowercase accepted (checksum-free form).
  Amounts: negative, zero, `0.0000001`, 7 decimals, `NaN`, `Infinity`, `1e6`, `1e30`, `1e309`, `null`,
  object, array, boolean, hex string, over-cap, Arabic-Indic digits, a 600-character numeral.
  Durations: 0, 6, 366, 7.5, `"week"`, negative, `1e18`. Networks: unknown, wrong case, alias,
  disabled, `__proto__`, `constructor`, 300 characters. Ids and query values. Body handling: malformed
  JSON → 400, 400 KB body → 413, `text/plain` and form-urlencoded rejected, **absent `Content-Type`
  rejected** (so there is no no-preflight cross-origin POST shape). Prototype pollution via
  `__proto__` at top level and nested, and via `constructor.prototype` — each followed by a probe
  request confirming nothing was polluted. Routing: unknown prepare action → 400 with the valid list,
  unknown route → 404 JSON, `GET /mcp` → 405, no `X-Powered-By`.
- **B — MCP tool input validation.** The same hostile values through `tools/call`, plus
  `arguments.__proto__`, a traversal-shaped tool name, and a 400 KB MCP body (→ 413).
- **C — relay adversarial (24 cases, real signed transactions, throwaway key, arc-staging only).**
  Listed in §7.1. Includes the H-1 regressions and both legacy-transaction variants. A well-formed
  allow-listed transaction is also sent, to prove the rejections are meaningful: it passes validation
  and fails only at the chain (`insufficient funds`, unfunded throwaway key) — nothing was mined.
- **D — SSRF / simulate abuse.** `to` is constrained to the pinned contract set: an arbitrary EOA, the
  zero address, the *legacy* staging marketplace, a contract belonging to the *other* network, and
  `http://169.254.169.254/…` / `file:///etc/passwd` / `http://127.0.0.1:3400/health` are all 400.
  Client-supplied `rpcUrl` / `provider` / `chainId` in the body are proven inert by comparing the
  response with and without them. Arbitrary calldata to an allow-listed contract is permitted and is
  `eth_call` only — read-only by construction, no state change, and it is the feature that makes
  `simulate_transaction` useful.
- **E — error-response hygiene.** Thirteen error and metadata routes scanned for stack frames,
  filesystem paths, secret-shaped env names, ethers internals and upstream RPC hosts. Clean on the
  fixed build.

### 8.3 Log hygiene (local stdout, `LOG_LEVEL=debug`, inspected after the full probe)

```
$ python - <<'…'   # distinct JSON keys across every log line
['auth','broadcastPerMin','clientIpHeader','error','errorName','host','ip','level','maxInflight',
 'method','ms','msg','networks','ok','path','port','ratePerMin','rpc','status','tool','tools',
 'transport','trustProxy','ts','version']
```

No request bodies, no headers other than the forwarded-IP chain, no tokens, no raw signed transactions
— the 24 relay attempts in section C produce only `{"method":"POST","path":"/v1/arc-staging/tx/broadcast","status":400,…}`.
The only long hex strings in the logs are wallet addresses that appear inside request paths.

**Informational (accepted):** request paths *are* logged, so wallet addresses appear in operator logs.
That is a privacy property, not a secrecy one, and it is what makes the logs useful; worth stating
explicitly in partner documentation.

### 8.4 Other accepted / informational observations

| # | Observation | Disposition |
|---|-------------|-------------|
| I-1 | A **legacy type-0** transaction with a valid EIP-155 chainId and an allow-listed call **is relayable**. | **Accepted.** The validator is deliberately transaction-type agnostic; a type-0 and a type-2 transaction with identical calldata do identical things. A **pre-EIP-155** legacy transaction (no replay protection, `chainId == 0`) is rejected by the chainId gate — verified (`probe.mjs` C10b). |
| I-2 | Unknown keys in request bodies are **ignored**, not rejected. | **Accepted.** Proven inert for the interesting ones (`rpcUrl`, `provider`, `chainId` — §8.2 D). Strict unknown-key rejection would be a defensible hardening step but is not needed for safety. |
| I-3 | `amount: " 5 "` is accepted as exactly 5 USDC (JS numeric coercion of surrounding whitespace). | **Accepted.** Lenient but not lossy; the value and the resulting calldata are exact. |
| I-4 | `/health` remains unauthenticated and exempt from the rate limiter. | **Accepted** now that it is cached and single-flighted (H-6): its cost is bounded regardless of request rate. |

---

## 9. Reproducing this round

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

# 1. build + full suite
cd mcp-server && npm run build && npm test

# 2. local instance for anything aggressive
SPECULAR_ENABLED_NETWORKS=arc-staging,arc-mainnet PORT=3400 HOST=127.0.0.1 \
  SPECULAR_RATE_LIMIT_PER_MIN=100000 SPECULAR_BROADCAST_LIMIT_PER_MIN=100000 npm start

# 3. adversarial probe (sections A–E; C only ever touches arc-staging)
cd ../forensics/output/testing-2026-09-20/hosted
node probe.mjs http://127.0.0.1:3400

# 4. MCP conformance (read-only; safe against live)
node mcp-conformance.mjs http://127.0.0.1:3400

# 5. load
node load.mjs http://127.0.0.1:3400 local arc-staging      # heavy
node load.mjs https://specular-agent-api-production.up.railway.app live arc-mainnet   # paced, budgeted

# 6. against live (read-only sections, paced for the public rate limit)
node probe.mjs https://specular-agent-api-production.up.railway.app --live
node mcp-conformance.mjs https://specular-agent-api-production.up.railway.app arc-staging
```

Artifacts in `forensics/output/testing-2026-09-20/hosted/`: `probe.mjs`, `mcp-conformance.mjs`,
`load.mjs` and their `*.json` / `*.log` outputs for both targets.

**Safety rails observed throughout:** the relay was exercised **only** against `arc-staging`
(chainId 5042002); no transaction was ever offered to `arc-mainnet` or `base` that could have been
relayed — the one cross-network case (C5b) is rejected by the chainId gate before any provider is
touched. All signing used a freshly generated, unfunded throwaway key; the `.env` key was never read.
No contracts, no root `test/`, and no `scripts/e2e/` files were modified.
