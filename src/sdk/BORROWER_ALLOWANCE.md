# Borrower USDC Allowance — Required Pre-Approval

## Summary

The deployed `AgentLiquidityMarketplace` on Base mainnet
(`0x2f24Ca82Cac2a0034eEA2E128328BAdA94A5E4B6`) and on Arc testnet calls
`USDC.transferFrom(borrower, …)` inside `requestLoan(amount, durationDays)`
for an upfront amount. **The borrower must hold a non-zero USDC
allowance to the marketplace before calling `requestLoan`.** If the
allowance is insufficient, the call reverts with:

```
Error("ERC20: transfer amount exceeds allowance")
```

The revert consumes ~295,835 gas before the require trips, so it is not
cheap to "discover" by retry.

## Evidence

V3 cross-network test on 2026-04-27 against fresh wallet
`0x4D97342a2bCb2c6980e881F6c6E2921737bc3DA3` (Base mainnet). Three
sequential `requestLoan(0.005, 7)` calls reverted at nonces 4/5/6:

```
Nonce | Block    | Selector       | Status | GasUsed
------+----------+----------------+--------+--------
4     | 45266924 | requestLoan    | 0      | 295835
5     | 45266925 | requestLoan    | 0      | 295835
6     | 45266928 | requestLoan    | 0      | 295835
```

`eth_call` replay at the original block returned, identically for all
three:

```
Error("ERC20: transfer amount exceeds allowance")
```

After an explicit `USDC.approve(marketplace, …)` at nonce 7, the next 3
`requestLoan` calls (nonces 8/9/10) succeeded with gas 445k / 381k /
386k.

## Why

The local source artifact's `_countActiveLoans` and `requestLoan` paths
do not exactly match the deployed bytecode (see Path A diff: 2
functional bytes differ at offsets 682 and 1031, both `0xc8 ↔ 0x32`).
The deployed `requestLoan` includes an upfront `transferFrom` call from
the borrower that is documented here based on observed runtime behavior
rather than source. The exact split between origination fee and
pre-paid interest is not knowable from the available source, but the
amount is bounded by the loan principal in practice.

## Recommended caller pattern

```js
const ONE_USDC = 1_000_000n;

// Approve generously before *any* requestLoan in the session.
// 4× the loan principal is a safe buffer (covers fees + repay + room
// for accrued interest on long durations).
const buffer = loanAmount * 4n;
await usdc.approve(marketplaceAddress, buffer);

// Now you can borrow.
const tx = await marketplace.requestLoan(loanAmount, durationDays);
await tx.wait();
```

For a test or agent that issues many loans in sequence, approve the
total expected outflow once at the top of the session rather than per
loan:

```js
const sessionBudget = loanAmount * BigInt(numCycles) * 4n;
await usdc.approve(marketplaceAddress, sessionBudget);
```

ERC-20 `approve` is idempotent — calling it again with a larger value
simply increases the allowance. Calling it with `0` first is unnecessary
for USDC on Base (Circle's USDC does not have the legacy
"non-zero-to-non-zero" restriction).

## Common mistakes

1. **Approving exactly the supply amount, then borrowing.** The
   `supplyLiquidity` call drains the allowance via its own
   `transferFrom`. Subsequent borrows then revert. Either re-approve
   before the loan batch, or approve the full session budget upfront.

2. **Approving the repay amount only after the loan succeeds.** If
   `requestLoan` itself does a `transferFrom`, you cannot rely on a
   post-loan `approve` to "fix" the loan. The allowance must be in
   place *before* the first borrow.

3. **Trusting `static_call` (`provider.call`) to predict success.** A
   static call against a state where the borrower has 0 allowance will
   correctly return the revert reason — but if your code checks
   "static-passes-then-send", the static call against a *projected*
   future state (e.g. after assumed approve mining) does not see the
   real on-chain allowance and may misreport. Always read the actual
   `usdc.allowance(borrower, marketplace)` before sending.

## Cross-reference

- V3 report: `CROSS_NETWORK_V3_REPORT_2026-04-27.md`
- Replay script: `replay-reverts.js`
- Replay output: `/tmp/v3-replay.log`
- Hygiene fixes: `src/sdk/HYGIENE_NOTES.md`
