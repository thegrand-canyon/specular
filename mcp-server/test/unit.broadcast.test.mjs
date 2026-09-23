// Unit tests for the signed-transaction relay validator. Transactions are
// signed offline with a throwaway key and NEVER broadcast.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { validateSignedTx } from '../dist/broadcast.js';
import { getNetwork, IFACE } from '../dist/networks.js';

const wallet = ethers.Wallet.createRandom();
const cfg = getNetwork('arc-staging');

async function sign(over) {
  return wallet.signTransaction({
    chainId: cfg.chainId,
    nonce: 0,
    gasLimit: 500_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    value: 0n,
    type: 2,
    ...over,
  });
}

test('accepts requestLoan to the marketplace', async () => {
  const raw = await sign({ to: cfg.addresses.marketplace, data: IFACE.marketplace.encodeFunctionData('requestLoan', [5_000_000n, 7n]) });
  const v = validateSignedTx(cfg, raw);
  assert.equal(v.target, 'marketplace');
  assert.equal(v.functionName, 'requestLoan');
  assert.equal(v.from, wallet.address);
  assert.equal(v.chainId, cfg.chainId);
  assert.match(v.hash, /^0x[0-9a-f]{64}$/);
});

test('accepts register to the registry and every allow-listed marketplace function', async () => {
  const reg = await sign({ to: cfg.addresses.registry, data: IFACE.registry.encodeFunctionData('register', ['ipfs://x', []]) });
  assert.equal(validateSignedTx(cfg, reg).functionName, 'register');
  const calls = [
    ['createAgentPool', []],
    ['supplyLiquidity', [1n, 1_000_000n]],
    ['withdrawLiquidity', [1n, 1n]],
    ['repayLoan', [1n]],
    ['claimInterest', [1n]],
  ];
  for (const [fn, args] of calls) {
    const raw = await sign({ to: cfg.addresses.marketplace, data: IFACE.marketplace.encodeFunctionData(fn, args) });
    assert.equal(validateSignedTx(cfg, raw).functionName, fn);
  }
});

test('rejects tx to an unknown address', async () => {
  const raw = await sign({ to: ethers.Wallet.createRandom().address, data: IFACE.marketplace.encodeFunctionData('requestLoan', [1n, 7n]) });
  assert.throws(() => validateSignedTx(cfg, raw), /not a Specular contract/);
});

test('rejects admin / non-allow-listed functions even on the marketplace', async () => {
  const pause = await sign({ to: cfg.addresses.marketplace, data: IFACE.marketplace.encodeFunctionData('pause', []) });
  assert.throws(() => validateSignedTx(cfg, pause), /not relayable/);
  const fees = await sign({ to: cfg.addresses.marketplace, data: IFACE.marketplace.encodeFunctionData('withdrawFees', [1n]) });
  assert.throws(() => validateSignedTx(cfg, fees), /not relayable/);
  const xfer = await sign({ to: cfg.addresses.registry, data: IFACE.registry.encodeFunctionData('transferFrom', [wallet.address, wallet.address, 1n]) });
  assert.throws(() => validateSignedTx(cfg, xfer), /not relayable/);
});

test('USDC: exact approve to the marketplace is accepted; unlimited, over-cap and foreign spender rejected', async () => {
  const ok = await sign({ to: cfg.addresses.usdc, data: IFACE.usdc.encodeFunctionData('approve', [cfg.addresses.marketplace, 5_000_000n]) });
  const v = validateSignedTx(cfg, ok);
  assert.equal(v.target, 'usdc');
  assert.equal(v.args.amountUsdc, '5.0');

  const unlimited = await sign({ to: cfg.addresses.usdc, data: IFACE.usdc.encodeFunctionData('approve', [cfg.addresses.marketplace, ethers.MaxUint256]) });
  assert.throws(() => validateSignedTx(cfg, unlimited), /unlimited/);

  const overCap = await sign({ to: cfg.addresses.usdc, data: IFACE.usdc.encodeFunctionData('approve', [cfg.addresses.marketplace, ethers.parseUnits('100001', 6)]) });
  assert.throws(() => validateSignedTx(cfg, overCap), /exceeds the exact-approval cap/);

  const foreign = await sign({ to: cfg.addresses.usdc, data: IFACE.usdc.encodeFunctionData('approve', [wallet.address, 1n]) });
  assert.throws(() => validateSignedTx(cfg, foreign), /not the Specular marketplace/);

  const transfer = await sign({ to: cfg.addresses.usdc, data: new ethers.Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', [wallet.address, 1n]) });
  assert.throws(() => validateSignedTx(cfg, transfer), /does not decode/);
});

test('rejects wrong chainId, non-zero value, unsigned and malformed input', async () => {
  const data = IFACE.marketplace.encodeFunctionData('claimInterest', [1n]);
  const wrongChain = await sign({ to: cfg.addresses.marketplace, data, chainId: 8453 });
  assert.throws(() => validateSignedTx(cfg, wrongChain), /chainId 8453 does not match arc-staging/);

  const withValue = await sign({ to: cfg.addresses.marketplace, data, value: 1n });
  assert.throws(() => validateSignedTx(cfg, withValue), /value 0/);

  const unsigned = ethers.Transaction.from({ chainId: cfg.chainId, to: cfg.addresses.marketplace, data, nonce: 0, gasLimit: 1n, type: 2, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }).unsignedSerialized;
  assert.throws(() => validateSignedTx(cfg, unsigned), /not signed/);

  assert.throws(() => validateSignedTx(cfg, '0x1234'), /could not be decoded/);
  assert.throws(() => validateSignedTx(cfg, 'nothex'), /must be 0x-prefixed hex/);
  assert.throws(() => validateSignedTx(cfg, 42), /must be 0x-prefixed hex/);
  assert.throws(() => validateSignedTx(cfg, '0x' + 'ff'.repeat(17 * 1024)), /exceeds/);
});

test('the same signed tx validates only against its own network', async () => {
  const base = getNetwork('base');
  const raw = await sign({ to: base.addresses.marketplace, chainId: base.chainId, data: IFACE.marketplace.encodeFunctionData('claimInterest', [1n]) });
  assert.equal(validateSignedTx(base, raw).target, 'marketplace');
  assert.throws(() => validateSignedTx(cfg, raw), /chainId/);
});
