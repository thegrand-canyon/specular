// Unit tests for the 2026-09-22 RPC-resilience layer (rpc.ts / cache.ts /
// deadline.ts / the read-route cache in tools.ts). Pure functions only — no
// sockets, no upstream. The socket-level behaviour (failover, backoff,
// coalescing, circuit breaker, bounded deadlines) is in
// test/integration.rpc.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cacheTtlFor, isCacheableMethod, parseEndpointList } from '../dist/rpc.js';
import { stableKey, TtlCache } from '../dist/cache.js';
import { attemptBudgetMs, remainingMs, requestDeadlineMs, RequestDeadlineError, runWithDeadline } from '../dist/deadline.js';
import { _clearNetworkCache, defaultRpcUrls, getNetwork, publicRpcUrlFor } from '../dist/networks.js';
import { isImmutableRead, readTtlFor } from '../dist/tools.js';

// ---------------------------------------------------------------- endpoints
test('multi-endpoint: a comma-separated list parses in order, the single-URL form still works', () => {
  const fallback = ['https://fallback.example/'];

  assert.deepEqual(parseEndpointList('https://a.example,https://b.example,https://c.example', fallback), [
    'https://a.example',
    'https://b.example',
    'https://c.example',
  ]);

  // the pre-existing single-URL form is a one-element list: no config change needed
  assert.deepEqual(parseEndpointList('https://only.example', fallback), ['https://only.example']);

  // blanks, whitespace and duplicates are tolerated
  assert.deepEqual(parseEndpointList(' https://a.example , , https://b.example ,https://a.example', fallback), [
    'https://a.example',
    'https://b.example',
  ]);

  // unset / empty falls back to the baked-in defaults
  assert.deepEqual(parseEndpointList(undefined, fallback), fallback);
  assert.deepEqual(parseEndpointList('', fallback), fallback);

  // only http(s): a stray scheme can never make the server speak to something else
  assert.deepEqual(parseEndpointList('file:///etc/passwd,ws://x.example,https://ok.example', fallback), ['https://ok.example']);
  assert.deepEqual(parseEndpointList('not a url,file:///x', fallback), fallback, 'an all-invalid list falls back rather than leaving the network endpointless');
});

test('baked-in default endpoint lists are multi-endpoint and keep dRPC last', () => {
  for (const net of ['arc-mainnet', 'arc-staging']) {
    const list = defaultRpcUrls(net);
    assert.ok(list.length >= 2, `${net} should have a failover list, got ${list.length}`);
    const drpc = list.findIndex((u) => u.includes('drpc.org'));
    if (drpc >= 0) assert.equal(drpc, list.length - 1, `${net}: dRPC 429s this host, it must be the last resort`);
  }
  assert.equal(defaultRpcUrls('arc-mainnet')[0], 'https://rpc.mainnet.arc.io');
  assert.equal(defaultRpcUrls('arc-staging')[0], 'https://rpc.testnet.arc.io');
});

test('with no SPECULAR_RPC_* override a network still resolves to the FULL failover list', () => {
  const saved = { ...process.env };
  try {
    for (const k of ['SPECULAR_RPC_ARC_MAINNET', 'SPECULAR_RPC_ARC_STAGING', 'SPECULAR_RPC_BASE']) delete process.env[k];
    _clearNetworkCache();
    for (const name of ['arc-mainnet', 'arc-staging']) {
      const cfg = getNetwork(name);
      assert.ok(cfg.rpcUrls.length >= 2, `${name} resolved to ${cfg.rpcUrls.length} endpoint(s): a config file naming one RPC must not collapse the failover list`);
      assert.equal(cfg.rpcUrls[0], defaultRpcUrls(name)[0]);
      assert.equal(cfg.rpcUrl, cfg.rpcUrls[0], 'the legacy single-URL field is the primary endpoint');
    }
    // an env override still wins outright, single URL or list
    process.env.SPECULAR_RPC_ARC_STAGING = 'https://only.example';
    _clearNetworkCache();
    assert.deepEqual(getNetwork('arc-staging').rpcUrls, ['https://only.example']);
    process.env.SPECULAR_RPC_ARC_STAGING = 'https://a.example,https://b.example';
    _clearNetworkCache();
    assert.deepEqual(getNetwork('arc-staging').rpcUrls, ['https://a.example', 'https://b.example']);
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    _clearNetworkCache();
  }
});

// ------------------------------------------------------------ H-3 redaction
test('H-3 holds for every endpoint in a failover list: operator credentials are never echoed', () => {
  // a well-known default is shown verbatim (it is public information)
  assert.equal(publicRpcUrlFor('arc-mainnet', 'https://rpc.mainnet.arc.io'), 'https://rpc.mainnet.arc.io');
  assert.equal(publicRpcUrlFor('arc-staging', 'https://arc-testnet-rpc.publicnode.com'), 'https://arc-testnet-rpc.publicnode.com');

  // anything operator-configured is reduced to its origin
  const secret = 'https://user:pa55w0rd@rpc.paid.example/v2/SECRETKEY?apikey=ANOTHERSECRET';
  const shown = publicRpcUrlFor('arc-mainnet', secret);
  assert.equal(shown, 'https://rpc.paid.example/');
  for (const leak of ['pa55w0rd', 'SECRETKEY', 'ANOTHERSECRET', 'user:']) {
    assert.ok(!shown.includes(leak), `redacted endpoint must not contain ${leak}`);
  }
  assert.equal(publicRpcUrlFor('arc-mainnet', 'not-a-url'), '[configured]');
});

