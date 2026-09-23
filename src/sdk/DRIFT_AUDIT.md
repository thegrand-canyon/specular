# Schema-Drift Audit

A read-only sweep of the repo against [`SCHEMA.md`](./SCHEMA.md) — what is the
on-chain interface vs. what the JS callers think it is. Each finding cites
`file:line` and the exact contract behavior that contradicts it.

This is a report. **No source files were modified by this audit.** Each
finding includes the minimum diff that would resolve it; whoever picks up the
follow-up should apply them carefully and re-test against a fresh on-chain
fixture.

Audit corpus: every `.js`, `.ts`, `.jsx`, `.tsx` file under the project root
excluding `node_modules`, `artifacts`, `cache`, `.git`. Run via `/usr/bin/grep
-rn` against the patterns derived from `SCHEMA.md` gotchas.

---

## Summary

| Class                                       | Sites | Severity | Confirmed runtime impact?     |
|---------------------------------------------|-------|----------|-------------------------------|
| `LoanState` enum **inverted** (state==2 read as ACTIVE) | 7 | HIGH     | Would silently process repaid loans as active, or skip every active loan |
| `loan.principal` (struct field is `amount`) | ~15   | MED      | `undefined` arithmetic, errors at next BigInt op |
| Wrong **positional index** for `amount`     | 1     | HIGH     | Computes interest using `agentId` as principal |
| Interest formula **missing duration scaling** | 3   | HIGH     | ~50× over-charge on 7-day loans |
| `requestLoan(amount, duration_seconds)`     | ~12   | MED      | On-chain revert `"Invalid duration"`, opaque |
| `marketplace.requestLoan(loanAmount, duration, 2000)` (3 args) | 1 | HIGH | Pre-mainnet script; ABI mismatch; will throw before send |
| `getAgentLoans()` invocation                | 1     | LOW      | Already wrapped in try/catch fallback |
| Stale Sepolia comment claiming `state=2 == ACTIVE` | 2 | DOC | Misleads anyone copy-pasting |

7 of these classes were directly captured in `SCHEMA.md` after this session's
on-chain footguns; this audit is the corresponding inventory pass.

---

## 1. `LoanState` enum inversion

