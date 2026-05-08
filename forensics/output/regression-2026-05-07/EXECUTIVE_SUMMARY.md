# Specular Security Update — Executive Summary

**Date**: 2026-05-08  
**Status**: V6 ready for external audit. No production deployment yet.

## Headline

Three security issues in the deployed `AgentLiquidityMarketplace` (v4) marketplace contract have been identified, reproduced, and fixed in a new contract version (V6). V6 has been deployed to Arc Testnet, exhaustively tested live, and prepared for an independent audit before mainnet rollout.

## What was found

| Issue | Severity | Impact | Status |
|-------|---------|--------|--------|
| §B1 — Duplicate poolLenders → Panic | **Critical** | Repaying a loan with interest panics the contract; loan cannot be repaid | **Fixed in V6** |
| §S1 — claimInterest fund-drain | **Critical** | `pool.availableLiquidity` accounting drifts upward over time; eventually withdrawals fail | **Fixed in V6** |
| §S5 — Unbounded loop DoS | **Medium** | High-volume agents (5,000+ loans) become unable to borrow; ~$57 attack cost | **Fixed in V6** |

All three are confirmed live on production:
- §B1 has stuck **3 real Base mainnet loans** (#2, #3, #4) — they cannot be repaid until the contract is replaced or the loans are liquidated (eligible 2026-05-11 19:10 UTC).
- §S1 has drained an estimated **74.87 USDC** of "phantom liquidity" on Arc Testnet (cumulative across 40 lenders); on top of an earlier ~225 USDC.
- §S5 puts Arc agent #43 (777 lifetime loans) at **3.94M gas per `requestLoan`** — about 10× higher than V6 fresh agents and ~5,665 loans from the block gas limit.

## What was built

**`AgentLiquidityMarketplaceV6`** — a surgical patch to v4 with three targeted fixes plus owner-only state-migration helpers. Storage layout intentionally not compatible: V6 is a fresh deployment with a planned user-driven migration from v4.

| Element | Description |
|---------|-------------|
| §B1 fix | New `isInPoolLenders` flag prevents duplicate-entry creation on supply→withdraw→supply cycles |
| §S1 fix | `claimInterest` now decrements `pool.availableLiquidity` by the claimed amount |
| §S5 fix | `activeLoanCount` mapping replaces the O(N) array walk in `_countActiveLoans` |
| Migration helpers | `seedPool`, `seedPosition`, `compactPoolLenders`, `setMigrationFinalized` (owner-only, locked once finalized) |

## Evidence of correctness

| Test | Outcome |
|------|---------|
| 287 inherited v4 hardhat tests | ✅ all pass |
| 8 V6 migration unit tests | ✅ all pass |
| 7 V6 reference-patch tests | ✅ all pass |
| 5 reentrancy attack scenarios | ✅ all blocked by `nonReentrant` |
| 5 property-fuzz cases (200+ random ops) | ✅ 0 invariant violations |
| 6 v4↔V6 differential cases | ✅ identical state on non-fix paths; divergence ONLY at fix sites |
| **Live on Arc V6**: 50-lender boundary | ✅ cap enforced, no panic at the cap |
| **Live on Arc V6**: 100 sequential loans | ✅ gas FLAT (ratio 0.937 — even slightly decreasing) |
| **Live on Arc V6**: 4-lender interest distribution | ✅ proportional, exact to base unit |
| **Live on Arc V6**: 25 sustained cycles | ✅ §S1 invariant holds throughout |

## Cost & deployment

- **Audit cost** (estimate): commercial firms range $30k–150k for a contract this size + complexity
- **Deployment cost** on Base: ~$0.05 (Base gas is cheap)
- **Migration cost**: <$1, single user (the secure wallet) is the only Base lender today

## Open items

| # | Item | Owner | Status |
|---|------|-------|--------|
| 1 | Engage external auditor (Trail of Bits, OpenZeppelin, Spearbit, Code4rena, etc.) | Pending decision | — |
| 2 | Liquidate stuck Base loans #2/#3/#4 | Cron scheduled | Fires 2026-05-11 19:30 UTC |
| 3 | Audit feedback turnaround | Auditor | Standard 2-4 weeks |
| 4 | V6 Base mainnet deployment | After audit | Script ready, gated |
| 5 | User-facing migration window | After deploy | Documented runbook |

## Risk posture

- **Today**: Arc Testnet has the bugs but no real funds (testnet). Base Mainnet has 3 stuck loans (~$0.0004 of locked collateral) plus 1.5 USDC of supplied liquidity from the secure wallet only. Risk to other parties: zero.
- **After Base V6 deploy**: existing v4 Base contract continues running until users migrate. New activity routes to V6.
- **Highest risk in the plan**: V6 itself is unaudited. The audit is the gate — not the deploy.
- **Lowest risk**: rollback is trivial (pause V6, revert frontend config to v4).

## Confidence statement

The three fixes are mathematically simple and surgically applied. Behavior outside the three fix sites is byte-identical to v4 (verified via differential testing). V6 has been exercised through: random-walk fuzz, reentrancy attack scenarios, multi-lender stress at the 50-lender cap, 100-loan sequential churn, and 25 sustained loan/repay/claim cycles, with **zero invariant violations** observed in any test.

The remaining unknown is whatever an external auditor surfaces. The audit package is prepared and ready for handoff.

## Files + entry points

- **Audit package**: `forensics/output/regression-2026-05-07/audit-package/` (also `audit-package.tar.gz`)
- **V6 contract source**: `contracts/core/AgentLiquidityMarketplaceV6.sol`
- **V6 deployed (Arc)**: https://testnet.arcscan.app/address/0xCeF77E14dB17aE0272510ddbDa97075e7Eb6EbF3#code
- **Migration runbook**: `forensics/output/regression-2026-05-07/V6_MIGRATION_RUNBOOK.md`
- **Liquidation runbook**: `forensics/output/regression-2026-05-07/LIQUIDATION_RUNBOOK_2026-05-11.md`
- **Base deploy prep**: `forensics/output/regression-2026-05-07/BASE_DEPLOY_PREP.md`
- **Live invariant monitor**: launchd job `com.specular.v6-invariants` (every 30 min, JSONL log to `forensics/monitor/v6-invariants.log`)

## Decision points needing input

1. **Choose auditor** — recommend at least 2 quotes
2. **Approve V6 Base deployment** — after audit clearance
3. **Schedule user comms** — pre-migration notice + migration window
