# V7 credit model — end-to-end scenario suite on a LIVE chain

**Target:** Arc **TESTNET** staging, chainId **5042002** (RPC `https://rpc.testnet.arc.io`).
**Stack under test:** `ReputationManagerV4` `0x66977dF45F38D8b0Dc463817C4B46a7E08ddbdFB` (`VERSION() == "V4"`) +
`AgentLiquidityMarketplaceV62` `0xa736EE7BB1BFB21bD294B220Bd7027B6Fe266300` (`VERSION() == "V6.2"`),
registry `0x4712A978A0EADe68f0b485b981112Ae66aA622d9`, MockUSDC `0x9F3C10985998D1354D1465c5135Aa924775bd11D`.
**Date:** 2026-09-22 · **Branch:** `arc-mainnet-launch` · **Scripts:** `scripts/e2e-v7/`
**Raw results:** `forensics/output/v7-model/e2e-v7-results/*.json` · **All tx hashes:** `forensics/output/v7-model/e2e-v7-txlog.json`

**Nothing was broadcast to Arc mainnet (5042) or Base.** The harness pins the provider to chainId 5042002,
refuses to run on 5042 / 8453 / 1, and additionally refuses unless the configured marketplace reports
`VERSION() == "V6.2"` and the reputation manager `"V4"`. Every role is a throwaway wallet generated for this
run; the keys live only in `forensics/output/v7-model/e2e-v7-wallets.json`, which is covered by the existing
`.gitignore` rule `forensics/output/**/*wallets*.json` (verified with `git check-ignore`, and the file has
never been committed). No key appears in any artifact in this report.

**Contracts were not modified.** Everything is driven directly with `ethers` against the deployed ABIs — no
SDK, MCP or Python code is on the path, so these results are independent of the concurrent SDK work.

---

## 0. Result matrix

| # | Scenario | Where | Checks | Result |
|---|---|---|---|---|
| **V1** | Self-stake lock (M2-a): creator locked while borrowing, third party not | **on-chain** | 12 | **PASS** |
| **V2** | Self-stake requirement (M2-c) gates the unsecured tiers, exact boundary | **on-chain** | 15 | **PASS** |
| **V3** | Credit ladder (M1-2): exact rungs, strict growth, no k=1 deadlock | **on-chain** | 34 | **PASS** |
| **V4** | Tier cap (M1-4): table, ceiling, `setTierLimits` guards | **on-chain** | 14 | **PASS** |
| **V5** | `loanId` pass-through (M2-d): concurrent equal loans, out-of-order repay | **on-chain** | 15 | **PASS** |
| **V6** | `minSupplyAmount` creator exemption | **on-chain** | 11 | **PASS** |
| **V7** | Migration finalized + control plane + live lever read-back | **on-chain** | 29 | **PASS** |
| **V8** | Prior-fix regression on V6.2: F-01, F-02, F-07 | **on-chain** | 32 | **PASS** |
| **V9** | *Observation:* `minHold` also gates the ladder (finding O-1) | **on-chain** | 7 | **PASS** (behaviour confirmed) |
| — | `00-setup` preflight: funding, lever compression, agent B pumped to tier 4 | on-chain | 8 | **PASS** |
| — | `99-restore-levers` read-back | on-chain | 7 | **PASS** |
| **L1** | Default penalty scales with size, floors at `defaultPenaltyBase` | local (time travel) | 4 | **PASS** |
| **L2** | Default resets `maxRepaidPrincipal` → 0 and forces `creditLimit` → 0 | local | 15 | **PASS** |
| **L3** | Credit line recovers to the bootstrap rung after the 180-day lockout | local | 6 | **PASS** |
| **L4** | A second, smaller default never *shortens* an existing lockout | local | 2 | **PASS** |
| **L5/L6** | Late-repayment reputation penalty (10 + 5/day, cap 100), ladder frozen | local | 9 | **PASS** |
| **L7** | Socialised loss: self-stake absorbs first; mid-loan joiner not charged | local | 9 | **PASS** |
| — | local setup guard (owner pool authorization revoked) | local | 1 | **PASS** |
| | **Total** | | **230** | **230 pass / 0 fail / 0 blocked** |

Nothing is BLOCKED. The time-dependent paths (L1–L7) are labelled **local** throughout and are described in §7.

---

## 1. A necessary caveat: the clock levers were compressed, and restored

