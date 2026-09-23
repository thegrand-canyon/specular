# V6 Threat Model

Captures the trust assumptions, attack surface, and known limitations of `AgentLiquidityMarketplaceV6` so reviewers can focus their effort.

## Actors

| Actor | Role | Trust |
|-------|------|-------|
| **Owner** | `0x800e305A...F72C` (secure wallet) | Fully trusted. Can pause, withdraw fees, liquidate, seed state, finalize migration, compact poolLenders, set fee rate. |
| **Agent** | Borrower with their own pool. Identified by `addressToAgentId(addr) != 0`. | Trusted to repay loans on time. Reputation tracks defaults. Trust does not extend to the contract itself. |
| **Lender** | Anyone who supplies USDC to a pool. | Trusted only to honor their own deposits. Cannot affect other lenders' positions directly. |
| **Anonymous** | Unauthenticated callers | Read-only via public view functions. |

## Trust assumptions

1. **Owner private key is not compromised.** A compromised owner can pause the contract, drain accumulated fees, seed arbitrary state during migration, and `liquidateLoan` early (only on overdue loans, but owner controls the overdue check by manipulating block timestamps via gas market manipulation? No — block.timestamp is controlled by the sequencer/validator, not the owner).
2. **`AgentRegistryV2` and `ReputationManagerV3` are honest.** The contract reads `addressToAgentId`, `calculateCreditLimit`, `calculateInterestRate`, `calculateCollateralRequirement`, `recordBorrow`, `recordLoanCompletion`, `recordDefault`. All trust flows through. If those contracts are compromised, V6 inherits the compromise.
3. **USDC is honest.** USDC token is used via SafeERC20. Reentrancy via USDC transfers is mitigated by `nonReentrant`. Fee-on-transfer USDC variants would break accounting but Base/Arc USDC don't have this.
4. **No malicious lender can make another lender lose funds without the lender's action.** Verified: `withdrawLiquidity`, `claimInterest`, `supplyLiquidity` all use `msg.sender`. No path lets caller A modify caller B's position.
5. **Block timestamps are loosely monotonic.** Used for `loan.startTime`, `loan.endTime`, `position.depositTimestamp`. The contract doesn't depend on millisecond precision.

## Attack surface — by entry point

### `supplyLiquidity(agentId, amount)` (whenNotPaused, nonReentrant)

| Risk | Mitigation |
|------|-----------|
| Reentrancy via USDC transferFrom | `nonReentrant` |
| Pool inflation by repeated push (§B1) | **Fixed**: `isInPoolLenders` flag prevents duplicate push |
| Lender cap bypass | `MAX_LENDERS_PER_POOL = 50` enforced |
| Spam DoS via 50 lenders supplying min amount | Cap is reached, no new lenders. Existing lenders unaffected. |
| Borrower's own pool can't be supplied to | False — anyone can supply to any pool. Lender chooses which agent to lend to. |
| Lender can supply to their own pool while being agent | True — supported design. Lender = borrower in this case. |

### `withdrawLiquidity(agentId, amount)` (whenNotPaused, nonReentrant)

| Risk | Mitigation |
|------|-----------|
| Withdraw more than position | `require(position.amount >= amount)` |
| Withdraw locked liquidity (in active loan) | `require(pool.availableLiquidity >= amount)` |
| Reentrancy | `nonReentrant` + CEI ordering |
| poolLenders entry not removed on full withdraw | Intentional in V6 — `isInPoolLenders` flag remains true so re-supply doesn't create duplicate. Position with amount=0 contributes nothing in `_distributeInterest`. |

### `requestLoan(amount, durationDays)` (whenNotPaused, nonReentrant)

| Risk | Mitigation |
|------|-----------|
| Borrow without registration | `require(agentId != 0, "Not a registered agent")` |
| Borrow without pool | `require(agentPools[agentId].isActive, "No pool for agent")` |
| Borrow more than pool | `require(amount <= pool.availableLiquidity)` |
| Borrow over credit limit | `require(amount <= creditLimit)` |
| §S5 DoS via lifetime loan history | **Fixed**: O(1) `activeLoanCount` check |
| Concurrent loan limit bypass | `require(activeLoans < MAX_ACTIVE_LOANS_PER_AGENT)` |
| Invalid duration (e.g., seconds) | `require(duration in [MIN, MAX])` |
| Reentrancy | `nonReentrant` |
| Collateral underpayment | `usdcToken.safeTransferFrom` for collateral; reverts on insufficient allowance/balance |

