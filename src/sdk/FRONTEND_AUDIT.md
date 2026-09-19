# Frontend SDK Consumer Audit

Audit of `/Users/peterschroeder/Specular/frontend/` for code paths that
either consume the broken SDK surface (see [`API_AUDIT.md`](./API_AUDIT.md))
or drift from the on-chain schema (see
[`SCHEMA_VERIFICATION.md`](./SCHEMA_VERIFICATION.md)).

The frontend is **largely safer than the off-chain JS scripts** because
most action paths bypass the SDK and call contracts directly via ethers.
But there are sharp edges — one critical, several medium — documented
below.

---

## TL;DR

- **Most pages work today** by skipping the broken `/tx/*` SDK surface
  entirely and going straight to the contracts via ethers in
  `frontend/js/contracts.js`.
- **One page is broken**: `frontend/js/pages/identity.js` hardcodes
  `http://localhost:3001` and calls `/credit/:address`, which is part of
  the orphaned `backend/routes/virtuals.js` (see
  [`VIRTUALS_SDK_AUDIT.md`](./VIRTUALS_SDK_AUDIT.md) §V2). The "Check
  Credit (1 USDC)" button 404s without fallback.
- **Two pages are slow** (`portfolio.js`, `leaderboard.js`) because
  they hit the API's O(N) loan-walk endpoint flagged in
  [`API_AUDIT.md`](./API_AUDIT.md) §4 — first load can take >60 s.
- **Loan duration handling is correct** in `borrow.js` — has inline
  validation matching `assertDurationDays` semantics, including the
  helpful "looks like seconds" hint.
- **Repay/supply flows are direct contract calls** with no API
  dependency — they work.

---

## Severity scoreboard

| # | Finding                                                     | Severity   | Page               |
|---|-------------------------------------------------------------|------------|--------------------|
| 1 | `identity.js` hardcodes `localhost:3001` + calls `/credit`  | CRITICAL   | identity.js        |
| 2 | Portfolio loads slowly due to API O(N) walk                 | HIGH       | portfolio.js       |
| 3 | Loan list UI sorts on missing `state` field                 | HIGH       | portfolio.js       |
| 4 | Leaderboard depends on API status JSON shape                | MED        | leaderboard.js     |
| 5 | Pool detail uses incomplete API totalEarned                 | MED        | pool-detail.js     |
| 6 | Reputation field-name assumptions in portfolio header       | MED        | portfolio.js       |
| 7 | borrow.js duration validation — SAFE (no action)            | INFO       | borrow.js          |
| 8 | Repay flow uses contract reads — SAFE                       | INFO       | borrow.js, portfolio.js |

---

## §F1 (CRITICAL) — `identity.js` calls a dead endpoint with hardcoded URL

### Location

`frontend/js/pages/identity.js:177` (URL constant), `:214` and `:245`
(calls).

```js
// Line 177
const API_URL = 'http://localhost:3001';

// Lines 214 and 245
const resp1 = await fetch(`${API_URL}/credit/${address}`, { ... });
const resp2 = await fetch(`${API_URL}/credit/${address}`, { ... });
```

### Why broken

1. **Hardcoded localhost.** No env var, no config injection, no
   `window.location.origin` fallback. Anyone running the prod build
   against `https://specular.network` (or wherever the UI is hosted) will
   send requests to their own machine, which won't have the API server
   running.
2. **`/credit/:address` route is orphaned.** Per
   [`VIRTUALS_SDK_AUDIT.md`](./VIRTUALS_SDK_AUDIT.md) §V2,
   `backend/routes/virtuals.js` defines a `/credit/:address` handler but
   the router is **never mounted** in any Express server in the repo.
   Probed live against `MultiNetworkAPI.js` and production:
   `GET /credit/:any` → 404.
3. **No fallback.** Unlike `portfolio.js` (which falls back to direct
   contract reads when the API is unreachable), `identity.js` has no
   alternative path. The "Check Credit (1 USDC)" button just shows an
   error toast and stops.

