# `src/sdk/` — Specular SDK & Audit Docs

Resilient transaction utilities for talking to the Specular protocol from a
JavaScript agent, plus the audit documents that explain what's actually wired
up versus what's documented to be wired up. Most files in this directory are
**read-only references** for engineers debugging end-to-end flows; a few are
the SDK code itself.

> **Status callout — read first.** The SDK's three transaction methods
> (`register`, `requestLoan`, `repayLoan`) currently POST to `/tx/*` routes on
> an HTTP server that **does not implement them anywhere in this repo, has
> never implemented them in any commit, and is unreachable at the URL the SDK
> defaults to in production agents.** See [`API_AUDIT.md`](./API_AUDIT.md) §0
> for the live evidence and [`OPTION2_FEASIBILITY.md`](./OPTION2_FEASIBILITY.md)
> for the recommended fix (encode calldata locally — net **-10 LOC**).
>
> The non-transaction utilities (`receipt.js`, `nonce.js`, `gasDefaults.js`,
> `duration.js`, `walletPersist.js`) are unaffected and are the load-bearing
> parts of the SDK in actual use.

---

## Security posture (2026-07 audit)

Full findings + fixes: [`../../forensics/output/security-audit-2026-07/SDK_SECURITY_AUDIT_2026-07.md`](../../forensics/output/security-audit-2026-07/SDK_SECURITY_AUDIT_2026-07.md). Every fix has a regression test under [`test/sdk/`](../../test/sdk/). Behavior/config changes callers must know:

| Area | Change | What you must do |
|------|--------|------------------|
| **`SpecularSDK` API calls** | Every API-supplied tx is validated before signing: `to` must be a known Specular/USDC contract (allowlist from in-repo config, **not** the API), USDC calls must be `approve()` to a canonical marketplace, and the API must be `https://` for non-localhost. | Nothing if you use the canonical config. A non-HTTPS remote `apiUrl` now throws. |
| **Approvals** (`SpecularQuickstart`, Python client) | No more `MaxUint256` blanket approval. Each op approves the **exact** amount (collateral / principal+interest / supply) just-in-time. `revokeApproval()` / `revoke_approval()` added. | Nothing — onboarding no longer emits an approve tx; approvals happen per op. |
| **`walletPersist`** (test-only) | Keys stored as **encrypted keystore**, gated behind opt-in. | Set `SPECULAR_ALLOW_KEY_PERSIST=1` **and** `SPECULAR_KEYSTORE_PASSWORD=<≥8 chars>`. Legacy plaintext keyfiles auto-migrate on first load. |
| **x402 client** (`src/x402/x402Client.js`) | Default **10 USDC per-payment cap** (`maxPayment`), optional `maxTotalSpend`, `verifyingContract` pinned to known USDC per network; unknown networks refused. | Raise `maxPayment` for larger payments (or `null` to opt out); set `allowUntrustedToken` only for a deliberately unknown network. |
| **x402 server** (`SpecularX402Server`) | `stub` mode (no payment verification) requires opt-in; `/__specular_x402/stats` is loopback-only or token-gated; 500s return generic bodies. | For stub tests set `allowStub:true` / `SPECULAR_X402_ALLOW_STUB=1`. Optionally set `SPECULAR_X402_STATS_TOKEN` and `SPECULAR_X402_BASE_URL`. |
| **`ContractManager`** | Writes send exactly once (poll receipt on transient RPC failure); only reads retry. | Nothing. |
| **`EventListener`** | Reconnects + backfills on WS drop (deduped); `stop()` removes only its own listeners. | Consumers should still treat events as at-least-once. |

---

## Module index

JavaScript modules in this directory:

| File                                       | Purpose                                                                                  | Reference doc                                  |
|--------------------------------------------|------------------------------------------------------------------------------------------|------------------------------------------------|
| [`SpecularSDK.js`](./SpecularSDK.js)       | Top-level SDK class. Discover + register + requestLoan + repayLoan. Calls `/tx/*` (broken — see `API_AUDIT.md`). | [`API_AUDIT.md`](./API_AUDIT.md), [`OPTION2_FEASIBILITY.md`](./OPTION2_FEASIBILITY.md) |
| [`index.js`](./index.js)                   | Flat re-exports of `nonce`, `gas`, `walletPersist`, `duration`, `receipt` helpers.       | —                                              |
| [`receipt.js`](./receipt.js)               | `waitForReceiptResilient` — survives free-tier RPC 408/500s without false-failures.      | [`RECEIPT.md`](./RECEIPT.md)                   |
| [`nonce.js`](./nonce.js)                   | `NonceCounter` — serializes concurrent sends from one wallet.                            | inline JSDoc                                   |
| [`nonceBlockSync.js`](./nonceBlockSync.js) | Variant of `NonceCounter` that anchors on the latest block.                              | inline JSDoc                                   |
| [`gasDefaults.js`](./gasDefaults.js)       | Per-network gas-limit defaults (Arc Testnet vs Base mainnet differ materially).          | inline JSDoc                                   |
| [`duration.js`](./duration.js)             | `assertDurationDays` — catches the seconds-vs-days footgun on `requestLoan`.             | inline JSDoc                                   |
| [`walletPersist.js`](./walletPersist.js)   | Save/load helpers for ephemeral test wallets.                                            | [`HYGIENE_NOTES.md`](./HYGIENE_NOTES.md)       |
| [`examples/quickstart.js`](./examples/quickstart.js) | Smallest end-to-end agent example.                                              | —                                              |