### `repayLoan(loanId)` (whenNotPaused, nonReentrant)

| Risk | Mitigation |
|------|-----------|
| Pay someone else's loan | `require(msg.sender == loan.borrower)` |
| Repay an inactive loan | `require(loan.state == LoanState.ACTIVE)` |
| Reentrancy via collateral return | `nonReentrant` + CEI ordering — funds in before state out. Collateral returned LAST. |
| Underflow in interest distribution (§B1) | **Fixed**: no duplicates in poolLenders[] means `_distributeInterest` correctly sums to ≤ totalInterest |
| Borrower starves lenders by repaying late | Late-fee built into interest formula (charged based on full duration, not actual time). Default penalty is enforced via `recordLoanCompletion(onTime=false)`. |

### `claimInterest(agentId)` (whenNotPaused, nonReentrant)

| Risk | Mitigation |
|------|-----------|
| Claim someone else's interest | `position` is keyed by `[agentId][msg.sender]`, can't be impersonated |
| Claim with no interest | `require(interest > 0)` |
| §S1 phantom liquidity | **Fixed**: `pool.availableLiquidity -= interest` decrement |
| Reentrancy | `nonReentrant` |
| Underflow on decrement | `require(pool.availableLiquidity >= interest)` |

### `liquidateLoan(loanId)` (onlyOwner, nonReentrant)

| Risk | Mitigation |
|------|-----------|
| Premature liquidation | `require(block.timestamp > loan.endTime)` |
| Liquidate non-active loan | `require(loan.state == LoanState.ACTIVE)` |
| Owner liquidates for profit | Recovered collateral goes to pool (not owner). Owner gains nothing personally. |
| §B1 panic during liquidation | **Bypassed**: `liquidateLoan` does NOT call `_distributeInterest`. This is by design — liquidation must work even when the pool is poisoned. |

### Migration helpers (`seedPool`, `seedPosition`, `compactPoolLenders`, `setMigrationFinalized`)

All `onlyOwner`. Bounded by `whileMigrating` modifier (except `compactPoolLenders` which can be called any time).

| Risk | Mitigation |
|------|-----------|
| Owner seeds fake pool to drain USDC | They'd need actual USDC to drain. Seeding a position doesn't transfer USDC — it just writes accounting. The lender (could be anyone) would still need to have funds in the contract for withdraw to succeed. |
| Owner front-runs lender migration to redirect funds | Possible during migration phase. **Mitigation:** users self-migrate (Approach A); owner doesn't have unilateral USDC custody migration capability. |
| Operator pushes a duplicate poolLenders entry via raw seed | Prevented by `isInPoolLenders` flag in `seedPosition`. |
| `setMigrationFinalized` flipped accidentally early | Irreversible. **This is the key risk — recovery requires deploying V7.** |
| `compactPoolLenders` called maliciously post-finalization | Owner could hide a duplicate or remove a legitimate lender. The lender's mapping data (`positions[agentId][lender]`) is unaffected, so they can still withdraw. They just won't receive new interest distributions. |

## Attack scenarios — adversarial walkthrough

### Scenario A: Lender tries to trigger §B1 panic via supply→withdraw→supply
**v4 outcome:** creates duplicate, eventually panics on next loan repay.
**V6 outcome:** `isInPoolLenders` flag prevents duplicate. No panic.
✅ Verified live: `17-v6-live-e2e.json`.

### Scenario B: Borrower creates 5,000+ loans to brick their own agent (DoS)
**v4 outcome:** at ~5,140 lifetime loans, `requestLoan` exceeds block gas. Agent stuck.
**V6 outcome:** O(1) counter — gas stays flat regardless of lifetime count.
✅ Verified live: `18-v6-boundary.json`.

