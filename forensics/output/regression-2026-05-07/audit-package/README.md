# Specular V6 Audit Package

Self-contained handoff for an external auditor reviewing `AgentLiquidityMarketplaceV6.sol`.

## Scope

Three security fixes (§B1, §S1, §S5) plus migration helpers, layered on top of the existing v4 marketplace.

V6 has been:
- Deployed to Arc Testnet (current post-fix: `0x56ecCB27D953a3c84463Df97e18b4E596462CbdE`)
- **Verified on Arcscan**: https://testnet.arcscan.app/address/0x56ecCB27D953a3c84463Df97e18b4E596462CbdE#code
- Live-tested for all three fixes — transaction hashes captured in evidence JSONs
- **Stress-tested at scale**: 50-lender boundary (Test A), 100 sequential loans (Test B), 25 sustained cycles (Test E), 365-day max-duration loan (Test D), multi-pool (Test C)
- Multi-lender interest distribution proven: 4 distinct lenders with proportional shares, no §B1 panic
- v4↔V6 differential: identical state on non-fix paths, divergence ONLY at the 3 fix sites
- Property-based fuzz: 5 Foundry invariants × 10,240 random sequences, 0 invariant violations
- Reentrancy guards verified: 5 attack scenarios all blocked
- Monitored continuously via launchd cron (every 30 min) for §B1/§S1/§S5 invariants
- **Internally reviewed by Claude** (the AI assistant that helped author V6) — 4 low-severity findings, all fixed in `3bb7c27` and verified live on post-fix Arc V6. See `CLAUDE_REVIEW.md` for the explicit scope-and-limitations preamble. **NOT a substitute for this external audit.**

Total tests passing: **378** (287 inherited v4 + 8 migration + 7 patch reference + 5 reentrancy + 5 property-fuzz + 6 differential + 15 Claude-review-fix + 45 coverage / live invariant helpers)

V6 has NOT been:
- Independently audited (this package is the gate)
- Deployed to Base Mainnet (gated on this audit)

Prior V6 deployments archived during iteration:
- `0xCeF77E14dB17aE0272510ddbDa97075e7Eb6EbF3` (pre-Claude-review V6, retained as `agentLiquidityMarketplace_v6_archive_2026_05_12`)

## What to read first

1. **`V4_TO_V6_DIFF.md`** — annotated walkthrough of every change. Start here.
2. **`THREAT_MODEL.md`** — actors, trust assumptions, attack surface, audit-focus recommendations.
3. **`v4-to-v6.diff`** — raw 270-line unified diff (178 +/- lines).

Then, depending on focus:
- **`COVERAGE_REPORT.md`** — test coverage breakdown + gap action items
- **`SLITHER_RUNBOOK.md`** — how to run static analysis (slither was not pre-run; install + execute steps included)
- **`baseline-report.md`** — pre-V6 audit findings (§B1/§S1/§S5 confirmed live on v4 + Base)
- **`V6_MIGRATION_RUNBOOK.md`** — operational migration plan (post-audit)

## Directory layout

