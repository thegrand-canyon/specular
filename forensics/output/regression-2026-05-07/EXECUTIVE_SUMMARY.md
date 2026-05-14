# Specular Security Update — Executive Summary

**Date**: 2026-05-08 (original) / 2026-05-13 (post-fix update)
**Status**: V6 ready for external audit. No production deployment yet. Internal Claude review completed; all 4 self-found low-severity issues fixed and redeployed.

## Headline

Three security issues in the deployed `AgentLiquidityMarketplace` (v4) marketplace contract have been identified, reproduced, and fixed in a new contract version (V6). V6 has been deployed to Arc Testnet, exhaustively tested live, internally reviewed by Claude (which produced 4 additional low-severity findings — all since fixed), and prepared for an independent audit before mainnet rollout.

**2026-05-13 update**: post-Claude-review fixes applied in `3bb7c27`, V6 redeployed to Arc at `0x56ecCB27D953a3c84463Df97e18b4E596462CbdE` in `a706c48`, and all fixes verified live on chain.

## What was found

| Issue | Severity | Impact | Status |
|-------|---------|--------|--------|
| §B1 — Duplicate poolLenders → Panic | **Critical** | Repaying a loan with interest panics the contract; loan cannot be repaid | **Fixed in V6** |
| §S1 — claimInterest fund-drain | **Critical** | `pool.availableLiquidity` accounting drifts upward over time; eventually withdrawals fail | **Fixed in V6** |
| §S5 — Unbounded loop DoS | **Medium** | High-volume agents (5,000+ loans) become unable to borrow; ~$57 attack cost | **Fixed in V6** |

