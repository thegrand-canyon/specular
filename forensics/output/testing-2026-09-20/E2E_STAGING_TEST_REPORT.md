# Specular — End-to-end test round on Arc testnet V6.1 staging (2026-09-20 / 21)

**Target (the ONLY chain written to in this round): Arc testnet staging, chainId `5042002`.**
Marketplace `0xB2d88bbFF61EF2CcF4B4A2CFd75aeed0f11F6878` (`VERSION() == "V6.1"`),
RegistryV2 `0x4712A978A0EADe68f0b485b981112Ae66aA622d9`, ReputationV3 `0x085D581FB56d4aD428d9852466557286099dD46c`,
MockUSDC `0x9F3C10985998D1354D1465c5135Aa924775bd11D`, owner `0x800e305A…F72C`.
RPC `https://rpc.testnet.arc.network` (fallback `https://arc-testnet.drpc.org`). Arc **mainnet** and **Base** were
never touched — `scripts/e2e/_lib.js` pins the provider to chainId 5042002 and every script asserts it at start.

Scope: exercise the 2026-09-19 internal-audit fixes (F-01, F-02, F-03, F-05, F-07, F-08) and the launch levers
(M-1, M-2, D1 rate limit, F-C minSupply, 1 % fee) against a live chain, through the JS SDK, the Python client and
the **live hosted non-custodial server** (`https://specular-agent-api-production.up.railway.app`).

Artifacts: `scripts/e2e/*`, `forensics/output/testing-2026-09-20/results/*.json`, `…/results/s8-run.log`,
`…/txlog.json` (137 on-chain transactions, all `status == 1`).

---

## 1. Scenario × result matrix

| # | Scenario | Result | Assertions (pass/fail/blocked) | Note |
|---|----------|--------|-------------------------------|------|
| S1 | Multi-party market via the SDK (3 lenders, exact interest shares, `minSupply` revert on a new slot) | **PASS** | 37 / 0 / 0 | agents 46 + 47, loan 3 |
| S2 | F-02 pending-tranche top-up behaviour, cases (a)–(e) | **PASS** | 30 / 0 / 0 | agent 46, loans 4 + 5 |
| S3 | F-01 agent-NFT transfer → repay by original borrower and by new holder; liquidation path | **PASS** | 24 / 0 / 0 | agent 46, loans 6 / 7 / 8 |
| S4 | F-07 deactivated agent cannot borrow but can repay / lenders can exit | **PASS** | 14 / 0 / 0 | agents 47 + 48; one stale NOTE, see B-4 |
| S5 | F-08 `seedPool` / `seedPosition` revert `"Migration finalized"` | **PASS** | 6 / 0 / 0 | read-only, 0 tx |
| S6 | M-1 non-creator cannot borrow / M-2 short-hold repayment earns no reputation | **PASS** | 10 / 0 / 0 | agent 46, loan 12 |
| S7 | Fully non-custodial path through the LIVE hosted server (prepare → sign locally → broadcast), incl. MCP JSON-RPC | run 1 **FAIL (1 check)** → **re-run PASS** | run 1: 34 / 1 / 0 → run 2: 35 / 0 / 0 | run 1 = agent 49, loans 13 + 14; run 2 = agent 50, loans 78 + 79. See B-3 |
| S8 | Reputation progression against the per-window rate limit + tier walk | **PASS** | 13 / 0 / 0 | agent 46, loans 15–17 + 19–77 |
| S9 | Python client vs JS SDK read parity | run 1 **BLOCKED** → fixed + **re-run PASS** | run 1: 0 / 0 / 1 → run 2: 17 / 0 / 0 | agent 47. See B-1, B-2 |

**Final tally after the two re-runs: 186 assertions passing, 0 failing, 0 blocked.**
Original run-1 records are preserved as `results/S7-run1.json` and `results/S9-run1-blocked.json`.

Global invariant, asserted at the end of S1, S2, S3, S4, S7 and again independently during this verification:
`marketplace USDC balance == Σ_pools availableLiquidity + Σ_active collateral + accumulatedFees` — **exact, surplus 0**,
and every pool conserves `availableLiquidity + totalLoaned == Σ position.amount + Σ earnedInterest`.
Final read: balance `482.236391` USDC == expected `482.236391` across 6 pools, 0 active loans, fees `0.169308`.

