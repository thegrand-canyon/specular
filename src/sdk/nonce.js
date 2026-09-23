/**
 * Specular SDK — nonce management utilities
 *
 * Solves two real problems we hit while load-testing on Base mainnet:
 *
 * 1. ethers v6's default `wallet.getNonce()` reads 'latest', which lags
 *    pending mempool state. Sending bursts with 'latest' produces
 *    REPLACEMENT_UNDERPRICED errors when the same nonce gets reused.
 *
 * 2. Some RPC providers (DRPC, public Base) return stale views even after
 *    a tx is confirmed. A naive read-then-send loop can produce
 *    "nonce too low" because the local cursor advanced past what RPC
 *    has indexed.
 *
 * Pattern:
 *   const nc = new NonceCounter(wallet);
 *   await nc.init();                          // primes from 'pending'
 *   const tx1 = await contract.foo({ nonce: nc.next() });
 *   const tx2 = await contract.bar({ nonce: nc.next() });
 *   await Promise.all([tx1.wait(), tx2.wait()]);
 *   await nc.sync();                          // re-anchor before next batch
 */

// Defaults sized for Base mainnet RPC indexer lag, which can run several
// seconds behind block-tip. The previous 5 s ceiling (10×500ms) timed out
// in the V3 concurrent test even though all txs had landed. 30 s gives
// comfortable headroom; the loop exits the moment `>= minExpected` is
// observed, so the fast path is unaffected.
const DEFAULT_RETRIES = 30;
const DEFAULT_DELAY_MS = 1000;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Poll `wallet.getNonce('pending')` until the chain view advances to
 * at least `minExpected`. Useful when you've broadcast txs and need to
 * confirm RPC has picked them up before computing your next nonce.
 *
 * @param {ethers.Wallet} wallet
 * @param {number} [minExpected]  - if undefined, returns first read
 * @param {object} [opts]
 * @param {number} [opts.maxRetries=10]
 * @param {number} [opts.delayMs=500]
 * @returns {Promise<number>}
 */
async function getNonceAtLeast(wallet, minExpected, opts = {}) {
  const maxRetries = opts.maxRetries ?? DEFAULT_RETRIES;
  const delayMs = opts.delayMs ?? DEFAULT_DELAY_MS;

  for (let i = 0; i < maxRetries; i++) {
    const n = await wallet.getNonce('pending');
    if (minExpected === undefined || n >= minExpected) return n;
    if (i < maxRetries - 1) await sleep(delayMs);
  }
  throw new Error(
    `Nonce did not advance to >= ${minExpected} after ${maxRetries} retries ` +
    `(${maxRetries * delayMs}ms). Possible RPC indexer lag.`
  );
}

/**
 * Stateful nonce cursor. Initialize once, then call .next() per tx.
 * Use .sync() between burst batches to re-align with chain view.
 */
class NonceCounter {
  /**
   * @param {ethers.Wallet} wallet
   */
  constructor(wallet) {
    if (!wallet || typeof wallet.getNonce !== 'function') {
      throw new Error('NonceCounter requires an ethers v6 wallet');
    }
    this.wallet = wallet;
    this.n = null;
  }

  /**
   * Prime the counter from the chain's pending view.
   * @returns {Promise<number>}  the starting nonce
   */
  async init() {
    this.n = await this.wallet.getNonce('pending');
    return this.n;
  }

  /**
   * Allocate the next nonce. Synchronous — does not touch the network.
   * Caller is responsible for actually broadcasting a tx with this nonce.
   * @returns {number}
   */
  next() {
    if (this.n === null) {
      throw new Error('NonceCounter not initialized — call .init() first');
    }
    return this.n++;
  }

  /**
   * Re-anchor the local cursor to the chain's current pending nonce,
   * waiting (via getNonceAtLeast) until the chain has caught up to
   * what we've already issued locally.
   * @param {object} [opts]  forwarded to getNonceAtLeast
   * @returns {Promise<number>}
   */
  async sync(opts) {
    if (this.n === null) return this.init();
    this.n = await getNonceAtLeast(this.wallet, this.n, opts);
    return this.n;
  }

  /** Current cursor without advancing. */
  peek() {
    return this.n;
  }
}

module.exports = {
  NonceCounter,
  getNonceAtLeast,
  sleep, // exported because callers usually need it
};