### User impact

A user on the Identity page who clicks "Check Credit (1 USDC)" sees
something like:

> ❌ API timeout — is the server running?

…even if the user is online and the chain is healthy. The x402-style
paid-credit-check demo is **non-functional in production today**.

---

## §F2 (HIGH) — Portfolio cold load takes >60 s due to API O(N) walk

### Location

`frontend/js/pages/portfolio.js:80`:

```js
api.getAgentProfile(account).catch(() => null),
```

### Why slow

The `/agents/:address` endpoint in `MultiNetworkAPI.js` walks
**every loan ever created on chain** to filter by borrower
(see [`API_AUDIT.md`](./API_AUDIT.md) §4). On Arc Testnet that's 2094+
loans as of this session; cold-cache response time is >60 seconds.

The first user to hit the portfolio page after the API server restarts
or evicts that key from cache pays the full cost. Subsequent loads are
fast.

### Mitigation already in place

`.catch(() => null)` falls back to direct contract reads, so the page
still renders correctly — just slowly. Lines 159-170 contain the
contract-only fallback path.

### What would actually fix this

The right fix is server-side, not frontend — index loan events by
borrower in the API server, or use the `agentLoans(address, idx)`
indexed accessor on chain instead of walking all loans. See
[`API_AUDIT.md`](./API_AUDIT.md) §4 cleanup section.

---

## §F3 (HIGH) — Loan list sorts on `state` field that doesn't exist in API response

### Location

`frontend/js/pages/portfolio.js:255-256`:

```js
const aActive = Number(a.loan.state) === 1;
const bActive = Number(b.loan.state) === 1;
```

### Why broken

Per [`API_AUDIT.md`](./API_AUDIT.md) §1 (verified live this session),
the `/agent/:id/loans` response object does **not** include `state`,
`repaid`, or `defaulted`. Probed response from agent 43 loan 2093:

```json
{
  "loanId": 2093, "borrower": "0x65...", "amount": "5000000",
  "interestRate": 500, "duration": 604800, "startTime": ..., "endTime": ...,
  "role": "borrower"
}
```

`Number(undefined)` is `NaN`. `NaN === 1` is `false`. So **all loans
will be sorted as "not active"**, which means the Active/Completed
sectioning may misorder, and the active-loans-first sort collapses to
the natural ordering.

### Mitigation in place

The page also fetches each loan directly from the contract via
`alm.loans(loanId)` (lines 146-151). The contract reads include the
correct `state` field (uint8). The API data is only used for sorting,
not display — so the **wrong order, but right content** is visible.

### What would actually fix this

Server-side — add `state: loan.state` to the JSON construction in
`MultiNetworkAPI.js` around line 807. See
[`API_AUDIT.md`](./API_AUDIT.md) §1 cleanup section.

---

## §F4 (MED) — Leaderboard depends on API status JSON shape

### Location

`frontend/js/pages/leaderboard.js:60`:

```js
const s = await api.getStatus();
el.innerHTML = `
    ${statCard('Total TVL',     formatMoney(s.liquidity?.tvlUsdc), ...)}
    ${statCard('Active Agents', s.agentCount ?? s.agents?.total ?? '—', ...)}
    ${statCard('Total Loans',   s.loanCount  ?? s.loans?.total  ?? '—', ...)}
    ${statCard('Active Loans',  s.activeLoanCount ?? s.loans?.active ?? '—', ...)}
`;
```

### Why fragile

The fallback chains (`s.agentCount ?? s.agents?.total ?? '—'`) are
defensive coding that **acknowledges** the JSON shape is unstable. If
the API server changes nesting (`s.loans.total` → `s.loans.count`) the
display silently shows `'—'`, masking the breakage.

### Severity rationale

Marked MED rather than HIGH because the leaderboard not displaying
correct numbers is cosmetic — it doesn't affect any action the user can
take. But the pattern (defensive fallbacks instead of a contract) is
worth flagging as a sign the consumer doesn't trust its dependency.