---

## 2. The numeric assertions that matter

### 2.1 S1 — interest split across three lenders, exact to the base unit

Loan 3: principal 100.000000 USDC, 1500 bps, 7 d. Qualified principal L1/L2/L3 = 100 / 50 / 30 of 180.

```
interest        = 100e6 * 1500/10000 * 604800 / 31_536_000 =   287_671
platform fee    = 287_671 * 100/10000                      =     2_876   (1 %)
lenderInterest  = 287_671 − 2_876                          =   284_795
L1 = 284_795 * 100/180 = 158_219.44 → 158_219   (on-chain 158_219) ✔
L2 = 284_795 *  50/180 =  79_109.72 →  79_109   (on-chain  79_109) ✔
L3 = 284_795 *  30/180 =  47_465.83 →  47_465   (on-chain  47_465) ✔
Σ shares = 284_793 → floor dust 2 base units routed to accumulatedFees ✔
```
Event on `0xd71c8de25ca6f2750db29027385b78cfcd2037756b1dff4eb3a6f32ad2971c5b`:
`InterestDistributed(agentId=46, totalInterest=284795)` / `LoanRepaid(loanId=3, principal=100000000, interest=287671)`.
Borrower net cost = exactly the interest (`A delta 0.287671`); collateral 100.000000 returned in full;
allowance back to 0 on both the supply and the repay legs (exact approvals, no `MaxUint256`).
`minSupplyAmount` lever: a 0.999999 USDC supply into a **new** slot reverts `"Below minimum supply"`; an existing
lender may top up by any amount.

### 2.2 S2 — F-02 tranche arithmetic

| Case | Action | Result |
|------|--------|--------|
| (b) | top up 20 while loan #1 open, no pending tranche yet | base `depositTimestamp` unchanged, pending = 20 @ 1789925670; **qualified amount for loan #1 unchanged** |
| (d) | top up 10 again, no active loan started since the pending stamp | pending merged to 30 and re-stamped; base untouched |
| (e) | top up after loan #2 started inside `[pending.ts, now)` | `canTopUp == false`; direct `supplyLiquidity` reverts **`"Top-up would forfeit in-flight interest"`**; SDK `supply()` refuses *before sending*; a **new** lender is never refused; the failed top-up changed nothing |
| (c) | top up after loan #1 closed | old pending folded into base (base stamp kept), new money → pending; qualified amount for loan #2 unchanged: `130000000 == 130000000` (lossless fold) |
| (a) | top up with no loans open | pending cleared, `PendingTrancheUpdated(…,0,0)` emitted, base re-stamped |

Exact shares with tranches in play — loan 4 (50 USDC, lenderInterest 142 397, L1 qualified 100 of 150):
`142_397 * 100/150 = 94_931.33 → 94_931` on-chain ✔ (the pending 30 correctly **excluded**); L2 `47_465` ✔.
Loan 5 (30 USDC, lenderInterest 85 438, L1 qualified 130 of 180): `85_438 * 130/180 = 61_705.9 → 61_705` ✔.
`pending ⊆ amount` held throughout.

### 2.3 S3 — F-01, collateral and reputation routing after an NFT transfer

| Leg | Assertion | Outcome |
|-----|-----------|---------|
| (i) | after `transferFrom(A → A2)`: `ownerOf == A2`, `addressToAgentId(A) == 0` | as expected |
| (i) | `previewRepayment` still works; **repay by the ORIGINAL borrower succeeds** | no `"Not an agent"`; total 20.057534 |
| (i) | collateral returned to `loan.borrower` (A); A2 balance untouched; A net delta = −interest 0.057534 | ✔ |
| (ii) | `repayLoan` by a **third party** | reverts `"Not the borrower"` |
| (ii) | `repayLoan` by the **new NFT holder** | succeeds; holder paid 10.028767; **collateral went to `loan.borrower` A2 (+10)** |
| (iii) | owner `liquidateLoan` while the NFT sits with A2 | reverts **`"Loan not overdue"`, NOT `"Not an agent"`** — the F-01 freeze is gone |
| (iii) | `getReputationScore(A2) == getReputationScore(agentId)` | reputation is keyed by agentId |

