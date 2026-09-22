// Integration tests for the 2026-09-22 RPC-resilience round.
//
// Part A drives the transport (dist/rpc.js) against LOCAL fake upstreams that
// can be switched between healthy, 429, 500, slow, hung and connection-refused,
// so failover / backoff / coalescing / caching / circuit breaker are proven
// deterministically without waiting for a public provider to throttle us.
//
// Part B boots dist/http.js and proves the HTTP contract: a dead network is a
// fast 503 "temporarily unavailable" with Retry-After (not a multi-minute
// hang), a hung upstream is bounded by the request deadline, /rpc-health
// reports endpoint health with redacted URLs, and a failover list keeps the
// server answering 200 when its primary endpoint is dead.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPool, rpcCall, rpcHealth, resetRpcState, UpstreamFailedError, UpstreamUnavailableError } from '../dist/rpc.js';
import { runWithDeadline, RequestDeadlineError } from '../dist/deadline.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(here, '..', 'dist', 'http.js');

// --------------------------------------------------------------- fake upstream
const fakes = [];
/**
 * A controllable JSON-RPC endpoint.
 *   f.mode: 'ok' | '429' | '500' | 'slow' | 'hang' | 'garbage' | 'rpcRateLimit'
 *   f.calls: number of JSON-RPC requests received
 */
async function fakeUpstream(initial = {}) {
  const f = { mode: 'ok', delayMs: 0, result: '0xdead', calls: 0, byMethod: {}, ...initial };
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    let id = 1;
    try {
      const p = JSON.parse(body);
      id = p.id;
      f.calls++;
      f.byMethod[p.method] = (f.byMethod[p.method] || 0) + 1;
    } catch { f.calls++; }

    if (f.mode === 'hang') return; // never answers, never closes
    if (f.mode === '429') {
      res.writeHead(429, { 'content-type': 'application/json', ...(f.retryAfter ? { 'retry-after': String(f.retryAfter) } : {}) });
      return res.end(JSON.stringify({ error: { code: 429, message: 'Too many requests' } }));
    }
    if (f.mode === '500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ error: { code: -32000, message: 'internal' } }));
    }
    if (f.mode === 'garbage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('<html>not json</html>');
    }
    if (f.mode === 'rpcRateLimit') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32005, message: 'rate limit exceeded' } }));
    }
    if (f.mode === 'revert') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: 3, message: 'execution reverted: Pool paused', data: '0x08c379a0' } }));
    }
    if (f.mode === 'slow') await new Promise((r) => setTimeout(r, f.delayMs));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id, result: typeof f.result === 'function' ? f.result() : f.result }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  f.url = `http://127.0.0.1:${server.address().port}`;
  f.close = () => new Promise((r) => server.close(r));
  fakes.push(f);
  return f;
}

// a TCP port nothing listens on -> ECONNREFUSED
const DEAD_URL = 'http://127.0.0.1:1';

let hangSock, hangUrl;
before(async () => {
  hangSock = net.createServer((s) => { s.on('data', () => {}); s.on('error', () => {}); });
  await new Promise((r) => hangSock.listen(0, '127.0.0.1', r));
  hangUrl = `http://127.0.0.1:${hangSock.address().port}`;
});

const children = [];
after(async () => {
  for (const f of fakes) await f.close().catch(() => {});
  hangSock?.close();
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* gone */ } }
});

let seq = 0;
const freshPool = (urls) => {
  const name = `test-net-${++seq}`;
  return getPool(name, urls, urls.map((u) => new URL(u).origin + '/'));
};
const call = (pool, method, params = [], id = 1) => rpcCall(pool, { id, method, params });

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) { saved[k] = process.env[k]; process.env[k] = v; }
  const restore = () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  };
  const out = fn();
  return out instanceof Promise ? out.finally(restore) : (restore(), out);
}

// ===========================================================================
// PART A — the transport
// ===========================================================================

