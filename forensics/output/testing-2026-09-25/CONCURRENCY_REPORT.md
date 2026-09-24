# Specular V7 under genuine CONCURRENCY — race-by-race report

**Date:** 2026-09-25 · **Stack under test:** `AgentLiquidityMarketplaceV62` (`VERSION() == "V6.2"`) +
`ReputationManagerV4` + `AgentRegistryV2`, unmodified — `git diff -- contracts/` is empty.
**Where:** hardhat chainId 31337 for everything needing many accounts, hand-built blocks or time travel;
Arc **staging** (chainId 5042002, marketplace `0x7E4D144AbEB3C695Ec2DdF00Fc710aABC04bDd18`) for real
mempool ordering. **Nothing was broadcast to Arc mainnet (5042) or Base (8453)** — those were not
contacted at all.

---

## 0. Headline

| | |
|---|---|
| Races driven | **8 families, 37 scenarios, 412 contended runs** locally, plus **12 phases across 3 scripts** on Arc staging |
| Same-block batches built by hand | every one of them; orderings **enumerated exhaustively** (all *k*! for *k* ≤ 4) rather than sampled |
| Invariants asserted | **16** (I-a1…I-s), after **every** contended batch — and after every transaction in the randomised sweeps |
| Contract-level invariant violations | **0**, locally and on Arc staging |
| Double-spends, over-subscribed caps, stranded collateral, double settlements | **0** in every ordering tested |
| Self-stake lock (M2-a/M2-c) | **holds atomically.** 480 probes after real transactions: the creator's withdrawal was permitted only while `outstandingPrincipal == 0`, never once otherwise |
| Reputation rate limit + credit ladder (the F-04 controls) | **hold.** Batching never beat one-at-a-time; it is neutral at best and worse in the usual case |
| Protocol findings | **1 MEDIUM** — a supply placed *behind* `requestLoan` in the **same block** qualifies for that loan's interest (up to 83 % dilution of the pre-existing lender). **1 LOW** — claiming interest ahead of a lossy liquidation shifts the loss onto the lenders who did not claim |
| Client findings | **1 MEDIUM** — N concurrent identical calls from one wallet are ONE transaction that reports success N times (10 USDC moved where 60 was intended, measured on Arc staging). **2 LOW** — no revert reason and no retryability from the SDK; no simulation block and misleading contended advice from the MCP server. **All three fixed, test first** |
| Gas/throughput under contention | per-transaction gas is **identical** alone or as the 49th of 49 in a block; total block gas is **exactly linear** in occupancy (marginal ratio 1.000); 4.16× throughput on staging for the same work |
| Suites after the client fixes | hardhat **883 passing, 0 failing**; mcp-server **127 passing, 0 failing** |

---

## 1. What "concurrent" can and cannot mean here, and how it was tested

The EVM executes a block's transactions strictly one after another, each atomic. Two contract calls
cannot interleave mid-body, and every **value-moving** entry point on V6.2 carries `nonReentrant`
(`supplyLiquidity`, `withdrawLiquidity`, `requestLoan`, `repayLoan`, `liquidateLoan`, `claimInterest`,
`withdrawFees`), so two of them cannot even be composed inside one transaction. (`createAgentPool` is the
one unguarded public entry point, and it moves no funds.) A "race" in this protocol is therefore always
one of exactly three things, and each needs a different instrument:

| | What it is | How this round detects it |
|---|---|---|
| **R1 — order dependence** | the same set of transactions in one block yields a different winner or a different end state depending on the order the producer chose | build the block by hand (`evm_setAutomine(false)` → N sends → exactly one `evm_mine`) and **enumerate the orderings**: all *k*! for *k* ≤ 4, rotations + reverse above that |
| **R2 — TOCTOU between an off-chain read and the transaction** | the client decided from a view taken at block *n*; the transaction executes at *n+1* against state somebody else moved | capture the view before the batch, compare against the receipt (§3, race 2.4) |
| **R3 — a mid-block invariant break** | an invariant that holds at the end of a block but not between two of its transactions | not externally observable — but also not exploitable, because `nonReentrant` forbids composing two entry points in one transaction. Approximated by re-checking the full invariant set after **every** transaction in the randomised sweeps |

Two techniques make the results sharper than a pass/fail:

* **Every reverted transaction is replayed** as an `eth_call` against the state at the *start* of its
  block and at the *end* of it, and the revert reason is read from the **actual execution's trace**
  (`debug_traceTransaction`, default tracer — hardhat/EDR has no `callTracer`). That distinguishes an
  unconditional refusal from a purely **positional** one. It is not a nicety: in race 2.1 case
  `[200, 199, 1200]` the transaction reverts `Remaining below minimum supply`, but replaying it at
  end-of-block state answers `Insufficient pool liquidity` — a different, wrong story, because a later
  transaction in the same block drained the pool.
* **Hardhat's mempool is pinned to FIFO** and the harness enumerates orderings itself. That is strictly
  stronger than testing one priority-fee auction: it covers *every* choice a block producer could make,
  not just the fee-ordered one. (`hardhat_setMempoolOrder` does not exist on the EDR provider in
  hardhat 2.29; the harness detects that and falls back cleanly.)

### The invariant set (asserted after every contended batch)

| id | invariant |
|---|---|
| I-a1 | per pool: `totalLiquidity == Σ position.amount` |
| I-a2 | per pool: `availableLiquidity + totalLoaned == Σ (amount + earnedInterest)` |
| I-a3 | global: `usdc.balanceOf(marketplace) == Σ availableLiquidity + accumulatedFees + Σ collateral of ACTIVE loans` |
| I-b | `pendingTranche.amount ≤ position.amount` for every (pool, lender) |
| I-c1 | `poolLenders[]` holds no duplicate entry (the §B1 guarantee) |
| I-c2 | `isInPoolLenders[l]` ⇔ `l ∈ poolLenders[]`, checked over **every address the harness ever touched**, not just the listed ones |
| I-c3 | `poolLenders.length ≤ MAX_LENDERS_PER_POOL` |
| I-c4 | every listed lender has principal or unclaimed interest (no dust-slot leak) |
| I-d1 | `activeLoanCount == |activeLoanIds| ==` number of ACTIVE loans |
| I-d2 | `activeLoanIds` has no duplicates and every entry is ACTIVE |
| I-h | `outstandingPrincipal[a] == Σ` ACTIVE principal of `a` |
| I-m2a | while `outstandingPrincipal > 0` the creator's withdrawal is impossible (probed as a `staticCall`) |
| I-m2c | while principal is outstanding below the 100 % tier, `selfStake ≥ requiredSelfStake` |
| I-q | `creditLimitOf ≤ MAX_TIER_LIMIT` |
| I-r | a locked-out agent's credit limit is exactly 0 |
| I-s | `ladderLimit == max(bootstrap, k·maxRepaid + step)` and `creditLimit == min(tier, ladder)` |