The live staging levers are calibrated for a real calendar. Two of them make a single-session on-chain run
impossible:

* `minHoldForReputationReward = 86400 s` — a loan must be held a full day before it counts at all;
* `maxReputationGainPerWindow = 5 / 86400 s` with `refDuration = 7 days` — reaching the 0 %-collateral tier
  (score ≥ 600, the only place the M2-c self-stake gate can bind) is **≥ 80 days** away.

`scripts/e2e-v7/00-setup.js` therefore compresses **five clock levers only**, as the staging owner, and
`99-restore-levers.js` puts every one of them back (verified by read-back, and independently re-verified by
V7 afterwards):

| lever | live | compressed for the run | restored |
|---|---|---|---|
| `onTimeRepaymentBonus` | 10 | 50 (0 during V3) | ✅ 10 |
| `bonusReferenceAmount` | 100 USDC | 1 USDC | ✅ 100 USDC |
| `refDuration` | 7 days | 1 s (600 s during V5) | ✅ 604800 s |
| reputation rate limit | 5 / 86400 s | 0 (unlimited) / 86400 s | ✅ 5 / 86400 s |
| `minHoldForReputationReward` | 86400 s | 0 | ✅ 86400 s |

**Not touched at any point, by any script:** `creditMultiple` (2), `growthStep` (100 USDC),
`bootstrapLimit` (100 USDC), `tierLimits`, `tierCollateralPct`, `tierMinScore`, `MAX_TIER_LIMIT`,
`defaultLockout` (180 d), `defaultPenaltyBase/Large`, `largeLoanThreshold`, `latePenalty*`,
`platformFeeRate` (100 bps), `minSupplyAmount` (10 USDC), `bindBorrowToPoolCreator` (M-1, on),
`migrationFinalized`. V4 (tier cap) does make two *deliberate* `setTierLimits` calls — one valid change and
one restore — which are part of the test and are verified back to the shipped table.

**Every model parameter under measurement was at its shipped value while it was measured.** The compressed
levers only buy simulated calendar time; the ladder arithmetic in V3, the self-stake arithmetic in V1/V2 and
the tier table in V4 are all read from chain at the shipped values, asserted in-script.

Agents used (all registered fresh on the shared staging registry):

| role | agentId | purpose |
|---|---|---|
| A | **#51** | ladder measurement (V3), F-02 (V8) |
| B | **#52** | pumped to score 600 → 0 % collateral; V1, V2, V5 |
| C | **#53** | `minSupplyAmount` exemption (V6), minHold observation (V9) |
| D → E | **#54** | agent-NFT transfer (F-01) |
| F | **#55** | deactivation (F-07) |

---

## 2. V1 — the self-stake lock (M2-a) · **PASS, on-chain**

Agent **#52** at the 0 %-collateral tier, pool shared with a genuine third-party lender `T`.

| assertion | measured |
|---|---|
| `selfStake(52)` with no loan open | `(200.000000, locked = false)` |
| `requiredSelfStake(52, 500)` | **250.000000 USDC** = 500 × (100−0)/100 ÷ k=2 |
| after `requestLoan(500)` | `selfStake(52) = (250.000000, locked = **true**)`, `outstandingPrincipal = 500` |
| creator `withdrawLiquidity(52, 1)` | **REVERT `"Self-stake locked while borrowing"`** |
| creator `withdrawLiquidity(52, 250e6)` | **REVERT `"Self-stake locked while borrowing"`** |
| creator position after the refusals | unchanged, 250.000000 |
| **third party** `withdrawLiquidity(52, 100)` *during the same loan* | **SUCCEEDS** — 400.0 → 300.0, loan still outstanding at 500 |
| after `repayLoan(11)` | `selfStake(52) = (250.000000, locked = **false**)` |
| creator `withdrawLiquidity(52, 250e6)` | **SUCCEEDS**, +250.000000 USDC returned, `selfStake` → 0 |
| per-pool conservation | exact (`1419.935603 + 0 == 1400.0 + 19.935603`) |

Key tx hashes: draw `0xea4d220806ccb2636d4db450fbc5c06592ae83bf117bd40b4e1c8b7bdd40a52f` ·
third-party withdraw `0xa9a53a49869b8a10416ad177b7af39c7724a36ca76119cb66f54ee139b08179a` ·
repay `0xf060b44603b885ccb2924f949261edc62b8d22d36e50b50b13778f3fda5cecc1` ·
creator withdraw `0xfad74ad639d2a49c11a776f29006322971c1a051cf44f54e813a815cef5a6bf3`.