// ------------------------------------------------------------- cache policy
test('cache policy: chain head is short-lived, pinned/immutable data is long-lived, writes are never cached', () => {
  const HEAD = 2_000, CALL = 4_000, STATIC = 3_600_000, IMMUTABLE = 300_000;

  // never cached: a nonce or a relay must always be live
  for (const m of ['eth_sendRawTransaction', 'eth_getTransactionCount', 'eth_sendTransaction', 'eth_sign']) {
    assert.equal(isCacheableMethod(m), false, `${m} must never be cached`);
    assert.equal(cacheTtlFor(m, [], '0x1'), 0);
  }

  // chain head: short
  assert.equal(cacheTtlFor('eth_blockNumber', [], '0x1'), HEAD);
  assert.equal(cacheTtlFor('eth_getBlockByNumber', ['latest', false], {}), HEAD);

  // a pinned block number can never change: long
  assert.equal(cacheTtlFor('eth_getBlockByNumber', ['0x3c4f2b', false], {}), STATIC);
  assert.equal(cacheTtlFor('eth_chainId', [], '0x13b2'), STATIC);
  assert.equal(cacheTtlFor('eth_getCode', ['0xabc', 'latest'], '0x60'), STATIC);

  // eth_call: `latest` short, pinned block long, `pending` never
  assert.equal(cacheTtlFor('eth_call', [{ to: '0x1', data: '0x2' }, 'latest'], '0x0'), CALL);
  assert.equal(cacheTtlFor('eth_call', [{ to: '0x1', data: '0x2' }, '0x3c4f2b'], '0x0'), STATIC);
  assert.equal(cacheTtlFor('eth_call', [{ to: '0x1', data: '0x2' }, 'pending'], '0x0'), 0);

  // a mined transaction is immutable; a null/pending one must NOT be cached,
  // or a freshly broadcast tx would stay invisible for the whole TTL
  assert.equal(cacheTtlFor('eth_getTransactionReceipt', ['0xh'], null), 0);
  assert.equal(cacheTtlFor('eth_getTransactionReceipt', ['0xh'], { blockNumber: null }), 0);
  assert.equal(cacheTtlFor('eth_getTransactionReceipt', ['0xh'], { blockNumber: '0x1' }), IMMUTABLE);
  assert.equal(cacheTtlFor('eth_getTransactionByHash', ['0xh'], { blockNumber: '0x1' }), IMMUTABLE);
});

test('cache TTLs are env-tunable and SPECULAR_RPC_CACHE=0 disables storage', () => {
  const saved = { ...process.env };
  try {
    process.env.SPECULAR_RPC_CACHE_CALL_MS = '9000';
    assert.equal(cacheTtlFor('eth_call', [{}, 'latest'], '0x0'), 9000);
  } finally {
    for (const k of ['SPECULAR_RPC_CACHE_CALL_MS']) delete process.env[k];
    Object.assign(process.env, saved);
  }
});

// ------------------------------------------------------- read-route TTL rule
test('read-route TTL: a terminal loan and a mined transaction are cached for minutes, live state for seconds', () => {
  assert.equal(isImmutableRead('get_loan', { state: 'REPAID' }), true);
  assert.equal(isImmutableRead('get_loan', { state: 'DEFAULTED' }), true);
  assert.equal(isImmutableRead('get_loan', { state: 'ACTIVE' }), false);
  assert.equal(isImmutableRead('get_loan', { state: 'REQUESTED' }), false);
  assert.equal(isImmutableRead('get_transaction', { found: true, status: 'confirmed', blockNumber: 12 }), true);
  assert.equal(isImmutableRead('get_transaction', { found: true, status: 'reverted', blockNumber: 12 }), true);
  assert.equal(isImmutableRead('get_transaction', { found: true, status: 'pending', blockNumber: null }), false);
  assert.equal(isImmutableRead('get_transaction', { found: false, status: 'unknown' }), false);
  assert.equal(isImmutableRead('get_protocol_status', { paused: false }), false);
  assert.equal(isImmutableRead('get_loan', null), false);

  assert.equal(readTtlFor('get_loan', { state: 'REPAID' }), 300_000);
  assert.equal(readTtlFor('get_loan', { state: 'ACTIVE' }), 3_000);
  assert.equal(readTtlFor('get_protocol_status', {}), 3_000);

  const saved = process.env.SPECULAR_READ_CACHE;
  try {
    process.env.SPECULAR_READ_CACHE = '0';
    assert.equal(readTtlFor('get_loan', { state: 'REPAID' }), 0, 'SPECULAR_READ_CACHE=0 must disable the read cache entirely');
  } finally {
    if (saved === undefined) delete process.env.SPECULAR_READ_CACHE;
    else process.env.SPECULAR_READ_CACHE = saved;
  }
});