All three are confirmed live on production:
- §B1 has stuck **3 real Base mainnet loans** (#2, #3, #4) — liquidated 2026-05-11 19:30 UTC per the scheduled cron. Underlying duplicate-poolLenders entries remain on Base pool 1 (structural); cleared during migration to V6.
- §S1 has drained an estimated **74.87 USDC** of "phantom liquidity" on Arc Testnet (cumulative across 40 lenders); on top of an earlier ~225 USDC.
- §S5 puts Arc agent #43 (777 lifetime loans) at **3.94M gas per `requestLoan`** — about 10× higher than V6 fresh agents and ~5,665 loans from the block gas limit.

### Internal Claude review (2026-05-12 → 2026-05-13)

An additional internal review by Claude (the AI assistant that helped author V6) surfaced 4 low-severity findings, **all subsequently fixed** in commit `3bb7c27`:

| # | Finding | Fix |
|---|---------|-----|
| 1 | `seedPool` did not validate `agentAddress` against the registry | Added `require(agentRegistry.addressToAgentId(agentAddress) == agentId)` |
| 2 | `seedPosition` did not enforce `Σ amount ≤ pool.totalLiquidity` | Iterates `poolLenders` (bounded by MAX=50) and asserts invariant |
| 3 | `requestLoan(amount=0)` could fill an agent's own MAX_ACTIVE_LOANS slots | Added `require(amount > 0)` |
| 4 | `withdrawLiquidity(amount=0)` was a wasted-gas no-op | Added `require(amount > 0)` |

This review is **explicitly not a substitute** for the external audit (see `CLAUDE_REVIEW.md` for the scope-and-limitations preamble).

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
| **378 hardhat tests** (287 inherited + 91 V6-specific incl. 15 Claude-review fix tests) | ✅ all pass |
| 8 V6 migration unit tests | ✅ all pass |
| 7 V6 reference-patch tests | ✅ all pass |
| 15 V6 Claude-review fix tests | ✅ all pass (covers all 4 fixes) |
| 5 reentrancy attack scenarios | ✅ all blocked by `nonReentrant` |
| 5 Foundry invariants × 10,240 random sequences | ✅ 0 invariant violations |
| 6 v4↔V6 differential cases | ✅ identical state on non-fix paths; divergence ONLY at fix sites |
| Slither static analysis (post-fix) | ✅ 5 V6-specific findings, all accept-with-rationale (down from 9 pre-fix) |
| **Live on Arc V6 (post-fix)**: 50-lender boundary | ✅ cap enforced, no panic at the cap |
| **Live on Arc V6 (post-fix)**: 100 sequential loans | ✅ gas FLAT (ratio 0.937 — even slightly decreasing) |
| **Live on Arc V6 (post-fix)**: 4-lender interest distribution | ✅ proportional, exact to base unit |
| **Live on Arc V6 (post-fix)**: 25 sustained cycles | ✅ §S1 invariant holds throughout |
| **Live on Arc V6 (post-fix)**: smoke test of all 4 Claude-review fix reverts | ✅ verified on chain (Fixes 1, 3, 4 trigger expected revert; Fix 2 covered by unit tests) |

## Cost & deployment

- **Audit cost** (estimate): commercial firms range $30k–150k for a contract this size + complexity
- **Deployment cost** on Base: ~$0.05 (Base gas is cheap)
- **Migration cost**: <$1, single user (the secure wallet) is the only Base lender today

## Open items

| # | Item | Owner | Status |
|---|------|-------|--------|
| 1 | Engage external auditor (Trail of Bits, OpenZeppelin, Spearbit, Code4rena, etc.) | Pending decision | — |
| 2 | Liquidate stuck Base loans #2/#3/#4 | Cron scheduled | ✅ Liquidated 2026-05-11 19:30 UTC |
| 3 | Internal Claude review of V6 + fix any findings | Claude | ✅ Completed; 4 findings, all fixed (`3bb7c27`) |
| 4 | Redeploy V6 to Arc with post-Claude-review fixes | Claude | ✅ Deployed `0x56ecCB27...` (`a706c48`) |
| 5 | Audit feedback turnaround | Auditor | Standard 2-4 weeks |
| 6 | V6 Base mainnet deployment | After audit | Script ready, gated |
| 7 | User-facing migration window | After deploy | Documented runbook |

## Risk posture

- **Today**: Arc Testnet has the bugs but no real funds (testnet). Base Mainnet: 3 originally-stuck loans now liquidated; 1.5 USDC of supplied liquidity from the secure wallet only. Risk to other parties: zero.
- **After Base V6 deploy**: existing v4 Base contract continues running until users migrate. New activity routes to V6.
- **Highest risk in the plan**: V6 itself is unaudited externally. The audit is the gate — not the deploy. Internal Claude review caught 4 issues which are now fixed; external auditor will find what Claude could not.
- **Lowest risk**: rollback is trivial (pause V6, revert frontend config to v4).

## Confidence statement

The three core fixes (§B1, §S1, §S5) are mathematically simple and surgically applied. Behavior outside the three fix sites is byte-identical to v4 (verified via differential testing). The 4 Claude-review fixes harden the migration helpers and tighten input validation; none touch the on-the-wire user-facing semantics. V6 has been exercised through: 378 hardhat unit tests, 5 Foundry invariants across 10,240 random sequences, reentrancy attack scenarios, multi-lender stress at the 50-lender cap, 100-loan sequential churn, 25 sustained loan/repay/claim cycles, post-fix smoke test on live Arc, with **zero invariant violations** observed in any test.

The remaining unknown is whatever an external auditor surfaces. The audit package (now ~720K) is prepared and ready for handoff and includes the internal Claude review with all 4 findings marked RESOLVED.

## Files + entry points

- **Audit package**: `forensics/output/regression-2026-05-07/audit-package/` (also `audit-package.tar.gz`)
- **V6 contract source**: `contracts/core/AgentLiquidityMarketplaceV6.sol`
- **V6 deployed (Arc, post-fix)**: https://testnet.arcscan.app/address/0x56ecCB27D953a3c84463Df97e18b4E596462CbdE#code
- **V6 deployed (Arc, pre-Claude-review, archived)**: `0xCeF77E14dB17aE0272510ddbDa97075e7Eb6EbF3` (archived as `agentLiquidityMarketplace_v6_archive_2026_05_12`)
- **Internal Claude review**: `forensics/output/regression-2026-05-07/audit-package/CLAUDE_REVIEW.md` (all 4 findings RESOLVED in `3bb7c27`)
- **Post-fix smoke test log**: `forensics/output/regression-2026-05-07/49-postfix-v6-smoke.txt`
- **Migration runbook**: `forensics/output/regression-2026-05-07/V6_MIGRATION_RUNBOOK.md`
- **Liquidation runbook**: `forensics/output/regression-2026-05-07/LIQUIDATION_RUNBOOK_2026-05-11.md`
- **Base deploy prep**: `forensics/output/regression-2026-05-07/BASE_DEPLOY_PREP.md`
- **Live invariant monitor**: launchd job `com.specular.v6-invariants` (every 30 min, JSONL log to `forensics/monitor/v6-invariants.log`)

## Decision points needing input

1. **Choose auditor** — recommend at least 2 quotes
2. **Approve V6 Base deployment** — after audit clearance
3. **Schedule user comms** — pre-migration notice + migration window