### Scenario C: Lender claims interest repeatedly to drain the contract
**v4 outcome:** `availableLiquidity` accounting drifts up; eventually withdraws fail. Effectively a slow drain.
**V6 outcome:** `availableLiquidity -= interest` keeps accounting honest.
✅ Verified live: `17-v6-live-e2e.json`.

### Scenario D: Migration operator (owner) introduces an inconsistency
e.g., seedPool says totalLiquidity = 100, but only seeds positions summing to 50. After finalization, 50 USDC of "ghost liquidity" is recorded.
**Mitigation:** the on-chain invariant `Σ pos.amount ≤ pool.totalLiquidity` is not enforced by the contract — runtime checks rely on individual transfers. Inconsistency would lead to first-come-first-serve withdrawals. The operator can verify post-seeding via the invariant monitor before calling `setMigrationFinalized`.

### Scenario E: Compromised owner key
Attacker can: pause, drain accumulated fees, seed arbitrary state during migration, dedup poolLenders maliciously, set fee rate to 5%, liquidate any overdue loan.
Cannot: bypass `whenNotPaused` (sandboxes themselves), bypass nonReentrant, bypass borrower checks, withdraw lender funds directly.
**Mitigation:** secure wallet hygiene + multi-sig consideration for production owner.

## Trust boundary diagram

```
[ External callers (anyone)        ] -- view/read --> [ V6 marketplace ]
                                                          |
[ Lenders ]  -- supply/withdraw -->                      | -> [ ReputationManagerV3 ]
                                                          |       (recordBorrow / recordLoanCompletion / recordDefault)
[ Agents ]   -- requestLoan/repay -->                    |
                                                          | -> [ AgentRegistryV2 ]
[ Owner ]    -- pause/seed/liquidate/compact/finalize    |       (addressToAgentId — read only)
              -- (privileged ops) -->                    |
                                                          | -> [ USDC ]
                                                                  (transferFrom / transfer)
```

V6 is the trust pivot. Compromise in any of {ReputationManager, AgentRegistry, USDC, Owner key} cascades.

## Known limitations (not bugs, but worth flagging)

1. **Interest formula uses full loan duration, not actual elapsed time.** A 7-day loan repaid in 1 second still incurs 7 days of interest. This is the v4 behavior, retained in V6.
2. **`withdrawLiquidity` doesn't pop poolLenders[].** A lender's slot stays at full size. Storage isn't reclaimed unless `compactPoolLenders` is called manually. Cost: 50 × ~5k slots per pool, ~250k storage if all pools fully populated. Marginal.
3. **No emergency pause-during-migration combo.** If owner pauses during migration, seed* functions still work because `whileMigrating` only checks finalization, not pause state. This is intentional — pause shouldn't block migration completion.
4. **`getActiveAgents()` reverts intentionally.** This is a v4 design decision — the function is meant to be queried via the front-end with specific agent filters. V6 retains this.
5. **No formal verification.** Contract is medium-complexity; behavior is well-tested via 8 V6Migration tests + 7 V6_Patch tests + 287 inherited tests. No SMT-checked invariants.

## Recommended audit focus areas

If audit budget is limited, prioritize:

1. **§S5 counter integrity** (highest leverage — DoS prevention is the §S5 fix). Verify all 3 transition sites and prove no other path can change `loan.state`.
2. **§B1 flag invariant**. Prove `isInPoolLenders[a][l] == true ⟺ l ∈ poolLenders[a]` holds across all paths (supply, seedPosition, compactPoolLenders).
3. **§S1 accounting**. Trace every increment/decrement of `availableLiquidity` to ensure they sum to actual USDC custody movements.
4. **Migration helpers**. Confirm the irreversibility of `setMigrationFinalized` and the bounded reach of seed*.
5. **Reentrancy**. Confirm every external call is in a `nonReentrant` function and follows CEI.

Lower priority (already extensively tested):
- View functions (read-only, no state mutation)
- Liquidation pathway (unchanged from v4)
- Constants / events (changes are surface-level)
- The 287 hardhat tests inherited from v4 give high baseline confidence in the unchanged surface.
