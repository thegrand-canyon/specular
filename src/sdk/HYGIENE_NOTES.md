# SDK Hygiene Notes — V3 Findings

Recommended changes following the V3 cross-network test on Base mainnet.
None of these are bugs in deployed contracts. They are caller-side
issues that the V3 testing surfaced.

---

## 1. `nonce.js` — bump the retry budget

**Symptom:** V3 concurrent test crashed with
`Nonce did not advance to >= 14 after 10 retries (5000ms)`. The 3
concurrent loans had actually been mined; Base RPC's pending view simply
hadn't caught up within 5 s.

**Fix A — single-line config change.** Bump the defaults:

```diff
--- a/src/sdk/nonce.js
+++ b/src/sdk/nonce.js
@@ -23,8 +23,8 @@
  *   await nc.sync();                          // re-anchor before next batch
  */

-const DEFAULT_RETRIES = 10;
-const DEFAULT_DELAY_MS = 500;
+const DEFAULT_RETRIES = 30;
+const DEFAULT_DELAY_MS = 1000;

 function sleep(ms) {
   return new Promise(r => setTimeout(r, ms));
```

This raises the wait ceiling from 5 s to 30 s — comfortable headroom for
Base's RPC indexer lag without sacrificing fast-path response (the loop
exits the moment `>= minExpected` is observed).

**Fix B — opt-in per call.** No file edit; callers pass overrides:

```js
await nc.sync({ maxRetries: 30, delayMs: 1000 });
```

**Fix C — switch to event-driven sync.** New file
`src/sdk/nonceBlockSync.js` (already shipped in this directory). Replace
calls to `nc.sync()` with:

```js
const { syncNonceOnBlock } = require('./src/sdk/nonceBlockSync');

// ...
await syncNonceOnBlock(nc, provider, { ceilingMs: 30_000 });
```

The event-driven version subscribes to `provider.on('block', …)` and
re-checks once per new head, avoiding the wasted polling traffic and
aligning the wait window with actual chain progression. It still has a
hard 30 s ceiling.

---

## 2. `test-base-fresh-v3.js` — add explicit pre-loan approve

**Symptom:** in `runSequential`, the first 3 `requestLoan` calls
reverted with `"ERC20: transfer amount exceeds allowance"` (gas 295,835
each). Root cause: `ensureLiquidity` consumed the prior 0.03 USDC
allowance via `supplyLiquidity`, leaving allowance = 0 when the loan
batch began. The repay-side `approve` in the cycle body fired only
*after* the loan succeeded, so it never had a chance to help the loan
itself.

**Fix:** approve enough USDC for the entire loan batch (loans + repays)
once, before either run starts. Suggested diff:

```diff
--- a/test-base-fresh-v3.js
+++ b/test-base-fresh-v3.js
@@ -156,6 +156,21 @@ async function ensureLiquidity(mpRO, mpRW, usdcRW, agentId, nc) {
   log('Supply done.');
 }

+/**
+ * Pre-approve enough USDC for the borrower side of every loan + repay
+ * the test will issue. requestLoan does a transferFrom(borrower, ...)
+ * for an upfront fee/interest amount, so allowance must be > 0 before
+ * the first borrow. See src/sdk/BORROWER_ALLOWANCE.md for details.
+ */
+async function approveBorrowerBudget(usdcRW, nc, totalLoanAmount) {
+  const buffer = totalLoanAmount * 4n; // 4× headroom for fees + repays
+  log(`Approving ${ethers.formatUnits(buffer, 6)} USDC for borrower side...`);
+  const tx = await usdcRW.approve(
+    CONTRACTS.marketplace, buffer,
+    { nonce: nc.next(), gasLimit: 100_000n }
+  );
+  await tx.wait();
+  await nc.sync();
+}
+
 async function runSequential(mpRW, usdcRW, nc) {
   log(`\n=== TEST 1: SEQUENTIAL ${CYCLES} cycles ===`);
   const t0 = Date.now();
@@ -345,6 +360,11 @@ async function main() {
   await ensurePool(mpRO, mpRW, agentId, nc);
   await ensureLiquidity(mpRO, mpRW, usdcRW, agentId, nc);

+  // Pre-approve the borrower's USDC for both runs (loans + repays).
+  const oneLoan = ethers.parseUnits(String(LOAN_AMT_USDC), 6);
+  const totalNeeded = oneLoan * BigInt(CYCLES + CONCURRENCY);
+  await approveBorrowerBudget(usdcRW, nc, totalNeeded);
+
   const seq = await runSequential(mpRW, usdcRW, nc);
   const con = await runConcurrent(mpRW, usdcRW, nc);
```

Once that's in place, the per-cycle approve at line 190-194 of
`runSequential` (and the bulk approve at line 239-244 of `runConcurrent`)
become belt-and-braces and can be removed in a follow-up. They are not
harmful, just wasteful.

---

## 3. Borrower upfront-USDC requirement — see `BORROWER_ALLOWANCE.md`

The deployed Base marketplace (`0x2f24Ca82…`) calls
`USDC.transferFrom(borrower, …)` inside `requestLoan` for an upfront
amount (origination fee, first-period interest, or both — exact split is
not in the local source, see Path A bytecode-diff notes). The V3 test's
295,835-gas reverts are this transferFrom failing on a 0 allowance.

Caller pattern for any future test or agent:

```js
// Always approve before borrowing, not just before repaying.
await usdc.approve(MARKETPLACE_ADDR, expectedLoanTotal * SAFETY_BUFFER);
await marketplace.requestLoan(amount, durationDays);
```

Full write-up: `BORROWER_ALLOWANCE.md` in this directory.

---

## Verification

After applying the fixes, expected outcome on Base mainnet:

- Sequential 3 cycles: all 3 loans + 3 repays succeed, no reverts.
- Concurrent 3 burst: still a single block (45266932 was 3-in-1); no
  nonce-sync timeout under the 30 s ceiling.
- Avg loan gas remains in the 380-450k range (fresh-agent profile).

These fixes are additive and reversible. Roll them in incrementally —
nonce retry budget first (smallest blast radius), then test-script
approve, then optionally migrate to `nonceBlockSync`.