The contract enum is **`{REQUESTED=0, ACTIVE=1, REPAID=2, DEFAULTED=3}`**
([`SCHEMA.md` §LoanState](./SCHEMA.md#loanstate-enum)). Several scripts treat
`state==2` as ACTIVE, which is the wrong end of the enum.

### Confirmed bugs

- **`examples/repay-loan-sepolia.js:41`** — comment is fully wrong:
  ```js
  if (loan.borrower === signer.address && loan.state === 2) { // ACTIVE (0=REQUESTED, 1=APPROVED, 2=ACTIVE)
  ```
  The comment invents a non-existent `APPROVED` state and shifts the others by
  one. As written, this script will only "find" loans the borrower already
  repaid, then try to repay them again → on-chain revert at line 286
  (`require(loan.state == LoanState.ACTIVE, "Loan not active")`).
  **Fix**: change to `=== 1` and update the comment.

- **`examples/live-sepolia-agent.js:133`** — `if (loan.state === 2) { // ACTIVE`
  Same shape. **Fix**: `=== 1`.

- **`scripts/repay-all-v3-loans.js:39`** —
  `Number(loan.state) === 2` filtering for "active" loans.
  **Fix**: `=== 1`.

- **`scripts/simulate-agent-activity.js:159`** — `loan.state === 2 // ACTIVE`.
  **Fix**: `=== 1`.

- **`scripts/simple-loan-cycle.js:121`** —
  ```js
  console.log(`State: ${loan.state === 2 ? 'ACTIVE (auto-disbursed)' : 'REQUESTED'}`);
  ```
  After `requestLoan` returns, the loan is always state=1 (ACTIVE). This log
  branch will print "REQUESTED" for every successful loan and "ACTIVE" only
  after the borrower has already repaid — exactly backwards.
  **Fix**: `=== 1` for the ACTIVE branch.

- **`scripts/check-pool-earnings.js:93`** — `loan.state === 2 // ACTIVE`.
  **Fix**: `=== 1`.

- **`src/SpecularAgent.js:201`** —
  ```js
  if (Number(loan.state) !== 2) { // ACTIVE state
  ```
  Reads as: "if not REPAID, log a warning". The comment is wrong; whether the
  *intent* matches `!== 1` (skip non-active) needs human review. The mismatched
  comment-vs-code is a code smell either way.
  **Fix**: clarify intent + use the right number.

### Correct usage (for reference)

These call sites map state correctly and confirm the convention:

- `frontend/js/pages/portfolio.js:255-256` — `Number(state) === 1` for ACTIVE
- `scripts/monitor-arc-protocol.js:109` — `loan[9] === 1 // ACTIVE`
- `scripts/arc-repay-active-loans.js:49` — `loan.state === 1`
- `scripts/test-withdrawals.js:226` — `loan.state === 1 // ACTIVE`
- `scripts/check-agent-loans.js:56` — `loan.state === 1 // ACTIVE`
- `scripts/arc-pool-status.js:91/94` — `=== 1` and `=== 2` with correct labels
- `scripts/loan-history.js:57/72/167/170` — comments and code agree
- `scripts/repay-loan-base.js:51/56` — `state === 2n` (repaid), `!== 1n` (not active)
- `src/test-suite/repay-all-loans.js:69` — `loan.state === 1`
- `src/test-suite/test-contract-functions.js:217` — `loan.state === 1n`
- `check-and-repay-loans.js:52/70` — defensive `loan.state ?? loan[9]`,
  BigInt-converted

The split is roughly 11 correct vs 7 inverted — bad enough that any new
script lifting boilerplate from one of the inverted siblings will inherit
the bug.

---

## 2. `loan.principal` (struct field is `amount`)

Per [`SCHEMA.md` §Loan struct](./SCHEMA.md#loan-struct), the field is named
`amount` and lives at index 3. There is no `principal` field on the struct.

### Confirmed struct-decode bugs

These read the **on-chain struct** and use `.principal`:

- **`src/agents/demo-borrower-agent.js:190`**
  ```js
  const principal = loan.principal;
  const interest = loan.interestRate * principal / 10000n; // ← also missing duration
  ```
  Double bug: wrong field + missing duration scaling (see §4).

- **`src/integrations/langchain/SpecularCreditTool-original.js:248-249,304`** —
  same `loan.principal` pattern in two sites.

- **`scripts/loan-history.js:61,73-74,105,179,187`** — six call sites all
  using `loan.principal`. The lifetime-volume aggregation at line 179
  (`totalPrincipal += loan.principal`) silently sums `undefined`s, producing
  `NaN` totals.

- **`src/analytics/ProtocolAnalytics.js:206,233,294,377`** — four sites,
  including the volume reducer
  `loans.reduce((s, l) => s + l.principal, 0n)` which throws
  `Cannot mix BigInt and other types` on the first iteration when `.principal`
  is `undefined`.

- **`scripts/analyze-usage.js:237,248,293`** — same pattern in usage analytics.

- **`scripts/pool-health-checker.js:149,214`** — including a user-facing
  message `Loan #X: ... (${formatUSDC(loan.principal)} principal)` that will
  print "undefined principal".

- **`scripts/test-arc-testnet-full.js:222`** — log line reading
  `lastLoan.principal`.

- **`scripts/rapid-loan-test.js:115`** — `BigInt(loan.principal)` will throw
  on `BigInt(undefined)`.

### API-shape principal (probably fine)

These read `data.principal` from API responses, where the API server may
serialize the field as `principal`. Verify against the actual API server
output before changing — these are NOT necessarily bugs:

- `mcp-server/dist/index.js:306`, `mcp-server/src/index.ts:431` —
  `data.principal` from API
- `scripts/repay-all-agents.js:44`, `scripts/arc-load-test.js:109`,
  `templates/yield-optimizer-agent/yield-optimizer-agent.js:174` —
  `loan.principal + loan.interest` (also uses `.interest`, which is also
  not a struct field, so this is API JSON shape)
- `repay-all-loans.js:51` — `loan.principal + loan.interestOwed` (clearly API)
- `scripts/export-protocol-data.js:170,206` — exports object built from API
- `src/integrations/openai/SpecularOpenAI.js:158` — `data.principal` (API)

### Fix pattern

For struct-decode sites:
```js
// Before
const principal = loan.principal;

// After
const principal = loan.amount;     // named tuple
//   OR
const principal = loan[3];          // positional (preferred for ethers v5 compat)
```

---

## 3. Wrong positional index — CRITICAL

**`src/integrations/langchain/SpecularCreditTool.js:213-215`**

```js
const principal = loan[2];           // ← loan[2] is agentId, NOT amount
const interestRate = loan[3];        // ← loan[3] is amount, NOT interestRate
const interest = interestRate * principal / 10000n;
```

Per [`SCHEMA.md`](./SCHEMA.md):

| Idx | Field    |
|-----|----------|
| 2   | agentId  |
| 3   | amount   |
| 5   | interestRate |

So this code computes `interest = amount * agentId / 10000n`. For an
agent with `agentId=43` and `amount=5_000_000` (5 USDC base units):

- Buggy interest = `5_000_000 * 43 / 10000` = 21500 base units = **0.0215 USDC**
- Correct 5% APR / 7-day interest ≈ **0.0048 USDC**

The error shape depends on the agentId, so it scales unpredictably with
deployment age. **No exception is thrown**; the agent silently overpays.

Same file, line 270:
```js
amount: ethers.formatUnits(loan[2], 6) + ' USDC',  // loan.principal
```
Reports the agentId as the loan amount in user-facing output.

This is the worst single bug surfaced by the audit. The langchain integration
has been "working" against this code path with silent value errors.

---

## 4. Interest formula missing duration scaling

The contract's [`calculateInterest`](../../contracts/core/AgentLiquidityMarketplace.sol)
formula is:

```
interest = (principal * annualRateBPS / 10000) * durationSeconds / 365 days
```

Three sites omit the duration scaling, computing only `(principal *
rateBPS) / 10000` — the **annualized** interest charged regardless of
loan length. For the canonical 7-day loan the buggy value is 365/7 ≈
**52× too high**.

- `src/agents/demo-borrower-agent.js:191` —
  `loan.interestRate * principal / 10000n`
- `src/integrations/langchain/SpecularCreditTool-original.js:249` — same
- `src/integrations/langchain/SpecularCreditTool.js:215` — same (compounded
  with the §3 index bug above; the resulting value is essentially random)

**Fix**: replace the local computation with a call to the contract's
`calculateInterest` view. It's `pure` and free.

```js
// Before
const interest = loan.interestRate * principal / 10000n;

// After
const interest = await marketplace.calculateInterest(
  loan.amount,        // or loan[3]
  loan.interestRate,  // or loan[5]
  loan.duration       // or loan[8]  -- SECONDS, already scaled
);
```

---

## 5. `requestLoan(amount, duration_seconds)` — wrong unit

`AgentLiquidityMarketplace.requestLoan(uint256 amount, uint256 durationDays)`
takes **days**, not seconds. The contract internally multiplies by `1 days`
(line 204) and reverts with `"Invalid duration"` for out-of-range input.

Sites passing seconds-shaped values:

- `scripts/test-gas-optimization.js:133,266` — `30 * 24 * 60 * 60`,
  `7 * 24 * 60 * 60`. Both passed straight to `requestLoan(loanAmount, duration)`
  at lines 141 and 268. Hardhat tests against a fork, so the on-chain revert
  is visible — but these silently fail with the opaque `"Invalid duration"`.

- `scripts/test-integration.js:79,207,309` — `30/60/45 * 24 * 60 * 60`,
  passed to `requestLoan` at lines 81, 209, 311. Same shape.

- `scripts/test-platform-fees.js:155,157` — `30 * 24 * 60 * 60`.

- `scripts/deploy-demo-agents.js:183,189` — `7 * 24 * 60 * 60` PLUS a
  3-argument call: `requestLoan(loanAmount, duration, 2000)`. The contract
  function takes 2 args, so this throws before the unit even matters.
  **HIGH severity**: this script is referenced by demo deployment paths;
  it currently cannot succeed.

### Recommendation

Apply `assertDurationDays` from `src/sdk/duration.js` at the top of each of
these test scripts. The validator will catch all of them at startup with the
seconds-hint error message documented in [`SCHEMA.md`](./SCHEMA.md).

The frontend (`frontend/js/pages/borrow.js:212-214`) already has an inline
seconds-detect warning — the same defense should be applied at every JS
entry point that takes user input.

---

## 6. `getAgentLoans()` invocation

Function does not exist on the contract — the mapping is exposed only as
`agentLoans(address, uint256)` ([`SCHEMA.md` §agentLoans](./SCHEMA.md#agentloans--getagentloans-confusion)).

- `probe-deployed-bugs.js:55-62` — calls `mp.getAgentLoans(agentId)` inside
  a try/catch block specifically logging "not available" on failure. This
  is informed code probing for a missing method. **Not a bug**; left in
  audit for completeness.

No other sites call `getAgentLoans`. Likely already cleaned up in earlier
sessions.

---

## 7. Frontend duration handling

`frontend/js/pages/borrow.js:212-214` has a custom inline check for the
seconds-shaped mistake:

```js
const secondsHint = (Number.isInteger(duration) && duration > 365 && duration % 86400 === 0)
    ? ` (looks like ${duration / 86400} days expressed in seconds — enter days)`
    : '';
```

This duplicates the logic in `src/sdk/duration.js`. Suggest replacing with
the shared `assertDurationDays(duration)` import and surfacing the resulting
`RangeError.message` to the UI. Single source of truth, identical message
shape across CLI and UI.

---

## Recommended cleanup order

If a future session picks this up, attack in this order — by **expected
runtime impact** descending:

1. **§3 (langchain `loan[2]` swap)** — silent value bug, hard to detect, in a
   user-facing integration. Fix first.
2. **§4 (interest formula)** — same files as §3 plus demo-borrower-agent.
   Replace each with `marketplace.calculateInterest(...)` call.
3. **§1 (state inversion)** — 7 sites, mechanical `=== 2` → `=== 1` flip
   (or vice versa, depending on intent). Audit each comment line during fix.
4. **§5 (duration units)** — apply `assertDurationDays` at each entry point;
   one-line addition per script.
5. **§2 (`loan.principal`)** — repetitive but mechanical replacement.
6. **§6, §7** — minor / docs.

After each fix, re-grep for the same pattern to confirm no new sites were
introduced and the existing ones are gone.

---

## Cross-reference

- [`SCHEMA.md`](./SCHEMA.md) — the canonical contract shapes this audit
  measures against.
- [`RECEIPT.md`](./RECEIPT.md) — receipt helper public contract.
- `assertDurationDays` lives in `src/sdk/duration.js`.
- The sites that already follow `SCHEMA.md` (listed under "Correct usage" in
  §1) are the templates to lift from when fixing the broken ones.
