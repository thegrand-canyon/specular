# Specular V7 credit model — design, implementation and validation

**Finding addressed:** F-04 (HIGH, design) —
`forensics/output/audit-2026-09/INTERNAL_AUDIT_2026-09-19.md`, quantified in
`forensics/output/testing-2026-09-20/ECONOMIC_ATTACK_SIMULATION.md`.
**Date:** 2026-09-22 · **Branch:** `arc-mainnet-launch` (isolated worktree)
**Execution:** local hardhat chain (`chainId 31337`) + Foundry. **Nothing was deployed or broadcast to any network.**

New contracts: `contracts/core/ReputationManagerV4.sol`, `contracts/core/AgentLiquidityMarketplaceV62.sol`
(`VERSION() == "V6.2"`). V6.1 (`AgentLiquidityMarketplaceV6`) and `ReputationManagerV3` are **unmodified**, so their
existing suites keep running against the exact source they were written for, and so the V3-vs-V7 numbers below are a
like-for-like measurement rather than a before/after of the same edited file.

---

## 0. Headline

| | V3 live (V6.1) | **V7 shipped (k = 2)** | change |
|---|---|---|---|
| Largest unsecured line an agent can reach | **50,000 USDC** | **5,000 USDC** | **10× smaller prize** |
| Attacker peak capital to reach it | 412 USDC | **11,458 USDC** | 27.8× |
| **Attacker capital as a share of the prize** | **0.8 %** | **229.2 %** | **the attack is now capital-bound** |
| Attacker *unrecoverable* cost per bust-out | 0.18 USDC (fees) | **2,500 USDC self-stake + 0.70 USDC fees** | ~13,900× |
| Third-party lender loss per bust-out | 49,982 USDC | **2,431 USDC** | 20.6× smaller |
| Default penalty | 100 pts (flat step) | **500 pts** (size-scaled) + capacity reset | — |
| Repeat cadence | 20 days (re-farm) | **180 days** lockout + a fresh 158-day ladder | 9× |
| **Steady-state extraction** | **2,500 USDC/day** | **13.9 USDC/day** | **−99.4 %** |
| Honest agent (50 USDC / 7-day, held to term) to score 600 | 699 days, 12.47 USDC | 839 days, 15.10 USDC + 6.25 stake | 20 % slower, 21 % dearer |
| Honest agent to its maximum line | 146 days, 18.30 USDC → 50,000 | 158 days, 69.97 USDC → 5,000 | 8 % slower, 3.8× dearer |
| **Residual attacker EV** | +50,000 per 20 days | **+2,500 per 338-day cycle on 11,458 USDC of capital (≈ 24 %/yr)** | **positive, priced, bounded** |

**The attack is not closed. It is repriced.** The report's own conclusion stands and is restated in §5:
an unsecured line to a pseudonymous agent can only be made EV-negative by backing it with something seizable.
`creditMultiple` is the knob that prices the residual; it does not remove it.

**One of the report's claims is refuted.** §4.3 shows that M1 does *not* make honest agents dramatically faster
when both models are driven by the *same* strategy — it makes every honest profile measured slower and dearer.
The report's "131 days vs 2,999 days" compared M1's ladder-optimal agent against V3's fixed-tenor agent, i.e. two
different strategies rather than two models.

---

## 1. What changed and why

### 1.1 M1 — `ReputationManagerV4`

| # | Change | Rationale (from the economic report) |
|---|---|---|
| M1-1 | **Principal-TIME bonus**: `bonus = onTimeBonus · min(amt,ref)/ref · min(held,refDuration)/refDuration` | V3 scaled by principal only. The full *nominal* term's interest is charged however early a loan is repaid, so the cheapest attacker cycle was "open a 7-day loan, repay after 1 day": full points, 1/7 of the capital-days. Hold time now buys the points, so the same reputation costs 7× the capital-days. Measured: a 1-day hold on a 7-day term now earns **1 point instead of 10**. Hold time is derived inside the manager from the `recordBorrow` timestamp of the same `loanId`. |
| M1-2 | **Credit ladder**: `creditLimit = min(tierLimit(score), max(bootstrapLimit, creditMultiple · maxRepaidPrincipal + growthStep))` | Reputation in V3 is a *clock*. The ladder makes capacity a function of principal the agent has itself already put at risk and repaid on time. This is what turns "0.18 USDC of fees" into "11,458 USDC of working capital". **`growthStep` is mandatory** — see §2. |
| M1-3 | **Size-proportional default penalty + capacity reset + lockout**: `penalty = max(base, large · amount / largeLoanThreshold)`, `maxRepaidPrincipal → 0`, `creditLimit → 0` for `defaultLockout` | V3's penalty was a flat step: a 50,000 default cost exactly as much as a 10,001 one, and 800 → 700 did not even change tier. The lockout plus the capacity reset is what moves the repeat cadence from 20 days to 180 days **plus a fresh ladder from zero**. A second, smaller default can never *shorten* an existing lockout. |
| M1-4 | **Tier table capped and owner-settable, with an immutable ceiling** | Report §8.3 item 3: *"a tier-table cap is worth more than every lever in §7 combined, because it bounds the prize instead of pricing the path."* The limits were hardcoded in V3 — the only reason fixing them needs a redeploy at all. They are settable now, but every entry is bounded by `MAX_TIER_LIMIT = 10,000 USDC` (a `constant`), so a compromised or coerced owner key cannot restore the 25,000 / 50,000 exposure. |
| M1-5 | **Late-repayment reputation penalty** | V6.1 fixed the *economics* of lateness (interest on `max(duration, elapsed)`) but had no reputation hook — V3 exposed none, so the only sanction was losing the bonus (`FIX_NOTES_2026-09-19.md` deferred it explicitly). `recordLoanCompletion` now takes `lateSeconds`; a late loan costs `latePenaltyBase + latePenaltyPerDay · fullDaysLate` (capped at `latePenaltyMax`) **and does not advance the ladder**. |

### 1.2 M2 — `AgentLiquidityMarketplaceV62`