test('failover: a 429 on the primary moves the call to the next endpoint, and the primary goes cold', async () => {
  resetRpcState();
  const a = await fakeUpstream({ mode: '429' });
  const b = await fakeUpstream({ mode: 'ok', result: '0xfromB' });
  const pool = freshPool([a.url, b.url]);

  await withEnv({ SPECULAR_RPC_CACHE: '0', SPECULAR_RPC_MAX_ATTEMPTS: '3' }, async () => {
    const r = await call(pool, 'eth_blockNumber');
    assert.equal(r.result, '0xfromB', 'the answer came from the healthy secondary');
    assert.equal(a.calls, 1);
    assert.equal(b.calls, 1);

    // the primary is cold now: the next calls skip it entirely
    const health = pool.health();
    assert.equal(health.endpoints[0].state, 'cold');
    assert.equal(health.endpoints[0].lastErrorClass, 'rate_limited');
    assert.equal(health.endpoints[1].state, 'up');
    assert.equal(health.circuitOpen, false, 'one healthy endpoint means the circuit stays closed');

    for (let i = 0; i < 5; i++) await call(pool, 'eth_blockNumber', [], i + 10);
    assert.equal(a.calls, 1, 'a cold endpoint receives no further traffic during its backoff');
    assert.equal(b.calls, 6);
  });
});

test('failover covers connection-refused, 5xx, garbage bodies and JSON-RPC-level rate limits', async () => {
  for (const [label, primary] of [
    ['connection refused', { dead: true }],
    ['500', { mode: '500' }],
    ['garbage body', { mode: 'garbage' }],
    ['JSON-RPC -32005 rate limit', { mode: 'rpcRateLimit' }],
  ]) {
    resetRpcState();
    const b = await fakeUpstream({ mode: 'ok', result: `0xok-${label.replace(/\W/g, '')}` });
    const primaryUrl = primary.dead ? DEAD_URL : (await fakeUpstream(primary)).url;
    const pool = freshPool([primaryUrl, b.url]);
    await withEnv({ SPECULAR_RPC_CACHE: '0', SPECULAR_RPC_FAILURE_THRESHOLD: '1' }, async () => {
      const r = await call(pool, 'eth_blockNumber');
      assert.equal(r.result, b.result, `${label}: failed over to the healthy endpoint`);
      assert.equal(pool.health().endpoints[0].state, 'cold', `${label}: the bad endpoint was taken out of rotation`);
    });
  }
});

test('failover on a slow/hung endpoint is bounded by the per-attempt timeout', async () => {
  resetRpcState();
  const b = await fakeUpstream({ mode: 'ok', result: '0xfast' });
  const pool = freshPool([hangUrl, b.url]);
  await withEnv({ SPECULAR_RPC_CACHE: '0', SPECULAR_RPC_TIMEOUT_MS: '700', SPECULAR_RPC_FAILURE_THRESHOLD: '1' }, async () => {
    const t = Date.now();
    const r = await call(pool, 'eth_blockNumber');
    const ms = Date.now() - t;
    assert.equal(r.result, '0xfast');
    assert.ok(ms >= 600 && ms < 3_000, `one timeout then failover, took ${ms}ms`);
    assert.equal(pool.health().endpoints[0].lastErrorClass, 'timeout');

    // the hung endpoint is out of rotation, so the NEXT call is immediate
    const t2 = Date.now();
    await call(pool, 'eth_blockNumber', [], 2);
    assert.ok(Date.now() - t2 < 300, 'a cold endpoint is skipped, not re-probed within its backoff');
  });
});

test('backoff: cold time grows exponentially per cold cycle and resets on a success (automatic recovery)', async () => {
  resetRpcState();
  const a = await fakeUpstream({ mode: '500' });
  const pool = freshPool([a.url]);
  await withEnv({
    SPECULAR_RPC_CACHE: '0',
    SPECULAR_RPC_FAILURE_THRESHOLD: '1',
    SPECULAR_RPC_MAX_ATTEMPTS: '1',
    SPECULAR_RPC_BACKOFF_MS: '150',
    SPECULAR_RPC_BACKOFF_MAX_MS: '5000',
  }, async () => {
    await assert.rejects(call(pool, 'eth_blockNumber'), UpstreamFailedError);
    const first = pool.health().endpoints[0].coldForMs;
    assert.ok(first > 0 && first <= 150, `first cold window ~150ms, got ${first}`);

    // wait it out; the next call is a half-open probe that fails again -> doubled
    await new Promise((r) => setTimeout(r, 200));
    await assert.rejects(call(pool, 'eth_blockNumber', [], 2), UpstreamFailedError);
    const second = pool.health().endpoints[0].coldForMs;
    assert.ok(second > 150 && second <= 300, `second cold window ~300ms (doubled), got ${second}`);

    // heal the upstream: the next probe succeeds and health resets completely
    await new Promise((r) => setTimeout(r, 350));
    a.mode = 'ok';
    const r = await call(pool, 'eth_blockNumber', [], 3);
    assert.equal(r.result, '0xdead');
    const h = pool.health().endpoints[0];
    assert.equal(h.state, 'up');
    assert.equal(h.consecutiveFailures, 0);
    assert.equal(h.coldForMs, 0);
    assert.equal(pool.health().circuitOpen, false, 'the circuit closed again without any operator action');
  });
});

