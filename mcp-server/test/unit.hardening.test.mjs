// Regression tests from the 2026-09-20 hosted-server security review. No RPC,
// nothing broadcast: signed transactions are built offline with a throwaway key.
//
//  H-1 broadcast validator must reject NON-CANONICAL calldata (an allow-listed
//      selector followed by trailing bytes was relayed and mined on arc-staging).
//  H-2 getNetwork() must not throw a raw TypeError on a non-string network.
//  H-3 publicNetworkInfo() must not expose credentials embedded in an
//      operator-configured RPC URL (SPECULAR_RPC_* with an API key).
//  H-4 get_available_liquidity must validate minAvailableUsdc/limit up front
//      (7-decimal / exponent values reached ethers.parseUnits and surfaced as a
//      502 carrying ethers internals; limit=1.5 was silently accepted).
process.env.SPECULAR_RPC_ARC_MAINNET = 'https://apiuser:apipass@rpc.example.test/v1/SECRET-PATH-KEY?apikey=SECRET-QUERY-KEY';
// hermetic: H-3 asserts the PUBLIC DEFAULT arc-staging RPC is shown verbatim, so an ambient override must not leak in.
delete process.env.SPECULAR_RPC_ARC_STAGING;

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { validateSignedTx } from '../dist/broadcast.js';
import { getNetwork, IFACE, NetworkError, publicNetworkInfo } from '../dist/networks.js';
import { correctedCanTopUp } from '../dist/reads.js';
import { callTool } from '../dist/tools.js';
import { cleanErrorText, ValidationError } from '../dist/validate.js';

const wallet = ethers.Wallet.createRandom();
const cfg = getNetwork('arc-staging');
const sign = (over) =>
  wallet.signTransaction({ chainId: cfg.chainId, nonce: 0, gasLimit: 200_000n, maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n, value: 0n, type: 2, ...over });

test('H-1: calldata must be the canonical ABI encoding (no trailing bytes, no padding tricks)', async () => {
  const good = IFACE.marketplace.encodeFunctionData('requestLoan', [1_000_000n, 7n]);
  assert.equal(validateSignedTx(cfg, await sign({ to: cfg.addresses.marketplace, data: good })).functionName, 'requestLoan');

  const trailing = await sign({ to: cfg.addresses.marketplace, data: good + 'ff' });
  assert.throws(() => validateSignedTx(cfg, trailing), /canonical|does not decode/);

  const trailingWord = await sign({ to: cfg.addresses.marketplace, data: good + '00'.repeat(32) });
  assert.throws(() => validateSignedTx(cfg, trailingWord), /canonical|does not decode/);

  const approve = IFACE.usdc.encodeFunctionData('approve', [cfg.addresses.marketplace, 5_000_000n]);
  const approveTrailing = await sign({ to: cfg.addresses.usdc, data: approve + 'deadbeef' });
  assert.throws(() => validateSignedTx(cfg, approveTrailing), /canonical|does not decode/);

  const register = IFACE.registry.encodeFunctionData('register', ['ipfs://x', []]);
  const registerOk = await sign({ to: cfg.addresses.registry, data: register });
  assert.equal(validateSignedTx(cfg, registerOk).functionName, 'register');
  const registerTrailing = await sign({ to: cfg.addresses.registry, data: register + '01' });
  assert.throws(() => validateSignedTx(cfg, registerTrailing), /canonical|does not decode/);
});

test('H-2: non-string network values produce a NetworkError, not a TypeError', () => {
  for (const bad of [{ toString: 'x' }, Object.create(null), [], 5042002, true, Symbol('n')]) {
    assert.throws(() => getNetwork(bad), (e) => e instanceof NetworkError && /Unknown network/.test(e.message) && !/Cannot convert/.test(e.message));
  }
});

test('H-3: operator RPC URL credentials are never exposed to clients', () => {
  const info = publicNetworkInfo(getNetwork('arc-mainnet'));
  assert.doesNotMatch(JSON.stringify(info), /SECRET|apipass|apiuser|apikey/);
  assert.match(info.rpcUrl, /^https:\/\/rpc\.example\.test\/?$/);
  // the public default stays fully visible (nothing secret in it)
  assert.equal(publicNetworkInfo(getNetwork('arc-staging')).rpcUrl, 'https://arc-testnet.drpc.org');
});

