# Slither Static Analysis Runbook

Slither was not pre-installed when the audit package was prepared. To run it locally:

## Install

```bash
# 1. Install pipx (isolated Python tool installer)
brew install pipx
pipx ensurepath

# 2. Install slither
pipx install slither-analyzer

# 3. Install solc-select (manages solc versions)
pipx install solc-select
solc-select install 0.8.20
solc-select use 0.8.20
```

## Run

```bash
cd ~/Specular
slither contracts/core/AgentLiquidityMarketplaceV6.sol \
    --solc-remaps "@openzeppelin=node_modules/@openzeppelin" \
    --json forensics/output/regression-2026-05-07/audit-package/slither-output.json \
    2>&1 | tee forensics/output/regression-2026-05-07/audit-package/slither-output.txt
```

## What to look for

Slither output is grouped by detector severity. For V6, focus on:

| Severity | Action |
|----------|--------|
| **High** | Must fix before deploy |
| **Medium** | Triage — fix unless documented false positive |
| **Low** | Triage — informational, fix if cheap |
| **Informational** | Note, no action required unless surprising |
| **Optimization** | Defer to post-deploy |

## Known false positives to expect

Based on V6's design, slither is likely to flag (and these are NOT bugs):

1. **`compactPoolLenders`** loops over poolLenders[]. Slither may flag "unbounded loop" — the array is bounded by `MAX_LENDERS_PER_POOL = 50`, so total gas is capped. Document and dismiss.
2. **`seedPool` / `seedPosition`** override existing state. Slither may flag "missing-zero-check" or "state-variable-after-init". These are intentional — migration helpers exist to seed arbitrary state during the migration phase.
3. **`_distributeInterest` totalLiquidity divisor**. Slither may flag "division-before-multiplication" — the rounding direction is intentional (lenders get slightly less, dust accrues to platform fees).
4. **`migrationFinalized` modifier**. Slither may flag "state-variable-only-set-once" — by design, this is one-way.

Real findings to act on:

- Reentrancy in any non-`nonReentrant` function — there shouldn't be any
- Unused state — V6 might inherit unused fields from v4 (e.g., the legacy `_countActiveLoansFromArray` is intentional for parity testing but slither may flag as dead)
- Incorrect access control — any owner-only function missing the modifier

## Triage template

For each finding, document:
```
- ID: SLITHER-001
- Severity: <high|med|low|info>
- Description: <slither's text>
- Location: <file:line>
- Triage: <accept|fix|false-positive>
- Reasoning: <one sentence why>
- Action: <PR # if fix, or "no change" if accepted>
```
