# SDK / Frontend V6 Compatibility Audit

## Headline

The frontend is **already broken** — `frontend/js/config.js` points at `0xD1cf6E7864Bc4CbBE52aA94369dF08B106927559`, which is the deprecated v3 marketplace (`agentLiquidityMarketplace_old` per addresses.json). It's been superseded twice (v3 → v4 → V6). Until this is updated, the frontend is interacting with a stale contract.

This audit identifies the minimum surface needed to migrate the codebase to V6.

## Code surface — direct contract callers

| File | Path | Refs | V6 impact |
|------|------|------|-----------|
| `frontend/js/config.js` | hardcodes addresses | `marketplace`, `registry`, `reputation`, `usdc` | **Update marketplace address to V6**. Other addresses unchanged. |
| `frontend/js/contracts.js` | loads ABIs from `./abis/AgentLiquidityMarketplace.json` | `marketplace()` helper | **Replace ABI** with V6 ABI (same function names + new admin). |
| `frontend/js/pages/borrow.js` | uses `marketplace()` helper | `requestLoan`, `repayLoan`, `loans`, `agentLoans`, `getAgentPool`, `calculateInterest` | **No code changes** — all V6 method signatures match v4. |
| `frontend/js/pages/{supply,pool-detail,portfolio}.js` | uses `marketplace()` helper | various reads | **No code changes** — all read methods match. |
| `src/SpecularAgent.js` | uses ContractManager | `agentRegistry`, `reputationManager`, `lendingPool`, `mockUSDC` | Calls **LendingPool**, not AgentLiquidityMarketplace. This is the local Hardhat dev contract. **Not affected by V6 migration.** |
| `src/SpecularAgentV2.js` | uses ContractManager | `LendingPoolV2` | Same — local dev. **Not affected.** |
| `src/ContractManager.js` | resolves names → addresses | reads `contractAddresses` map | **Optionally add `AgentLiquidityMarketplaceV6` resolution path.** |
| `src/sdk/SpecularSDK.js` | API-gateway pattern (calls `/tx/request-loan`) | calls API for unsigned tx data | **API server determines marketplace** — update there. SDK code unchanged. |
| `src/agents/AutonomousAgent.js`, `LenderAgent.js` | uses ethers.Contract directly with addresses from config | various | **Update config consumption** to read `agentLiquidityMarketplace_v6` key. |

## Required changes (minimal V6 cutover)

### 1. `frontend/js/config.js`
```diff
 export const ADDRESSES = {
-    marketplace: '0xD1cf6E7864Bc4CbBE52aA94369dF08B106927559',  // STALE v3
+    marketplace: '0xCeF77E14dB17aE0272510ddbDa97075e7Eb6EbF3',  // V6
     registry:    '0x741C03c0d95d2c15E479CE1c7E69B3196d86faD7',
     reputation:  '0x94F2fa47c4488202a46dAA9038Ed9C9c4c07467F',
     validationRegistry: '0xD97AeE70866b0feF43A4544475A5De4c061eCcea',
     usdc:        '0xf2807051e292e945751A25616705a9aadfb39895',
 };
```

### 2. Replace `frontend/abis/AgentLiquidityMarketplace.json`
Copy from `artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json` after extracting the `.abi` field. V6 ABI is a strict superset of v4 — all v4 methods exist with identical signatures.

### 3. API server (need to locate)
The SDK uses `${apiUrl}/.well-known/specular.json` and `${apiUrl}/tx/request-loan`. The API server holds the marketplace address. Need to find that server (Railway deployment per CLAUDE.md) and update its config.

Inferred endpoints from `src/sdk/SpecularSDK.js`:
- `/.well-known/specular.json` — returns manifest
- `/status` — returns health
- `/agents/:address` — returns profile
- `/tx/request-loan` — returns unsigned tx data
- `/tx/repay-loan` — returns unsigned tx data

The API needs the V6 marketplace address as the `to` field in tx-builder responses.

### 4. Optional: `src/ContractManager.js`
Add `AgentLiquidityMarketplaceV6` to the ABI loader list (line 31 area). Not strictly required if you replace the v4 ABI with the V6 ABI, but useful for ambient testing where both contracts coexist.

## Method-signature verification

Cross-checked all method calls in callers against V6 ABI. Result: **100% compatible**.

| Caller method | V6 has it? | Same signature? |
|---------------|------------|-----------------|
| `requestLoan(amount, durationDays)` | ✓ | ✓ |
| `repayLoan(loanId)` | ✓ | ✓ |
| `supplyLiquidity(agentId, amount)` | ✓ | ✓ |
| `withdrawLiquidity(agentId, amount)` | ✓ | ✓ |
| `claimInterest(agentId)` | ✓ | ✓ |
| `loans(loanId)` | ✓ | ✓ (same struct, but state enum still {REQUESTED,ACTIVE,REPAID,DEFAULTED}) |
| `agentLoans(addr, idx)` | ✓ | ✓ |
| `getAgentPool(agentId)` | ✓ | ✓ |
| `calculateInterest(p, r, d)` | ✓ | ✓ |
| `createAgentPool()` | ✓ | ✓ |

V6 also has new public state and methods (zero-impact additions):
- `activeLoanCount(addr)` — read counter
- `isInPoolLenders(agentId, addr)` — read flag
- `migrationFinalized()` — read phase
- `seedPool`, `seedPosition`, `compactPoolLenders`, `setMigrationFinalized` — admin-only

## Risk surface

- **Frontend ABI mismatch silently degrades**: ethers.js will succeed for matching methods and fail for missing ones. Since V6 is a superset, this is safe.
- **The duration plan from `bubbly-discovering-aurora.md` is ALREADY IMPLEMENTED** — `src/sdk/duration.js` exists and `src/sdk/SpecularSDK.js:130` calls `assertDurationDays`. Plan complete.
- **Stale address in frontend** — independent of V6 work. The frontend has been pointing at a deprecated contract for some time. May explain user-reported issues.

## Cutover sequence (recommended)

1. Update `frontend/js/config.js` marketplace address → V6
2. Replace `frontend/abis/AgentLiquidityMarketplace.json` content with V6 ABI
3. Smoke-test frontend in browser against Arc V6
4. Update API server config (Railway) to V6 address + V6 ABI
5. Update `src/agents/*.js` config consumption to read `agentLiquidityMarketplace_v6` key (optional — most don't read this directly)
6. After Base V6 deployment: same updates for Base addresses

Estimated effort: **<1 hour of careful editing + smoke-test**, gated by V6 migration completion.

## Anomalies found

- **frontend points at v3 address**, not v4 canonical. Either the frontend has been stale for months, or there's a build/deploy step that overrides this at runtime. Worth investigating independently.
- **`frontend/abis/` directory does not exist** in the local checkout (the `loadAbis()` function fetches from `./abis/...`). Either the ABIs are bundled elsewhere or fetched at runtime from a deployed location. Need to inspect the deployed Vercel build.
- The `LendingPool` contract referenced in `src/SpecularAgent.js` is the **local Hardhat development contract** (per `contracts/core/LendingPool.sol`). It is NOT used in production — production is `AgentLiquidityMarketplace`. Both may need to coexist for local testing.