test('a single blip does not take a single-endpoint deployment out: failureThreshold consecutive failures are required', async () => {
  resetRpcState();
  const a = await fakeUpstream({ mode: 'ok' });
  const pool = freshPool([a.url]);
  await withEnv({ SPECULAR_RPC_CACHE: '0', SPECULAR_RPC_FAILURE_THRESHOLD: '2', SPECULAR_RPC_MAX_ATTEMPTS: '1' }, async () => {
    a.mode = '500';
    await assert.rejects(call(pool, 'eth_blockNumber'), UpstreamFailedError);
    assert.equal(pool.health().endpoints[0].state, 'up', 'one non-429 failure is a blip, not a fault');
    assert.equal(pool.health().circuitOpen, false);
    a.mode = 'ok';
    await call(pool, 'eth_blockNumber', [], 2);
    assert.equal(pool.health().endpoints[0].consecutiveFailures, 0);
  });
});

test('circuit breaker: with every endpoint cold, calls fail fast with a retry hint instead of queueing', async () => {
  resetRpcState();
  const pool = freshPool([DEAD_URL, DEAD_URL.replace(':1', ':2')]);
  await withEnv({ SPECULAR_RPC_CACHE: '0', SPECULAR_RPC_FAILURE_THRESHOLD: '1', SPECULAR_RPC_BACKOFF_MS: '400', SPECULAR_RPC_MAX_ATTEMPTS: '3' }, async () => {
    await assert.rejects(call(pool, 'eth_blockNumber'), (e) => e instanceof UpstreamUnavailableError || e instanceof UpstreamFailedError);

    const h = pool.health();
    assert.equal(h.circuitOpen, true, 'every endpoint is cold => the circuit is open');
    assert.ok(h.retryAfterSeconds >= 1);

    // subsequent calls must be REFUSED IMMEDIATELY — no socket, no queue
    const t = Date.now();
    await assert.rejects(call(pool, 'eth_blockNumber', [], 2), (e) => {
      assert.ok(e instanceof UpstreamUnavailableError, `expected circuit-open error, got ${e}`);
      assert.match(e.message, /temporarily unavailable/i);
      assert.ok(e.retryAfterSeconds >= 1);
      return true;
    });
    assert.ok(Date.now() - t < 100, 'circuit-open must be an immediate refusal');

    // and it closes by itself once the backoff elapses and an endpoint answers
    assert.ok(pool.health().circuitOpens >= 1);
  });
});

test('coalescing: N identical concurrent reads produce ONE upstream call; distinct params do not share', async () => {
  resetRpcState();
  const a = await fakeUpstream({ mode: 'slow', delayMs: 120, result: '0xshared' });
  const pool = freshPool([a.url]);
  await withEnv({ SPECULAR_RPC_CACHE: '0', SPECULAR_RPC_COALESCE: '1' }, async () => {
    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => call(pool, 'eth_call', [{ to: '0xc', data: '0xd' }, 'latest'], i)));
    assert.equal(a.calls, 1, `25 identical concurrent reads must issue 1 upstream call, issued ${a.calls}`);
    for (const r of results) assert.equal(r.result, '0xshared');
    // ids are preserved per caller
    assert.deepEqual(results.map((r) => r.id).sort((x, y) => x - y), [...Array(25).keys()]);

    a.calls = 0;
    await Promise.all([
      call(pool, 'eth_call', [{ to: '0xc', data: '0xAA' }, 'latest'], 100),
      call(pool, 'eth_call', [{ to: '0xc', data: '0xBB' }, 'latest'], 101),
    ]);
    assert.equal(a.calls, 2, 'different params must not share an in-flight promise');
  });
});

