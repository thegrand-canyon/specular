# Base Mainnet V6 Deploy Prep

Pre-flight checklist + audit gate + execution plan for deploying `AgentLiquidityMarketplaceV6` to Base mainnet.

## TL;DR

| Item | Status |
|------|--------|
| V6 deployed to Arc Testnet | ✅ `0xCeF77E14dB17aE0272510ddbDa97075e7Eb6EbF3` |
| V6 fixes verified live on Arc (B1/S1/S5) | ✅ tx hashes in `17-v6-live-e2e.json` |
| 287 hardhat tests + 8 V6Migration tests | ✅ all pass |
| Boundary tests live (gas, MAX_ACTIVE_LOANS) | ✅ `18-v6-boundary.json` |
| Invariant monitor running | ✅ launchd job, every 30 min |
| Deploy script ready | ✅ `scripts/deploy-v6-base-mainnet.js` (dry-run verified) |
| Base ETH for deploy | ✅ 0.0103 ETH = $31 (need ~$0.05 actual) |
| **External audit** | ❌ **gate** — required before broadcast |
| Stuck loans liquidated | ❌ available 2026-05-11 19:10 UTC |
| User communication plan | ❌ template ready in V6_MIGRATION_RUNBOOK.md |

## Cost estimate

From dry-run on Base (2026-05-07, gas at 0.006 gwei):
- Deployment: 2,621,974 gas × 0.006 gwei = **0.0000157 ETH ≈ $0.05**
- `authorizePool`: ~50k gas ≈ $0.001
- Total: well under $0.10 at current gas prices.

The secure wallet has 0.0103 ETH (~$31) — sufficient for hundreds of deployments. No additional bridging needed.

## Pre-deploy gates (must clear in order)

### Gate 1 — External audit ❌ REQUIRED

V6 has not been independently audited. Before deploying to Base mainnet:

**Static analysis:**
- [ ] Slither: `slither contracts/core/AgentLiquidityMarketplaceV6.sol` — no high/medium findings
- [ ] Mythril or similar — no critical findings
- [ ] Diff review against v4: focus on the 3 surgical changes plus migration helpers

**Manual review by external auditor:**
- [ ] §B1 fix: `isInPoolLenders` flag gates `poolLenders.push()`. Verify no path bypasses the flag.
- [ ] §S1 fix: `claimInterest` decrements `availableLiquidity`. Verify no path drains without decrement.
- [ ] §S5 fix: `activeLoanCount` increments in `_disburseLoan`, decrements in `repayLoan` + `liquidateLoan`. Verify exact accounting (no double-increments, no missed decrements).
- [ ] Migration helpers: `seedPool` / `seedPosition` / `compactPoolLenders` / `setMigrationFinalized`. Verify owner-only, irreversibility, no state inconsistency post-finalization.
- [ ] Storage layout (intentionally NOT compatible with v4 — this is correct, but reviewer should confirm)
- [ ] Reentrancy: all external functions retain `nonReentrant`. Verify no new external calls without modifier.
- [ ] Unchanged from v4: liquidateLoan, calculateInterest, withdrawFees — verify these match v4 byte-for-byte after canonicalization.

**Functional regression:**
- [x] All 287 hardhat tests pass on V6
- [x] V6Migration test suite passes (8/8)
- [x] V6_Patch reference test suite passes (7/7) — kept as a separate self-contained illustration
- [x] Live E2E on Arc Testnet shows fixes working

**Suggested auditors / approaches:**
- Trail of Bits, OpenZeppelin, Spearbit (commercial)
- Code4rena / Cantina (competitive)
- Internal: another senior Solidity reviewer with smart-contract security focus

### Gate 2 — Stuck loans recovered ❌ AT 2026-05-11 19:10 UTC

