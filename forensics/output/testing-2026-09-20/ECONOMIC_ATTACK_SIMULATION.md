# Quantitative adversarial economic simulation of the Specular reputation/credit model

**Finding under test:** F-04 (HIGH, design) — `forensics/output/audit-2026-09/INTERNAL_AUDIT_2026-09-19.md`
**Date:** 2026-09-21
**Target:** `AgentLiquidityMarketplaceV6.sol` (`VERSION() == "V6.1"`) + `ReputationManagerV3.sol` + `AgentRegistryV2.sol`, i.e. the exact source of the Arc mainnet stack (`0x358c5E69…`, `0x1577Eb99…`, `0x6F1EbF50…`).
**Execution:** local hardhat chain only (`chainId 31337`, `evm_increaseTime`/`evm_snapshot`). **Nothing was broadcast to any live network.**

---

## 0. Headline

| Question | Answer (simulated) |
|---|---|
| Days + cost for one self-lending agent to unlock a 25,000 USDC unsecured line, **OLD levers** (20 pts/day, minSupply 1) | **25.00 days, 0.12462 USDC of fees, 212.47 USDC of capital** |
| Same, **NEW levers** (5 pts/day, minSupply 10) | **100.00 days, 0.12460 USDC of fees, 62.47 USDC of capital** |
| What the lever tightening actually bought | **4× calendar time and nothing else.** Fee cost identical to 5 significant figures; capital requirement went *down* 3.4× |
| Does M-1 (`bindBorrowToPoolCreator`) stop Sybil fan-out? | **No.** It never fires. 5 agents reached 25,000 each in the same 100 days for 312.33 USDC of (recoverable) capital and 0.623 USDC of fees |
| Worst-case third-party lender loss per USDC of attacker cost | **200,642 : 1** (25,000 USDC lost for 0.1246 USDC of fees) |
| Steady-state extraction once at score 800 | **50,000 USDC every 28 days** (marginal fee cost **0.01342 USDC**, i.e. 3.7 million : 1) |
| Best configuration reachable with *any* owner lever | attacker pays **62.33 USDC + locks 2,012 USDC for 500 days** to unlock 25,000 |
| Hard ceiling on levers | **An attacker can never be made to pay more than `platformFeeRate/10000` = 5 % of what an honest agent pays for the same reputation.** Confirmed in all 40 feasible sweep configurations |
| Verdict | **Levers alone cannot fix F-04. A model change is required.** |

---

## 1. Methodology

### 1.1 What the harness does

`scripts/sim/lib/harness.js` deploys the **real** contracts (MockUSDC → AgentRegistryV2 → ReputationManagerV3 → AgentLiquidityMarketplaceV6) on an in-process hardhat chain, applies a parameterised lever set through the real owner setters (`setReputationRateLimit`, `setBonusReferenceAmount`, `setScoringParameters`, `setMinSupplyAmount`, `setPlatformFeeRate`, `setMinHoldForReputationReward`, `setBindBorrowToPoolCreator`, `setMigrationFinalized`), and then drives actors over simulated months.

Two lever sets are pre-defined and used throughout:

```
LEVERS_OLD  maxGain 20 / 86400s, minSupply  1 USDC, fee 100 bps, minHold 86400, M-1 on, ref 100 USDC
LEVERS_NEW  maxGain  5 / 86400s, minSupply 10 USDC, fee 100 bps, minHold 86400, M-1 on, ref 100 USDC
```

`LEVERS_NEW` is the live Arc mainnet configuration (CLAUDE.md, tightened 2026-09-19).

