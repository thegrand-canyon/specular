# Specular V6 (fixed) — Comprehensive Load / Gas / Scale Test (2026-08)

Load-tested the 2026-08 self-audited/fixed V6 stack in two venues:
- **Local (hardhat network)** — scale + precise gas: `scripts/load-test-v6-local.js`
- **On-chain (Arc testnet staging)** — real RPC/latency/concurrency: `scripts/load-test-arc-staging-onchain.js`

**Result: ALL PASS.** The §S5 O(1) DoS fix holds (loan gas flat over 100 loans),
the bounded 50-lender loops (interest distribution, D4 socialized loss, reset)
stay well under the block gas limit, the new levers add negligible gas, exact
solvency holds under sustained mixed load, and the fixed contracts handle
concurrent multi-agent operation on a real chain with no races.

---

## Local scale/gas results

| Scenario | Metric | Result |
|----------|--------|--------|
| **S1** loan gas flatness | requestLoan gas, loan 1–5 → 96–100 | 410,374 → 400,114 (**ratio 0.975**, flat/decreasing) — §S5 O(1) confirmed |
| **S2** MAX_LENDERS (50) | 50-lender cap enforced; 51st reverted | ✅ |
| **S2** interest distribution | repayLoan @ 50 lenders (`_distributeInterest`) | **1,681,397 gas** (< 3M budget, well under block limit) |
| **S3** socialized loss (D4) | liquidateLoan @ 50 lenders (`_socializeLoss`) | **544,477 gas** — the new pro-rata loop is cheap |
| **S3** solvency | balance ≥ availableLiquidity + fees after lossy default | ✅ |
| **S4** resetPoolAccounting | @ 50 lenders (bounded rebuild loop) | **394,548 gas** |
| **S5** mixed-load invariant | 235 successful ops, 3 agents / 4 lenders | exact solvency, **0 violations** |
| **S6** lever overhead | supply gas: baseline vs levers ON | +**284 gas** (negligible) |

Key takeaways:
- **§S5 holds**: `requestLoan` gas does NOT grow with an agent's loan history
  (ratio 0.975 over 100 loans) — the O(1) `activeLoanCount` counter works.
- The three bounded 50-lender loops (`_distributeInterest`, `_socializeLoss`,
  `resetPoolAccounting`) all fit comfortably under the block gas limit; the
  `MAX_LENDERS_PER_POOL = 50` cap is the right bound.
- The **D4 socialized-loss loop adds only ~544K gas at the 50-lender worst case**
  — cheap for the fairness it buys.
- The launch levers (minSupply / rate-limit / min-hold) add **negligible** gas.

## On-chain (Arc testnet staging) results

| Part | Metric | Result |
|------|--------|--------|
| **A** sequential | 15 request+repay cycles, real RPC | 157.6s (10.5s/cycle) |
| **A** real-chain gas | requestLoan gas first → last | 422,302 → 422,302 (**ratio 1.000**, exactly flat) |
| **B** concurrent | 4 fresh agents, full onboard→supply→borrow→repay in PARALLEL | completed in 30.3s |
| **B** correctness | all 4 concurrent loans REPAID | ✅ no races / nonce issues |
| **B** registry | distinct agentIds assigned under concurrent registration | ✅ (register() CEI fix holds) |

Key takeaways:
- Real-chain loan gas is **exactly flat** (ratio 1.000) — §S5 confirmed outside
  the idealized local network.
- **Concurrent multi-agent operation works**: 4 agents ran full lifecycles in
  parallel (~20 txs) in 30s with no cross-agent interference, all loans repaid,
  and the registry assigned distinct agentIds — validating the register() CEI fix
  and the SDK's nonce/RPC handling under real concurrency.

## Scope / limits (honest)
- Local scenarios use the fixed contracts on the hardhat network — precise gas,
  but not real chain conditions (covered by the on-chain part).
- On-chain testing is bounded (~60 txs) by testnet gas + latency; it validates
  real-chain gas-flatness and concurrency, not sustained thousands-of-ops load
  (that is the local S1/S5 role).
- Default+liquidation at 50 lenders is local-only (needs the 7-day MIN_LOAN_DURATION
  fast-forwarded); on-chain it would require a 7-day real wait.

**Bottom line:** the fixed V6 stack is not just correct (unit + 76.8k-call
invariants + on-chain smoke) but also **performant and DoS-resistant at scale** —
flat loan gas, bounded lender loops under the block limit, cheap socialized loss,
negligible lever overhead, and clean concurrent operation on a real chain.
