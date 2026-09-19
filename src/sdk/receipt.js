/**
 * Specular SDK — resilient receipt fetching.
 *
 * ethers v6's `tx.wait()` throws when the JSON-RPC `eth_getTransactionReceipt`
 * call fails — even when the transaction itself has already mined. On free
 * public RPC endpoints (notably DRPC's free tier) we observed `408 Request
 * Timeout` and intermittent `500 Internal Server Error` responses to receipt
 * polls, producing a "false failure" signature where the caller sees an
 * exception even though the tx is on-chain with status=1.
 *
 * `waitForReceiptResilient` polls `provider.getTransactionReceipt(hash)`
 * directly with bounded retries + linear backoff. It distinguishes:
 *   - true failure (receipt found, status=0)
 *   - true success (receipt found, status=1)
 *   - inclusion timeout (no receipt after N attempts) — caller decides what
 *     to do
 *   - persistent RPC failure (every poll threw) — surfaced as a thrown error
 *     so the caller can't silently treat it as success
 *
 * Use this anywhere you'd otherwise call `tx.wait()` against an unreliable
 * RPC endpoint. For private/paid endpoints, `tx.wait()` is fine.
 */

/**
 * Default retry budget. 30 attempts × 2s ≈ 60 seconds — long enough to ride
 * out a typical free-tier hiccup, short enough that genuinely-stuck txs
 * don't hang the caller forever.
 */
const DEFAULT_MAX_ATTEMPTS = 30;
const DEFAULT_DELAY_MS = 2000;

/**
 * Wait for a transaction receipt with retry on RPC errors.
 *
 * @param {object} provider     ethers provider
 * @param {string} hash         tx hash
 * @param {object} [opts]
 * @param {number} [opts.maxAttempts]   default 30
 * @param {number} [opts.delayMs]       default 2000
 * @param {number} [opts.confirmations] number of block confirmations to wait
 *                                       for (default 1 — i.e. just included)
 * @returns {Promise<{receipt: object, attempts: number, rpcErrors: number}>}
 *          On success, `receipt.status` is 0 or 1.
 * @throws  if no receipt observed after `maxAttempts` and at least one poll
 *          succeeded (i.e. tx genuinely not mined).
 * @throws  if every single poll threw (caller can't distinguish success).
 */
async function waitForReceiptResilient(provider, hash, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;
  const confirmations = opts.confirmations ?? 1;

  let rpcErrors = 0;
  let lastRpcErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const receipt = await provider.getTransactionReceipt(hash);
      if (receipt) {
        if (confirmations > 1) {
          const head = await provider.getBlockNumber();
          if (head - receipt.blockNumber + 1 < confirmations) {
            await sleep(delayMs);
            continue;
          }
        }
        return { receipt, attempts: attempt, rpcErrors };
      }
      // null = not yet mined; keep polling
    } catch (e) {
      rpcErrors++;
      lastRpcErr = e;
      // fall through to backoff
    }
    if (attempt < maxAttempts) await sleep(delayMs);
  }

  // Exhausted budget. Decide between "not mined" vs "RPC was broken".
  if (rpcErrors === maxAttempts) {
    const err = new Error(
      `waitForReceiptResilient: every poll for ${hash.slice(0, 12)}… threw ` +
      `(${maxAttempts} attempts). Last error: ${lastRpcErr?.shortMessage || lastRpcErr?.message || 'unknown'}`
    );
    err.cause = lastRpcErr;
    err.code = 'RPC_UNAVAILABLE';
    throw err;
  }
  const err = new Error(
    `waitForReceiptResilient: no receipt for ${hash.slice(0, 12)}… after ` +
    `${maxAttempts} attempts (${rpcErrors} RPC errors). Tx may not have been mined.`
  );
  err.code = 'RECEIPT_TIMEOUT';
  throw err;
}

/**
 * Convenience wrapper: send the tx, then wait resiliently.
 * Returns the same shape as waitForReceiptResilient with `tx` attached.
 */
async function sendAndWaitResilient(txPromise, provider, opts = {}) {
  const tx = await txPromise;
  const result = await waitForReceiptResilient(provider, tx.hash, opts);
  return { tx, ...result };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_DELAY_MS,
  waitForReceiptResilient,
  sendAndWaitResilient,
};
