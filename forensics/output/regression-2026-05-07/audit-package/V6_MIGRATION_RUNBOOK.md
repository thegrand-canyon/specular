# V6 Migration Runbook

Migrating from `AgentLiquidityMarketplace` (v4) to `AgentLiquidityMarketplaceV6` to remediate §B1, §S1, §S5.

## Status as of 2026-05-07

| Network | v4 (current) | V6 (new) | Status |
|---------|--------------|----------|--------|
| Arc Testnet | `0x048363A325A5B188b7FF157d725C5e329f0171D3` | `0xCeF77E14dB17aE0272510ddbDa97075e7Eb6EbF3` | **V6 deployed, migration not started** |
| Base Mainnet | `0xd7b4dEE74C61844DFA75aEbe224e4635463b1C8f` | NOT DEPLOYED | Awaiting external audit |

V6 changes vs v4:
- §B1 — `isInPoolLenders` flag prevents duplicate `poolLenders[]` entries
- §S1 — `claimInterest` decrements `pool.availableLiquidity`
- §S5 — `activeLoanCount` counter replaces `_countActiveLoans` array walk (O(N) → O(1))
- New: `seedPool`, `seedPosition`, `compactPoolLenders`, `setMigrationFinalized` (admin-only, locked after finalization)
- `MAX_LENDERS_PER_POOL`: 50 (was 200 in committed source / 50 in deployed Base bytecode)

## Migration model

V6 is a **new contract**, not an upgrade. Storage is incompatible. Two approaches:

### Approach A — User-driven (cleanest, slowest)

Lenders and borrowers manually move their state.

1. Pause v4 (`pause()`) to prevent new state divergence
2. Notify users (frontend banner, email, Discord)
3. Each lender: `withdrawLiquidity(agentId, amount)` from v4 → receives USDC
4. Each lender: `supplyLiquidity(agentId, amount)` to V6
5. Each borrower: `repayLoan(loanId)` on v4 to clear active loans, OR wait for default + `liquidateLoan`
6. Once v4 is empty: `setMigrationFinalized()` on V6

Pros: lenders control their own funds; no admin custody; clean audit trail.
Cons: requires user action; slow; some users may never migrate.

### Approach B — Admin-seeded (faster, requires custody)

Owner snapshots v4 state and seeds V6 directly. USDC must still move physically — V6 cannot conjure USDC.

1. Pause v4 (`pause()`)
2. Snapshot v4 state to JSON: pools, lender positions, active loan IDs (no migration of active loans — they remain in v4 until repaid/liquidated)
3. For each pool: `v6.seedPool(agentId, agentAddress, totalLiquidity, availableLiquidity, totalEarned)`
4. For each lender position: `v6.seedPosition(agentId, lender, amount, earnedInterest, depositTimestamp)`
5. **USDC custody transfer**: lenders still need to physically move funds (V6 starts empty). Either:
   - (B1) Mint a one-shot escrow contract that withdraws from v4 (requires v4 admin sweep — does not exist) and deposits to V6 → **NOT POSSIBLE** with current v4
   - (B2) Lenders individually call `v4.withdrawLiquidity` then `v6.supplyLiquidity` — but their V6 position is already seeded so this would double-count
   - (B3) Owner calls `v4.withdrawLiquidity` on behalf of each lender — **NOT POSSIBLE** without their consent (msg.sender check)

Conclusion: Approach B is incomplete for fund movement. **Approach A is the only viable path.**

### Recommended hybrid (best of both)

1. Pause v4
2. Notify users with a 30-day grace period and clear instructions
3. Lenders self-withdraw + self-supply (Approach A, steps 3-4)
4. After grace period: invoke `liquidateLoan` on any expired loans on v4 to recover collateral
5. After all funds extracted: any residual fees recovered via `v4.withdrawFees()`
6. Call `v6.setMigrationFinalized()` once V6 has converged

## Pre-deployment audit gate (Base only)

Before deploying V6 to Base mainnet:
- [ ] Independent security review of `AgentLiquidityMarketplaceV6.sol` diff vs v4
- [ ] Slither / Mythril static analysis
- [ ] All 287 hardhat tests pass on V6 (verified 2026-05-07)
- [ ] Specifically verify §B1/§S1/§S5 test coverage in `test/unit/V6Migration.test.js` (8 tests, all passing)
- [ ] Gas comparison: confirm V6 `requestLoan` gas does NOT scale with lifetime loan count
- [ ] Verify `compactPoolLenders` correctly dedups arbitrary duplicate counts (test up to 10×)
- [ ] Set up monitoring on V6 invariants from day 1

## Step-by-step deployment plan

### Phase 1 — Arc Testnet validation (DONE)