---

## 2. Race-by-race results

Every row is contended — the transactions in each batch are in **one block**, competing for the same
state. "Runs" counts distinct executions (amount shape × ordering × repetition).

### Race 1 — same-block supply contention

| Scenario | Runs | Outcome | Invariants | Violations |
|---|---:|---|---|---:|
| 1.1 N lenders supply one pool in one block (N = 2, 5, 10, 25, 49; both directions) | 20 | all N land; `totalLiquidity`, `availableLiquidity` and `lenderCount` move by exactly the sum | all 16 | 0 |
| 1.2 49 slots full, creator **not** staked, k third parties race the last slot (k = 2, 3, 5, 10 × every ordering) | 25 | **0 winners in every ordering.** `lenderCount` stays 49. Every refusal is the explainable `Last slot reserved for agent self-stake`, and none is ordering-dependent | all 16 | 0 |
| 1.3 creator + k third parties race the *same* last free slot (k = 1, 2, 3 all orderings; k = 9 rotations) | 43 | **the creator always gets in**, in every ordering, including when its stake is *below* `minSupplyAmount` (the M2-a exemption). Cap never exceeds 50 | all 16 | 0 |
| 1.4 creator staked, 50 slots full, k racers (k = 2, 3, 6 × orderings) | 15 | every racer refused `Pool lender capacity reached`; no 51st slot in any ordering | all 16 | 0 |
| 1.5 full pool: one lender exits and k newcomers race the freed slot in the **same block** (k = 2, 3 × orderings × exit position) | 16 | **exactly one** newcomer admitted when the exit is placed first; **zero** when it is placed last, and those refusals replay successfully one slot later (positional) | all 16 | 0 |
| 1.6 `minSupplyAmount` under contention, incl. a sub-minimum chaser behind the same sender's own qualifying supply | 12 | no sub-minimum **new** position ever landed; `isInPoolLenders` stayed false for the sub-minimum sender in all 12 | all 16 | 0 |

**Can two transactions both believe they took the last slot?** No. `_claimLenderSlot` reads
`poolLenders[agentId].length` and pushes inside the same transaction, so the second contender sees the
first's push. Across 99 contended runs at the boundary the length never exceeded 50 and never exceeded
49 while the creator's slot was reserved.

**Order dependence found (benign):** *which* third party gets slot 50 in 1.3, and whether a sender's own
sub-minimum top-up lands in 1.6, both depend on the ordering. Neither breaks an invariant; both are
client-visible and are covered in §7.

### Race 2 — borrow vs withdraw

| Scenario | Runs | Outcome | Invariants | Violations |
|---|---:|---|---|---:|
| 2.1 one withdraw + one borrow that cannot both fit (7 amount shapes × both orders) | 14 | **exactly one wins, always.** USDC moved equals the single winner's amount to the base unit; the loser moved nothing | all 16 | 0 |
| 2.2 withdraw + borrow that together fit (4 shapes × both orders) | 8 | both succeed; `availableLiquidity` falls by exactly `withdraw + borrow` | all 16 | 0 |
| 2.3 3 lenders withdrawing + 1 borrow, **every** ordering | 24 | Σ(money out) ≤ `availableLiquidity` in all 24; contract USDC movement equals the sum of the successful calls exactly | all 16 | 0 |
| 2.4 TOCTOU: agent sizes a loan from `availableLiquidity` read one block earlier | 10 | **refused 10/10** when any lender exits in between | all 16 | 0 |
| 2.5 lender withdraws in the same block a loan is repaid (both orders) | 6 | withdraw-first reverts `Insufficient pool liquidity` and the replay proves it would succeed one slot later; repay-first succeeds | all 16 | 0 |

**Can the pool lend liquidity that was simultaneously withdrawn?** No. `requestLoan` and
`withdrawLiquidity` both read and write `pool.availableLiquidity` within their own transaction, so the
second sees the first's write. The interesting result is the **asymmetry**: a lender's withdrawal can be
denied by the agent's borrow landing first (2.1, withdraw-last). The lender's capital is not lost, only
illiquid until the loan closes — but it is the lender, not the borrower, who eats the ordering risk.

### Race 3 — self-stake lock (M2)

| Scenario | Runs | Outcome | Invariants | Violations |
|---|---:|---|---|---:|
| 3.1 creator withdraw + own `requestLoan` in one block (8 stake/withdraw/borrow combinations × both orders) | 16 | borrow-first ⇒ withdraw refused `Self-stake locked while borrowing`; withdraw-first ⇒ borrow refused `Insufficient self-stake` **iff** the remaining stake no longer covers it, and succeeds when it does. **No ordering lands both while coverage is short** | all 16 | 0 |
| 3.2 withdraw one block *before* / one block *after* the borrow, with a lock probe at every step | 12 | probe never once found `outstandingPrincipal > 0` together with a permitted creator withdrawal | all 16 | 0 |
| 3.3 repay + creator withdraw + new borrow in one block, **every** ordering × 3 stake levels | 18 | no ordering left principal outstanding against a stake below the requirement | all 16 | 0 |
| 3.4 two active loans; repay one and withdraw the stake in the same block (both orders) | 6 | withdrawal refused in **all 6** — closing one of two loans does not unlock the stake | all 16 | 0 |
| 3.5 randomised sweep, 40 runs × 12 operations, lock probed after **every transaction** | 480 probes | the creator's withdrawal was permitted **only** while `outstandingPrincipal == 0` | all 16, after every op | 0 |

