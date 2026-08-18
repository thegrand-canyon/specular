# Specular V6 — Internal Self-Audit (2026-08, pre-Arc-mainnet)

> **UPDATE 2026-08 — the owner elected to do NO external audit and instead
> maximize internal rigor.** A second pass therefore FIXED most of the open
> design findings (D1–D3, D5, D11, D12), upgraded the Foundry invariant suite to
> exact-solvency + liquidation (64,000 calls/invariant), and ran a final
> adversarial re-review. This section is the original self-audit; the **"D-series
> resolution" and "Final adversarial re-review" sections at the bottom are the
> current status.** Note the honest residual risk on D1 and D4/D6/D7 below —
> internal rigor is NOT equivalent to independent professional review, and this
> document discloses what remains.

Best-effort adversarial self-audit of the money contracts. Method: **four
independent deep-review agents** (accounting/invariants, access-control/
reentrancy, economic/game-theory, fixes+test-adequacy) + an **original
exact-solvency invariant fuzz** + **Foundry stateful invariants** + **slither
0.11.4** + a **final adversarial re-review** of all fixes. Every fix carries a
reproducing regression test.

**Scope:** `AgentLiquidityMarketplaceV6.sol`, `ReputationManagerV3.sol`,
`AgentRegistryV2.sol`, `AgentCreditFaucet.sol`, `ValidationRegistry.sol`.

**Result:** 1 HIGH + 4 MEDIUM fixed in round 1; D1/D2/D3/D5/D11/D12 fixed in
round 2. Test suite **414 → 501** + Foundry invariants. Remaining residual risk
(D1 farming, D4 loss-ordering, D6 W1-JIT, D7 timestamp) disclosed below.

---

## Fixed this round (with reproducing tests)

| # | Sev | Finding | Fix | Commit |
|---|-----|---------|-----|--------|
| A1 | **HIGH** | `totalLiquidity` drifts below `totalLoaned` (interest paid to availableLiquidity is withdrawn as principal); a later lossy `liquidateLoan` does `totalLiquidity -= loss` → checked-math **underflow → liquidation permanently bricked**, borrower **evades the default penalty**, pool accounting stuck. Also underflowed `withdrawLiquidity` and `resetPoolAccounting`. | Saturating subtraction at all 3 sites. | `a9a66f3` |
| A2 | MED | **H-2 × resetPoolAccounting**: removing a fully-withdrawn lender who still had unclaimed `earnedInterest` dropped their interest from `resetPoolAccounting`'s sum → understated `availableLiquidity` → their `claimInterest` reverts ("Drain underflow") — **interest frozen**. | Remove only when `amount==0 && earnedInterest==0`; `claimInterest` removes on full exit. | `3be96f2` |
| A3 | **HIGH (griefing)** | **F-C lender-slot squatting**: H-2 freed slots on withdrawal, but 50 Sybil addresses can supply 1 base unit each and **never withdraw**, permanently occupying `MAX_LENDERS_PER_POOL` and locking out real lenders on every pool. | `minSupplyAmount` owner lever (default 0; gates new slots only). Set at launch. | `3be96f2` |
| A4 | MED-HIGH | **F1/F-G reputation reset**: `initializeReputation` gated on `score==0`, conflating "never initialized" with "defaulted to 0" → a defaulter re-inits to 100, **erasing the default penalty**. | Explicit `initialized` flag. | `3be96f2` |
| A5 | MED | **F3 agentId collision**: `_update` set `addressToAgentId[to]` unconditionally → transferring an agent NFT to an address that already owns one **orphaned** the recipient's agent (reputation/pool unreachable). | Reject such transfers (mint exempt). | `3be96f2` |
| A6 | LOW | M-2 lever cap was `MAX_LOAN_DURATION`; a high `minHold` silently denies reputation to all shorter loans. | Cap at `MIN_LOAN_DURATION` (7d). | `3be96f2` |
| A7 | test | `V6PropertyFuzz` §S1 invariant omitted `accumulatedFees` (the omission that let H-1 hide). | Added fees to the invariant + new exact-solvency fuzz incl. liquidation. | `a9a66f3`,`3be96f2` |

