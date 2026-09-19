# Option 2 Feasibility — Move Calldata Encoding into the SDK

Companion to [`API_AUDIT.md`](./API_AUDIT.md) §0. Validates the proposed
"Option 2" fix: delete the network round-trip to `/tx/*` routes that
have never existed, and have `SpecularSDK` encode calldata locally using
the existing ABI artifacts.

This is a **read-only feasibility analysis**. No code is changed.

## TL;DR

**Option 2 is trivial.** ~50 LOC delete-and-replace. All inputs already
exist in the SDK's scope. The three transaction methods reduce from
~22 LOC each (fetch + parse + send + wait) to ~6 LOC each (encode +
send + wait). Total: 206 LOC → ~150 LOC, plus removal of the unreachable
network dependency.

## Inputs already available

The SDK already has everything it needs:

| Input                      | Already in SDK?                                               |
|----------------------------|---------------------------------------------------------------|
| ethers v6                  | yes — `require('ethers')` line 11                             |
| `wallet`                   | yes — `this.wallet` (line 18)                                 |
| `provider`                 | yes — `this.provider` (line 19)                               |
| ABI artifacts              | yes — `artifacts/contracts/core/*.sol/*.json`                 |
| Contract addresses         | yes — fetched by `discover()` (line 26-30) into `this.manifest` |
| `waitForReceiptResilient`  | yes — line 13                                                 |
| `assertDurationDays`       | yes — line 12                                                 |

The only addition needed is two `ethers.Interface` instances loaded once
at construct-time from the bundled ABI artifacts.

## Verified ABI signatures

Read from the on-disk artifacts:

```
AgentRegistryV2.register(string agentURI, MetadataEntry[] metadata)        nonpayable
AgentLiquidityMarketplace.requestLoan(uint256 amount, uint256 durationDays) nonpayable
AgentLiquidityMarketplace.repayLoan(uint256 loanId)                         nonpayable
```

Where `MetadataEntry` is `(string key, bytes value)`.

## Manifest shape (verified against production)

`GET https://specular-production.up.railway.app/.well-known/specular.json`
returns (Base mainnet):

```json
{
  "agentRegistryV2":           "0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa",
  "reputationManagerV3":       "0xf19b1780A84668C8dfB6b4E84C08e457dB3B0527",
  "usdc":                      "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "agentLiquidityMarketplace": "0xd7b4dEE74C61844DFA75aEbe224e4635463b1C8f",
  "deployer":                  "0x800e305A0caDdE6289dFDFEDF38218f45C06F72C",
  "deployedAt":                "2026-02-25T00:00:00.000Z",
  "network":                   "base-mainnet",
  "chainId":                   8453
}
```

The two `to` addresses needed (`agentRegistryV2`,
`agentLiquidityMarketplace`) are already in the manifest. `discover()` is
already in the SDK. No new RPC plumbing is required.

## Encoded-calldata proof

Live verification — three encodes, no errors:

```
requestLoan(5 USDC, 7 days):
  to  : 0x048363A325A5B188b7FF157d725C5e329f0171D3 (Arc marketplace)
  data: 0xaa452fa6
        00000000000000000000000000000000000000000000000000000000004c4b40
        0000000000000000000000000000000000000000000000000000000000000007
  size: 68 bytes

repayLoan(2093):
  to  : 0x048363A325A5B188b7FF157d725C5e329f0171D3
  data: 0xab7b1c89
        000000000000000000000000000000000000000000000000000000000000082d
  size: 36 bytes

register("ipfs://placeholder", []):
  to  : <agentRegistryV2 address>
  data: 0x8ea42286 + abi-encoded args
  size: 164 bytes
```

`ethers.Interface(abi).encodeFunctionData(name, args)` is a one-liner.
The currently-fictional `/tx/*` endpoints would, at most, be doing the
same thing on the server side.

## Refactor sketch (illustrative — not implementation)

