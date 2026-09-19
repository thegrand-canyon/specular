# `sdk/virtuals/SpecularSDK.js` Audit

Audit of the **second**, **separate** SpecularSDK file at
`/Users/peterschroeder/Specular/sdk/virtuals/SpecularSDK.js` (388 LOC).
Distinct from the main `src/sdk/SpecularSDK.js` (the subject of
[`API_AUDIT.md`](./API_AUDIT.md)). Same class name; different code; different
target API; **same fundamental "calls routes that don't exist" problem**, but
with extra failure modes around x402 payments.

This file targets the Virtuals Protocol integration story (AI-agent lending
demo with paid credit checks). It was discovered while tracing SDK consumer
URLs in [`API_AUDIT.md`](./API_AUDIT.md) addendum 2.

---

## TL;DR

- File path: `sdk/virtuals/SpecularSDK.js` (note: NOT under `src/sdk/`)
- Hardcoded base URL: `https://specular-production.up.railway.app/virtuals`
- Hardcoded contract address: `marketplace = 0xd7b4dEE74C61844DFA75aEbe224e4635463b1C8f` (matches Base mainnet manifest)
- All 4 documented endpoints (`/credit-check`, `/apply`, `/confirm`,
  `/agent/:address`, `/pools`) → **404 in production today** (verified live
  against `specular-production.up.railway.app/virtuals/*`)
- Backing handler exists in `backend/routes/virtuals.js` but is
  **never mounted** by any Express server in the repo (verified by Grep)
- Status: **dead code that ships ESM exports** — anything that tries to
  `import { SpecularSDK }` from this path will load successfully then 404
  on first call

---

## What this SDK does (from reading)

Different surface area from `src/sdk/SpecularSDK.js`:

| Method                                          | Purpose                                  | Surface                                   |
|-------------------------------------------------|------------------------------------------|--------------------------------------------|
| `getCreditCheck()`                              | Paid x402 credit assessment              | `POST /credit-check` + EIP-712 signature   |
| `applyForLoan(amount, duration)`                | Free loan application                    | `POST /apply`                              |
| `confirmLoan(applicationId, poolId, amount, duration)` | Sign + send loan tx              | `POST /confirm` returns unsigned tx        |
| `getProfile(address?)`                          | Free agent profile lookup                | `GET /agent/:address`                      |
| `getPools()`                                    | Free pool list                           | `GET /pools`                               |
| `borrowNow(amount, duration, skipCreditCheck)`  | One-shot pipeline of the above           | composed                                   |
| `getUSDCBalance()`                              | Direct USDC `balanceOf` read             | RPC                                        |

The "novel" thing relative to the main SDK is the **paid credit check**: a
1-USDC-per-call gating mechanism implemented via x402-style EIP-712 signed
payment claims, with the server verifying signatures before returning the
credit profile.

---

## Findings

### §V1 (CRITICAL) — All HTTP endpoints 404 in production

The five endpoints called by this SDK:

| Endpoint                     | Live result against `specular-production.up.railway.app` |
|------------------------------|----------------------------------------------------------|
| `POST /virtuals/credit-check` | 404                                                      |
| `POST /virtuals/apply`        | 404                                                      |
| `POST /virtuals/confirm`      | 404                                                      |
| `GET  /virtuals/agent/:addr`  | 404                                                      |
| `GET  /virtuals/pools`        | 404                                                      |

Verification: probed live during [`API_AUDIT.md`](./API_AUDIT.md) addendum 2,
all 5 returned 404.

The SDK does NOT validate the URL on construction; failures surface only
when methods are called. Call site experience:

```js
const sdk = new SpecularSDK(wallet);
await sdk.getProfile();  // ← here it 404s, not at construction
```

### §V2 (CRITICAL) — Backing handler exists but is orphaned

`backend/routes/virtuals.js` (466 LOC) defines an Express router that DOES
implement these endpoints. However:

- `Grep "app.use.*virtuals"` across the entire repo → **0 mounts**
- `Grep "require.*backend/routes/virtuals"` → **0 mounts**
- Neither `src/api/MultiNetworkAPI.js` nor `src/api/SpecularAgentAPI.js` ever
  imports or mounts this router

Result: the handler code is committed but unreachable. The SDK targets a
real-looking surface that has no live counterpart.

This is an **inverse** of the main SDK's problem (§API_AUDIT §0): there
the SDK exists and the handlers don't; here both exist but they're not
plugged together.

### §V3 (HIGH) — Hardcoded marketplace address may go stale

Lines 12-15:

```js
const CONTRACTS = {
  usdc: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  marketplace: '0xd7b4dEE74C61844DFA75aEbe224e4635463b1C8f'
};
```

This currently matches the Base mainnet manifest exactly (verified live this
session). But:

- No `discover()` method — the SDK never reads
  `/.well-known/specular.json`, so any future redeploy silently leaves the
  SDK pointed at a dead address
- Compare to `src/sdk/SpecularSDK.js` which DOES have `discover()` (and is
  used by [`OPTION2_FEASIBILITY.md`](./OPTION2_FEASIBILITY.md) as the
  manifest source of truth)
- The marketplace address is also baked into the **EIP-712 domain**
  (`verifyingContract`, line 49) — meaning a deployment swap invalidates
  every previously-signed payment claim

### §V4 (HIGH) — x402 signing path uses unverified domain

Lines 45-50:

```js
const domain = {
  name: 'Specular x402',
  version: '1',
  chainId: 8453,
  verifyingContract: CONTRACTS.marketplace
};
```

