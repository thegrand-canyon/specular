# V7 credit model — end-to-end scenario suite on a LIVE chain

**Target:** Arc **TESTNET** staging, chainId **5042002** (RPC `https://rpc.testnet.arc.io`).
**Stack under test (re-validated after the V7 scale-fix redeploy):**
`ReputationManagerV4` **`0xD7906fDFBf69BA89a4c2FE148797e24f386fE3d2`** (`VERSION() == "V4"`) +
`AgentLiquidityMarketplaceV62` **`0x7E4D144AbEB3C695Ec2DdF00Fc710aABC04bDd18`** (`VERSION() == "V6.2"`),
registry `0x4712A978A0EADe68f0b485b981112Ae66aA622d9`, MockUSDC `0x9F3C10985998D1354D1465c5135Aa924775bd11D`.
The pre-scale-fix pair (`0xa736EE7B…` / `0x66977dF4…`) is now recorded under `supersededDeployments` in
`src/config/arc-testnet-v6-addresses.json` and is asserted **unauthorized** on the live ReputationManagerV4.
**Date:** 2026-09-23 (re-validation run; original run 2026-09-22) · **Branch:** `arc-mainnet-launch` · **Scripts:** `scripts/e2e-v7/`
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
| **V5** | `loanId` pass-through (M2-d): concurrent equal loans, out-of-order repay | **on-chain** | 17 | **PASS** |
| **V6** | `minSupplyAmount` creator exemption | **on-chain** | 11 | **PASS** |
| **V7** | Migration finalized + control plane + live lever read-back | **on-chain** | 30 | **PASS** |
| **V8** | Prior-fix regression on V6.2: F-01, F-02, F-07 | **on-chain** | 36 | **PASS** |
| **V9** | *Observation:* `minHold` also gates the ladder (finding O-1) | **on-chain** | 7 | **PASS** (behaviour confirmed) |
| — | `00-setup` preflight: funding, lever compression, agent B pumped to the unsecured tier | on-chain | 8 | **PASS** |
| — | `99-restore-levers` read-back | on-chain | 7 | **PASS** |
| **L1** | Default penalty scales with size, floors at `defaultPenaltyBase` | local (time travel) | 4 | **PASS** |
| **L2** | Default resets `maxRepaidPrincipal` → 0 and forces `creditLimit` → 0 | local | 15 | **PASS** |
| **L3** | Credit line recovers to the bootstrap rung after the 180-day lockout | local | 6 | **PASS** |
| **L4** | A second, smaller default never *shortens* an existing lockout | local | 2 | **PASS** |
| **L5/L6** | Late-repayment reputation penalty (10 + 5/day, cap 100), ladder frozen | local | 9 | **PASS** |
| **L7** | Socialised loss: self-stake absorbs first; mid-loan joiner not charged | local | 9 | **PASS** |
| — | local setup guard (owner pool authorization revoked) | local | 1 | **PASS** |
| | **Total** | | **237** | **237 pass / 0 fail / 0 blocked** |

Nothing is BLOCKED. The time-dependent paths (L1–L7) are labelled **local** throughout and are described in §7.

**Every on-chain result JSON in `forensics/output/v7-model/e2e-v7-results/` records
`marketplace = 0x7E4D144AbEB3C695Ec2DdF00Fc710aABC04bDd18` and
`reputation = 0xD7906fDFBf69BA89a4c2FE148797e24f386fE3d2`** — verified by re-reading the files after the run,
not inferred from the runner's exit code (the runner continues past a failing scenario and still exits 0, so a
stale file that merely still says "pass" would not be evidence). `local-time-travel.json` is the one file with
no marketplace address: it runs on a local hardhat chain (31337) and records `chainId: 31337` instead.
The definitive run is timestamped **2026-09-23T00:27–00:37Z**.

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

## 1b. Re-validation after the V7 scale-fix redeploy (2026-09-23)

The V7 stack was redeployed to staging with the scale fixes. **`ReputationManagerV4` ships no seeder by
design**, so reputation does **not** migrate across a redeploy: every agent comes back at
`maxRepaidPrincipal == 0` and its credit limit collapses to `bootstrapLimit` (100 USDC). The effective limit
is