```js
const { ethers } = require('ethers');
const { assertDurationDays } = require('./duration');
const { waitForReceiptResilient } = require('./receipt');
const REG_ABI = require('../../artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json').abi;
const MP_ABI  = require('../../artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json').abi;
const REG_IFACE = new ethers.Interface(REG_ABI);
const MP_IFACE  = new ethers.Interface(MP_ABI);

class SpecularSDK {
  constructor({ apiUrl, wallet, rpcUrl }) {
    this.apiUrl = apiUrl || 'http://localhost:3001';
    this.wallet = wallet;
    this.provider = wallet ? wallet.provider : (rpcUrl ? new ethers.JsonRpcProvider(rpcUrl) : null);
    this.manifest = null;
  }

  async _ensureManifest() {
    if (!this.manifest) await this.discover();
    return this.manifest;
  }

  async register({ agentURI = '', metadata = [] } = {}) {
    if (!this.wallet) throw new Error('Wallet required for registration');
    const m = await this._ensureManifest();
    const tx = await this.wallet.sendTransaction({
      to: m.contracts.agentRegistry,        // or .agentRegistryV2 — see manifest naming
      data: REG_IFACE.encodeFunctionData('register', [agentURI, metadata]),
    });
    const { receipt } = await waitForReceiptResilient(this.provider, tx.hash);
    if (receipt.status !== 1) throw new Error(`Registration tx ${tx.hash.slice(0,12)} reverted`);
    return receipt;
  }

  async requestLoan({ amount, durationDays }) {
    if (!this.wallet) throw new Error('Wallet required for loan request');
    assertDurationDays(durationDays, 'SpecularSDK.requestLoan');
    const m = await this._ensureManifest();
    const tx = await this.wallet.sendTransaction({
      to: m.contracts.agentLiquidityMarketplace,
      data: MP_IFACE.encodeFunctionData('requestLoan', [BigInt(amount), durationDays]),
    });
    const { receipt } = await waitForReceiptResilient(this.provider, tx.hash);
    if (receipt.status !== 1) throw new Error(`Loan request tx ${tx.hash.slice(0,12)} reverted`);
    return receipt;
  }

  async repayLoan(loanId) {
    if (!this.wallet) throw new Error('Wallet required for loan repayment');
    const m = await this._ensureManifest();
    const tx = await this.wallet.sendTransaction({
      to: m.contracts.agentLiquidityMarketplace,
      data: MP_IFACE.encodeFunctionData('repayLoan', [BigInt(loanId)]),
    });
    const { receipt } = await waitForReceiptResilient(this.provider, tx.hash);
    if (receipt.status !== 1) throw new Error(`Loan repayment tx ${tx.hash.slice(0,12)} reverted`);
    return receipt;
  }
}
```

This is structurally identical to the current code — same `sendTransaction`,
same receipt handling, same error checks, same `assertDurationDays` — with
the `fetch('/tx/*')` round-trip replaced by an `encodeFunctionData` call.

## What this refactor does NOT solve

These remain caller responsibilities, **same as today**:

- **USDC approval before borrow** — `requestLoan` uses collateral; the
  borrower must `usdc.approve(marketplace, collateralAmount)` first. The
  current SDK does not do this either; consumers (e.g.
  `build-reputation.js:80-86`) call `usdc.approve()` directly on the token
  contract. Behavior is unchanged.
- **USDC approval before repay** — same pattern; caller must approve the
  full repay amount. Current SDK doesn't help; new SDK doesn't either.
- **Computing the repay amount** — repay quote currently comes back from
  `/tx/repay-loan` response field `repayAmount`. With Option 2 the caller
  needs to read `marketplace.calculateRepayAmount(loanId)` (or equivalent
  view, name TBD) themselves, OR the SDK can add a small helper that
  reads it.
- **Loan-ID extraction** — current SDK leaves a comment "In production,
  parse events properly. For demo, return receipt." That's broken
  regardless of which option is chosen; calldata encoding doesn't change
  it.

A complete fix would add three small helpers:

```js
async approveUsdcForMarketplace(amount)   // token approval helper
async getRepayAmount(loanId)              // view call wrapper
extractLoanId(receipt)                    // parse LoanRequested event
```

