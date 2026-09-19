# API Server Audit

Read-only analysis of every API server source file in this repo, cross-checked
against [`SCHEMA.md`](./SCHEMA.md) and [`DRIFT_AUDIT.md`](./DRIFT_AUDIT.md).

Companion to those two docs. Where `DRIFT_AUDIT.md` catalogues SDK-consumer
violations of the on-chain contract shapes, this file catalogues the same
class of bugs **inside the API servers themselves** — plus the larger
structural finding below.

## Headline

**Neither API server in this repo exposes `/tx/register`, `/tx/request-loan`,
or `/tx/repay-loan`.** `SpecularSDK` (`src/sdk/SpecularSDK.js`) constructs all
of its transactions by `POST`ing to those three routes and then broadcasting
the returned calldata. Those routes do not exist in:

- `src/api/SpecularAgentAPI.js` (171 LOC, legacy single-network)
- `src/api/MultiNetworkAPI.js` (914 LOC, default `npm start` target)
- `backend/routes/virtuals.js` (466 LOC, x402-paid Virtuals integration)

Practical consequences:

- The SDK end-to-end probe earlier in this session only worked because a
  *mock* server was hand-rolled in the probe script. Against the actual
  servers shipped in this repo, every `requestLoan` / `repayLoan` /
  `register` call would fail with `404 Not Found`.
- Any external consumer who reads the SDK README and runs `npm start` will
  hit a dead route. There is no in-repo reference implementation of the
  transaction surface the SDK contracts with.
- Either the SDK is incompletely wired (consumer must BYO server) or the
  real server lives in a sibling repository.

This is not necessarily a bug — many SDK kits expect the consumer to host
their own backend — but it is **completely undocumented**, and the SDK README
implies the opposite by hard-coding `apiUrl: 'http://localhost:3001'` as the
default.

## Audit summary

| §  | Severity | File                              | Site             | Class                                   |
|----|----------|-----------------------------------|------------------|-----------------------------------------|
| 0  | CRITICAL | (all three)                       | —                | No `/tx/*` endpoints                    |
| 1  | HIGH     | `MultiNetworkAPI.js`              | L807-808         | Non-existent struct fields              |
| 2  | HIGH     | `backend/routes/virtuals.js`      | L33-36           | Wrong `requestLoan` ABI (3-arg vs 2)    |
| 3  | HIGH     | `backend/routes/virtuals.js`      | L33-34           | Wrong `getPool` tuple shape             |
| 4  | MED      | `MultiNetworkAPI.js`              | L788-815         | O(N) walk of `nextLoanId()`             |
| 5  | MED      | `SpecularAgentAPI.js`             | L102, L108       | Wrong mapping name (`pools` vs `agentPools`) |
| 6  | MED      | `backend/routes/virtuals.js`      | L329             | `Number()` precision loss on base units |
| 7  | LOW      | `backend/routes/virtuals.js`      | L380             | Ambiguous duration unit                 |
| 8  | LOW      | `backend/routes/virtuals.js`      | L28-29           | Reputation tuple shape unverified       |

---

## §0 No `/tx/*` endpoints — CRITICAL

`SpecularSDK.js` POSTs to:

| SDK call                | Expected route        |
|-------------------------|-----------------------|
| `register()`            | `POST /tx/register`   |
| `requestLoan()`         | `POST /tx/request-loan` |
| `repayLoan(loanId)`     | `POST /tx/repay-loan` |

Grep across all three server files turns up zero matches for `'/tx/'`. Every
endpoint in this repo's API surface is a **read** (status, agents, loans,
pools, stats, dashboard).

**Fix path**: either delete the SDK's network round-trip and have it build
calldata locally (it has access to the ABI artifacts already), or ship a
reference `/tx/*` handler in `MultiNetworkAPI.js`. The local-only path is
preferable: there's no reason to do an HTTP round-trip to encode a function
call when the caller already has a wallet and an ABI.

---

## §1 `loan.repaid` / `loan.defaulted` non-existent fields — HIGH

**File**: `src/api/MultiNetworkAPI.js` lines 807-808