```
creditLimit = min( tierLimit(score), max(bootstrapLimit, creditMultiple · maxRepaidPrincipal + growthStep) )
```

Any scenario that hardcoded a borrow amount therefore reverted `"Exceeds credit limit"` on the new stack.
Three scenarios did not refresh; re-running the suite surfaced four more that were **one-shot** — they had
passed once against a virgin stack and would silently fail on any second run. All were fixed by making the
scenarios read their amounts and preconditions **from chain at runtime**. No assertion was weakened; V8 and
V5 gained checks.

### What changed, and why

| Script | Why it broke | Fix |
|---|---|---|
| `v7-migration-control-plane.js` | (a) hardcoded the old pair `0xa736EE7B…` / `0x66977dF4…`; (b) read `cfg.agentLiquidityMarketplace_v61_legacy`, **a key that does not exist** in the address file, so `authorizedPools(undefined)` threw a `TypeError` and killed the script — which is why its JSON never refreshed at all | pair read from the **canonical keys** of `arc-testnet-v6-addresses.json` and asserted **not** to be any `supersededDeployments` entry; the "unauthorized" check now iterates **every** superseded/legacy marketplace the address file lists (3 + 2 aliases), so a future supersession is covered without a script edit |
| `v8-prior-fixes-regression.js` | hardcoded 100 USDC × 3 concurrent loans with a single hardcoded ladder rung. Post-redeploy the agent is back at `bootstrapLimit`. A crashed prior run had also left 3 ACTIVE loans, so `outstandingPrincipal` already sat at the limit | every borrow sized at runtime from `creditLimitOf` − `outstandingPrincipal`, pool `availableLiquidity` and the borrower's own USDC (`_lib.borrowableNow`); the ladder is climbed with on-time repaid rungs until *N* concurrent loans fit (`_lib.climbLadderTo`); *N*, the self-stake and the revert-probe amounts derive from `bootstrapLimit` |
| `v8` (second, independent blocker) | `AgentRegistryV2` is **not** redeployed with the marketplace, so the agent NFT from the previous run was still parked on E and `_update` refused the transfer with **`"Recipient already owns an agent"`** (the 1:1 `addressToAgentId` invariant). F-01 could never run twice | preflight parks a stale identity on a fresh sink address; leftover ACTIVE loans are repaid (`_lib.clearActiveLoans`); **new check F-01(e)** hands the identity back E → D at the end and asserts the registry mapping follows, so the pair is reusable and no NFT is stranded |
| `v8` (third) | after a few runs D's score crossed into a **0 %-collateral tier** and the M2-c self-stake gate began to bind on aggregate exposure — `"Insufficient self-stake"` | `_lib.ensureSelfStake` posts exactly `requiredSelfStake(agentId, exposure)` before borrowing (a no-op at the 100 %-collateral tiers), plus a new check that the stake actually covers the aggregate exposure |
| `v3-credit-ladder.js` | measures the ladder **from the bootstrap rung**, so it needs `maxRepaidPrincipal == 0`. Nothing on chain can restore that (only a default, which arms a 180-day lockout), so re-running it against the already-climbed agent A produced 18 failures | allocates a **virgin** agent per run (`V3LADDER-n`, reused until consumed, via `_lib.freshRoleWallet`); the whole rung table is now **computed** from `creditMultiple` / `growthStep` / `bootstrapLimit` / `tierLimit` read on chain instead of the hardcoded `100/300/700/1000/2100`; the tier-cap check derives the first capped rung |
| `v6-minsupply-creator-exempt.js` | needs a creator with **no lender slot** in its own pool; a slot is never un-claimed, so the second run failed 7 checks | allocates a virgin `V6CREATOR-n`; its pool being new also makes the third-party and foreign-pool legs honest again |
| `v5-loanid-passthrough.js` | agent B's score had **saturated at `MAX_SCORE` (1000)**, so both bonus deltas read 0 and the hold-time attribution proof was silently vacuous (0 == 0 proves nothing) | uses a `V5LOANID-n` agent with asserted score head-room, climbs the ladder, and derives the two equal loan amounts from chain; **two new checks** assert the head-room and that two concurrent equal loans fit |
| `00-setup.js` | pinned "agent B tier limit is the capped 2,500 USDC (tier 4)"; B's score crossed 800 into tier 5 (5,000 USDC) | reads `tierOf` / `tierLimits` / `tierCollateralPct` from chain and asserts B's tier limit is exactly the shipped table entry for **its** tier and that the tier is unsecured |
| `v9-minhold-ladder-coupling.js` | inherited agent C from `v6`, which no longer uses that role | registers and funds agent C itself; loan size derived from `bootstrapLimit` |

