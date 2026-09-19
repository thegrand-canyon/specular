# Documentation Fabrication Audit

Sweep of `*.md` files across the repo for **claims that don't match
verifiable reality**. Companion to [`API_AUDIT.md`](./API_AUDIT.md), which
proved the underlying server-side gap; this document inventories every place
the gap was papered over with a green checkmark.

Findings are grouped by severity. Every claim cited has a quoted line and a
pointer to evidence (live probe, git pickaxe, or another audit doc).

---

## TL;DR

The repo contains **at least 10 distinct documentation files** that assert
features, endpoints, or hostnames are working when they verifiably are not.
The pattern is uniform: a documented happy-path was committed alongside the
SDK, the corresponding server code was never written, and follow-up
documentation (registry submissions, status reports, "PRODUCTION READY"
banners) treated the documented happy-path as deployed.

Three broken hostnames. Four non-existent HTTP routes. Two conflicting
"verified" contract addresses for the same role. One self-reported "100%
test pass rate" against a server route that doesn't exist.

---

## Severity scoreboard

| # | Finding                                           | Severity   | Evidence                          |
|---|---------------------------------------------------|------------|-----------------------------------|
| 1 | `Transaction Builder Endpoints (4/4 ✅)` claim    | CRITICAL   | git history; live 404             |
| 2 | Three broken hostnames in docs                    | CRITICAL   | DNS fail; live `curl` exit 6      |
| 3 | Conflicting Base marketplace addresses            | HIGH       | doc cross-read                    |
| 4 | "Production-ready" banners contradict own audit   | HIGH       | API_AUDIT §0,1,4                  |
| 5 | "14 endpoints, 100% pass" against mock server     | HIGH       | API_AUDIT §0                      |
| 6 | "500-loan marathon" claim vs 308 actual           | MED        | self-reported diff                |
| 7 | Registry submissions reference dead URLs          | MED        | DNS fail                          |
| 8 | Loan response missing `state` field               | MED        | live JSON probe                   |
| 9 | "Coming soon" vs "Production-ready" inconsistency | LOW        | doc cross-read                    |
| 10 | "Verified on BaseScan" without proof              | LOW        | no deployment log in repo         |

---

## §1 (CRITICAL) — Fictional `/tx/*` endpoint test pass

### Quoted claim

`API_TEST_RESULTS.md` lines 38-42:

```
#### Transaction Builder Endpoints (4/4 ✅)
- ✅ `POST /tx/register` - Build agent registration transaction
- ✅ `POST /tx/request-loan` - Build loan request transaction
- ✅ `POST /tx/repay-loan` - Build loan repayment transaction
- ✅ `POST /tx/supply-liquidity` - Build liquidity supply transaction
```

`API_TEST_RESULTS.md` lines 14-16 (top of doc):

```
Total Endpoints Tested: 14
Success Rate: 100%
Failed: 0
```

### Why fabricated

Per [`API_AUDIT.md`](./API_AUDIT.md) §0 + git-history addendum:

- `git log --all -S "app.post('/tx"` → **0 matches across all 58 commits**
- `git log --all -S "router.post('/tx"` → **0 matches across all 58 commits**
- Live POST against `http://localhost:3001` and
  `https://specular-production.up.railway.app` → all 4 routes return 404
- The "passing test" was a hand-rolled mock server inside the test script,
  not the actual API server (`src/api/MultiNetworkAPI.js`)

### Files repeating the claim

| File                                          | Reference                            |
|-----------------------------------------------|--------------------------------------|
| `API_TEST_RESULTS.md`                         | Lines 14-16, 38-42, 129-143          |
| `AGENT_API_README.md`                         | Multiple references to `/tx/*`       |
| `AGENT_API_GUIDE.md`                          | Multiple references to `/tx/*`       |
| `QUICKSTART.md`                               | "5-minute" example uses `/tx/*`      |
| `registry-submissions/x402-protocol-submission.md` | API endpoints section           |
| `src/sdk/SpecularSDK.js` (code, not doc)      | Calls `/tx/register`, etc.           |
| `src/sdk/examples/quickstart.js`              | Calls SDK that calls `/tx/*`         |

---

## §2 (CRITICAL) — Three broken hostnames documented as live

### Hostname matrix

