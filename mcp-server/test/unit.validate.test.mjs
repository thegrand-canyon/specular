// Unit tests: address / amount / duration / network validation. No RPC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';
import {
  validateAddress,
  validateAmountUsdc,
  validateDurationDays,
  validateId,
  validateTxHash,
  validateHexData,
  validateShortString,
  ValidationError,
} from '../dist/validate.js';
import { getNetwork, enabledNetworks, NetworkError } from '../dist/networks.js';
import { redact } from '../dist/logger.js';

const GOOD = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';

// The arc-staging marketplace is redeployed from time to time (V6 -> V6.1 on 2026-09-19).
// Read the expected address from the same repo JSON the server resolves, so the test checks
// the resolution path rather than a constant that goes stale on every staging redeploy.
const here = path.dirname(fileURLToPath(import.meta.url));
const STAGING_CFG = JSON.parse(
  fs.readFileSync(path.resolve(here, '..', '..', 'src', 'config', 'arc-testnet-v6-addresses.json'), 'utf8'),
);
const STAGING_MARKETPLACE = STAGING_CFG.agentLiquidityMarketplace_v6;

test('addresses: checksum enforced, lowercase accepted, junk rejected', () => {
  assert.equal(validateAddress(GOOD), GOOD);
  assert.equal(validateAddress(GOOD.toLowerCase()), GOOD);
  assert.throws(() => validateAddress(GOOD.replace('A', 'a')), /checksum/);
  assert.throws(() => validateAddress('0x1234'), /20-byte hex/);
  assert.throws(() => validateAddress(GOOD + '00'), /20-byte hex/);
  assert.throws(() => validateAddress(123), ValidationError);
  assert.throws(() => validateAddress('800e305A0caDdE6289dFDFEDF38218f45C06F72C'), /0x-prefixed/);
});

test('amounts: display units -> base units, caps and shape', () => {
  assert.equal(validateAmountUsdc(12.5), 12_500_000n);
  assert.equal(validateAmountUsdc('0.000001'), 1n);
  assert.equal(validateAmountUsdc('100000'), ethers.parseUnits('100000', 6));
  assert.throws(() => validateAmountUsdc('100000.000001'), /per-call cap/);
  assert.throws(() => validateAmountUsdc(0), /must be > 0/);
  assert.equal(validateAmountUsdc(0, 'amount', { allowZero: true }), 0n);
  assert.throws(() => validateAmountUsdc(-1), /positive decimal/);
  assert.throws(() => validateAmountUsdc('1e3'), /positive decimal/);
  assert.throws(() => validateAmountUsdc('1.1234567'), /6 decimal places/);
  assert.throws(() => validateAmountUsdc(NaN), /finite/);
  assert.throws(() => validateAmountUsdc(Infinity), /finite/);
  assert.throws(() => validateAmountUsdc({ toString: () => '5' }), /number or decimal string/);
  assert.throws(() => validateAmountUsdc(60_000, 'amount', { max: 50_000 }), /cap of 50000/);
  process.env.SPECULAR_MAX_AMOUNT_USDC = '10';
  try {
    assert.throws(() => validateAmountUsdc(11), /cap of 10/);
  } finally {
    delete process.env.SPECULAR_MAX_AMOUNT_USDC;
  }
});

test('duration days: 7..365 integer, seconds hint', () => {
  assert.equal(validateDurationDays(7), 7);
  assert.equal(validateDurationDays('365'), 365);
  assert.throws(() => validateDurationDays(6), /below min 7/);
  assert.throws(() => validateDurationDays(366), /exceeds max 365/);
  assert.throws(() => validateDurationDays(604800), /looks like 7 days expressed in seconds/);
  assert.throws(() => validateDurationDays(7.5), /integer/);
  assert.throws(() => validateDurationDays('7d'), /integer/);
});

test('ids, hashes, hex data, strings', () => {
  assert.equal(validateId(3, 'x'), 3);
  assert.equal(validateId('42', 'x'), 42);
  assert.throws(() => validateId(0, 'x'), />= 1/);
  assert.throws(() => validateId(-1, 'x'), /integer/);
  assert.throws(() => validateId(1.5, 'x'), /integer/);
  assert.throws(() => validateId(2 ** 60, 'x'), /integer/);
  assert.equal(validateTxHash('0x' + 'AB'.repeat(32)), '0x' + 'ab'.repeat(32));
  assert.throws(() => validateTxHash('0x1234'), /32-byte/);
  assert.equal(validateHexData('0xABcd'), '0xabcd');
  assert.throws(() => validateHexData('0xabc'), /hex bytes/);
  assert.throws(() => validateHexData('0x' + 'ab'.repeat(9000)), /exceeds/);
  assert.equal(validateShortString('ok', 'f'), 'ok');
  assert.throws(() => validateShortString('a\nb', 'f'), /control/);
  assert.throws(() => validateShortString('x'.repeat(600), 'f'), /at most 512/);
});

test('network selection: explicit required, aliases rejected, config resolved from repo JSON', () => {
  assert.throws(() => getNetwork(undefined), NetworkError);
  assert.throws(() => getNetwork(''), /"network" is required/);
  assert.throws(() => getNetwork('arc'), /Unknown network "arc"/);
  assert.throws(() => getNetwork('mainnet'), /Unknown network/);
  const s = getNetwork('arc-staging');
  assert.equal(s.chainId, 5042002);
  assert.equal(s.addresses.marketplace, ethers.getAddress(STAGING_MARKETPLACE));
  assert.equal(s.realMoney, false);
  assert.equal(getNetwork('base').realMoney, true);
  assert.equal(getNetwork('arc-mainnet').realMoney, true);
  assert.equal(getNetwork('arc-mainnet').chainId, 5042);
  process.env.SPECULAR_ENABLED_NETWORKS = 'arc-staging';
  try {
    assert.deepEqual(enabledNetworks(), ['arc-staging']);
    assert.throws(() => getNetwork('base'), /not enabled/);
    process.env.SPECULAR_ENABLED_NETWORKS = 'arc-staging,bogus';
    assert.throws(() => enabledNetworks(), /unknown network "bogus"/);
  } finally {
    delete process.env.SPECULAR_ENABLED_NETWORKS;
  }
});

test('logger redacts secret-looking fields', () => {
  const out = redact({ privateKey: '0xabc', authorization: 'Bearer x', signedTransaction: '0x02..', nested: { token: 't', fine: 1 }, big: 5n });
  assert.equal(out.privateKey, '[redacted]');
  assert.equal(out.authorization, '[redacted]');
  assert.equal(out.signedTransaction, '[redacted]');
  assert.equal(out.nested.token, '[redacted]');
  assert.equal(out.nested.fine, 1);
  assert.equal(out.big, '5');
});
