# AgentLiquidityMarketplaceV6 — V6.1 contract testing round (2026-09-20 / completed 2026-09-21)

**Scope:** the V6.1 diff vs tag `arc-mainnet-v6-deployed-2026-09-19` (`git diff arc-mainnet-v6-deployed-2026-09-19 -- contracts/core/AgentLiquidityMarketplaceV6.sol`, 378+/39−):
F-01 (`ownerOf` resolution in `repayLoan`/`liquidateLoan`, holder-may-repay, collateral → `loan.borrower`), F-02 (pending
tranche: `supplyLiquidity` fold/merge/refuse, `canTopUp`, `qualifiedAmountAt`, LIFO `withdrawLiquidity`, `_shrinkPendingProRata`,
`activeLoanIds`), F-03 (`_interestDue` max(duration, elapsed) capped at +30d, `previewRepayment`, lateness records), F-05
(`_socializeInterestLoss`, `_pruneEmptyLenders`), F-07 (`isAgentActive` gates). Branch `arc-mainnet-launch`. Nothing broadcast.

**Every number below was produced by a command run on 2026-09-20/21; the command output tail is pasted with each section.**
Logs live in the session scratchpad (`npm-test.log`, `forge-test.log`, `foundry-deep2.log`, `gas.log`, `coverage-before.log`,
`coverage-after.log`, `mutation.log`); the mutation runner and its machine-readable results are committed
(`scripts/mutation/mutate-v61.js`, `forensics/output/testing-2026-09-20/mutation-results.json`).