| Hostname                                    | DNS resolves? | Returns 200? | Documented as live?         |
|---------------------------------------------|---------------|--------------|------------------------------|
| `api.specular.network`                      | ❌ NXDOMAIN   | n/a          | ✅ moltbook scripts, registry |
| `api.specular.finance`                      | ❌ NXDOMAIN   | n/a          | ✅ API_TEST_RESULTS.md        |
| `api.specular.xyz`                          | ❌ NXDOMAIN   | n/a          | ✅ PROMPT_FOR_SEO_LANDING_PAGE.md, RAILWAY_DEPLOYMENT.md |
| `specular-production.up.railway.app`        | ✅ resolves   | ✅ /health   | ✅ FOR_AI_AGENTS_ENHANCED.md  |
| `localhost:3001`                            | ✅ local      | ⚠ /tx → 404 | ✅ default in many docs       |

### Quoted claim (one of many)

`API_TEST_RESULTS.md` lines 277-282:

```
Example: New Agent in 5 Minutes

// 1. Discover (1 min)
const api = await fetch('http://api.specular.finance/arc/.well-known/specular.json');
// 2. Check profile (30 sec)
const me = await fetch(`http://api.specular.finance/arc/agents/${myAddress}`);
// 3. Register (1 min)
const registerTx = await fetch('http://api.specular.finance/arc/tx/register', { ... });
```

### Evidence

- `dig +short api.specular.finance` → no records (verified live this session)
- `dig +short api.specular.network` → no records
- `curl http://api.specular.finance/` → exit code 6 (could not resolve host)
- The only working hostname (`specular-production.up.railway.app`) returns
  404 for every documented `/tx/*` route — see §1 above

### Files affected

`registry-submissions/{ai16z,defillama,x402-protocol}-submission.md`,
`API_TEST_RESULTS.md`, `QUICKSTART.md`, `PROMPT_FOR_SEO_LANDING_PAGE.md`,
`RAILWAY_DEPLOYMENT.md`, plus various `.js` consumer scripts (which thereby
inherit the failure as a runtime error rather than a doc bug).

---

## §3 (HIGH) — Conflicting Base mainnet marketplace addresses

### Two addresses claimed for the same role

`DEFI_AGGREGATOR_SUBMISSION.md` lines 20-23:

```
| AgentLiquidityMarketplace | `0x77f8D49C706A566Eecc9a2C3DD6556D5be54CACE` | ✅ [BaseScan](...) |
```

`DEFI_AGGREGATOR_SUBMISSION.md` line 33 (later in same file):

```
AgentLiquidityMarketplace: 0x2f24Ca82Cac2a0034eEA2E128328BAdA94A5E4B6
```

`https://specular-production.up.railway.app/.well-known/specular.json`
returns yet a **third** address (verified live this session):

```json
"agentLiquidityMarketplace": "0xd7b4dEE74C61844DFA75aEbe224e4635463b1C8f"
```

### Why suspect

Three different addresses, one role, one network. Two are tagged
"✅ Verified on BaseScan" without explaining which one is current. The
production manifest disagrees with both of the `.md`-listed addresses.

The on-chain probe (this session) shows
`0xd7b4dEE7...` has `totalPools = 1, nextLoanId = 1` — i.e. the canonical
production marketplace is essentially unused. The other two addresses are
either previous deployments left in docs after upgrades, or copy-paste from
testnet.

### Files affected

`DEFI_AGGREGATOR_SUBMISSION.md`, `FOR_AI_AGENTS_ENHANCED.md`,
`registry-submissions/defillama-submission.md`,
`CROSS_NETWORK_COMPARISON_2026-04-29.md`.

---

## §4 (HIGH) — "Production-ready" claim contradicts in-repo audit

### Quoted claims

`FOR_AI_AGENTS_ENHANCED.md` line 6:

```
Status: ✅ Production-ready
✅ 100% uptime since launch
```

`ULTIMATE_TESTING_SUMMARY_2026-02-20.md` line 6:

```
PRODUCTION VALIDATED AT MASSIVE SCALE
```

`COMPREHENSIVE_TESTING_REPORT.md`:

```
97.4% pass rate - Production ready
```

`ARBITRUM_TRAILBLAZER_GRANT_APPLICATION.md`:

```
Operational API with 100% uptime
```

### Contradicting evidence (same repo)

[`API_AUDIT.md`](./API_AUDIT.md) documents three CRITICAL/HIGH unfixed bugs:

- §0 — `/tx/*` routes 404 in production
- §1 — `/agent/:id/loans` response object has no `state` field (verified live)
- §4 — `/agent/:address` walks all 2094+ loans on Arc; cold-cache
  response time **>60 seconds**

A "production-ready" service that 404s on its documented happy-path and
takes a minute to answer a profile lookup is not production-ready by any
sensible definition.

---

## §5 (HIGH) — "14 endpoints, 100% pass" against mock server