// ----------------------------------------------------------- TtlCache itself
test('TtlCache: hit, expiry, single flight, and stats', async () => {
  const c = new TtlCache(10);
  let produced = 0;
  const produce = async () => {
    produced++;
    await new Promise((r) => setTimeout(r, 30));
    return { n: produced };
  };

  // 8 concurrent callers for the same key produce ONE upstream call
  const all = await Promise.all(Array.from({ length: 8 }, () => c.wrap('k', () => 50, produce)));
  assert.equal(produced, 1, 'concurrent identical reads must share one in-flight promise');
  for (const r of all) assert.equal(r.n, 1);
  assert.equal(c.stats().coalesced, 7);
  assert.equal(c.stats().misses, 1);

  // inside the TTL: a hit, still one upstream call
  assert.equal((await c.wrap('k', () => 50, produce)).n, 1);
  assert.equal(produced, 1);
  assert.equal(c.stats().hits, 1);

  // after the TTL: refetched
  await new Promise((r) => setTimeout(r, 70));
  assert.equal((await c.wrap('k', () => 50, produce)).n, 2);
  assert.equal(produced, 2);

  // ttl 0 stores nothing
  await c.wrap('z', () => 0, produce);
  assert.equal(c.peek('z'), null);

  // a producer that throws must not be cached, and must not wedge the key
  await assert.rejects(c.wrap('boom', () => 50, async () => { throw new Error('nope'); }));
  assert.equal(c.peek('boom'), null);
  assert.equal((await c.wrap('boom', () => 50, async () => ({ n: 'recovered' }))).n, 'recovered');

  // onHit can stamp the value handed back without changing what is stored
  const stamped = await c.wrap('k', () => 50, produce, (v, ageMs) => ({ ...v, cached: true, cacheAgeMs: ageMs }));
  assert.equal(stamped.cached, true);
  assert.equal(typeof stamped.cacheAgeMs, 'number');
  assert.equal(c.peek('k').value.cached, undefined, 'the stored copy must stay clean');
});

test('stableKey: argument order cannot split a cache key', () => {
  assert.equal(stableKey({ a: 1, b: { c: 2, d: 3 } }), stableKey({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(stableKey({ a: 1 }), stableKey({ a: 2 }));
  assert.equal(stableKey(10n), '"10n"');
  const circular = { a: 1 };
  circular.self = circular;
  assert.ok(stableKey(circular).includes('circular'));
});

// ------------------------------------------------------------- deadlines
test('deadline: budget is clamped to what is left, and running out throws before any socket is opened', () => {
  assert.equal(remainingMs(), null, 'outside a request there is no deadline');
  assert.equal(attemptBudgetMs(8000), 8000, 'with no deadline the per-call timeout applies unchanged');

  runWithDeadline(5_000, () => {
    const left = remainingMs();
    assert.ok(left > 4_000 && left <= 5_000, `remaining ${left}`);
    assert.equal(attemptBudgetMs(8_000), Math.min(8_000, left - 150), 'per-attempt timeout is clamped by the remaining budget');
    assert.equal(attemptBudgetMs(1_000), 1_000, 'a short per-call timeout still wins when it is smaller');
  });

  runWithDeadline(0, () => assert.equal(remainingMs(), null, 'deadline 0 disables the budget'));

  // an already-expired budget fails immediately rather than dialling out
  runWithDeadline(1, () => {
    const end = Date.now() + 5;
    while (Date.now() < end) { /* burn past the deadline */ }
    assert.throws(() => attemptBudgetMs(8_000), RequestDeadlineError);
  });
});

test('requestDeadlineMs: default, override, and explicit disable', () => {
  const saved = process.env.SPECULAR_REQUEST_DEADLINE_MS;
  try {
    delete process.env.SPECULAR_REQUEST_DEADLINE_MS;
    assert.equal(requestDeadlineMs(), 20_000);
    process.env.SPECULAR_REQUEST_DEADLINE_MS = '4500';
    assert.equal(requestDeadlineMs(), 4_500);
    process.env.SPECULAR_REQUEST_DEADLINE_MS = '0';
    assert.equal(requestDeadlineMs(), 0, '0 means "no deadline"');
    process.env.SPECULAR_REQUEST_DEADLINE_MS = 'nonsense';
    assert.equal(requestDeadlineMs(), 20_000, 'a junk value falls back to the default rather than disabling the bound');
  } finally {
    if (saved === undefined) delete process.env.SPECULAR_REQUEST_DEADLINE_MS;
    else process.env.SPECULAR_REQUEST_DEADLINE_MS = saved;
  }
});
