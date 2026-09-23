# Specular V6 — Small-Transaction Scale Testing (2026-09)

Question: **how many small transactions can go through?** Tested at three layers:
contract capacity (local, precise gas), the x402 micropayment layer, and
measured real-chain throughput on the fixed-V6 Arc staging stack.

## 1. Contract capacity — gas ceiling per small op (local, 30M gas block)

| Small op | Gas | Max tx/block |
|---|---|---|
| supplyLiquidity(1 USDC) | 73,827 | **406** |
| withdrawLiquidity(1 USDC) | 59,918 | **500** |
| requestLoan(0.01 USDC) | 400,212 | **74** |
| repayLoan(0.01 USDC) | 132,510 | **226** |
| claimInterest | 51,239 | **585** |

At Arc's ~1s block time, chain capacity is on the order of **~400 small
supplies/s** or **~74 micro-loans/s** — the contracts are not the bottleneck.

## 2. Volume endurance — 1,000 tiny loan cycles (local)

- **2,000 txs in 1.7s (1,200 tx/s in-process)**; requestLoan gas **dead flat**
  (400,212 at cycle 100 = cycle 999; ratio 0.886 incl. first-write discount) —
  §S5 O(1) holds at 1,000-loan agent history.
- Exact solvency at every checkpoint; `activeLoanCount` exact at history=1,000.
- **200 dust cycles at 1 base unit (1e-6 USDC)**: solvency exact, no duplicate
  lender entries (§B1/H-2 hold at dust scale).
- **Economics finding (expected, documented E11):** 1,000 × 0.01-USDC loans paid
  lenders 0.013 USDC interest but **0 protocol fees** — the 1% fee floors to 0
  below ~0.075-USDC loans. Micro-loans are lender-profitable, protocol-free.
  (Bounded: yields an attacker nothing; reputation principal-scaling still
  applies.) If protocol revenue at micro-scale matters, a flat minimum fee would
  be a product change to consider.

## 3. x402 micropayment layer — 250 concurrent micro-buyers

`scripts/x402-microtx-scale.js` (5× the standard 50-buyer test, 0.01 USDC each):
- **250/250 served in 0.09s (2,841 req/s)** through the stub seller.
- Revenue accounting **EXACT** under concurrency: 2.50 USDC expected → 2.50
  flushed in a **single** on-chain tx to the staging pool, pending 0 (the
  flush-race fix holds at 5× scale).

## 4. Real-chain burst — measured throughput on Arc staging

`scripts/small-tx-burst-arc-staging.js`: K fresh agents × 10 sequential 1-USDC
supplies, agents in parallel, through the public drpc RPC:

| Agents | Txs | Wall clock | Throughput | Retries needed | Result |
|---|---|---|---|---|---|
| 5 | 50 | 51s | **0.98 tx/s** | 6 (12%) | 50/50, exact |
| 10 | 100 | 49s | **2.03 tx/s** | 17 (17%) | 100/100, exact |
| 20 | 200 | 50s | **4.01 tx/s** | 36 (18%) | 200/200, exact |

- **Throughput scales linearly with parallel agents** (≈0.2 tx/s per agent lane,
  ~5s RPC round-trip per tx) — the bottleneck is public-RPC latency, not the
  chain or contracts.
- **350/350 total burst txs confirmed**; every pool's totalLiquidity matched its
  confirmed tx count EXACTLY — no lost or double-counted funds under concurrency.
- ~18% of txs hit a transient "execution reverted" on the public load-balanced
  RPC; **100% succeeded with a single retry** — consistent with the documented
  RPC-staleness profile, and the SDK's retry hardening is the right client model.

## Bottom line

- **Protocol capacity**: hundreds of small txs per block (~400 supplies or ~74
  micro-loans per 30M-gas block); flat gas at 1,000-loan history; exact
  accounting down to 1 base unit.
- **x402 layer**: thousands of micropayments/s off-chain with exact single-flush
  on-chain settlement.
- **Real-chain today**: ~4 tx/s measured at 20 parallel agents through the free
  public RPC, scaling linearly — the ceiling is RPC infrastructure, not the
  protocol. With a dedicated RPC and more lanes, throughput extrapolates toward
  the per-block gas ceiling.
- One economics note (fee floor at micro-scale) surfaced and documented above.