### Quoted claim

`API_TEST_RESULTS.md` lines 14-16:

```
Total Endpoints Tested: 14
Success Rate: 100%
Failed: 0
```

### Why fabricated

The test script that produced this number boots its own mock server inside
the test process, then asserts that the mock returns expected shapes. The
real API server (`src/api/MultiNetworkAPI.js`) was never under test —
verified by reading the test source against the API server source.

When the same test suite is pointed at the actual server (this session), 4
of 14 endpoints (the entire transaction-builder family) return 404
immediately.

The "100%" reflects the mock matching itself, not the deployed API matching
its documentation.

---

## §6 (MED) — Inflated test-volume claims

### Quoted vs actual

| Claim                                              | Actual                                |
|----------------------------------------------------|---------------------------------------|
| `ULTIMATE_TESTING_SUMMARY: "Total Loan Cycles: 546+"` | self-reported, no external verification |
| `FOR_AI_AGENTS_ENHANCED: "1,500+ loans processed"`  | self-reported, no external verification |
| `500_LOAN_MARATHON_FINAL_RESULTS.md: "500 sequential loans"` | 308 successful (61.6%) per same file |

### Why suspect

These are framed as performance achievements but are entirely internal
self-tests. The 500-loan marathon document is honest about the 61.6% success
rate within its body, but the headline number became "500" in summary
documents without the success-rate qualifier.

This is borderline-acceptable optimization-language in a status report, but
crosses into fabrication when reproduced in registry submissions
(`registry-submissions/*.md`) presented to third parties as if they were
external benchmarks.

---

## §7 (MED) — Registry submissions reference dead URLs

### Quoted claim

`registry-submissions/ai16z-submission.md` line 60:

```
"npm install @specular/eliza-plugin"
"apiUrl": "http://api.specular.network"
```

### Reality

- `api.specular.network` does not resolve in DNS (see §2)
- `@specular/eliza-plugin` is not on the npm registry (`npm show @specular/eliza-plugin` → 404)
- `registry-submissions/x402-protocol-submission.md` references the same
  fictional `/tx/*` API surface as §1

### Why concerning

Registry submissions are the public-facing claim of "this works, integrate
with us". Submitting to ai16z / DefiLlama / x402 with documentation that
references unreachable hostnames and unpublished packages is a
reproducibility failure that's externally visible the moment a downstream
integrator tries to follow the instructions.

---

## §8 (MED) — Loan response field documented but missing

### Documented contract

Multiple consumer scripts and downstream docs assume the
`/agent/:id/loans` response contains `loan.repaid` and `loan.defaulted`
booleans, OR a numeric `loan.state`.

### Actual response (probed live this session, Arc Testnet, agent 43)

```json
{
  "loanId":       2093,
  "borrower":     "0x6560...fce2",
  "amount":       "5000000",
  "interestRate": 500,
  "duration":     604800,
  "startTime":    1777584942,
  "endTime":      1778189742,
  "role":         "borrower"
}
```

No `state`. No `repaid`. No `defaulted`. Consumers can't tell ACTIVE from
REPAID from DEFAULTED purely from the response.

The on-chain `loans(loanId)` view returns all 10 fields including `state`
(uint8) — see [`SCHEMA_VERIFICATION.md`](./SCHEMA_VERIFICATION.md) — but
the API drops the field when constructing the JSON.

This is documented in [`API_AUDIT.md`](./API_AUDIT.md) §1 as a server bug;
mentioned here because docs that rely on the field's presence (e.g.
`AGENT_API_GUIDE.md`'s "loan state machine" section) are misleading
consumers about what the wire format actually carries.

---

## §9 (LOW) — "Coming soon" vs "Production-ready"

`FOR_AI_AGENTS.md` line 6:

```
API: https://specular-production.up.railway.app (coming soon)
```

`FOR_AI_AGENTS_ENHANCED.md` line 6 (in same repo):

```
Status: ✅ Production-ready
```

Two documents claiming opposite states for the same URL on the same day.
Likely an artifact of `_ENHANCED.md` being a forked-and-rewritten copy of
`.md` without retiring the original.

---

## §10 (LOW) — "Verified on BaseScan" without on-repo proof

### Pattern

Multiple submission docs include rows like:

```
| Contract | Address | Verified |
| AgentRegistryV2 | 0xb999... | ✅ [BaseScan](...) |
```

### What's missing

The repo contains:
- No `deployments/` directory
- No `hardhat-deploy` artifacts
- No saved deployment receipt JSON
- No transaction hashes for the deployment txs

