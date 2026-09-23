# Regression Addendum — 2026-05-07 PM

Builds on `REGRESSION_REPORT_2026-05-07.md`. Captures the second-session work after the user requested the next-step actions.

## Tasks completed this session

| # | Task | Outcome |
|---|------|---------|
| 10 | Probe v5 marketplace | v5 keccak == Base canonical keccak — same broken artifact, MAX_LENDERS=50 only. **Authorizing v5 would not fix §B1/§S1/§S5.** |
| 11 | Test resetPoolAccounting | Does NOT heal §S1. Formula `avail = totalLiq + totalEarned - actualLoaned` re-computes the phantom value. **No in-contract tool fixes §S1.** |
| 12 | Schedule Base liquidation | Runbook + standalone script ready. Script: `forensics/scripts/base_liquidate_2026_05_11.js`. Runbook: `LIQUIDATION_RUNBOOK_2026-05-11.md`. Cron created (session-only) — set OS-level reminder for redundancy. |
| 13 | Design §S5 patch | `AgentLiquidityMarketplaceV6_Patch.sol` written. **7/7 tests pass** including gas-non-scaling check (ratio < 1.5×). Includes §B1 + §S1 + §S5 fixes + `compactPoolLenders()` migration helper. |
| 14 | Expanded E2E | Duration edge cases verified (MIN=7, MAX=365 days). Liquidate pre-flight ready. **Side effect: Arc pool #49 now has a 2nd §B1 duplicate** from the duration test setup — same address pushed twice via supply→withdraw→supply. |

## Key new findings

### v5 marketplace identity
- Arc v5 (`0x9EF0...877A2B`) bytecode keccak `0x95b0d1ac40...`
- Base canonical (`0xd7b4dEE7...`) bytecode keccak `0x95b0d1ac40...`
- **Same artifact.** Difference vs Arc v4 is exactly 1 byte at offset 682: `0xc8` (200) → `0x32` (50) for `MAX_LENDERS_PER_POOL`. No §B1/§S1/§S5 fixes.
- v5 owner is the compromised wallet — would need ownership transfer first.

### resetPoolAccounting limitation
The function only recalculates `totalLoaned` from active loans and re-derives `availableLiquidity = totalLiquidity + totalEarned − totalLoaned`. It does not distinguish claimed vs unclaimed interest, so any §S1 phantom is preserved on call. **The 74.87 USDC of cumulative §S1 leaks across 40 lenders is permanent until the contract is replaced.**

### V6 patch — verified fixes

| Fix | Mechanism | Test result |
|-----|-----------|-------------|
| §B1 | `mapping(uint256 => mapping(address => bool)) isInPoolLenders` gates `poolLenders[].push()`; admin `compactPoolLenders()` for migration | supply→withdraw→supply leaves `poolLenders` unchanged ✓ |
| §S1 | `claimInterest` decrements `pool.availableLiquidity` by claimed amount (with underflow `require`) | `availableLiquidity ≤ usdc.balanceOf(MP)` invariant holds ✓ |
| §S5 | `mapping(address => uint256) activeLoanCount` replaces array walk in `_countActiveLoans` | Gas ratio between 5-loan and 55-loan history < 1.5× ✓ |

Compiled successfully against solc 0.8.20. Storage layout intentionally NOT compatible with v4/v5 — needs fresh deployment + state migration.

### Duration footgun (§D)
Contract enforces `7 ≤ durationDays ≤ 365`. Both `366` and `604800` (seconds-shaped) revert with the **same** opaque message `"Invalid duration"`. The SDK guard from `~/.claude/plans/bubbly-discovering-aurora.md` is still warranted — it would catch `604800` with the actionable hint `"looks like 7 days expressed in seconds — pass days instead"` before any RPC round-trip.

## Net Specular state changes from this session

| Network | Pool | Change |
|---------|------|--------|
| Arc | 49 | lenderCount went 1→2 (§B1 duplicate created via duration test setup); supplied 1 USDC then withdrew it; phantom availableLiquidity remains at 0.008544 USDC |
| Base | 1 | unchanged |

Net cost: ~0.0008 ETH gas on Arc (~$0.001 at gas), no Base gas spent.

## Open paths forward

1. **2026-05-11 19:30 UTC**: run `base_liquidate_2026_05_11.js` to free Base loans #2/#3/#4 → DEFAULTED state. Recovers ~3855 base units of collateral. Borrower (secure wallet's agent #1) takes -150 reputation.
2. **§S1 mitigation**: deploy V6_Patch (or audited equivalent) and migrate. The 74.87 USDC phantom remains in the old contract until obsoleted.
3. **§S5 mitigation**: same as §S1 — deploy patch, migrate. Agent #43 (compromised wallet) at 777 loans cannot be migrated until the wallet's pool is drained or the contract has admin ownership-transfer for stuck pools.
4. **§B1 mitigation across existing pools**: V6 patch's `compactPoolLenders(agentId)` is the migration hook — would need to be called for every poisoned pool (1 on Base, 2 on Arc currently).
5. **Authorize V6 deployment**: write deployment script, audit the patch (independently), bridge ETH to deployer wallet, deploy + transfer ownership + migrate state.

## Artifacts (this session)

```
forensics/output/regression-2026-05-07/
├── 12-v5-probe.txt                       # v5 vs v4 bytecode comparison
├── 13-resetPoolAccounting.txt            # confirmed: doesn't heal §S1
├── 14-base-liquidation-result.json       # (will populate when liquidation script fires)
├── 15-expanded-e2e.{txt,json}            # duration edge cases + liquidate pre-flight + cross-net snapshot
├── LIQUIDATION_RUNBOOK_2026-05-11.md     # operations runbook for Day-11 liquidation
└── ADDENDUM_2026-05-07_PM.md             # this file

forensics/scripts/
├── base_liquidate_2026_05_11.js          # idempotent liquidation script
└── expanded_e2e_2026_05_07.js            # duration/cross-net script

contracts/core/
├── AgentLiquidityMarketplaceV6_Patch.sol # patched contract (B1+S1+S5 fixes + migration helper)
└── AgentLiquidityMarketplaceV2_EMERGENCY_PATCH.sol.broken  # pre-existing broken file, moved aside

test/unit/
└── AgentLiquidityMarketplaceV6_Patch.test.js  # 7/7 tests pass
```
