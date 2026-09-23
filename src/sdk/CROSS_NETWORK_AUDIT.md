# Cross-Network Audit — Arc Testnet vs Base Mainnet

End-to-end audit comparing the two live deployments of the Specular protocol.
Combines (a) direct on-chain probes against both networks, (b) production API
endpoint matrix at `specular-production.up.railway.app`, and (c) live
transaction cycle on Arc.

> **Scope notes.** Audit performed 2026-05-02. Arc Testnet block 40,171,000–
> 40,173,000; Base Mainnet block 45,474,600. All findings are read-only
> evidence except for §LIVE which performed one borrow+repay cycle on Arc
> (loanId 2094, txs `0x79be9469…` and `0x53aec0a8…`).

---

## TL;DR

Arc and Base are **not running the same protocol code**. Despite identical-
looking artifact references in the repo, the two networks have materially
different contracts, materially different operational health, and the public
API is currently broken on Arc due to free-tier RPC rate-limiting.

Most-severe drift:

- **§N1 (CRITICAL)**: Arc marketplace is running the **pre-H-04 build**
  (`MAX_LENDERS_PER_POOL=200`); Base is running the post-fix build (=50).
  Repo notes "v5_WITH_FIX deployed but not authorized" — meaning the fix
  exists on-chain but isn't in use.
- **§N2 (CRITICAL)**: Arc production API endpoints all return 500. drpc.org
  free tier is 429-rate-limiting the cache syncer (86.7% sync failure rate
  per `/stats`). Cache for Arc is stale; Base cache is healthy.
- **§N3 (HIGH)**: Arc and Base ReputationManagerV3 are different contract
  versions. Arc lacks 7 public getters that Base exposes
  (`onTimeRepaymentBonus`, `defaultPenaltyBase`, etc.). On Arc these are
  hardcoded constants; on Base they're owner-tunable storage.
- **§N4 (HIGH)**: Base mainnet is functionally unused (3 agents, 1 pool,
  0 loans completed); Arc has 81 agents, 40 pools, 2,094 loans cycled.
  All production-readiness narrative ignores this asymmetry.

---

## §0 Network-summary table

| Field                       | Arc Testnet                                  | Base Mainnet                                 |
|-----------------------------|----------------------------------------------|----------------------------------------------|
| ChainId                     | 5042002 (Arc Testnet)                        | 8453                                         |
| Marketplace                 | `0x048363A3…71D3` (v4)                       | `0xd7b4dEE7…1C8f`                            |
| Registry                    | `0x741C03c0…faD7`                            | `0xb9996de0…9Aaa`                            |
| Reputation                  | `0x94F2fa47…467F` (4119 bytes)               | `0xf19b1780…0527` (5505 bytes)               |
| USDC                        | `0xf2807051…9895` (Mock USDC)                | `0x83358…2913` (Circle USD Coin)             |
| Owner (all 3)               | `0x800e305A0c…F72C` ✅ unified                | `0x800e305A0c…F72C` ✅ unified                |
| MAX_LENDERS_PER_POOL        | **200** ❌ pre-H-04                           | **50** ✅ post-H-04                           |
| MAX_ACTIVE_LOANS_PER_AGENT  | 10                                           | 10                                           |
| MIN/MAX_LOAN_DURATION       | 7 / 365 days                                 | 7 / 365 days                                 |
| platformFeeRate             | 100 bps (1.0%)                               | 100 bps (1.0%)                               |
| Paused?                     | false                                        | false                                        |
| Total agents                | 81                                           | 3                                            |
| Total pools                 | 40                                           | 1                                            |
| Loans created (nextLoanId)  | **2,094**                                    | **1**                                        |
| Marketplace USDC balance    | 38,113.94                                    | 285.00                                       |
| Accumulated fees            | 1.029 USDC                                   | 0                                            |
| Production API health       | ❌ 500 on every read                          | ✅ 200 (sub-100ms typical)                    |

---

## §1 Severity scoreboard