### 2.4 S6 — levers M-1 / M-2

- M-1 `bindBorrowToPoolCreator == true`: the NFT **holder who is not the pool creator** gets
  `"Borrow restricted to pool creator"`; an unregistered wallet gets `"Not a registered agent"`;
  `pool.agentAddress` stays the creator across the transfer.
- M-2 `minHoldForReputationReward == 86400`: loan 12 held **9 s**, repaid on time with interest paid
  (0.287671 USDC) → `LoanCompleted(onTime=false)`, **no `ReputationUpdated`**, score 0 → 0,
  `gainedInWindow` unchanged. Only the min-hold gate blocked the bonus.

### 2.5 S8 — reputation deltas and the D1 window

Levers at start: `maxReputationGainPerWindow=20`, `reputationGainWindow=86400 s`, `onTimeRepaymentBonus=10`,
`bonusReferenceAmount=100 USDC`, `minHold=86400 s` (temporarily set to 0 for the cycles, restored at the end).

| Cycle | Loan | Score before → after | gainedInWindow |
|-------|------|----------------------|----------------|
| 1 | 15 | 0 → **10** (`ReputationUpdated(46, 0, 10, "on-time repayment")`) | 10 |
| 2 | 16 | 10 → **20** | 20 |
| 3 | 17 | 20 → **20** (clamped; **no** `ReputationUpdated` emitted) | 20 |

The score stopped **exactly** at the window budget. Tier walk (rate limit temporarily 0 = unlimited):

| Score crossed | Collateral | APR | Credit limit | borrow tx |
|---|---|---|---|---|
| 200 | 100 % | 15 % | 5 000 USDC | `0xb920268b56492bb2454923e3fbefe3c56ede89981db5e4ac8a85a10854446b45` |
| 400 | 100 % | 10 % | 10 000 USDC | `0x8ff4234a375a0bddcaa7281fe7ad0230a5feb42c409a505913718bab3dca9fea` |
| 500 | **25 %** | 10 % | 10 000 USDC | `0xd58cc621f44af74c2925037c9ba22d07305298cf6ec616d79efa765b43f2d870` |
| 600 | **0 %** | 7 % | 25 000 USDC | `0xe807ad8cf311f4ed162b7a32309a9b57b04a8363227f427753e4b65ab1a10de2` |

A real loan taken at score 600 posted `collateralAmount == 0` at 700 bps
(`0xd52a16de52fd3451dca64dea40fba6ea2fe12f48ff095e470b2e62ddc5409035`). The rate-limit lever was restored
(`0x1892125a182583b0010ecc0bc5bbb81cd87714fcf70e401d83c00e6b0fc460ab`), as was `minHold`
(`0xb6501a712a1841af9fca24d4ba012a4581f678563981145bac7e8d70b77b1433`).

---

## 3. S7 — hosted non-custodial path, latency

Flow per loan cycle: `prepare_*` on the server (returns an **unsigned** tx for the agent's own wallet, plus a
simulation and, where needed, an exact-amount `approve` **prerequisite**) → sign locally with ethers →
`broadcast_signed_transaction`. Two of the steps below ran over **MCP JSON-RPC** (`POST /mcp`, `tools/call`)
rather than REST — the whole second loan cycle did.

Security behaviours confirmed: every prepared tx carried `value == 0`; every approval was **exact**
(`previewRepayment.total` for repays, tier collateral for borrows) and the wallet's allowance was 0 at the end;
the relay **refused** a signed tx to a non-Specular target —
`{"error":"Specular transactions must carry value 0; refusing to relay a native-token transfer"}` (HTTP 400).

### Round-trip latency (run 1, 2026-09-20)