---

## §F5 (MED) — Pool detail uses incomplete API totalEarned

### Location

`frontend/js/pages/pool-detail.js:34, 128-130`:

```js
let apiPool = null;
try { apiPool = await api.getPool(Number(agentId)); } catch { /* API offline */ }

// later:
${apiPool?.totalEarnedUsdc != null
    ? apiPool.totalEarnedUsdc.toFixed(4) + ' USDC'
    : formatUSDC(totalEarned) + ' USDC'}
```

### Issue

The API's `getPool` response may omit `totalEarnedUsdc` (or return a
slightly different basis from the on-chain `totalEarned` field). The
fallback to the contract read is correct.

This is more of a "watch this spot for drift" than an active bug.

---

## §F6 (MED) — Reputation field-name assumptions

### Location

`frontend/js/pages/portfolio.js:224-226`:

```js
${rep.creditLimitUsdc} ...
${rep.interestRatePct} ...
${rep.collateralRequiredPct} ...
```

### Issue

These are field names the API server constructs after calling the four
ReputationManagerV3 view functions
(`calculateCreditLimit`, `calculateInterestRate`,
`calculateCollateralRequirement`, plus the implied tier-string
derivation). Per [`SCHEMA_VERIFICATION.md`](./SCHEMA_VERIFICATION.md)
§G1, there is **no** on-chain `getReputation()` returning a tuple — the
shape is constructed entirely server-side, and the field names are a
convention the API server invented.

If the API server's field names ever drift (e.g. `creditLimitUsdc` →
`creditLimit`), the portfolio header silently shows `undefined`. There's
no schema contract or type-check between the API and the frontend.

### Severity rationale

MED because it's a latent issue (works today) but has no defense against
upstream drift.

---

## §F7 (INFO — SAFE) — `borrow.js` duration handling

### Location

`frontend/js/pages/borrow.js:127-130, 211-218`:

```html
<input type="number" id="loanDuration" value="30" min="7" max="365">
```

```js
if (!Number.isInteger(duration) || duration < 7 || duration > 365) {
    const secondsHint = (Number.isInteger(duration) && duration > 365 && duration % 86400 === 0)
        ? ` (looks like ${duration / 86400} days expressed in seconds — enter days)`
        : '';
    showToast(`Duration must be 7–365 days${secondsHint}`, true);
    return;
}
```

### Status

**SAFE.** This validator is a precise mirror of `assertDurationDays` in
`src/sdk/duration.js`, including the seconds-hint logic. If a user
somehow submits a seconds-shaped value (e.g. via DevTools), they get the
same helpful error a JS caller would.

The downstream `alm.requestLoan(amount, duration)` call passes through
`frontend/js/contracts.js`, which calls the contract directly (no SDK,
no API). The contract enforces the same range on-chain.

---

## §F8 (INFO — SAFE) — Repay/supply flows use direct contract calls

### Locations

`frontend/js/pages/borrow.js:255-282` (repay):

```js
async function doRepayLoan(loanId) {
    const alm = marketplace();
    const loan = await alm.loans(loanId);
    const principal = loan[3];
    const interestRate = loan[5];
    const duration = loan[8];
    const interest = await alm.calculateInterest(principal, interestRate, duration);
    // ... approval + repayment
}
```

`frontend/js/pages/supply.js:198`:

```js
const supplyTx = await alm.supplyLiquidity(_poolAgentId, amount);
```

### Status

**SAFE.** No API round-trip. Loan state read directly from contract via
the verified 10-field tuple ([`SCHEMA_VERIFICATION.md`](./SCHEMA_VERIFICATION.md)
§S1) — positional indexes 3 (amount), 5 (interestRate), 8 (duration)
all match. Interest calculated by the on-chain `pure` view — no formula
duplication. Repay/supply transactions go straight through ethers'
`sendTransaction`.