---

## Docs index

Standalone analysis / reference documents (no code):

| Doc                                              | Scope                                                                                  | Status                                                       |
|--------------------------------------------------|----------------------------------------------------------------------------------------|--------------------------------------------------------------|
| [`SCHEMA.md`](./SCHEMA.md)                       | Canonical on-chain shapes for loans, agents, pools, reputation. What the contracts actually return. | **Reference** — use as the source of truth for field names. |
| [`SCHEMA_VERIFICATION.md`](./SCHEMA_VERIFICATION.md) | Live on-chain probe of Arc + Base contracts confirming `SCHEMA.md` field names/order. Documents gaps for `AgentRegistryV2` + `ReputationManagerV3` (G1-G6 footguns: address-vs-agentId, no `getReputation()` aggregate). | **Live evidence** — covers gaps in SCHEMA.md.                |
| [`CROSS_NETWORK_AUDIT.md`](./CROSS_NETWORK_AUDIT.md) | End-to-end Arc Testnet vs Base Mainnet audit. State probe + production API matrix + live cycle. 12 findings (N1-N12, 2 CRITICAL): Arc on pre-H-04 marketplace, all `?network=arc` API routes 500, reputation contract drift, Base mainnet has 3 agents / 0 loans. | **Live evidence** — includes §N12 successful Arc cycle (loan #2094). |
| [`API_AUDIT.md`](./API_AUDIT.md)                 | Audit of `src/api/MultiNetworkAPI.js`, `SpecularAgentAPI.js`, `backend/routes/virtuals.js`. 8 numbered findings + 3 live-verification addenda + git-history pickaxe. | **Live evidence** — flagged CRITICAL: `/tx/*` routes don't exist, never have. |
| [`VIRTUALS_SDK_AUDIT.md`](./VIRTUALS_SDK_AUDIT.md) | Audit of the **second** SpecularSDK at `sdk/virtuals/SpecularSDK.js` (388 LOC). 9 findings (V1-V9): all 5 `/virtuals/*` endpoints 404, orphaned handler, x402 signing replay-prone, hardcoded chainId. | **Live evidence** — distinct file from `src/sdk/SpecularSDK.js`. |
| [`DRIFT_AUDIT.md`](./DRIFT_AUDIT.md)             | Consumer-side audit. Where in-repo scripts assume schemas that don't match `SCHEMA.md`. | **Active findings** — multiple sites assume nonexistent fields. |
| [`FRONTEND_AUDIT.md`](./FRONTEND_AUDIT.md)       | UI-side audit of `frontend/js/pages/*`. 8 findings (F1-F8). Most flows safely bypass SDK via direct contract calls; `identity.js` hardcodes localhost + dead `/credit/:address` route. | **Active findings** — frontend mostly safe by accident.       |
| [`DOC_FABRICATION_AUDIT.md`](./DOC_FABRICATION_AUDIT.md) | Sweep of repo `*.md` for fictional success claims. 10 findings (2 CRITICAL): `API_TEST_RESULTS.md` claims pass for routes with 0 git matches; 3 conflicting "verified" Base marketplace addresses; 3 dead hostnames in published docs. | **Active findings** — registry submissions reference dead URLs. |
| [`OPTION2_FEASIBILITY.md`](./OPTION2_FEASIBILITY.md) | Validates the proposed fix for `API_AUDIT.md` §0: have the SDK encode calldata locally instead of calling `/tx/*`. | **Recommendation** — ~50 LOC delete-and-replace, net -10 LOC. |
| [`RECEIPT.md`](./RECEIPT.md)                     | Public API + rationale for `receipt.js`. Why `tx.wait()` produces false-failures on shared RPCs. | **Reference** — utility doc.                                 |
| [`BORROWER_ALLOWANCE.md`](./BORROWER_ALLOWANCE.md) | USDC approval semantics for `requestLoan` / `repayLoan`. Catches the silent-failure case where collateral isn't approved. | **Reference**                                                |
| [`HYGIENE_NOTES.md`](./HYGIENE_NOTES.md)         | Operational notes: wallet rotation, key isolation, fund-funder anti-patterns.          | **Reference**                                                |

---

## How the docs cross-reference

```
                               ┌──────────────┐
                               │   SCHEMA.md  │  canonical contract shapes
                               └──────┬───────┘
                                      │ field names verified against
                       ┌──────────────┼──────────────┐
                       ▼              ▼              ▼
              ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
              │ DRIFT_AUDIT  │ │   API_AUDIT  │ │ OPTION2_FEAS │
              │ (consumer    │ │ (server      │ │ (recommended │
              │  drift)      │ │  drift +     │ │  fix)        │
              └──────────────┘ │  /tx/* gap)  │ └──────┬───────┘
                               └──────┬───────┘        │
                                      │                │ replaces fetch with
                                      │                │ Interface.encodeFunctionData
                                      │                ▼
                                      │         ┌──────────────┐
                                      └────────►│SpecularSDK.js│
                                       fix the  │              │
                                       SDK to   └──────┬───────┘
                                       end the         │ uses
                                       round-trip      ▼
                                                ┌──────────────┐
                                                │  receipt.js  │
                                                │  (RECEIPT.md)│
                                                └──────────────┘
```

---

## Reading order for new contributors

1. **[`SCHEMA.md`](./SCHEMA.md)** + **[`SCHEMA_VERIFICATION.md`](./SCHEMA_VERIFICATION.md)** — what
   the contracts actually return, and the live-probe evidence behind it. All
   other docs assume you've internalized this.
2. **[`API_AUDIT.md`](./API_AUDIT.md)** — what the API server actually
   exposes (and doesn't). The §0 finding is the headline issue blocking
   the documented SDK happy-path.
3. **[`DRIFT_AUDIT.md`](./DRIFT_AUDIT.md)** + **[`FRONTEND_AUDIT.md`](./FRONTEND_AUDIT.md)** —
   companion to API_AUDIT on the client side: where scripts and the UI
   assume fields that don't exist.
4. **[`DOC_FABRICATION_AUDIT.md`](./DOC_FABRICATION_AUDIT.md)** + **[`VIRTUALS_SDK_AUDIT.md`](./VIRTUALS_SDK_AUDIT.md)** —
   what's been claimed in the docs/registries vs what's wired up; second
   SpecularSDK file with its own 404 surface.
5. **[`OPTION2_FEASIBILITY.md`](./OPTION2_FEASIBILITY.md)** — the proposed
   fix and why it's small. Read after API_AUDIT §0.
6. **[`RECEIPT.md`](./RECEIPT.md)** — once you understand the data plane,
   this covers the transport-resilience layer that everything else relies on.
7. **[`BORROWER_ALLOWANCE.md`](./BORROWER_ALLOWANCE.md)** and
   **[`HYGIENE_NOTES.md`](./HYGIENE_NOTES.md)** — operational gotchas. Read
   when you actually start sending transactions.

---

## What this README does NOT cover

- **Contract internals.** The on-chain logic (interest model, reputation
  tier transitions, collateral math) lives in `contracts/core/` and isn't
  duplicated here. `SCHEMA.md` describes the public ABI surface only.
- **Agent runtime.** `src/agents/` (AutonomousAgent, build-reputation,
  etc.) are SDK *consumers*, not SDK code. They're referenced from
  `DRIFT_AUDIT.md` where relevant.
- **Frontend.** `frontend/` consumes the same broken `/tx/*` routes
  through the JS SDK; same fix story applies. Tracked separately.
- **Multi-language SDKs.** None exist today. If they're added, see
  `OPTION2_FEASIBILITY.md` "Why prefer Option 2 over Option 1" — the
  trade-off shifts.

---

## Quick start (current state)

```js
const { SpecularSDK } = require('./SpecularSDK');
const { ethers } = require('ethers');

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL, undefined, { batchMaxCount: 1 });
const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const sdk = new SpecularSDK({
  apiUrl: 'http://localhost:3001',  // ← see API_AUDIT.md §0: /tx/* are 404 here
  wallet,
});

await sdk.discover();                                  // ✅ works
await sdk.getAgent(wallet.address);                    // ✅ works (read paths OK)
// await sdk.requestLoan({ amount: 5_000_000n, durationDays: 7 }); // ❌ 404 today
```

For the loan/register/repay path to work today, callers must encode and send
calldata themselves — see `src/agents/build-reputation.js` for the current
workaround pattern (caller does `usdc.approve` + manual receipt handling).

`OPTION2_FEASIBILITY.md` describes the proposed fix that would make the
commented-out line above just work.

---

## Conventions

- All transaction-sending code paths use [`receipt.js`](./receipt.js)
  (`waitForReceiptResilient`) instead of bare `tx.wait()`. New code should
  follow this convention.
- All `requestLoan` callers should run input through
  [`duration.js`](./duration.js) (`assertDurationDays`) to catch the
  seconds-vs-days footgun before the on-chain revert.
- Contract addresses are sourced from the manifest at
  `/.well-known/specular.json` via `SpecularSDK.discover()`. Hard-coding
  addresses anywhere in JS code is a bug — file an issue.
- `SCHEMA.md` field names are the single source of truth. If a script
  reads `loan.repaid` or `loan.state`, it's wrong (those fields don't
  exist in the wire format) — file under DRIFT_AUDIT.

---

## Related (outside this directory)

- `contracts/core/AgentLiquidityMarketplace.sol` — the contract behind `requestLoan` / `repayLoan`.
- `contracts/core/AgentRegistryV2.sol` — the contract behind `register`.
- `src/api/MultiNetworkAPI.js` — the live API server (`npm start`); subject of `API_AUDIT.md`.
- `src/agents/build-reputation.js` — reference consumer that bypasses the broken SDK paths.