Base has 3 stuck loans (#2, #3, #4) on v4 that revert with §B1 panic. These must be liquidated before V6 migration:
- They occupy `agentLoans[]` and skew counters
- Their collateral (~3855 base units = $0.004) is locked

Liquidation script is ready: `forensics/scripts/base_liquidate_2026_05_11.js`. Cron scheduled for 2026-05-11 12:23 PDT.

### Gate 3 — User communication ❌ DRAFT

Single user on Base today (the secure wallet itself — agent #1 with 1.5 USDC supplied), but production migration needs:
- [ ] Discord / X announcement
- [ ] Email to known users (if any)
- [ ] Frontend banner with migration deadline
- [ ] Documentation update on specular.financial

Template in `V6_MIGRATION_RUNBOOK.md`.

## Deploy sequence (post-audit)

```bash
# 0. Confirm V6 still passes all tests
cd ~/Specular
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
npx hardhat test  # 287 passing

# 1. Final dry-run on Base
BASE_RPC_URL=https://base.publicnode.com \
  npx hardhat run scripts/deploy-v6-base-mainnet.js --network base
# verify: chainId 8453, deployer = secure wallet, ≥0.005 ETH balance

# 2. Broadcast (irreversible)
DEPLOY_CONFIRM=I_HAVE_AUDITED_V6 \
BASE_RPC_URL=https://base.publicnode.com \
  npx hardhat run scripts/deploy-v6-base-mainnet.js --network base
# capture deployed address

# 3. Verify on Basescan
npx hardhat verify --network base <V6_ADDRESS> \
  0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa \
  0xf19b1780A84668C8dfB6b4E84C08e457dB3B0527 \
  0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913

# 4. Smoke-test
node -e "..."  # read paused(), owner(), MAX_LENDERS_PER_POOL etc.
```

## Post-deploy verification

- [ ] `paused()` returns `false`
- [ ] `owner()` returns `0x800e305A...F72C` (secure wallet)
- [ ] `migrationFinalized()` returns `false`
- [ ] `MAX_LENDERS_PER_POOL` returns `50`
- [ ] `MAX_ACTIVE_LOANS_PER_AGENT` returns `10`
- [ ] `MIN_LOAN_DURATION` returns `604800` (7 days in seconds)
- [ ] `MAX_LOAN_DURATION` returns `31536000` (365 days in seconds)
- [ ] `agentRegistry()` returns Base AgentRegistryV2 address
- [ ] `reputationManager()` returns Base ReputationManagerV3 address
- [ ] `usdcToken()` returns Base USDC address (`0x8335...02913`)
- [ ] `totalPools()` returns `0`
- [ ] Verified on Basescan
- [ ] Authorized with ReputationManagerV3 (verify `authorizedPools(V6) == true`)

## Migration step (post-deploy)

For Base, only one lender (the secure wallet, agent #1, 1.5 USDC supplied):

```bash
# 1. Snapshot v4 state (already captured in baseline JSONs)
# 2. v4: secure wallet calls withdrawLiquidity (after stuck-loan liquidation, since the duplicate
#    poolLenders entries no longer matter — withdraw doesn't trigger §B1 panic, only repay does)
# 3. V6: owner seeds the pool: seedPool(1, ownerAddr, 0, 0, 0)  (empty start)
# 4. v4: secure wallet's USDC arrives, then approves V6, supplyLiquidity to V6
# 5. V6: call setMigrationFinalized()
# 6. Update src/config/base-addresses.json — swap agentLiquidityMarketplace v4→V6
# 7. Update frontend/js/config.js, frontend/abis/AgentLiquidityMarketplace.json
# 8. Redeploy Railway + Vercel
```

Total Base ETH cost for migration: <$1.

## Rollback plan

V6 deployment is non-destructive. v4 keeps running with its bugs. To rollback:
1. Revert config files to point at v4
2. Lenders withdraw from V6 (their funds were just moved in)
3. Lenders re-supply to v4 if they want
4. V6 stays deployed on chain but unused

Irreversibility threshold: `setMigrationFinalized()`. After this, seed* functions are locked. Don't call until V6 has soaked for ≥7 days post-migration with the invariant monitor reporting clean.

## Soak monitor

Already installed on local machine (launchd job `com.specular.v6-invariants`, fires every 30 min, asserts §B1/§S1/§S5 invariants on Arc V6). After Base V6 deploy, extend the monitor to Base by adding Base provider config to `forensics/monitor/v6-invariants.js`.

## Open risks

1. **Frontend isn't talking to v4 in production yet** — local repo has been fixed, but production Vercel deploy still has the v3 stale address. Push + redeploy needed to materialize the fix users see.
2. **API server `/tx/*` endpoints just landed** — production Railway hasn't picked them up yet. SDK consumers calling these endpoints continue to get 404 until next Railway deploy.
3. **Compromised wallet `0x6560...8BCFcE2` is still the owner of v5 marketplace** — that contract is unauthorized so it can't be used, but it's a loose end. Either transfer v5 ownership to secure wallet (low priority since v5 won't be used) or just leave it.
4. **Arc agent #43 at 777 lifetime loans** — even after V6 migration, the on-chain agentLoans array is still in v4. Doesn't affect V6 since V6 is fresh. But v4 will keep getting more expensive to interact with for that agent.

## Decision log

- **Why a fresh contract instead of upgrade**: existing contract is non-proxy (uses standard Ownable, not `OwnableUpgradeable`). No proxy pattern. Upgrade path doesn't exist.
- **Why MAX_LENDERS=50 not 200**: matches Base canonical (which has 50 from H-04 fix). Bounds the gas of `_distributeInterest` to a known maximum. 200 was tested but is needlessly high for a P2P agent pool.
- **Why a "compactPoolLenders" admin even with the new `isInPoolLenders` flag**: defensive — if migration accidentally pushes duplicates via the seed helpers (e.g., operator error), this gives an in-place repair tool.
- **Why `setMigrationFinalized()` is irreversible**: prevents an attacker who somehow gains owner access from re-enabling seed functions to inject arbitrary state. The flag flip is one-way by design.

## Files referenced

- Contract: `contracts/core/AgentLiquidityMarketplaceV6.sol`
- Tests: `test/unit/V6Migration.test.js`, `test/unit/AgentLiquidityMarketplaceV6_Patch.test.js`
- Deploy: `scripts/deploy-v6-base-mainnet.js`, `scripts/deploy-v6-arc-testnet.js`
- Migration runbook: `forensics/output/regression-2026-05-07/V6_MIGRATION_RUNBOOK.md`
- Liquidation runbook: `forensics/output/regression-2026-05-07/LIQUIDATION_RUNBOOK_2026-05-11.md`
- Live monitor: `forensics/monitor/v6-invariants.js` + `install-v6-monitor.sh`
- API tx-builder: `src/api/MultiNetworkAPI.js` (POST /tx/*) + `test/api/tx-builder.test.js`