New shared helpers in `scripts/e2e-v7/_lib.js`: `borrowableNow`, `climbLadderTo`, `ensureSelfStake`,
`clearActiveLoans`, `freshRoleWallet`.

### Was any of it a contract bug?

**No.** Each behaviour that looked like breakage was the shipped design doing its job:

* **reputation does not migrate** — `ReputationManagerV4` has no seeder, `migrationFinalized == true`, and
  `seedPool` / `seedPosition` / `setMigrationFinalized` all revert `"Migration finalized"` even for the owner
  (V7, 30/30). Capacity must be re-demonstrated from scratch, which is the stated M1-2 intent.
* **`"Recipient already owns an agent"`** — `AgentRegistryV2._update` enforcing the 1:1 `addressToAgentId`
  invariant. The surprise is operational, not a defect: the registry outlives a marketplace redeploy.
* **`"Insufficient self-stake"`** — M2-c binding on aggregate exposure the moment an agent reaches a
  0 %-collateral tier. Exactly the gate V2 measures.
* **`MAX_SCORE` clamping** and **`minHold` gating the ladder** (finding O-1, re-confirmed at live levers by
  V9, 7/7) — both shipped behaviour.

The V6.2 / V4 contracts were **not modified**; `contracts/` is untouched by this work.

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
| after `repayLoan` | `selfStake(52) = (250.000000, locked = **false**)` |
| creator `withdrawLiquidity(52, 250e6)` | **SUCCEEDS**, +250.000000 USDC returned, `selfStake` → 0 |
| per-pool conservation | exact (`1419.935603 + 0 == 1400.0 + 19.935603`) |

