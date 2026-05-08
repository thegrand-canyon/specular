# API Server V6 Cutover Audit

## Findings

### `/tx/request-loan` is NOT implemented

The SDK in `src/sdk/SpecularSDK.js:130` calls `POST ${apiUrl}/tx/request-loan`, expecting a server that returns unsigned tx data. **No such route exists in the codebase.**

```bash
$ grep -nE "app\.(get|post)\(" src/api/MultiNetworkAPI.js
# only GET routes — zero POST routes
```

`src/sdk/BACKEND_AUDIT.md` correctly notes "not implemented". `src/sdk/DOC_FABRICATION_AUDIT.md` falsely claims "✅ implemented" — that doc is unreliable.

This means:
- **SDK calls to `requestLoan()` / `repayLoan()` would fail** with 404 today against the live API
- The frontend bypasses the SDK and talks to contracts directly via `frontend/js/contracts.js`
- Direct callers (scripts, agents) have to encode tx data themselves, OR they go through `src/agents/build-reputation.js` which also calls the missing endpoint

### What the API server actually does

`src/api/MultiNetworkAPI.js` — read-only API exposing GET endpoints:

| Route | Purpose |
|-------|---------|
| `/.well-known/specular.json` | service manifest |
| `/health`, `/status` | health checks |
| `/agents/:address`, `/agents`, `/agent/:id` | agent profile reads |
| `/pools`, `/pools/:id` | pool state reads |
| `/agent/:id/loans` | loan history |
| `/networks`, `/network/:network`, `/stats` | network metadata |

All routes resolve marketplace via `network.addresses.agentLiquidityMarketplace` (line 184).

### Implication for V6 cutover

When migration completes and the canonical address rotates from v4 to V6, only **one** change in the API server config is needed:

```diff
 // src/config/arc-testnet-addresses.json
 {
-  "agentLiquidityMarketplace": "0x048363A325A5B188b7FF157d725C5e329f0171D3",
+  "agentLiquidityMarketplace": "0xCeF77E14dB17aE0272510ddbDa97075e7Eb6EbF3",
   "agentLiquidityMarketplace_v4_archive": "0x048363A325A5B188b7FF157d725C5e329f0171D3",
   ...
 }
```

The API server picks this up on restart (Railway deploy). No code changes needed.

The ABI file the API uses is also resolved at load time:
```js
// MultiNetworkAPI.js
const mpAbi = JSON.parse(fs.readFileSync(
    './artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json'
)).abi;
```

V6's ABI is a strict superset of v4's — same selectors for all read methods used by the API. **The API will work against V6 with the v4 ABI** for read-only operations. To use V6-specific admin methods (seedPool, etc.) the API would load V6's ABI explicitly, but that's not a runtime requirement for the read endpoints.

### Implication for SDK consumers

Anyone using `SpecularSDK.requestLoan()` or `SpecularSDK.repayLoan()` is calling a 404 endpoint today. Either:
- They've been failing silently
- They've never run that code path
- They've been encoding txs themselves and bypassing the SDK

The duration validation (`assertDurationDays`) does run before the network call, so the bug-prevention logic from `bubbly-discovering-aurora.md` is intact even when the network call fails.

## Recommendations

### Short-term (independent of V6)

1. **Decide whether to fix or remove** the SDK's tx-builder pattern. If it's needed: implement the POST endpoints. If not: simplify the SDK to encode + send directly via ethers.

### V6 cutover sequence (revised)

1. ✅ Frontend config updated (this session — pointing at v4 canonical, noted as ready for V6 swap)
2. (Migration phase) Lenders self-migrate from v4 to V6
3. Owner: `setMigrationFinalized()` on V6
4. Update `src/config/arc-testnet-addresses.json` — swap `agentLiquidityMarketplace` value v4 → V6, archive v4 under `agentLiquidityMarketplace_v4_archive`
5. Update `frontend/js/config.js` `marketplace` value → V6
6. Update `frontend/abis/AgentLiquidityMarketplace.json` → copy V6 ABI
7. Redeploy API server (Railway), redeploy frontend (Vercel)
8. Smoke-test: API GET endpoints return V6 state; frontend reads V6 pools

Total file edits at cutover: **3 files** (the JSON address file, frontend config, frontend ABI). All other code reads through these abstractions.