### Original verification artifact
`test/unit/V6InvariantFuzz.test.js` — 500 randomized ops (supply/withdraw/borrow/
repay/**liquidate**/claim/withdrawFees/time-travel) asserting the **exact** global
solvency equality `balance == Σ availableLiquidity + accumulatedFees + Σ_active
collateral`, plus H-3 (`outstandingPrincipal` == Σ active principal) and §S5
(`activeLoanCount` == live ACTIVE count) after every step. (Note: the A1 HIGH was
a *different* invariant — `totalLiquidity` vs `totalLoaned` — which this fuzz did
not target; it was caught by the accounting agent and now has its own repro.)

---

## Open — design decisions & lower severity (for the external audit / product)

### D1 — [CRITICAL, design] Reputation is cheap to mint → build-then-bust-out
`recordLoanCompletion` grants a flat **+10 regardless of loan size**; tiny loans
pay **zero** interest/fee (integer truncation) and their collateral is fully
returned; an agent can **supply to its own pool** and loop `requestLoan(1)`/`repay`.
With `MAX_ACTIVE_LOANS=10`, that is +100 reputation per M-2 hold-period, cost = gas.
Reaching score 800 (0% collateral, 50k limit) then attracting real lenders and
defaulting is the core undercollateralized-lending break. **M-2 (min-hold) does
not fix it** — concurrency defeats the time gate; it only adds latency.
**Recommendation:** tie the reputation bonus to *principal × time-held × interest
actually paid*; enforce a minimum loan size and non-zero interest; rate-limit
unsecured-exposure growth per unit of realized interest-bearing volume. This is a
reputation-model change (product + audit), not a lever — flagged as the #1 item.

### D2 — [HIGH, mitigated by M-1 ON at launch] Aggregate credit is per-address, reputation per-agentId
`outstandingPrincipal`/`activeLoanCount` are keyed by borrower **address**;
`creditLimit`/reputation by **agentId**. Transferring the NFT resets the aggregate
while reusing the reputation → the multi-limit exposure H-3 targeted.
**M-1 ON (the planned launch config) blocks this** (only the pool creator may
borrow). **Recommendation (defense-in-depth):** re-key `outstandingPrincipal`/
`activeLoanCount` by `agentId` so H-3 no longer depends on the M-1 lever.

### D3 — [MEDIUM] ValidationRegistry unbounded loop DoS on the borrow path
`calculateCreditLimit` → `validationRegistry.getSummary` loops over all of an
agent's validations with no cap, and `validationRequest` is permissionless — an
attacker can bloat a victim's array until the victim's `requestLoan` reverts.
Only active when a `validationRegistry` is set and `validationCreditBonus>0`.
**Recommendation:** cap/paginate `getSummary`, restrict who can request validation,
and audit ValidationRegistry before enabling the bonus. (Keep it unset at launch.)

### D4 — [MEDIUM] Socialized-loss ordering is cheaply forceable (M-4)
On an undercollateralized default, positions aren't scaled; withdraw/claim are
FCFS against `availableLiquidity`, so an alert/colluding lender front-runs
`liquidateLoan` with a full withdraw and dumps the shortfall on the last lender.
**Recommendation:** pro-rata loss accounting (`lossPerShare` accumulator). Real
redesign, not a toggle. (Same as the round-2 M-4.)

### D5 — [MEDIUM] Centralization / liveness
`pause()` freezes lender withdraw/claim AND borrower `repayLoan`, while
`liquidateLoan` stays callable — the owner can pause, let a loan lapse, and
liquidate a borrower who had no way to cure (forced default). `liquidateLoan` is
owner-only (no permissionless recovery if the owner is offline). One-step
`Ownable` + `renounceOwnership` across all contracts. **Recommendations:** make
`liquidateLoan` `whenNotPaused` (or exempt exits from pause), consider
permissionless liquidation once overdue, adopt `Ownable2Step`, override
`renounceOwnership` to revert.

