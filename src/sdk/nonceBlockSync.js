/**
 * Specular SDK — event-driven nonce sync.
 *
 * Companion to `nonce.js`. Where `getNonceAtLeast` polls
 * `wallet.getNonce('pending')` on a fixed cadence, this module subscribes
 * to `provider.on('block', ...)` and re-checks once per new head, with a
 * hard wall-clock ceiling.
 *
 * Why: on Base mainnet (and other rollups with a separate sequencer +
 * indexer), pending-nonce visibility lags the actual mempool by hundreds
 * of milliseconds to a few seconds. Polling every 500ms wastes RPC calls
 * and can still time out at 5s. Subscribing to blocks is more efficient
 * and aligns the wait window with the actual chain progression.
 *
 * Usage:
 *
 *   const { syncNonceOnBlock } = require('./nonceBlockSync');
 *
 *   // Replace `await nc.sync()` with:
 *   await syncNonceOnBlock(nc, provider, { ceilingMs: 30_000 });
 *
 * Or use the standalone helper:
 *
 *   const n = await waitForNonceOnBlock(wallet, provider, minExpected, {
 *     ceilingMs: 30_000,
 *   });
 *
 * No transactions are sent; this is read-only RPC traffic.
 */

/**
 * Wait until `wallet.getNonce('pending')` is at least `minExpected`,
 * driven by the provider's `block` event rather than a fixed-rate poll.
 *
 * @param {ethers.Wallet}   wallet
 * @param {ethers.Provider} provider
 * @param {number}          minExpected
 * @param {object}          [opts]
 * @param {number}          [opts.ceilingMs=30000]  hard wall-clock timeout
 * @param {boolean}         [opts.checkImmediately=true]  read once before
 *                                                        subscribing
 * @returns {Promise<number>}  the observed pending nonce
 */
async function waitForNonceOnBlock(wallet, provider, minExpected, opts = {}) {
  if (!wallet || typeof wallet.getNonce !== 'function') {
    throw new Error('waitForNonceOnBlock requires an ethers v6 wallet');
  }
  if (!provider || typeof provider.on !== 'function') {
    throw new Error('waitForNonceOnBlock requires an ethers v6 provider');
  }

  const ceilingMs = opts.ceilingMs ?? 30_000;
  const checkImmediately = opts.checkImmediately !== false;

  if (minExpected === undefined || minExpected === null) {
    return wallet.getNonce('pending');
  }

  if (checkImmediately) {
    const n0 = await wallet.getNonce('pending');
    if (n0 >= minExpected) return n0;
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const startedAt = Date.now();

    const cleanup = () => {
      try { provider.off('block', onBlock); } catch { /* ignore */ }
      if (timer) clearTimeout(timer);
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(
        `waitForNonceOnBlock: pending nonce did not reach ${minExpected} ` +
        `within ${ceilingMs}ms. Possible RPC indexer lag.`
      ));
    }, ceilingMs);

    const onBlock = async () => {
      if (settled) return;
      try {
        const n = await wallet.getNonce('pending');
        if (n >= minExpected) {
          settled = true;
          cleanup();
          resolve(n);
        }
      } catch (err) {
        // transient RPC error — keep waiting; the next block tick will retry
      }
    };

    provider.on('block', onBlock);

    // Belt-and-braces: also tick at half the ceiling in case the provider
    // misses block events.
    const fallbackTimer = setTimeout(() => {
      if (settled) return;
      onBlock();
    }, Math.max(2_000, Math.floor(ceilingMs / 2)));

    // Make sure fallbackTimer is cleared on settle
    const _origCleanup = cleanup;
    // overwrite local cleanup to also clear fallback
    // (we cannot reassign const, so wrap by adding an additional clear in onBlock/timer paths)
    // Workaround: clear fallbackTimer when block arrives or timer fires.
    const wrappedReject = reject;
    const wrappedResolve = resolve;
    void wrappedReject; void wrappedResolve; void _origCleanup;
    // Monkey-patched final clear:
    const monkey = setInterval(() => {
      if (settled) {
        clearTimeout(fallbackTimer);
        clearInterval(monkey);
      }
    }, 100);
  });
}

/**
 * NonceCounter-compatible drop-in for `nc.sync()`. Re-anchors the local
 * cursor to chain pending view, waiting (block-driven) until at least
 * the locally-issued count is visible.
 *
 * @param {NonceCounter}    nc       a `nonce.js` NonceCounter instance
 * @param {ethers.Provider} provider
 * @param {object}          [opts]   forwarded to waitForNonceOnBlock
 * @returns {Promise<number>}
 */
async function syncNonceOnBlock(nc, provider, opts) {
  if (!nc || typeof nc.peek !== 'function') {
    throw new Error('syncNonceOnBlock requires a NonceCounter from nonce.js');
  }
  const local = nc.peek();
  if (local === null) {
    // never primed — just init from pending
    nc.n = await nc.wallet.getNonce('pending');
    return nc.n;
  }
  const observed = await waitForNonceOnBlock(nc.wallet, provider, local, opts);
  nc.n = observed;
  return observed;
}

module.exports = {
  waitForNonceOnBlock,
  syncNonceOnBlock,
};
