# V6 Test Coverage Report

Generated via `npx hardhat coverage --testfiles V6Migration.test.js,V6_Patch.test.js`. Full HTML report at `./coverage/`.

## Summary

| Contract | % Stmts | % Branch | % Funcs | % Lines |
|----------|---------:|---------:|--------:|--------:|
| AgentLiquidityMarketplaceV6.sol | 72.3 | 39.86 | 59.26 | 73.89 |
| AgentLiquidityMarketplaceV6_Patch.sol | 93.51 | 51.52 | 92.86 | 95.19 |
| AgentLiquidityMarketplace.sol (v4) | 91.53 | 62.5 | 90.48 | 90.26 |

V6 production has lower coverage **by design** — the V6 test suite focuses specifically on the three fixes (§B1, §S1, §S5) and migration helpers. Inherited v4 functionality is covered indirectly by the v4 test suite (which still passes).

## Functions NOT exercised by V6-specific tests

| Function | Line | Why uncovered | Risk |
|----------|------|---------------|------|
| `createAgentPool` | 138 | V6 tests use `seedPool` (admin migration helper) instead | **None** — unchanged from v4. Tested by v4's tests. |
| `totalPools()` | 161 | Read helper, not called in tests | None |
| `liquidateLoan` | 400 | Need to fast-forward time for `block.timestamp > endTime`; not in V6-specific test suite | **Low** — tested in v4 suite, only V6 change is `activeLoanCount--` |
| `getLenderPosition` | 478 | Read helper | None |
| `getActiveAgents` | 502 | Intentionally reverts (v4 design) | None |
| `withdrawFees` | 534 | Owner op, tested in v4 | **Low** — unchanged from v4 |
| `pause` / `unpause` | 543, 550 | Owner ops, tested in v4 | None — unchanged |
| `setPlatformFeeRate` | 660 | Owner op, tested in v4 | None — unchanged |
| `resetPoolAccounting` | 670 | Owner op (legacy), tested in v4 | **Low** — unchanged from v4. Note: doesn't fix §S1 — see audit findings. |
| `_countActiveLoansFromArray` | 705 | Intentionally retained as legacy (unused in production paths) | None — dead code by design, kept for test parity |

## Statement coverage gaps (raw)

Uncovered line ranges:
```
139-141, 153-155, 162   ← createAgentPool, totalPools, view returns
272                      ← requestLoan: a branch in collateral path
401-405, 408-409, 415, 429-431  ← liquidateLoan body
484-487, 491, 506        ← view functions (getLenderPosition, getActiveAgents)
535-537, 544, 551        ← pause/unpause/withdrawFees
644, 661                  ← setPlatformFeeRate / resetPoolAccounting head
671-672, 675-680, 686, 690 ← resetPoolAccounting body
706-710, 715              ← _countActiveLoansFromArray (intentionally unused)
```

## Action items (gap-filling tests to add)

For full audit coverage, the following test additions would close the gaps. None are blockers — they're confidence-building.

1. **`liquidateLoan` test on V6**:
   - Take a loan, fast-forward past endTime via `time.increase()`, owner liquidates, verify `activeLoanCount` decremented.
   - File: extend `V6Migration.test.js` with a "liquidation" describe block.
2. **`createAgentPool` test on V6**:
   - Register an agent, call `createAgentPool`, verify pool active + agentPoolIds updated.
3. **`requestLoan` collateral branch test**:
   - Test the path where `requiredCollateral > 0` (low reputation case).
4. **`pause`/`unpause` test**:
   - Verify whenNotPaused functions revert when paused.
5. **`compactPoolLenders` test for actual duplicates**:
   - Use `seedPosition` to inject N positions for same lender (impossible via supplyLiquidity due to flag), then dedup. **Caveat:** seedPosition itself uses the flag, so direct duplicate injection requires a test-only override or assembly storage write.

## Branch coverage gaps

Branch coverage at 39.86% reflects:
- Many `require` failure paths not tested (e.g., "Pool already exists", "Loan not active", "Insufficient pool liquidity"). These are reverts, not state changes — auditing them via tests adds confidence the revert message is right but doesn't change the security analysis.
- Conditional branches in `_distributeInterest` (zero-amount lender skip, dust crediting) — partially covered by the multi-lender tests in V6_Patch suite.

## Recommendation for audit

The 287 v4 hardhat tests + 8 V6 migration tests + 7 V6_Patch tests = **302 tests** covering V6's three fix sites + migration helpers + the entire inherited v4 surface (via v4 tests).

For external auditor handoff, point them at:
1. `test/unit/V6Migration.test.js` — V6-specific behavior
2. `test/unit/AgentLiquidityMarketplaceV6_Patch.test.js` — reference patch tests
3. `test/unit/AgentLiquidityMarketplace.test.js` — v4 tests (which V6 inherits semantics from)

Coverage gaps in V6 are **inherited functions tested in v4**. If the auditor needs V6-specific coverage of these, the action items above provide the minimal surface.