### D6 — [MEDIUM] W1 sandwich defense degrades to near-costless JIT for short loans
Qualification is `depositTimestamp <= loan.startTime`; front-running `requestLoan`
(not the repay) yields `ts == startTime` and qualifies, so a JIT lender captures
interest on a quickly-repaid loan for ~1 block held. **Recommendation:** require
deposits to predate `startTime` by a min delta, or accrue interest time-weighted
over the actual holding period (also fixes D7).

### D7–D12 — LOW / informational
- **D7** Topping up a position resets `depositTimestamp`, disqualifying the whole
  position from in-flight loans' interest (lender self-harm). Track per-tranche or
  keep earliest timestamp.
- **D8** `seedPool`/`seedPosition` (migration) set balances with no solvency
  assertion — add a post-seed `balance >= Σ availableLiquidity + fees + collateral`
  check. (Not used by the Arc fresh-deploy path.)
- **D9** `setAgentWallet` EIP-712 sig has no nonce → replayable within the deadline.
- **D10** `AgentCreditFaucet` remains Sybil-able across many funded EOAs (M-3 only
  stops single-address NFT-cycling); keep faucet balance + `maxEligibleAgentId`
  conservative — it is not a proof-of-personhood.
- **D11** `notifyRefill` emits attacker-controlled `Refilled` (event spoof).
- **D12** `getActiveAgents` always reverts (dead); M-1 ON permanently freezes
  borrowing on a legitimately-transferred pool (intended, but sharp — consider an
  owner re-point). Storage layout: new vars inserted mid-order (fine for a fresh
  non-proxy deploy; append for future upgradeability).

---

## Proven correct (high-confidence)
- **Exact solvency** `balance == Σ availableLiquidity + fees + Σ active collateral`
  holds across supply/withdraw/borrow/repay/**liquidate**/claim/withdrawFees —
  verified by algebra (accounting agent) AND by 500-op exact-equality fuzz.
- **H-1/§S1** interest→fees routing fully conserves value; no phantom liquidity
  (both dust and `qualifiedTotal==0` paths decrement `availableLiquidity`).
- **H-3/§S5 counters** increment once at disburse, decrement once at the single
  ACTIVE→terminal transition — no drift/underflow (now that A1 unbricks liquidate).
- **Reentrancy**: `nonReentrant` + CEI on every external-call function; USDC has no
  transfer hooks; `register()` CEI verified safe; no cross-function/read-only path.
- **Access control**: all 18 marketplace externals correctly gated; no non-owner
  path to an owner-only effect; reputation mutators `onlyAuthorizedPool`; faucet
  M-3 dedup complete.
- **slither 0.11.4**: no new High/Medium from these fixes; remaining High/Medium
  are OZ `mulDiv` false-positive + pre-existing accepted patterns (documented in
  ARC_MAINNET_DEPLOY_PREP.md).

---

## Bottom line for the external audit
The contracts are materially stronger after this pass — the one reachable HIGH
(A1 liquidation underflow) and four mediums are fixed with tests, and the exact-
solvency fuzz gives high confidence in the core money accounting. **The external
audit should prioritize D1 (reputation-minting economics)** — the deepest,
design-level risk that no lever fixes — and D2/D3/D4/D6 (the credit-key coupling,
validation DoS, and the interest/loss accounting model). Launch config (M-1 ON,
M-2 ON ~1d, faucet ON, and now `minSupplyAmount` > 0) mitigates several of these
at the edges but is not a substitute for the model-level fix in D1.

---

## D-series resolution (round 2, 2026-08 — in place of external audit)