| #     | Severity  | Component                       | Finding (one-liner)                                                                                  |
|-------|-----------|---------------------------------|------------------------------------------------------------------------------------------------------|
| §N1   | CRITICAL  | Arc marketplace                 | Running pre-H-04 contract with `MAX_LENDERS=200`; v5 deployed but unauthorized                        |
| §N2   | CRITICAL  | Production API (Arc routes)     | All `?network=arc` endpoints 500; drpc free tier rate-limits killing the cache syncer                |
| §N3   | HIGH      | Reputation contract drift       | Arc and Base run different `ReputationManagerV3` builds (4119 vs 5505 runtime bytes; 7 getters diff) |
| §N4   | HIGH      | Base activity                   | Base mainnet has 3 agents / 1 pool / 0 completed loans; "production" claims ignore this              |
| §N5   | HIGH      | Manifest scope                  | `/.well-known/specular.json` only describes Base; no Arc manifest published                          |
| §N6   | HIGH      | Cache health                    | `syncs:7261, syncFailures:6297` (86.7% failure rate) per live `/stats`                               |
| §N7   | MED       | Arc historical-version sprawl   | `arc-testnet-addresses.json` lists 5 marketplace addresses (v1–v5), only v4 is live                  |
| §N8   | MED       | Marketplace gas footprint       | Arc borrow gas = 3.81M (lender-loop unbounded by H-04); Base would be lower                          |
| §N9   | MED       | API query default               | `?network` defaults to Base (3 agents) instead of Arc (81 agents); silently misroutes UI             |
| §N10  | LOW       | "Arbitrum" cache slot           | `/stats` reports an Arbitrum cache (0/0); contracts not deployed but config wired                    |
| §N11  | LOW       | API endpoint coverage           | `/loans`, `/leaderboard`, all `/tx/*`, `/credit/*`, all `/virtuals/*` return 404 on both networks    |
| §N12  | INFO      | Live cycle works on Arc         | borrow + repay completed in ~11s; loan #2094; 0.000958 USDC net cost                                  |
| §N13  | LOW       | Pool accounting naming          | `availableLiquidity > totalLiquidity` is correct (interest reinvested) but field names mislead; 600-wei rounding loss in lender shares |

---

## §N1 (CRITICAL) — Arc marketplace is the pre-H-04 build

Live constants (read this session):

```
ARC : MAX_LENDERS_PER_POOL = 200
BASE: MAX_LENDERS_PER_POOL = 50
```

`src/config/arc-testnet-addresses.json` documents the situation candidly:

```json
"agentLiquidityMarketplace": "0x048363A325A5B188b7FF157d725C5e329f0171D3",
"agentLiquidityMarketplace_v5_WITH_FIX": "0x9EF0DD53F4412B5D5250B6797f6E347912877A2B",
"agentLiquidityMarketplace_v5_note": "H-04 security fix (MAX_LENDERS=50) - not authorized yet",
"upgradeReason_v5": "[H-04 FIX] MAX_LENDERS_PER_POOL reduced from 200 to 50",
"deployerForUpgrade_v5": "0x656086A21073272533c8A3f56A94c1f3D8BCFcE2"
```

Notes:

- v5 deploy was done by the **compromised wallet**
  (`0x656086A2…`); the rotated owner (`0x800e305A0c…`) cannot complete the
  authorization handoff to v5 without re-executing the deploy or transferring
  ownership of v5 first.
- Live Arc cycle this session burned **3,812,236 gas on requestLoan** (§N8) —
  consistent with the lender-distribution loop being uncapped at 200.

### Impact