| Route | Step | ms | | Route | Step | ms |
|---|---|---|---|---|---|---|
| REST | `GET /health` | 351 | | REST | `preview_repayment` | 414 |
| REST | `GET …/network` | 253 | | REST | `prepare_repay_loan` (simulate) | 559 |
| REST | `check_credit_score` (before) | 140 | | REST | broadcast repay prerequisite | 118 |
| REST | `prepare_register_agent` | 193 | | REST | `prepare_repay_loan` (after approve) | 493 |
| REST | broadcast `register_agent` | 192 | | REST | broadcast `repay_loan` 13 | 118 |
| REST | `prepare_create_pool` | 500 | | REST | `get_loan_status` (repaid) | 249 |
| REST | broadcast `create_pool` | 181 | | REST | `check_credit_score` (after) | 294 |
| REST | `prepare_approve_usdc` 20 | 364 | | MCP | `get_protocol_status` | 215 |
| REST | broadcast `approve_usdc` | 179 | | MCP | `prepare_request_loan` | 404 |
| REST | `prepare_supply_liquidity` | 503 | | MCP | broadcast loan prerequisite | 120 |
| REST | broadcast `supply_liquidity` | 124 | | MCP | `prepare_request_loan` (after approve) | 461 |
| REST | `prepare_request_loan` (no allowance) | 378 | | MCP | broadcast `request_loan` 5 | 121 |
| REST | broadcast loan prerequisite | 108 | | MCP | `get_transaction` | 254 |
| REST | `prepare_request_loan` (after approve) | 536 | | MCP | `preview_repayment` | 158 |
| REST | broadcast `request_loan` 10 | 124 | | MCP | `prepare_repay_loan` | 232 |
| REST | `get_transaction` (loan) | 224 | | MCP | broadcast repay prerequisite | 106 |
| REST | `get_loan_status` (active) | 464 | | MCP | `prepare_repay_loan` (after approve) | 612 |
| REST | broadcast to a non-Specular target (refused) | 65 | | MCP | broadcast `repay_loan` 14 | 120 |
| | | | | MCP | `get_loan_status` | 216 |

| Route | n | min | median | p90 | max | mean |
|---|---|---|---|---|---|---|
| REST (run 1) | 25 | 65 | 249 | 503 | 559 | 285 |
| MCP (run 1) | 12 | 106 | 216 | 461 | 612 | 252 |
| REST (run 2) | 25 | 71 | 239 | 523 | 622 | 274 |
| MCP (run 2) | 12 | 117 | 302 | 563 | 688 | 309 |

Shape: pure reads and broadcasts are ~110–350 ms; `prepare_*` **with `simulate: true`** is the expensive class
(~380–690 ms) because it runs an `eth_estimateGas`/`eth_call` against the upstream RPC. No timeouts, no 5xx.

---

## 4. Audit finding → live evidence

