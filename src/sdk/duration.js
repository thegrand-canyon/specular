/**
 * Loan duration validation helpers.
 *
 * The deployed AgentLiquidityMarketplace contracts (on Arc Testnet, Base
 * canonical, and Base V3) all expect `requestLoan(amount, durationDays)`
 * with `durationDays` in the inclusive range [7, 365]. The contract
 * multiplies the input by `1 days` internally and reverts with the
 * uninformative message "Invalid duration" for out-of-range values.
 *
 * The most common mistake is to pass duration in seconds (e.g. 7 * 86400 =
 * 604800), which the contract silently rejects with the same opaque error.
 * `assertDurationDays` fails fast off-chain with a clear, actionable message.
 */

const DURATION_DAYS_MIN = 7;
const DURATION_DAYS_MAX = 365;
const SECONDS_PER_DAY = 86400;

/**
 * Validate a `durationDays` argument intended for `requestLoan`.
 *
 * @param {number|bigint} value  the duration the caller wants to pass
 * @param {string} [ctx]         label for the error message (defaults to 'requestLoan')
 * @returns {number}             the validated value as a Number
 * @throws {RangeError}          when value is non-integer or outside [7, 365]
 */
function assertDurationDays(value, ctx = 'requestLoan') {
  if (typeof value === 'bigint') value = Number(value);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RangeError(`${ctx}: durationDays must be an integer, got ${value}`);
  }
  if (value > DURATION_DAYS_MAX) {
    const hint = value % SECONDS_PER_DAY === 0
      ? ` (looks like ${value / SECONDS_PER_DAY} days expressed in seconds — pass days instead)`
      : '';
    throw new RangeError(
      `${ctx}: durationDays=${value} exceeds max ${DURATION_DAYS_MAX}${hint}`
    );
  }
  if (value < DURATION_DAYS_MIN) {
    throw new RangeError(
      `${ctx}: durationDays=${value} is below min ${DURATION_DAYS_MIN}`
    );
  }
  return value;
}

module.exports = {
  DURATION_DAYS_MIN,
  DURATION_DAYS_MAX,
  SECONDS_PER_DAY,
  assertDurationDays,
};