Instrumented per cycle: reputation score, credit limit, collateral tier, cumulative `accumulatedFees` delta, **capital locked** (`startUSDC − balanceOf(actor)` — USDC the protocol holds on the actor's behalf: pool principal + collateral − disbursed loan), cumulative `gasUsed`, and a **realised cost** figure taken after a full unwind (repay every loan, `claimInterest`, `withdrawLiquidity`) so that only genuinely unrecoverable outflows are counted.

### 1.2 The attacker's cheapest cycle (derived, then measured)

The on-time bonus in `ReputationManagerV3.recordLoanCompletion` is

```
bonus = onTimeRepaymentBonus · min(amount, bonusReferenceAmount) / bonusReferenceAmount
```

clamped by the remaining `maxReputationGainPerWindow` budget. Interest is `principal · rate · duration / 365 days`, and the fee is `interest · platformFeeRate / 10000`. Below `bonusReferenceAmount`, **both bonus and fee are linear in principal, so the USDC-per-reputation-point cost is scale-invariant** — loan size is irrelevant to cost and matters only for capital. The optimum is therefore the *smallest* principal that exactly saturates the daily budget, on the *shortest* allowed term (`MIN_LOAN_DURATION` = 7 days), repaid as soon as `minHoldForReputationReward` allows (an early repayment still pays the full nominal 7-day interest, so holding longer costs capital and buys nothing).

Under `LEVERS_NEW` that is exactly **one 50 USDC / 7-day loan per day**. Under `LEVERS_OLD`, **two 100 USDC loans per day**. The harness computes this automatically (`cyclePlan`).

Because the attacker is the pool's only lender, `_distributeInterest` returns 100 % of `lenderInterest` to it as `earnedInterest`. **The only unrecoverable outflow is the platform fee** (plus rounding dust and gas).

### 1.3 Validation of the one projection used

The lever sweep (§7) measures cost/point in a 4-window steady state and projects to 500 points (100 → 600) using the tier blend 300 pts @ 15 % APR + 200 pts @ 10 % APR = 433.33 "15 %-equivalent" points. Checked against the full 100-cycle run:

| | projected | full simulation | error |
|---|---|---|---|
| fees 100 → 600, `LEVERS_NEW` | 0.124627 USDC | 0.124600 USDC | 0.02 % |
| days 100 → 600, `LEVERS_NEW` | 100.0 | 100.0023 | 0.002 % |

Everywhere else in this report the numbers are direct simulation output. Results explicitly marked *(analytic)* are derivations; everything else was run.

---

## 2. Strategy (a)/(b) — solo self-lender, OLD vs NEW levers

Source: `scripts/sim/run-farm.js` → `scripts/sim/out/farm.json`. One agent, own pool, own liquidity, farmed to 800 with milestones recorded at every tier.

| | **OLD** (20 pts/day, minSupply 1) | **NEW** (5 pts/day, minSupply 10) | change |
|---|---|---|---|
| cheapest saturating cycle | 2 × 100 USDC / 7 d | 1 × 50 USDC / 7 d | — |
| **days to score 600 (25,000 USDC, 0 % collateral)** | **25.00** | **100.00** | 4.0× slower |
| **platform fees paid to reach 600** | **0.12462 USDC** | **0.12460 USDC** | **1.0000× (no change)** |
| capital locked at 600 | 212.47 USDC | 62.47 USDC | 3.4× *less* |
| gas to 600 | 34,132,156 | 69,504,136 | 2.0× more |
| **days to score 800 (50,000 USDC)** | **35.00** | **140.00** | 4.0× slower |
| fees to 800 | 0.15146 USDC | 0.15144 USDC | no change |
| capital locked at 800 | 215.15 USDC | 65.15 USDC | 3.4× less |

**The single most important line in this report is the fee row.** Tightening `maxReputationGainPerWindow` from 20/day to 5/day changed the attacker's monetary cost by 0.02 % — it is a *rate* limit, not a *price*. It buys calendar time and nothing else. `setMinSupplyAmount(10e6)` had **zero** effect: the attacker needs 50 USDC in its own pool regardless, so the 10 USDC floor is never binding (confirmed across the whole sweep — every `ms10` row is bit-identical to its `ms100` twin).

Also measured: `minHoldForReputationReward = 86400` is **economically non-binding** under a 1-day rate-limit window. The window already forces a ≥1-day cadence, and because interest is charged on the *nominal* 7-day term regardless of when the loan is repaid, holding for one day instead of seven costs the attacker nothing extra while using 7× less capital. M-2 only becomes a real lever if it exceeds the rate-limit window (see §7).

---

## 3. Strategy (c) — Sybil fan-out, and what M-1 actually does

Source: `scripts/sim/run-sybil.js` → `out/sybil.json`. Five agents (five EOAs — `AgentRegistryV2` allows one agent per address), each creating its **own** pool, farmed in lockstep under `LEVERS_NEW` with `bindBorrowToPoolCreator = true`.

| agent | agentId | score after 100 days | credit limit | capital locked | gas |
|---|---|---|---|---|---|
| sybil0 | 1 | 600 | 25,000 USDC | 62.4657 USDC | 69,415,158 |
| sybil1 | 2 | 600 | 25,000 USDC | 62.4657 USDC | 69,363,870 |
| sybil2 | 3 | 600 | 25,000 USDC | 62.4657 USDC | 69,363,870 |
| sybil3 | 4 | 600 | 25,000 USDC | 62.4657 USDC | 69,363,870 |
| sybil4 | 5 | 600 | 25,000 USDC | 62.4657 USDC | 69,363,870 |
| **total** | | | **125,000 USDC** | **312.33 USDC** | 346,870,638 |

Total fees for the whole fan-out: **0.623 USDC**.

**M-1 does not constrain this at all, and cannot.** `requestLoan` always draws from `agentPools[addressToAgentId(msg.sender)]` — an agent can only ever borrow from its *own* pool. `bindBorrowToPoolCreator` therefore only compares `pool.agentAddress` with `msg.sender`, which differ solely after an **agent-NFT transfer**. M-1 is an anti-NFT-resale control; it has no bearing on an operator who simply registers N agents. The sim confirmed the M-1 branch never fires for any Sybil.

Scaling is perfectly linear and parallel: `windowStart`/`gainedInWindow` are keyed by `agentId`, so N agents each get their own 5 pts/day. **Per-agent marginal cost of a 25,000 USDC credit line: 62.47 USDC of recoverable capital + 0.1246 USDC of fees + ~69.4 M gas.** The only real constraint is gas (which on Arc is paid in USDC — this report deliberately quotes gas units rather than inventing an Arc gas price).

---

## 4. Strategies (d)/(e) — bust-out timing, repeat cadence, and re-farm cost

### 4.1 A bust-out takes 100 % of third-party liquidity, and lenders cannot escape

Source: `run-farm.js::bustOut`, `run-lender.js::L1_L3_worstCase`.

With five honest lenders supplying 5,000 USDC each to the (now score-600) attacker's pool:

| | at score 600 | at score 800 |
|---|---|---|
| credit limit / collateral | 25,000 USDC / 0 % | 50,000 USDC / 0 % |
| attacker's own seed withdrawn first | 50 USDC | 50 USDC |
| drawn | 25,000 USDC | 50,000 USDC |
| **attacker gain** | **25,000 USDC** | **50,000 USDC** |
| lender recovery after liquidation | **0 for all five** | **0 for all five** |
| a warned lender's `withdrawLiquidity` before liquidation | **reverts `Insufficient pool liquidity`** | same |
| reputation penalty | **100 pts** (600 → 500) | **100 pts** (800 → 700) |

The withdrawal-race test is important: once the attacker has drawn the pool down, `pool.availableLiquidity == 0` and **every lender is trapped**. The D4 pro-rata socialisation then distributes a 100 % loss — it is working correctly, but by that point there is nothing left to allocate fairly.

When lenders supply *more* than the credit limit the loss is bounded by the limit, and the surplus becomes a **FIFO race** (L1/L3, 40,000 supplied vs a 25,000 limit):

| lender | supplied | withdrawn before liquidation | left | loss |
|---|---|---|---|---|
| L0 | 10,000 | 10,000 | 0 | **0** |
| L1 | 10,000 | 5,000 | 0 | 5,000 |
| L2 | 10,000 | 0 | 0 | 10,000 |
| L3 | 10,000 | 0 | 0 | 10,000 |

**Total lender loss 25,000 USDC for 0.1246 USDC of attacker cost = 200,642 : 1.**

### 4.2 Is it optimal to default at 600 or push to 800?

First cycle: 25,000 at day 108 = 231 USDC/day; 50,000 at day 148 = 338 USDC/day → **800 wins even on the first pass**. It wins far more decisively in steady state, because `recordDefault` charges a **flat** `defaultPenaltyLarge` (100 pts) for *any* loan above `largeLoanThreshold`. A 50,000 default costs exactly as many points as a 10,001 one.

Measured steady state (`run-sybil.js::repeatBustOut`, three rounds at score 800, a fresh honest lender each round):

| round | climb cycles | day of default | extracted | score after | cumulative fees |
|---|---|---|---|---|---|
| 1 | 140 | 148 | 50,000 | 700 | 0.15144 USDC |
| 2 | 20 | 176 | 50,000 | 700 | 0.16486 USDC |
| 3 | 20 | 204 | 50,000 | 700 | 0.17828 USDC |

**150,000 USDC extracted in 204 days. Steady state = 50,000 USDC every 28 days = 1,785.71 USDC/day, at a marginal cost of 0.01342 USDC per 50,000 (≈ 3.7 million : 1).** The penalty does not even cost a tier: 800 → 700 stays inside the 0 %-collateral, 50,000-limit band, so the attacker never has to re-collateralise.

### 4.3 Re-farm cost after a default (the real penalty scaling)

`recordDefault`'s penalty is a step function, not a scaling: `penalty = amount > largeLoanThreshold ? defaultPenaltyLarge : defaultPenaltyBase`. Measured for a 25,000 USDC default (600 → 500):

| | OLD levers | NEW levers |
|---|---|---|
| penalty | 100 pts | 100 pts |
| days to re-reach 600 | **5.00** | **20.00** |
| fees to re-reach 600 | 0.01917 USDC | 0.01916 USDC |

Even at the owner's maximum (`setScoringParameters(10, 200, 300, …)` → 300 pts for a large default) the re-farm is only 60 days at 5 pts/day, and the fee cost stays trivial (0.058 USDC — swept in §7).

---

## 5. Strategy (f) — honest agents, and the honest-vs-attacker ratio

Source: `scripts/sim/run-honest.js` → `out/honest.json`. Every honest profile borrows from a pool funded by a **third-party lender**, so it pays the *full* interest; only the attacker recaptures it.

| profile | loan | levers | days to 600 | realised cost | of which protocol fees |
|---|---|---|---|---|---|
| **attacker** (self-lender) | 50 USDC / 7 d | NEW | **100.0** | **0.12460** | 0.12460 |
| H3 reputation-optimising honest agent (7-d term repaid after 1 d) | 50 USDC | NEW | 100.0 | **12.4657** | 0.1246 |
| H1 7-day working capital, held to term | 50 USDC | NEW | **699.3** | 12.4657 | 0.1246 |
| H2 30-day working capital, held to term | 50 USDC | NEW | **2,999.3** | 53.4246 | 0.5342 |
| H4 real 1,000 USDC / 30-day borrower | 1,000 USDC | NEW | 2,999.3 | **1,068.49** | 10.6849 |
| H5 borrows its full tier limit, 30-day | tier limit | NEW | 2,999.3 | **6,000.00** | 60.0000 |
| H1 | 100 USDC | OLD | 349.7 | 12.4657 | 0.1246 |
| H2 | 100 USDC | OLD | 1,499.7 | 53.4246 | 0.5342 |
| H3 | 100 USDC | OLD | 50.0 | 12.4657 | 0.1246 |

### The ratio

* **Cost:** for identical behaviour (H3 vs attacker) the attacker pays **1/100th** — exactly `platformFeeRate/10000`. For a *realistic* borrower (H5, borrowing its actual tier limit on 30-day terms) the ratio is **6,000 / 0.1246 = 48,150 : 1**.
* **Time:** equal *only* if the honest agent behaves like the attacker (repay after one day while paying seven days' interest — i.e. pay 7× for the credit it uses). A genuine 7-day borrower needs **7.0×** longer; a 30-day borrower **30.0×** longer (8.2 years).
* **The tightening was regressive.** It slowed the attacker 4× (25 → 100 days) but also slowed every fixed-tenor honest agent 2× (H1 350 → 699 days, H2 1,500 → 2,999 days), because the per-loan bonus is clamped from 10 to 5. The attacker, who controls its own cadence, absorbs a rate limit; an honest agent whose loan tenor is set by its business cannot.

Three structural honest-agent frictions surfaced while building these runs:

1. **A loan repaid at or one second past `endTime` earns zero reputation** (`onTime = block.timestamp <= loan.endTime`, no partial credit) while still paying the full term's interest. An agent that repays exactly at term gets nothing. Every honest profile above had to repay 10 minutes early to score at all.
2. **Reputation cost rises linearly with honest loan size.** Above `bonusReferenceAmount` the bonus caps but the interest keeps scaling: H1 (50 USDC loans) pays 12.47 USDC for 500 points; H5 (tier-limit loans) pays 6,000 USDC for the *same* 500 points — 481× more for identical reputation.
3. An honest agent that needs more than 1,000 USDC **cannot start**: at score 100 the tier limit is 1,000 USDC and `requestLoan` reverts `Exceeds credit limit`. Observed directly when attempting a 5,000 USDC honest profile.

---

## 6. Lender-side attacks, and verification of the V6.1 fixes

Source: `scripts/sim/run-lender.js` → `out/lender.json`.

| id | test | result |
|---|---|---|
| **L1/L3** | worst-case loss per unit attacker cost | **200,642 : 1**; loss is bounded by the credit limit, the surplus is a FIFO race (§4.1) |
| **L2** | can a warned lender exit before liquidation? | **No** — `withdrawLiquidity` reverts `Insufficient pool liquidity` once the pool is drawn down |
| **L4** | F-05 socialised-loss path beyond Σ principal | **Works.** 56.9589 USDC of unclaimed interest socialised exactly; `claimInterest` afterwards reverts rather than leaving an unbacked FCFS claim |
| **L5** | F-02 mid-loan top-up | **FIXED.** A 1 USDC top-up on a 10,000 USDC position mid-loan kept the full 10,000 qualified; the honest lender earned 56.9020 of 56.9591 USDC. The self-lending borrower's 10 USDC seed recaptured only **0.0999 %** — exactly its pro-rata share, no more |
| **L6** | F-03 late repayment | **FIXED.** See table below |
| **L7** | yield/loss asymmetry for lenders who join mid-loan | **CONFIRMED — new finding, see below** |

### L6 — late-repayment economics (F-03 verification)

10,000 USDC, 7-day term:

| | interest charged | chargeable days | reputation bonus |
|---|---|---|---|
| on time | 13.4247 USDC | 7 | **+5** |
| 10 days late | 32.6027 USDC | 17 | **0** |
| 30 days late | 70.9589 USDC | 37 | **0** |
| 90 days late | 70.9589 USDC | 37 (capped) | **0** |

F-03 is genuinely fixed: 30 days of overdue credit now costs **+57.53 USDC** (5.3× the nominal interest), so the profit motive for front-running liquidation is gone. **Two residuals remain:**

* `LATE_INTEREST_CAP = 30 days` — past `duration + 30 days` interest stops accruing and overdue credit is free again. A borrower who intends to default anyway is unaffected.
* There is still **no reputation penalty for lateness** — `ReputationManagerV3` exposes no hook, so the only sanction is losing the bonus. `lateRepayCount`/`lateSecondsTotal` are recorded on-chain but nothing consumes them.

### L7 — new finding (MEDIUM): a lender who joins while a loan is open bears loss it could never earn on

The W1 qualification rule (`depositTimestamp <= loan.startTime`) correctly prevents a JIT lender from capturing interest on an already-open loan. But D4 socialisation reduces **every** current lender's principal pro-rata when that loan defaults. Measured:

| lender | supplied | qualified for the in-flight loan | left after default |
|---|---|---|---|
| early (supplied before the loan) | 10,000 | 10,000 | 5,000 |
| **late joiner (supplied after)** | 10,000 | **0** | **5,000** |

The late joiner had **zero** upside on that loan and took an identical 50 % loss. Two consequences: (i) it is a systematic transfer from new lenders to existing ones; (ii) an agent can open a large loan *first* and solicit liquidity afterwards, knowing new capital absorbs the loss without ever having been paid for the risk. Suggested fix: socialise a loan's loss only across the principal that was **qualified at that loan's `startTime`** (the data is already available via `qualifiedAmountAt`).

### One more bypass worth recording

The F-02 top-up guard (`Top-up would forfeit in-flight interest`) only constrains an **existing** lender position. Supplying from a **fresh address** is always allowed and costs only `minSupplyAmount` + gas. The M1 attacker in §8 used 24 fresh lender addresses to grow its pool while loans were in flight. `MAX_LENDERS_PER_POOL = 50` is the only bound.

---

## 7. The lever frontier

Source: `scripts/sim/run-sweep.js` → `out/sweep.json`. Full factorial over
`maxGainPerWindow ∈ {20, 5, 1}/day × minSupplyAmount ∈ {10, 100} USDC × platformFeeRate ∈ {100, 500} bps × minHoldForReputationReward ∈ {1, 7} days × bonusReferenceAmount ∈ {100, 1000, 10000} USDC`, with `defaultPenaltyBase/Large` already at their maxima (200/300). 72 configurations; each measured in a real steady state with a **staggered loan pipeline** of depth `ceil(minHold/window)` so that a long `minHold` costs capital rather than calendar time (`MAX_ACTIVE_LOANS_PER_AGENT = 10` bounds the pipeline).

**40 configurations are feasible. 32 are bootstrap-infeasible** — the principal needed to saturate the gain budget exceeds the 1,000 USDC bottom-tier credit limit, so *no* agent, honest or hostile, can build reputation at all. This is a hard structural cap: **`bonusReferenceAmount × maxGainPerWindow / onTimeRepaymentBonus ≤ 1,000 USDC`**, which bounds the strongest anti-farming lever there is.

### The invariant that settles the question

Across **all 40 feasible configurations**, the attacker's cost as a percentage of the honest cost for the same reputation was measured at **0.998 %, 0.999 %, 1.000 % (at 100 bps) and 4.998 %, 4.999 %, 5.000 % (at 500 bps)** — never anything else. That is the analytic law

```
attacker cost / honest cost  =  platformFeeRate / 10000
```

(the honest borrower pays the whole interest; the self-lender recaptures all of it but the protocol fee), and `setPlatformFeeRate` is capped at **500 bps** in the contract. **No lever setting can make an attacker pay more than 5 % of an honest agent's price for the same credit line, and no lever other than the fee moves the ratio at all.**

### Selected frontier rows (projected 100 → 600, validated per §1.3)

| rate limit | minSupply | fee | minHold | bonusRef | days | attacker USDC | honest USDC | attacker % of honest | attacker capital | capital / 25k prize | re-farm after 25k default |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 20/d | 10 | 100 | 1 d | 100 | 25 | 0.1246 | 12.47 | 1.0 % | 402 | 1.6 % | 15 d |
| **5/d (LIVE)** | **10** | **100** | **1 d** | **100** | **100** | **0.1246** | **12.47** | **1.0 %** | **101** | **0.4 %** | **60 d** |
| 5/d | 10 | 500 | 1 d | 100 | 100 | 0.6232 | 12.47 | 5.0 % | 101 | 0.4 % | 60 d |
| 5/d | 10 | 500 | 7 d | 100 | 100 | 0.7123 | 14.25 | 5.0 % | 701 | 2.8 % | 60 d |
| 5/d | 10 | 500 | 1 d | 1,000 | 100 | 6.2328 | 124.66 | 5.0 % | 1,006 | 4.0 % | 60 d |
| 1/d | 10 | 500 | 7 d | 1,000 | 500 | 7.1231 | 142.47 | 5.0 % | 1,401 | 5.6 % | 300 d |
| **1/d** | **10** | **500** | **1 d** | **10,000** | **500** | **62.33** | **1,246.58** | **5.0 %** | **2,012** | **8.0 %** | **300 d** |
| 1/d | 10 | 100 | 1 d | 10,000 | 500 | 12.47 | 1,246.58 | 1.0 % | 2,012 | 8.0 % | 300 d |

*(`minSupplyAmount` rows are omitted where identical — every `ms100` row equals its `ms10` twin to the last digit. `minSupplyAmount` has no effect on any metric in this model.)*

### Recommended lever set (the best available, and still not enough)

```
rep.setReputationRateLimit(1, 86400)                     // 1 pt/day
rep.setBonusReferenceAmount(1000e6)                      // 1,000 USDC. (10,000 is bootstrap-infeasible
                                                         //  at maxGain 5; safe only at maxGain 1)
rep.setScoringParameters(10, 200, 300, 1000e6)           // max penalties; lower the large-loan threshold
                                                         //  to 1,000 so ANY meaningful default costs 300 pts
mkt.setPlatformFeeRate(500)                              // 5 % — the ONLY lever that moves the ratio
mkt.setMinHoldForReputationReward(7 days)                // forces a 7-deep pipeline → 7× capital
mkt.setMinSupplyAmount(...)                              // irrelevant here; leave at 10 USDC for F-06
```

Justification, all simulated: attacker cost to unlock 25,000 rises from **0.1246 → 7.12 USDC** (57×), capital from **62 → 1,401 USDC** (22×), time from **100 → 500 days** (5×), re-farm after a bust-out from **20 → 300 days** (15×). Honest cost rises from 12.47 → 142.47 USDC and honest time from 699 → 3,500 days for a 7-day-tenor agent.

**That trade is not worth taking.** It multiplies honest-agent friction by the same factor as attacker friction (the ratio stays pinned at 5 %), pushes any real borrower past a ten-year horizon, and *still* leaves a 25,000 USDC prize available for 7 USDC of fees and 1,401 USDC of fully recoverable capital.

---

## 8. Verdict, and the model change

### 8.1 Verdict

**Levers alone are insufficient. The model must change.** The strongest supporting number: *across every one of the 40 feasible lever configurations, the attacker's cost was exactly `platformFeeRate/10000` of the honest agent's cost for identical reputation — capped by the contract at 5 %.* The root cause is structural, not parametric:

1. Reputation is priced in **interest paid**, but a self-lender **recaptures the interest** and forfeits only the protocol fee.
2. Self-lending is **not distinguishable on-chain**. Excluding `loan.borrower` from the interest share catches nothing: a Sybil lender is a different address supplying real USDC, indistinguishable from an honest lender. Any address-based "non-self interest" rule is bypassed for free.
3. Every attacker input is **recoverable** — pool principal, collateral, and their own share of interest all come back. Only fees and gas are sunk, and both are set by levers that hit honest agents identically.
4. The default penalty is a **flat step**, so the sanction does not scale with the damage, and it costs **no tier** at the top (800 → 700 keeps 0 % collateral and the 50,000 limit).

### 8.2 Ranked proposals

#### M1 — principal-time bonus + exposure bounded by demonstrated repaid volume + scaling penalty with lockout  *(recommended; simulated)*

Implemented in `contracts/sim/ReputationManagerV4Sim.sol` (a drop-in replacement: identical external selectors, so `AgentLiquidityMarketplaceV6` constructs against it unchanged). Three changes:

1. `bonus = onTimeBonus · min(amt,ref)/ref · min(held,refDuration)/refDuration` — hold time now counts. Derived inside the manager from `recordBorrow` timestamps, **no marketplace change required** for this part.
2. `creditLimit = min(tierLimit, max(bootstrapLimit, creditMultiple · maxRepaidPrincipal))` — an agent may only borrow a multiple of the single largest loan it has already repaid.
3. `recordDefault`: penalty scales with size (`defaultPenaltyLarge · amount / largeLoanThreshold`), `maxRepaidPrincipal` resets to 0, and the credit limit is forced to 0 for `defaultLockout`.

**Simulated** (`run-model.js`, `run-model-k1.js` → `out/model.json`, `out/model-k.json`), same greedy attacker, same levers:

| metric | V3 (live) | **M1, k = 2** | M1, k = 4 |
|---|---|---|---|
| days to a 25,000 USDC line | 100 | **131** | 125 |
| **peak attacker capital** | **62.47 USDC** | **9,020.74 USDC** | 3,518.28 USDC |
| capital as a share of the prize | 0.25 % | **36.1 %** | 14.1 % |
| fees | 0.1246 | 0.9638 | 0.4892 |
| bust-out gain | 25,000 | 25,000 | — |
| penalty for the 25,000 default | 100 pts | **250 pts** | — |
| credit limit immediately after | 25,000 (600 → 500 tier) | **0** | — |
| `maxRepaidPrincipal` after | n/a | **reset to 0** | — |
| **repeat cadence** | **28 days** | **≥ 180 days** (lockout) **+ a fresh 131-day ladder** | — |
| steady-state extraction | **1,785.71 USDC/day** | **≤ 139 USDC/day** *(analytic: 25,000 / 180)* | — |

Honest impact, measured on the same model: a 7-day-to-term honest agent reaches 600 in 839 days for 15.10 USDC (vs 699 days / 12.47 under V3 — 20 % slower, 21 % dearer, because terms must now exceed the hold). An honest agent that actually wants a 25,000 line reaches it in **131 days for 96.27 USDC** — versus **2,999 days** under V3. **M1 is a large net improvement for real borrowers**, because capacity now grows with demonstrated usage instead of with a pure reputation clock.

Two findings from implementing it, both of which must be carried into production:

* **`creditMultiple = 1` deadlocks.** With `limit = 1 × maxRepaid`, head-room can never exceed the record, so the ladder cannot grow: the k=1 run stalled at a 100 USDC limit after 500 days. A production version needs `limit = max(bootstrap, k·maxRepaid + growthStep)` with `k > 1` or an explicit additive step.
* Matching a repayment to its open-loan record **by amount** is ambiguous with concurrent equal-sized loans. The scratch contract uses oldest-first FIFO (the reading most generous to the borrower); **production must pass `loanId` from the marketplace**, which *is* a marketplace-side signature change.

**M1 does not close the attack by itself** — the attacker still nets 25,000 for 9,021 USDC of *recoverable* capital. It must be paired with M2.

#### M2 — subordinate and lock the borrower's own stake  *(marketplace change; analytic)*

The bust-out in every simulation begins with the attacker **withdrawing its own seed** from its own pool. Make that impossible and make it first-loss:

* while `outstandingPrincipal[agentId] > 0`, `withdrawLiquidity` is refused for `positions[agentId][pool.agentAddress]`;
* on default, that position absorbs the loss **before** `_socializeLoss` touches anyone else;
* the 0 %-collateral tiers require `selfStake ≥ outstandingPrincipal / creditMultiple`.

Combined with M1 at `k = 2`, the attacker's 9,021 USDC becomes unrecoverable: net gain 25,000 − 9,021 = 15,979 (still positive). As `k → 1⁺` the required self-stake approaches the credit limit and expected value goes to zero — which is the honest conclusion that **an unsecured line to a pseudonymous agent can only be made EV-negative by backing it with something the protocol can seize.** Pick `k` to *price* the residual risk; do not pretend it is zero.

#### M3 — anchor reputation to unrecoverable spend  *(cleanest, but expensive for honest agents; analytic)*

Score/limit as a function of **cumulative platform fees paid** rather than repayment count: `creditLimit = min(tierLimit, feeMultiple · cumulativeFeesPaid)`. Fees are the *only* flow no participant can recapture, so attacker cost = honest cost **by construction** — it is the one design that removes the 100× gap rather than shrinking it. It needs the marketplace to pass the fee amount into `recordLoanCompletion` (signature change). The catch is calibration: at `feeMultiple = 50` a 25,000 line costs 500 USDC of fees, which at 100 bps means 50,000 USDC of interest paid — years of genuine borrowing. Practical only alongside an explicit, non-refundable **credit-line subscription fee** (pay X USDC up front to raise the limit), which is honest-friendly and attacker-hostile but still prices the line at only a fraction of it.

#### M4 — move the trust decision to lenders and to ERC-8004  *(structural)*

Per-lender opt-in exposure caps (a lender chooses how much of *its* capital any one agent may draw, instead of the protocol granting a global limit), plus the already-present but unwired `ValidationRegistry` for attestation-gated access to the 0 %-collateral tiers. This is the only direction that makes the residual loss a **priced, consented risk** rather than a protocol-level promise.

### 8.3 Recommended sequence

1. **Do not solicit third-party lender liquidity** for any 0 %-collateral agent until M1 + M2 ship. Today's live exposure is `min(pool liquidity, credit limit)` per farmed agent, fully recoverable by the agent, with lenders unable to exit.
2. Ship **M1 + M2** together (ReputationManager redeploy + marketplace changes for `loanId` pass-through and self-stake subordination). Fold in the L7 socialisation-basis fix and a late-repayment reputation penalty in the same redeploy.
3. Meanwhile, as damage limitation — not a fix — cap exposure directly: keep the tier table but hard-cap the top tiers (e.g. 600 → 2,500 USDC, 800 → 5,000 USDC) so a bust-out is survivable. **A tier-table cap is worth more than every lever in §7 combined**, because it bounds the prize instead of pricing the path.
4. Raise `platformFeeRate` to 500 bps only if the revenue is wanted for its own sake; as a security control it buys a 5× attacker-cost increase and nothing structural.

---

## Appendix A — files, evidence, and how to reproduce

All harness code and every raw result JSON are preserved at
`forensics/output/testing-2026-09-20/economic-sim/` (and in the working branch at `scripts/sim/` + `contracts/sim/`).

| file | purpose |
|---|---|
| `scripts/lib/harness.js` | deploys the real stack, lever sets, actor/gas/capital accounting, time travel |
| `scripts/lib/strategies.js` | `cyclePlan` (cheapest saturating cycle), `farmCycle`, `unwind`, `soloSelfLender`, `honestBorrower` |
| `scripts/run-farm.js` | strategies (a)(b)(d)(e) → `out/farm.json` |
| `scripts/run-sybil.js` | strategy (c) + repeat bust-out cadence → `out/sybil.json` |
| `scripts/run-honest.js` | strategy (f), profiles H1–H5 → `out/honest.json` |
| `scripts/run-lender.js` | lender-side L1–L7, F-02/F-03/F-05 verification → `out/lender.json` |
| `scripts/run-sweep.js` | 72-config lever frontier → `out/sweep.json` |
| `scripts/run-model.js`, `run-model-k1.js` | M1 attacker + honest + `creditMultiple` variants → `out/model.json`, `out/model-k.json` |
| `contracts/ReputationManagerV4Sim.sol` | the M1 scratch contract (drop-in, selector-compatible with V3) |

To port: copy `economic-sim/scripts/` to `scripts/sim/` and `economic-sim/contracts/ReputationManagerV4Sim.sol` to `contracts/sim/`, then:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npx hardhat compile
npx hardhat run scripts/sim/run-farm.js      # ~6 min
npx hardhat run scripts/sim/run-honest.js    # ~12 min
npx hardhat run scripts/sim/run-sybil.js     # ~15 min
npx hardhat run scripts/sim/run-lender.js    # ~6 min
npx hardhat run scripts/sim/run-sweep.js     # ~12 min
npx hardhat run scripts/sim/run-model.js     # ~10 min
npx hardhat run scripts/sim/run-model-k1.js  # ~15 min
```

Only the default in-process `hardhat` network is used. The harness creates funded random EOAs (`ethers.Wallet.createRandom()`) because 20 default signers are not enough; the owner funds each with 5 ETH, so long sweeps must not raise that figure (10,000 ETH total budget).

## Appendix B — `scripts/sim/lib/harness.js`

```javascript
const { ethers, network } = require("hardhat");

const DAY = 86400;
const U = (n) => BigInt(Math.round(Number(n) * 1e6)); // USDC (6 dec)
const f6 = (x) => Number(x) / 1e6;

async function advance(seconds) {
  if (seconds <= 0) return;
  await network.provider.send("evm_increaseTime", [Math.floor(seconds)]);
  await network.provider.send("evm_mine");
}
async function now() { return (await ethers.provider.getBlock("latest")).timestamp; }

/** Default levers = Arc mainnet post-audit (2026-09) config. */
const LEVERS_NEW = {
  name: "NEW (Arc mainnet post-audit)",
  maxGainPerWindow: 5, gainWindow: DAY, minSupply: U(10), platformFeeRate: 100,
  minHold: DAY, bindM1: true, bonusRef: U(100), onTimeBonus: 10,
  penaltyBase: 50, penaltyLarge: 100, largeThreshold: U(10000),
};
const LEVERS_OLD = { ...LEVERS_NEW, name: "OLD (pre-tightening)", maxGainPerWindow: 20, minSupply: U(1) };

let _accIdx = 0;
async function newActor(ctx, label, usdcAmount) {
  const w = ethers.Wallet.createRandom().connect(ethers.provider);
  await ctx.owner.sendTransaction({ to: w.address, value: ethers.parseEther("5") });
  if (usdcAmount && usdcAmount > 0n) await ctx.usdc.mint(w.address, usdcAmount);
  const a = { label: label || `actor${_accIdx++}`, signer: w, address: w.address,
              gas: 0n, startUsdc: usdcAmount || 0n, agentId: 0n };
  await track(a, ctx.usdc.connect(w).approve(await ctx.mkt.getAddress(), ethers.MaxUint256));
  return a;
}
async function track(actor, txPromise) {
  const tx = await txPromise; const r = await tx.wait(); actor.gas += r.gasUsed; return r;
}

async function deployStack(levers) {
  const [owner] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  await usdc.waitForDeployment();
  const registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
  await registry.waitForDeployment();
  const rep = await (await ethers.getContractFactory(levers.repContract || "ReputationManagerV3"))
                      .deploy(await registry.getAddress());
  await rep.waitForDeployment();
  const mkt = await (await ethers.getContractFactory(levers.mktContract || "AgentLiquidityMarketplaceV6"))
                      .deploy(await registry.getAddress(), await rep.getAddress(), await usdc.getAddress());
  await mkt.waitForDeployment();
  await (await rep.authorizePool(await mkt.getAddress())).wait();
  await (await rep.setReputationRateLimit(levers.maxGainPerWindow, levers.gainWindow)).wait();
  await (await rep.setBonusReferenceAmount(levers.bonusRef)).wait();
  await (await rep.setScoringParameters(levers.onTimeBonus, levers.penaltyBase,
                                        levers.penaltyLarge, levers.largeThreshold)).wait();
  await (await mkt.setMinSupplyAmount(levers.minSupply)).wait();
  await (await mkt.setPlatformFeeRate(levers.platformFeeRate)).wait();
  await (await mkt.setMinHoldForReputationReward(levers.minHold)).wait();
  await (await mkt.setBindBorrowToPoolCreator(levers.bindM1)).wait();
  await (await mkt.setMigrationFinalized()).wait();
  return { owner, usdc, registry, rep, mkt, levers };
}

async function makeAgent(ctx, actor, uri) {
  await track(actor, ctx.registry.connect(actor.signer).register(uri || `ipfs://${actor.label}`, []));
  actor.agentId = await ctx.registry.addressToAgentId(actor.address);
  await track(actor, ctx.rep.connect(actor.signer)["initializeReputation()"]());
  await track(actor, ctx.mkt.connect(actor.signer).createAgentPool());
  return actor;
}
async function score(ctx, a)         { return Number(await ctx.rep["getReputationScore(uint256)"](a.agentId)); }
async function creditLimit(ctx, a)   { return await ctx.rep["calculateCreditLimit(address)"](a.address); }
async function collateralPct(ctx, a) { return Number(await ctx.rep.calculateCollateralRequirement(a.address)); }
/** USDC the protocol currently holds on this actor's behalf. */
async function lockedCapital(ctx, a) { return a.startUsdc - (await ctx.usdc.balanceOf(a.address)); }

module.exports = { DAY, U, f6, advance, now, track, newActor, deployStack, makeAgent,
                   score, creditLimit, collateralPct, lockedCapital, LEVERS_NEW, LEVERS_OLD, ethers };
```

## Appendix C — the cheapest-cycle primitives (`scripts/sim/lib/strategies.js`)

```javascript
/** Loans-per-cycle and per-loan principal that exactly saturate the gain budget. */
function cyclePlan(levers) {
  const maxGain = levers.maxGainPerWindow > 0 ? levers.maxGainPerWindow : levers.onTimeBonus * 10;
  const K = Math.max(1, Math.ceil(maxGain / levers.onTimeBonus));
  const totalPrincipal = (BigInt(maxGain) * levers.bonusRef) / BigInt(levers.onTimeBonus);
  return { K, per: totalPrincipal / BigInt(K), totalPrincipal, maxGain };
}

/** One rate-limit window of farming: open K loans, hold, repay them all. */
async function farmCycle(ctx, borrower, plan, opts = {}) {
  const before = await H.score(ctx, borrower);
  const ids = [];
  for (let k = 0; k < plan.K; k++) {
    const r = await track(borrower, ctx.mkt.connect(borrower.signer)
                 .requestLoan(plan.per, opts.durationDays || 7));
    ids.push(r.logs.map(l => { try { return ctx.mkt.interface.parseLog(l); } catch { return null; } })
              .find(e => e && e.name === "LoanRequested").args[0]);
  }
  await advance(Math.max(opts.hold ?? Number(ctx.levers.minHold), Number(ctx.levers.gainWindow)));
  for (const id of ids) await track(borrower, ctx.mkt.connect(borrower.signer).repayLoan(id));
  return { gained: (await H.score(ctx, borrower)) - before, score: await H.score(ctx, borrower), ids };
}
```

Two harness behaviours worth porting deliberately, because getting them wrong silently *understates* the attacker:

* **Stagger the pipeline.** Opening N loans in one block makes them all mature on the same day, where the rate limit clamps `N × bonus` down to one window's budget — N× the fees for the same reputation. One new loan per window is correct.
* **Loan term must exceed the hold time.** Repaying at or past `endTime` sets `onTime = false` and forfeits the entire bonus while still paying the interest.

## Appendix D — `contracts/sim/ReputationManagerV4Sim.sol` (M1)

Full contract preserved at `forensics/output/testing-2026-09-20/economic-sim/contracts/ReputationManagerV4Sim.sol`. The three substantive diffs against `ReputationManagerV3.sol`:

```solidity
// (1) principal-TIME bonus — V3 scaled by principal only
uint256 public refDuration = 7 days;
struct OpenLoan { uint128 amount; uint128 start; }
mapping(uint256 => OpenLoan[]) public openLoans;          // pushed in recordBorrow

// in recordLoanCompletion, replacing V3's `bonus = (onTimeRepaymentBonus * effAmount) / ref`:
uint256 start   = _popOpen(agentId, amount);              // oldest matching record (FIFO)
uint256 held    = block.timestamp > start ? block.timestamp - start : 0;
uint256 effAmt  = amount < bonusReferenceAmount ? amount : bonusReferenceAmount;
uint256 effHeld = held < refDuration ? held : refDuration;
uint256 bonus   = (onTimeRepaymentBonus * effAmt * effHeld) / (bonusReferenceAmount * refDuration);
if (block.timestamp < lockedUntil[agentId]) bonus = 0;    // (3) no gains during lockout
// ... V3's rate-limit clamp unchanged ...

// (2) exposure bounded by demonstrated repaid volume
uint256 public creditMultiple = 2;                        // MUST be > 1 — k == 1 deadlocks the ladder
uint256 public bootstrapLimit = 100 * 1e6;
mapping(uint256 => uint256) public maxRepaidPrincipal;    // set in recordLoanCompletion when onTime

function calculateCreditLimit(address agent) external view returns (uint256) {
    uint256 agentId = agentRegistry.addressToAgentId(agent);
    if (block.timestamp < lockedUntil[agentId]) return 0;         // (3) post-default freeze
    uint256 tl = tierLimit(agentReputation[agentId]);
    uint256 demonstrated = creditMultiple * maxRepaidPrincipal[agentId];
    if (demonstrated < bootstrapLimit) demonstrated = bootstrapLimit;
    return demonstrated < tl ? demonstrated : tl;
}

// (3) size-proportional penalty + capacity reset + lockout, replacing V3's flat step
uint256 public defaultLockout = 180 days;
mapping(uint256 => uint256) public lockedUntil;

uint256 penalty = (defaultPenaltyLarge * amount) / largeLoanThreshold;
if (penalty < defaultPenaltyBase) penalty = defaultPenaltyBase;
if (penalty > 1000) penalty = 1000;
agentReputation[agentId]    = old > penalty ? old - penalty : 0;
maxRepaidPrincipal[agentId] = 0;                          // capacity must be re-demonstrated
lockedUntil[agentId]        = block.timestamp + defaultLockout;
```

**Production caveats** (both found while simulating): `creditMultiple` must be `> 1` or carry an additive growth step, and `_popOpen`'s amount-matching must be replaced by a `loanId` passed from the marketplace — which makes M1 a marketplace change as well as a ReputationManager one.
