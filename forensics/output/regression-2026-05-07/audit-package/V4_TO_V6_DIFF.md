# V4 → V6 Annotated Diff

Companion to `v4-to-v6.diff` (270-line raw diff, 178 +/- lines).

This document walks through every change so reviewers can verify each one is correct and intentional.

## Files

- v4: `contracts/core/AgentLiquidityMarketplace.sol`
- V6: `contracts/core/AgentLiquidityMarketplaceV6.sol`
- Raw diff: `audit-package/v4-to-v6.diff`

## Change categories

| Category | Count | Risk |
|----------|-------|------|
| Three security fixes (§B1, §S1, §S5) | 3 sites + supporting state | **HIGH — primary review target** |
| Migration helpers | 4 functions + 1 modifier | Medium — owner-only, locked after finalization |
| Constants & metadata | 1 (MAX_LENDERS 200→50) + comments | Low |
| Events | 5 new | Low |
| Cosmetic | contract rename | Trivial |

## Section 1 — Three security fixes

### §B1 fix: prevent duplicate poolLenders entries

**v4 (broken)** — `supplyLiquidity`, around line 178:
```solidity
if (position.amount == 0) {
    require(poolLenders[agentId].length < MAX_LENDERS_PER_POOL, "Pool lender capacity reached");
    poolLenders[agentId].push(msg.sender);
    position.depositTimestamp = block.timestamp;
}
position.amount += amount;
```
After a full withdraw, `position.amount = 0`. On re-supply, the push fires again — creating a second entry for the same lender. `_distributeInterest` then double-counts shares → arithmetic underflow → Panic(0x11).

**V6 (fixed)** — same function:
```solidity
if (!isInPoolLenders[agentId][msg.sender]) {
    require(poolLenders[agentId].length < MAX_LENDERS_PER_POOL, "Pool lender capacity reached");
    poolLenders[agentId].push(msg.sender);
    isInPoolLenders[agentId][msg.sender] = true;
    position.depositTimestamp = block.timestamp;
}
position.amount += amount;
```
The push is gated by an explicit presence flag, not by position state. Once a lender is in the array, the flag stays `true` forever — no matter how many times they withdraw and re-supply.

**Auditor checks:**
- [ ] Does any path push to `poolLenders[]` without setting `isInPoolLenders` to true? (Search for `poolLenders[*].push`)
- [ ] Does any path clear `isInPoolLenders` to false? (Only `compactPoolLenders` should — and it sets it back true for unique entries.)
- [ ] Verify gas: a lender's first supply now writes 1 extra storage slot vs v4 (the flag). All subsequent supplies are unchanged.

### §S1 fix: decrement availableLiquidity on claim

**v4 (broken)** — `claimInterest`:
```solidity
function claimInterest(uint256 agentId) external nonReentrant whenNotPaused {
    LenderPosition storage position = positions[agentId][msg.sender];
    uint256 interest = position.earnedInterest;
    require(interest > 0, "No interest to claim");
    position.earnedInterest = 0;
    usdcToken.safeTransfer(msg.sender, interest);
}
```
USDC leaves the contract via safeTransfer, but `pool.availableLiquidity` is never decremented. Over time, `Σ pool.availableLiquidity` grows beyond `usdc.balanceOf(this)`. Eventually withdrawals will fail because the contract doesn't actually have the USDC the accounting claims.

**V6 (fixed)** — same function:
```solidity
function claimInterest(uint256 agentId) external nonReentrant whenNotPaused {
    LenderPosition storage position = positions[agentId][msg.sender];
    AgentPool storage pool = agentPools[agentId];
    uint256 interest = position.earnedInterest;
    require(interest > 0, "No interest to claim");
    position.earnedInterest = 0;
    require(pool.availableLiquidity >= interest, "Drain underflow");
    pool.availableLiquidity -= interest;
    usdcToken.safeTransfer(msg.sender, interest);
    emit InterestClaimed(agentId, msg.sender, interest);
}
```