Key tx hashes (2026-09-23 re-validation run, loan #99): draw
`0x1122ce1dc8c0f68ff8663f760e4f06c178eaf0f6e0192e3376fb0925c208f5a1` · third-party withdraw
`0x6faa69aa811336acc1141ff4c82c97d6d69194db38ca0a6087280fe087d56593` · repay
`0x15443baa86224b29763f981562518a86a0b94a6bde78f30c5598a71c3aaac97b` · creator withdraw
`0xd9cd540e208229a6a2111309708340e0509617e830a94af719154715cd9ec8dc`. Every other scenario's hashes are in
`forensics/output/v7-model/e2e-v7-txlog.json` and in each result JSON's `txs` array.

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

A **virgin agent allocated for the run** (re-validation: role `V3LADDER-4`, agent **#64**), at the shipped
ladder parameters read from chain: **k = 2, growthStep = 100 USDC, bootstrapLimit = 100 USDC**.
`onTimeRepaymentBonus` was set to 0 for the duration so the score — and therefore the tier — is frozen at 100
(tier 0, limit 1,000 USDC) and the ladder is isolated. Restored afterwards. The rung table below is
**computed** from those four chain reads, not hardcoded (§1b); the measurement must start at
`maxRepaidPrincipal == 0`, which is why the agent is fresh each run.

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

* The **tier cap** is asserted to bind at the first rung whose ladder head-room exceeds the tier limit — the
  rung index is derived from the computed table, not assumed to be rung 3.

Rung txs for each run are in `e2e-v7-txlog.json`; the per-rung table is in
`e2e-v7-results/v3-credit-ladder.json`.

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

Two loans of **exactly equal size** opened 65 s apart on one agent and repaid **in the opposite order** — the
case amount-matching cannot resolve. `refDuration` was set to 600 s for this script (restored) so hold time is
measurable inside one run; `onTimeBonus = 50`, `bonusRef = 1 USDC`, so `bonus = 50·min(held,600)/600`.
`minHoldForReputationReward` is lowered to 10 s alongside it, because it gates the reward **entirely** (O-1)
and at the live 1-day value every loan here would earn 0, making the proof vacuous.

The scenario runs on an agent with **asserted reputation head-room** (re-validation: `V5LOANID-1`, agent
**#60**), climbs the ladder, and derives the loan size from live head-room — **450.000000 USDC each** in the
re-validation run. This matters: the proof reads the M1-1 bonus off the score **delta**, so an agent saturated
at `MAX_SCORE` would report 0 == 0 and pass while proving nothing (§1b).

| | loan X (older, #106) | loan Y (younger, #107) |
|---|---|---|
| `openLoans(pool, loanId).start` | 1790123509 | 1790123574 (+65 s) |
| `openLoans(pool, loanId).amount` / `.agentId` | 450.000000 / 60 | 450.000000 / 60 |
| repaid | **second** | **first** |

On repaying **Y first**:

* `LoanCompleted` carried **`loanId = 107`** (indexed), not an amount match.
* Score delta = **3 points**, exactly `50 · 42 s / 600 s` using **Y's own** 42-second hold.
* The **FIFO / oldest-first counterfactual** — the reading the report's scratch contract used — would have paid
  `50 · 107 s / 600 s` = **8 points**. Measured 3 ≠ 8, so attribution is unambiguously by `loanId`.
* `openLoans(107)` was deleted; **`openLoans(106)` was untouched** (same `start`, `amount`, `agentId`), and
  loan #106 stayed ACTIVE on the marketplace.

Then repaying **X**: `LoanCompleted` carried `loanId = 106`, score delta **9 points** = `50 · 112 s / 600 s`
from X's own hold, and `openLoans(106)` was deleted.

Note the getter signature: V6.2 keys open-loan records by `(marketplace, loanId)`, so it is
`openLoans(pool, loanId)` — the one-argument form was removed.

---

## 7. V6 — `minSupplyAmount` creator exemption · **PASS, on-chain**

Live lever `minSupplyAmount = 10 USDC`, a **virgin creator allocated for the run** (re-validation:
`V6CREATOR-4`, agent **#65**). The creator must be new in its own pool for the "new slot" leg to mean
anything, and a lender slot is never un-claimed on chain — hence the fresh allocation (§1b).

| actor | action | result |
|---|---|---|
| creator C, own pool, **new slot** | supply **5 USDC** | **SUCCEEDS** — registers as `selfStake = 5.000000` |
| third party T2, same pool, new slot | supply **5 USDC** | **REVERT `"Below minimum supply"`**, no position created |
| third party T2 | supply **10 USDC** (exactly the minimum) | SUCCEEDS |
| third party T2, **existing** slot | top up **1 USDC** | SUCCEEDS (F-C gates only new slots) |
| creator C | top up **2 USDC** | SUCCEEDS (stake 7.000000) |
| creator C, in **another agent's** pool (#51) | supply 5 USDC | **REVERT `"Below minimum supply"`** — the exemption is pool-scoped |

---

## 8. V7 — migration finalized and control plane · **PASS, on-chain (at the restored live levers)**

Run **after** `99-restore-levers.js`, so it measures the configuration staging is actually left in.

* `VERSION()` = `"V6.2"` / `"V4"`; addresses are the configured V7 pair.
* `migrationFinalized == true`; `seedPool(...)`, `seedPosition(...)` and `setMigrationFinalized()` all
  **REVERT `"Migration finalized"`** even from the owner — the latch is one-way and the F-08 surface is shut.
* Owner of both contracts is the secure wallet `0x800e305A0caDdE6289dFDFEDF38218f45C06F72C`; marketplace not
  paused; `renounceOwnership()` **REVERTS `"Ownership cannot be renounced"`** on both (I-1);
  both `Ownable2Step` with no pending owner.
* `authorizedPools[0x7E4D144A… (V6.2)] == true`. **Every** superseded / legacy marketplace the address file
  records is **NOT** authorized — V6.0 `0xDbDf60AE…`, V6.1 `0xB2d88bbF…` and the pre-scale-fix V6.2
  `0xa736EE7B…` — so two live marketplaces cannot write the same reputation state. An unauthorized caller
  (even the owner EOA) is refused with `"Only authorized pools"`. The check is driven off
  `supersededDeployments`, so a future supersession is covered without a script edit.
* **Live lever read-back, all as documented:** M-1 `bindBorrowToPoolCreator = true`; `minHold = 86400 s`;
  `minSupplyAmount = 10 USDC`; `platformFeeRate = 100 bps`; rate limit **5 / 86400 s**; ladder
  **k = 2, step = 100 USDC, bootstrap = 100 USDC, refDuration = 604800 s**; `onTimeBonus = 10`,
  `bonusReferenceAmount = 100 USDC`; `defaultLockout = 15,552,000 s (180 d)`; default penalty
  **50 / 100 / threshold 1,000 USDC**; late penalty **10 / 5 per day / cap 100**; tier limits
  `[1000, 5000, 10000, 10000, 2500, 5000]` with `MAX_TIER_LIMIT = 10,000`; marketplace constants
  `MIN_LOAN_DURATION 7 d`, `MAX_ACTIVE_LOANS_PER_AGENT 10`, `MAX_LENDERS_PER_POOL 50`,
  `LATE_INTEREST_CAP 30 d`.

---

## 9. V8 — prior fixes still hold on V6.2 · **PASS, on-chain (36 checks)**

Re-validation run: agents **D = #56**, **A = #51**, **F = #55**; loans **#108–#110** (transfer),
**#111/#112** (tranche), **#113** (deactivation). Every amount in this scenario is now read from chain at
runtime — see §1b.

### F-01 — repay after an agent-NFT transfer (agent #56, D → E)

* D's ladder was climbed with on-time repaid rungs until three concurrent loans fit; the per-loan amount came
  out at **100.000000 USDC** (limit 300.0, `maxRepaidPrincipal` 100.0). Because D now sits at a
  **0 %-collateral** tier, the M2-c gate binds: D posted **150.000000 USDC** of first-loss self-stake for the
  300 USDC aggregate exposure before borrowing, and the scenario asserts
  `positions[agent][creator] >= requiredSelfStake(agentId, exposure)`.
* After `transferFrom`, the registry moved the identity: `ownerOf == E`, `addressToAgentId[D] == 0`,
  `addressToAgentId[E] == 56`.
* **Original borrower D repaid loan #108** after the transfer. D's balance delta was exactly
  `collateral − (principal + interest)`.
* **New holder E repaid loan #109.** **Collateral went to `loan.borrower` (D), not to E.** The reputation
  call resolved through the new holder (`LoanCompleted` for agentId 56).
* An unrelated address was refused: **`"Not the borrower"`**.
* After the transfer neither party can open a new loan: D gets **`"Not a registered agent"`**, and M-1 stops
  E with **`"Borrow restricted to pool creator"`**.
* **F-01(e), new:** the identity is handed **back** E → D and the registry mapping follows —
  `ownerOf == D`, `addressToAgentId[D] == 56`, `addressToAgentId[E] == 0`. This both proves the transfer is
  symmetric and leaves the D/E pair reusable, which is what `AgentRegistryV2`'s 1:1 mapping requires
  (`"Recipient already owns an agent"` otherwise).

### F-02 — in-flight top-up refusal (agent #51)

`canTopUp` was `true` before the first top-up (case b); the 20 USDC top-up became a **pending tranche** stamped
after the loan started, and LA's qualified amount for loan #111 was **unchanged**. Once a second loan started
*after* the pending stamp, `canTopUp` went **false** and `supplyLiquidity` reverted
**`"Top-up would forfeit in-flight interest"`**. A lender with no position is never refused. `canTopUp`
returned `true` again once no loan was in flight. `canTopUp` was an exact oracle for the refusal throughout.
The two concurrent loans were sized from A's live head-room (**592.000000 USDC** each against a 2,100 USDC
limit), not a constant.

### F-07 — deactivated agent (agent #55)

`registry.deactivateAgent(55)` → `isAgentActive == false`. Then: `requestLoan` **REVERTS
`"Agent deactivated"`**; `repayLoan` **succeeds** (the closing path stays live); a third-party lender
**can still withdraw**; the creator **can withdraw its own stake** once `outstandingPrincipal == 0`.
`reactivateAgent` restored borrowing.

Per-pool conservation was exact for pools #51, #56 and #55 at the end of the scenario.

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

**No contract bug was found** — in the original run or in the 2026-09-23 re-validation. Every designed
behaviour in V1–V8 and L1–L7 matched the specification exactly, to the base unit and to the point. The four
behaviours that looked like breakage after the redeploy were all the shipped design working (§1b); each was
reproduced, traced to the contract line responsible, and the *scenario* was fixed rather than the
expectation relaxed. Three informational observations:

### O-1 · LOW / documentation — `minHoldForReputationReward` also gates the **credit ladder**, not just the bonus

**Reproduced on-chain at the live levers** (`scripts/e2e-v7/v9-minhold-ladder-coupling.js`; re-confirmed on the
redeployed stack 2026-09-23 with agent #53, loan #114, held 4 s).

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
the **V6.2 / V4** addresses (superseded pairs moved to `supersededDeployments` / `*_legacy` keys). The
pre-existing harness
`scripts/e2e/_lib.js` loads the `AgentLiquidityMarketplaceV6` and `ReputationManagerV3` **ABIs** against those
keys, so it now drives V6.2/V4 through the older ABIs. The overlapping read surface makes that mostly work
silently, which is the hazard. This suite avoids it by loading the V6.2/V4 ABIs explicitly and asserting
`VERSION()` before any write. **Recommendation:** pin the older suite to the `*_legacy` keys, or update its
ABIs.

A second instance of the same hazard was found and fixed during the re-validation:
`v7-migration-control-plane.js` read `cfg.agentLiquidityMarketplace_v61_legacy`, **a key that does not exist**
in the address file. `authorizedPools(undefined)` threw a `TypeError` that killed the script outright, which
is why its result JSON silently never refreshed. Scenario code should now derive addresses from the canonical
keys and iterate `supersededDeployments`, never name an alias by hand.

### O-3 · INFORMATIONAL — a V7 redeploy resets every agent's credit line, and the registry does not follow

`ReputationManagerV4` ships **no seeder** and the marketplace's migration latch is closed
(`migrationFinalized == true`, `seedPool` / `seedPosition` revert). A redeploy therefore puts every agent back
at `maxRepaidPrincipal == 0`, i.e. `creditLimit == bootstrapLimit` (100 USDC), while `AgentRegistryV2` is
**not** redeployed — agent NFTs, ids and the 1:1 `addressToAgentId` mapping all survive. So after a redeploy
an agent keeps its identity and its pool creator binding but loses its entire credit ladder.

That is deliberate (capacity must be re-demonstrated), but it has two operational consequences worth stating
in the migration runbook:

1. **Anything that assumes a pre-existing credit line breaks at the redeploy boundary** — this is exactly what
   took out three scenarios here, and the same holds for any integrator, dashboard or agent that caches a
   limit. Clients should read `calculateCreditLimit` / `requiredSelfStake` at call time, never cache them
   across a deployment change. `V7_CLIENT_MIGRATION.md` should say so explicitly.
2. **Registry state outlives the marketplace.** A half-finished flow that moved an agent NFT leaves it parked
   on the recipient; the next attempt fails with `"Recipient already owns an agent"`, and no marketplace
   redeploy clears it. Operationally, agent-NFT transfers need to be treated as a step that must be unwound,
   not retried.

No code change is recommended — the behaviour is correct. **Recommendation:** document both points in
`V7_MAINNET_MIGRATION_RUNBOOK.md` and `V7_CLIENT_MIGRATION.md`.

---

## 12. Staging funds spent

Arc **testnet** only. MockUSDC is a test token with no value; native is testnet gas. Figures are cumulative
across every run of this harness (tracked in `forensics/output/v7-model/e2e-v7-spend.json`, which enforces a
hard 30-native cap on anything moved out of the deployer).

| | amount |
|---|---|
| Native moved from the deployer to throwaway wallets (cumulative) | **19.139986** (hard cap in the harness: 30) |
| Native still held by the 22 throwaway wallets (recoverable) | **15.899150** |
| **Native actually consumed as gas by the throwaways** | **≈ 3.240836** |
| Native consumed by the deployer's own txs (funding, mints, owner levers) | **≈ 0.500685** |
| **Total native cost of all runs** | **≈ 3.741521** |
| Deployer native balance after | **75.389143** (was 95.029814 before the first run) |
| MockUSDC minted to throwaways (cumulative) | **33,680.000000** (minted by the deployer, which owns MockUSDC) |
| On-chain transactions sent (cumulative) | **815**, **138,515,221** gas total |

**The 2026-09-23 re-validation session alone** (fixing three stale scenarios, four one-shot scenarios, and
four full suite runs to convergence):

| | amount |
|---|---|
| Native moved from the deployer | **8.524424** |
| MockUSDC minted | **11,780.000000** |
| On-chain transactions | **532**, **84,907,206** gas |
| …of which **the final, definitive suite run** | **98** txs, **15,914,263** gas |

Making `v3` / `v5` / `v6` allocate a virgin agent per run costs roughly **1.6 native + ~2,900 MockUSDC per
suite run** in fresh wallets (`V3LADDER-n` ~1.2, `V6CREATOR-n` ~0.4; `V5LOANID-n` is reused until its score
head-room runs out). That is the price of the scenarios being honest rather than silently one-shot, and the
30-native cap remains the guard — at the current 19.14 there is room for roughly six more full runs before it
trips, at which point the unused 15.90 native should be swept back from the throwaway keys.

Throwaway wallet addresses are recorded in the (gitignored) wallets file and in each scenario's result JSON.
**No private key appears anywhere in this report.**

### End state of staging after the run

* **All 114 loans on the new marketplace are `REPAID` (state 2). No loan is left `ACTIVE`, `REQUESTED` or
  `DEFAULTED`.**
* **All five compressed clock levers restored to their live values** and read back by both
  `99-restore-levers.js` (7/7) and, independently, `v7-migration-control-plane.js` (30/30):
  `onTimeRepaymentBonus 10`, `bonusReferenceAmount 100 USDC`, `refDuration 604800 s`, rate limit `5 / 86400 s`,
  `minHoldForReputationReward 86400 s`. Never-touched levers still at shipped values:
  `creditMultiple 2`, `growthStep 100 USDC`, `bootstrapLimit 100 USDC`, `defaultLockout 180 d`,
  `platformFeeRate 100 bps`, `minSupplyAmount 10 USDC`, `bindBorrowToPoolCreator true`.
* Marketplace **not paused**, owner = the secure wallet `0x800e305A0caDdE6289dFDFEDF38218f45C06F72C`,
  `migrationFinalized == true`.
* **Nothing was broadcast to Arc mainnet (5042) or Base (8453).** The harness pins the provider to chainId
  5042002 and refuses to run on 5042 / 8453 / 1, and additionally refuses unless `VERSION()` reads
  `"V6.2"` / `"V4"`.

---

## 13. Re-running

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
node scripts/e2e-v7/run-all.js            # every on-chain scenario, in order, then restore + verify
node scripts/e2e-v7/run-all.js --local    # …and the local time-travel suite
npx hardhat run scripts/e2e-v7/local-time-travel.js   # local suite alone
```

Individual scenarios are independently re-runnable and idempotent **as of the 2026-09-23 pass** — before it,
`v3`, `v5`, `v6` and `00-setup` were one-shot and would silently fail on a second run (§1b). Wallets,
registrations, pools, reputation initialisation and pool funding are "ensure" operations; every borrow is
sized from live chain state rather than a constant; scenarios that need virgin state allocate an indexed
throwaway role and reuse it until it is actually consumed; leftover ACTIVE loans, a stale agent NFT parked on
a recipient and a stale pending tranche are all cleaned up in a preflight; and every scenario closes the loans
it opens. `00-setup.js` must run before V1–V6/V8 (it compresses the clock
levers and pumps agent B); `99-restore-levers.js` must run before `v7-migration-control-plane.js` and
`v9-minhold-ladder-coupling.js`, which are the two scripts that measure the live configuration.
Override the RPC with `E2E_V7_RPC_URL` (fallback `https://arc-testnet-rpc.publicnode.com`; the dRPC endpoint
rate-limits this host and is not used).