```
audit-package/
├── README.md                       (this file)
├── V4_TO_V6_DIFF.md                annotated diff
├── v4-to-v6.diff                    raw unified diff
├── THREAT_MODEL.md                  attack surface + trust model
├── COVERAGE_REPORT.md               test coverage breakdown
├── SLITHER_RUNBOOK.md               static analysis instructions
├── baseline-report.md               pre-V6 §B1/§S1/§S5 evidence on v4
├── V6_MIGRATION_RUNBOOK.md          post-deploy migration plan
├── source/
│   ├── AgentLiquidityMarketplaceV6.sol         the contract under review
│   ├── v4-baseline.sol                          v4 = AgentLiquidityMarketplace.sol
│   └── AgentLiquidityMarketplaceV6_Patch.sol    self-contained reference (kept for parity)
├── tests/
│   ├── V6Migration.test.js                      v4 → V6 migration tests (8 cases)
│   ├── AgentLiquidityMarketplaceV6_Patch.test.js  reference patch tests (7 cases)
│   ├── V6PropertyFuzz.test.js                   property fuzz with random walks (5 cases)
│   ├── V4_V6_Differential.test.js               proves divergence ONLY at fix sites (6 cases)
│   ├── V6Reentrancy.test.js                     5 reentrancy attack scenarios — all blocked
│   └── V6ClaudeReviewFixes.test.js              15 tests for the 4 Claude-review fixes
└── evidence/                                    on-chain test results
    ├── 02-baseline-augment.json                 §B1/§S1/§S5 confirmed on v4 baseline
    ├── 11-new-scenarios.json                    §S5 live gas, §S1 leak projection
    ├── 17-v6-live-e2e.json                      V6 fixes verified on Arc Testnet (live tx hashes)
    ├── 18-v6-boundary.json                      MAX_ACTIVE_LOANS + gas non-scaling
    ├── 22-sdk-api-v6-integration.json           SDK→API→V6 full-stack integration
    ├── 23-v6-fuzz-walk.json                     live random walk on V6
    ├── 24-gas-comparison.json                   Arc v4 / V6 / Base v4 gas comparison
    ├── 26-v6-multi-lender.json                  4-lender interest distribution
    ├── 27-base-v4-state-dump.json               Base agent #1 §B1 mechanism dump
    ├── 28-test-a-max-lenders.json               50-lender boundary (cap proven enforced)
    ├── 29-test-b-loan-churn.json                100 sequential loans gas analysis
    ├── 30-test-c-multipool.json                 5-pool independence
    └── 31-test-de-longdur-claims.txt            365-day loan + 25 claim cycles
```

## Quick verification

To replicate the test pass:

```bash
git clone <repo>
cd Specular
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"  # Node 22 LTS required
npm install
npx hardhat compile
npx hardhat test test/unit/V6Migration.test.js test/unit/AgentLiquidityMarketplaceV6_Patch.test.js
# Expected: 15 passing
```

Full suite (V6 + inherited v4 tests):
```bash
npx hardhat test
# Expected: 378 passing, 1 pending
```

Coverage:
```bash
npx hardhat coverage --testfiles "test/unit/V6Migration.test.js,test/unit/AgentLiquidityMarketplaceV6_Patch.test.js"
```

## Three things to focus the audit on

Per `THREAT_MODEL.md` "Recommended audit focus areas":

1. **§S5 counter integrity** — verify `activeLoanCount[]` exactly mirrors `Σ(loans where state == ACTIVE)` across all paths
2. **§B1 flag invariant** — prove `isInPoolLenders[a][l] ⟺ l ∈ poolLenders[a]`
3. **§S1 accounting** — trace every `availableLiquidity` ± to actual USDC custody movements

Plus secondary:
- `setMigrationFinalized()` irreversibility
- All `nonReentrant` + CEI ordering preserved
- Migration helpers' bounded reach (owner-only, locked post-finalization)

## Out-of-scope reminders

- v4 itself is **not** part of this audit (it's the baseline). Bugs in v4 are documented but won't be patched in v4.
- `AgentRegistryV2` and `ReputationManagerV3` are **not** part of this audit. V6 trusts them.
- The migration **process** (operational, not contract) is not part of this audit, but the on-chain hooks (seed*) are in scope.
- The frontend / SDK / API server are not part of this audit.

## Severity rubric

| Severity | Definition for this scope |
|----------|---------------------------|
| Critical | Allows fund theft, permanent fund freezing, or DoS of all users |
| High     | Allows §B1/§S1/§S5 to remanifest, or allows owner to drain non-fee USDC |
| Medium   | Allows specific lender/borrower to be denied service, or allows owner to do something not in trust assumptions |
| Low      | Code quality, minor information leak, gas optimization, naming |
| Info     | Style, doc, suggested improvements |

## Bug bounty / disclosure

Findings should be reported to: (TODO — fill in disclosure address)

A separate `DISCLOSURE.md` exists in the parent repo for the original §B1/§S1/§S5 findings on v4.