| Finding | Fix claimed in `FIX_NOTES_2026-09-19.md` | Live evidence on chainId 5042002 | Verdict |
|---|---|---|---|
| **F-01** HIGH — NFT transfer freezes `repayLoan` / `liquidateLoan` | resolve the agent via `ownerOf(loan.agentId)`; repay by borrower **or** holder; collateral always to `loan.borrower` | S3 (i) repay by original borrower after transfer `0x3c132a57126f9ea65744af1e1647fd98b5ee19e63702081c818073dd9c89c092`; (ii) repay by the new holder `0x49baf3d4a8b08a57f18430d146c1ffde19bab2c99ed7901854e929d58c1f896b` with collateral to A2; third party refused `"Not the borrower"`; (iii) `liquidateLoan` reverts **`"Loan not overdue"`**, not `"Not an agent"` | **CONFIRMED FIXED live** |
| **F-02** MEDIUM — top-up forfeits the whole position's in-flight interest | two tranches per position; cases (a)–(d) lossless, (e) reverts; `canTopUp` view | S2, all five cases, with exact per-lender shares (§2.2). Qualified amounts provably unchanged by (b)/(c)/(d) | **CONFIRMED FIXED live** |
| **F-03** MEDIUM — late repayment costs nothing | interest on `max(duration, elapsed)` capped at `duration + 30 d`; `repayments[loanId]`, `lateRepayCount`, `LoanRepaidLate` | **Partial.** `previewRepayment` and `repayments[loanId]` exist and are populated on every repay (`interestPaid` == charged interest, `lateSeconds == 0`, `chargeableSeconds == 604800`); server `preview_repayment` matches the contract exactly. **The late path itself was never exercised** — no loan in this round was allowed to pass its 7-day term | **NOT PROVEN live — gap** |
| **F-05** LOW — loss beyond principal strands unclaimed interest | second-pass `_socializeInterestLoss` + `_pruneEmptyLenders` | **Not exercised.** No default or liquidation was performed on staging in this round (every loan was repaid; `liquidateLoan` was only probed and correctly refused as not overdue) | **NOT PROVEN live — gap** |
| **F-07** LOW — `deactivateAgent` was a no-op | gate `requestLoan` + `createAgentPool` on `isAgentActive`; leave closing/exit paths open | S4: `requestLoan` → `"Agent deactivated"` (`0x…` probe), `createAgentPool` → `"Agent deactivated"`; while deactivated the agent **repaid** (`0x991c7cf7b56e103219e61496cc4fa18d5be307ebdc13ae9a53d7d0d0cf294a7c`), lender L2 **withdrew** and **claimed** (28 480 base units); reactivation restored borrowing. Independently re-verified 2026-09-21 on agent 48: `supplyLiquidity` into a deactivated agent's pool is **ALLOWED** (documented design), `requestLoan` / `createAgentPool` both revert `"Agent deactivated"` | **CONFIRMED FIXED live** |
| **F-08** MEDIUM — migration helpers live | owner tx `setMigrationFinalized()` | S5 + independent read: `migrationFinalized() == true`; owner `seedPool`, `seedPosition` and a second `setMigrationFinalized` all revert **`"Migration finalized"`**; non-owner `seedPool` → `OwnableUnauthorizedAccount` | **CONFIRMED CLOSED on staging** |
| **F-04** HIGH (design, D1 economics) | *not fixed — owner decision* | See §5.1. Reproduced end-to-end: **0.149029 USDC of fees** took an agent from score 20 to the 0 %-collateral / 25 000-USDC tier | **STILL OPEN, now empirically confirmed on a live chain** |
| **M-1** bindBorrowToPoolCreator | lever | S3 (ii) + S6: NFT holder who is not the pool creator → `"Borrow restricted to pool creator"`; lever read `true` and restored after the temporary toggle | **WORKS** |
| **M-2** minHoldForReputationReward = 86 400 s | lever | S6: 9 s hold → `onTime=false`, no `ReputationUpdated`, score unchanged, although the loan was on time and paid interest | **WORKS** |
| **D1** rate limit 20 pts / 86 400 s | lever | S8: +10, +10, +0 — clamps exactly at `gainedInWindow == 20` | **WORKS** |
| **F-C** `minSupplyAmount` = 1 USDC | lever | S1: 0.999999 into a new slot → `"Below minimum supply"`; existing lenders may top up by any amount | **WORKS** |
| §B1 / §S1 / H-3 solvency | V6 + V6.1 | Global solvency exact (surplus 0) at the end of S1, S2, S3, S4, S7 and on independent re-read; per-pool conservation `avail + loaned == Σ amount + Σ earned` holds for all 6 pools; `claimInterest` decrements `availableLiquidity` (S1); a fully-withdrawn lender with unclaimed interest stays in `poolLenders` (slot not leaked) | **HOLDS** |

---

## 5. Findings

### 5.1 F-04 (HIGH, design) — reproduced on a live chain, still open

The S8 tier walk is a direct, on-chain reproduction of the audit's D1 farming model. With the rate limit
temporarily removed (to compress ~30 calendar days into ~20 minutes — the rate limit *is* the only barrier
F-04 describes), agent 46 went **score 20 → 610** in **59 on-time 100-USDC loans**, which bought
0 % collateral, 7 % APR and a **25 000 USDC** unsecured credit limit.

Measured cost, read from `accumulatedFees` at the block boundaries of the walk:

```
accumulatedFees before the walk (block 63158104) =    19_706
accumulatedFees after  the walk (block 63160420) =   168_735
total protocol fees for the whole climb          =   149_029 base units = 0.149029 USDC
```