- [x] Deploy V6 to Arc Testnet — done 2026-05-07, address `0xCeF77E14...EbF3`
- [x] Authorize V6 with `ReputationManagerV3` — done
- [x] Smoke test (owner, paused, constants) — done
- [ ] Run a full lifecycle E2E on Arc V6 (supply → loan → repay → claim → withdraw)
- [ ] Verify `isInPoolLenders` correctly prevents duplicates after a withdraw → resupply cycle
- [ ] Verify `claimInterest` decrements `availableLiquidity`
- [ ] Authorize V6 with `AgentRegistryV2` if needed (likely no — read-only access)
- [ ] Pause Arc v4 marketplace
- [ ] Migrate Arc state per Approach A
- [ ] Call `setMigrationFinalized()` on Arc V6
- [ ] Update SDK to point at `agentLiquidityMarketplace_v6`
- [ ] Update frontend to point at `agentLiquidityMarketplace_v6`

### Phase 2 — Base Mainnet preparation

- [ ] External audit of V6 (gate)
- [ ] Verify Arc V6 has been stable for ≥7 days
- [ ] Bridge ETH to deployer for Base deployment (~0.01 ETH = $30)
- [ ] Write `scripts/deploy-v6-base-mainnet.js` (mirror Arc deploy script)
- [ ] Liquidate stuck Base loans #2/#3/#4 on 2026-05-11 19:30 UTC (already scheduled — see `LIQUIDATION_RUNBOOK_2026-05-11.md`)
- [ ] Pause Base v4 marketplace

### Phase 3 — Base Mainnet deployment & migration

- [ ] Deploy V6 to Base
- [ ] Authorize with `ReputationManagerV3` (Base owner = secure wallet, fine)
- [ ] Notify users of migration window
- [ ] Lenders migrate per Approach A (only secure wallet has funds in pool 1 — single user migration)
- [ ] `setMigrationFinalized()`
- [ ] Update SDK + frontend to point at Base V6

## Rollback plan

V6 deployment is non-destructive (v4 keeps running). Rollback is "stop pointing at V6":
- Revert SDK / frontend to v4 addresses
- V6 remains deployed but unused
- Lenders keep funds in V6

If a critical bug is found in V6 *before* `setMigrationFinalized`:
- Pause V6 (`pause()`)
- Lenders withdraw from V6 (their funds were just moved in)
- Investigate, fix, redeploy V7

If a critical bug is found *after* `setMigrationFinalized`:
- `setMigrationFinalized` is irreversible — seed* functions cannot be re-enabled
- All recovery must go through user-driven withdraw → re-supply to a V7
- This is why migration finalization should only happen after V6 has been observed in production for some time

## Failure modes during migration

| Scenario | Mitigation |
|----------|------------|
| Lender refuses to migrate, leaves funds in v4 | v4 stays paused; their funds are safely held but inaccessible until they migrate. Plan a final liquidation deadline (e.g., 90 days) after which v4 owner sweeps via `withdrawFees` if applicable. |
| Borrower has active loan on v4 | Their v4 loan must be repaid or liquidated before they can borrow on V6. V6 has no migration of active loans (cleanest). |
| Operator pushes seed* with wrong values | Use `compactPoolLenders` to repair if it's a duplicate issue; otherwise re-seed by overwriting (seedPool overwrites if pool exists, before finalization). |
| §B1/§S1/§S5 found in V6 itself | See "Rollback plan" above — pause V6, redeploy V7. |

## Communication template (for user notification)

> **Specular V6 migration**
>
> We're upgrading the marketplace contract to fix three security issues identified in the audit (§B1 panic, §S1 fund leak, §S5 DoS). The new contract is deployed at:
> - Arc Testnet: 0xCeF77E14dB17aE0272510ddbDa97075e7Eb6EbF3
> - Base Mainnet: TBD (pending audit)
>
> **You'll need to:**
> 1. Withdraw your liquidity from the old marketplace by 2026-XX-XX
> 2. Re-supply to the new marketplace
>
> Active borrowers should repay or wait for default. Stuck loans will be liquidated.
>
> No funds are at risk during migration — the old contract continues to honor withdrawals.

## Artifacts

- Contract: `contracts/core/AgentLiquidityMarketplaceV6.sol`
- Tests: `test/unit/V6Migration.test.js` (8/8 pass), `test/unit/AgentLiquidityMarketplaceV6_Patch.test.js` (7/7 pass — separate self-contained reference)
- Deploy script: `scripts/deploy-v6-arc-testnet.js`
- Updated config: `src/config/arc-testnet-addresses.json` — new key `agentLiquidityMarketplace_v6`