**Is there a window where principal is outstanding and the stake is withdrawable?** **No, and the reason
is structural, not incidental.** The lock (`msg.sender != pool.agentAddress || outstandingPrincipal == 0`)
and the coverage gate (`positions[agentId][creator].amount ≥ requiredSelfStake(outstanding + amount)`)
read the *same two storage slots* the two calls write. A withdrawal that precedes the borrow in the same
block is already visible to the borrow's coverage check; a borrow that precedes the withdrawal has
already incremented `outstandingPrincipal`. The lock therefore engages atomically with the borrow by
construction, and 480 post-transaction probes found no counter-example.

### Race 4 — repay vs liquidate

| Scenario | Runs | Outcome | Invariants | Violations |
|---|---:|---|---|---:|
| 4.1 unsecured overdue loan, repay + liquidate in one block (4 sizes × 1 d and 40 d late × both orders) | 16 | exactly one settles, always; the loser reverts `Loan not active`. When liquidation wins, the borrower's USDC balance is **unchanged** — it is not charged for a loan taken from under it | all 16 | 0 |
| 4.2 100 %-collateralised overdue loan (3 sizes × both orders) | 6 | collateral is **either** refunded to the borrower (repay) **or** seized into `availableLiquidity` (liquidation) — never both, never orphaned. I-a3 is the detector and held in every ordering | all 16 | 0 |
| 4.3 liquidation cron double-fire: 2–3 `liquidateLoan` for the same id in one block | 6 | exactly one settles; `totalLoaned` falls by the principal exactly once | all 16 | 0 |
| 4.4 repay(L1) + liquidate(L1) + liquidate(L2) + a fresh borrow, **every** ordering | 24 | loan 1 settles exactly once in all 24; loan 2 always liquidates; no double accounting | all 16 | 0 |

The cron double-fire (4.3) is the operationally real version of this race and it is clean: the second
call sees `LoanState != ACTIVE` and reverts before touching anything.

### Race 5 — interest distribution under contention

| Scenario | Runs | Outcome | Invariants | Violations |
|---|---:|---|---|---:|
| 5.1 uncontended repay with mixed tranche histories (6 shapes) | 6 | every lender's share exact to the base unit against the independent model | all 16 | 0 |
| 5.2 repay contended with a top-up, a withdrawal and a claim in one block, **every** ordering × 2 shapes | 48 | the model predicted **both** which calls succeed **and** every lender's principal, pending tranche and `earnedInterest` exactly, in all 48 | all 16 | 0 |
| 5.3 supply placed *behind* `requestLoan` in the same block (4 sizes) | 4 | **the back-runner qualifies for that loan's interest** — see finding F-1 | all 16 | 0 (economic finding) |
| 5.3b the same back-runner exits before repayment (3 sizes) | 3 | share is **exactly 0** — the capital must stay in the pool until the loan closes | all 16 | 0 |
| 5.4 two loans, overlapping lender sets, both repaid in one block, top-ups interleaved (3 shapes × both orders) | 6 | exact per lender; a lender who supplied after both loans started earned exactly 0 | all 16 | 0 |
| 5.5 49 lenders, repay contended with a top-up and a withdrawal (4 runs) | 4 | Σ shares + dust == `lenderInterest` exactly; dust lands in `accumulatedFees` exactly | all 16 | 0 |

See §4 for the exact-share method and numbers.

### Race 6 — credit ladder and rate-limit (the F-04 controls)

| Scenario | Runs | Outcome | Invariants | Violations |
|---|---:|---|---|---:|
| 6.1 up to 10 loans repaid in a **single block** (N = 2, 5, 10 × 3) | 9 | total reputation gain never exceeded the window head-room. All repayments in a block share one `block.timestamp`, so the rolling window can roll **at most once** for the whole batch | all 16 | 0 |
| 6.2 repayments straddling the rate-limit window boundary | 6 | gain inside a saturated window = 0; gain at the boundary = 5 (the limit). Worst instantaneous burst is bounded at 2 × `maxGain`, and is not improvable by racing | all 16 | 0 |
| 6.3 10 differently-sized loans repaid in one block (both directions) | 4 | `maxRepaidPrincipal` became the **maximum** (310 USDC), never the sum (1,470 USDC) | all 16 | 0 |
| 6.4 12 `requestLoan` in **one block** | 5 | ≤ 10 land (the concurrent-loan cap); aggregate `outstandingPrincipal` never exceeded `creditLimitOf` | all 16 | 0 |
| 6.5 repay (advancing the ladder) + a larger borrow in the same block, both orders | 6 | outstanding never exceeded the line as of the borrow's own position | all 16 | 0 |
| 6.6 liquidation (starting the lockout) + `requestLoan` in the same block, both orders | 6 | a borrow behind the liquidation is always refused; credit limit is exactly 0 afterwards; no later block admits a borrow either | all 16 | 0 |
| 6.7 F-04 control: 12 rounds of ladder growth, batched (4 concurrent loans/round) vs one-at-a-time, **all repaid on time** | 1 | batched reached `maxRepaidPrincipal` **1,200 USDC**; sequential reached **2,500 USDC**. Both ended at the same credit limit (2,500, the tier cap). **Racing advantage: 0** | all 16 | 0 |

**Can an agent gain more reputation or ladder capacity by racing?** **No.**

* *Reputation*: the window counters (`windowStart`, `gainedInWindow`) are read-modify-written inside each
  `recordLoanCompletion`, and a batch of repayments shares one `block.timestamp`, so the window rolls at
  most once no matter how many are in the block. 9 batched runs, gain ≤ head-room every time.
* *Ladder*: `maxRepaidPrincipal` advances to the **largest single on-time repayment**, so splitting a
  round into four concurrent loans divides the demonstrated size by four. Batching raised the *score*
  faster (more repayment events) but the credit line is `min(tier, ladder)` and the tier caps it — and
  with the live rate limit on (5 points/86,400 s), 6.1 shows the score advantage is capped too.
* *Aggregate exposure*: `outstandingPrincipal + amount ≤ creditLimit` is evaluated per `requestLoan`
  against the counter the previous one in the block already incremented. 12-way batches never exceeded
  the line.

