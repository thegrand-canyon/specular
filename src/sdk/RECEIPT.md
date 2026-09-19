# `receipt.js` — Resilient Receipt Fetching

Public API for [`src/sdk/receipt.js`](./receipt.js). Drop-in replacement for
`tx.wait()` when you're talking to an unreliable RPC endpoint (free-tier DRPC,
public Base RPC under load, etc.).

## Why this exists

ethers v6's `tx.wait()` polls `eth_getTransactionReceipt` and **throws on the
first transport error**, even when the transaction itself has already been
mined and finalized. On free / shared RPC endpoints this produces a
**false-failure** signature:

| What the RPC did                           | What `tx.wait()` does | Tx state on chain |
|--------------------------------------------|------------------------|--------------------|
| `408 Request Timeout` on receipt fetch     | throws                | `status = 1` ✅     |
| `500 Internal Server Error` on poll        | throws                | `status = 1` ✅     |
| Returns receipt with `status = 0`          | returns receipt        | reverted            |
| Returns receipt with `status = 1`          | returns receipt        | success             |

Phase-3 cleanup on Arc Testnet hit this directly: 4 of 10 sequential repays
"failed" with 408 on the receipt fetch, but every one of them landed on-chain
with `status = 1`. The script counted them as failures and tried to retry
(which then collided with the borrower-active-loans cap).

`waitForReceiptResilient` polls the receipt directly with a bounded retry
budget and **distinguishes the four outcomes** so the caller can react
correctly.

## Outcomes

```text
                              ┌─ receipt.status === 1 ──→  success
                              │
poll provider.getTxReceipt ───┼─ receipt.status === 0 ──→  reverted on chain
                              │                            (returned, not thrown)
                              │
                              ├─ no receipt after N polls,
                              │  at least one poll succeeded ──→  RECEIPT_TIMEOUT
                              │                                   (probably not mined)
                              │
                              └─ every poll threw ─────────→  RPC_UNAVAILABLE
                                                              (cannot infer state)
```

The two error codes are deliberately different:

- **`RECEIPT_TIMEOUT`** — at least one RPC call returned successfully (just
  with no receipt). The endpoint is healthy; the transaction is most likely
  not mined. Safe to assume "did not happen" and retry the whole
  `sendTransaction`.

- **`RPC_UNAVAILABLE`** — every single poll threw. We have **no information**
  about whether the tx mined. The caller MUST NOT retry blindly: if the tx
  did land, retrying creates a duplicate. Strategy: re-resolve via a different
  RPC, look the hash up later, or surface to operator.

## API

```js
const { waitForReceiptResilient, sendAndWaitResilient } =
  require('./src/sdk/receipt');
```

### `waitForReceiptResilient(provider, hash, opts?) → Promise<{receipt, attempts, rpcErrors}>`

| Param                | Type     | Default | Notes                                        |
|----------------------|----------|---------|----------------------------------------------|
| `provider`           | provider | —       | ethers v6 provider                           |
| `hash`               | string   | —       | tx hash                                      |
| `opts.maxAttempts`   | number   | `30`    | retry budget                                 |
| `opts.delayMs`       | number   | `2000`  | linear backoff between polls                 |
| `opts.confirmations` | number   | `1`     | wait until `head - blockNumber + 1 ≥ N`      |

Defaults give a **60-second budget** (30 × 2 s) — long enough to ride out a
typical free-tier hiccup, short enough that genuinely-stuck txs don't hang the
caller forever.

Returns:

- `receipt` — the ethers receipt object. Caller MUST still check
  `receipt.status === 1` to distinguish success from on-chain revert.
- `attempts` — how many polls were issued before the receipt came back.
  Useful telemetry: `> 5` suggests RPC degradation.
- `rpcErrors` — how many of those polls threw. `0` means a clean inclusion;
  non-zero means the helper hid transport noise.

### `sendAndWaitResilient(txPromise, provider, opts?) → Promise<{tx, receipt, attempts, rpcErrors}>`

Convenience wrapper. Equivalent to:

```js
const tx = await txPromise;
const result = await waitForReceiptResilient(provider, tx.hash, opts);
return { tx, ...result };
```