| ID | Sev | Status | Fix | Commit |
|----|-----|--------|-----|--------|
| **D1** | CRITICAL | **MITIGATED (not eliminated)** | Principal-scaled reputation bonus + interest>0 reward gate. Farming cost raised from ~0 to (platform fee + collateral time-lock). **Residual risk below.** | `2c1567c` |
| **D2** | HIGH | **FIXED** | `outstandingPrincipal`/`activeLoanCount` re-keyed by agentId → H-3 aggregate credit decoupled from the M-1 lever; NFT-transfer reset closed. | `dc4759d` |
| **D3** | MED | **FIXED (latent)** | `getSummary` bounds its scan to the most-recent 200; registry stays unset at launch. | `3cadb0c` |
| **D5** | MED | **FIXED** | `liquidateLoan` now `whenNotPaused` (no forced default); `Ownable2Step`; `renounceOwnership` reverts. | `8fff1a3` |
| **D11** | LOW | **FIXED** | `notifyRefill` owner-only + emits actual balance. | `3cadb0c` |
| **D12** | LOW | **FIXED** | `getActiveAgents` implemented (was reverting stub). | `3cadb0c` |
| A1 | HIGH | **FIXED** | Saturating `totalLiquidity` (liquidation no longer bricked). | `a9a66f3` |
| **Foundry** | — | **Upgraded** | Exact-solvency + H-3 + liquidation invariants; deep campaign 256×250 = 64,000 calls/invariant, all green. | `88a296e` |

## Final adversarial re-review (2026-08) — results

A fresh agent attacked every round-2 fix for regressions/bypasses. **No BROKEN
regressions.** Verdicts:

- **D2 / A1-availableLiquidity / D5 / D11 / D12 — SOLID.** agentId re-keying is
  consistent across all loan-state transitions and genuinely closes the H-3
  bypass independent of M-1; `availableLiquidity` stays a checked subtraction
  everywhere (saturation only on the non-solvency-critical `totalLiquidity`);
  pause/Ownable2Step/renounce wired correctly; no on-chain caller of the new
  view functions. Earlier fixes (H-1, H-3, M-3, register-CEI, §S1/§S5/§B1) still
  hold under the layered changes.

- **D1 — WEAK (disclosed residual risk).** My "kills the farm" claim was
  **overstated and is corrected.** A farmer controlling both the borrower and a
  Sybil lender address supplies to their own pool, borrows, and recaptures the
  interest — so the real per-cycle cost is only the platform fee + the
  time-value of collateral locked during the minHold window. The mitigations
  (principal-scaling, interest gate) + the launch levers (M-2 minHold ON,
  nonzero platformFeeRate) raise the cost materially but do **not** eliminate it.
  **A complete on-chain defense is not possible without identity/attestation
  (ERC-8004 ValidationRegistry, audited + wired) or slashable staking.** This is
  documented in-code at `ReputationManagerV3.bonusReferenceAmount` and is the
  #1 residual risk. Launch MUST enable M-2 + a nonzero fee; the deepest fix
  (staking/identity) is future work.

- **A1 `resetPoolAccounting` — LOW/MED failure-mode note.** On an already-drifted
  pool, the saturating `totalLiquidity` makes the owner-only emergency repair
  tool now silently understate `availableLiquidity` (was: revert). It cannot
  reconcile against real USDC custody because the contract balance is shared
  across pools. Documented limitation; only reachable on a pool already underwater
  from a lossy default.

- **D3 tail-scan — LOW/latent.** Bounding to the last 200 lets an agent bury
  earlier bad validations under fresh good ones IF the registry is ever wired.
  Latent (registry unset at launch); revisit before enabling the validation bonus.

## Still open — require design work, NOT rushed (honest disclosure)

- **D1 residual** (above) — needs identity/staking. **D4 socialized-loss
  ordering** — a pro-rata `lossPerShare` redesign; deliberately NOT attempted
  here because a rushed accounting rewrite could break global solvency (worse
  than the bounded fairness issue it fixes). **D6 W1 JIT** and **D7 top-up
  timestamp reset** — both resolved by a time-weighted interest-accrual redesign;
  same reasoning. These are the honest limits of what internal work should change
  without independent review.

## Launch posture required by this audit (Arc mainnet)
1. **M-2 `minHoldForReputationReward` > 0** and **nonzero `platformFeeRate`** —
   REQUIRED for D1 to bite (not optional).
2. **M-1 on**, **`minSupplyAmount` > 0** (F-C), **faucet cohort small + funded**.
3. **Leave `validationRegistry` unset** (keeps D3 latent) until it is separately
   audited + the tail-scan revisited.
4. Transfer ownership to the secure wallet via the two-step flow.