**Headline:** 1 low-severity contract bug found and fixed (`canTopUp` view could say `true` for a top-up that would revert — §6)
and 1 test-harness bug found and fixed (the Foundry handler's deactivation op never fired — §2); no funds-at-risk finding.
Five angles: coverage → new unit tests, Foundry stateful invariants (768k handler calls), mutation (17 mutants, all killed),
2,400-op hardhat property fuzz, and a V6.0-vs-V6.1 gas comparison under isolated per-call metering.

| Angle | Result |
|---|---|
| Coverage (V6 marketplace) | stmts 97.21 → **97.83** · branch 86.33 → **91.01** · funcs 97.78 → **97.78** · lines 98.09 → **98.56** (both columns re-measured this round; all V6.1 lines + branches covered; the only uncovered function is the legacy `_countActiveLoansFromArray`) |
| Foundry invariants (new `V61Invariants.t.sol`) | **6/6 pass** at 256 runs × 500 depth = **128,000 calls per invariant, 768,000 total, 0 reverts**, 36.3 s; 7 ghost-violation counters, 0 violations |
| Mutation (17 mutants on the V6.1 diff) | **17/17 killed**, 0 survived; 8 of them additionally killed by the Foundry invariants |
| Property fuzz (new `V61PropertyFuzz.test.js`) | 2,400 attempted / **1,641 executed** ops (3 lenders × 2 agents, time travel, NFT transfers, deactivation), invariants (a)–(l) asserted after every op, **0 violations** — this is the harness that found the `canTopUp` bug |
| Gas (`V61Gas.t.sol`, `--isolate`) | every V6.1 path within budget; worst case `liquidateLoan` @ 50 lenders all with pending tranches = 998,361 (was 544,190); `repayLoan` @ 50 lenders 1,852,743 (was 1,681,007) |
| Full suite | `npm test`: **671 passing / 5 pending / 0 failing** (baseline 655 / 5 / 0) on the first run of the day. Later re-runs show **632 / 5 / 2 failing** — both failures are the network-dependent `test/api/tx-builder*` suites blocked by an Arc-testnet public-RPC **HTTP 429**, see §9. Suite minus `test/api/`: **632 / 5 / 0**, reproducible. `forge test`: **13 passed, 0 failed, 0 skipped across 3 suites** |

---

## 1. Coverage (solidity-coverage, `npx hardhat coverage`, full suite)

`AgentLiquidityMarketplaceV6.sol`, before → after. **Both columns were measured in this round**: "before" is the same suite with
the two files this round added (`test/unit/V61TrancheEdgeCases.test.js`, `test/unit/V61PropertyFuzz.test.js`) moved out of the
tree; "after" is the suite as it now stands. Counters are read from `coverage/lcov.info`.

| | Stmts | Branch | Funcs | Lines |
|---|---|---|---|---|
| before | 97.21 % | 86.33 % (BRH 240/278) | 97.78 % (FNH 44/45) | 98.09 % (LH 410/418) |
| **after** | **97.83 %** | **91.01 %** (BRH 253/278) | **97.78 %** (FNH 44/45) | **98.56 %** (LH 412/418) |

```
$ npx hardhat coverage            # before (V61 test files moved aside)
  AgentLiquidityMarketplaceV6.sol       |    97.21 |    86.33 |    97.78 |    98.09 |... 2,1423,1427 |

$ npx hardhat coverage            # after
File                                    |  % Stmts | % Branch |  % Funcs |  % Lines |Uncovered Lines |
  AgentLiquidityMarketplaceV6.sol       |    97.83 |    91.01 |    97.78 |    98.56 |... 2,1423,1427 |
All files                               |    87.14 |    67.14 |    81.96 |    86.37 |                |
```

Delta, straight out of the two lcov files (line numbers are the **current, post-fix** file):

- **13 branches** newly covered, at lines **370** (`_toU128` overflow guard), **382** (the three `canTopUp` short-circuit arms),
  **512** (`_shrinkPendingProRata` delete-when-zero), **536 / 538 / 541 / 549** (`_socializeInterestLoss`: `totalInterest == 0`,
  the `loss > Σinterest` cap, the `earnedInterest == 0` skip, the `take < remainder` remainder loop), **591 / 604 / 605**
  (`_socializeLoss` interest-only-lender skips in both passes), **966** (`liquidateLoan` `interestReduced == 0`).
- **2 lines** newly covered: **513–514** (the `delete pendingTranche` + event inside `_shrinkPendingProRata`).
- No branch or line that was covered before became uncovered.

Per changed function:

| V6.1 function / path | Before | After | Test added |
|---|---|---|---|
| `supplyLiquidity` cases (a)(b)(c)(d)(e) | all 5 hit | all 5 hit | — (F-02 regression suite) |
| `_activeLoanStartedIn` boundary `s < hi` at `s == pending.ts` | not pinned | pinned | `V61TrancheEdgeCases` "same-block top-up + loan" |
| `_toU128` overflow branch (L370) | **uncovered** | covered | "`_toU128` guard" |
| `canTopUp` three short-circuits (L382: `p.amount==0`, `activeLoanCount==0`, `pt.amount==0`) | 3 of the `\|\|` arms uncovered | covered | "canTopUp short-circuits" |
| `qualifiedAmountAt` `<=` boundaries (both tranches at `ts == loan.start`) | pending-tranche boundary not pinned | pinned | "same-block top-up + loan" |
| `_distributeInterest` with pending tranches | covered | covered (+ exact per-lender share property (c) in fuzz + invariants) | — |
| `withdrawLiquidity` LIFO: partial trim / full delete of pending | covered | covered (+ full-withdraw property (d)) | "withdraw larger than the pending tranche" |
| `_shrinkPendingProRata`: delete-when-zero branch (L512–514) | **uncovered lines** | covered | "`_shrinkPendingProRata` deletes the pending tranche" |
| `_shrinkPendingProRata`: clamp `newPending > amountBefore − share` (L511) | uncovered | **still uncovered — unreachable** (see §7) | — |
| `_socializeLoss` `p.amount == 0` skips (L591, L605) and `take < remainder` (L604) | uncovered | covered | "`_socializeLoss` skips interest-only lenders in both passes" |
| `_socializeInterestLoss`: `totalInterest == 0` (L536), cap `loss > Σinterest` (L538), `earnedInterest == 0` skip (L541), remainder `take < remainder` (L549) | 4 branches uncovered | covered | 4 `_socializeInterestLoss` tests |
| `liquidateLoan` `interestReduced == 0` branch (L966) | uncovered | covered | "pool with NO lenders" |
| `repayLoan` ownerOf path: borrower / holder / stranger | covered (F-01 suite) | covered + fuzz property (j) | — |
| `_interestDue`: `elapsed == duration`, `elapsed == duration + 30d`, far beyond | boundaries not pinned | pinned | "repay exactly at endTime … exactly at endTime + 30d" |
| `previewRepayment` non-ACTIVE revert | covered | covered | "previewRepayment reverts for a loan that is not ACTIVE" |
| `_removeActiveLoanId` via `liquidateLoan` | covered | covered + invariant (f) | "activeLoanIds is maintained by liquidateLoan too" |
| `requestLoan` / `createAgentPool` `isAgentActive` gate | covered (F-07 suite) | covered + fuzz property (l) | — |

Remaining uncovered in the file after this round, read exhaustively from `lcov.info`:

- **Lines 1418, 1419, 1421, 1422, 1423, 1427** — the whole body of `_countActiveLoansFromArray`, the legacy O(N) counter kept only
  as a test oracle. It is the single uncovered function (`FNDA:0,_countActiveLoansFromArray`, FNH 44/45).
- **25 uncovered branches**, none of them V6.1 changes: the `onlyOwner` / `whenNotPaused` / `nonReentrant` reverse-branches the
  instrumenter attributes to the modifier line (233 `renounceOwnership`, 240 `createAgentPool`, 414 `withdrawLiquidity`,
  934 `liquidateLoan`, 1089 `claimInterest`, 1121 `withdrawFees`); defensive `require` reverse-branches on registration and
  migration helpers (242, 481, 626, 629, 698, 1097, 1173, 1174, 1217, 1218, 1228, 1270, 1351, 1399); the pool-active filters in
  the two list views (1068, 1074); the dead `_shrinkPendingProRata` clamp (511, §7); and 1422 in the legacy function above.

## 2. Invariants — `test/foundry/V61Invariants.t.sol` (new)

Setup: 3 lenders × 2 agents; agent 1 pumped to the 0 %-collateral tier so defaults are lossy, agent 2 at score 0 (100 % collateral,
exercises the collateral-return path). **11 handler ops**: `supply` (records whether `canTopUp` predicted the outcome; warps +1 s
before the tx so the view and the tx are evaluated at *different* timestamps, as on a real chain), `withdraw`, `withdrawAll`,
`drainPrincipal` (every lender pulls all principal → pool backed only by unclaimed interest), `claim`, `requestLoan` (by the
current NFT holder, records deactivation refusals), `repayLoan` (4 timing modes: now / inside term / 1–30 d late / 31–90 d late;
3 payer modes: borrower / holder / stranger), `liquidateLoan`, `transferAgent` (NFT to/from an alt wallet), `toggleActive`
(registry deactivate/reactivate), `warpTime`.

**Harness bug found and fixed this round.** `toggleActive` read `registry.isAgentActive(holder)` *after* `vm.prank(owner)`, so the
read consumed the prank and `deactivateAgent`/`reactivateAgent` ran as the handler → `onlyOwner` revert → silently swallowed by
the `try/catch`. Every printed profile showed `deactivations 0 / borrow-blocked 0`: the F-07 path never fired in Foundry at all.
Fixed by reading first and pranking immediately before the write. After the fix the same campaign shows 9–11 deactivations and
9–22 blocked borrows per run, and mutant **M13** (deleting the `isAgentActive` gate on `requestLoan`) is now killed by the Foundry
invariants as well as by hardhat — which is how the fix was confirmed to be live rather than cosmetic.

| Invariant (checked after every call) | Requested as | Result (256 × 500) |
|---|---|---|
| `invariant_a_balance_identity`: `balance + Σ totalLoaned == Σ amount + Σ earnedInterest + fees + Σ active collateral`, plus the two exact identities it decomposes into (`totalLiquidity == Σ amount`, `avail + loaned == Σ amount + Σ interest`) and exact solvency `balance == Σ avail + fees + Σ collateral` | (a) | PASS, 128,000 calls, 0 reverts |
| `invariant_b_pending_within_position`: `pending.amount ≤ position.amount` ∀ (pool, lender); `pending.ts ≥ base.ts`; non-members hold nothing | (b) | PASS, 128,000 calls, 0 reverts |
| `invariant_f_activeLoanIds_consistent`: `activeLoanIds[agent]` == the set of ACTIVE loans, no duplicates, length == `activeLoanCount` ≤ 10 | — (F-02 bookkeeping) | PASS, 128,000 calls, 0 reverts |
| `invariant_g_holder_maps_back`: `addressToAgentId[ownerOf(id)] == id` (the F-01 premise) through transfers | — | PASS, 128,000 calls, 0 reverts |
| `invariant_h_outstanding_principal`: `outstandingPrincipal[agent] == Σ ACTIVE principal` (H-3, now agentId-keyed) | — | PASS, 128,000 calls, 0 reverts |
| `invariant_ghost_no_violations` — the 7 call-time counters below | (c)(d)(e)(i)(j)(k)(l) | PASS, 128,000 calls, 0 violations |

Ghost properties (7 counters, checked inside the handler at the call that can violate them):

| | Property | Violations |
|---|---|---|
| (c) | on every repay, each lender's `earnedInterest` delta == `lenderInterest · qualifiedAmountAt(loan.start) / Σ qualifiedAmountAt`, and `fees` delta == platform fee + rounding dust | 0 |
| (d) | `withdrawLiquidity(position.amount)` never reverts when `availableLiquidity ≥ amount`, and leaves `amount == 0 && pending == 0` | 0 |
| (e) | `repayments[id].interestPaid == calculateInterest(P, rate, max(duration, min(elapsed, duration + 30 d)))`, `lateSeconds` exact, and `previewRepayment` agrees on all four outputs | 0 |
| (i) | `canTopUp` == ¬("Top-up would forfeit in-flight interest" revert), with the view read one second **before** the tx | 0 — and the check is live, not vacuous: mutant M17 (reverting the §6 fix) makes `invariant_ghost_no_violations` FAIL |
| (j) | borrower and current holder are never refused and never revert; a stranger is always refused with "Not the borrower"; collateral always lands on `loan.borrower`, principal + interest is pulled from the payer | 0 |
| (k) | liquidating an overdue ACTIVE loan never reverts (incl. after NFT transfer / deactivation); Σ principal falls by exactly `min(loss, Σ principal)` and Σ interest by exactly `min(loss − principalReduced, Σ interest)` | 0 |
| (l) | a registry-deactivated agent can never open a loan | 0 |

```
$ FOUNDRY_INVARIANT_RUNS=256 FOUNDRY_INVARIANT_DEPTH=500 forge test --match-path test/foundry/V61Invariants.t.sol -vv
[PASS] invariant_a_balance_identity() (runs: 256, calls: 128000, reverts: 0)
[PASS] invariant_b_pending_within_position() (runs: 256, calls: 128000, reverts: 0)
[PASS] invariant_f_activeLoanIds_consistent() (runs: 256, calls: 128000, reverts: 0)
[PASS] invariant_g_holder_maps_back() (runs: 256, calls: 128000, reverts: 0)
[PASS] invariant_ghost_no_violations() (runs: 256, calls: 128000, reverts: 0)
[PASS] invariant_h_outstanding_principal() (runs: 256, calls: 128000, reverts: 0)
Suite result: ok. 6 passed; 0 failed; 0 skipped; finished in 36.31s (138.71s CPU time)
```

**What the Foundry campaign does NOT reach** (honest gap; these are covered by the hardhat fuzz and the unit tests instead).
The `afterInvariant` profiles printed for the six final runs show, per run: 45 supplies but **0 case-(e) top-up refusals**, 6–13
liquidations of which 2–4 lossy but **0 with loss > Σ principal and 0 with interest socialized**, 10–24 loans, 4–12 repays, 1–8
late, 0–4 beyond-cap, 0–2 holder repays, 2–5 stranger refusals, 30–31 NFT transfers, 9–11 deactivations, 9–22 blocked borrows.
So properties (i) and the F-05 second pass are exercised in Foundry only in their *negative* direction; the positive cases come
from `V61PropertyFuzz` (supply.refused 6+0, lossOverPrincipal 3+2, interestSocialized 3+2 — §4) and from the `_socializeInterestLoss`
unit tests. Tightening the Foundry handler to force those two op classes is the obvious next improvement.

The pre-existing `V6Invariants.t.sol` (6 invariants) also passes unchanged at the default 32 × 64.

## 3. Mutation testing

Runner: **`scripts/mutation/mutate-v61.js` (committed, reproducible)**. Method as in commit `a3cd2df`: one mutant at a time —
patch `contracts/core/AgentLiquidityMarketplaceV6.sol` in place from an in-memory pristine copy, run the targeted subset
`test/unit/V61TrancheEdgeCases.test.js` + `test/unit/V61PropertyFuzz.test.js` (with `V61_FUZZ_OPS=150`) + the five
`test/audit-2026-09-fixes/F0{1,2,3,5,7}-fix.test.js` suites (52 tests) **and** `forge test --match-path
test/foundry/V61Invariants.t.sol` (32 × 64), restore, next. Every `find` anchor is asserted to occur exactly once in the pristine
source before the campaign starts; the runner verifies at the end that `git diff` on the target is byte-identical to the baseline.
Machine-readable output: `forensics/output/testing-2026-09-20/mutation-results.json`. ~56 s per mutant, 17 min total.

> The previous pass of this report claimed "27 mutants, all killed". No mutation artifacts existed on disk and the kill count was
> never filled in, so that campaign was treated as not completed and is **not** carried forward. The numbers below are from a
> fresh 17-mutant campaign run on 2026-09-21.

| # | Area | Mutation | hardhat subset | Foundry inv. | Verdict |
|---|---|---|---|---|---|
| M01 | F-02 `_activeLoanStartedIn` | half-open window becomes closed: `s < hi` → `s <= hi` | 50p/**2f** | 6p/0f | **killed** |
| M02 | F-02 `qualifiedAmountAt` | base tranche boundary `<=` → `<` (equal-timestamp lender loses its share) | 51p/**1f** | 6p/0f | **killed** |
| M03 | F-02 `qualifiedAmountAt` | pending tranche boundary `<=` → `<` | 50p/**2f** | 6p/0f | **killed** |
| M04 | F-02 `_socializeLoss` pass 1 | drop the `_shrinkPendingProRata` call (pending may exceed principal) | 47p/**5f** | 6p/0f | **killed** |
| M05 | F-02 `_socializeLoss` remainder pass | drop the `_shrinkPendingProRata` call in the remainder loop | 51p/**1f** | 6p/0f | **killed** |
| M06 | F-01 `repayLoan` | revert the `ownerOf` substitution: only the original borrower may repay | 48p/**4f** | 6p/0f | **killed** |
| M07 | F-01 `repayLoan` | reputation credited to the historical borrower instead of the NFT holder | 46p/**6f** | 5p/**1f** | **killed** |
| M08 | F-01 `liquidateLoan` | revert the `ownerOf` substitution: default recorded against `loan.borrower` | 49p/**3f** | 5p/**1f** | **killed** |
| M09 | F-03 `_interestDue` | remove the 30-day late-interest cap | 48p/**4f** | 5p/**1f** | **killed** |
| M10 | F-03 `_interestDue` | drop `max(duration, elapsed)`: a late loan is charged the nominal term only | 47p/**5f** | 5p/**1f** | **killed** |
| M11 | F-02 `withdrawLiquidity` LIFO | off-by-one: the pending tranche is trimmed one base unit short | 48p/**4f** | 4p/**2f** | **killed** |
| M12 | F-01 `repayLoan` | collateral returned to the current NFT holder instead of `loan.borrower` | 48p/**4f** | 5p/**1f** | **killed** |
| M13 | F-07 `requestLoan` | delete the `isAgentActive` gate on borrowing | 48p/**4f** | 5p/**1f** | **killed** |
| M14 | F-07 `createAgentPool` | delete the `isAgentActive` gate on pool creation | 50p/**2f** | 6p/0f | **killed** |
| M15 | F-05 `liquidateLoan` | skip `_socializeInterestLoss` (loss beyond principal leaves unbacked interest) | 44p/**7f** | 4p/**2f** | **killed** |
| M16 | F-05 `liquidateLoan` | skip `_pruneEmptyLenders` (wiped lenders keep their slot forever) | 46p/**6f** | 6p/0f | **killed** |
| M17 | 2026-09-20 fix — `canTopUp` | neutralize the fix: `block.timestamp + 1` → `block.timestamp` | 50p/**2f** | 6p/0f | **killed** |

```
$ node scripts/mutation/mutate-v61.js
M17 KILLED  [hh 50p/2f, forge 6p/0f] 57s — 2026-09-20 fix — canTopUp: neutralize the fix: inclusive bound `block.timestamp + 1` → `block.timestamp`
         first hardhat failure: [BUG 2026-09-20] canTopUp must see a loan that started in the LATEST block (view at T vs tx at T' > T)

17/17 killed, 0 survived. 8 additionally killed by the Foundry invariants. Source restored: yes (byte-identical)
```

**17/17 killed, 0 survived**, so no survivor-killing tests had to be added. Every mutant is killed by at least one deterministic
hardhat test; **8** (M07, M08, M09, M10, M11, M12, M13, M15) are additionally killed by the Foundry invariants — the desired
defence-in-depth, a regression that slips past a unit assertion still trips an invariant. No mutant produced a compile error, so
all 17 were semantically meaningful. The three cheapest killers were the property fuzz (first failure for 8 mutants), the
`_interestDue` boundary test (M09/M10) and the tranche edge cases (M01/M03/M11/M15/M16/M17).

## 4. Property fuzz — `test/unit/V61PropertyFuzz.test.js` (new)

Same style as `V6PropertyFuzz.test.js` (seeded mulberry32, invariants asserted after **every** successful op), extended with the
V6.1 op set and time travel: 3 lenders × 2 agents (agent 1 lossy tier, agent 2 100 % collateral), weighted ops `supply` (with the
`canTopUp` oracle check and fold/merge/refuse classification), `withdraw`, `withdrawAll` (property (d)), `drain`, `requestLoan`
(by the current holder, deactivation-aware), `repay` (timing 0/inside/≤30 d late/31–90 d late; payer borrower/holder/stranger;
exact interest, lateness, collateral routing and per-lender distribution checked), `liquidate` (exact principal/interest
reduction), `forceLoss` (drain → lend the unclaimed interest → overdue → liquidate: the F-05 loss > Σ principal scenario),
`claim` (asserts the only legitimate refusal is "Drain underflow" while the interest is out on loan), NFT `transfer`,
`deactivate/reactivate`, `time`.

| Run | Attempted | Executed | Invariants | Profile (executed ops) |
|---|---|---|---|---|
| seed 20260920 | 2,000 | 1,378 | (a)(b)(f)(g)(h) after every op + (c)(d)(e)(i)(j)(k)(l) at call time — **0 violations** | supply.base 304 · pendingCreate 42 · fold 12 · merge 8 · **refused (e) 6** · withdraw.partial 119 · **withdraw.all 52** · drain 69 · loan 154 · blockedInactive 151 · repay 86 (**late 62, beyondCap 36, byHolder 5**) · strangerRefused 45 · liquidate 79 (lossy 14, **lossOverPrincipal 3, interestSocialized 3**) · claim 47 · nft.transfer 75 · deactivate 19 / reactivate 14 |
| seed 137 | 400 | 263 | 0 violations | supply.base 58 · pendingCreate 5 · fold 1 · merge 2 · withdraw.partial 10 · withdraw.all 9 · drain 16 · loan 38 · blockedInactive 24 · repay 21 (late 16, beyondCap 10, byHolder 1) · strangerRefused 9 · liquidate 19 (lossy 8, **lossOverPrincipal 2, interestSocialized 2**) · claim 12 · nft.transfer 15 · deactivate 5 / reactivate 3 |

```
$ npm test   (excerpt)
  V6.1 property fuzz — tranches / late repay / holder repay / interest-loss socialization
      → seed-20260920: 1378/2000 ops executed; 2 loans left open
    ✔ 2000 random ops (seed 20260920): all V6.1 invariants hold after every op (11485ms)
      → seed-137: 263/400 ops executed; 3 loans left open
    ✔ different seed (137), 400 ops: invariants still hold (2085ms)
```

The test also asserts that each of 14 V6.1-specific paths fired at least once, so a future change that silently makes a path
unreachable fails the suite. Default op count is 2,000 (`V61_FUZZ_OPS` overrides; the mutation runner uses 150).

**What the fuzz found:** on its first full run, property (i) fired — `canTopUp` returned `true` and `supplyLiquidity` then reverted
"Top-up would forfeit in-flight interest" (§6). Two earlier failures were harness bugs, fixed in the harness: the `claim` op did
not anticipate the legitimate "Drain underflow" while interest is lent out, and the Foundry handler had a backwards `vm.warp`
(pending tranche appeared "stamped before base" only because time went backwards — a harness artifact, not a contract state).

## 5. Gas — `test/foundry/V61Gas.t.sol` (new), V6.0 (tag) vs V6.1, `forge test --isolate`

The tagged V6.0 source is compiled alongside as `test/foundry/legacy/AgentLiquidityMarketplaceV6_0.sol` (contract renamed, imports
re-pointed, otherwise byte-for-byte the tag) so both versions run the identical scenario on identical fresh stacks. Metering is
`vm.lastCallGas().gasTotalUsed` under `--isolate` (each call is its own tx with cold storage) — it reconciles with the 2026-08
hardhat-receipt numbers in `LOAD_TEST_2026-08.md` (repayLoan @ 50 lenders: 1,681,007 here vs 1,681,397 there; lossy liquidate @ 50:
544,190 vs 544,477).

| Scenario | V6.0 | V6.1 | Δ | Why |
|---|---|---|---|---|
| supplyLiquidity fresh (new slot) | 224,427 | 227,037 | +2,610 | `activeLoanCount` read + pending-slot read |
| supplyLiquidity top-up, no loan in flight (case a) | 73,829 | 78,645 | +4,816 | |
| supplyLiquidity top-up mid-loan, first (case b, pending create) | 73,829 | 95,919 | +22,090 | 1 new packed slot (amount, ts) + event |
| supplyLiquidity top-up merge (d) | 71,029 | 85,092 | +14,063 | `activeLoanIds` scan ×1 + slot rewrite |
| supplyLiquidity top-up fold (c) | 71,029 | 85,092 | +14,063 | |
| supplyLiquidity top-up fold with 10 active loans (max scan) | 73,829 | 129,904 | +56,075 | two scans of the 10-entry active set (worst case) |
| withdrawLiquidity partial with pending trim | 59,925 | 67,560 | +7,635 | |
| withdrawLiquidity full exit (slot freed) | 65,610 | 67,556 | +1,946 | |
| requestLoan (1 lender) | 451,486 | 499,750 | +48,264 | `isAgentActive` call + `activeLoanIds.push` (new array slot) |
| repayLoan 1 lender, on time | 194,447 | 249,848 | +55,401 | `ownerOf` call + `repayments[id]` record (3 new slots) + active-set pop |
| repayLoan 1 lender, 53 d late (beyond cap) | 180,034 | 302,829 | +122,795 | + `lateRepayCount`/`lateSecondsTotal` first writes (2 new slots) + `LoanRepaidLate` |
| **repayLoan 50 lenders, no tranches** (`_distributeInterest`) | 1,681,007 | 1,852,743 | +171,736 | `qualifiedAmountAt` reads the pending slot per lender (50 extra cold SLOADs) |
| repayLoan 50 lenders, all with pending tranches | 1,681,007 | 1,857,743 | +176,736 | tranche arithmetic is memory-only; +5k over the no-tranche case |
| liquidateLoan 50 lenders, lossy (principal only) | 544,190 | 726,911 | +182,721 | `_shrinkPendingProRata` early-return ×50 + `_pruneEmptyLenders` walk + `ownerOf` |
| **liquidateLoan 50 lenders, lossy, all with pending tranches** | 544,190 | 998,361 | +454,171 | 50 pending-slot rewrites + 50 `PendingTrancheUpdated` events — the new worst case |
| liquidateLoan 50 lenders, loss > Σ principal (interest socialized) | 341,797 | 728,978 | +387,181 | F-05 second pass (2 loops over 50) + prune loop popping all 50 |
| claimInterest | 51,234 | 51,216 | −18 | |

```
$ forge test --isolate --match-path test/foundry/V61Gas.t.sol -vv
  GAS | scenario | V6.0 | V6.1 | delta
  GAS | repayLoan 50 lenders, no tranches | 1681007 | 1852743 | +171736
  GAS | liquidateLoan 50 lenders, lossy, all with pending tranches | 544190 | 998361 | +454171
  GAS | claimInterest | 51234 | 51216 | -18
  [PASS] test_gas_report()
```

Assessment: the bounded 50-lender loops stay far under any block limit (worst 998k). The per-loan overhead (+48k request, +55k
repay, +123k for a late repay) is the cost of the `repayments`/lateness records and the active-set bookkeeping; on Arc this is
cents. Nothing in the V6.1 diff introduces an unbounded loop: `activeLoanIds` ≤ 10, `poolLenders` ≤ 50.

## 6. Bug found — `canTopUp` pre-check misses a loan that started in the latest block (LOW, fixed in repo, NOT deployed)

**Symptom (fuzz property (i)):** `canTopUp(agentId, lender)` returned `true`; the immediately following `supplyLiquidity` reverted
"Top-up would forfeit in-flight interest".

**Mechanism.** The case-(d) test in both `supplyLiquidity` and `canTopUp` is `_activeLoanStartedIn(agentId, pending.ts,
block.timestamp)` with a half-open window `s < hi`. Inside the supply **tx** that is right: a loan started in the same block as the
supply (`s == block.timestamp`) is excluded, and merging + re-stamping the pending tranche to `now == s` keeps it qualified for that
loan (lossless, consistent with the existing equal-timestamp rule). But the **view** is evaluated by the SDK/MCP against the latest
block, at timestamp T, and the tx lands at T′ > T. A loan that started at exactly T is outside the view's window and inside the
tx's. So whenever the most recent block opened a loan on that pool, the pre-check said "safe" for a top-up that must be refused.

**Fix (contract, one line, view-only):** `canTopUp` now uses the inclusive bound `block.timestamp + 1`. Since every ACTIVE loan
has `start ≤ block.timestamp < T′`, "some active loan started in `[pending.ts, T+1)`" is exactly the tx's condition for any later
block (absent a new loan in between, which is a genuine race no view can pre-empt). `supplyLiquidity` itself is unchanged.

```solidity
// contracts/core/AgentLiquidityMarketplaceV6.sol — canTopUp()
-        return !_activeLoanStartedIn(agentId, pt.timestamp, block.timestamp);
+        return !_activeLoanStartedIn(agentId, pt.timestamp, block.timestamp + 1);
```

**Verification that the property really failed before the fix, and that the fix is view-only.**

- `git diff -- contracts/` is exactly this hunk: **1 file changed, 6 insertions(+), 1 deletion(-)** (5 of the 6 are the comment).
- Reverting it (mutant **M17**) fails 2 hardhat tests — the dedicated pin `"[BUG 2026-09-20] canTopUp must see a loan that started
  in the LATEST block (view at T vs tx at T' > T)"` and the property fuzz — **and** fails the Foundry `invariant_ghost_no_violations`
  (property (i)). So the failing property is real and is now guarded from two independent directions.
- **Storage layout is bit-identical.** `forge inspect AgentLiquidityMarketplaceV6 storageLayout` before and after the change gives
  the same 25-slot vector, same labels, offsets and types (`_owner`@0 … `lateSecondsTotal`@24), and the same type definitions.
  Nothing is added, removed or reordered, and the changed expression lives inside an `external view` function.
- The only behavioural change is in the `canTopUp` return value. No write path is touched.

**Deployment status — the fix is NOT in the deployed bytecode.** Measured, not assumed:

| | Arc **mainnet** `0x358c5E69f712A4b3558333090a45A054bAeEb282` | Arc **testnet staging** `0xB2d88bbFF61EF2CcF4B4A2CFd75aeed0f11F6878` |
|---|---|---|
| `eth_getCode` runtime size | 19,725 bytes | 19,725 bytes |
| locally compiled **pre-fix** source (hardhat, solc 0.8.20, viaIR, 200 runs) | 19,725 bytes | 19,725 bytes |
| locally compiled **post-fix** source (the tree today) | **19,759 bytes** | **19,759 bytes** |
| byte-diff vs locally compiled pre-fix | 22 runs of differences: 21 × 20-byte address immutables + the 32-byte metadata hash at offset 19,682 — **nothing else** | identical shape: 21 × 20-byte immutables + 32-byte metadata |

The fix adds 34 bytes of code, so the deployed contracts cannot contain it; and the deployed code matches the *pre-fix* source
everywhere except the constructor immutables (registry / reputation / USDC addresses, inlined at 21 call sites) and the metadata
hash. This is independently corroborated by git: the fix exists only as an uncommitted working-tree change
(`git log -S"block.timestamp + 1" -- contracts/core/AgentLiquidityMarketplaceV6.sol` returns nothing), while both marketplaces were
deployed from commits `7d80ff2` (mainnet) and `07fb780` (staging), whose `canTopUp` ends `…, block.timestamp);`. Both deployments
are Sourcify `exact_match` against that pre-fix source.

**Real-world impact of the deployed (pre-fix) `canTopUp`.**

- *Who is affected.* Only a lender who simultaneously has (1) a non-zero position in an agent pool, (2) a non-empty **pending
  tranche**, (3) at least one ACTIVE loan on that pool, and (4) a loan on that pool whose `startTime` equals the timestamp of the
  block the view was read against. In practice: "I topped up mid-loan, and the agent opened another loan in the block I just read."
- *What they see.* The `supplyLiquidity` transaction reverts with `Top-up would forfeit in-flight interest`. That is the **correct,
  conservative** outcome — the contract is protecting the lender's in-flight interest. The revert is atomic: no USDC moves, the
  position, pending tranche, and `earnedInterest` are untouched. The cost is the failed tx's gas, which on Arc is a fraction of a
  cent. An SDK/MCP caller that trusts `canTopUp` surfaces a raw revert string instead of a clean "not right now" message.
- *Is money at risk?* **No.** The error is one-directional: the deployed view is strictly *more permissive* than the tx, so the
  only possible failure mode is "view says yes, tx refuses". It can never cause a top-up that *should* be refused to be accepted,
  and it cannot mis-account interest, principal, or collateral — all of that is decided in `supplyLiquidity`, which is correct and
  unchanged. `canTopUp` is not called by any on-chain write path (it is `external view`, referenced only by the SDK/MCP layer).
- *Residual risk of the fix itself.* The fixed view is very slightly conservative in the opposite direction: if a tx were included
  in a block with the *same* timestamp as the block the view was read against, the view could say "no" where the tx would have
  succeeded. That direction is safe (a spurious "wait" rather than a spurious "go"), and it is unreachable on Arc, where block
  timestamps are strictly increasing.

**Recommendation.**

1. **Do not redeploy the marketplace for this alone.** A marketplace redeploy on Arc mainnet means retiring the live contract,
   migrating lender positions and open loans, and re-verifying — materially more risk than a view that is occasionally optimistic
   about a top-up. Severity is LOW and no funds are at risk.
2. **Handle it in the SDK / MCP layer (the right place regardless).** Treat `canTopUp == true` as *advisory*, and always catch the
   `Top-up would forfeit in-flight interest` revert on `supplyLiquidity`, mapping it to a clear user-facing message ("another loan
   opened just now — top up again once it closes, or withdraw your pending tranche first"). This is required even against the
   fixed contract, because a loan opened between the view read and tx inclusion is a genuine race no view can eliminate. *(Not
   implemented here — `mcp-server/` is owned by another agent; this is a handover item.)*
3. **Ship the one-line fix with the next marketplace deploy** (e.g. whenever F-04 forces a ReputationManagerV3 / marketplace
   change). Storage layout is unchanged, so it adds no migration burden of its own.

## 7. Refuted / clarified concerns

| Concern | Verdict |
|---|---|
| `_shrinkPendingProRata` clamp `if (newPending > amountBefore − share)` (L511) is uncovered — is a `pending > amount` state reachable? | **Refuted.** With `cut = ⌊share·pend/A⌋`, `pend ≤ A`, `share ≤ A`: `pend − cut ≤ A − share` always (algebraically `pend·(A−share) ≤ A·(A−share)` ⇒ `pend − share·pend/A ≤ A − share`). The clamp is dead defensive code and is still the only uncovered V6.1 branch after this round; invariant (b) confirms `pending ≤ amount` over 128,000 calls × 6 invariants. |
| Could `_distributeInterest` split by `qualifiedAmountAt` disagree with an off-chain sum of the same view? | **Refuted.** Property (c): per-lender share and fee dust exact over 107 fuzz repays (86 + 21) and every Foundry repay. |
| Can tranche bookkeeping ever block a full withdrawal while liquidity is available? | **Refuted.** Property (d): 0 refusals over 61 hardhat full withdrawals (52 + 9) plus 9–15 per Foundry run, with position and pending both zeroed. |
| Does the F-01 holder-repay path let a stranger close (or grief) a loan, or move collateral to the holder? | **Refuted.** Property (j): 54 stranger attempts (45 + 9) refused with "Not the borrower"; collateral always to `loan.borrower`; principal + interest always pulled from the payer. Mutants M06 and M12 confirm the assertions bite. |
| Does the 30-day cap ever under- or over-charge at the boundaries? | **Refuted.** Exact at `elapsed == endTime` (0 late seconds, nominal interest), at `endTime + 30 d` (37-day charge), and far beyond (cap binds, `lateSeconds` keeps growing). Mutants M09 and M10 both killed by that one test. |
| Can a loss larger than Σ principal leave `earnedInterest` unbacked (first-come-first-served claims)? | **Refuted** on V6.1. Property (k) + invariant (a): interest reduced by exactly `min(excess, Σ interest)`; a 1-unit-lender remainder case is exact to the base unit; the wiped lenders are pruned. Note the positive case fires in the hardhat fuzz (5 occurrences) and the unit tests, **not** in the Foundry campaign (§2). |
| Does `liquidateLoan` still work after the NFT moved / the agent was deactivated? | **Refuted** (i.e. it works): property (k) 0 reverts across 90 hardhat NFT transfers and 24 deactivations, plus ~31 transfers and ~10 deactivations per Foundry run. |
| Does `canTopUp` exactly predict the tx? | **Not refuted — bug §6**, fixed in the repo, **still live on Arc mainnet and staging**. |
| Does the Foundry handler actually exercise the F-07 deactivation gate? | **It did not** — a `vm.prank` consumption bug meant every deactivation silently reverted. Fixed this round (§2); the gate now fires 9–11 times per run and mutant M13 is killed by the invariants. |

## 8. Files

Added (tests):
- `test/foundry/V61Invariants.t.sol` — 6 invariants + 7 ghost-violation counters, handler with 11 ops (includes the 2026-09-21 `toggleActive` prank fix)
- `test/foundry/V61Gas.t.sol` + `test/foundry/legacy/AgentLiquidityMarketplaceV6_0.sol` (tag source, renamed) — V6.0 vs V6.1 gas
- `test/unit/V61TrancheEdgeCases.test.js` — 14 tests: coverage-gap branches, boundaries, the §6 bug pin
- `test/unit/V61PropertyFuzz.test.js` — 2 tests, 2,400-op property fuzz (`V61_FUZZ_OPS` to shorten)

Added (tooling / artefacts):
- `scripts/mutation/mutate-v61.js` — the committed, reproducible mutation runner (17 mutants, `--only=`, `--no-forge`, `--out=`)
- `forensics/output/testing-2026-09-20/mutation-results.json` — per-mutant results

Changed:
- `contracts/core/AgentLiquidityMarketplaceV6.sol` — `canTopUp` inclusive bound (§6), 6 lines incl. comment, view-only

Not touched: `mcp-server/`, `docs/`, `scripts/e2e/`, `forensics/output/testing-2026-09-20/e2e*`, SDKs.

## 9. Totals

- **`npm test`: 671 passing / 5 pending / 0 failing** on the first run of the day (`EXIT=0`, 43 s). Baseline without this round's
  two new files: 655 / 5 / 0 (the two files add 14 + 2 = 16 tests).
- **Caveat, measured:** every later full-suite run in this session reports **632 passing / 5 pending / 2 failing**. Both failures are
  `"before all"` hooks in `test/api/tx-builder-stress.test.js` and `test/api/tx-builder.test.js`, which spawn a real
  `MultiNetworkAPI` server and poll `/health?network=arc`. That endpoint now returns HTTP 503 because the public Arc-testnet RPC
  replies `{"code":429,"message":"Too many requests"}` (reproduced directly with curl: `RPC time=0.15 http=429`). It is an external
  rate limit, not a code regression — those two suites contribute the 39 tests between 632 and 671, and they touch no contract.
  **Deterministic control: the whole suite minus `test/api/` is 632 passing / 5 pending / 0 failing, `EXIT=0`, reproducible.**
- **`forge test`** (all suites, default 32 × 64 + the gas test): `Ran 3 test suites in 608.97ms: **13 tests passed, 0 failed,
  0 skipped** (13 total)` — `V61Gas` 1/1, `V6Invariants` 6/6, `V61Invariants` 6/6.
- **Deep Foundry campaign on the fixed contract:** 6/6 pass, 256 runs × 500 depth = 128,000 calls per invariant, **768,000 handler
  calls, 0 reverts, 36.31 s**.
- **Mutation: 17/17 killed, 0 survived**, 8 also killed by the Foundry invariants; source tree verified byte-identical afterwards.

Reproduce:

```
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npm test                                                     # or: npx hardhat test $(find test -name '*.js' | grep -v ^test/api/ | grep -v ^test/foundry/)
npx hardhat coverage
forge test
forge test --isolate --match-path test/foundry/V61Gas.t.sol -vv
FOUNDRY_INVARIANT_RUNS=256 FOUNDRY_INVARIANT_DEPTH=500 forge test --match-path test/foundry/V61Invariants.t.sol -vv
node scripts/mutation/mutate-v61.js                          # ~17 min, writes mutation-results.json
```
