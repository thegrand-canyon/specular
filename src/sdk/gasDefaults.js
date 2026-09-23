/**
 * Specular SDK — gas defaults
 *
 * Empirically derived gas limits and pricing helpers. The 6,000,000 default
 * came out of V2 load testing: agents with long loan history (e.g. agent #43
 * on Arc with 200+ loans) consume up to 3.5M gas in `requestLoan` due to
 * O(n) iteration. Default of 6M gives a safety margin without being absurdly
 * high.
 *
 * Use these when broadcasting txs that touch the marketplace's loan path.
 * For pure transfers / approvals, ethers' auto-estimation is fine.
 */

/** Conservative default for any marketplace tx. */
const DEFAULT_GAS_LIMIT = 6_000_000n;

/** For simple ERC20 transfers / approvals. */
const ERC20_GAS_LIMIT = 100_000n;

/** For agent registration. */
const REGISTER_GAS_LIMIT = 500_000n;

/** For createAgentPool. */
const CREATE_POOL_GAS_LIMIT = 300_000n;

/** For supplyLiquidity. */
const SUPPLY_GAS_LIMIT = 300_000n;

/**
 * Minimum gas-price floor for Base mainnet (1 gwei is below the typical
 * tip; this avoids txs sitting forever in the mempool).
 */
const BASE_MIN_GAS_PRICE = 1_000_000_000n; // 1 gwei

/**
 * Build a tx-options object with sensible gas defaults.
 *
 * @param {object} [overrides]  any field here wins over defaults
 * @returns {object}            { gasLimit, ...overrides }
 */
function withDefaultGas(overrides = {}) {
  return {
    gasLimit: DEFAULT_GAS_LIMIT,
    ...overrides,
  };
}

module.exports = {
  DEFAULT_GAS_LIMIT,
  ERC20_GAS_LIMIT,
  REGISTER_GAS_LIMIT,
  CREATE_POOL_GAS_LIMIT,
  SUPPLY_GAS_LIMIT,
  BASE_MIN_GAS_PRICE,
  withDefaultGas,
};