This is exactly the pattern [`OPTION2_FEASIBILITY.md`](./OPTION2_FEASIBILITY.md)
proposes for the JS SDK. The frontend is already there for these flows.

---

## What works today (button-by-button)

| User action                | Status     | Notes                                              |
|----------------------------|------------|----------------------------------------------------|
| Connect wallet (any page)  | ✅ works    | Direct ethers + injected provider                  |
| View leaderboard           | ⚠ slow      | Cold cache: 60+ s. Falls back to contracts on err |
| View pool detail           | ✅ works    | Falls back to contracts; one cosmetic field gap   |
| View portfolio             | ⚠ slow + sort wrong | Same O(N) issue + sort uses missing `state` |
| Request loan (borrow page) | ✅ works    | Direct contract call; correct duration handling   |
| Repay loan                 | ✅ works    | Direct contract call; uses on-chain `calculateInterest` |
| Supply liquidity           | ✅ works    | Direct contract call                               |
| **Check Credit (1 USDC)**  | ❌ broken   | 404 on `/credit/:addr`; no fallback                |
| Sign In With Agents (SIWA) | ✅ works    | Direct contract call to registry                   |
| Register agent             | ✅ works    | Direct contract call (does not use SDK `/tx/register`) |

---

## Why the frontend is mostly safe

The frontend bypasses the broken SDK surface entirely for **all
state-changing operations** (loan request, repay, supply, register). It
does this by calling the contracts directly through
`frontend/js/contracts.js`, which constructs ethers `Contract`
instances and exposes typed bindings. The API layer
(`frontend/js/api.js`) is used only for read queries that benefit from
server-side aggregation (leaderboard totals, pool lists, agent
profiles).

This is essentially the architecture
[`OPTION2_FEASIBILITY.md`](./OPTION2_FEASIBILITY.md) proposes for the JS
SDK. The frontend got there first, by accident or by design.

The exceptions are §F1 (the credit-check x402 demo, which legitimately
needs server-side scoring data the chain doesn't have) and the read-only
API dependencies in §F2-F6 (which work but have schema-drift risk).

---

## Recommended actions

In order of impact:

1. **Fix `identity.js` URL handling** (§F1).
   - Replace `const API_URL = 'http://localhost:3001'` with a config
     lookup (env-injected at build time, or read from
     `window.SPECULAR_API_URL` set by a small `<script>` tag).
   - OR remove the credit-check button entirely if the x402 demo isn't
     active.
   - OR mount `backend/routes/virtuals.js` in `MultiNetworkAPI.js` so the
     route stops 404ing.
2. **Add `state` to API loan response** to fix §F3 sort and unblock
   future filter-by-state UI features.
3. **Index `/agent/:address` server-side** to fix §F2 cold-cache
   latency. Replace the loan-walk with `agentLoans(addr, idx)` indexed
   reads or a SQLite-backed event index.
4. **Type-narrow the API response shapes** (e.g. with a JSON schema
   shared between server and frontend) so §F4 and §F6 fail loud rather
   than silently rendering `'—'` or `undefined`.

None of these are urgent — all the load-bearing user actions work today.

---

## Cross-reference

- [`API_AUDIT.md`](./API_AUDIT.md) — server side of §F2, §F3
- [`VIRTUALS_SDK_AUDIT.md`](./VIRTUALS_SDK_AUDIT.md) — `/credit/*`
  orphaning that breaks §F1
- [`SCHEMA_VERIFICATION.md`](./SCHEMA_VERIFICATION.md) — confirms the
  contract-side reads in §F8 are correct
- [`OPTION2_FEASIBILITY.md`](./OPTION2_FEASIBILITY.md) — the frontend's
  direct-contract pattern is the same pattern this proposes for the SDK
- [`DOC_FABRICATION_AUDIT.md`](./DOC_FABRICATION_AUDIT.md) — broader
  context on documented vs actual state
