// Integration regressions from the 2026-09-20 hosted-server review. Boots
// dist/http.js (arc-staging only). Reads may hit the public RPC; a local
// never-responding TCP listener stands in for a hung RPC. Nothing is broadcast.
//
//  H-5  upstream RPC timeout: a hung RPC must yield 502/503 quickly, not hang.
//  H-6  /health is cached (bounded RPC fan-out from an unauthenticated route).
//  H-7  load shedding: SPECULAR_MAX_INFLIGHT caps concurrent RPC-bound work -> 503 + Retry-After.
//  H-8  MCP: Accept without text/event-stream is tolerated (stateless JSON server).
//  H-9  MCP: unknown tool / malformed tools/call -> JSON-RPC -32602, never -32603 with zod dumps.
//  H-10 trust proxy: hop count honoured; XFF spoofing cannot change the limiter key;
//       access log carries the forwarded chain for operator verification.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const here = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(here, '..', 'dist', 'http.js');
const NET = 'arc-staging';
const AGENT = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';
const MCP_H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

const servers = [];
async function boot(env) {
  const port = 3500 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, [ENTRY], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', SPECULAR_ENABLED_NETWORKS: NET, LOG_LEVEL: 'info', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/`)).ok) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs}`);
  }
  const s = { base, child, logs: () => logs };
  servers.push(s);
  return s;
}
async function json(url, init) {
  const r = await fetch(url, init);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, body, text, headers: r.headers };
}
const post = (url, data, headers = {}) => json(url, { method: 'POST', headers: { ...MCP_H, ...headers }, body: JSON.stringify(data) });

// TCP listener that accepts and never answers (a hung RPC).
let hang; let hangPort;
before(async () => {
  hang = net.createServer((sock) => { sock.on('data', () => {}); sock.on('error', () => {}); });
  await new Promise((r) => hang.listen(0, '127.0.0.1', r));
  hangPort = hang.address().port;
});
after(() => {
  for (const s of servers) s.child.kill('SIGTERM');
  hang?.close();
});

test('H-5: hung RPC -> fast 502/503 on reads and 503 on /health (SPECULAR_RPC_TIMEOUT_MS)', async () => {
  const S = await boot({ SPECULAR_RPC_ARC_STAGING: `http://127.0.0.1:${hangPort}`, SPECULAR_RPC_TIMEOUT_MS: '1500' });
  let t = Date.now();
  const st = await json(`${S.base}/v1/${NET}/status`);
  // 2026-09-22: with the resilient transport the second consecutive timeout takes
  // the (single) endpoint out of rotation, so the read can also come back as the
  // circuit-breaker's 503 instead of the exhausted-attempts 502. Both are fast,
  // explicit and sanitised — which is what H-5 is about.
  assert.ok([502, 503].includes(st.status), st.text);
  assert.match(st.body.error, /timed out|unreachable|temporarily unavailable/i);
  assert.ok(Date.now() - t < 6000, `status took ${Date.now() - t}ms`);
  t = Date.now();
  const h = await json(`${S.base}/health`);
  assert.equal(h.status, 503);
  assert.equal(h.body.networks[0].ok, false);
  assert.ok(Date.now() - t < 6000, `health took ${Date.now() - t}ms`);
  assert.doesNotMatch(JSON.stringify(h.body) + st.text, new RegExp(String(hangPort)), 'RPC endpoint not echoed');
}, { timeout: 30_000 });

test('H-6: /health is cached for a short window', async () => {
  const S = await boot({ SPECULAR_HEALTH_CACHE_MS: '5000' });
  const a = await json(`${S.base}/health`);
  assert.equal(a.status, 200, a.text);
  const b = await json(`${S.base}/health`);
  const c = await json(`${S.base}/health`);
  assert.equal(a.body.cached, false);
  assert.equal(b.body.cached, true);
  assert.equal(c.body.cached, true);
  assert.equal(b.body.networks[0].blockNumber, a.body.networks[0].blockNumber);
  assert.equal(b.body.networks[0].blockTimestamp, a.body.networks[0].blockTimestamp);
  assert.equal(typeof b.body.cacheAgeMs, 'number');
}, { timeout: 30_000 });

