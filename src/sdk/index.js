/**
 * Specular SDK — entry point.
 *
 * Re-exports the V2 utility modules built out of cross-network load testing.
 * The pre-existing SpecularSDK class is kept untouched and also re-exported.
 */

const nonce = require('./nonce');
const gas = require('./gasDefaults');
const walletPersist = require('./walletPersist');
const duration = require('./duration');
const receipt = require('./receipt');

module.exports = {
  // V2 utilities
  ...nonce,
  ...gas,
  ...walletPersist,
  ...duration,
  ...receipt,
};