**The `locked` flag flips exactly with `outstandingPrincipal > 0`, and the lock is scoped to the creator's own
slot only.** The simulation's bust-out ordering (withdraw own seed, then draw the pool down) is impossible on
the live stack.

---

## 3. V2 — the self-stake requirement (M2-c) · **PASS, on-chain**

Exact boundary against `requiredSelfStake(agentId, additionalAmount)`, agent #52, collateral 0 %, k = 2.

| step | required (chain) | actual self-stake | `requestLoan` |
|---|---|---|---|
| control, 100 %-collateral agent #51 | **0** | — | gate inert |
| first loan, 400 USDC | **200.000000** | **199.999999** (required − 1 base unit) | **REVERT `"Insufficient self-stake"`** |
| first loan, 400 USDC | **200.000000** | **200.000000** (exactly required) | **SUCCEEDS** (loan #12) |
| second loan, +100 USDC | **250.000000** (aggregate 400 + 100) | 200.000000 | **REVERT `"Insufficient self-stake"`** |
| second loan, +100 USDC | **250.000000** | **250.000000** | **SUCCEEDS** (loan #13) |

`requiredSelfStake` matched the specification exactly at every step:
`(outstandingPrincipal + amount) × (100 − collateralPct) / 100 ÷ creditMultiple`. The refused loans left no
state (`outstandingPrincipal` and `activeLoanCount` unchanged). The requirement is confirmed to be on
**aggregate** exposure, not per-loan — a second loan demands more stake even though the first one's stake was
sufficient on its own.

Boundary txs: `0x40689905…` (supply to required−1), `0x676655c2…` (the final 1 base unit),
`0xb5bd3ccd…` (the loan that then succeeds), `0x48446b76…`/`0x5905d5bc…` (aggregate top-up and second loan).

---

## 4. V3 — the credit ladder (M1-2) · **PASS, on-chain**

Agent **#51**, at the shipped ladder parameters read from chain: **k = 2, growthStep = 100 USDC,
bootstrapLimit = 100 USDC**. `onTimeRepaymentBonus` was set to 0 for the duration so the score — and therefore
the tier — is frozen at 100 (tier 0, limit 1,000 USDC) and the ladder is isolated. Restored afterwards.

| rung | `maxRepaidPrincipal` | `ladderLimit` = max(boot, k·maxRepaid + step) | `tierLimit(score)` | **`calculateCreditLimit`** | borrowed |
|---|---|---|---|---|---|
| 0 | 0 | **100** | 1,000 | **100** | 100 |
| 1 | 100 | **300** | 1,000 | **300** | 300 |
| 2 | 300 | **700** | 1,000 | **700** | 700 |
| 3 | 700 | **1,500** | 1,000 | **1,000 ← tier cap binds** | 1,000 |
| 4 | 1,000 | **2,100** | 1,000 | **1,000 (still capped)** | — |

All values USDC, all asserted to the base unit against a locally recomputed
`min(tierLimit, max(bootstrap, k·maxRepaid + step))`.

* **Strictly increasing: 100 → 300 → 700 → 1,500 → 2,100.** Head-room exceeds the record it just beat at every
  rung, so the `k = 1` deadlock mode (head-room ≤ record ⇒ permanent stall) does not occur.
* `CreditCapacityUpdated(agent, amount)` was emitted on every on-time repayment with the exact new record.
* Borrowing `creditLimit + 1` base unit at rung 0 reverted **`"Exceeds credit limit"`**.
* `setLadderParameters(k = 1, growthStep = 0, …)` reverted **`"growthStep must be > 0"`** — the deadlock is
  refused by the setter, on chain — and the refused call left `creditMultiple`/`growthStep` untouched.
* `creditLimit ≤ tierLimit` at every rung.

Rung txs: `0x621b521d…`/`0x1a077308…` (100), `0xfbbe1d54…`/`0x26f11fa3…` (300),
`0x0db82faa…`/`0xefe9475f…` (700), `0xcd128297…`/`0x74df651c…` (1,000).

---

## 5. V4 — the tier cap (M1-4) · **PASS, on-chain**

| read | value |
|---|---|
| `MAX_TIER_LIMIT()` | **10,000 USDC** (a `constant`) |
| `tierLimits(0..5)` | **1,000 / 5,000 / 10,000 / 10,000 / 2,500 / 5,000 USDC** |
| `tierCollateralPct(0..5)` | 100 / 100 / 100 / **75** / 0 / 0 |
| `tierMinScore(0..5)` | 0 / 200 / 400 / 500 / 600 / 800 |
| `unsecuredTierExposure(0..5)` | 0 / 0 / 0 / 2,500 / 2,500 / **5,000** — monotone and capped |

* `creditLimitOf ≤ tierLimit(score) ≤ MAX_TIER_LIMIT` held for every live agent (#51: 1,000 ≤ 1,000 ≤ 10,000;
  #52 at score 750: 2,100 ≤ 2,500 ≤ 10,000), and `tierLimit(s) ≤ ceiling` across a sweep of the whole
  0…1000 score domain.
* `setTierLimits` with one entry at `MAX_TIER_LIMIT + 1` → **REVERT `"Tier limit exceeds ceiling"`**.
* `setTierLimits` attempting to restore the old **50,000 USDC top tier** → **REVERT, same reason**. A
  compromised owner key cannot re-open the V3 exposure.
* `setTierLimits` with a zero entry → **REVERT `"Tier limit must be > 0"`**.
* All three refused owner calls changed nothing on chain.
* A **valid** owner change (tier 5 → 10,000, tx `0x1b38afa9…`) applied and read back, then was restored to the
  shipped table (tx `0xb88d9bb5…`) and re-verified entry by entry.

---

## 6. V5 — `loanId` pass-through (M2-d) · **PASS, on-chain**

Two loans of **exactly 200.000000 USDC each** opened 65 s apart on agent #52 and repaid **in the opposite
order** — the case amount-matching cannot resolve. `refDuration` was set to 600 s for this script (restored)
so hold time is measurable inside one run; `onTimeBonus = 50`, `bonusRef = 1 USDC`, so
`bonus = 50·min(held,600)/600`.

| | loan X (older, #18) | loan Y (younger, #19) |
|---|---|---|
| `openLoans(loanId).start` | 1790099663 | 1790099728 (+65 s) |
| `openLoans(loanId).amount` / `.agentId` | 200.000000 / 52 | 200.000000 / 52 |
| repaid | **second** | **first** |

On repaying **Y first**:

* `LoanCompleted` carried **`loanId = 19`** (indexed), not an amount match.
* Score delta = **3 points**, exactly `50 · 41 s / 600 s` using **Y's own** 41-second hold.
* The **FIFO / oldest-first counterfactual** — the reading the report's scratch contract used — would have paid
  `50 · 106 s / 600 s` = **8 points**. Measured 3 ≠ 8, so attribution is unambiguously by `loanId`.
* `openLoans(19)` was deleted; **`openLoans(18)` was untouched** (same `start`, `amount`, `agentId`), and loan
  #18 stayed ACTIVE on the marketplace.

Then repaying **X**: `LoanCompleted` carried `loanId = 18`, score delta **9 points** = `50 · 112 s / 600 s`
from X's own hold, and `openLoans(18)` was deleted.

Txs: `0xeb714ede…` (X), `0x9737c909…` (Y), `0xcc1643b9…` (repay Y first), `0xd2341620…` (repay X).

---

## 7. V6 — `minSupplyAmount` creator exemption · **PASS, on-chain**

Live lever `minSupplyAmount = 10 USDC`, fresh agent **#53**.

| actor | action | result |
|---|---|---|
| creator C, own pool, **new slot** | supply **5 USDC** | **SUCCEEDS** — registers as `selfStake = 5.000000` |
| third party T2, same pool, new slot | supply **5 USDC** | **REVERT `"Below minimum supply"`**, no position created |
| third party T2 | supply **10 USDC** (exactly the minimum) | SUCCEEDS |
| third party T2, **existing** slot | top up **1 USDC** | SUCCEEDS (F-C gates only new slots) |
| creator C | top up **2 USDC** | SUCCEEDS (stake 7.000000) |
| creator C, in **agent #51's** pool | supply 5 USDC | **REVERT `"Below minimum supply"`** — the exemption is pool-scoped |

---

## 8. V7 — migration finalized and control plane · **PASS, on-chain (at the restored live levers)**

Run **after** `99-restore-levers.js`, so it measures the configuration staging is actually left in.

* `VERSION()` = `"V6.2"` / `"V4"`; addresses are the configured V7 pair.
* `migrationFinalized == true`; `seedPool(...)`, `seedPosition(...)` and `setMigrationFinalized()` all
  **REVERT `"Migration finalized"`** even from the owner — the latch is one-way and the F-08 surface is shut.
* Owner of both contracts is the secure wallet `0x800e305A0caDdE6289dFDFEDF38218f45C06F72C`; marketplace not
  paused; `renounceOwnership()` **REVERTS `"Ownership cannot be renounced"`** on both (I-1);
  both `Ownable2Step` with no pending owner.
* `authorizedPools[0xa736EE7B… (V6.2)] == true`. The superseded V6.1 marketplace
  `0xB2d88bbFF61EF2CcF4B4A2CFd75aeed0f11F6878` and the legacy V6.0 `0xDbDf60AE…` are **NOT** authorized —
  two live marketplaces cannot write the same reputation state. An unauthorized caller (even the owner EOA)
  is refused with `"Only authorized pools"`.
* **Live lever read-back, all as documented:** M-1 `bindBorrowToPoolCreator = true`; `minHold = 86400 s`;
  `minSupplyAmount = 10 USDC`; `platformFeeRate = 100 bps`; rate limit **5 / 86400 s**; ladder
  **k = 2, step = 100 USDC, bootstrap = 100 USDC, refDuration = 604800 s**; `onTimeBonus = 10`,
  `bonusReferenceAmount = 100 USDC`; `defaultLockout = 15,552,000 s (180 d)`; default penalty
  **50 / 100 / threshold 1,000 USDC**; late penalty **10 / 5 per day / cap 100**; tier limits
  `[1000, 5000, 10000, 10000, 2500, 5000]` with `MAX_TIER_LIMIT = 10,000`; marketplace constants
  `MIN_LOAN_DURATION 7 d`, `MAX_ACTIVE_LOANS_PER_AGENT 10`, `MAX_LENDERS_PER_POOL 50`,
  `LATE_INTEREST_CAP 30 d`.

---

## 9. V8 — prior fixes still hold on V6.2 · **PASS, on-chain**

### F-01 — repay after an agent-NFT transfer (agent #54, D → E)

* After `transferFrom`, the registry moved the identity: `ownerOf == E`, `addressToAgentId[D] == 0`,
  `addressToAgentId[E] == 54`.
* **Original borrower D repaid loan #21** after the transfer. D's balance delta was exactly
  `collateral − (principal + interest)` = `100.000000 − 100.287671` = **−0.287671 USDC**.
* **New holder E repaid loan #22.** **Collateral went to `loan.borrower` (D: +100.000000), not to E**, and E
  paid `100.287671`. The reputation call resolved through the new holder (`LoanCompleted` for agentId 54).
* An unrelated address was refused: **`"Not the borrower"`**.
* After the transfer neither party can open a new loan: D gets **`"Not a registered agent"`**, and M-1 stops
  E with **`"Borrow restricted to pool creator"`**.

### F-02 — in-flight top-up refusal (agent #51)

`canTopUp` was `true` before the first top-up (case b); the 20 USDC top-up became a **pending tranche** stamped
after the loan started, and LA's qualified amount for loan #1 was **unchanged** (1,100.0). Once a second loan
started *after* the pending stamp, `canTopUp` went **false** and `supplyLiquidity` reverted
**`"Top-up would forfeit in-flight interest"`**. A lender with no position is never refused. `canTopUp`
returned `true` again once no loan was in flight. `canTopUp` was an exact oracle for the refusal throughout.

### F-07 — deactivated agent (agent #55)

`registry.deactivateAgent(55)` → `isAgentActive == false`. Then: `requestLoan` **REVERTS
`"Agent deactivated"`**; `repayLoan` **succeeds** (the closing path stays live); a third-party lender
**can still withdraw**; the creator **can withdraw its own stake** once `outstandingPrincipal == 0`.
`reactivateAgent` restored borrowing.

Per-pool conservation was exact for pools #51, #54 and #55 at the end of the scenario.

---

## 10. Local (hardhat, chainId 31337) — the time-dependent paths · **46 checks, all PASS**

`scripts/e2e-v7/local-time-travel.js` — run with `npx hardhat run`. **These are LOCAL, not on-chain**: a
180-day lockout, a 25-day-late repayment and an overdue liquidation cannot be produced on a live testnet.
A fresh V7 stack is deployed on the in-process chain with the **live arc-staging levers** (k = 2, step 100,
bootstrap 100, refDuration 7 d, minHold 1 d, minSupply 10, fee 100 bps, M-1 on, rate limit 5/day, lockout
180 d, shipped tier table). Scores and ladder capacity are **seeded** through the authorized-pool path (the
shortcut `test/v7/_fixture.js` uses, since reaching score 600 honestly takes ~50 real cycles); the owner's
pool authorization is then **revoked**, so every mechanism below runs through the real marketplace.

### L1 — the default penalty scales with size

| defaulted | penalty formula `max(base 50, 100 · amount / 1,000)` | measured score change |
|---|---|---|
| 300 USDC | max(50, 30) = **50** (the floor binds) | 605 → 555 |
| 1,000 USDC | max(50, 100) = **100** (at the threshold) | 605 → 505 |
| 2,000 USDC | max(50, 200) = **200** (scales) | 605 → 405 |

Doubling the default doubled the penalty; the base floor covers everything below the threshold. This is the
V3 pathology (a flat 100-point step regardless of size) genuinely removed.

### L2 — capacity reset and lockout

For every default: `maxRepaidPrincipal` reset to **0** with `CreditCapacityUpdated(agent, 0)`;
`AgentLockedOut(agent, now + 180 days)` emitted with the exact timestamp; `isLockedOut == true`;
`creditLimitOf == 0`; and a locked-out agent's `requestLoan` reverts **`"Exceeds credit limit"`** even with
ample pool liquidity.

### L3 — recovery

Ten seconds before expiry the limit was still 0. One second after: `isLockedOut == false`, the ladder restarts
at the **bootstrap rung (100 USDC)** — not where it was — `creditLimitOf == min(tierLimit 10,000, ladder 100)
== 100 USDC`, the agent borrowed again, and the ladder began climbing from zero
(`maxRepaidPrincipal → 100`).

### L4 — a second default never shortens an existing lockout

After a first default set `lockedUntil = t + 180 d`, `defaultLockout` was temporarily lowered to 1 day and a
second, smaller loan was liquidated. `lockedUntil` **did not move** — the `if (until_ > lockedUntil)` guard
holds.

### L5 / L6 — late repayment

| days late | penalty `min(10 + 5·fullDays, 100)` | measured | ladder |
|---|---|---|---|
| 3 | **25** | 450 → 425, `LateRepaymentRecorded.penalty == 25`, `lateSeconds 259261` | **not advanced** |
| 25 | 10 + 125 = 135 → **capped 100** | 425 → 325, `penalty == 100`, `lateSeconds 2160061` | **not advanced** |

`lateCount` incremented both times, and interest was charged on elapsed time (F-03): chargeable 864,060 s and
2,764,860 s respectively, both above the 604,800 s nominal term.

### L7 — socialised-loss basis and the first-loss waterfall

Fresh 0 %-collateral agent, self-stake **500**, early lender **600** (supplied before the loan), loan
**1,000 USDC** fully unsecured, then a **mid-loan joiner** supplied **400** after `startTime`.
`qualifiedAmountAt(early, startTime) = 600`, `qualifiedAmountAt(joiner, startTime) = 0`. On liquidation:

| party | before | after | charged |
|---|---|---|---|
| creator self-stake (M2-b) | 500 | **0** | **500 — absorbed FIRST**, `SelfStakeAbsorbedLoss(…, 500)` |
| early (qualified) lender | 600 | **100** | 500 |
| **mid-loan joiner** | 400 | **400** | **0** |

Flat pro-rata — the V6.1 behaviour — would have charged the joiner `500 × 400/1000 =` **200 USDC**. It was
charged **zero**. Per-pool conservation stayed exact through the loss (`500 + 0 == 500 + 0`), and the
defaulting agent was locked out with capacity reset.

---

## 11. Findings

**No contract bug was found.** Every designed behaviour in V1–V8 and L1–L7 matched the specification exactly,
to the base unit and to the point. Two informational observations:

### O-1 · LOW / documentation — `minHoldForReputationReward` also gates the **credit ladder**, not just the bonus

**Reproduced on-chain at the live levers** (`scripts/e2e-v7/v9-minhold-ladder-coupling.js`, agent #53, loan #27,
request `0x68c16800…`, repay `0x3490064f…`).

`AgentLiquidityMarketplaceV62.repayLoan` folds three conditions into the single `onTime` boolean it passes on:

```solidity
reputationManager.recordLoanCompletion(holder, loanId, loan.amount, onTime && heldLongEnough && paidInterest, lateSeconds);
```

and `ReputationManagerV4.recordLoanCompletion` advances the M1-2 ladder **inside that same branch**:

```solidity
} else if (onTime) {
    if (block.timestamp >= lockedUntil[agentId] && amount > maxRepaidPrincipal[agentId]) { maxRepaidPrincipal[agentId] = amount; ... }
    ... // bonus
}
```

Measured: a **genuinely punctual** 100 USDC / 7-day repayment held 5 s (`lateSeconds == 0`, well inside the
term) produced `LoanCompleted(onTime = false)`, **no** `CreditCapacityUpdated`, `maxRepaidPrincipal` still 0,
`ladderLimit` still 100 USDC, and an unchanged score. At the live `minHold` of 1 day, **no loan held under
24 h can ever raise a credit line**, however punctual.

This is defensible design — capacity should be demonstrated by capital-time, not by round trips — and it is
consistent with M1-1's intent. It is flagged because `V7_DESIGN_AND_VALIDATION.md` describes M-2 only as
blunting reputation farming (§ "M-2 lever" comment: *"a too-fast on-time repay simply earns no bonus (neither
reward nor penalty)"*), and does not say it also freezes the ladder. A client that surfaces "repay early to
grow your line" would be wrong. **Recommendation:** document it, and have
`prepare_repay_loan` warn when `block.timestamp − loan.startTime < minHoldForReputationReward`.

### O-2 · INFORMATIONAL — the staging config keys now alias V7 under V6/V3 names

`src/config/arc-testnet-v6-addresses.json` points `agentLiquidityMarketplace_v6` and `reputationManagerV3` at
the **V6.2 / V4** addresses (the V6.1 pair moved to `*_legacy`). The pre-existing harness
`scripts/e2e/_lib.js` loads the `AgentLiquidityMarketplaceV6` and `ReputationManagerV3` **ABIs** against those
keys, so it now drives V6.2/V4 through the older ABIs. The overlapping read surface makes that mostly work
silently, which is the hazard. This suite avoids it by loading the V6.2/V4 ABIs explicitly and asserting
`VERSION()` before any write. **Recommendation:** pin the older suite to the `*_legacy` keys, or update its
ABIs.

---

## 12. Staging funds spent

Arc **testnet** only. MockUSDC is a test token with no value; native is testnet gas.

| | amount |
|---|---|
| Native moved from the deployer to throwaway wallets | **9.246659** (hard cap in the harness: 30) |
| Native still held by the throwaway wallets (recoverable) | **8.587357** |
| **Native actually consumed as gas by the throwaways** | **≈ 0.659302** |
| Native consumed by the deployer's own txs (funding, mints, owner levers) | **≈ 0.044942** |
| **Total native cost of the run** | **≈ 0.704** |
| Deployer native balance after | **85.738166** (was 95.029814) |
| MockUSDC minted to throwaways | **13,700.000000** (minted by the deployer, which owns MockUSDC) |
| On-chain transactions sent | **157**, **28,171,654** gas total |

Throwaway wallet addresses are recorded in the (gitignored) wallets file and in each scenario's result JSON;
the unused 8.59 native can be swept back to the deployer at any time from those keys.

---

## 13. Re-running

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
node scripts/e2e-v7/run-all.js            # every on-chain scenario, in order, then restore + verify
node scripts/e2e-v7/run-all.js --local    # …and the local time-travel suite
npx hardhat run scripts/e2e-v7/local-time-travel.js   # local suite alone
```

Individual scenarios are independently re-runnable and idempotent: wallets, registrations, pools, reputation
initialisation and pool funding are all "ensure" operations, every scenario asserts its own preconditions, and
every scenario closes the loans it opens. `00-setup.js` must run before V1–V6/V8 (it compresses the clock
levers and pumps agent B); `99-restore-levers.js` must run before `v7-migration-control-plane.js` and
`v9-minhold-ladder-coupling.js`, which are the two scripts that measure the live configuration.
Override the RPC with `E2E_V7_RPC_URL` (fallback `https://arc-testnet-rpc.publicnode.com`; the dRPC endpoint
rate-limits this host and is not used).