Use when the call site is short and you don't already have the `tx` reference.

## Usage patterns

### 1. Drop-in replacement for `tx.wait()`

```js
// Before
const tx = await contract.someMethod(...);
const receipt = await tx.wait();
if (receipt.status !== 1) throw new Error('reverted');

// After
const tx = await contract.someMethod(...);
const { receipt } = await waitForReceiptResilient(provider, tx.hash);
if (receipt.status !== 1) throw new Error('reverted');
```

The `if (receipt.status !== 1)` check is **not optional**: the helper
deliberately returns reverted receipts rather than throwing, so the caller
can decide whether to surface the revert or treat it as expected (e.g. when
testing failure paths).

### 2. Distinguishing transport failure from missed inclusion

```js
try {
  const { receipt } = await waitForReceiptResilient(provider, tx.hash);
  // ...
} catch (e) {
  if (e.code === 'RECEIPT_TIMEOUT') {
    // Tx most likely not mined. Safe to recover by resending with the same nonce.
  } else if (e.code === 'RPC_UNAVAILABLE') {
    // We don't know the outcome. Park the hash and reconcile later.
    pendingReconciliation.push(tx.hash);
  } else {
    throw e;
  }
}
```

### 3. Tightening the budget for fast-fail paths

```js
// Stress-test: don't wait the full 60 s on each tx in a tight loop.
const { receipt } = await waitForReceiptResilient(provider, tx.hash, {
  maxAttempts: 10,
  delayMs: 1000,
});
```

### 4. Higher confirmation count for big-money operations

```js
const { receipt } = await waitForReceiptResilient(provider, tx.hash, {
  confirmations: 3,
});
```

Note: confirmation polling currently issues one extra `eth_blockNumber` call
per attempt once the receipt is found. For most use cases (`confirmations: 1`)
that's a no-op.

## Where it's wired in this repo

| Site                                      | Path                                       |
|-------------------------------------------|--------------------------------------------|
| Stress test (Test 1 + Test 2)             | `stress-test.js` lines ~210, ~296          |
| Core SDK (register / requestLoan / repay) | `src/sdk/SpecularSDK.js`                   |
| Build-reputation script                   | `src/agents/build-reputation.js`           |

`AutonomousAgent` and other SDK consumers inherit the resilience transitively
through `SpecularSDK` — no per-caller wiring needed.

## What this helper deliberately does NOT do

- **Re-broadcast the transaction.** If the tx is genuinely missing from the
  mempool (RECEIPT_TIMEOUT after a healthy poll), this helper surfaces that
  to the caller. It does not silently resend, because resending requires
  nonce coordination that lives in `nonce.js`.
- **Switch RPC endpoints.** A multi-endpoint failover layer would be a
  separate module wrapping this one.
- **Distinguish 408 from 500 from network unreachable.** All transport-level
  failures are bucketed as "RPC error" and contribute to `rpcErrors`. The
  underlying error is preserved on `err.cause` for debugging.

## Trade-offs

- **Linear backoff, not exponential.** A tx that's going to land usually lands
  within 1–3 polls. Exponential backoff would push the tail latency for the
  rare slow case into territory where the caller is better off failing.
- **Fixed budget regardless of mempool state.** A more sophisticated version
  would inspect `eth_getTransactionByHash` to see if the tx is still pending
  vs dropped, and adjust. Not worth it for the call volumes here.
- **30 attempts is generous for healthy RPCs.** On a paid endpoint where
  every poll succeeds, the helper is functionally equivalent to `tx.wait()`
  with a slightly higher poll cadence. The extra cost is one extra
  `eth_getTransactionReceipt` per second until inclusion.

## Related modules

- [`nonce.js`](./nonce.js) — `NonceCounter` for serializing concurrent sends.
  Pair with `waitForReceiptResilient` when you're issuing many txs from the
  same wallet.
- [`gasDefaults.js`](./gasDefaults.js) — sane gas limits per network.
- [`duration.js`](./duration.js) — `assertDurationDays` for `requestLoan`.
- [`walletPersist.js`](./walletPersist.js) — wallet save/load helpers.