test('H-7: in-flight cap sheds load with 503 + Retry-After instead of queueing', async () => {
  const S = await boot({ SPECULAR_RPC_ARC_STAGING: `http://127.0.0.1:${hangPort}`, SPECULAR_RPC_TIMEOUT_MS: '3000', SPECULAR_MAX_INFLIGHT: '2' });
  const t = Date.now();
  const results = await Promise.all(Array.from({ length: 6 }, () => json(`${S.base}/v1/${NET}/status`)));
  // 2026-09-22: the upstream failure itself can now be a 503 (circuit breaker) as
  // well as a 502, so shed responses are identified by their body ("server busy"),
  // not by status alone. The contract under test is unchanged: exactly
  // MAX_INFLIGHT requests execute and the rest are refused immediately.
  const shed = results.filter((r) => /busy/i.test(String(r.body?.error ?? '')));
  const executed = results.filter((r) => !/busy/i.test(String(r.body?.error ?? '')));
  assert.equal(shed.length, 4, JSON.stringify(results.map((r) => [r.status, r.body?.error])));
  assert.equal(executed.length, 2);
  for (const r of executed) assert.ok([502, 503].includes(r.status), `executed request status ${r.status}`);
  for (const r of shed) {
    assert.equal(r.status, 503);
    assert.ok(r.headers.get('retry-after'));
  }
  assert.ok(Date.now() - t < 10_000);
  // capacity is released afterwards
  const again = await json(`${S.base}/v1/networks`);
  assert.equal(again.status, 200);
  // MCP tool calls go through the same shed() cap. 2026-09-22: by this point the
  // circuit breaker has taken the dead endpoint out, so these calls are refused
  // in milliseconds instead of occupying a slot — they must be either an HTTP 503
  // shed OR an isError tool result that says the network is unavailable. What must
  // never happen is a caller waiting on a hung upstream.
  const mcp = await Promise.all(Array.from({ length: 4 }, () => post(`${S.base}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_protocol_status', arguments: { network: NET } } })));
  for (const r of mcp) {
    if (r.status === 503) continue;
    assert.equal(r.status, 200, r.text);
    assert.equal(r.body.result?.isError, true, r.text);
    assert.match(r.text, /temporarily unavailable|timed out|unreachable/i);
  }
}, { timeout: 40_000 });

test('H-8: MCP tolerates Accept without text/event-stream (and no Accept at all)', async () => {
  const S = await boot({});
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  for (const accept of ['application/json', '*/*', '']) {
    const r = await post(`${S.base}/mcp`, ping, { accept });
    assert.equal(r.status, 200, `accept=${JSON.stringify(accept)}: ${r.text}`);
    assert.deepEqual(r.body.result, {});
    assert.match(r.headers.get('content-type'), /application\/json/);
  }
  // an explicit SSE-only client still gets JSON (stateless server, enableJsonResponse)
  const sse = await post(`${S.base}/mcp`, ping, { accept: 'text/event-stream' });
  assert.equal(sse.status, 200);
  assert.match(sse.headers.get('content-type'), /application\/json/);
});

test('H-9: MCP protocol errors use -32602 for unknown tool / malformed tools/call', async () => {
  const S = await boot({});
  const unknown = await post(`${S.base}/mcp`, { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'nope', arguments: {} } });
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.error?.code, -32602, unknown.text);
  assert.match(unknown.body.error.message, /Unknown tool: nope/);
  assert.equal(unknown.body.id, 7);

  for (const [label, params] of [
    ['missing params', undefined],
    ['name not a string', { name: 42 }],
    ['arguments array', { name: 'list_networks', arguments: [] }],
    ['arguments string', { name: 'list_networks', arguments: 'x' }],
    ['arguments null', { name: 'list_networks', arguments: null }],
  ]) {
    const r = await post(`${S.base}/mcp`, { jsonrpc: '2.0', id: 8, method: 'tools/call', ...(params === undefined ? {} : { params }) });
    assert.equal(r.status, 200, label);
    assert.equal(r.body.error?.code, -32602, `${label}: ${r.text}`);
    assert.doesNotMatch(r.body.error.message, /invalid_type|"path"/, `${label}: no zod dump`);
    assert.equal(r.body.id, 8);
  }
  // initialize with a non-string protocolVersion is also invalid params
  const init = await post(`${S.base}/mcp`, { jsonrpc: '2.0', id: 9, method: 'initialize', params: { protocolVersion: 42, capabilities: {}, clientInfo: { name: 't', version: '0' } } });
  assert.equal(init.body.error?.code, -32602, init.text);
  // tool-level validation failures remain tool results (isError), not protocol errors
  const bad = await post(`${S.base}/mcp`, { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'check_credit_score', arguments: { network: NET, address: '0x1' } } });
  assert.equal(bad.body.result?.isError, true);
});

test('H-10: trust-proxy hop count keys the limiter on the real client, spoofed XFF entries are ignored, chain is logged', async () => {
  // Simulates Railway: client -> edge (appends client IP) -> internal hop (appends edge IP) -> app. Two trusted hops.
  const S = await boot({ SPECULAR_TRUST_PROXY: '2', SPECULAR_RATE_LIMIT_PER_MIN: '3' });
  const hit = (xff) => json(`${S.base}/v1/networks`, { headers: { 'x-forwarded-for': xff } });
  // same real client, different spoofed prefixes -> one bucket
  const codes = [];
  for (let i = 1; i <= 5; i++) codes.push((await hit(`1.1.1.${i}, 203.0.113.7, 152.233.76.10`)).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  // a different real client behind the same edge is NOT locked out
  assert.equal((await hit('203.0.113.8, 152.233.76.10')).status, 200);
  // the raw chain is in the access log (IPs only, no bodies) and the resolved ip is the client
  await new Promise((r) => setTimeout(r, 200));
  const line = S.logs().split('\n').find((l) => l.includes('"xff":"203.0.113.8, 152.233.76.10"'));
  assert.ok(line, 'xff chain logged');
  assert.match(line, /"ip":"203.0.113.8"/);

  // With ONE trusted hop (the previous Railway default) the edge IP becomes the key: everyone shares a bucket.
  const T = await boot({ SPECULAR_TRUST_PROXY: '1', SPECULAR_RATE_LIMIT_PER_MIN: '3' });
  const hit1 = (xff) => json(`${T.base}/v1/networks`, { headers: { 'x-forwarded-for': xff } });
  for (let i = 1; i <= 3; i++) await hit1(`203.0.113.${i}, 152.233.76.10`);
  assert.equal((await hit1('203.0.113.99, 152.233.76.10')).status, 429, 'hop=1 keys on the edge IP (documents the bug)');
});

test('H-12: a dead/hung RPC is a 502, never a fabricated "transaction would revert" carrying the endpoint', async () => {
  const S = await boot({ SPECULAR_RPC_ARC_STAGING: 'http://127.0.0.1:1/', SPECULAR_RPC_TIMEOUT_MS: '2000', SPECULAR_RPC_MAX_ATTEMPTS: '1' });
  const nets = await json(`${S.base}/v1/networks`);
  const marketplace = nets.body.networks[0].contracts.marketplace;
  const data = new ethers.Interface(['function requestLoan(uint256,uint256)']).encodeFunctionData('requestLoan', [1_000_000n, 7n]);

  const sim = await json(`${S.base}/v1/${NET}/tx/simulate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ from: AGENT, to: marketplace, data }),
  });
  assert.equal(sim.status, 502, sim.text);
  assert.match(sim.body.error, /unreachable or timed out/);
  assert.doesNotMatch(sim.text, /ECONNREFUSED|127\.0\.0\.1|revertReason|would revert/, sim.text);

  // and via MCP the same failure is a tool error, not a false "ok:false" simulation,
  // and its message is sanitised too (H-13: unexpected errors used to go back verbatim).
  const mcp = await post(`${S.base}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'simulate_transaction', arguments: { network: NET, from: AGENT, to: marketplace, data } } });
  assert.equal(mcp.body.result?.isError, true, mcp.text);
  assert.doesNotMatch(mcp.text, /ECONNREFUSED|127\.0\.0\.1:1|version=/, mcp.text);
  assert.match(mcp.text, /unreachable or timed out/, mcp.text);
}, { timeout: 30_000 });

test('H-11: REST/MCP error bodies never carry ethers internals', async () => {
  const S = await boot({});
  const r = await post(`${S.base}/v1/${NET}/tx/broadcast`, { signedTransaction: '0xdeadbeef' });
  assert.equal(r.status, 400, r.text);
  assert.doesNotMatch(r.text, /version=|BUFFER_OVERRUN|buffer=0x/, r.text);
  const m = await post(`${S.base}/mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'broadcast_signed_transaction', arguments: { network: NET, signedTransaction: '0xdeadbeef' } } });
  assert.equal(m.body.result?.isError, true, m.text);
  assert.doesNotMatch(m.text, /version=|BUFFER_OVERRUN/, m.text);
}, { timeout: 30_000 });

