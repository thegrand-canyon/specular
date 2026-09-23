# Specular V6 — Coverage-Driven Testing Round (2026-08)

A principled "where are we actually under-tested?" pass: ran solidity-coverage to
get an objective map, closed the known RPC-staleness test gap, added a new Foundry
invariant (which **found a real imprecision**), and filled the biggest coverage
holes. Test suite **566 → 588 hardhat + 6 Foundry invariants**.

## The new invariant found a bug

Added **`invariant_pool_principal_conservation`** to the Foundry suite:
- `totalLiquidity == Σ position.amount`, and
- `availableLiquidity + totalLoaned == Σ position.amount + Σ earnedInterest`, per pool.

It **failed** on the first run (the other 5 passed): `_socializeLoss` (D4) reduced
positions by `Σ floor(loss·amount_i/total)`, which is *less* than the full loss by
integer-division dust (< lender-count base units per liquidation). So after a
lossy default, `Σ position.amount` drifted a few base units above
`availableLiquidity + totalLoaned` — the last withdrawer would eat a sub-$0.0001
dust shortfall. Solvency held (S1 passed), but the pro-rata wasn't *exact*.

**Fix (`58536e5`):** `_socializeLoss` now assigns the floor-division remainder, so
the pool loses EXACTLY `min(loss, totalPrincipal)` — no dust drift. Deep campaign
(256×250 = **64,000 calls**): all 6 invariants pass, including the new one.

## Coverage (core V6 stack) — before → after

| Contract | Stmts | Branch | Funcs | Lines |
|----------|-------|--------|-------|-------|
| AgentLiquidityMarketplaceV6 | 94.4 → **94.6** | 84.3 → 84.2 | 93.9 | 96.5 → **96.6** |
| ReputationManagerV3 | 81.9 → **86.8** | 67.4 → **75.5** | 73.7 | 80.6 |
| **AgentRegistryV2** | 43.8 → **87.5** | 30.0 → **76.0** | 25.0 → **87.5** | 47.5 → **88.5** |
| AgentCreditFaucet | 95.5 | 86.7 | 87.5 | 96.7 |

AgentRegistryV2 was the standout gap (25% function coverage) — its NFT/admin
surface is now covered. (ValidationRegistry / legacy V2 contracts sit at 0% but
are NOT part of the deployed launch stack.)

## Tests added this round

- **`quickstart-rpc-staleness.test.js`** (4) — the RPC read-after-write staleness
  fixes (surfaced live on Base) shipped live-validated only; now unit-covered:
  `_approveExact` polls past a stale-replica window / skips when covered; `borrow`
  retries transient "Insufficient pool liquidity"; a genuine revert surfaces.
- **`V6SocializedLoss` exact-dust case** (1) — loss distributed exactly (no dust)
  with unequal coprime stakes.
- **`AgentRegistryV2.functions.test.js`** (11) — setAgentURI / setMetadata /
  deactivate-reactivate / pause-unpause / views, with negatives.
- **`ReputationManagerV3.tiers.test.js`** (6) — every credit/collateral/interest
  tier boundary, score cap, default-penalty small/large/floor, rate-limit window.

## Totals now
- **588 hardhat** (unit + security + integration) + **6 Foundry invariants**
  (64k-call deep campaign) + **54 security attack tests** (subset of the 588).
- Contracts: V6 marketplace 94.6% stmts / 96.6% lines; RegistryV2 87.5%;
  ReputationV3 86.8%; Faucet 95.5%.

This round did what good testing should: an objective coverage map pointed at the
real gaps, and a new invariant caught an imprecision that 570 prior tests + 5
invariants had not — now fixed and locked in.