The "✅ Verified" tag relies entirely on the reader following the BaseScan
link and seeing the source code. That works (the contracts ARE verified on
BaseScan) — but the doc gives no path to confirm the address shown matches
what the rest of the repo treats as canonical (see §3 for the conflict).

A trustworthy version of this table would include:
- The deployment tx hash (so a reader can `eth_getTransactionReceipt` it)
- The deployer address that should match the on-chain `owner()`
- A link to the manifest in this repo that names the same address

The current docs include the BaseScan link only.

---

## Pattern analysis

The fabrications all trace to **one architectural gap** that propagated
outward:

```
                       ┌────────────────────┐
                       │   SpecularSDK.js   │
                       │   committed with   │
                       │   /tx/* fetches    │
                       │   that point at    │
                       │   nonexistent      │
                       │   server routes    │
                       └─────────┬──────────┘
                                 │ used in
                                 ▼
              ┌──────────────────────────────────┐
              │   Test scripts mock /tx/*        │
              │   to make assertions pass        │
              └─────────┬────────────────────────┘
                        │ documented as
                        ▼
              ┌──────────────────────────────────┐
              │   API_TEST_RESULTS.md says       │
              │   "14 endpoints, 100% pass"      │
              └─────────┬────────────────────────┘
                        │ cited by
                        ▼
              ┌──────────────────────────────────┐
              │   FOR_AI_AGENTS_ENHANCED.md says │
              │   "Production-ready, 100% uptime"│
              └─────────┬────────────────────────┘
                        │ used as evidence in
                        ▼
              ┌──────────────────────────────────┐
              │   Registry submissions           │
              │   (ai16z, DefiLlama, x402)       │
              │   pointing at dead hostnames     │
              └──────────────────────────────────┘
```

Each layer "verified" the layer above it without ever testing the actual
deployed server. Once `OPTION2_FEASIBILITY.md` is implemented (or the `/tx/*`
routes are added server-side per Option 1), the whole stack collapses into
truth — but until then, every document downstream of `SpecularSDK.js` is
making promises the system can't keep.

---

## Cleanup recommendations

In ascending order of effort:

1. **Add a doc-status banner** to every `*.md` that touches the SDK happy
   path:
   ```
   > ⚠ This document references the SDK's `/tx/*` HTTP routes. As of
   > <date>, those routes return 404 — see src/sdk/API_AUDIT.md §0 and
   > OPTION2_FEASIBILITY.md.
   ```
   Cheapest possible mitigation; doesn't fix anything but stops new
   integrators from wasting hours debugging.

2. **Delete the three dead hostnames** from all docs. Replace with:
   - `https://specular-production.up.railway.app` (the only working URL)
   - `http://localhost:3001` (for local dev)
   - Anything else is misleading.

3. **Reconcile the contract address conflict (§3)**. Pick the canonical
   manifest's value (`0xd7b4dEE7...`) as truth, retire the other two with
   `_DEPRECATED` markers, and add deployment tx hashes for the live one.

4. **Re-run `API_TEST_RESULTS.md` against the actual server**. Update the
   pass/fail counts honestly. Likely outcome: 10/14 pass (the read paths)
   and 4/14 fail (the `/tx/*` family) until Option 2 ships.

5. **Move "PRODUCTION READY" claims behind a CI gate**. Have a single
   test that probes every documented endpoint against the live URL and
   updates a status badge. If the test fails, the badge goes red. Stops
   future drift between "what we say" and "what we ship".

6. **Implement Option 2** ([`OPTION2_FEASIBILITY.md`](./OPTION2_FEASIBILITY.md)).
   Once the SDK encodes calldata locally, `/tx/*` is no longer load-bearing
   and most of the fabrications above become true retroactively. Net SDK
   delta: -10 LOC.

---

## Cross-reference

- [`API_AUDIT.md`](./API_AUDIT.md) — server-side gap that motivates this audit
- [`OPTION2_FEASIBILITY.md`](./OPTION2_FEASIBILITY.md) — the recommended fix
- [`DRIFT_AUDIT.md`](./DRIFT_AUDIT.md) — consumer-side drift in JS scripts
- [`SCHEMA_VERIFICATION.md`](./SCHEMA_VERIFICATION.md) — confirms `SCHEMA.md` matches on-chain
- [`FRONTEND_AUDIT.md`](./FRONTEND_AUDIT.md) — UI-side consequences of these gaps
- [`VIRTUALS_SDK_AUDIT.md`](./VIRTUALS_SDK_AUDIT.md) — second SDK with overlapping problems