| # | Change | Rationale |
|---|---|---|
| M2-a | **The pool creator's own lender position is locked while `outstandingPrincipal[agentId] > 0`** | Every bust-out in the simulation *began* with the attacker withdrawing its own seed from its own pool immediately before drawing the pool down. That ordering is now impossible. Verified in-sim: `selfStakeLockedAtBustOut: true` for both V7 configurations. The check sits **before** the liquidity require, so a locked creator always gets the informative reason (after a full draw `availableLiquidity` is 0 and the generic `"Insufficient pool liquidity"` would mask the real constraint). |
| M2-b | **On default, that position absorbs the loss FIRST**, before `_socializeLoss` touches anyone else | Makes the agent's own capital genuinely subordinated rather than pari passu. Under V6.1's flat pro-rata an attacker holding 1/5 of its own pool kept 80 % of its stake through its own default. |
| M2-c | **A loan at a tier with `collateral < 100 %` requires `selfStake >= unsecuredExposure / creditMultiple`** | The report specifies this for the 0 %-collateral tiers. Generalising by the collateral percentage (`unsecured = (outstanding + amount) · (100 − pct) / 100`) closes the 500-tier route around the same cap, and reduces to the report's rule exactly when `pct == 0`. The requirement is on **aggregate** exposure, so a second loan needs more stake. |
| M2-d | **`loanId` is passed into every reputation call** (`recordBorrow` / `recordLoanCompletion` / `recordDefault`) | The report flags amount-matching as ambiguous with concurrent equal-size loans; its scratch contract used oldest-first FIFO. The loanId makes hold time exact and O(1). **Required, not optional** — it is the reason the marketplace has to be redeployed as well. |
| M2-e | **`lateSeconds` is passed through** | Feeds M1-5, using the `lateSeconds` V6.1 already computed and recorded but had nowhere to send. |
| L7 | **Socialised default loss now falls first on the principal QUALIFIED for that loan at its `startTime`** | New MEDIUM finding in report §6: under the W1 rule a lender who joins mid-loan earns nothing from that loan, but V6.1 charged it a full pro-rata share of that loan's default. That is a systematic transfer from new lenders to existing ones, and an invitation to open a large loan and *then* solicit liquidity. Pass 1 charges the qualified basis (`qualifiedAmountAt(.., loan.startTime)`); pass 2 charges any residual to the remaining principal; F-05's third pass still charges unclaimed interest. Per-pool conservation stays **exact**. |
| — | **`canTopUp` one-liner retained** verbatim (the 2026-09-20 `block.timestamp + 1` fix) | Kept as instructed; regression-tested as an exact oracle for the refusal. |
| — | **The pool creator's own stake is exempt from `minSupplyAmount`** | Found while running the honest simulation: a 50 USDC loan at the 75 %-collateral tier needs only 6.25 USDC of stake at `k = 2`, which the live 10 USDC `minSupplyAmount` floor refuses — making small honest borrowing impossible. The creator's slot is locked first-loss capital, the opposite of the squat that `minSupplyAmount` exists to price, and there is exactly one such slot per pool. |

---

## 2. Parameters and how they were calibrated

```solidity
// ReputationManagerV4 shipped defaults
onTimeRepaymentBonus = 10;          bonusReferenceAmount = 100e6;
refDuration          = 7 days;      // == marketplace MIN_LOAN_DURATION
creditMultiple       = 2;           growthStep     = 100e6;
bootstrapLimit       = 100e6;       defaultLockout = 180 days;
defaultPenaltyBase   = 50;          defaultPenaltyLarge = 100;
largeLoanThreshold   = 1000e6;      // V3 shipped 10,000e6
latePenaltyBase      = 10;          latePenaltyPerDay = 5;   latePenaltyMax = 100;
MAX_TIER_LIMIT       = 10000e6;     // constant, immutable

tierMinScore      = [    0,  200,   400,   500,   600,   800 ];
tierLimits        = [ 1000, 5000, 10000, 10000,  2500,  5000 ] e6;
tierCollateralPct = [  100,  100,   100,    75,     0,     0 ];
tierInterestBps   = [ 1500, 1500,  1000,  1000,   700,   500 ];
```

**`creditMultiple = 2`.** `k` does double duty: it is the ladder's growth factor *and* the self-stake divisor,
so a larger `k` means a faster ladder (less capital to climb) but a smaller first-loss stake. The simulation
measured the trade directly:

| | peak attacker capital | self-stake burned | attacker net gain | third-party loss | steady-state |
|---|---|---|---|---|---|
| `k = 2` | 11,458 USDC | **2,500** | **+2,500** | **2,431** | **13.9 USDC/day** |
| `k = 4` | 8,179 USDC | 1,250 | +3,750 | 3,715 | 20.8 USDC/day |

`k = 2` dominates `k = 4` on every security metric and costs the honest agent only extra *recoverable* working
capital. `k = 1` would make the stake equal the whole unsecured exposure (EV → 0) but is the worst case for honest
capital efficiency and makes the ladder crawl. **`k = 2` is the shipped choice, and `k` is the knob to turn if the
residual EV in §5 is judged too high.** The setter bounds it to `1 ≤ k ≤ 10`.