### Race 7 — contention throughput and gas

See §5 (local) and §6 (Arc staging, real mempool).

### Race 8 — `claimInterest` racing a LOSSY liquidation (not in the original six; it falls out of them)

D4 removed first-come-first-served **withdrawal** for principal; F-05 extended the waterfall to
**unclaimed interest** when a loss overruns all principal. But a claim is still a separate
transaction, so the same question has to be asked about interest.

| Scenario | Runs | Outcome | Invariants | Violations |
|---|---:|---|---|---:|
| 8.1 lossy liquidation + `claimInterest` in one block, both orders, across three draw-down regimes | 6 | solvency, per-pool conservation and the F-05 "every remaining claim stays backed" property hold in **every** case. Distributionally the ordering matters — see finding F-2 | all 16 | 0 (economic finding) |

---

## 3. Findings

### F-1 — MEDIUM · a supply placed *behind* `requestLoan` in the **same block** earns that loan's interest

**What.** Interest qualification is `depositTimestamp ≤ loan.startTime` (`qualifiedAmountAt`). Both are
`block.timestamp`. A lender who watches the mempool, sees a `requestLoan`, and back-runs it with a supply
**in the same block** therefore compares **equal** and qualifies for that loan's interest — having funded
none of it. The identical supply one block later qualifies for exactly nothing.

This is the residual of the W1 mempool-sandwich mitigation: the stamp blocks the *later-block* sandwich,
but same-block equality slips through.

**Measured** (pre-existing honest lender holds 1,000 USDC; loan 1,000 USDC, 7 d, 5 % APR, 1 % fee):

| Back-run stake | Back-runner's qualified amount | Back-runner's share | Honest lender's share | Honest lender diluted by |
|---:|---:|---:|---:|---:|
| 500 USDC | 500 USDC | 246,118 | 492,237 | **33.3 %** |
| 1,000 USDC | 1,000 USDC | 415,325 | 415,325 | **50.0 %** |
| 2,000 USDC | 2,000 USDC | 632,876 | 316,438 | **66.7 %** |
| 5,000 USDC | 5,000 USDC | 922,945 | 184,589 | **83.3 %** |

(shares in USDC base units; the same supply one block later earns **0** in every row.)

**Why MEDIUM and not higher.** Race 5.3b bounds it: the back-runner's capital must sit in the pool,
exposed to socialised default loss, until the loan is repaid. Withdrawing first forfeits the entire share
(`qualifiedAmountAt` reads the *current* `position.amount`). It is therefore "jumping the lender queue by
one block", not theft — the back-runner takes the same risk as the lenders it dilutes, for the same
duration. It also needs a free lender slot and `minSupplyAmount`. The loss to existing lenders is real
but is capped by their pro-rata share of one loan's interest.

**Reproduction** (fails on a fix that makes qualification strict; passes today, recording the dilution):

```
npx hardhat --config hardhat.concurrency.config.js \
  test forensics/output/testing-2026-09-25/harness/C5-interest-exact-shares.test.js -g '5.3'
```

Minimal shape: fund a pool with one honest lender, then put `requestLoan` and the back-runner's
`supplyLiquidity` in **one block** in that order; `qualifiedAmountAt(agentId, backrunner, loan.startTime)`
returns the full stake.

**Fix, if it is judged worth one** (a contract change, therefore *not* applied here): make the base
tranche's qualification strict — `p.depositTimestamp < loanStartTime` — or stamp `requestLoan`'s
`startTime` as `block.timestamp` while stamping supplies as `block.timestamp + 1`. Either turns the
same-block back-run into a non-qualifier while leaving genuine prior lenders untouched. Note the cost:
a supply and a loan that legitimately land in the same block (a fresh pool bootstrapping) would then not
qualify either, and that interest would route to fees via the `qualifiedTotal == 0` arm.

### F-2 — LOW · claiming interest ahead of a lossy liquidation shifts the loss onto the lenders who did not claim

**What.** When a default's loss overruns *all* principal (the self-stake first, then every lender's
principal), `_socializeInterestLoss` charges the remainder pro-rata across **unclaimed interest**.
`claimInterest` is a separate transaction, so a lender who claims in the same block *ahead* of the
liquidation keeps its whole balance and the shortfall lands entirely on the lenders who did not. This is
the same first-come-first-served shape D4 removed for principal, surviving for interest.

