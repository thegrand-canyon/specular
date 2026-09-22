# Specular Client SDK — Robustness & Failure-Injection Report

**Date:** 2026-09-21
**Scope:** the CLIENT libraries a third-party AI agent actually depends on —
`src/sdk/SpecularQuickstart.js`, `src/SpecularAgent.js`, `src/ContractManager.js`,
`src/StateManager.js`, `src/EventListener.js`, `python/specular/client.py`.
**Target contracts:** `AgentLiquidityMarketplaceV6` at `VERSION() == "V6.1"`
(`previewRepayment`, `canTopUp`, `qualifiedAmountAt`, `getActiveLoanIds`,
late-repay interest on `max(duration, elapsed)` capped at `duration + 30 days`).
**Branch/worktree:** `arc-mainnet-launch` @ `5fe56c4`, worktree
`.claude/worktrees/agent-a5b6e03cdea7dee91`.
**Chain used:** local hardhat only. No transaction was broadcast to Arc mainnet or Base.

**Method.** A fault-injecting JSON-RPC transport (`test/sdk-robustness/helpers/faultProvider.js`)
sits between ethers and an in-process hardhat node, so the SDK under test speaks
real JSON-RPC and *every* request can be dropped, delayed, corrupted, answered
from a stale block, or answered with a revert. Real `ethers.Wallet` signers
(own key, local signing, `eth_sendRawTransaction`) — i.e. the shape a third-party
agent actually runs, not a node-unlocked signer. Every finding was reproduced
with a failing test first, then fixed, then the test made to pass.

**Result.** 17 defects found (2 HIGH, 10 MEDIUM, 5 LOW) + 3 Python-only gaps.
All fixed. 65 new robustness tests; root suite **682 passing / 5 pending /
2 failing** (the 2 are pre-existing, environmental — see §7).

---

## 1. Findings