**`growthStep = 100 USDC` (mandatory).** The report proved `creditMultiple = 1` with no additive term
**deadlocks**: head-room can never exceed the record it would have to beat, so the ladder stalls at
`bootstrapLimit` forever (the report's k=1 run stalled at a 100 USDC limit after 500 days).
`setLadderParameters` therefore **reverts on `growthStep == 0`**, and the climb is proven by test:

> measured rungs at `k = 2`, top tier: `100 → 300 → 700 → 1,500 → 3,100 → 5,000 (tier cap) → 5,000 …`
> measured rungs at `k = 1, step = 100`: `100 → 200 → 300 → 400 → 500 …` — strictly increasing in both cases.

**`refDuration = 7 days`** equals `MIN_LOAN_DURATION`, so any loan held to the shortest legal term earns the full
bonus and no honest tenor is penalised beyond it. The attacker's 1-day cycle earns 1/7.

**`largeLoanThreshold = 1,000 USDC`** (V3: 10,000). With the tier cap at 5,000, a 10,000 threshold would put
*every reachable default* back on the `defaultPenaltyBase` floor — i.e. flat again, which is the V3 pathology.
At 1,000 a maximum bust-out (5,000 USDC) costs **500 points**, half the whole scale. This is the report's §7
recommendation ("lower the large-loan threshold so ANY meaningful default costs the full penalty").

**`defaultLockout = 180 days`** is the report's proposal and is the single biggest contributor to the cadence
change (20 → 180 days). It is bounded at 2 years by the setter so a mis-set value cannot permanently brick an agent.

**The tier table.** The report specifies 600 → 2,500 and 800 → 5,000 and "keep the lower tiers". Kept literally,
the 500-tier (10,000 limit at V3's 25 % collateral) would carry **7,500 USDC of unsecured exposure** — three times
the capped 600 tier, and the cap would simply be routed around one tier lower. The fix that preserves the report's
instruction is to raise that tier's *collateral requirement* rather than cut its limit: **25 % → 75 %**. The
resulting unsecured exposure is monotone and capped, which is asserted as a unit test:

| score | limit | collateral | **unsecured exposure** |
|---|---|---|---|
| 0–199 | 1,000 | 100 % | 0 |
| 200–399 | 5,000 | 100 % | 0 |
| 400–499 | 10,000 | 100 % | 0 |
| 500–599 | 10,000 | **75 %** (was 25 %) | 2,500 |
| 600–799 | **2,500** (was 25,000) | 0 % | 2,500 |
| 800–1000 | **5,000** (was 50,000) | 0 % | 5,000 |

`unsecuredTierExposure(tier)` publishes this figure on-chain for monitoring and for sanity-checking any future
`setTierLimits` call.

**`MAX_TIER_LIMIT = 10,000 USDC` is a `constant`, not a variable.** The whole value of a tier cap is that it holds
when the owner key does not. `setTierLimits` and `setValidationBonusParameters` are both bounded by it, so the
ERC-8004 validation bonus cannot be used as an escape hatch either.

**Late penalty (10 base + 5/day, cap 100).** Calibrated against the on-time bonus: a 3-day-late repayment costs 25
points, i.e. 2.5 on-time repayments' worth of progress, on top of forfeiting the bonus and paying elapsed-time
interest (F-03). The cap keeps a long-overdue loan from being strictly worse than defaulting, which would invert
the incentive to eventually repay.

---

## 3. Attacker simulation

Harness: `scripts/sim/` (ported from `forensics/output/testing-2026-09-20/economic-sim/` per Appendix A of the
report, extended for the V7 stack). Raw output: `scripts/sim/out/v7-model.json`. Reproduce with

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npx hardhat run scripts/sim/run-v7-model.js                  # ~25 min, all configurations
SIM_ONLY=v7_k2 npx hardhat run scripts/sim/run-v7-model.js   # one configuration
```

Configurations, all under the **live Arc mainnet levers** (5 pts/day, `minSupply` 10 USDC, 100 bps fee,
`minHold` 1 day, M-1 on, `bonusRef` 100 USDC):

* `v3` — `ReputationManagerV3` + `AgentLiquidityMarketplaceV6` (V6.1): what is live today.
* `m1_k2` / `m1_k4` — the report's `ReputationManagerV4Sim` + **unchanged V6.1**: M1 alone, no M2, V3 tier table.
* `v7_k2` / `v7_k4` — the shipped `ReputationManagerV4` + `AgentLiquidityMarketplaceV62`: M1 + M2 + the tier cap.

The attacker runs the report's greedy strategy: a staggered pipeline of small loans saturating the reputation
rate-limit budget, plus one "ladder" loan per cycle as large as head-room allows, funded from fresh Sybil lender
addresses (the F-02 top-up guard binds only an *existing* position). On the V7 stack it must also maintain and
re-commit its locked first-loss stake. At the bust-out it first recovers everything it can (all Sybil positions,
and any self-stake above what M2-c requires), then a genuine third-party lender funds the shortfall, then it draws
the whole line and never repays. "Capital" is `startUSDC − balanceOf`, i.e. USDC the protocol holds on the
attacker's behalf, summed across every address it controls.

| metric | **v3 (live)** | **m1_k2** | **m1_k4** | **v7_k2 (shipped)** | **v7_k4** |
|---|---|---|---|---|---|
| days to the maximum line | 146 | 171 | 165 | **158** | 152 |
| score reached | 800 | 835 | 835 | 800 | 800 |
| **line unlocked (the prize)** | **50,000** | 50,000 | 50,000 | **5,000** | **5,000** |
| **peak attacker capital** | **412.27** | 27,902.34 | 42,412.79 | **11,458.41** | 8,178.77 |
| **capital as share of the prize** | **0.8 %** | 55.8 % | 84.8 % | **229.2 %** | 163.6 % |
| platform fees paid | 0.1829 | 1.3497 | 1.0347 | **0.7004** | 0.3557 |
| drawn at the bust-out | 50,000 | 50,000 | 50,000 | 5,000 | 5,000 |
| self-stake withdrawable before the draw? | n/a | n/a | n/a | **no — locked** | **no — locked** |
| **self-stake burned (unrecoverable)** | **0** | **0** | **0** | **2,500** | 1,250 |
| **attacker net gain** | **+50,000** | +50,000 | +50,000 | **+2,500** | +3,750 |
| **third-party lender loss** | **49,982** | 49,866 | 49,898 | **2,431** | 3,715 |
| reputation penalty | 100 pts | 500 pts | 500 pts | **500 pts** | 500 pts |
| credit limit immediately after | 25,000 | **0** | **0** | **0** | **0** |
| `maxRepaidPrincipal` after | n/a | **0** | **0** | **0** | **0** |
| **repeat cadence** | **20 days** (re-farm 100 pts at 5/day) | 180 d lockout + fresh ladder | 180 d + ladder | **180 d + a fresh 158-day ladder** | 180 d + ladder |
| **steady-state extraction** | **2,500 USDC/day** | 277.8 USDC/day | 277.8 USDC/day | **13.9 USDC/day** | 20.8 USDC/day |

Reading the table:

* **M1 alone is a large improvement and is not enough.** It raises the attacker's working capital from 412 to
  27,902 USDC and cuts steady-state extraction 9×, but every dollar of that capital comes *back*: the M1 bust-out
  still nets the full 50,000 and still costs the lenders 49,866. This independently reproduces the report's own
  conclusion that "M1 does not close the attack by itself — it must be paired with M2".
* **M2 is what makes the capital unrecoverable.** `selfStakeLockedAtBustOut: true` in both V7 runs — the attacker
  tried to withdraw its stake with the loan outstanding and was refused. 2,500 USDC of its own money is then seized
  *before* any lender's.
* **The tier cap is what shrinks the prize**, and it does more for the loss number than everything else combined:
  third-party loss falls from ~50,000 to 2,431 per bust-out.
* **The penalty finally scales.** 100 pts flat (a 20-day re-farm that did not even cost a tier) → 500 pts plus a
  ladder reset to zero plus a 180-day freeze.
* **Sybil fan-out no longer scales for free.** Under V3 a second agent cost 62 USDC of recoverable capital
  (report §3). Under V7 each parallel agent needs its own ~11,458 USDC of working capital and burns its own 2,500.
  The attack is now capital-bound rather than calendar-bound — which is the only kind of bound a pseudonymous-
  identity system can actually enforce.
* **Note on `m1_k4` vs `m1_k2`:** a bigger `k` makes the ladder cheaper to climb in *time* but demands a larger
  single repaid loan to reach the same limit, hence the higher peak capital. Without M2 that difference is
  irrelevant to the outcome — both net the full 50,000 — which is precisely why `k` only becomes a security
  parameter once M2 ties it to the seizable stake.

---

## 4. Honest-agent trajectory on the same model

Two profiles, both funded by a **genuine third-party lender** (so the borrower pays the full interest and
recaptures none of it), measured on the identical harness. Cost is *realised* — taken after a full unwind, so only
genuinely unrecoverable outflows count.

### 4.1 H1 — fixed 50 USDC / 7-day working capital, held to term

| model | days to score 600 | realised cost | of which fees | self-stake posted |
|---|---|---|---|---|
| V3 live | **699.3** | **12.47 USDC** | 0.125 | 0 |
| M1 only (k = 2) | 839.2 | 15.10 USDC | 0.151 | 0 |
| **V7 (k = 2)** | **839.2** | **15.10 USDC** | 0.151 | **6.25 USDC** (recoverable) |

*(The M1 row reproduces the economic report's own figure — 839 days / 15.10 USDC — to four significant figures.
That is the cross-check that this implementation of M1 matches the one the report measured.)*

**20 % slower and 21 % dearer**, plus 6.25 USDC of locked (recoverable) first-loss capital. The slowdown is the
principal-TIME bonus: a 7-day loan repaid ten minutes before term now earns 9 points rather than 10, and the term
must comfortably exceed the hold.

### 4.2 The ladder-optimal honest agent (the same strategy the attacker uses)

| model | days | score | line reached | peak own capital | realised cost | of which fees |
|---|---|---|---|---|---|---|
| V3 live | **146** | 800 | **50,000** | 12.27 | **18.30 USDC** | 0.18 |
| M1 only (k = 2) | 171 | 835 | 50,000 | 67.23 | 134.97 USDC | 1.35 |
| **V7 (k = 2)** | **158** | 800 | **5,000** | 116.30 | **69.97 USDC** | 0.70 |

### 4.3 Verdict on the report's honest-agent claim — **REFUTED as stated**

The report claims *"M1 is a large net improvement for real borrowers … an honest agent that actually wants a
25,000 line reaches it in 131 days for 96.27 USDC — versus 2,999 days under V3."*

Run the **same strategy** against both models and that does not hold:

* For the ladder strategy, V3 reaches a **10× larger** line in **12 fewer days** for **3.8× less money** than V7,
  and for **7.4× less** than M1-alone at the same 50,000 line.
* For the fixed H1 profile, M1 and V7 are both slower and dearer than V3.
* Every honest profile measured is worse off in time and money under the new model.

The report's comparison was between M1's *ladder-optimal* agent (131 days) and V3's *fixed 30-day-tenor* agent
(2,999 days) — two different strategies, not two different models. What is genuinely true, and worth stating:

1. Under V3 the credit limit is a pure **clock**: a 1,000-USDC borrower and a 25,000-USDC borrower climb at exactly
   the same rate, and the big borrower pays 481× more interest for the same points (report §5). The ladder removes
   that pathology — capacity now tracks demonstrated usage, and a borrower that genuinely wants a larger line has
   a path that a pure clock never offered.
2. The V7 honest cost is higher **for the same reason the attacker's is**: the model charges for capital-time and
   for demonstrated repayment. There is no parameterisation that raises the attacker's price without raising the
   honest agent's — the report proved that for levers, and it is equally true of the model change. What the model
   change buys, which no lever could, is that the attacker's added cost is **unrecoverable** (seized self-stake)
   while the honest agent's is almost entirely **recoverable** (locked capital it gets back).
3. The honest cost is dominated by interest paid to real lenders, not by protocol fees (69.97 USDC total, of which
   0.70 USDC is fees, in the V7 ladder run) — i.e. it is a transfer to the parties taking the risk, not a tax.

**The honest cost of V7 is real and should be disclosed, not glossed.** The trade being made is: every honest agent
pays roughly 3–4× more and waits ~10–20 % longer for a line that is 10× smaller, in exchange for removing 99.4 % of
the attacker's steady-state extraction and 95 % of the per-incident lender loss. If the 5,000 USDC ceiling is too
low for the product, `setTierLimits` can raise it to `MAX_TIER_LIMIT` (10,000) without a redeploy — and the residual
EV in §5 scales linearly with it.

---

## 5. Residual risk — stated plainly

**The bust-out remains EV-positive.** At the shipped parameters (`k = 2`, top tier 5,000 USDC):

* Gross draw: **5,000 USDC.**
* Unrecoverable cost: **2,500 USDC** of seized self-stake + **0.70 USDC** of fees + gas.
* **Net gain: +2,500 USDC per agent per cycle.**
* Cycle length: 158 days to climb + 180 days of lockout = **338 days**, during which ~11,458 USDC of the attacker's
  capital is tied up (mostly recoverable).
* **Residual EV ≈ +2,500 USDC per 338 days on ~11,458 USDC of working capital ≈ 24 % annualised**, before gas and
  before the cost of sourcing 2,431 USDC of third-party liquidity willing to fund a pseudonymous agent.
* Sybil fan-out is still linear in agents, but is now **capital-bound**: N agents require N × ~11,458 USDC.
* Counted the other way — the metric the headline uses — an agent that only waits out the lockout before re-drawing
  extracts **13.9 USDC/day**, versus 2,500 USDC/day today.

This is dramatically worse for an attacker than a near-risk-free 2,500 USDC/day, but it is **not zero**, and it must
not be described as closed. As `k → 1` the required self-stake approaches the whole unsecured exposure and the EV
approaches zero — at which point the product is no longer an unsecured credit line. That is the honest frontier,
and it is the report's own conclusion:

> *An unsecured line to a pseudonymous agent can only be made EV-negative by backing it with something the protocol
> can seize. Pick `k` to price the residual risk; do not pretend it is zero.*

Other residuals, carried forward and unchanged by this work:

| | |
|---|---|
| **M-1 must stay ON** | The self-stake is keyed to `pool.agentAddress` (the pool creator), as the report specifies. With `bindBorrowToPoolCreator` off and the agent NFT transferred, the borrower and the stake-holder can diverge. Keep M-1 enabled. |
| **`LATE_INTEREST_CAP = 30 days`** | Unchanged from V6.1. Past `duration + 30 days` interest stops accruing. A borrower intending to default is unaffected; the M1-5 reputation penalty now also applies, but is capped at 100 points. |
| **Owner blast radius** | `liquidateLoan` is still `onlyOwner`, so a non-liquidating owner lets a default sit and the self-stake is never seized. `pause()` still freezes lender exits (I-5). `ReputationManagerV4` is `Ownable2Step` and cannot renounce (closing I-1 for this contract; the registry and faucet are unchanged and remain one-step `Ownable`). |
| **Lender-slot squat (F-06)** | Unchanged; still a lever. The new creator exemption from `minSupplyAmount` applies only to `pool.agentAddress` in its own pool — exactly one slot per pool. |
| **Fresh-address supply** | The F-02 top-up guard still constrains only *existing* positions; the attacker used fresh addresses to grow its pool while loans were in flight. `MAX_LENDERS_PER_POOL = 50` remains the only bound. |
| **Ladder gaming not found, not disproved** | The ladder rewards the *largest single on-time repaid loan*. An agent can inflate it with self-funded round trips — but that is exactly the capital cost M2-c then charges it for, which is the design. No cheaper path was found in the campaign; that is not a proof that none exists. |
| **No external audit** | Neither new contract has been independently audited. |

---

## 6. Tests, coverage, gas, bytecode

### 6.1 Totals

| suite | before this work | **after** |
|---|---|---|
| `npx hardhat test` (all of `test/`) | 737 passing · 5 pending · **0 failing** | **832 passing · 5 pending · 0 failing** |
| `forge test` | 13 passing (V6 ×6, V6.1 ×6, V6.1 gas ×1) | **20 passing · 0 failing** (+ V7 ×7) |

The 5 pending are pre-existing (the `F-04`/`F-06`/`F-08` owner-decision `it.skip`s in `test/audit-2026-09/` plus one
SDK skip). **Note on `test/api/*`:** the task flagged these as failing from an external Arc-testnet RPC rate limit.
In this environment they **passed** in both the baseline and the final run — the limit was not hit. They are
included in the 737 → 832 figures; nothing in this change touches them. Had they failed it would have been
environmental and excluded from the pass/fail judgement.

New suites (95 hardhat tests):

| file | tests | covers |
|---|---|---|
| `test/v7/M1-ReputationManagerV4.test.js` | 48 | every new/changed V4 function: principal-time bonus (7), credit ladder incl. the k=1 deadlock and the bootstrap→cap climb (8), default penalty / capacity reset / lockout (10), tier table + hard ceiling (7), late penalty (6), loanId registry (6), hygiene + access control (4) |
| `test/v7/M2-SelfStake.test.js` | 27 | self-stake gate (7), lock (5), first-loss waterfall (5), L7 basis incl. a side-by-side V6.1 comparison proving the behaviour actually changed (4), loanId/lateSeconds plumbing (5), version (1) |
| `test/v7/V62-PriorFixesRegression.test.js` | 20 | **F-01 (4), F-02 (5), F-03 (4), F-05 (1), F-07 (1)** still hold on V6.2, plus §B1 / §S1 / §S5 / H-3 / pause / renounce (5) |
| `test/foundry/V7Invariants.t.sol` | 7 | see §6.2 |

`test/audit-2026-09-fixes/` (the original 36 V6.1 regression tests) and `test/audit-2026-09/` are untouched and
still green against the unmodified V6.1 source.

### 6.2 Foundry invariants

`test/foundry/V7Invariants.t.sol` — **48 runs × 192 depth = 9,216 handler calls, 0 reverts, 7/7 pass.**
Two agents (one pumped to the 0 %-collateral top tier so defaults are genuinely lossy, one at score 0 so the
100 %-collateral and "no self-stake required" branches are exercised), three lenders, plus the agents acting as
their own first-loss lenders.

State invariants, checked after every call:

* `(a)` exact solvency + per-pool conservation including unclaimed interest
* `(b)` `pendingTranche.amount <= position.amount`
* `(h)` `outstandingPrincipal == Σ ACTIVE principal`
* `(q)` **`creditLimitOf(agent) <= MAX_TIER_LIMIT` always** — the cap is unconditional
* `(r)` **a locked-out agent's credit limit is exactly 0**
* `(s)` **`ladderLimit` and `creditLimitOf` agree with `maxRepaidPrincipal` and the tier table** (no view drift)

Call-time properties as ghost counters, all required to stay 0:

* `M2a` a creator withdrawal while `outstandingPrincipal > 0` **always** reverts, and never reverts when it is 0
* `M2c` after every successful `requestLoan`, `selfStake >= unsecured / k`
* `M2b` on every lossy liquidation the creator absorbs exactly `min(loss, creatorBefore)` **and** Σ principal falls
  by exactly `min(loss, Σ principal)`
* `L7` no unqualified lender is cut while a qualified one still holds principal
* `M1` `maxRepaidPrincipal` only rises, or resets to exactly 0 on a default
* `M1b` a locked-out agent never opens a loan

The campaign reaches the interesting states (per-run counters printed by `afterInvariant`): lossy liquidations with
self-stake absorption, post-default lockouts, borrows blocked during lockout, ladder advances, and blocked creator
withdrawals. A `warpPastDue` handler op exists specifically so the liquidation path is reachable inside a bounded
campaign rather than only by luck.

### 6.3 Slither 0.11.4

`slither . --filter-paths "node_modules|contracts/bridge|contracts/sim|test"` — 58 contracts, 245 results.
Restricted to findings that name one of the two **new** contracts:

| impact / check | count | disposition |
|---|---|---|
| **High** | **0** | — |
| Medium / `divide-before-multiply` | 2 | `calculateInterest` (accepted, SDK-matched, carried from V6) and the M1-5 penalty's deliberate *full-days-late* floor |
| Medium / `incorrect-equality` | 2 | the legacy `_countActiveLoansFromArray` helper (carried from V6) and `openLoans[loanId].start == 0` (an intentional "not recorded" sentinel) |
| Medium / `unused-return` | 1 | `validationRegistry.getSummary` (carried from V3) |
| Low / `timestamp` | 27 | expected for a time-based credit product |
| Informational | 14 | naming / dead code / cyclomatic complexity |

No new class of finding versus the V6.1 baseline. Filtered JSON (the 46 findings naming the two new contracts):
`scripts/sim/out/slither-v7-new-contracts.json`. The full 10 MB run is not committed — reproduce with the command above.

### 6.4 Gas

`npx hardhat run scripts/sim/gas-v62-vs-v61.js` → `scripts/sim/out/gas-and-size.json`. Identical scenario on both
stacks (score-800 agent, three lender positions, a 5,000 USDC loan, a mid-loan joiner before a lossy liquidation):

| operation | V6.1 | **V6.2** | delta |
|---|---|---|---|
| `supplyLiquidity` (new lender slot) | 227,067 | 227,106 | +39 |
| `supplyLiquidity` (self-stake / top-up) | 158,655 | 158,694 | +39 |
| `requestLoan` (incl. disburse + `recordBorrow`) | 499,725 | 514,087 | **+14,362** (self-stake gate + loanId record) |
| `repayLoan` (incl. distribute + `recordLoanCompletion`) | 315,942 | 322,117 | **+6,175** (loanId close + late branch) |
| `claimInterest` | 51,221 | 51,173 | −48 |
| `liquidateLoan` (lossy, with a mid-loan joiner) | 154,047 | 193,774 | **+39,727** (self-stake absorption + the two-pass L7 basis) |

All comfortably inside a block. The liquidation delta is the L7 two-pass socialisation; it is bounded by
`MAX_LENDERS_PER_POOL = 50`, exactly as V6.1's single pass was — the §S5 O(1) properties are untouched.

### 6.5 Bytecode size (solc 0.8.20, optimizer 200 runs, viaIR, evm `paris`)

| contract | deployed bytecode | initcode | headroom to EIP-170 (24,576 B) |
|---|---|---|---|
| `ReputationManagerV3` (live) | 6,388 | 6,666 | 18,188 |
| **`ReputationManagerV4`** | **11,099** | 11,931 | **13,477** |
| `AgentLiquidityMarketplaceV6` (V6.1, live) | 19,759 | 20,222 | 4,817 |
| **`AgentLiquidityMarketplaceV62`** | **21,299** | 21,776 | **3,277** |

Both fit; no trimming was needed. V6.2 has the tighter margin — future additions should budget against 3,277 bytes.
The obvious reclaimable space is the legacy `_countActiveLoansFromArray` helper and the migration helpers (§8).

---

## 7. Storage layout, and the absence of upgradeability

**Neither contract is upgradeable. There is no proxy anywhere in this stack, and none is introduced.**
`AgentLiquidityMarketplaceV62` and `ReputationManagerV4` are fresh deploys with constructor-set immutables
(`agentRegistry`, `reputationManager`, `usdcToken`). Nothing in either contract assumes, or is compatible with,
`delegatecall`-based upgrading: there is no storage gap, no initializer, and the immutables live in code rather than
storage. The layouts below are documented for auditors and for the invariant monitor, **not** because any
storage-compatible upgrade is intended or possible.

`ReputationManagerV4` (`forge inspect … storage-layout`; bold entries are new versus V3):

| slot | variable |
|---|---|
| 0–1 | `Ownable2Step`: `_owner`, `_pendingOwner` |
| 2 | `validationRegistry` |
| 3–5 | `authorizedPools`, `agentReputation`, `initialized` |
| 6–9 | `maxReputationGainPerWindow`, `reputationGainWindow`, `windowStart`, `gainedInWindow` |
| 10–14 | `totalBorrowed`, `totalRepaid`, `loanCount`, `defaultCount`, **`lateCount`** |
| 15–19 | `onTimeRepaymentBonus`, `defaultPenaltyBase`, `defaultPenaltyLarge`, `largeLoanThreshold`, `bonusReferenceAmount` |
| 20–23 | **`refDuration`, `creditMultiple`, `growthStep`, `bootstrapLimit`** |
| 24 | **`maxRepaidPrincipal`** |
| 25–26 | **`defaultLockout`, `lockedUntil`** |
| 27–29 | **`latePenaltyBase`, `latePenaltyPerDay`, `latePenaltyMax`** |
| 30–31 | `validationBonusThreshold`, `validationCreditBonus` |
| 32–37 | **`TIER_MIN_SCORE[6]`** |
| 38–43 | **`tierLimits[6]`** |
| 44–49 | **`tierCollateralPct[6]`** |
| 50–55 | **`tierInterestBps[6]`** |
| 56 | **`openLoans`** — `loanId → {uint128 amount, uint64 start, uint64 agentId}`, one packed slot per entry |

`agentRegistry` is `immutable` (code, not storage). `VERSION`, `MAX_SCORE`, `INITIAL_SCORE`, `MAX_TIER_LIMIT` are
`constant`.

`AgentLiquidityMarketplaceV62` — **byte-for-byte identical layout to V6.1**, slots 0–24: `Ownable2Step` (0–1),
`ReentrancyGuard._status` (2), `Pausable._paused` (3), `agentPools`, `positions`, `poolLenders`, `loans`,
`agentLoans`, `nextLoanId`, `platformFeeRate`, `accumulatedFees`, `minHoldForReputationReward`,
`bindBorrowToPoolCreator`, `minSupplyAmount`, `agentPoolIds`, `activeLoanCount`, `outstandingPrincipal`,
`isInPoolLenders`, `migrationFinalized`, `pendingTranche`, `activeLoanIds`, `repayments`, `lateRepayCount`,
`lateSecondsTotal`.

**V6.2 adds no storage at all.** Every M2 change is logic over state V6.1 already tracked — the self-stake is simply
`positions[agentId][pool.agentAddress]`. Full JSON dumps: `scripts/sim/out/storage-rmv4.json`,
`scripts/sim/out/storage-v62.json`.

---

## 8. Interface changes the SDK / MCP layer must adopt

### 8.1 Breaking — `ReputationManagerV4` write path

| V3 | **V4** |
|---|---|
| `recordBorrow(address borrower, uint256 amount)` | **`recordBorrow(address borrower, uint256 loanId, uint256 amount)`** |
| `recordLoanCompletion(address borrower, uint256 amount, bool onTime)` | **`recordLoanCompletion(address borrower, uint256 loanId, uint256 amount, bool onTime, uint256 lateSeconds)`** |
| `recordDefault(address borrower, uint256 amount)` | **`recordDefault(address borrower, uint256 loanId, uint256 amount)`** |

These are `onlyAuthorizedPool`, so only the marketplace and owner-operated tooling call them — but **every script
that pumps reputation through the authorized-pool path must be updated** (several exist under `scripts/` and in the
test fixtures). Event signatures changed to match: `LoanRecorded`, `LoanCompleted` and `DefaultRecorded` all gained
an indexed `loanId`. `mcp-server/abi/ReputationManagerV3.json` and `abis/` need a V4 variant.

### 8.2 Unchanged read surface (no SDK/MCP change required for reads)

`getReputationScore(uint256)`, `getReputationScore(address)`, `calculateCreditLimit(address)`,
`calculateCollateralRequirement(address)`, `calculateInterestRate(address)`, `initializeReputation()` /
`initializeReputation(uint256)`, `authorizePool`, `revokePool`, `setScoringParameters`, `setBonusReferenceAmount`,
`setReputationRateLimit`, `setValidationRegistry`, `setValidationBonusParameters`, and the
`totalBorrowed` / `totalRepaid` / `loanCount` / `defaultCount` / `initialized` getters all keep their V3 signatures
and semantics. `mcp-server/src/prepare.ts` reads only from this set.

On the marketplace, the `loans()` tuple (10 fields), `positions()` tuple (3 fields), `getLenderPosition`
(4 returns), `getAgentPool`, `previewRepayment`, `canTopUp`, `qualifiedAmountAt`, `getActiveLoanIds`,
`pendingTranche`, `repayments`, `lateRepayCount`, `lateSecondsTotal` and every V6.1 event are **unchanged**.

### 8.3 New reads the SDK / MCP **should** adopt

| contract | member | why |
|---|---|---|
| V6.2 | **`requiredSelfStake(agentId, additionalAmount) → uint256`** | `prepare_request_loan` must warn before an `"Insufficient self-stake"` revert and should surface the top-up the agent needs. |
| V6.2 | **`selfStake(agentId) → (uint256 amount, bool locked)`** | `prepare_withdraw_liquidity` must warn a pool creator that its position is locked; the dashboard should render it as first-loss capital, not ordinary liquidity. |
| V4 | `creditLimitOf(uint256 agentId)` | agentId-keyed limit (F-01 identity hygiene — prefer it over the address form). |
| V4 | `ladderLimit(agentId)`, `maxRepaidPrincipal(agentId)` | explain *why* a limit is what it is: "your line is `k × your largest repaid loan + step`, capped by your tier". |
| V4 | `isLockedOut(agentId)`, `lockedUntil(agentId)` | a post-default agent sees `calculateCreditLimit == 0`; without this it reads as a bug. |
| V4 | `tierLimit(score)`, `tierOf(score)`, `tierLimits(i)`, `tierCollateralPct(i)`, `tierInterestBps(i)`, `tierMinScore(i)`, `unsecuredTierExposure(i)`, `MAX_TIER_LIMIT()` | the tier table is now **on-chain data, not a hardcoded client-side copy**. Every client, doc and dashboard carrying a hardcoded 25,000/50,000 table must read it from the contract instead — including `CLAUDE.md`'s reputation table and `index.html`. |
| V4 | `lateCount(agentId)`, `openLoans(loanId)` | lateness history, and the open-loan record that drives the bonus. |
| V4 / V6.2 | `VERSION() → "V4"` / `"V6.2"` | capability probe. `mcp-server/src/networks.ts`'s `marketplaceCapabilities` gate must learn `v62`. |

### 8.4 New revert strings to pre-check and surface

| revert | raised by | pre-check |
|---|---|---|
| `"Insufficient self-stake"` | `requestLoan` | `requiredSelfStake(agentId, amount) <= positions(agentId, poolCreator).amount` |
| `"Self-stake locked while borrowing"` | `withdrawLiquidity` | `selfStake(agentId).locked == false` when `msg.sender == pool.agentAddress` |
| `"Exceeds credit limit"` (new cause) | `requestLoan` | now also fires at limit 0 for a locked-out agent — check `isLockedOut` and explain *why* |
| `"Loan already recorded"`, `"Loan/agent mismatch"` | V4, authorized-pool path only | operator tooling |
| `"growthStep must be > 0"`, `"Tier limit exceeds ceiling"`, `"creditMultiple too high"`, `"Bonus exceeds ceiling"`, `"Late penalty too high"`, `"Lockout too long"`, `"Threshold must be > 0"` | V4 owner setters | admin tooling |

Behavioural change for `prepare_supply_liquidity`: **`minSupplyAmount` no longer applies to the pool creator
supplying into its own pool**, so the existing "below the minimum supply" warning must not fire in that case.

### 8.5 New events for the monitor

| event | contract |
|---|---|
| `SelfStakeAbsorbedLoss(agentId, agentAddress, amount)` | V6.2 |
| `CreditCapacityUpdated(agentId, maxRepaidPrincipal)` | V4 |
| `AgentLockedOut(agentId, until)` | V4 |
| `LateRepaymentRecorded(agentId, loanId, lateSeconds, penalty)` | V4 |
| `LadderParametersUpdated`, `TierLimitsUpdated`, `DefaultLockoutUpdated`, `LatePenaltyParametersUpdated` | V4 — owner-lever changes; alert on all four |

`forensics/monitor/v6-invariants.js` should add: (i) `selfStake(agentId).amount >= requiredSelfStake(agentId, 0)`
for every agent with `outstandingPrincipal > 0` at a tier below 100 % collateral; (ii)
`creditLimitOf(agentId) <= MAX_TIER_LIMIT` for every agent; (iii) an alert on any `TierLimitsUpdated`.

---

## 9. Migration note

**This is a redeploy, not an upgrade.** Both contracts are fresh deploys with no proxy and no storage compatibility
with their predecessors. Concretely:

**Persists automatically (the registry is NOT redeployed):** `AgentRegistryV2` and every agent NFT, `agentId`, owner
and metadata entry. **Agent identities survive.** Nothing has to be re-minted and no agent has to re-register.

**Does NOT persist (V4 starts empty):** every reputation score, `totalBorrowed` / `totalRepaid` / `loanCount` /
`defaultCount`, and the `initialized` flag. `ReputationManagerV4` has **no migration helper, by design** — a
`seedReputation` would be exactly the owner blast radius that F-08 flagged on the marketplace side, and it would let
the owner mint credit limits directly. Consequences to plan for:

1. Every existing agent must call `initializeReputation()` again on V4 (score 100) and re-climb. With the tier cap
   at 5,000 and the ladder starting at 100, that re-climb is the real cost of this change — roughly the §4.2
   trajectory, ~158 days to the top tier under the live 5 pts/day rate limit.
2. The Arc mainnet population is small today (CLAUDE.md: pool #1 only, four closed loans, no third-party lender
   liquidity, faucet cohort 100). The practical cost is therefore near zero right now. **That is the argument for
   doing this before lenders arrive, not after.**
3. If preserving history is judged essential, the only route that does not re-open F-08 is a one-shot, verifiable
   `migrateFromV3(agentIds[])` that *reads* V3 and is permanently disabled by a `setMigrationFinalized`-style latch,
   with the ladder (`maxRepaidPrincipal`) deliberately **not** migrated — capacity must still be demonstrated on the
   new model. That is not implemented here.

**Marketplace state** (pools, lender positions, loans, fees) also does not migrate: `AgentLiquidityMarketplaceV62`
starts empty. It retains V6.1's `seedPool` / `seedPosition` / `setMigrationFinalized` helpers, so a snapshot
migration is possible — **and if no migration is performed, `setMigrationFinalized()` must be called in the same
deployment batch**, which is the F-08 lesson learned the hard way on 2026-09-19. (Dropping the helpers entirely
would close F-08 structurally and reclaim ~1.5 KB of the 3,277-byte headroom; they were left in to keep the
V6.1 → V6.2 diff reviewable, and removing them is the recommended follow-up if a snapshot migration is ruled out.)

**Deployment order and wiring:**

```
1. deploy ReputationManagerV4(registryV2)
2. deploy AgentLiquidityMarketplaceV62(registryV2, reputationV4, usdc)
3. reputationV4.authorizePool(marketplaceV62)
4. marketplaceV62.setMigrationFinalized()          # unless a snapshot migration is planned
5. levers: rep.setReputationRateLimit / setBonusReferenceAmount / setScoringParameters /
           setLadderParameters / setDefaultLockout / setLatePenaltyParameters / setTierLimits
           mkt.setMinSupplyAmount / setPlatformFeeRate / setMinHoldForReputationReward /
           setBindBorrowToPoolCreator(true)        # M-1 must stay ON — see §5
6. transferOwnership(secure wallet) on both, then acceptOwnership (Ownable2Step)
7. pause + revoke the OLD marketplace only after its lender positions are at zero
   (the 2026-09-19 precedent: V6.0 was left live because it still held ~849 USDC of lender funds)
8. reputationV3.revokePool(oldMarketplace) once the old marketplace is retired, so two live
   marketplaces can never write to the same reputation state
```

Verification after deploy: `VERSION()` on both, the full lever read-back, `MAX_TIER_LIMIT()` and all six
`tierLimits(i)` / `tierCollateralPct(i)`, then the §6.2 invariants against the live addresses.

---

## 10. Files

| path | contents |
|---|---|
| `contracts/core/ReputationManagerV4.sol` | M1 — the new credit model |
| `contracts/core/AgentLiquidityMarketplaceV62.sol` | M2 + L7 — `VERSION() == "V6.2"` |
| `contracts/sim/ReputationManagerV4Sim.sol` | the report's M1 scratch contract, ported for the ablation rows only — **not for deployment** |
| `test/v7/{_fixture,M1-ReputationManagerV4,M2-SelfStake,V62-PriorFixesRegression}.js` | 95 hardhat tests |
| `test/foundry/V7Invariants.t.sol` | 7 stateful invariants, 9,216 calls |
| `scripts/sim/lib/{harness,strategies}.js` | the ported and extended economic harness |
| `scripts/sim/run-v7-model.js` | the attacker and honest campaigns behind §3 and §4 |
| `scripts/sim/gas-v62-vs-v61.js` | §6.4 and §6.5 |
| `scripts/sim/out/{v7-model,gas-and-size,slither-v7-new-contracts,storage-rmv4,storage-v62}.json` | raw results |
| `forensics/output/v7-model/V7_DESIGN_AND_VALIDATION.md` | this document |
| `forensics/output/v7-model/v7-model.patch` | the whole change as a single `git apply`-able patch |