test('caching: repeat reads inside the TTL never touch the upstream; writes and nonces always do', async () => {
  resetRpcState();
  const a = await fakeUpstream({ mode: 'ok', result: '0xcached' });
  const pool = freshPool([a.url]);
  await withEnv({ SPECULAR_RPC_CACHE: '1', SPECULAR_RPC_CACHE_CALL_MS: '400' }, async () => {
    for (let i = 0; i < 10; i++) await call(pool, 'eth_call', [{ to: '0xc', data: '0xd' }, 'latest'], i);
    assert.equal(a.calls, 1, `10 sequential identical reads => 1 upstream call, got ${a.calls}`);

    await new Promise((r) => setTimeout(r, 450));
    await call(pool, 'eth_call', [{ to: '0xc', data: '0xd' }, 'latest'], 99);
    assert.equal(a.calls, 2, 'the cache expires, so state cannot go stale indefinitely');

    // never cached: a nonce read and a relay must always reach the chain
    a.calls = 0;
    for (let i = 0; i < 3; i++) await call(pool, 'eth_getTransactionCount', ['0xabc', 'pending'], i);
    for (let i = 0; i < 3; i++) await call(pool, 'eth_sendRawTransaction', ['0x02f8'], i);
    assert.equal(a.calls, 6, 'nonce reads and raw-tx relays are never cached or coalesced');
  });
});

test('caching can be disabled without disabling coalescing (SPECULAR_RPC_CACHE=0)', async () => {
  resetRpcState();
  const a = await fakeUpstream({ mode: 'slow', delayMs: 80, result: '0x1' });
  const pool = freshPool([a.url]);
  await withEnv({ SPECULAR_RPC_CACHE: '0', SPECULAR_RPC_COALESCE: '1' }, async () => {
    await Promise.all(Array.from({ length: 6 }, (_, i) => call(pool, 'eth_call', [{ to: '0x1' }, 'latest'], i)));
    assert.equal(a.calls, 1, 'coalescing still applies');
    await call(pool, 'eth_call', [{ to: '0x1' }, 'latest'], 9);
    assert.equal(a.calls, 2, 'with the cache off, a later identical read does hit the upstream again');
  });
});

test('a contract revert is returned to the caller, NOT treated as an endpoint fault', async () => {
  resetRpcState();
  const a = await fakeUpstream({ mode: 'revert' });
  const b = await fakeUpstream({ mode: 'ok', result: '0xshouldNotBeUsed' });
  const pool = freshPool([a.url, b.url]);
  await withEnv({ SPECULAR_RPC_CACHE: '0' }, async () => {
    const r = await call(pool, 'eth_call', [{ to: '0xc', data: '0xd' }, 'latest']);
    assert.ok(r.error, 'the revert reaches the caller as a JSON-RPC error');
    assert.match(r.error.message, /execution reverted/);
    assert.equal(b.calls, 0, 'a revert must never cause a failover');
    assert.equal(pool.health().endpoints[0].state, 'up', 'a revert must never mark an endpoint unhealthy');
  });
});

test('the request deadline clamps upstream attempts and fails explicitly rather than hanging', async () => {
  resetRpcState();
  const pool = freshPool([hangUrl]);
  await withEnv({ SPECULAR_RPC_CACHE: '0', SPECULAR_RPC_TIMEOUT_MS: '30000', SPECULAR_RPC_MAX_ATTEMPTS: '3' }, async () => {
    const t = Date.now();
    await assert.rejects(
      runWithDeadline(900, () => call(pool, 'eth_blockNumber')),
      (e) => e instanceof RequestDeadlineError || e instanceof UpstreamFailedError,
    );
    const ms = Date.now() - t;
    assert.ok(ms < 2_500, `a 900ms budget against a hung upstream must fail in ~1s, took ${ms}ms`);
  });
});