```js
repaid: loan.repaid,
defaulted: loan.defaulted,
```

Per [`SCHEMA.md`](./SCHEMA.md) the on-chain `Loan` struct has exactly 10
fields ending with `state` (a `LoanState` enum). There is no `repaid` boolean
and no `defaulted` boolean. Both reads return `undefined` in **every** JSON
response from `/agent/:id/loans`.

**Intended logic**:

```js
repaid: Number(loan.state) === 2,    // LoanState.REPAID
defaulted: Number(loan.state) === 3, // LoanState.DEFAULTED
```

This is the same drift class as §1 of `DRIFT_AUDIT.md` — the difference is
that the SDK consumers got the *enum index* wrong while the API server
forgot the field name exists at all.

---

## §2 Wrong `requestLoan` ABI (3-arg vs 2) — HIGH

**File**: `backend/routes/virtuals.js` line 35

```js
'function requestLoan(uint256 poolId, uint256 amount, uint256 duration) external'
```

The deployed `AgentLiquidityMarketplace.sol` on every network takes
**two** arguments: `requestLoan(uint256 amount, uint256 durationDays)`. There
is no `poolId` parameter — the contract derives the pool from the borrower's
agent profile.

The `/virtuals/confirm` handler at lines 376-381 uses this ABI to encode
calldata that it then returns to the agent for broadcast. Any agent that
follows the contract returned by this endpoint will revert on submission.

Cross-references DRIFT_AUDIT.md §5 — this is the same class of bug as the
hardhat scripts that pass seconds instead of days, just expressed at the ABI
level instead of the call-site level.

---

## §3 Wrong `getPool` tuple shape — HIGH

**File**: `backend/routes/virtuals.js` line 34

```js
'function getPool(uint256) external view returns (tuple(address agent, uint256 totalSupplied, uint256 totalBorrowed, uint256 availableLiquidity, uint256 interestRate, bool isActive))'
```

This declares a **6-field** tuple. Per [`SCHEMA.md`](./SCHEMA.md) the real
`AgentPool` struct has **7 fields** with different names:

```
agentId         uint256
agentAddress    address
totalLiquidity  uint256
availableLiquidity uint256
totalLoaned     uint256
totalEarned     uint256
isActive        bool
```

The decoded fields will silently misalign (the route claims field 0 is an
address; real field 0 is a uint256 agentId; address lives at field 1). All
downstream JSON from `/virtuals/pools` and `/virtuals/credit-check` is wrong.

---

## §4 O(N) walk of `nextLoanId()` — MED

**File**: `src/api/MultiNetworkAPI.js` lines 788-815

```js
const nextId = await marketplace.nextLoanId();
for (let i = 1n; i <= nextId; i++) {
    const loan = await marketplace.loans(i);
    if (loan.borrower.toLowerCase() === address.toLowerCase()) {
        loans.push(...);
    }
}
```

Every call to `/agent/:id/loans` reads every loan that has ever existed on
the network. Arc Testnet alone is at 752+ loans (as of this session); Base
will outgrow that. The endpoint is wrapped in `BlockchainCache` so the
amortised cost is fine, but the cold-cache path is already 5+ seconds and
gets monotonically worse.

**Fix path**: index `LoanRequested` events server-side into a per-borrower
list, or read `marketplace.getAgentLoans(address)` if that view exists on
the deployed contract (per SCHEMA.md it's `getAgentLoans(address)` returning
`uint256[]`, which would be O(1) at the contract).

---

## §5 Wrong mapping name `pools` vs `agentPools` — MED

**File**: `src/api/SpecularAgentAPI.js` lines 102, 108

```js
const totalPools = await marketplace.totalPools();
// ...
const pool = await marketplace.pools(i);
```

Per SCHEMA.md the marketplace exposes:
- `agentPoolIds(uint256) returns (uint256)` — index → poolId
- `agentPools(uint256) returns (AgentPool)` — agentId → pool

There is no `pools()` mapping and no `totalPools()` view documented. The
`/status` route on this server will throw on the first contract call. This
file is the *legacy* server (not the default `npm start` target), so the
blast radius is small, but it's still dead code that pretends to work.