Any pool on Arc that grows past 50 lenders runs into the H-04 attack class
(unbounded loop ⇒ DoS-via-gas-griefing on lender ops). Today Arc pools have
≤ 2 lenders (per the §N12 cycle's pool 43 inspection), so the issue is
latent. Risk increases as adoption increases.

### Recommendation

- Decide whether Arc Testnet is deprecated or production-track. If
  production: re-deploy v5 from the secure wallet and migrate pool
  accounting, then deprecate the v4 address.
- If deprecated: pause v4 (already callable: `paused()=false`, `pause()`
  exists), document Arc as legacy in the manifest, point the production
  API away from Arc.

---

## §N2 (CRITICAL) — Production API broken on Arc

Live test of every documented Arc-network route at
`specular-production.up.railway.app`:

| Route                            | Status | Latency | Body                                                            |
|----------------------------------|--------|---------|-----------------------------------------------------------------|
| `/agents?network=arc`            | 500    | 2723ms  | `"exceeded maximum retry limit … 429 Too Many Requests"`        |
| `/pools?network=arc`             | 500    | 2636ms  | (same)                                                          |
| `/agent/1?network=arc`           | 500    | 2592ms  | (same)                                                          |
| `/agent/1/loans?network=arc`     | 500    | 2535ms  | (same)                                                          |
| `/stats`                         | 200    | 59ms    | shows `arc.status: "stale"`                                      |
| `/.well-known/specular.json`     | 200    | 326ms   | Base-only manifest (§N5)                                         |

Underlying cause from `/stats` body:

```json
"blockchainCache": {
  "syncs": 7261,
  "syncFailures": 6297,
  "hitRate": "99.58%",
  "lastSync": {
    "arc": "2026-05-02T16:22:24.857Z",
    "base": "2026-05-02T16:21:49.205Z"
  }
},
"cacheHealth": {
  "arc":  { "status": "stale",   "lastSync": "2026-05-02T15:33:31.653Z", "agents": 60, "pools": 40 },
  "base": { "status": "healthy", "lastSync": "2026-05-02T16:21:49.205Z", "agents": 3,  "pools": 1  }
}
```

86.7% sync failures, Arc cache marked stale, Arc cache shows 60 agents but
the **contract has 81** — the cache is missing 21 newer registrations.

### Impact

- Frontend pages that pass `?network=arc` get 500s with no graceful fallback
- Even Base routes work only by luck: cache is healthy now, but the same
  drpc rate-limit logic applies if Base's RPC ever degrades
- 99.58% cache hit rate is misleading — the misses are probably the only
  ones an end-user actually waits on, and those are the ones that 500

### Recommendation

- Move Arc off drpc free tier — even a single $50/mo Alchemy/Infura/Quicknode
  endpoint would resolve this
- Add a circuit-breaker that returns 503 (not 500) when RPC is rate-limited
  so clients can implement retries
- Cache should serve stale data with `Warning: 110` header instead of
  cascading the 429 to clients (would turn this from CRITICAL to LOW)

---

## §N3 (HIGH) — Reputation contract drift

Both networks have `ReputationManagerV3` at the addresses claimed by their
respective config files, but they are **not the same contract**:

| Selector                       | Arc                                | Base                              |
|--------------------------------|------------------------------------|-----------------------------------|
| Runtime bytecode size          | 4,119 bytes                        | 5,505 bytes                       |
| `validationRegistry()`         | REVERT (function does not exist)   | `0x0000…0000` (zero address)      |
| `onTimeRepaymentBonus()`       | REVERT                             | `10`                              |
| `defaultPenaltyBase()`         | REVERT                             | `50`                              |
| `defaultPenaltyLarge()`        | REVERT                             | `100`                             |
| `validationBonusThreshold()`   | REVERT                             | `75`                              |
| `validationCreditBonus()`      | REVERT                             | `2_000_000_000` (2,000 USDC)      |
| `largeLoanThreshold()`         | REVERT                             | `10_000_000_000` (10,000 USDC)    |
| `getReputationScore(address)`  | `0`                                | `0`                               |
| `calculateInterestRate(addr)`  | `0x05dc` = 1500 bps                | `0x05dc` = 1500 bps               |
| `calculateCreditLimit(addr)`   | `0x3b9aca00` = 1000 USDC           | `0x3b9aca00` = 1000 USDC          |

### Interpretation

Arc's older contract has these values **hardcoded as Solidity constants**.
Base's newer contract makes them **owner-mutable storage variables**, exposed
via auto-generated getters.

Default values match across networks (1500 bps, 1000 USDC, 100% collateral),
so behavior is currently identical for new agents. Drift would emerge only
if the Base owner ever calls a setter (none of the setters were probed).

### Impact

- Any client that introspects reputation parameters (analytics, monitoring,
  research) gets different surfaces per network
- `src/sdk/SCHEMA.md` describes a reputation contract; the doc's accuracy
  depends on which network you're on — should be split or annotated
- A future Base owner action (e.g., raise `largeLoanThreshold` to suppress
  validator bonuses for whales) would silently apply only to Base

### Recommendation

- Align by deploying Arc's V3.1 (with public storage) — same migration story
  as §N1
- Or document SCHEMA.md gaps explicitly per network
  ([`SCHEMA_VERIFICATION.md`](./SCHEMA_VERIFICATION.md) §G1 already flags
  the missing `getReputation()` aggregate; add §G7 for this drift)

---

## §N4 (HIGH) — Base mainnet is functionally unused

Live counters as of this session:

| Metric                                    | Arc            | Base    |
|-------------------------------------------|----------------|---------|
| `AgentRegistryV2.totalAgents()`           | 81             | 3       |
| `AgentLiquidityMarketplace.totalPools()`  | 40             | 1       |
| `AgentLiquidityMarketplace.nextLoanId()`  | 2094           | 1       |
| Marketplace USDC balance                  | 38,113.94      | 285.00  |
| Accumulated platform fees                 | 1.029          | 0       |

Base mainnet has not seen a single completed loan. The lone pool is the
`0x800e305A…F72C` deployer's own pool funded with 285 USDC.

### Impact on prior audits

- [`DOC_FABRICATION_AUDIT.md`](./DOC_FABRICATION_AUDIT.md) §4 ("Production-
  ready" claims) — this is the empirical contradiction. Test volume that was
  claimed to demonstrate Base readiness all happened on Arc Testnet
- Registry submissions referencing `https://specular-production.up.railway.app`
  are presenting Base-mainnet endpoints with a 1-pool dataset

### Recommendation

- Reframe Base mainnet as "deployed and instrumented; awaiting first agent
  cohort" rather than "production"
- Or re-run the Arc test cohort against Base before any external integrations
  are pitched as production

---

## §N5 (HIGH) — Manifest only describes Base

```json
GET /.well-known/specular.json →
{
  "protocol": "Specular",
  "version": "3",
  "network": "base",
  "networkName": "Base Mainnet",
  "chainId": 8453,
  "contracts": { ... base addresses ... }
}
```

There is no per-network manifest path, no `?network=arc` variant, no
catalog endpoint listing all networks the API serves. The manifest's
existence is the canonical source-of-truth pattern documented in
[`README.md`](./README.md) — but it omits the network with 96% of the
activity.

### Recommendation

- Either expose `/.well-known/specular.json?network=arc` returning the Arc
  contract set, OR
- Reshape the manifest to a top-level catalog: `{ networks: { arc: {...},
  base: {...} } }`, with current single-network response moved to
  `/.well-known/specular.json?network=base` for back-compat

---

## §N6 (HIGH) — Cache failure rate is hidden behind hit rate

`/stats` reports `hitRate: "99.58%"` while simultaneously reporting
`syncFailures/syncs = 6297/7261 = 86.7%`. These two metrics measure
different things and the high hit-rate buries the bad sync-rate in the
dashboard.

The 99.58% hit rate is a tautology: serving stale-cache content always
"hits" the cache. What matters for correctness is whether the cache is
fresh enough to be trustworthy — `cacheHealth.arc.status: "stale"` is the
real signal here, and it's not surfaced as an alarm.

### Recommendation

- Add a `cache_freshness_seconds` metric per network and alert if > 5×TTL
- Treat 5xx on the underlying RPC as a cache-eviction event, not a re-serve

---

## §N7 (MED) — Arc historical version sprawl

`src/config/arc-testnet-addresses.json` references **5 marketplace addresses**:

| Suffix                        | Address                                      | Status / Note                                         |
|-------------------------------|----------------------------------------------|-------------------------------------------------------|
| `agentLiquidityMarketplace`   | `0x048363A3…71D3`                            | **Live** (v4)                                         |
| `..._v4`                      | `0x048363A3…71D3`                            | Backup pointer to current live                        |
| `..._v5_WITH_FIX`             | `0x9EF0DD53…7A2B`                            | Deployed, **not authorized** (§N1)                    |
| `..._v2`                      | `0xFBF9509A…1D7A`                            | Backed up before resetPoolAccounting upgrade          |
| `..._old`                     | `0xD1cf6E78…7559`                            | Backed up before [SECURITY-01] upgrade                |

Plus three notes referencing the **compromised wallet** (`0x656086A2…`,
"⚠️ COMPROMISED WALLET - Private key exposed on GitHub") that performed
multiple historical deploys.

### Impact

- `src/api/MultiNetworkAPI.js` (and any consumer) must pick exactly one
  field — typo'ing `_v4` instead of the canonical key would silently work
  today (same address) but fail on the next upgrade
- Indexers, analytics tools, registry submissions, any external reference
  may be pointing at any of the historical addresses

### Recommendation

- Move historical addresses to a separate `arc-testnet-addresses.history.json`
- Keep the live config minimal (5 keys: registry, reputation, marketplace,
  USDC, owner) matching the Base config shape

---

## §N8 (MED) — Arc borrow gas is 3.81M

From the live cycle (§N12):

```
Step 3: requestLoan(1 USDC, 7 days)
  gas used: 3,812,236     ← borrow
Step 5: repayLoan(2094)
  gas used:   144,476     ← repay (28× cheaper)
```

The borrow path's gas cost scales with `MAX_LENDERS_PER_POOL` because
it iterates over pool lenders to allocate the loan. Arc's =200 cap (§N1)
makes this expensive even though pool 43 only had 2 lenders.

### Impact

- At Arc Testnet's negligible gas price this is invisible. On Base mainnet
  with the same code this would be ~$1.50 per borrow at 0.05 gwei.
- The H-04 fix (`MAX_LENDERS=50`) reduces the worst-case loop bound by 4×
  but doesn't eliminate it — the actual fix would be to switch from
  push-based lender accounting to a pull-based claim model

### Recommendation

- Profile a 50-lender pool to confirm Base's worst-case gas before pushing
  Base into actual usage
- Consider pull-based interest claims as a follow-on optimization

---

## §N9 (MED) — API default network is Base

`/agents` (no query param) and `/pools` (no query param) silently target
Base. UI components that don't pass `?network=…` see only the 3-agent /
1-pool dataset. Any frontend chrome that lists "all agents" without
specifying network shows ~4% of reality.

### Recommendation

- Either make the default Arc (where the data is), OR
- Reject requests without `?network=` with a 400 listing valid options

---

## §N10 (LOW) — Arbitrum cache slot is wired but empty

`/stats` reports a third network slot:

```
"arbitrum": { "status": "healthy", "lastSync": ..., "agents": 0, "pools": 0 }
```

No corresponding entry in `src/config/`, no manifest, no contracts.
Configuration includes the network but nothing was deployed.

### Recommendation

- Either deploy Arbitrum or remove the slot from the cache config

---

## §N11 (LOW) — Documented endpoint surface vs reality

Routes that return 404 on both networks (verified live):

| Method | Path                              | Documented in                                |
|--------|-----------------------------------|----------------------------------------------|
| GET    | `/loans`                          | `API_TEST_RESULTS.md`                        |
| GET    | `/leaderboard`                    | `frontend/js/pages/leaderboard.js`           |
| POST   | `/tx/register`                    | `src/sdk/SpecularSDK.js`                     |
| POST   | `/tx/request-loan`                | `src/sdk/SpecularSDK.js`                     |
| POST   | `/tx/repay-loan`                  | `src/sdk/SpecularSDK.js`                     |
| GET/POST | `/credit/:address`              | `frontend/js/pages/identity.js`              |
| POST   | `/virtuals/credit-check`          | `sdk/virtuals/SpecularSDK.js`                |
| POST   | `/virtuals/apply`                 | `sdk/virtuals/SpecularSDK.js`                |
| POST   | `/virtuals/confirm`               | `sdk/virtuals/SpecularSDK.js`                |
| GET    | `/virtuals/agent/:address`        | `sdk/virtuals/SpecularSDK.js`                |
| GET    | `/virtuals/pools`                 | `sdk/virtuals/SpecularSDK.js`                |

Cross-references to existing audits:
- [`API_AUDIT.md`](./API_AUDIT.md) §0 — `/tx/*` never existed
- [`VIRTUALS_SDK_AUDIT.md`](./VIRTUALS_SDK_AUDIT.md) §V1 — `/virtuals/*`
- [`FRONTEND_AUDIT.md`](./FRONTEND_AUDIT.md) §F1 — `/credit/:address`
- [`DOC_FABRICATION_AUDIT.md`](./DOC_FABRICATION_AUDIT.md) §1 — fabricated
  pass results for `/tx/*`

This audit's contribution is the **exhaustive live confirmation across both
networks**: not a single one of these routes works on Arc OR Base today.

---

## §N12 (INFO) — Live cycle on Arc succeeded

Performed end-to-end as proof the read+write paths still function:

```
Wallet:        0x656086A21073272533c8A3f56A94c1f3D8BCFcE2
Pool:          agent 43 (totalLiquidity 1,900 USDC, lenderCount 2)
Loan amount:   1.0 USDC
Duration:      7 days
Collateral:    0% (top-tier reputation)

Step 3 borrow tx: 0x79be94699b18c9d10d5c76f88249a634a2834165649b542b02e293a68ba328cf
  block: 40,173,079
  gas:   3,812,236
  state: REQUESTED → ACTIVE
  loanId: 2094

Step 5 repay tx:  0x53aec0a810c349caea6b7a90a38b90daed761097c4523b879363039864dc65ef
  block: 40,173,089
  gas:   144,476
  state: ACTIVE → REPAID

Step 6 final:
  loan.state: 2 (REPAID)
  USDC delta: -0.000958 (interest + fee for ~50s borrow)
```

Confirms:
- Marketplace transactions still mine on Arc despite stale cache
- Loan state machine works (REQUESTED → ACTIVE → REPAID)
- 10-block latency from borrow to repay-confirmed (~50s wall clock)
- ABI matches the deployed contract for the heavy paths

### Base cycle skipped — wallet underfunded

```
Base wallet 0x800e305A0c…F72C
  ETH:  0.000371915326544037
  USDC: 0.010884
```

Insufficient for a borrow + repay cycle (would need at least 1 USDC of
collateral + a few cents of ETH for two txs). The wallet is the contract
owner — using it for arbitrary writes is also a key-rotation risk to avoid.

Static-call simulation against Base confirmed the contract would reject
`requestLoan` with `"ERC20: transfer amount exceeds allowance"` rather than
any structural issue, so the write path is reachable; just not exercised.

### Recommendation

- Top up a non-owner Base test wallet with ~5 USDC + 0.001 ETH to enable
  cross-network parity testing in CI
- Schedule a daily lightweight cycle on each network as a smoke test

---

## §N13 (LOW) — Pool accounting names mislead, but math is sound

During the §N12 cycle the pool 43 view returned a state that looks
self-contradictory:

```
getAgentPool(43):
  totalLiquidity     = 1900.000000 USDC
  availableLiquidity = 1933.346189 USDC   ← > totalLiquidity!
  totalLoaned        = 0.000000 USDC
  totalEarned        = 33.346189 USDC
  utilizationRate    = 0%
  lenderCount        = 2
```

`availableLiquidity > totalLiquidity` superficially reads as a broken
invariant (a pool can't have more available than supplied). A targeted
probe of the storage struct, lender positions, and lifecycle events
explains the math fully — **this is not a bug**, but the field naming
is misleading and there is a small (600-wei) rounding loss in per-lender
share accounting that is worth tracking.

### What `totalLiquidity` actually means

The contract uses `totalLiquidity` to mean **principal supplied by lenders**,
not "total assets in the pool". Confirmed by direct sum-of-positions:

```
positions(43, 0x6560…BCFcE2).amount = 1400.000000 USDC  (depositTime 2026-02-20T17:14:05Z)
positions(43, 0xd673…9F8A).amount   =  500.000000 USDC  (depositTime 2026-02-20T18:42:58Z)
sum                                  = 1900.000000 USDC
                                     == pool.totalLiquidity ✅
```

`availableLiquidity` is the loanable balance, which equals
`totalLiquidity − totalLoaned + totalEarned − claimedSoFar`. Working
backwards from the observed values:

```
1933.346189 = 1900 − 0 + 33.346189 − claimedSoFar
        ⇒ claimedSoFar = 0
```

i.e. **no lender has ever called `claimInterest()` on pool 43**. The
33.346189 USDC of accrued interest sits in the available bucket as
auto-reinvested principal, but is *not* added to `totalLiquidity` because
that field tracks deposit principal only. The same accounting principle
appears on every other pool we sampled.

### Direct event evidence (one-shot proof)

The §N12 cycle this session is the cleanest natural experiment.
Event scan of blocks 40,156,339 → 40,186,339 (last 30k blocks):

```
LoanRequested(loanId=2094, agentId=43, borrower=0x6560…, amount=1.000000) @ block 40173079
InterestDistributed(agentId=43, totalInterest=949 wei = 0.000949 USDC)    @ block 40173089
```

Pre-cycle pool state (reconstructed):

```
totalLiquidity     = 1900.000000
availableLiquidity = 1933.345240
totalEarned        =   33.345240
```

Post-cycle pool state (observed live):

```
totalLiquidity     = 1900.000000   ← unchanged
availableLiquidity = 1933.346189   ← +0.000949
totalEarned        =   33.346189   ← +0.000949
```

The exact same 949 wei landed in both `availableLiquidity` and
`totalEarned`, with no movement on `totalLiquidity`. This proves the
accounting model is:

```
LiquiditySupplied(amt)      → totalLiquidity += amt;     availableLiquidity += amt
LoanDisbursed(amt)          → availableLiquidity −= amt; totalLoaned        += amt
LoanRepaid(principal)       → availableLiquidity += principal; totalLoaned −= principal
InterestDistributed(int)    → availableLiquidity += int;       totalEarned += int
claimInterest(amt)          → availableLiquidity −= amt;       (no change to totals)
withdrawLiquidity(amt)      → availableLiquidity −= amt;       totalLiquidity −= amt
PoolAccountingReset(…)      → emergency reset of both fields (none observed for pool 43)
```

### The actual defect: per-lender basis-point rounding

`getLenderPosition.share` returns shares in basis points:

```
0x6560…BCFcE2 → share = 7368   (1400 / 1900 = 73.68421%)
0xd673…9F8A   → share = 2631   ( 500 / 1900 = 26.31579%)
sum            = 9999            ← short by 1 bp
```

The 1-bp shortfall causes a small drift between the per-lender
`positions.earnedInterest` sum and the pool's `totalEarned`:

```
sum(positions[L].earnedInterest) = 33.345589 USDC
pool.totalEarned                 = 33.346189 USDC
delta                            =  0.000600 USDC = 600 wei lost in rounding
```

That 600 wei is **stuck in the pool**: `availableLiquidity` includes it
but no lender can claim it via `claimInterest` because it never made it
into any `positions[L].earnedInterest` slot. Over the lifetime of pool
43 (~70 days, dozens-to-hundreds of repayments), this has accumulated
to ~600 wei. Worst case at the H-04 cap (50 lenders, integer division
losing up to 49 wei per repayment) the drift would still be sub-cent
over normal pool lifetimes.

It would only become a real problem if (a) a malicious actor deliberately
crafts a swarm of micro-repayments to amplify rounding, or (b) the field
is later relied on for solvency math at exact equality.

### Solvency check (cross-pool)

Total marketplace USDC balance: **38,113.94 USDC** (serves all 40 pools).
Pool 43 alone claims `availableLiquidity = 1933.35 USDC`, which is well
within the global balance. No solvency issue at this pool.

### Whole-protocol sweep result

Re-ran the same probe across **all 40 Arc pools + the 1 Base pool**
(this session, Arc block 40,340,487, Base block 45,517,755). Hard
totals:

```
                          Arc                Base
Σ totalLiquidity     :   38,236.00 USDC     285.00 USDC
Σ availableLiquidity :   37,982.92 USDC     285.00 USDC
Σ totalLoaned        :      355.00 USDC       0.00 USDC
Σ totalEarned        :      101.92 USDC       0.00 USDC
Σ positions.amount   :   38,236.00 USDC     285.00 USDC   ← matches totalLiq exactly
Σ rounding dust      :      600 wei            0 wei      ← only pool 43
MP USDC balance      :   38,113.94 USDC     285.00 USDC
Solvency slack       :     +131.03 USDC      0.00 USDC    ← Arc has active loan collateral
Drift pools          :        0 / 40         0 / 1        ← every invariant holds
```

Conclusions:

- **Pool 43 is the only pool in the protocol with rounding loss.** It's
  also the only pool that has both >1 lender AND has completed repayment
  cycles. Every other Arc pool has either 1 lender (no division) or
  0 completed loans. The 600-wei dust scales with `(loans × lenders)`,
  not pool count.
- **Both networks solvent.** Arc has ~131 USDC of slack which matches
  active loan collateral + accumulated fees (1.03 USDC). Base is exactly
  balanced.
- **`Σ positions.amount = Σ totalLiquidity` exactly across every pool
  on both networks** — the principal-tracking invariant is bulletproof.
  No silent drift anywhere.

### Impact

- **No funds at risk.** Pool 43 is solvent and the math is consistent.
- **Field-naming hazard.** Any caller (frontend, indexer, integrator) that
  reads `totalLiquidity` expecting "total assets" gets a number that's
  ~1.8% low. The Specular API responses in particular should be checked
  for this aliasing — `/pools` returns all six fields raw.
- **Rounding sink.** 600 wei stuck in the available bucket per pool, per
  ~70 days of operation. Cosmetic, but it means
  `Σ positions.earnedInterest ≠ totalEarned` is normal, not a bug to
  chase later.
- **No `PoolAccountingReset` events for pool 43**, so the rolled-back
  v3 upgrade reason ("Added resetPoolAccounting emergency function" per
  `arc-testnet-addresses.json`) was never used for this pool. The reset
  function exists but stayed unused for the high-traffic agent.

### Recommendation

- **Document the accounting model** in the contract NatSpec and in the
  `/pools` API response schema. Add `totalAssets` (= `totalLiquidity +
  totalEarned − claimedSoFar`) as a derived field to remove the
  "available > total" surprise.
- Surface a `protocolDust` getter (or include it in `accumulatedFees`
  withdrawal flow) so the per-pool rounding leak can be swept by the
  owner periodically.
- When the `claimInterest` flow is exercised in tests, verify that the
  rounding-induced delta is actually unrecoverable through normal user
  paths and that no off-by-one revert can be triggered.

---

## §2 Method

### State probe

Direct `eth_call` against:

- Marketplace (Arc `0x048363A3…`, Base `0xd7b4dEE7…`): every public
  view/pure function listed in
  `artifacts/contracts/core/AgentLiquidityMarketplace.sol/.../*.json`
- Registry (Arc `0x741C03c0…`, Base `0xb9996de0…`): same
- Reputation (Arc `0x94F2fa47…`, Base `0xf19b1780…`): same, plus raw
  selector probe to detect missing-getter REVERTs (§N3)
- USDC balances + token metadata
- Bytecode (`provider.getCode()`) for cross-network parity check

### API endpoint matrix

31 routes across `https://specular-production.up.railway.app`:

- 7 read-path routes (× 3 network variants where applicable)
- 3 `/tx/*` POSTs
- 5 `/virtuals/*` routes
- 1 `/credit/:address` (GET + POST)
- `/health`, `/.well-known/specular.json`, `/stats`, `/`

Each call recorded: status code, latency, response shape (object keys or
text snippet).

### Live cycle

Single-shot `requestLoan(1e6, 7)` then `repayLoan(loanId)` from the Arc
test wallet (`0x656086A2…`, agent 43). Logged: gas used, block numbers,
state transitions, USDC delta. Wallet was approved for 194 USDC prior to
this session, so no extra `approve` was needed.

---

## §3 Recommended actions in priority order

1. **Decide Arc Testnet's status.** Either authorize v5_WITH_FIX from the
   secure wallet (resolves §N1, §N3) and migrate, OR deprecate Arc and
   move the API/manifest to point at Base only.
2. **Replace drpc free-tier RPC for Arc.** Single biggest live-impact fix
   (§N2, §N6). One paid endpoint flips the API from 500s to 200s.
3. **Publish a multi-network manifest** (§N5). Pre-req for any
   external integration that wants to talk to both networks.
4. **Fund a Base test wallet for daily smoke cycles** (§N12). Cheapest
   guard against live-fire regression on the underused Base deployment.
5. **Fix `/stats` cache health metrics** (§N6) — surface
   `syncFailures/syncs` ratio prominently; tag stale caches in `200`
   responses with a `Warning: 110` header.
6. **Trim `arc-testnet-addresses.json`** (§N7) — move history to a
   separate file.
7. **Re-baseline "production" claims** to reflect §N4 — Base is deployed,
   not in use.
8. **Document the pool accounting model** (§N13) — add a `totalAssets`
   derived field to the `/pools` response and rename or NatSpec
   `totalLiquidity` so integrators don't trip on `available > total`.

---

## §4 Cross-references

- [`API_AUDIT.md`](./API_AUDIT.md) — server-side audit; §0 finding
  reconfirmed live across both networks here (§N11)
- [`SCHEMA_VERIFICATION.md`](./SCHEMA_VERIFICATION.md) — on-chain shape
  reference; §N3 here adds a per-network drift dimension
- [`FRONTEND_AUDIT.md`](./FRONTEND_AUDIT.md) — UI-side; §F1 (`identity.js`
  hardcoded localhost) is the same root cause as §N11's `/credit/:address`
- [`DOC_FABRICATION_AUDIT.md`](./DOC_FABRICATION_AUDIT.md) — §4 "Production-
  ready" claims; §N4 here is the empirical contradiction
- [`VIRTUALS_SDK_AUDIT.md`](./VIRTUALS_SDK_AUDIT.md) — second SDK targeting
  `/virtuals/*`; §N11 confirms all 5 routes 404 on both networks
- [`OPTION2_FEASIBILITY.md`](./OPTION2_FEASIBILITY.md) — recommended SDK
  fix; would also resolve the §N9 default-network ambiguity by removing
  the network query parameter from the SDK→server hop entirely