The audit's estimate was 0.125 USDC for 100 → 600. The live figure is the same order and confirms the
conclusion verbatim: **D1 is time-gated, not economically gated.** Working capital was fully recovered
(agent 46's principal round-tripped on every loan). Nothing here is a regression — it is the unfixed finding
behaving exactly as predicted, now with a transaction trail.

Operational note discovered while doing it: `setReputationRateLimit(0, w)` means **unlimited**, not "no gain"
(documented at `ReputationManagerV3.sol:35-37`), and while the limit is 0 the `gainedInWindow` /
`windowStart` counters are **not** updated at all (`ReputationManagerV3.sol:246,258`). An owner who sets 0
intending to freeze reputation would uncap it instead. Worth a line in the launch runbook.

### 5.2 Bugs found

| ID | Severity | Where | Finding | Status |
|----|----------|-------|---------|--------|
| **B-1** | MEDIUM *(test harness only — no protocol impact)* | `scripts/e2e/s9-python-parity.py:38` and `…parity.js:44` | Both sides indexed **`getAgentPool()`**'s 7-tuple `(agentAddress, totalLiquidity, availableLiquidity, totalLoaned, totalEarned, utilizationRate, lenderCount)` using the **`agentPools` struct** order `(agentId, agentAddress, …, isActive)`. Python raised `ValueError` on `int(pool[0])` (an address) and S9 aborted; the JS side would silently have compared `pool[3]` (= `totalLoaned`) as `availableLiquidity`, masked by a named-property fallback | **FIXED** — both scripts switched to `agentPools()` (indices now correct on both sides) and S9 re-run: **17/17 pass** |
| **B-2** | LOW *(harness / staging hygiene)* | `scripts/e2e/s9-python-parity.js:33-37` | The `R.blocked()` path returns **before** the cleanup `repay`, so the aborted run left **loan 18 ACTIVE** on agent 47 — 5.0 USDC of lender principal stuck in `totalLoaned` for ~25 h. Put the cleanup in a `finally` | **Leftover repaid** `0xbfd644d4d500bba140c328dce24fbdc8edea6240b2ab49c4003c05fe237393d8`; `activeLoanCount(47) == 0`, solvency exact |
| **B-3** | LOW *(hosted API, not reproducible)* | live server `GET /v1/arc-staging/agents/{addr}/credit` | S7 run 1's only failure. The on-chain truth at that instant was unambiguous — agent 49 has `score == 0`, `loanCount == 2`, `gainedInWindow == 0`, `windowStart == 0` and **no `ReputationUpdated` event has ever been emitted for it** — so the chain was never in the state the assertion rejected; the server response must have disagreed with the chain (most likely a transient upstream-RPC read). The harness truncated its detail to the first 200 chars of the body, which cut off the `reputation` / `credit` fields, so the exact offending field was not captured | **Not reproduced.** Re-run of the identical flow (agent 50) passes with `server score 0 == chain score 0`. Harness hardened: the check now records `registered`, `reputation`, `collateralPercent`, the **on-chain** score and `rpc`/`error` |
| **B-4** | LOW *(record accuracy)* | `results/S4.json`, NOTE `"supplyLiquidity into deactivated agent pool (staticCall)"` | Recorded `"reverts"`. That record predates the final version of `s4-f07-deactivate.js` (the probe ran without an allowance). `AgentLiquidityMarketplaceV6.sol` gates `isAgentActive` only at lines 244 (`createAgentPool`) and 625 (`requestLoan`) — `supplyLiquidity` is deliberately ungated | **Corrected by live re-check** on agent 48 (2026-09-21): `supplyLiquidity(48, 1 USDC)` while deactivated → **ALLOWED (no revert)**, matching the documented design. Agent reactivated, allowance revoked |
| **B-5** | INFO *(record accuracy)* | `results/S8.json` `finalScore: 600` | The script snapshots `cur` **before** the cleanup `repay` of the tier-verification loan (loan 77), which lands another +10 while the rate limit is still 0. On-chain agent 46 reads **610** | Benign; report `finalScore` after the cleanup repay |

**No contract bug, no SDK bug and no hosted-server logic bug was found.** Every revert observed in the round was
the intended one, with the intended reason string.

### 5.3 Coverage gaps (not failures — simply not exercised this round)

- **F-03 late-repayment economics**: `max(duration, elapsed)` interest and the 30-day `LATE_INTEREST_CAP` were
  never charged live, because no loan was allowed to run past its 7-day term. Everything *around* the fix is
  proven (`previewRepayment`, `repayments[loanId]`, `lateSeconds`), the late branch itself is not.
- **F-05 loss-beyond-principal**: requires a liquidation with a real loss. No default was staged.
- Both need a short-duration loan (or a time-advanced fork) plus an owner `liquidateLoan`; recommend adding
  an S10/S11 before the mainnet lever review.

---

## 6. Independent verification of the recorded results

Nine recorded transaction hashes were re-fetched from the chain and their claimed effects re-read from
contract state (not from the result JSONs). All nine mined with `status == 1`:

| Scenario | Recorded claim | Tx | On-chain |
|---|---|---|---|
| S1 | A registered, agentId 46 | `0x583c7512a243dbeba17ca9ec15feb55d74395034e38f075262e0bfe78855683d` | status 1, block 63122981; `ownerOf(46) == 0x6072…865b`, `addressToAgentId == 46` ✔ |
| S1 | pool created for 46 | `0x8d2994c6ad249bb77b7c3b0dfbe404780ebf8cf2f7d5a4285589d6c4ba1a42ff` | status 1, block 63122984; pool active, `agentAddress == A` ✔ |
| S1 | loan 3 repaid, shares 158219 / 79109 / 47465, fee 2876 + dust 2 | `0xd71c8de25ca6f2750db29027385b78cfcd2037756b1dff4eb3a6f32ad2971c5b` | `InterestDistributed(46, 284795)`, `LoanRepaid(3, 100000000, 287671)`, `LoanCompleted(onTime=false)`; loan 3 state **REPAID**, `repayments[3].interestPaid == 287671`, `lateSeconds == 0` ✔ |
| S2 | case (b) pending tranche 20 @ 1789925670 | `0x41a913d29212e3e47931cb3e0816a4e5b2e020678443f62eddb842a0339b4a71` | `PendingTrancheUpdated(46, L1, 20000000, 1789925670)` + `LiquiditySupplied` ✔ |
| S3 | repay by the NFT **holder** who is not the borrower | `0x49baf3d4a8b08a57f18430d146c1ffde19bab2c99ed7901854e929d58c1f896b` | `InterestDistributed(46, 28480)`, `LoanRepaid(7, 10000000, 28767)`; loan 7 **REPAID**; A2 holds 110.0 MockUSDC (100 minted + 10 collateral) ✔ |
| S6 | M-2 blocks the bonus | `0x313398f5ddc9329bc51e38fd69aca20072b53bb5e28187edb23fa28545c10e07` | `LoanCompleted(46, 100000000, onTime=false)` and **no `ReputationUpdated`** ✔ |
| S7 | loan 13 requested then repaid via the hosted relay | `0xb1b5be…a33b95` / `0xe466b876d35f58715c0741eab6d6cab0dc007443912e1bf5635d92efc70ce4f7` | loan 13 **REPAID**, interest 28 767, collateral 10.0 returned ✔ |
| S7 | loan 14 repaid via **MCP** | `0x16325a69e33d8e005d61e5621b4b8dca80f291e440e664323e0b293a8274a6de` | loan 14 **REPAID**, interest 14 383 ✔ |
| S8 | score 0 → 10 on loan 15 | `0xba7fa4d6fef53987136476e98c6f9904054b13661e92c9b2baa2329b881d7b35` | `ReputationUpdated(46, 0, 10, "on-time repayment")` ✔ |
| S9 | loan 18 opened for the parity read | `0x197ffb6a22fe419f95bd56af6fa8ca9e9154b5bf8b249e356d6d0e171a3f878f` | status 1 — but the loan was still **ACTIVE** (see B-2) ✘ |

**Discrepancies between the recorded results and on-chain reality: three, all benign and all now closed.**

1. **Agent 46 reads score 610, S8.json says `finalScore: 600`** — B-5, a pre-cleanup-repay snapshot.
2. **Loan 18 was still ACTIVE** — B-2, the aborted S9 run's cleanup never ran; now repaid.
3. **S4's `supplyLiquidity` NOTE said "reverts"; it does not** — B-4, stale record, corrected by re-check.

Every other sampled claim matched the chain exactly. Final post-verification state: **0 active loans**,
all 79 loans `REPAID`, global solvency exact (surplus 0), all levers at their documented staging values —
`migrationFinalized true`, M-1 `true`, M-2 `86400`, `minSupplyAmount 1.0 USDC`, `platformFeeRate 100 bps`,
`maxReputationGainPerWindow 20 / 86400 s`, `bonusReferenceAmount 100 USDC`, `paused false`,
owner `0x800e305A0caDdE6289dFDFEDF38218f45C06F72C`.

> Note carried forward: the **legacy V6.0 staging marketplace** `0xDbDf60AE5CB46D23aA44c062a4943655a6820f31`
> still reads `migrationFinalized == false` (read-only check in S5). It is testnet-only and holds test USDC,
> but F-08 is closed on V6.1 only.

---

## 7. Staging funds spent

All figures are **Arc testnet** value (native gas token) and **MockUSDC** (a freely-mintable test token with no
real value). **Zero real funds were spent; no mainnet transaction was broadcast.**

| Item | Amount |
|---|---|
| On-chain transactions | **137** (117 in the original round + 14 for the S7 re-run + 2 S9 cleanup + 4 F-07 re-check), all `status == 1` |
| Total gas consumed | **18 811 572** units |
| Native transferred from the deployer to throwaway wallets | **15.300159334926547913** |
| Native burned as the deployer's own gas | **0.043501453868383602** |
| **Total native leaving the deployer** | **15.343660788794931515** |
| Of that, still sitting in the 11 throwaway wallets (recoverable) | **≈ 13.603** |
| **Net native actually consumed as gas** | **≈ 1.741** |
| MockUSDC minted for the round | **1 060.000000** |
| MockUSDC still held by the throwaway wallets | **778.264183** |
| Protocol fees accrued into `accumulatedFees` during the round | **0.168734 USDC** (574 → 169 308 base units) |
| Deployer native balance after the round | 95.256394021156209267 |

Per scenario (funding + gas; MockUSDC minted):

| Scenario | txs | gas | native funded | MockUSDC minted |
|---|---|---|---|---|
| S1 | 20 | 1 919 628 | 6.000000 | 710.0 |
| S2 | 12 | 1 784 157 | 0.051000 | 0.0 |
| S3 | 21 | 2 778 985 | 1.062043 | 100.0 |
| S4 | 32 | 3 632 143 | 1.047833 | 50.0 |
| S5 | 0 | 0 | 0 | 0.0 |
| S6 | 9 | 974 479 | 1.078854 | 0.0 |
| S7 | 28 | 4 648 880 | 2.000000 | 200.0 |
| S8 | 11 | 2 317 531 | 4.021275 | 0.0 |
| S9 | 4 | 755 769 | 0.039153 | 0.0 |

---

## 8. Key security hygiene

`forensics/output/testing-2026-09-20/e2e-wallets.json` holds the throwaway private keys used by this round.
It is **gitignored** — `.gitignore:48` matches it exactly and `git check-ignore -v` confirms the rule applies.
No key material appears in this report, in `results/*.json` or in `txlog.json`. The wallets are disposable and
hold only testnet value; they may be swept and discarded.

## 9. Recommended follow-ups

1. Add the missing scenarios for **F-03 (late-repay interest + 30-day cap)** and **F-05 (loss > Σ principal
   socialisation and slot pruning)** — the two fixes with no live evidence.
2. **F-04 remains open** and is now quantified on-chain at 0.149029 USDC for the climb to the 0 %-collateral,
   25 000-USDC tier. Do not solicit third-party lender USDC at that tier until the ReputationManager model
   change lands. Tighten the mainnet levers as the audit recommends in the meantime.
3. Runbook line: `setReputationRateLimit(0, …)` = **unlimited**, and while 0 the per-window counters do not
   advance.
4. Move `s9-python-parity.js`'s cleanup repay into a `finally` (B-2) so an aborted parity run cannot leave an
   open loan behind.
5. Keep the widened failure-detail in `s7-hosted-noncustodial.js` and consider adding a chain-vs-server
   reputation cross-check to the hosted-API monitor, so a repeat of B-3 is diagnosable.
6. Finalise migration on the legacy V6.0 staging marketplace, or document it as knowingly left open.