**Measured** (pool drawn down by `Σ principal + δ`, so exactly δ must come out of interest; the
claimant held 27.72 USDC of the pool's ~69.3 USDC interest pile):

| regime | is a claim payable before the liquidation? | claimed FIRST | claimed BEHIND | advantage of going first | the other lender's loss (first / behind) |
|---|:--:|---:|---:|---:|---:|
| partially drawn, δ = 20 USDC | yes | 27.720000 | 19.720000 | **8.000000** | 13.333333 / 8.000000 |
| partially drawn, δ = 35 USDC | yes | 27.720000 | 13.720000 | **14.000000** | 23.333333 / 14.000000 |
| drawn to the floor | **no** | 0 | 0 | **0** | 27.719999 / 27.719999 |

**The guard that already limits it.** In the fully-drawn regime the claim reverts `Drain underflow`
(`require(pool.availableLiquidity >= interest)`) **whichever way the block is ordered**, so nobody can
get out ahead of the loss. The exploitable window is exactly the partially-drawn band: the loss must
overrun all principal (δ > 0) while `availableLiquidity` still covers the claimant's balance — i.e.
δ < Σ interest − (claimant's interest).

**Why LOW.** It requires a default that has already wiped the agent's entire self-stake *and* every
lender's principal — a pool that is a write-off either way. The transfer is bounded by δ × the
claimant's share of the interest pile, which is bounded by the interest pile itself. Solvency, per-pool
conservation and "every remaining claim stays backed" hold in every ordering and both regimes: the
protocol is never left short, only the split between lenders changes.

**Reproduction:**

```
npx hardhat --config hardhat.concurrency.config.js \
  test forensics/output/testing-2026-09-25/harness/C8-claim-vs-liquidation.test.js
```

### F-3 — MEDIUM (client) · N concurrent identical calls from one wallet are ONE transaction that reports success N times

**What.** Measured on Arc staging, twice, in two independently-written harnesses. Six identical
`supplyLiquidity(agentId, 10 USDC)` calls fired with `Promise.all` from one wallet:

* all six read `eth_getTransactionCount(pending)` before any had been broadcast, so ethers allocated
  **nonce 4** to all six;
* identical calldata + identical nonce + identical fee is the **same signed transaction**, so all six
  hashes were equal;
* the RPC accepted every one of them **with no error at all** and returned that hash;
* every receipt lookup then found the same successful receipt — **six `status: 1` results**;
* the wallet's nonce advanced 4 → 5 and the position moved **10 USDC, not 60**.

A client that fires concurrent calls and checks the receipts is told, with no error anywhere, that
transactions it never made succeeded. Nothing on-chain is wrong; the client's accounting is.
(Hardhat/EDR at least answers `Known transaction: 0x…` for the duplicates. The Arc RPC said nothing.)

With the repo's existing `NonceCounter` the same six get distinct nonces, all six land — in **one
block** — and the position moves the full 60 USDC. `SpecularSDK` was not using it.

**Evidence:** `staging-concurrency-result.json` phase 7.1a (3 runs) and
`staging-nonce-burst-result.json` phase 7.1d (unthrottled).
**Fixed** — `SpecularSDK.sendTransactionSerialized`, §8.3, with 5 tests.

### F-4 — LOW (client) · the SDK reported "reverted on-chain" with no reason and no retry guidance

Every contended race ends with the loser reverting. `SpecularSDK` turned that into
`Loan request tx 0xabc… reverted on-chain` — no reason string, nothing to decide with. Three of the most
common contended refusals are ones a client **should** re-send unchanged, and one that looks similar
(`Loan not active`) is one it must **not**, because it can mean the loan was liquidated rather than
repaid. **Fixed** — §8.1.

### F-5 — LOW (server) · the MCP server's simulation had no block and no retryability, and two of its plain-language strings were wrong in the contended case

`simulateCall` answered `{ok, revertReason, plainLanguage}` with no indication of (a) which block the
answer belonged to — although the caller signs and broadcasts afterwards — or (b) whether the refusal was
somebody else's transaction getting there first. Its advice for the two most common contended refusals
pointed the wrong way: *"Insufficient pool liquidity → lower the amount, or supply/attract liquidity
first"* and *"Pool lender capacity reached → choose another pool"*, when in both cases the correct first
response is to re-read and retry. A third, `Drain underflow`, said *"contact the protocol owner"* when
the real cause is almost always that the pool's liquidity is out on loan — which race 8 hit directly.
**Fixed** — §8.2.

---

## 4. Exact-share verification for interest

Asserting that the shares *sum* to the interest would hide a mis-attribution between lenders, which is
precisely what contention could cause. So the V6.1/V6.2 tranche rules were **re-implemented in
JavaScript from the contract's specification** — the (a)…(e) top-up cases, LIFO withdrawal, per-tranche
qualification, floor division, dust-to-fees — and every lender's `earnedInterest`, principal and pending
tranche compared exactly. The model never calls the contract's own views, so agreement is evidence rather
than a tautology. It lives in `harness/C5-interest-exact-shares.test.js` (`applyOp`).

What the model predicts, and what was checked against the chain after every contended block:

* per lender: `position.amount`, `pendingTranche.amount`, `position.earnedInterest` — **exact to the base unit**;
* pool: `availableLiquidity`; protocol: `accumulatedFees`;
* **and which calls succeed**: the model also predicts each operation's success/refusal, and the batch is
  asserted to agree. A disagreement there would mean the documented rules and the deployed code differ.

**Result: 0 mismatches across 71 contended repayments** (5.1 × 6, 5.2 × 48, 5.3 × 4, 5.3b × 3, 5.4 × 6,
5.5 × 4). Representative 49-lender run:

| run | interest | fee (1 %) | lenderInterest | Σ distributed | dust → fees | Σ + dust == lenderInterest |
|---:|---:|---:|---:|---:|---:|:--:|
| 0 | 1,342,465 | 13,424 | 1,329,041 | 1,329,019 | 22 | ✓ |
| 1 | 1,343,808 | 13,438 | 1,330,370 | 1,330,342 | 28 | ✓ |
| 2 | 1,345,150 | 13,451 | 1,331,699 | 1,331,670 | 29 | ✓ |
| 3 | 1,346,495 | 13,464 | 1,333,031 | 1,333,002 | 29 | ✓ |

The pending-tranche logic is the part contention was most likely to break, and it did not: **a top-up
that lands before the repayment in the same block does not dilute the qualified set**, because its
pending tranche is stamped `block.timestamp` while the loan started strictly earlier. (F-1 is the mirror
image of that same equality, one block earlier in the loan's life.)

---

## 5. Throughput and gas under contention vs the sequential baseline

Baseline: `forensics/output/v7-model/V7_SCALE_AND_GAS_REPORT.md`, which metered execution gas one call at
a time under `forge test --isolate`. The figures below are **transaction-level** receipts (so they
include the 21,000 intrinsic cost plus calldata, ≈ +21.5 k), taken from hand-built blocks.

### 5.1 Does occupancy change the cost of a call? No.

The controlled comparison — the *identical* `supplyLiquidity` into an already-warm pool, once alone in a
block and once as a member of a 40-way block:

| | gas |
|---|---:|
| alone in its own block | **161,296** |
| as one of 40 in one block | **161,296** |
| spread between the 40 members of that block | **0** |

EIP-2929 access lists are per-**transaction**, so nothing a block-mate does makes a call cheaper or
dearer. Every variation observed is **state**-dependent, not occupancy-dependent:

| scenario | N=1 | N=10 | N=25 | N=49 | within-block spread | cause of the spread |
|---|---:|---:|---:|---:|---:|---|
| `supplyLiquidity`, fresh slot | 229,696 | 161,296 (last) | 161,296 | 161,296 | 68,400 | the block's **first** supply writes cold pool slots |
| `requestLoan` | 517,573 | 432,073 (last) | — | — | 85,500 | same: first loan warms the pool |
| `repayLoan`, 50-lender pool | 1,870,091 | 969,392 (last) | — | — | 924,699 | the first repayment writes 50 zero→non-zero `earnedInterest` slots; later ones are non-zero→non-zero |
| `withdrawLiquidity`, full exit | 69,337 | — | 102,596 (max) | — | 33,259 | swap-and-pop position in `poolLenders[]` |

The `repayLoan` row is worth keeping: **the first repayment into a fresh 50-lender pool costs ~1.93× a
subsequent one.** That is inherent to cold storage, not to contention, but it is the number a client
should size gas against.

### 5.2 Is anything non-linear in block occupancy? No.

Total block gas for N same-block `supplyLiquidity`:

| N | 1 | 2 | 5 | 10 | 20 | 30 | 40 | 49 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| total block gas | 229,696 | 390,992 | 874,880 | 1,681,360 | 3,294,320 | 4,907,280 | 6,520,240 | 7,971,904 |
| gas per tx | 229,696 | 195,496 | 174,976 | 168,136 | 164,716 | 163,576 | 163,006 | 162,691 |

Marginal cost per additional transaction: **161,296 at the start of the block, 161,296 at 49 — ratio
1.000.** Exactly linear. The falling "per tx" column is only the first transaction's cold-slot premium
being amortised.

### 5.3 Saturation at Arc's 30 M block

| operation | measured avg gas | operations per 30 M block |
|---|---:|---:|
| `supplyLiquidity` (fresh slot) | 162,691 | **≈ 184** |
| `requestLoan` | 440,623 | **≈ 68** |
| `repayLoan`, 50-lender pool (first) | 1,870,091 | ≈ 16 |
| `repayLoan`, 50-lender pool (subsequent) | 969,392 | ≈ 30 |

The protocol's own caps bind long before the block does: 50 lender slots per pool, 10 active loans per
agent. A single pool cannot generate more than 49 fresh-slot supplies or 10 concurrent loans, so the
block-gas ceiling is not reachable by contention on one pool — it would take ~4 pools saturating
simultaneously to fill an Arc block with supplies.

---

## 6. Arc staging — nonce and mempool reality

Chain: Arc **staging**, chainId 5042002, marketplace `0x7E4D144AbEB3C695Ec2DdF00Fc710aABC04bDd18`
(`VERSION() == "V6.2"`, unpaused, live levers: minSupply 10 USDC, fee 100 bps, minHold 86,400,
M-1 on, rate limit 5/86,400). Block gas limit 30,000,000. Two throwaway agents (#70, #71) and
ten throwaway lenders, funded from the deployer. Arc mainnet and Base were never contacted.

**Global solvency was exact before and after every run**
(`balance == Σ availableLiquidity + accumulatedFees + Σ ACTIVE collateral`, delta **0**, across
19–20 pools and 118 → 124 loans). **0 invariant violations** on every pool touched.

### 6.1 The client-side finding: concurrent identical calls collapse into one transaction

| phase | what was fired | result |
|---|---|---|
| 7.1a (×3) | 6 × identical `supplyLiquidity(agentId, 10 USDC)` via `Promise.all`, ethers' default nonce allocation | **all 6 broadcast with no error, all 6 receipts `status: 1`, 1 distinct nonce — and the position moved 10 USDC, not 60** |
| 7.1d | the same, against a completely unthrottled provider | nonce **4** allocated to all six; `nonceBefore` 4 → `nonceAfter` 5; **zero send errors**; six "successful" receipts; position **+10 USDC of the 60 intended** |
| 7.1e | nonce-gap probe afterwards | **no gap** — the collapse duplicates a transaction, it does not skip one |
| 7.1b (×2) | the same 6 with the repo's own `NonceCounter` (`src/sdk/nonce.js`) | 6 distinct nonces, 6 distinct transactions, position **+60 exactly** |
| 7.1f | the same with `NonceCounter`, unthrottled | 6 distinct nonces, **all six in ONE block** (63830016), position +60 exactly |
| 7.1c | two sends at the SAME nonce, second with a 50 % fee bump | the original had already been mined; the "replacement" was refused **`nonce has already been used`** — Arc does not let a fee bump displace a mined transaction |

**Mechanism.** `Promise.all` makes all six calls read `eth_getTransactionCount(pending)` before any of
them has been broadcast, so ethers hands the same nonce to all six. Identical calldata + identical
nonce + identical fee is the **same signed transaction**, so all six hashes are equal — the RPC
accepted each one and returned that hash, and every receipt lookup then found the same successful
receipt. **A client that "checks the receipts" is told six times that a transaction it never made
succeeded.** Nothing on-chain is wrong; the client's books are.

Hardhat/EDR at least answers `Known transaction: 0x…` for the duplicates. The Arc RPC answered
nothing at all, which is what makes the real-chain version silent. This is **F-4**, and it is fixed
(§8.3).

### 6.2 Real same-block contention between independent wallets

| phase | what was fired | result |
|---|---|---|
| 7.2 (×3, throttled harness) | 10 distinct wallets supply the same pool simultaneously | 10/10 landed, `totalLiquidity` moved by exactly the sum of the successful supplies, `lenderCount` 10, **0 invariant violations** |
| 7.2b (unthrottled) | the same 10 wallets | **all 10 landed in ONE block** (63830022), `totalLiquidity` +145 USDC == Σ successful supplies **exactly**, `lenderCount` 10, 3.87 tx/s |

The throttled runs showed at most 1–2 transactions per block; that was the harness's own token bucket
serialising `eth_sendRawTransaction`, not the chain. Removed, ten independent wallets contend inside a
single Arc block and the accounting is exact — the same answer the hand-built hardhat blocks gave.

### 6.3 Borrow vs withdraw with real ordering (fresh pool, agent #71)

Pool sized so only one call fits: `availableLiquidity` 150 USDC, borrow 100, withdraw 100.

| run | order | winner | loser's reason | availableLiquidity Δ | == winner's amount | same block |
|---:|---|---|---|---:|:--:|:--:|
| 0 | withdraw first | WITHDRAW | `Insufficient pool liquidity` | 100 | ✓ | ✓ |
| 1 | borrow first | BORROW | `Insufficient pool liquidity` | 100 | ✓ | ✓ |
| 2 | withdraw first | WITHDRAW | `Insufficient pool liquidity` | 100 | ✓ | ✓ |
| 3 | borrow first | BORROW | `Insufficient pool liquidity` | 100 | ✓ | ✓ |

Exactly one winner every time, it is always the transaction the sequencer put first, the loser moved
**nothing** (balance unchanged, verified both ways round), and `availableLiquidity` fell by exactly the
winner's amount. This is the hardhat result (§2, race 2) reproduced against a real mempool.

### 6.4 Double-firing the same settlement

* **Two DISTINCT transactions** (same `repayLoan(loanId)`, different gas limit ⇒ different payload ⇒
  different hash), fired concurrently: the second was refused **at broadcast** with
  `replacement fee too low` — same nonce, different payload, same fee. Exactly one settled,
  `totalLoaned` fell exactly once, final state `REPAID`, 0 invariant violations. 2/2 runs.
* **Two IDENTICAL transactions**: the first harness run scored this as "loan settled 2×". That was
  **the harness, not the chain** — the same collapse as §6.1, so one receipt was counted twice.
  Verified directly on-chain afterwards: block 63829531 contains **one** transaction from the agent
  and the window contains **one** `LoanRepaid` event for loan 119 (and likewise for 120). The
  addendum harness now deduplicates by transaction hash so the artefact cannot recur.

### 6.5 Throughput and gas, real chain

| | attempted | landed | seconds | tx/s | avg gas |
|---|---:|---:|---:|---:|---:|
| concurrent (8 sends at once, explicit nonces) | 8 | 8 | 8.0 | **0.998** | 85,808 |
| sequential (await each receipt) | 8 | 8 | 33.3 | **0.240** | 79,069 |

**4.16× throughput** for the same work, and that is the throttled figure — the unthrottled 10-wallet
burst reached **3.87 tx/s** and put all ten in one block. The gas difference is **not** contention: it
is the F-02 tranche arm (the V7 scale report's 78,684 vs 85,131 execution gas for "top-up, no loan in
flight" vs the fold/merge arms, plus ≈ 21.5 k intrinsic = 79.1 k / 85.6 k). Per-transaction gas is
unchanged by having block-mates, exactly as §5.1 measured locally.

### 6.6 Funds

| | native |
|---|---:|
| deployer balance at the start of the round | 63.382765 |
| deployer balance at the end | 59.110503 |
| **moved out of the deployer** | **4.272263** |
| of which still held by the throwaway wallets (recoverable) | 3.832926 |
| **actually burned as gas** | **≈ 0.439337** |
| cap | 25 |

No real-value assets were touched: Arc staging USDC is `MockUSDC` and was minted for the round.

---

## 7. Which races are safe, and which need client-side care

### Safe on-chain, nothing to do

| Race | Why |
|---|---|
| Same-block supply contention, including both cap boundaries (1.1–1.6) | `_claimLenderSlot` reads and pushes in one transaction; the cap and the reserved creator slot hold exactly in every ordering |
| Borrow vs withdraw (2.1–2.3) | `availableLiquidity` is read and written in the same transaction; money out never exceeds it |
| Self-stake lock (3.1–3.5) | the lock and the coverage gate read the same slots the two calls write, so they engage atomically. **The M2 lock holds under racing.** |
| Repay vs liquidate, incl. cron double-fire (4.1–4.4) | `LoanState` is the single settlement latch; exactly one wins, collateral goes to exactly one place |
| Interest distribution under contention (5.1–5.5) | shares exact to the base unit against an independent model, in all 48 contended orderings |
| Rate limit and credit ladder (6.1–6.7) | per-agent counters are read-modify-written per transaction; a batch shares one timestamp. **Racing never beat sequential.** |
| Solvency under a lossy liquidation racing a claim (8.1) | the contract is never left short in any ordering or draw-down regime; only the split between lenders moves (F-2) |

### Needs client-side care (the contract is fine; the client can still get it wrong)

| Situation | What the client must do |
|---|---|
| **Sizing a loan from a stale `availableLiquidity`** (2.4 — refused 10/10) | size with a margin, or re-read immediately before signing, and treat `Insufficient pool liquidity` as **retryable**, not as "the pool is short" |
| **A withdrawal placed ahead of the repayment that funds it** (2.5) | the revert replays successfully one slot later — retry, do not surface as insufficient liquidity |
| **`Pool lender capacity reached` under churn** (1.5) | a slot can free in the very next block; retry once before advising "choose another pool" |
| **`Last slot reserved for agent self-stake`** (1.2) | a *distinct* refusal, not a generic capacity error — the agent itself can still supply |
| **`Loan not active` on a repayment** (4.1–4.4) | **never retry blindly.** Read `loans(loanId).state`: 2 = REPAID, 3 = DEFAULTED. A 3 means the liquidation won, and it carries the reputation penalty and the 180-day lockout |
| **Firing several transactions concurrently from one wallet** (§6.1, F-3) | allocate nonces explicitly — `SpecularSDK.sendTransactionSerialized` now does, or use `src/sdk/nonce.js` `NonceCounter` directly. Without it, N identical concurrent calls are ONE transaction that reports success N times and no error is raised anywhere. Also beware the opposite failure: a nonce **gap** makes every later transaction from that wallet unminable until the gap is filled |
| **Claiming interest while a default may be imminent** (§8 race, F-2) | claiming ahead of a lossy liquidation keeps the claimant whole and moves the loss onto the lenders who did not claim. Nothing to fix in a client, but lenders should know it is first-come-first-served for unclaimed interest, and that `Drain underflow` means "the liquidity is out on loan", not "the protocol is broken" |
| **Batching a qualifying supply with a sub-minimum top-up** (1.6) | the outcome depends on ordering — do not assume both land |
| **Lenders' ordering risk** (2.1) | a lender's withdrawal can be denied by the agent's borrow landing first. Capital is not lost, only illiquid until the loan closes; this is worth saying out loud to third-party lenders |

---

## 8. Client-side fixes shipped (test first, all three)

No contract was touched. Three client-side changes, each written test-first:

### 8.1 SDK — `src/sdk/revert.js` (new) + `SpecularSDK` wired to it

* `decodeRevertData`, `reasonFromError`, `classifyRevertReason`, `explainFailedTx`, `failedTxError`.
* Classification is three-way: **retryable** (somebody else's transaction is the obstacle),
  **actionable** (the caller must change something), **terminal** (never re-send). Unmapped reasons fail
  **closed** as terminal.
* `explainFailedTx` also replays a failed transaction at the start and end of its block and marks it
  **positional** if a different slot would have succeeded — in which case it is retryable regardless of
  the reason string. Transport errors are re-thrown rather than mistaken for a revert.
* `SpecularSDK.registerAgent / requestLoan / repayLoan` now throw an Error carrying `revertReason`,
  `failureClass`, `retryable`, `positional`, `advice` and `txHash` instead of a bare
  "reverted on-chain".
* Tests: `test/sdk/revert-classification.test.js` — 6 tests, including a genuinely position-dependent
  failure built inside a hand-made block.

### 8.2 MCP server — race classification on the simulation

* `Simulation` gains **`simulatedAtBlock`** and **`raceClass`**; `explainRevert` returns `raceClass`;
  `classifyRace` is exported.
* A prepared transaction for a **contended** action (`supply_liquidity`, `withdraw_liquidity`,
  `request_loan`, `repay_loan`, `claim_interest`) now carries a warning naming the block it was
  simulated against and the two refusals that contention actually produces; a failed simulation whose
  reason is retryable says so explicitly.
* The three misleading plain-language strings are rewritten: `Insufficient pool liquidity` and
  `Pool lender capacity reached` now lead with the contended case and the retry; `Loan not active` now
  warns that the loan may have been **liquidated** and tells the agent to read the state.
* `openapi.ts` publishes both new fields.
* Tests: `mcp-server/test/unit.race.test.mjs` — 11 tests.

### 8.3 SDK — `sendTransactionSerialized` (the F-3 fix)

* `SpecularSDK` now owns a serialised send queue and a nonce cursor. Two calls on the same instance can
  never share a nonce, even under `Promise.all`.
* The nonce is `max(chain pending nonce, local cursor)`, so the queue also survives an RPC whose pending
  view lags; the cursor is **dropped on any failure** so the next call re-anchors to the chain rather
  than compounding a **gap** (a gap is the one genuinely dangerous outcome: if nonce *n* never reaches
  the mempool but *n+1…n+k* do, none of them can ever be mined until something occupies *n*).
* `registerAgent`, `requestLoan` and `repayLoan` all go through it; wallets that cannot report a nonce
  (custom signers, test doubles) fall back to the plain path, still serialised.
* Tests: `test/sdk/concurrent-send.test.js` — 5 tests, including a deterministic reproduction of the
  collapse (four sends pinned to one nonce → one transaction, one supply) and a contiguity check that
  would fail if the cursor ever skipped a nonce.

**Suites after the changes:** `npx hardhat test` → **883 passing, 5 pending, 0 failing** (872 before this
round; +11 from the two new SDK suites); `mcp-server` unit suite → **127 passing, 0 failing** (126 before;
+12 from `unit.race.test.mjs`, and one pre-existing OpenAPI shape test now also covers the new fields).
Nothing pre-existing was modified except the three `SpecularSDK` throw sites plus its send path, the four
reworded REASON_MAP strings, and the additive `Simulation` fields.

---

## 9. Harness, reproduction, and the patch

Everything lives in this directory, outside `test/` on purpose (the local harness needs 140 funded
accounts and a 120 M block gas limit, which would break `npm test`).

```
forensics/output/testing-2026-09-25/
  CONCURRENCY_REPORT.md          ← this file
  concurrency.patch              ← git apply-able patch for every change in this round
  concurrency-results.json       ← machine-readable results of every local run
  staging-concurrency-result.json← Arc-staging results
  staging-run.log                ← live log of the staging run
  preflight-staging.js           ← read-only staging preflight (sends nothing)
  staging-concurrency.js         ← the Arc-staging harness (race 7)
  staging-nonce-burst.js         ← the UNTHROTTLED nonce/mempool burst (F-3 evidence)
  staging-contention-addendum.js ← borrow-vs-withdraw + double-fire on a fresh staging pool
  staging-*-result.json          ← results of each staging script
  staging-addendum.log, staging-nonce-burst.log
  harness/
    _conc.js                     ← block building, revert classification, the 16 invariants
    C1-supply-contention.test.js
    C2-borrow-vs-withdraw.test.js
    C3-selfstake-lock-race.test.js
    C4-repay-vs-liquidate.test.js
    C5-interest-exact-shares.test.js   ← includes the independent tranche model
    C6-ladder-ratelimit-race.test.js
    C7-contention-gas.test.js
    C8-claim-vs-liquidation.test.js
hardhat.concurrency.config.js    ← FIFO mempool, 140 accounts, 120 M block gas limit
```

Permanent regression tests added to the normal suites (these DO run under `npm test`):

```
test/sdk/revert-classification.test.js   ← F-4 fix
test/sdk/concurrent-send.test.js         ← F-3 fix
mcp-server/test/unit.race.test.mjs       ← F-5 fix
```

Re-run:

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npx hardhat --config hardhat.concurrency.config.js test          # 37 scenarios, 412 contended runs, ~16 s
npx hardhat test test/sdk/                                       # the two SDK fixes
(cd mcp-server && npm run build && node --test test/unit.race.test.mjs)   # the server fix

# Arc STAGING (broadcasts; throwaway wallets funded from PRIVATE_KEY, capped at SPEND_CAP native)
node forensics/output/testing-2026-09-25/preflight-staging.js    # read-only
node forensics/output/testing-2026-09-25/staging-concurrency.js
node forensics/output/testing-2026-09-25/staging-nonce-burst.js
node forensics/output/testing-2026-09-25/staging-contention-addendum.js
```

`staging-wallets.json` holds throwaway testnet keys and is already covered by `.gitignore`
(`forensics/output/**/*wallets*.json`); it is **not** in the patch.

A fresh worktree needs `npm ci` at the repo root (and in `mcp-server/`) before any of the above will
run; the harness has no dependencies of its own beyond what the project already uses.