test('H-14: JSON-RPC batch conformance — array shape, empty batch, and no zod dumps inside a batch', async () => {
  const S = await boot({});
  // a batch always answers with an ARRAY, even when only one member produces a response
  const mixed = await post(`${S.base}/mcp`, [
    { jsonrpc: '2.0', id: 1, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
  ]);
  assert.equal(mixed.status, 200, mixed.text);
  assert.ok(Array.isArray(mixed.body), mixed.text);
  assert.equal(mixed.body.length, 1);
  assert.equal(mixed.body[0].id, 1);

  // a plain (non-batch) request still answers with an OBJECT
  const single = await post(`${S.base}/mcp`, { jsonrpc: '2.0', id: 9, method: 'ping' });
  assert.ok(!Array.isArray(single.body), single.text);
  assert.equal(single.body.id, 9);

  // an empty batch is an Invalid Request (JSON-RPC 2.0 §6), not a 202
  const empty = await post(`${S.base}/mcp`, []);
  assert.equal(empty.status, 400, empty.text);
  assert.equal(empty.body.error?.code, -32600);

  // a malformed tools/call INSIDE a batch is -32602, not -32603 with a raw zod issue list
  const bad = await post(`${S.base}/mcp`, [{ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 42 } }]);
  assert.ok(Array.isArray(bad.body), bad.text);
  assert.equal(bad.body[0].error?.code, -32602, bad.text);
  assert.doesNotMatch(bad.text, /invalid_type|"path"\s*:/, bad.text);

  // full batches keep every response and correlate ids
  const three = await post(`${S.base}/mcp`, [1, 2, 3].map((id) => ({ jsonrpc: '2.0', id, method: 'ping' })));
  assert.deepEqual(three.body.map((r) => r.id), [1, 2, 3]);

  // normal tool traffic is untouched by the response rewriter
  const tool = await post(`${S.base}/mcp`, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'list_networks', arguments: {} } });
  assert.ok(tool.body.result?.structuredContent?.networks?.length >= 1, tool.text);
}, { timeout: 30_000 });