---

## §6 `Number()` precision loss on USDC base units — MED

**File**: `backend/routes/virtuals.js` line 329

```js
const repayAmount = Number(amount) + (Number(amount) * interestRate / 10000 * duration / 365);
```

`amount` here is a USDC base-unit value (parts of millionths, `uint256`).
`Number(amount)` silently loses precision once the value exceeds
`Number.MAX_SAFE_INTEGER` (2^53 - 1) — i.e. amounts above ~9 trillion base
units (~9 million USDC). The protocol's effective ceiling is far below that
today, so this is latent rather than active, but the formula also does
floating-point intermediate math which is unsafe for monetary calculations
of any size.

The contract computes interest itself — there is no need for the API to
recompute it. If a preview is wanted, mirror the on-chain formula in BigInt:

```js
const interest = (amount * BigInt(interestRate) * BigInt(durationDays)) / (10000n * 365n);
const repayAmount = amount + interest;
```

This is the same class as DRIFT_AUDIT.md §4 (interest formula bugs).

---

## §7 Ambiguous duration unit — LOW

**File**: `backend/routes/virtuals.js` line 380

```js
const duration = req.body.duration || 7;
```

`duration` flows through the file as both an x402-payment quote input AND as
a calldata field for the (broken) `requestLoan` ABI. The variable name
doesn't disclose whether the unit is days or seconds, and both interpretations
appear in different lines. Since the real contract takes `durationDays`, this
should be renamed `durationDays` and validated with the same guard as
`assertDurationDays` from `src/sdk/duration.js`.

---

## §8 `getAgentReputation` tuple shape unverified — LOW

**File**: `backend/routes/virtuals.js` lines 28-29

```js
'function getAgentReputation(address) external view returns (tuple(uint256 score, uint256 totalLoans, uint256 repaidLoans, uint256 defaultedLoans, uint256 lastUpdated))'
```

This declares 5 fields. The real `ReputationManagerV3` interface is not
documented in `SCHEMA.md` (which focuses on the marketplace) — but given the
pattern of the other ABI declarations in this file, it's likely wrong. Needs
a direct read of `ReputationManagerV3.sol` to confirm. Marked LOW because
it's used only in the `/virtuals/credit-check` quote, not in calldata.

---

## Cross-reference matrix

| Drift class                       | DRIFT_AUDIT.md §  | API_AUDIT.md §  |
|-----------------------------------|-------------------|-----------------|
| LoanState enum mishandling        | §1                | §1              |
| Loan struct field-name guesses    | §2                | §1              |
| Wrong positional indices          | §3                | §3              |
| Interest formula bugs             | §4                | §6              |
| Duration in seconds, not days     | §5                | §2, §7          |
| Wrong contract ABI shapes         | (n/a in DRIFT)    | §3, §8          |
| Read-amplification anti-pattern   | (n/a in DRIFT)    | §4              |
| Wrong contract method name        | (n/a in DRIFT)    | §5              |

The SDK consumers (DRIFT_AUDIT.md) and the API servers (this file) make the
same kinds of mistakes for the same reasons: there's no single source of
truth that says "here is the on-chain shape; here is how to decode it". The
SDK has the ABI artifacts in `artifacts/`, but neither the API servers nor
the consumer scripts use them — they each redefine the shapes inline and
each one drifts independently.

## Recommended cleanup order

1. **§1 (MultiNetworkAPI.js loan.repaid)** — one-line fix; affects every
   `/agent/:id/loans` response right now.
2. **§2 + §3 (virtuals.js wrong ABIs)** — replace the inline ABI strings
   with imports from `artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json`.
   This kills both bugs at once.
3. **§5 (SpecularAgentAPI.js wrong mapping)** — or just delete the legacy
   server if it's truly unused.