**Auditor checks:**
- [ ] Verify `pool.availableLiquidity` decrement is correct. Interest was added to `availableLiquidity` in `repayLoan` (line ~341). On claim, it's removed.
- [ ] The `require(pool.availableLiquidity >= interest)` should never fire under correct state — if it does, accounting was inconsistent already.
- [ ] Note: `pool.totalEarned` is NOT decremented (intentional — it's a lifetime stat). Only `availableLiquidity` decrements.
- [ ] Live verification on Arc V6: `forensics/output/regression-2026-05-07/17-v6-live-e2e.json` shows pool.availableLiquidity going 5.008544 → 5.000000 after claim of 0.008544 USDC.

### §S5 fix: O(1) active-loan check

**v4 (broken)** — `_countActiveLoans`:
```solidity
function _countActiveLoans(address agent) internal view returns (uint256) {
    uint256[] memory loanIds = agentLoans[agent];
    uint256 activeCount = 0;
    for (uint256 i = 0; i < loanIds.length; i++) {
        if (loans[loanIds[i]].state == LoanState.ACTIVE) {
            activeCount++;
        }
    }
    return activeCount;
}
```
Called from `requestLoan`. Gas grows linearly with lifetime loan count. At ~5,000 lifetime loans, `requestLoan` exceeds block gas limit → DoS.

**V6 (fixed)** — same function reduced to one line:
```solidity
function _countActiveLoans(address agent) internal view returns (uint256) {
    return activeLoanCount[agent];
}

// Legacy O(N) implementation, retained for verifying counter integrity in tests.
function _countActiveLoansFromArray(address agent) internal view returns (uint256) {
    // ... same as v4
}
```
Plus three sites where the counter is maintained:

| Site | Change |
|------|--------|
| `_disburseLoan` (transition REQUESTED→ACTIVE) | `activeLoanCount[loan.borrower]++` |
| `repayLoan` (transition ACTIVE→REPAID) | `activeLoanCount[loan.borrower]--` |
| `liquidateLoan` (transition ACTIVE→DEFAULTED) | `activeLoanCount[loan.borrower]--` |

**Auditor checks:**
- [ ] Every transition INTO `LoanState.ACTIVE` increments. Search for `loan.state = LoanState.ACTIVE`. Only one site (`_disburseLoan`).
- [ ] Every transition OUT OF `ACTIVE` decrements. Search for `loan.state = LoanState.REPAID` and `loan.state = LoanState.DEFAULTED`.
  - REPAID: only in `repayLoan` ✓ decrement present
  - DEFAULTED: only in `liquidateLoan` ✓ decrement present
- [ ] No path can transition state without going through one of these three functions.
- [ ] No double-increment / double-decrement: each function transitions exactly once due to `require(loan.state == ACTIVE)` checks.
- [ ] `_countActiveLoansFromArray` should never be called in production code paths — it exists for test parity.
- [ ] Live verification on Arc V6: `forensics/output/regression-2026-05-07/18-v6-boundary.json` shows gas FLAT across 10 loans (ratio 0.914×).

## Section 2 — Migration helpers

V6 adds a migration phase, gated by the `migrationFinalized` boolean and `whileMigrating` modifier:

```solidity
modifier whileMigrating() {
    require(!migrationFinalized, "Migration finalized");
    _;
}
```

### `seedPool(agentId, agentAddress, totalLiquidity, availableLiquidity, totalEarned)`

Owner-only, while migrating. Writes the pool struct directly. Adds to `agentPoolIds` if new.

**Auditor checks:**
- [ ] `onlyOwner` modifier present
- [ ] `whileMigrating` modifier present
- [ ] No checks against existing state — operator can overwrite. This is intentional (migration is one-shot).
- [ ] `agentId != 0` and `agentAddress != address(0)` checks present
- [ ] No state side effects beyond the pool struct + agentPoolIds (which is correct — the function is for pool-level data only, not positions)

### `seedPosition(agentId, lender, amount, earnedInterest, depositTimestamp)`

Owner-only, while migrating. Writes the position + ensures lender is in poolLenders.

**Auditor checks:**
- [ ] Modifiers present
- [ ] Checks `agentPools[agentId].agentId == agentId` (pool must be seeded first)
- [ ] **Uses isInPoolLenders flag to prevent duplicate push** (this is the §B1 fix paying off — even operator error can't create duplicates)
- [ ] Respects MAX_LENDERS_PER_POOL cap

### `compactPoolLenders(agentId)`

Owner-only (NOT gated by whileMigrating — useful even post-finalization). Dedups any duplicate entries.

**Auditor checks:**
- [ ] `onlyOwner` modifier present
- [ ] In-place rewrite using `writeIdx` cursor — verify the algorithm correctly preserves the first occurrence of each address
- [ ] All flags reset to false then re-set as the address is encountered for the first time
- [ ] Tail entries are popped via `list.pop()` (zeros the slot)
- [ ] Gas bounded by `MAX_LENDERS_PER_POOL = 50`

### `setMigrationFinalized()`

Owner-only, while migrating. Flips the boolean to true. Irreversible.

**Auditor checks:**
- [ ] `onlyOwner` and `whileMigrating` modifiers present
- [ ] No way to flip back to false (no setter exists)

## Section 3 — Constants

Only one numeric change: `MAX_LENDERS_PER_POOL` 200 → 50.

Justification: matches the Base canonical deployment (which has 50 from the H-04 fix). Tighter cap bounds `_distributeInterest` gas to a known maximum (~50 storage reads + writes per repay).

**Auditor check:** verify the cap doesn't restrict any legitimate use case. The protocol design has at most 1 borrower per pool, with multiple lenders. 50 lenders per pool is reasonable.

## Section 4 — Events

5 new events (additive, no removals):
- `InterestClaimed(agentId, lender, amount)`
- `PoolLendersCompacted(agentId, removed)`
- `MigrationFinalized()`
- `PoolSeeded(agentId, agentAddress)`
- `PositionSeeded(agentId, lender, amount, earnedInterest)`

**Auditor check:** confirm no existing events were removed (they weren't) — indexer compatibility.

## Section 5 — What did NOT change

For reviewer confidence, here's what is byte-for-byte (or semantically) identical to v4:

- `requestLoan` (signature, validation, collateral logic, fee calculation)
- `_disburseLoan` (state transition logic) — only `activeLoanCount[]++` added
- `repayLoan` (interest calculation, CEI ordering) — only `activeLoanCount[]--` added
- `liquidateLoan` (collateral seizure, default reporting) — only `activeLoanCount[]--` added
- `withdrawLiquidity` (no logic change — note: no longer pops poolLenders, but v4 didn't either)
- `_distributeInterest` (lender share calculation, dust handling)
- `calculateInterest` (formula)
- `getAgentPool`, `getActiveAgents`, view helpers
- `pause` / `unpause`
- `withdrawFees`
- `resetPoolAccounting`
- `setPlatformFeeRate`
- `getActiveAgents` (and its intentional revert)
- All structs (AgentPool, LenderPosition, Loan)
- LoanState enum (REQUESTED/ACTIVE/REPAID/DEFAULTED)

This is the bulk of the contract. The diff is surgical.

## Threat model implications

V6 adds two new privileges to the owner:

1. **State seeding during migration** — owner can write arbitrary pool/position state until `setMigrationFinalized()` is called.
2. **`compactPoolLenders` post-finalization** — owner can rewrite any pool's poolLenders array.

In v4, the owner could already: pause/unpause, withdraw accumulated fees, liquidate overdue loans, reset pool accounting, set platform fee rate. The two new powers fit the same trust model — owner is fully trusted.

A malicious owner in V6 could:
- During migration: seed fake balances and drain by withdrawing them via the lender (who would be themselves)
- Post-migration: dedup poolLenders[] in unexpected ways (e.g., remove their own entry — but this just affects future interest distribution, not USDC custody)

Mitigations:
- Owner is `0x800e305A...F72C` (secure wallet). Compromise of this key is the highest-impact failure mode for the protocol regardless of V6.
- `setMigrationFinalized()` is irreversible — narrows the window of seed-power abuse.
- All seed* operations emit events — anomaly detection can flag unexpected activity.

## Coverage of fixes

Cross-reference between fixes and proof:

| Fix | Unit test | Live evidence |
|-----|-----------|---------------|
| §B1 prevention | `V6Migration.test.js: "supply→withdraw→supply does NOT create duplicate"` | `17-v6-live-e2e.json` — re-supply lenderCount stays at 1 |
| §B1 migration dedup | `V6Migration.test.js: "v4 produces a duplicate poolLenders entry; V6 migration dedups it"` | (would test on production once we migrate from a poisoned v4 pool) |
| §S1 decrement | `V6Migration.test.js: "claimInterest decrements availableLiquidity"` + `AgentLiquidityMarketplaceV6_Patch.test.js` | `17-v6-live-e2e.json` — 5.008544 → 5.000000 |
| §S5 O(1) | `V6Migration.test.js: "activeLoanCount tracks state, not array length"` + `AgentLiquidityMarketplaceV6_Patch.test.js` gas test | `18-v6-boundary.json` — gas ratio 0.914× |
| Migration finalization | `V6Migration.test.js: "seed* functions revert after setMigrationFinalized"` | (no live test yet — pre-finalization) |
| compactPoolLenders | `V6Migration.test.js: "compactPoolLenders heals a malformed seed"` | (no live test yet — V6 has no duplicates) |

Open coverage gaps (auditor should consider whether to flag):
- No fuzz test for `seedPosition` with arbitrary values (could be added; manually verified)
- No formal verification of the §B1 invariant (unique addresses in `poolLenders[]` ↔ `isInPoolLenders[lender] = true`)
- No reentrancy fuzz test (relying on `nonReentrant` modifier presence)