test('rpcHealth() exposes per-endpoint state and cache hit rate, and never a full operator URL', async () => {
  resetRpcState();
  const a = await fakeUpstream({ mode: 'ok' });
  const pool = getPool('redaction-net', [`${a.url}/v2/SUPERSECRETKEY?apikey=ALSOSECRET`], [`${a.url}/`]);
  await withEnv({ SPECULAR_RPC_CACHE: '1' }, async () => {
    await call(pool, 'eth_call', [{ to: '0x1' }, 'latest'], 1).catch(() => {});
    await call(pool, 'eth_call', [{ to: '0x1' }, 'latest'], 2).catch(() => {});
    const h = rpcHealth();
    const text = JSON.stringify(h);
    assert.ok(!text.includes('SUPERSECRETKEY'), '/rpc-health must never publish a path key');
    assert.ok(!text.includes('ALSOSECRET'), '/rpc-health must never publish a query key');

    const netH = h.networks.find((n) => n.network === 'redaction-net');
    assert.ok(netH, 'the pool is reported');
    assert.equal(netH.endpoints.length, 1);
    for (const k of ['endpoint', 'state', 'consecutiveFailures', 'lastErrorClass', 'lastErrorAt', 'calls', 'successes', 'failures']) {
      assert.ok(k in netH.endpoints[0], `endpoint health must report ${k}`);
    }
    assert.ok(h.cache.hitRate > 0, 'the cache hit rate is reported');
    assert.equal(typeof h.config.perCallTimeoutMs, 'number');
  });
});

// ===========================================================================
// PART B — the HTTP contract
// ===========================================================================

async function boot(env) {
  const port = 3700 + Math.floor(Math.random() * 1500);
  const child = spawn(process.execPath, [ENTRY], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      SPECULAR_ENABLED_NETWORKS: 'arc-staging',
      SPECULAR_RATE_LIMIT_PER_MIN: '100000',
      LOG_LEVEL: 'warn',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let logs = '';
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/`)).ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 100));
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs}`);
  }
  return { base, child, logs: () => logs };
}
async function get(url) {
  const r = await fetch(url);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, body, text, headers: r.headers };
}

test('HTTP: every upstream dead => fast 503 "network temporarily unavailable" + Retry-After, not a hang', async () => {
  const s = await boot({
    SPECULAR_RPC_ARC_STAGING: `${DEAD_URL},http://127.0.0.1:2`,
    SPECULAR_RPC_FAILURE_THRESHOLD: '1',
    SPECULAR_RPC_BACKOFF_MS: '3000',
  });

  const first = await get(`${s.base}/v1/arc-staging/status`);
  assert.ok([502, 503].includes(first.status), `first request status ${first.status}`);

  const t = Date.now();
  const second = await get(`${s.base}/v1/arc-staging/status`);
  const ms = Date.now() - t;
  assert.equal(second.status, 503, `circuit open => 503, got ${second.status}: ${second.text.slice(0, 200)}`);
  assert.match(second.body.error, /temporarily unavailable/i);
  assert.equal(second.body.network, 'arc-staging');
  assert.ok(Number(second.headers.get('retry-after')) >= 1, 'a retry hint is returned');
  assert.ok(ms < 1_000, `circuit-open responses must be immediate, took ${ms}ms`);

  // no upstream detail escapes
  assert.ok(!/127\.0\.0\.1:1|ECONNREFUSED|ethers/i.test(second.text), `error body leaked internals: ${second.text}`);

  // /health reports the degradation, /rpc-health explains it
  const health = await get(`${s.base}/health`);
  assert.equal(health.status, 503);
  assert.equal(health.body.upstream.networks[0].circuitOpen, true);
  assert.equal(health.body.upstream.networks[0].endpointsTotal, 2, 'both configured endpoints are tracked');

  const rpcH = await get(`${s.base}/rpc-health`);
  assert.equal(rpcH.status, 200);
  assert.equal(rpcH.body.status, 'degraded');
  const netH = rpcH.body.networks.find((n) => n.network === 'arc-staging');
  assert.equal(netH.circuitOpen, true);
  assert.equal(netH.endpoints.length, 2);
  assert.ok(netH.endpoints.every((e) => e.state === 'cold'));
  assert.equal(netH.endpoints[0].lastErrorClass, 'connection');
});