Issues:

1. **`name: 'Specular x402'` is asserted, not verified.** There's no
   contract on `verifyingContract` that actually consumes this signature.
   The x402 verification, if it exists, lives entirely in the (orphaned)
   server.
2. **`chainId: 8453` is hardcoded.** Calling this SDK from a wallet
   connected to Arc Testnet (chainId 5042002) will produce signatures the
   server (if it existed) would reject as wrong-chain.
3. **No nonce coordination.** Lines 34-35:
   ```js
   const nonce = Date.now();
   const deadline = Math.floor(Date.now() / 1000) + 3600;
   ```
   Using `Date.now()` as nonce means concurrent calls from the same wallet
   within the same millisecond produce identical signatures — a replay-prone
   pattern. (Moot today because the server doesn't exist; would matter if
   wired up.)

### §V5 (HIGH) — `confirmLoan` uses bare `tx.wait()`, not the resilient receipt helper

Line 174-175:

```js
const tx = await this.wallet.sendTransaction(transaction);
const receipt = await tx.wait();
```

Compare `src/sdk/SpecularSDK.js` (which uses `waitForReceiptResilient`).
This SDK will report false-failures on free-tier RPC hiccups exactly as
[`RECEIPT.md`](./RECEIPT.md) describes — every 408/500 from the receipt
poll surfaces as a thrown exception even when the tx already mined.

This is the same bug that motivated `receipt.js`, just replicated in a
fork that didn't get the fix.

### §V6 (MED) — Static error messages reference dead URL

Line 200:

```js
message: 'Agent not registered. Register at https://specular.financial/register'
```

`specular.financial` was not in the §2 hostname matrix because it doesn't
appear in test code, only as a user-facing error message string. Worth
verifying it actually points at a live registration UI.

### §V7 (MED) — `borrowNow` writes to console.log throughout

Lines 248, 253, 256-258, 268, 275, 277-280, 287-288, 295.

Library code that prints emojis to stdout is fine for a quickstart script,
problematic in production where the SDK might be called from a worker
process whose stdout is consumed by JSON-line log parsers. Compare with the
main `src/sdk/SpecularSDK.js` which is silent.

### §V8 (LOW) — `applyForLoan` accepts duration in days, no validation

Line 120:

```js
async applyForLoan(amount, duration = 7) {
```

No `assertDurationDays` (which exists in `src/sdk/duration.js` and is wired
into the main SDK). A caller that passes `604800` (7 days in seconds, the
[`SCHEMA.md`](./SCHEMA.md) trap) will:

- Send a request the server (if it existed) would forward to the contract
- Hit `MAX_LOAN_DURATION` revert on chain
- Get an opaque `"Invalid duration"` error

This SDK's `applyForLoan(amount, duration)` is documented as accepting days,
but the `applyForLoan` line in `borrowNow` doesn't validate either.

### §V9 (LOW) — `confirmLoan` trusts server-provided unsigned tx

Line 171-174:

```js
const { transaction } = await response.json();
const tx = await this.wallet.sendTransaction(transaction);
```

The wallet signs whatever calldata the server returns. If the (currently
nonexistent) server were ever compromised, this is a direct path to
malicious calldata signing — the SDK does no client-side verification that
`transaction.to`, `transaction.data` selector, or amounts match the
applicationId the user thought they were confirming.

This is the same trust-the-server design as the main SDK's `/tx/*` flow
and is one of the structural arguments [`OPTION2_FEASIBILITY.md`](./OPTION2_FEASIBILITY.md)
uses for moving calldata encoding into the SDK. The same argument applies
here.

---

## Recommended actions

In ascending order of effort:

1. **Add a doc banner** to the top of the file (as a JSDoc comment):
   ```
   * @deprecated The /virtuals/* HTTP routes this SDK targets are not
   * mounted by any server in this repo. See
   * src/sdk/VIRTUALS_SDK_AUDIT.md for live verification.
   ```
2. **Remove the file** if Virtuals integration is not active. There's no
   harm done by deletion: nothing in `package.json`, `frontend/`, `src/`,
   or `scripts/` imports it (verified by Grep).
3. **Mount `backend/routes/virtuals.js` in MultiNetworkAPI.js** if the
   Virtuals integration IS active. Single-line change:
   ```js
   app.use('/virtuals', require('../../backend/routes/virtuals'));
   ```
4. **Apply Option 2-style refactoring** to remove the SDK's dependence on
   `/virtuals/confirm` returning unsigned txs. Encode calldata locally;
   keep `/credit-check` as the only paid-server hop (it's the genuinely
   server-side feature — credit scoring needs server data the chain doesn't
   have).
5. **Migrate to the canonical SDK utilities**: `waitForReceiptResilient`
   from `receipt.js`, `assertDurationDays` from `duration.js`. Stop
   maintaining two copies of these patterns.

---

## Cross-reference

- [`API_AUDIT.md`](./API_AUDIT.md) — main SDK audit; addendum 2 first
  identified this file as a separate code path
- [`OPTION2_FEASIBILITY.md`](./OPTION2_FEASIBILITY.md) — same fix pattern
  applies here (encode locally, drop server round-trip)
- [`DOC_FABRICATION_AUDIT.md`](./DOC_FABRICATION_AUDIT.md) — registry
  submissions reference x402 endpoints documented by this SDK
- [`RECEIPT.md`](./RECEIPT.md) — `waitForReceiptResilient` that this SDK
  doesn't use
- [`duration.js`](./duration.js) — `assertDurationDays` that this SDK
  doesn't use