These are bounded scope additions, ~30 LOC total. Out of scope for the
"Option 2" refactor proper — they're independent features the SDK is
missing today regardless of how calldata is encoded.

## Effort estimate

| Task                                                 | LOC delta      |
|------------------------------------------------------|----------------|
| Delete `/tx/register` fetch in `register()`          | -8             |
| Replace with `Interface.encodeFunctionData`          | +3             |
| Same for `requestLoan()`                             | -8 / +3        |
| Same for `repayLoan()`                               | -8 / +3        |
| Add ABI imports + `Interface` instantiation          | +5             |
| Add `_ensureManifest()` helper                       | +4             |
| Adjust `register()` signature to accept agentURI/metadata args (currently silently passes nothing) | +2 |
| **Total**                                            | **~ -10 LOC**  |

Net result: SDK shrinks slightly, gains testability (no network mock
needed for unit tests), drops the single largest reliability risk (a
hard dep on routes that don't exist).

## Why prefer Option 2 over Option 1

| Concern                                  | Option 1 (implement /tx/*) | Option 2 (encode locally) |
|------------------------------------------|-----------------------------|----------------------------|
| LOC to write                             | ~150 (3 handlers + boot)    | ~50 (replace 3 calls)      |
| New runtime dependency                   | Express-server availability | none                       |
| Failure modes                            | RPC down + server down      | RPC down only              |
| Testability                              | needs server fixture        | pure unit test             |
| Multi-language SDK story (Python/Go)     | unblocked — server-encoded  | each SDK encodes itself    |
| Latency                                  | +1 HTTP round-trip per tx   | +0                          |
| Trust model                              | trust the server's encoding | trust your own ABI         |

Option 1 wins on **multi-language SDK story** (a Python or Go agent
without an ABI parser benefits from server-side encoding) and on
**central upgradability** (deploy a new contract → change one server).

Option 2 wins on **everything else**: simpler, faster, locally testable,
no extra failure mode, fewer LOC.

For a JS-only consumer base today, Option 2 is the right call. If a
non-JS SDK ever lands, Option 1 can be added back as a thin
optimisation layer on top of Option 2 (the JS SDK can keep encoding
locally; non-JS SDKs hit the server).

## Risks

1. **ABI / contract drift.** The SDK now ships with a snapshot of the
   ABI. If contracts get redeployed with a different signature, the SDK
   silently produces wrong calldata until republished. Mitigation: pin
   the ABI version, expose it via `manifest.abiHash`, and have the SDK
   check on `discover()`.
2. **Manifest contract-key naming.** The production manifest currently
   uses `agentRegistryV2` and `agentLiquidityMarketplace`. The SDK should
   accept either or both names; the existing SDK does no manifest
   validation at all so this is already a latent issue.
3. **Multiple deployments per network.** If a future deployment runs two
   marketplace contracts side-by-side (e.g. v3 + v4), the SDK needs a
   way to choose. Trivial config option, doesn't block Option 2.

## Validation plan

To convert this read-only analysis into a working refactor, the
sequence would be:

1. Apply the refactor sketch (above) to `src/sdk/SpecularSDK.js`.
2. Run `test/unit/duration.test.js` — should still pass unchanged.
3. Add a unit test that asserts `requestLoan({amount:5, durationDays:7})`
   produces calldata starting with `0xaa452fa6` (the verified function
   selector).
4. Run an end-to-end probe against a fresh wallet on Arc Testnet —
   register, request, repay — bypassing the API entirely.
5. Compare receipt-status across runs to confirm behavior parity with
   the current (broken) flow except that no `/tx/*` HTTP calls are made.

## Related documents

- [`SCHEMA.md`](./SCHEMA.md) — canonical contract shapes used by Option 2.
- [`API_AUDIT.md`](./API_AUDIT.md) — §0 finding that motivates this analysis.
- [`DRIFT_AUDIT.md`](./DRIFT_AUDIT.md) — consumer drift; would be partly
  obviated by an SDK that encodes correctly itself.
- [`RECEIPT.md`](./RECEIPT.md) — `waitForReceiptResilient` is reused unchanged.