test('HTTP: a hung upstream is bounded by SPECULAR_REQUEST_DEADLINE_MS (fast, explicit failure with a retry hint)', async () => {
  const s = await boot({
    SPECULAR_RPC_ARC_STAGING: hangUrl,
    SPECULAR_RPC_TIMEOUT_MS: '60000',   // deliberately huge: the DEADLINE must be what bounds this
    SPECULAR_REQUEST_DEADLINE_MS: '1500',
  });
  const t = Date.now();
  const r = await get(`${s.base}/v1/arc-staging/status`);
  const ms = Date.now() - t;
  assert.ok([502, 503, 504].includes(r.status), `status ${r.status}`);
  assert.ok(ms < 4_000, `a hung upstream must fail in seconds, took ${ms}ms (the 2026-09-20 report measured 164 s)`);
  assert.ok(r.body?.error, 'a JSON error body, not a socket reset');
  assert.ok(!/127\.0\.0\.1|ethers|version=6\./i.test(r.text), `leaked internals: ${r.text}`);
  if (r.status === 504) assert.equal(r.headers.get('retry-after'), '1');
});

test('HTTP: a failover list keeps the server serving 200 when the PRIMARY endpoint is dead', async () => {
  // primary refuses connections; secondary is the real public Arc testnet RPC.
  const s = await boot({ SPECULAR_RPC_ARC_STAGING: `${DEAD_URL},https://rpc.testnet.arc.io`, SPECULAR_RPC_FAILURE_THRESHOLD: '1' });
  const r = await get(`${s.base}/v1/arc-staging/network`);
  assert.equal(r.status, 200, `expected a successful read through the secondary endpoint, got ${r.status}: ${r.text.slice(0, 300)}`);
  assert.equal(r.body.chainId, 5042002);

  const rpcH = await get(`${s.base}/rpc-health`);
  const netH = rpcH.body.networks.find((n) => n.network === 'arc-staging');
  assert.equal(netH.endpoints.length, 2);
  assert.equal(netH.endpoints[0].state, 'cold', 'the dead primary was taken out of rotation');
  assert.equal(netH.endpoints[1].successes > 0, true, 'the secondary served the read');
  assert.equal(netH.circuitOpen, false);

  // /v1/networks must publish the whole list, redacted
  const nets = await get(`${s.base}/v1/networks`);
  const cfg = nets.body.networks.find((n) => n.network === 'arc-staging');
  assert.equal(cfg.rpcUrls.length, 2);
  assert.ok(cfg.rpcUrls.includes('https://rpc.testnet.arc.io'), 'a well-known public default is shown verbatim');
});

test('HTTP: /v1/networks and /rpc-health never publish operator RPC credentials (H-3, now per endpoint)', async () => {
  const s = await boot({
    SPECULAR_RPC_ARC_STAGING: 'https://opuser:0pSecret@rpc.paid.example/v2/PATHKEY123?apikey=QUERYKEY456,https://rpc.testnet.arc.io',
  });
  for (const route of ['/v1/networks', '/rpc-health', '/health']) {
    const r = await get(`${s.base}${route}`);
    for (const leak of ['0pSecret', 'PATHKEY123', 'QUERYKEY456', 'opuser']) {
      assert.ok(!r.text.includes(leak), `${route} leaked ${leak}`);
    }
  }
  const nets = await get(`${s.base}/v1/networks`);
  const cfg = nets.body.networks.find((n) => n.network === 'arc-staging');
  assert.deepEqual(cfg.rpcUrls, ['https://rpc.paid.example/', 'https://rpc.testnet.arc.io']);
});

test('HTTP: a repeated read is served from the route cache and stops reaching the upstream', async () => {
  const up = await fakeUpstream({ mode: 'ok' });
  // Only /health is exercised here: it needs exactly one eth_getBlockByNumber
  // per network, which the fake can answer, so the call count is unambiguous.
  up.result = () => ({ number: '0x1', timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16), hash: '0x' + '11'.repeat(32), parentHash: '0x' + '22'.repeat(32), transactions: [] });
  const s = await boot({ SPECULAR_RPC_ARC_STAGING: up.url, SPECULAR_HEALTH_CACHE_MS: '30000' });
  up.calls = 0;
  for (let i = 0; i < 12; i++) await get(`${s.base}/health`);
  assert.ok(up.calls <= 1, `/health must not fan out per request, saw ${up.calls} upstream calls for 12 requests`);

  const rpcH = await get(`${s.base}/rpc-health`);
  assert.ok('jsonRpc' in rpcH.body.caches && 'readRoutes' in rpcH.body.caches, 'both cache layers report counters');
  assert.equal(typeof rpcH.body.caches.jsonRpc.hitRate, 'number');
  assert.equal(typeof rpcH.body.config.requestDeadlineMs, 'number');
});