test('H-4: get_available_liquidity validates query values before any RPC', async () => {
  for (const args of [
    { network: 'arc-staging', minAvailableUsdc: '0.1234567' },
    { network: 'arc-staging', minAvailableUsdc: 1e-7 },
    { network: 'arc-staging', minAvailableUsdc: '1e3' },
    { network: 'arc-staging', minAvailableUsdc: -1 },
    { network: 'arc-staging', limit: 1.5 },
    { network: 'arc-staging', limit: '2.0' },
    { network: 'arc-staging', limit: 0 },
    { network: 'arc-staging', limit: 201 },
  ]) {
    await assert.rejects(callTool('get_available_liquidity', args), (e) => e instanceof ValidationError, JSON.stringify(args));
  }
});

//  H-11 (2026-09-21) client-facing errors must not echo ethers' parenthetical detail
//       block (code=/version=/buffer=) or any upstream RPC host.
test('H-11: broadcast decode errors carry no library internals or upstream host', () => {
  for (const raw of ['0xdeadbeef', '0x' + 'c9'.padEnd(20, '0'), '0xabcdef0123456789']) {
    let msg = '';
    try {
      validateSignedTx(cfg, raw);
    } catch (e) {
      msg = e.message;
      assert.ok(e instanceof ValidationError, `${raw}: ${e.constructor.name}`);
    }
    assert.ok(msg, `${raw} must be rejected`);
    assert.doesNotMatch(msg, /version=|code=[A-Z_]{4,}|buffer=|operation=|argument=/, msg);
    assert.doesNotMatch(msg, /https?:\/\//, msg);
  }
});

test('H-11: cleanErrorText strips ethers detail blocks, URLs and hosts', () => {
  assert.equal(
    cleanErrorText(new Error('data short segment too short (buffer=0xdeadbeef, length=4, offset=31, code=BUFFER_OVERRUN, version=6.16.0)')),
    'data short segment too short',
  );
  assert.equal(
    cleanErrorText(new Error('too many decimals for format (operation="fromString", fault="underflow", value="0.1", code=NUMERIC_FAULT, version=6.16.0)')),
    'too many decimals for format',
  );
  const net = cleanErrorText(new Error('connect ECONNREFUSED 10.1.2.3:8545'));
  assert.doesNotMatch(net, /10\.1\.2\.3|8545/, net);
  const url = cleanErrorText(new Error('failed to fetch https://user:pass@rpc.example.test/KEY?apikey=SECRET'));
  assert.doesNotMatch(url, /SECRET|rpc\.example\.test|pass/, url);
});

//  H-15 (2026-09-21, from the contracts track) the DEPLOYED canTopUp() view on Arc
//       mainnet (0x358c5E69) and Arc staging (0xB2d88bbF) uses a half-open upper bound
//       and can answer true for a top-up that supplyLiquidity then reverts. The server
//       must mirror the corrected (inclusive) predicate and answer conservatively.
test('H-15: correctedCanTopUp mirrors the FIXED predicate, not the deployed off-by-one view', () => {
  const base = { positionAmount: 100n, depositTimestamp: 1000n, pendingAmount: 20n, pendingTimestamp: 2000n };

  // short circuits: no position / no active loans / no pending tranche -> always allowed
  assert.equal(correctedCanTopUp({ ...base, positionAmount: 0n, activeLoanStartTimes: [2500n] }), true);
  assert.equal(correctedCanTopUp({ ...base, activeLoanStartTimes: [] }), true);
  assert.equal(correctedCanTopUp({ ...base, pendingAmount: 0n, activeLoanStartTimes: [2500n] }), true);

  // (c) fold: nothing active started inside [deposit, pending) -> allowed
  assert.equal(correctedCanTopUp({ ...base, activeLoanStartTimes: [2500n] }), true);

  // (d) merge: an active loan in [deposit, pending) AND none at/after pending -> allowed
  assert.equal(correctedCanTopUp({ ...base, activeLoanStartTimes: [1500n] }), true);

  // refused: an active loan started after the pending stamp
  assert.equal(correctedCanTopUp({ ...base, activeLoanStartTimes: [1500n, 2500n] }), false);

  // THE BUG: a loan that started exactly "now" (the block the deployed view reads).
  // Deployed view: [pending, now) excludes it -> true. Corrected: the supply tx lands
  // LATER, so its window includes it -> false. The server must say false.
  const now = 3000n;
  assert.equal(correctedCanTopUp({ ...base, activeLoanStartTimes: [1500n, now] }), false);
  // and exactly at the pending stamp (inclusive lower bound) is refused too
  assert.equal(correctedCanTopUp({ ...base, activeLoanStartTimes: [1500n, 2000n] }), false);
});