4. **§0 (no /tx/* endpoints)** — architectural decision: either move
   transaction encoding into the SDK (use the existing ABI artifacts, no
   server round-trip) or implement the routes in MultiNetworkAPI.js.
5. **§6 (Number precision)** — BigInt-ify the repay-quote math.
6. **§4 (O(N) walk)** — index events into a per-borrower table.
7. **§7, §8** — naming and verification cleanup.

## What this audit deliberately does NOT do

- **Test the endpoints live.** All findings are static analysis of source
  files. A smoke test against a running `MultiNetworkAPI.js` would confirm
  the §1 bug (every response has `repaid: undefined`) but I have not done
  that here.
- **Inspect frontend / SDK consumer code paths that hit these endpoints.**
  Some of them may already work around the bugs (e.g. ignoring `repaid` and
  computing it from `state` themselves).
- **Improve or rewrite any server code.** Per the read-only analysis remit
  for this session, only documentation outputs are produced.

## Related documents

- [`SCHEMA.md`](./SCHEMA.md) — canonical on-chain shapes.
- [`DRIFT_AUDIT.md`](./DRIFT_AUDIT.md) — SDK-consumer drift sites.
- [`RECEIPT.md`](./RECEIPT.md) — `waitForReceiptResilient` documentation.

---

## Live verification addendum

Added after running `npm start` (= `node src/api/MultiNetworkAPI.js`) and
exercising the suspect endpoints against Arc Testnet on 2026-04-30. Server
boot was clean (`http://localhost:3001`, `chainId 5042002`, block 39875345).

### §0 → confirmed CRITICAL (live)

```
HTTP 404 POST /tx/register
HTTP 404 POST /tx/request-loan
HTTP 404 POST /tx/repay-loan
```

The SDK's three transaction routes return 404 from the running default
server. SpecularSDK consumers using `apiUrl: 'http://localhost:3001'` (the
documented default) will fail every register / borrow / repay attempt with
`fetch failed: 404 Not Found`. The session-17 SDK probe only worked because
that probe script hand-rolled a mock server.

### §1 → confirmed HIGH (live)

`GET /agent/43/loans?network=arc&limit=3` returned 753 loans for the
heavily-tested borrower. Each loan entry has exactly these keys:

```json
{
  "loanId": 2093,
  "borrower": "0x656086A21073272533c8A3f56A94c1f3D8BCFcE2",
  "amount": 5,
  "interestRate": 5,
  "duration": 604800,
  "startTime": 1777584942,
  "endTime": 1778189742,
  "role": "borrower"
}
```

- `repaid` — **absent** (read as `undefined`, dropped by `JSON.stringify`)
- `defaulted` — **absent** (same)
- `state` — **absent** (not selected into the response object at all)

**Net effect**: API consumers cannot distinguish ACTIVE / REPAID / DEFAULTED
loans from this endpoint. Every loan in the JSON looks identical regardless
of state. The DRIFT_AUDIT.md §1 (state-enum inversion) bugs in SDK consumers
are partially explained: those consumers were probably reading `loan.state`
directly from the contract because the API doesn't expose it.

### §4 → confirmed MED (live)

The first cold-cache call to `/agent/43/loans` took **~60+ seconds** to
return — long enough that the Bash tool timed out the foreground HTTP and
I had to wait via TaskOutput. The server walks all loans 1..nextLoanId()
to filter; current `nextLoanId` is ≥ 2094 on Arc. With cache, subsequent
hits are fast, but cold-start traffic spikes will hammer the RPC.

### §2, §3, §6, §7, §8 → DOWNGRADE (orphaned router)

`grep -rn virtuals` across `src/`, `backend/`, repo root, etc. finds **zero
mounts** of `backend/routes/virtuals.js`. No `app.use('/virtuals', ...)`,
no import statement, nothing pulls the file into any Express app. Live
probes against `MultiNetworkAPI.js` confirm:

```
HTTP 404 GET /virtuals/pools
HTTP 404 GET /virtuals/credit-check
HTTP 404 GET /virtuals/agent/:address
```

The 466-LOC file is **orphaned dead code**. The bugs in §2 / §3 / §6 / §7 /
§8 are real on paper but unreachable in practice. They become live bugs
the moment someone mounts the router — but right now they cannot harm
anyone.

**Updated severity for virtuals.js findings**: HIGH → LATENT-HIGH. The
findings should still block any future PR that mounts this router; they
do not block anything else.

### §5 → not reproduced (legacy server not run)

Did not boot `src/api/SpecularAgentAPI.js` because `npm start` points at
`MultiNetworkAPI.js` and there is no `npm run` shortcut for the legacy
server. Static analysis of the `pools()` / `agentPools()` mismatch stands.

### Updated scoreboard

| §  | Static severity | Live status         |
|----|-----------------|---------------------|
| 0  | CRITICAL        | **CONFIRMED LIVE**  |
| 1  | HIGH            | **CONFIRMED LIVE**  |
| 2  | HIGH            | latent (orphan)     |
| 3  | HIGH            | latent (orphan)     |
| 4  | MED             | **CONFIRMED LIVE**  |
| 5  | MED             | not exercised       |
| 6  | MED             | latent (orphan)     |
| 7  | LOW             | latent (orphan)     |
| 8  | LOW             | latent (orphan)     |

**Net upgrade**: §0 jumps from "static finding" to "live confirmed CRITICAL"
— this is the actionable headline. The SDK ships with a hard-coded default
`apiUrl` that 404s on every transaction call. Either the default must be
removed (force consumers to specify) or the routes must be implemented.

**Net downgrade**: every virtuals.js finding becomes latent. The router is
dead code. A reasonable cleanup is to either delete the file or mount it
with the ABI imports fixed; either action is out of scope for this audit.

---

## SDK consumer URL trace

Follow-up to §0. Every `new SpecularSDK(...)` callsite in the repo, plus
how each one resolves `apiUrl`. SpecularSDK default is hard-coded at
`src/sdk/SpecularSDK.js:17`:

```js
this.apiUrl = apiUrl || 'http://localhost:3001';
```

### Callsite table

| Callsite                                         | apiUrl source                        | Resolved URL value                                         |
|--------------------------------------------------|--------------------------------------|------------------------------------------------------------|
| `test-integration.js:63`                         | `process.env.API_URL \|\| 'http://localhost:3001'` | env or localhost                                |
| `test-eliza-integration.js:109`                  | hardcoded                            | `https://specular-production.up.railway.app`               |
| `test-security-fixes.js:48`                      | hardcoded                            | `http://localhost:3001`                                    |
| `templates/arbitrage-agent/arbitrage-agent.js:25`| ctor arg `specularApiUrl`            | caller-provided                                            |
| `templates/api-caller-agent/api-caller-agent.js:25` | ctor arg `specularApiUrl`         | caller-provided                                            |
| `templates/trading-agent/trading-agent.js:25`    | ctor arg `specularApiUrl`            | caller-provided                                            |
| `src/agents/AutonomousAgent.js:59`               | `opts.apiUrl`                        | caller-provided (typically `http://localhost:${PORT}`)     |
| `src/agents/LenderAgent.js:36`                   | `opts.apiUrl`                        | caller-provided                                            |
| `src/agents/run-agent.js:39`                     | `\`http://localhost:${PORT}\``       | localhost (passed into AutonomousAgent)                    |
| `src/agents/run-agents.js:42`                    | `\`http://localhost:${PORT}\``       | localhost                                                  |
| `src/moltbook/post-api-announcement.js:21`       | hardcoded                            | `http://api.specular.network`                              |
| `src/moltbook/post-first-borrower-offer.js:37`   | hardcoded                            | `http://api.specular.network`                              |
| `src/integrations/natural-language/NaturalLanguageInterface.js:19` | ctor arg `specularApiUrl` | caller-provided                                  |
| `src/integrations/eliza/src/index.ts:159`        | from `config`                        | caller-provided                                            |
| `src/sdk/examples/quickstart.js:15`              | hardcoded                            | `http://localhost:3001`                                    |
| `sdk/virtuals/SpecularSDK.js:11`                 | hardcoded (different SDK!)           | `https://specular-production.up.railway.app/virtuals`      |

### Reachability matrix

Live probes performed on 2026-04-30:

| URL                                                   | `/health` | `POST /tx/register` | `POST /tx/request-loan` | `POST /tx/repay-loan` | `GET /virtuals/pools` |
|-------------------------------------------------------|-----------|---------------------|--------------------------|------------------------|------------------------|
| `http://localhost:3001` (running MultiNetworkAPI.js)  | 200       | 404                 | 404                      | 404                    | 404                    |
| `https://specular-production.up.railway.app`          | 200       | 404                 | 404                      | 404                    | 404                    |
| `http://api.specular.network`                         | DNS fail  | DNS fail            | DNS fail                 | DNS fail               | DNS fail               |

All three of the SDK's transaction routes return **404 in production as
well as locally**. The Railway-hosted server is running essentially the
same `MultiNetworkAPI.js` audited above — read endpoints work, transaction
endpoints don't exist. `api.specular.network` does not resolve.

### Per-callsite verdict

| Callsite                                          | Status when called as written |
|---------------------------------------------------|-------------------------------|
| `post-api-announcement.js`                        | **DEAD** — DNS doesn't resolve |
| `post-first-borrower-offer.js`                    | **DEAD** — DNS doesn't resolve |
| `quickstart.js`                                   | **DEAD on register/borrow/repay** — localhost defaults to 404 |
| `test-security-fixes.js`                          | **DEAD on register/borrow/repay** — same |
| `test-integration.js`                             | **DEAD on register/borrow/repay** — same |
| `test-eliza-integration.js`                       | **DEAD on register/borrow/repay** — prod also 404s |
| `sdk/virtuals/SpecularSDK.js`                     | **DEAD** — `/virtuals/*` 404 in prod |
| `templates/*` (3 files)                           | **conditionally dead** — depends on caller-supplied URL; no working URL exists in this repo |
| `AutonomousAgent.js`, `LenderAgent.js`            | **conditionally dead** — same; `run-agent.js` passes `http://localhost:${PORT}` which means the consumer must boot a server with `/tx/*` routes themselves |
| `NaturalLanguageInterface.js`, `eliza/index.ts`   | **conditionally dead** — same |

### Implication for §0

The §0 finding is no longer just "default URL 404s locally." It is:

> **No URL configured anywhere in this repository can satisfy
> `SpecularSDK.requestLoan / repayLoan / register`. Every callsite is
> either pointing at a 404, a non-resolving hostname, or a caller-supplied
> URL with no working server implementation in the repo.**

This is a structural gap, not a configuration mistake. A future fix has
exactly two options:

1. **Implement `/tx/*` routes in `MultiNetworkAPI.js`** so the existing
   defaults start working. The contract ABIs are available in
   `artifacts/contracts/core/AgentLiquidityMarketplace.sol/`. Each handler
   would just `populateTransaction.<method>(...)` and return the calldata
   blob. ~30-50 LOC per route.
2. **Move calldata encoding into `SpecularSDK.js`** and delete the network
   round-trip. The SDK already imports ethers and has the wallet; there is
   no actual reason to ask a server how to encode a function call. This
   collapses three unreachable routes and eliminates the dependency.

Option 2 is architecturally cleaner. Option 1 preserves the existing
contract surface for any non-JS consumer (Python, Go, etc.) that would
want server-side encoding.

### Note on `sdk/virtuals/SpecularSDK.js`

This is a **second, separate SDK file** distinct from the one in
`src/sdk/SpecularSDK.js`. It hardcodes
`https://specular-production.up.railway.app/virtuals` and routes everything
through the orphaned `backend/routes/virtuals.js`. Since prod returns 404
for `/virtuals/*` (matching the orphan-router finding above), this entire
SDK variant is dead at every call. It should either be deleted or wired up
with the broken ABIs fixed first.

---

## Git history of `/tx/*` routes

Follow-up on §0. The question: did `/tx/register` / `/tx/request-loan` /
`/tx/repay-loan` ever exist as Express handlers in this repo's history,
or were they always a paper interface?

### Method

```sh
git -C /Users/peterschroeder/Specular log --all -S "/tx/register"   --oneline
git -C /Users/peterschroeder/Specular log --all -S "/tx/request-loan" --oneline
git -C /Users/peterschroeder/Specular log --all -S "/tx/repay-loan"  --oneline
git -C /Users/peterschroeder/Specular log --all -S "app.post('/tx"   --oneline
git -C /Users/peterschroeder/Specular log --all -S "router.post('/tx" --oneline
```

### Result

```text
/tx/register      → 8f18ad0   (initial commit, Feb 21 2026)  — only ever introduced; never modified, never deleted
/tx/request-loan  → 8f18ad0   (same)
/tx/repay-loan    → 8f18ad0   (same)
app.post('/tx     → (no matches, ever)
router.post('/tx  → (no matches, ever)
```

`grep -l "/tx/register" HEAD` over all tracked files in HEAD finds the
strings only in:

- `src/sdk/SpecularSDK.js`           (the SDK that calls them)
- `src/agents/build-reputation.js`   (an agent that calls them)
- `examples/agent-lifecycle-via-api.js`
- `src/test-suite/test-api-endpoints.js`
- `src/test-suite/novel-tests.js`
- `AGENT_API_GUIDE.md`, `AGENT_API_README.md`, `API_TEST_RESULTS.md`,
  `ARC_COMPREHENSIVE_TEST_REPORT.md`, `QUICKSTART.md`, `REPUTATION_JOURNEY.md`
  (six docs that describe them as if they exist)

**No file in any commit on any branch has ever contained an Express handler
for `/tx/*`.** The strings are introduced in the very first commit
(`8f18ad0 "Initial commit: Specular Protocol - Production ready on Base
mainnet"`) on the *consumer* side only — SDK call sites, test scripts, and
documentation. The server side has never existed.

### Smoking gun: fabricated test results

`API_TEST_RESULTS.md` (committed at HEAD) claims:

```
#### Transaction Builder Endpoints (4/4 ✅)
- ✅ `POST /tx/register` - Build agent registration transaction
- ✅ `POST /tx/request-loan` - Build loan request transaction
- ✅ `POST /tx/repay-loan` - Build loan repayment transaction
- ✅ `POST /tx/supply-liquidity` - Build liquidity supply transaction
```

These results cannot have been real. The handlers do not exist in the
git history of this repo. `POST /tx/supply-liquidity` (the fourth route
in the table) returns 404 against the running production server, same as
the other three:

```
POST https://specular-production.up.railway.app/tx/supply-liquidity → 404
```

The doc also shows code samples calling
`http://api.specular.finance/arc/...`. That hostname does not resolve
either:

```
$ dig +short api.specular.finance
(no records)
$ curl http://api.specular.finance/ → exit code 6 (could not resolve)
```

So in addition to `api.specular.network` (referenced by the moltbook
scripts), there's a *third* broken hostname `api.specular.finance` baked
into the documentation. None of them resolve.

### Updated §0 finding

The §0 gap is not a recent regression and not a forgotten feature. It is
the **original state of the repository**. The SDK was committed as a
pure-client interface to a server that has never been written. Every
piece of "documentation" describing these routes as working — including
the explicit `4/4 ✅` claim in `API_TEST_RESULTS.md` — was written before
the routes existed and remained in the repo unchanged through 58 commits
of subsequent work.

### Implications

- **For users**: anyone reading `QUICKSTART.md` or `API_TEST_RESULTS.md`
  and trying to follow the documented flow will hit 404 on the very first
  transaction call. The claimed working state has never been true.
- **For maintainers**: the documentation is misleading and predates any
  implementation. It should either be deleted or downgraded to a
  forward-looking spec until handlers exist.
- **For the audit**: §0 is upgraded from "structural gap" to "the
  documented happy path of the SDK is fictional in this repo."

### What this trace deliberately does NOT do

- Look at sibling repositories or deployment configs that might host the
  routes elsewhere. The Railway production server does not have them
  (confirmed live above), so any external implementation, if it exists,
  is invisible to this audit.
- Recommend specific code changes. The fix paths in the previous
  addendum (implement server-side or move to client-side calldata) still
  apply unchanged.