| ID | Sev | Component | Mechanism | JS / Py | Status | Test |
|----|-----|-----------|-----------|---------|--------|------|
| **F-R1** | **HIGH** | Quickstart capability detection | `try { VERSION() } catch { this._mpVersion = 'V6' }`. ethers collapses a 429/500/timeout/socket-reset during `eth_call` into the *same* `CALL_EXCEPTION (no data)` it produces for a selector the contract does not implement. **One transient RPC error therefore permanently caches "this is a V6 deployment"** for the SDK instance. On a V6.1 chain the SDK then sizes a LATE repayment from the nominal fixed-term figure, under-approves, and `repayLoan` reverts — the agent **cannot close the loan at all** and defaults. Reproduced end-to-end: 13-day-late loan, one injected timeout on `VERSION()`, repay failed with `ERC20InsufficientAllowance`. | both | **FIXED** | `04-v61-capability` ×2; py `TestCapabilityDetection` |
| **F-R2** | **HIGH** | `previewRepayment()` fallback | Any error that wasn't the literal string `Loan not active` fell through to `calculateInterest(amount, rate, duration)` — the V6 nominal figure. A 429 on the view therefore silently produced an under-approval for a late loan, same consequence as F-R1. | both | **FIXED** | `04-v61-capability` ×2; py `TestPreviewFallback` |
| **F-R3** | MED | allowance-shortfall recovery | The bounded-buffer safety net in `borrow`/`repay` triggered on `/allowance\|exceeds\|transfer amount/i` over `e.message`. OpenZeppelin v5 tokens revert with the custom error `ERC20InsufficientAllowance(address,uint256,uint256)` (`0xfb8f41b2`), whose ethers message is `"execution reverted (unknown custom error)"` — **no match, so the safety net was dead** against any custom-error USDC. Python had no recovery path at all. | both | **FIXED** | `04`, `02-tx-safety`; py `TestAllowanceShortfall` |
| **F-R4** | MED | dangling allowance | Any failure *after* `_approveExact()` — a 503 on `estimateGas`, a socket drop inside `wait()`, the process being killed — left a standing USDC allowance to the marketplace. Measured: a failed 100-USDC borrow left a 100-USDC allowance live. | both | **FIXED** | `01-rpc-adversity` F-R4; `03-exact-approval` ×3 |
| **F-R5** | MED | stale state | **Nothing in the SDK was tied to a block.** A replica serving state behind head makes a LATE loan read as on-time and cheap, so the approval is sized *below* what the chain will pull. Measured: SDK approved `1002876712` where the chain pulled `1008219182`. The SDK silently acted on stale state and the repay failed. | both | **FIXED** | `01-rpc-adversity` F-R5; py `TestStaleness` |
| **F-R6** | MED | lost send response | `eth_sendRawTransaction` timing out *after* the node accepted the tx made a **successful repay look like a failure**. On `borrow` this is worse: the SDK reports failure, the agent retries, and a **second loan is opened**. | JS (py partial) | **FIXED** | `01-rpc-adversity` F-R6 |
| **F-R7** | MED | reorg | A reorg that un-mines a repay left the SDK with observations that no longer exist, and nothing detected the head moving backwards. | both | **FIXED** | `01-rpc-adversity` F-R7 |
| **F-R8** | MED | unbounded hang | `tx.wait()` with no timeout **never returns** when the RPC stops serving receipts. An unattended agent simply stops, forever. The test that exercised this had to be killed by mocha's 240 s timeout. | JS | **FIXED** | `01-rpc-adversity` F-R8 |
| **F-R9** | LOW | hostile input | `supply`/`withdraw` fed agent-supplied values straight into `ethers.parseUnits(String(amount))`. Negative amounts only failed later at ABI encoding; `1e-7` and `1e21` (what `String()` produces for small/large numbers) died with an opaque ethers error; sub-base-unit amounts silently rounded to a zero-value transaction. | both | **FIXED** | `06-hostile-input`; py `TestInputValidation` |
| **F-R10** | MED | nonce safety | Every SDK op is multi-transaction (approve → act → revoke) and ethers resolves each nonce at send time from `pending`. Two SDK calls in flight on one wallet handed the **same nonce to two transactions**: one landed, the other died `nonce has already been used`. Reproduced with `supply` + `repay` + `borrow` fired together, and with two concurrent borrows. | both | **FIXED** | `02-tx-safety` F-R10 ×2; py `TestWriteSerialization` |
| **F-R12** | MED | `StateManager` | A failed refresh was swallowed and the **previous value was still returned past its TTL**, with no signal. An agent would size a loan against a credit limit that is minutes or hours old — the exact silent-stale-state failure this pass looked for. | JS | **FIXED** | `05-state-event` F-R12 |
| **F-R13** | MED | `StateManager` | No cache entry was tied to a block, so a value read on a block that was later reorged away kept being served for the rest of its TTL. | JS | **FIXED** | `05-state-event` F-R13 |
| **F-R14** | MED | `EventListener` | On reconnect, a `queryFilter` that threw (the *same* RPC outage that caused the reconnect) was swallowed per contract and `_lastSeenBlock` advanced to head anyway — **the missed window was lost permanently and silently**. A lender bot would never see the `LoanDefaulted` it disconnected through. | JS | **FIXED** | `05-state-event` F-R14 |
| **F-R15** | MED | exact approval | A *larger* pre-existing allowance (a crashed session, or an older SDK's `MaxUint256`) was accepted as "already covered" and carried forward forever — so "exact approvals" were **not exact**: a wallet could keep an unlimited approval standing while every SDK call reported exact behaviour. | both | **FIXED** | `03-exact-approval` F-R15 ×2; py `TestExactApproval` |
| **F-R16** | LOW | hostile input | `agentId` was unvalidated; a NaN/float/string reached ethers with an opaque error — for `supply`, *after* the approve had already been sent. | both | **FIXED** | `06-hostile-input` |
| **F-R17** | LOW | hostile input | The metadata URI passed to `onboard()` was unbounded and unsanitised; a megabyte string burns unbounded gas (and can exceed the block limit, so onboarding fails in a way no retry fixes). | both | **FIXED** | `06-hostile-input` |
| **F-R18** | MED | **Python only** | `if duration_days < 7 or duration_days > 365` — **both comparisons are `False` for `float('nan')`**, so NaN passed validation and reached the chain. Floats (`7.5`) were accepted too. The JS SDK's `assertDurationDays` has caught this since the 2026-07 audit (L3). | Py | **FIXED** | py `TestInputValidation` |
| **F-R19** | HIGH *(usability)* | **Python only** | `NETWORK_CONFIGS` had no `arc-mainnet`. **The network the protocol actually launched on was unreachable from the Python client**, and the constructor default is `'base'` — a Python agent asking for Arc mainnet got a `ValueError`, or silently transacted on Base. | Py | **FIXED** | py `TestNetworkParity` |
| **F-R20** | LOW | **Python only** | `onboard()` read `addressToAgentId` once after `register()` and **proceeded with `agentId == 0`** if the write hadn't propagated; no retry on `createAgentPool` reverting `Not a registered agent`. JS had both a 20 s propagation poll and a 5× retry. | Py | **FIXED** | pre-fix probe; py suite |

### Verified-correct (no defect)

| Check | Result |
|-------|--------|
| **F-R11** — a tx that reverts on chain after a *successful* gas estimate | Never reported as success. `tx.wait()` raises on `status == 0`; Python's `_send` checks `receipt["status"] != 1`. |
| Write re-broadcast (`ContractManager.callContract`, 2026-07 M4) | Still holds. On a transient `wait()` failure it polls the receipt by hash and never re-sends. Verified no duplicate raw tx under a dropped connection. |
| Gas-estimation failure | Fails closed; nothing is broadcast. |
| Underpriced / rejected broadcast | Surfaced without a duplicate send. |
| Inconsistent-replica retry (registry registered / marketplace not) | The existing retry works: 2 injected `Not a registered agent` reverts were ridden out; a persistent one surfaces instead of looping forever. |
| Config shadowing (2026-07 M1) | **Holds.** A hostile CWD-local `src/config/base-addresses.json` plus five plausible `SPECULAR_*` env vars were ignored; the SDK source contains no `process.env` and no `process.cwd`. |
| Exact approvals (2026-07 M2) | Holds, and is now exact in both directions (F-R15). |
| EventListener reconnect / dedup (2026-07 M5) | Holds; extended with F-R14. |
| StateManager per-key TTL (2026-07 L8) | Holds; extended with F-R12/F-R13. |

### Open / documented, not fixed

| ID | Sev | Note |
|----|-----|------|
| OPEN-1 | INFO | `EventListener.start()` does **not** replay events that occurred while the listener was stopped (a deliberate `stop()`, a crash, a restart). Only a *reconnect* backfills. A bot that restarts must replay from its own persisted checkpoint via `queryPastEvents()`. Test `05-state-event` documents this. |
| OPEN-2 | INFO | The late-repay headroom is 600 s. A repay delayed past that re-prices and bumps (bounded), but each bump costs an extra approve. Agents on very slow chains should shorten the preview→send window rather than raise the headroom. |
| OPEN-3 | INFO | `ContractManager.callContract` passes its own options object (`retries`, `retryDelay`, `estimateGas`) through as ethers tx overrides. It works with the current ethers version but is fragile; it is a legacy path (`SpecularAgent`), not the Quickstart surface third-party agents use. |

---

## 2. Exact-approval audit — every USDC-pulling path

Resting state of the allowance after every operation is **zero**. No path ever
approves `MaxUint256`. All rows verified on a local V6.1 deployment with the
arc-mainnet launch levers (M-1 on, M-2 = 1 day, 1 % fee, minSupply 1 USDC).

| # | Path | What the contract pulls | What the SDK approves | Resting allowance | Test |
|---|------|------------------------|-----------------------|-------------------|------|
| 1 | `onboard()` | nothing | **nothing** (no approve tx at all since 2026-07 M2) | 0 | `03` |
| 2 | `borrow()` — collateral tier > 0 % | `amount × pct / 100` | exactly that | 0 | `03` |
| 3 | `borrow()` — 0 % collateral tier | nothing | **nothing** — no approve is sent | 0 | `03` |
| 4 | `borrow()` — contract pulls more than exact (buffer path) | ≤ collateral + principal | bounded buffer `collateral + principal`, then revoked | 0 | `test/sdk/quickstart-collateral-fallback` |
| 5 | `repay()` on time, V6.1 | principal + nominal interest | `previewRepayment().total` (exact to the base unit) | 0 | `03` |
| 6 | `repay()` LATE, inside the cap | principal + per-second interest | `preview.total + ≤600 s of accrual`, clamped at `duration + LATE_INTEREST_CAP` | 0 (leftover revoked) | `03`, `04` |
| 7 | `repay()` LATE, at the 30-day cap | a constant amount | exactly `preview.total`, **no headroom** | 0 | `03` |
| 8 | `repay()` on a V6.0 deployment | principal + nominal | `amount + calculateInterest(amount, rate, duration)` | 0 | `04` |
| 9 | `repay()` where accrual outran the headroom (preview→send race) | more than the preview | **re-priced from chain** and bumped, still ≤ the contract cap | 0 | `04` |
| 10 | `supply()` | `amt` | exactly `amt` | 0 | `03` |
| 11 | `withdraw()` | nothing from the caller | **no approve is sent** | 0 | `03` |
| 12 | `claim()` | nothing from the caller | **no approve is sent** | 0 | `03` |
| 13 | any failure path (borrow / repay / supply) | nothing | approval **revoked to 0** on the way out | 0 | `01`, `03` |
| 14 | pre-existing `MaxUint256` or over-large allowance | — | **tightened down** to exactly what the op needs | 0 | `03` |

**Worst-case residual if the process dies between approve and pull.** Bounded,
and bounded tightly: for a repay it is at most
`principal + interest(duration + 30 days)` **for that single loan**, spendable
only by the marketplace address loaded from the in-repo config. Never
`MaxUint256`, never the wallet balance. Verified explicitly, including the case
where the revoke transaction itself fails (`04-v61-capability`).

---

## 3. Reorg / stale-state verdict

**Before this pass: the SDK had no concept of a block.** Nothing in
`SpecularQuickstart`, `StateManager`, or `ContractManager` compared a read
against a height or a timestamp. Consequences measured:

- A replica behind head made a late loan read as on-time; the SDK sized and sent
  an approval that was **~5.3 USDC short** of what the chain pulled
  (`1002876712` vs `1008219182` base units), then failed — with no indication
  that the cause was staleness.
- A reorg (`evm_revert`) that un-mined a repay left `StateManager` serving
  pre-reorg credit data for the remainder of its TTL, and left the Quickstart
  with no signal at all.
- `tx.wait()` confirms at **1 block**. A single-confirmation reorg silently
  un-does a "settled" repay. (`src/sdk/receipt.js` supports `confirmations` but
  the Quickstart does not use it.)

**After the fix, the SDK notices, and refuses to act:**

1. **Monotonic guard** (always on) — the SDK records the highest block it has
   observed (every receipt, every head read). Before sizing money in
   `borrow()` and `_repayApproval()` it re-reads the head; a head *below* an
   already-observed block throws. This catches both a mid-flow load-balance onto
   a lagging replica and a chain reorg, without any clock dependency.
2. **Wall-clock guard** (default 600 s, `sdk.maxBlockLagSeconds = 0` to disable)
   — the head block must not trail real time by more than the limit. A head
   that is *ahead* of wall clock is never flagged, so test chains and clock skew
   do not false-positive. This catches a globally lagging endpoint where there
   is no earlier observation to compare against.
3. **`StateManager.checkForReorg()`** — one rate-limited `eth_blockNumber`
   (default ≤ 1 per 5 s) on each getter; a head that went backwards drops the
   whole cache. Far cheaper than the refetch it prevents.

Both guards are opt-out (`sdk.stalenessCheck = false`), because an integrator
running against a deliberately pinned archive node has a legitimate reason.

**Still true and unfixable in the client:** a reorg deeper than one block can
still un-do a repay the SDK already reported as successful. The SDK now *detects*
the rollback on its next operation; it cannot prevent it. Agents holding real
money on a chain with meaningful reorg depth should re-verify loan state after
settlement rather than trusting a single-confirmation receipt.

---

## 4. Python parity

The Python client was materially weaker than the JS one. Every divergence below
was reproduced against the pre-fix `client.py` (15 findings, scripted probe) and
is now fixed to parity.

| Divergence | Pre-fix Python | JS | Now |
|---|---|---|---|
| Arc mainnet | **absent from `NETWORK_CONFIGS`** | present | added |
| Capability detection | transient error → cached `"V6"` | same bug | both bytecode-probed |
| `previewRepayment` fallback | any exception → nominal | same bug | both selector-gated |
| Duration validation | **NaN and floats passed** (`nan < 7` is `False`) | `assertDurationDays` | parity |
| Amount validation | none (0, −5 accepted) | validated | parity |
| Allowance shortfall recovery | **none at all** | string-match only (broken on OZ v5) | both fixed, custom error included |
| Approval cleanup on failure | none | none | both `_with_approval_cleanup` |
| Staleness / reorg detection | none | none | both guards |
| Write serialization | none | none | both (`threading.RLock` / promise queue) |
| Over-large allowance | carried forward | carried forward | both tightened |
| `agentId` / metadata validation | none | none | both validated |
| Registry propagation poll | **proceeded with `agentId == 0`** | 20 s poll | parity |
| `createAgentPool` retry | none | 5× | parity |
| Receipt status check | present (2026-07 M3) | present | unchanged |
| `Decimal` amount precision | present (2026-07 L4) | n/a | unchanged |

**Remaining divergence (documented, not fixed):** JS `repay()` reconciles a lost
send response against on-chain loan state (F-R6) and returns `null` rather than
throwing; Python's `_send` raises on a lost broadcast and leaves reconciliation
to the caller. Python's `wait_for_transaction_receipt` is bounded by web3's own
default timeout, so it does not hang (the JS F-R8 bug had no Python analogue).

---

## 5. What a third-party agent integrator must handle themselves

1. **A `repay()` that resolves to `null` is a SUCCESS.** It means the repay was
   confirmed settled on chain but its transaction hash was never learned
   (the send response was lost). Do not retry it.
2. **`borrow()` may return `{ tx: null, reconciled: true }`.** The loan exists;
   it was adopted after a lost send response. **Never retry a `borrow()` that
   failed with a network-class error without first checking your loan count** —
   a blind retry opens a second loan against the same collateral budget.
3. **Errors with `code === 'SPECULAR_VERSION_UNKNOWN'` are retryable**, not
   fatal. The SDK is refusing to guess the marketplace version rather than risk
   under-approving a late repayment. Retry against a healthy RPC.
4. **Staleness errors ("serving state BEHIND…", "behind wall clock") are
   retryable.** They mean your RPC load-balanced onto a lagging replica or the
   chain reorged. If you deliberately pin an archive/lagging node, set
   `sdk.stalenessCheck = false` — and accept that you are then responsible for
   approval sizing.
5. **`StateManager` getters now throw `SPECULAR_STATE_STALE`** rather than
   quietly returning an expired credit limit. Treat it as "unknown", not "zero".
6. **Late loans cost more every second.** Approval sizing is exact only at the
   block it was computed on. Keep the preview→send window short; the SDK covers
   600 s of accrual and re-prices beyond that, but each re-price costs a tx.
7. **One wallet, one SDK instance.** The instance serializes its own writes. Two
   `SpecularQuickstart` instances on the same private key will still collide on
   the nonce — use `NonceCounter` (`src/sdk/nonce.js`) if you genuinely need
   parallel bursts from one key.
8. **`tx.wait()` confirms at 1 block.** On a chain with real reorg depth,
   re-verify loan state after settlement; do not treat a receipt as final.
9. **Event listeners do not replay across a restart.** `EventListener` backfills
   across a *reconnect* only. Persist your own last-processed block and replay
   with `queryPastEvents()` on boot. Watch `lastBackfillIncomplete` — it means a
   window could not be read and will be retried on the next reconnect.
10. **`supply()` can be refused before broadcasting** with "Top-up would forfeit
    in-flight interest" (V6.1). Call `canTopUp(agentId)` first, or open a fresh
    position from another address.
11. **Registered agents can be deactivated.** V6.1 `requestLoan` reverts
    `Agent deactivated`; repay stays open by design. Handle the borrow-side
    refusal as terminal, not transient.
12. **Set `sdk.receiptTimeoutMs` to your own tolerance** (default 180 s). It is
    the only thing standing between your agent and an indefinite hang when an
    RPC stops serving receipts.

---

## 6. Test inventory

New harness, all under `test/sdk-robustness/` (archived alongside this report as
`sdk-robustness-harness.tar.gz`):

| File | Tests | Covers |
|------|-------|--------|
| `helpers/faultProvider.js` | — | fault-injecting EIP-1193 transport + rule kit (429/500/timeout, stale reads, swallowed receipts, lost send responses, canned calls/reverts) |
| `helpers/stack.js` | — | local V6.1 deployment with arc-mainnet levers, `makeSdk`, V6.0-ABI builder, reputation ladder |
| `helpers/wallets.js` | — | real `ethers.Wallet` signers over the faulty provider |
| `00-harness-smoke.test.js` | 2 | harness self-check |
| `01-rpc-adversity.test.js` | 11 | 429/500/timeout, staleness, inconsistent replicas, dropped connection, lost receipt, no double-submit, reorg |
| `02-tx-safety.test.js` | 6 | nonce under concurrency, gas-estimate failure, revert-after-estimate, underpriced send, terminal reverts |
| `03-exact-approval.test.js` | 13 | the §2 audit table |
| `04-v61-capability.test.js` | 10 | capability detection, preview race, process death between approve and repay, failing revoke, `canTopUp` |
| `05-state-event.test.js` | 10 | StateManager TTL / stale-on-error / reorg; EventListener backfill failure, dedup, watchdog |
| `06-hostile-input.test.js` | 13 | malformed addresses/amounts/durations/agentIds/metadata, CWD + env config shadowing |
| `python/test_python_robustness.py` | 27 | the Python equivalents of all of the above |

**65 new JS tests, all passing.** Python suites: `python/tests` **21 passing**,
`test/sdk-robustness/python` **27 passing** (run with
`<venv>/bin/python -m unittest discover -s <dir>`; install deps with
`pip install -r python/requirements.txt` into a venv — the system Python is
PEP-668 managed).

Type surface: `npm run test:types` passes (`BorrowResult.tx` and `repay()` are
now nullable — see §5.1/5.2).

---

## 7. Root suite totals

Run in the worktree with `npx hardhat test`:

| | Baseline (`5fe56c4`, before changes) | After |
|---|---|---|
| passing | 655 | **682** |
| pending | 5 | **5** |
| failing | 0 | **2** |

The 2 failures are **`test/api/tx-builder.test.js`** and
**`test/api/tx-builder-stress.test.js`**, both failing in their `before all`
hook with *"API server did not start within 15000ms"*. These are **pre-existing
and environmental**, not caused by this work — verified by stashing every `src/`
and `python/` change and re-running them, where they fail identically. The test
spawns `src/api/MultiNetworkAPI.js`, which probes the Arc/Base/Arbitrum RPCs at
boot; started by hand it takes ~7 s but exceeds the hook's 15 s budget when the
network is slow. They passed in one earlier baseline run and have failed in
every run since, including on pristine source. Recommend raising that hook's
timeout (or stubbing the RPC probes) independently of this report.

Excluding those two suites' ~39 tests, which never got to run: **682 passing,
0 failing**, of which **65 are the new robustness tests**.

---

## Appendix A — client diffs (port these)

The complete patch, including the test-file adjustments in Appendix B, is saved
next to this report as **`sdk-robustness-2026-09.patch`** (apply with
`git apply`). The new harness is in **`sdk-robustness-harness.tar.gz`**
(extract at the repo root — it unpacks to `test/sdk-robustness/`).

### A.1 `src/sdk/SpecularQuickstart.js`

Changes by area:

- **constructor** — adds `receiptTimeoutMs = 180000` (F-R8) and `_maxSeenBlock` (F-R5).
- **new statics** — `MAX_BLOCK_LAG_SECONDS`, `_toBaseUnits` (F-R9), `_toAgentId`
  (F-R16), `MAX_METADATA_URI_BYTES` / `_assertMetadataUri` (F-R17),
  `_isRealRevert`, `_retryTransient`, `ERC20_INSUFFICIENT_ALLOWANCE` /
  `isAllowanceShortfall` (F-R3), `_isInconclusive` (F-R6).
- **new instance methods** — `_serialize` (F-R10), `_noteBlock`, `_wait` (F-R8),
  `_assertChainNotBehind` (F-R5), `_withApprovalCleanup` (F-R4),
  `_codeHasSelector` (F-R1), `_loanCount`, `_reconcileNewLoan`, `_loanSettled` (F-R6),
  `_revokeApprovalInner`.
- **restructured** — `onboard` → `_onboardInner`, `borrow` → `_borrowInner`,
  `repay` → `_repayInner`, `supply` → `_supplyInner`, each wrapped in
  `_serialize` (+ `_withApprovalCleanup` for the USDC-pulling ones). Internal
  callers use the `*Inner` variants so a nested call cannot deadlock on the queue.
- **`marketplaceVersion`** — bytecode probe; a transient failure throws
  `SPECULAR_VERSION_UNKNOWN` instead of caching `'V6'`.
- **`previewRepayment`** — retries transients; falls back only when the selector
  is genuinely absent from the deployed bytecode.
- **`_approveExact`** — tightens an over-large allowance (F-R15); marks
  `_approvedThisOp` before waiting so cleanup runs even if `wait()` dies.
- **`repay`'s bump path** — re-prices from chain instead of guessing
  `approve + preview.interest`.

```diff
@@ constructor @@
+        // [ROBUSTNESS F-R8] Bound every receipt wait. ethers' `tx.wait()` with no
+        // timeout blocks FOREVER when the RPC stops returning receipts — an
+        // unattended agent simply stops. Set to 0 to restore unbounded waiting.
+        this.receiptTimeoutMs = 180000;
+        // [ROBUSTNESS F-R5] Highest block this instance has observed. Used to
+        // detect an RPC that load-balanced onto a lagging replica (or a reorg).
+        this._maxSeenBlock = undefined;

@@ capability detection @@
-    async marketplaceVersion() {
-        if (this._mpVersion === undefined) {
-            try {
-                this._mpVersion = String(await this.marketplace.VERSION());
-            } catch (e) {
-                this._mpVersion = 'V6';
-            }
-        }
-        return this._mpVersion;
-    }
+    static _isRealRevert(e) {
+        return !!(e && e.code === 'CALL_EXCEPTION' && ((e.data && e.data !== '0x') || e.reason));
+    }
+
+    static async _retryTransient(fn, { attempts = 3, delayMs = 400 } = {}) {
+        let last;
+        for (let i = 0; i < attempts; i++) {
+            try { return await fn(); }
+            catch (e) {
+                last = e;
+                if (SpecularQuickstart._isRealRevert(e) || e instanceof TypeError || e.code === 'BAD_DATA') throw e;
+                if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
+            }
+        }
+        throw last;
+    }
+
+    /** Is `name` actually deployed? Answered from eth_getCode, not from a failing call. */
+    async _codeHasSelector(name) {
+        let frag;
+        try { frag = this.marketplace.interface.getFunction(name); } catch (_) { return false; }
+        if (!frag) return false;
+        if (this._mpCode === undefined) {
+            const code = await SpecularQuickstart._retryTransient(
+                () => this.wallet.provider.getCode(this.addresses.marketplace));
+            if (!code || code === '0x') {
+                throw new Error(
+                    `SpecularQuickstart: no contract code at marketplace ${this.addresses.marketplace} ` +
+                    '(wrong address, wrong network, or an RPC serving an empty view).');
+            }
+            this._mpCode = code.toLowerCase();
+        }
+        return this._mpCode.includes(frag.selector.slice(2).toLowerCase());
+    }
+
+    async marketplaceVersion() {
+        if (this._mpVersion !== undefined) return this._mpVersion;
+        let present;
+        try {
+            present = await this._codeHasSelector('VERSION');
+        } catch (e) {
+            const err = new Error(
+                `SpecularQuickstart: could not determine the marketplace version at ${this.addresses.marketplace} ` +
+                `(${e.shortMessage || e.message}). Refusing to guess — guessing "V6" would under-approve a late ` +
+                'repayment on a V6.1 deployment and the repay would revert. Retry against a healthy RPC.');
+            err.code = 'SPECULAR_VERSION_UNKNOWN';
+            err.cause = e;
+            throw err;
+        }
+        if (!present) { this._mpVersion = 'V6'; return this._mpVersion; }
+        const v = await SpecularQuickstart._retryTransient(() => this.marketplace.VERSION());
+        this._mpVersion = String(v);
+        return this._mpVersion;
+    }

@@ previewRepayment fallback @@
-                if (/Loan not active/i.test(e.message || '') || (e.reason && /Loan not active/i.test(e.reason))) throw e;
+                let deployed = true;
+                try { deployed = await this._codeHasSelector('previewRepayment'); } catch (_) { deployed = true; }
+                if (deployed) throw e;

@@ allowance-shortfall detection @@
+    static ERC20_INSUFFICIENT_ALLOWANCE = '0xfb8f41b2';
+    static isAllowanceShortfall(e) {
+        if (!e) return false;
+        const msg = `${e.message || ''} ${e.shortMessage || ''} ${e.reason || ''}`;
+        if (/allowance|exceeds|transfer amount/i.test(msg)) return true;
+        const candidates = [e.data, e.info && e.info.error && e.info.error.data,
+                            e.error && e.error.data, e.revert && e.revert.data];
+        for (const d of candidates) {
+            if (typeof d === 'string' && d.toLowerCase().startsWith(SpecularQuickstart.ERC20_INSUFFICIENT_ALLOWANCE)) return true;
+        }
+        return false;
+    }
-                if (!buffered && /allowance|exceeds|transfer amount/i.test(msg)) {
+                if (!buffered && SpecularQuickstart.isAllowanceShortfall(e)) {
-                if (!bumped && /allowance|exceeds|transfer amount/i.test(msg)) {
+                if (!bumped && SpecularQuickstart.isAllowanceShortfall(e)) {

@@ staleness guard @@
+    static get MAX_BLOCK_LAG_SECONDS() { return 600; }
+    _noteBlock(n) {
+        const b = Number(n);
+        if (!Number.isFinite(b)) return;
+        if (this._maxSeenBlock === undefined || b > this._maxSeenBlock) this._maxSeenBlock = b;
+    }
+    async _wait(tx) {
+        const ms = this.receiptTimeoutMs;
+        const receipt = ms ? await tx.wait(1, ms) : await tx.wait();
+        if (receipt) this._noteBlock(receipt.blockNumber);
+        return receipt;
+    }
+    async _assertChainNotBehind(ctx = 'SpecularQuickstart') {
+        if (this.stalenessCheck === false) return null;
+        const p = this.wallet && this.wallet.provider;
+        if (!p || typeof p.getBlockNumber !== 'function') return null;
+        const head = Number(await SpecularQuickstart._retryTransient(() => p.getBlockNumber()));
+        if (this._maxSeenBlock !== undefined && head < this._maxSeenBlock) {
+            throw new Error(
+                `${ctx}: the RPC is serving state BEHIND what this session already observed ` +
+                `(head ${head} < block ${this._maxSeenBlock} seen earlier). Either it load-balanced onto a lagging ` +
+                'replica or the chain reorged. Refusing to act on stale state — retry, or set ' +
+                '`sdk.stalenessCheck = false` to override.');
+        }
+        this._noteBlock(head);
+        const maxLag = this.maxBlockLagSeconds === undefined
+            ? SpecularQuickstart.MAX_BLOCK_LAG_SECONDS : this.maxBlockLagSeconds;
+        if (maxLag) {
+            const blk = await SpecularQuickstart._retryTransient(() => p.getBlock(head)).catch(() => null);
+            if (blk && blk.timestamp) {
+                const lag = Math.floor(Date.now() / 1000) - Number(blk.timestamp);
+                if (lag > maxLag) {
+                    throw new Error(
+                        `${ctx}: RPC head block ${head} is ${lag}s behind wall clock (max ${maxLag}s) — this endpoint ` +
+                        'is serving stale state. Refusing to size an approval or a loan from it; retry against a ' +
+                        'healthy RPC, or set `sdk.maxBlockLagSeconds = 0` to override.');
+                }
+            }
+        }
+        return head;
+    }

@@ approval cleanup @@
+    async _withApprovalCleanup(fn) {
+        this._approvedThisOp = false;
+        try { return await fn(); }
+        catch (e) {
+            if (this._approvedThisOp) {
+                try { await this._revokeApprovalInner(); } catch (_) { /* residual stays bounded */ }
+            }
+            throw e;
+        } finally { this._approvedThisOp = false; }
+    }

@@ write serialization @@
+    async _serialize(fn) {
+        const prev = this._txQueue || Promise.resolve();
+        let release;
+        this._txQueue = new Promise((r) => { release = r; });
+        try { await prev; } catch (_) { /* a predecessor's failure must not block us */ }
+        try { return await fn(); } finally { release(); }
+    }

@@ exact approval, both directions @@
-        if (current >= amount) return null;
+        if (current === amount) return null;
+        if (current > amount) {
+            const tx0 = await this.usdc.approve(this.addresses.marketplace, amount);
+            this._approvedThisOp = true;
+            await this._wait(tx0);
+            return tx0.hash;
+        }
         const tx = await this.usdc.approve(this.addresses.marketplace, amount);
-        await tx.wait();
+        this._approvedThisOp = true;
+        await this._wait(tx);

@@ lost-send reconciliation @@
+    async _loanCount() {
+        let i = 0;
+        while (true) {
+            try { await this.marketplace.agentLoans(this.wallet.address, i); } catch (_) { return i; }
+            i++;
+            if (i > 10000) return i;
+        }
+    }
+    async _reconcileNewLoan(countBefore, attempts = 10, delayMs = 1000) {
+        for (let i = 0; i < attempts; i++) {
+            let n;
+            try { n = await this._loanCount(); } catch (_) { n = null; }
+            if (n !== null && n > countBefore) {
+                try { return Number(await this.marketplace.agentLoans(this.wallet.address, n - 1)); } catch (_) {}
+            }
+            await new Promise(r => setTimeout(r, delayMs));
+        }
+        return null;
+    }
+    async _loanSettled(loanId, attempts = 10, delayMs = 1000) {
+        for (let i = 0; i < attempts; i++) {
+            try {
+                const st = Number((await this.marketplace.loans(loanId)).state);
+                if (st === 2 || st === 3) return st;
+            } catch (_) {}
+            await new Promise(r => setTimeout(r, delayMs));
+        }
+        return null;
+    }
+    static _isInconclusive(e) {
+        if (!e) return false;
+        if (SpecularQuickstart._isRealRevert(e)) return false;
+        const code = e.code;
+        return code === 'TIMEOUT' || code === 'NETWORK_ERROR' || code === 'SERVER_ERROR' ||
+               code === 'UNKNOWN_ERROR' || code === 'CALL_EXCEPTION' || code === 'REPLACEMENT_UNDERPRICED' ||
+               /timeout|socket|ECONN|coalesce|network/i.test(`${e.message || ''} ${e.shortMessage || ''}`);
+    }
```

### A.2 `src/StateManager.js`

```diff
@@ constructor @@
+        // [F-R12] Per-key refresh errors. A failed refresh used to be swallowed,
+        // leaving the PREVIOUS value in `cache` — and the getters returned it even
+        // though its TTL had expired and nothing had been re-read.
+        this.errors = {};
+        // [F-R13] Reorg awareness. Nothing here was tied to a block.
+        this.headCheckIntervalMs = 5000;
+        this._maxSeenBlock = null;
+        this._lastHeadCheck = 0;
+    }
+
+    get _provider() {
+        const p = this.agent && (this.agent.provider || (this.agent.wallet && this.agent.wallet.provider));
+        return p && typeof p.getBlockNumber === 'function' ? p : null;
+    }
+
+    async checkForReorg() {
+        const p = this._provider;
+        if (!p) return false;
+        const now = Date.now();
+        if (now - this._lastHeadCheck < this.headCheckIntervalMs) return false;
+        this._lastHeadCheck = now;
+        let head;
+        try { head = Number(await p.getBlockNumber()); } catch (_) { return false; }
+        if (!Number.isFinite(head)) return false;
+        if (this._maxSeenBlock !== null && head < this._maxSeenBlock) {
+            const from = this._maxSeenBlock;
+            this._maxSeenBlock = head;
+            this.invalidateCache();
+            console.warn(`StateManager: chain head went backwards (${from} -> ${head}); cache dropped.`);
+            return true;
+        }
+        if (this._maxSeenBlock === null || head > this._maxSeenBlock) this._maxSeenBlock = head;
+        return false;
     }

@@ _stamp / _serve @@
-        for (const k of keys) this.timestamps[k] = now;
+        for (const k of keys) { this.timestamps[k] = now; delete this.errors[k]; }
+    }
+
+    /** [F-R12] Never serve expired data as if it were current. */
+    _serve(key) {
+        if (this.isCacheValid(key)) return this.cache[key];
+        const err = this.errors[key];
+        if (err) {
+            const e = new Error(
+                `StateManager: ${key} could not be refreshed (${err.message}) and the cached value is stale ` +
+                '— refusing to return it. Retry, or read the contract directly.');
+            e.code = 'SPECULAR_STATE_STALE';
+            e.cause = err;
+            throw e;
+        }
+        return this.cache[key];
     }

@@ refreshReputation / refreshAgentInfo / refreshLoans @@
-            if (!error.message.includes('not initialized')) {
-                console.error('Failed to refresh reputation:', error.message);
-            }
+            // "not initialized" is a legitimate answer for a fresh agent, not a
+            // read failure — everything else is recorded so the getters refuse
+            // to serve the stale previous value. (F-R12)
+            const benign = error.message.includes('not initialized');
+            for (const k of ['reputation', 'creditLimit', 'collateralRequirement']) {
+                this.errors[k] = benign ? undefined : error;
+                if (benign) delete this.errors[k];
+            }
+            if (!benign) console.error('Failed to refresh reputation:', error.message);
+            // (analogous changes in refreshAgentInfo with 'not registered', and
+            //  refreshLoans which records every error)

@@ every getter @@
 async getReputation(forceRefresh = false) {
+        await this.checkForReorg();
         ...
-        return this.cache.reputation;
+        return this._serve('reputation');
 }
 // identical shape for getAgentInfo / getLoans / getCreditLimit
```

### A.3 `src/EventListener.js`

```diff
@@ _reconnect @@
-                await this._backfill(from + 1, head == null ? 'latest' : head);
-                if (head != null) this._lastSeenBlock = head;
+                // [F-R14] Only advance the marker if the backfill actually
+                // SUCCEEDED. A queryFilter that threw — the same RPC outage that
+                // caused the reconnect — was swallowed and the marker advanced
+                // anyway, losing the missed window permanently and silently.
+                const complete = await this._backfill(from + 1, head == null ? 'latest' : head);
+                if (head != null && complete) this._lastSeenBlock = head;
+                else if (!complete) {
+                    this.lastBackfillIncomplete = true;
+                    console.warn(
+                        `Event listener: backfill of blocks ${from + 1}..${head == null ? 'latest' : head} was ` +
+                        'incomplete (RPC errors); keeping the marker so the next reconnect retries the window.');
+                }

@@ _backfill @@
+    /** @returns {Promise<boolean>} true only if every configured query succeeded. */
     async _backfill(fromBlock, toBlock = 'latest') {
+        let complete = true;
         ...
-            try { filter = contract.filters[spec.event](); } catch (_) { continue; }
+            try { filter = contract.filters[spec.event](); } catch (_) { complete = false; continue; }
-            try { events = await contract.queryFilter(filter, fromBlock, toBlock); } catch (_) { continue; }
+            try { events = await contract.queryFilter(filter, fromBlock, toBlock); }
+            catch (_) { complete = false; continue; }
         ...
+        return complete;
     }
```

### A.4 `python/specular/client.py`

Mirrors A.1. New: `arc-mainnet` config; class constants
`MAX_BLOCK_LAG_SECONDS`, `MAX_METADATA_URI_BYTES`,
`ERC20_INSUFFICIENT_ALLOWANCE`; statics `_selector`, `_to_base_units`,
`_to_agent_id`, `_assert_duration_days`, `_assert_metadata_uri`,
`_is_allowance_shortfall`; instance `_write_lock` (`threading.RLock`),
`_note_block`, `_assert_chain_not_behind`, `_with_approval_cleanup`,
`_code_has_selector`, `_revoke_approval_inner`; `onboard`/`borrow`/`repay`/
`supply` split into locked public + `_inner`; `onboard` gains the registry
propagation poll and the `createAgentPool` retry; `_approve_exact` tightens an
over-large allowance; `repay` gains the allowance bump.

```diff
+        # [ROBUSTNESS F-R19] Arc MAINNET (chainId 5042) — the network the protocol
+        # actually launched on.
+        "arc-mainnet": {
+            "addresses_path": REPO_ROOT / "src" / "config" / "arc-mainnet-addresses.json",
+            "explorer_tx": "https://explorer.arc.io/tx/",
+            "default_rpc": "https://rpc.mainnet.arc.io",
+        },

     def borrow(self, amount: float, duration_days: int) -> dict[str, Any]:
-        if duration_days < 7 or duration_days > 365:
-            raise ValueError("duration_days must be 7-365")
-        self.onboard()  # idempotent
-        amt_units = _usdc_units(amount)
+        # [F-R18] `duration_days < 7 or duration_days > 365` is False for NaN in
+        # BOTH directions, so the old check passed NaN straight to the chain.
+        self._assert_duration_days(duration_days, "SpecularClient.borrow")
+        amt_units = self._to_base_units(amount, "SpecularClient.borrow")
+        with self._write_lock:
+            self._onboard_inner()  # idempotent
+            return self._with_approval_cleanup(lambda: self._borrow_inner(amt_units, duration_days))

     def marketplace_version(self) -> str:
-        cached = getattr(self, "_mp_version", None)
-        if cached is None:
-            try:
-                cached = str(self.marketplace.functions.VERSION().call())
-            except Exception:
-                cached = "V6"
-            self._mp_version = cached
-        return cached
+        cached = getattr(self, "_mp_version", None)
+        if cached is not None:
+            return cached
+        try:
+            present = self._code_has_selector("VERSION()")
+        except Exception as e:
+            raise RuntimeError(
+                f"SpecularClient: could not determine the marketplace version at {self.marketplace_addr} ({e}). "
+                "Refusing to guess — guessing 'V6' would under-approve a late repayment on a V6.1 deployment. "
+                "Retry against a healthy RPC.") from e
+        if not present:
+            self._mp_version = "V6"
+            return self._mp_version
+        self._mp_version = str(self.marketplace.functions.VERSION().call())
+        return self._mp_version

     # preview_repayment fallback
-            except Exception as e:  # a real revert must surface; a missing selector falls back
-                if "Loan not active" in str(e):
-                    raise
+            except Exception as e:
+                try:
+                    deployed = self._code_has_selector("previewRepayment(uint256)")
+                except Exception:
+                    deployed = True
+                if deployed:
+                    raise e

     # _approve_exact
-        if current >= amount:
-            return None
+        if current == amount:
+            return None
+        if current > amount:
+            self._approved_this_op = True
+            return self._send(self.usdc.functions.approve(self.marketplace_addr, amount))
+        self._approved_this_op = True
```

(Full text of every new Python method is in `sdk-robustness-2026-09.patch`.)

---

## Appendix B — test-file adjustments to existing suites

Four existing tests asserted the *old* behaviour and were updated deliberately;
all are in the patch.

| File | Change | Why |
|------|--------|-----|
| `test/sdk/quickstart-rpc-staleness.test.js` | `sdk.onboard = …` → `sdk._onboardInner = …`; `_approveExact skips when allowance already covers` split into an *exact*-match skip plus a new F-R15 tightening test | `borrow()` now calls the unlocked `_onboardInner` (the public `onboard` takes the write lock); an over-large allowance is now tightened rather than carried forward |
| `test/sdk/quickstart-collateral-fallback.test.js` | same `_onboardInner` stub rename | same |
| `python/tests/test_client.py` | `bare_client()` gains a `w3` whose `get_code` returns fake bytecode containing (or not containing) the V6.1 selectors, plus a fresh block head; `test_skips_when_covered` → exact-match + tightening; `_revoke_approval_inner` aliased in the V6.1 fixture | capability detection now probes bytecode instead of catching a failing call; the staleness guard reads a head |
| `src/sdk/__types-test__/sdk-types.test-d.ts` | `loan.tx` typed `string \| null`, `loan.reconciled` added | F-R6 return shape |

---

*Generated with Claude Code. All findings carry a test that failed before the
fix and passes after it, under `test/sdk-robustness/`.*
