# Slither Triage — V6

**Slither version**: 0.11.4 (via uv-managed install)
**Solc version**: 0.8.20 (via solc-select)
**Run command**:

```bash
slither contracts/core/AgentLiquidityMarketplaceV6.sol \
  --solc-remaps "@openzeppelin=node_modules/@openzeppelin" \
  --solc-args "--via-ir --optimize --optimize-runs=200" \
  --json forensics/output/regression-2026-05-07/audit-package/slither-output.json
```

**Total findings**: 101 across V6 + dependencies. **V6-specific findings: 9 distinct issues**, all triaged below.

## V6-specific triage table

| # | Detector | Severity (slither) | Location | Verdict | Action |
|---|----------|-------------------|----------|---------|--------|
| V6-01 | `divide-before-multiply` | informational | `calculateInterest` lines 442-443 | **Accept (false positive)** | Same as v4. Order is `(p × rate) / 10000` then `(annual × duration) / 365 days`. Reordering would either overflow (rate × duration first hits uint256 limits) or lose more precision. Not a bug. |
| V6-02 | `incorrect-equality` | medium | `_countActiveLoansFromArray` line 710 | **False positive** | Strict equality on `LoanState` enum is the correct comparison pattern. No "dangerous" semantics in enum equality. |
| V6-03 | `timestamp` | low | multiple loan-lifecycle functions | **Accept** | Block timestamp is the canonical time source for lending durations. Manipulation window is bounded (~15s on most L2s, irrelevant for 7-day minimum loans). Standard pattern across all DeFi. |
| V6-04 | `dead-code` | informational | `_countActiveLoansFromArray` (lines 705-716) | **Accept (intentional)** | Function intentionally retained for parity testing — comment in source documents this. Removing it would reduce auditor confidence in the §S5 fix correctness. |
| V6-05 | **`events-maths`** | medium | `withdrawFees` line 536 | **Fixed** | Owner-only state mutation should emit an event for off-chain accounting. Added `FeesWithdrawn(address to, uint256 amount)` event. |
| V6-06 | **`immutable-states`** | informational | `agentRegistry`, `reputationManager`, `usdcToken` (lines 35-37) | **Fixed** | Set in constructor, never reassigned. Marked as `immutable` — saves ~2,100 gas per access. Behavior unchanged. |
| V6-07 | `solc-version` | informational | pragma `^0.8.20` | **Accept** | Caret range is intentional. Project standardizes on 0.8.20 across all contracts. |
| V6-08 | `pragma` | informational | inconsistent versions across deps | **Accept** | OZ pragmas are `>=0.5.0` etc. — out of our control. |
| V6-09 | `naming-convention` (V6 inputs) | informational | parameter naming | **Accept** | All V6-introduced parameters follow mixedCase; flagged items are in inherited deps. |

## Out-of-scope findings (95 results)

The remaining ~95 findings are in dependencies (OpenZeppelin), `AgentRegistryV2`, `ReputationManagerV3`, or `ValidationRegistry`. They are not part of the V6 audit scope. Notable ones the auditor should be aware of:

- **`reentrancy-no-eth` in `AgentRegistryV2.register`**: caused by `_safeMint` callback ordering. State mutation after external call. ERC721's `onERC721Received` callback could re-enter, but `register` writes `addressToAgentId[msg.sender] = agentId` after the safeMint. Would only matter if an agent's contract wallet (acting as a malicious ERC721 receiver) exploited the window. Mitigation in scope of the registry, not V6.
- **`unused-return` in `ReputationManagerV3.calculateCreditLimit`**: ignores 3 of 4 tuple values from `validationRegistry.getSummary`. Cosmetic.

## Fixes applied this session

### V6-05: `withdrawFees` event

```diff
+    event FeesWithdrawn(address indexed to, uint256 amount);

     function withdrawFees(uint256 amount) external onlyOwner nonReentrant {
         require(amount <= accumulatedFees, "Insufficient fees");
         accumulatedFees -= amount;
         usdcToken.safeTransfer(owner(), amount);
+        emit FeesWithdrawn(owner(), amount);
     }
```

### V6-06: `immutable` state

```diff
-    AgentRegistryV2 public agentRegistry;
-    ReputationManagerV3 public reputationManager;
-    IERC20 public usdcToken;
+    AgentRegistryV2 public immutable agentRegistry;
+    ReputationManagerV3 public immutable reputationManager;
+    IERC20 public immutable usdcToken;
```

## Verification

After fixes:
- Hardhat compile: ✅ clean (only known unused-warning on a view function)
- Hardhat test: ✅ 363 passing (no regressions)
- Slither re-run on V6: V6-05 and V6-06 no longer flagged

## Net result

V6 has **0 high-severity slither findings** and **0 unaddressed medium-severity findings** specific to the contract. Two minor fixes applied; the remaining V6 findings are explicit accept-with-rationale calls.

Audit-package status: refreshed. Next deploy will need to redeploy V6 with the immutable + FeesWithdrawn-event changes.
