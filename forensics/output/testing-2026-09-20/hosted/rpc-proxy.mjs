/**
 * Counting / fault-injecting JSON-RPC proxy.
 *
 * Sits between the Specular agent server and a real upstream RPC so a load test
 * can measure EXACTLY how many upstream calls a workload produces, and so
 * failure modes (429, 500, connection refused, slow, hang) can be reproduced
 * deterministically without waiting for a public provider to throttle us.
 *
 *   node rpc-proxy.mjs --port 8545 --upstream https://rpc.testnet.arc.io [--fault ...]
 *
 * Control plane (same port):
 *   GET  /__stats          -> {total, byMethod, sinceMs}
 *   POST /__reset          -> zero the counters
 *   POST /__fault          -> {mode: "none"|"429"|"500"|"refuse"|"slow"|"hang", delayMs, forCalls}
 *
 * Anything else is treated as a JSON-RPC POST and forwarded upstream.
 */
import http from 'node:http';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const PORT = Number(opt('port', 8545));
const UPSTREAM = opt('upstream', 'https://rpc.testnet.arc.io');
const LABEL = opt('label', `proxy:${PORT}`);

let counters = { total: 0, byMethod: Object.create(null), startedAt: Date.now() };
/** @type {{mode:string, delayMs:number, forCalls:number}} */
let fault = { mode: opt('fault', 'none'), delayMs: Number(opt('delayMs', 30000)), forCalls: Number(opt('forCalls', -1)) };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/__stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ label: LABEL, upstream: UPSTREAM, total: counters.total, byMethod: counters.byMethod, upstreamNon200: counters.upstreamNon200 || 0, upstreamStatuses: counters.upstreamStatuses || {}, upstreamErrors: counters.upstreamErrors || 0, upstreamErrorKinds: counters.upstreamErrorKinds || {}, sinceMs: Date.now() - counters.startedAt, fault }));
    return;
  }
  if (url.pathname === '/__reset') {
    counters = { total: 0, byMethod: Object.create(null), startedAt: Date.now() };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
    return;
  }
  if (url.pathname === '/__fault') {
    const body = await readBody(req);
    try {
      const f = JSON.parse(body || '{}');
      fault = { mode: String(f.mode || 'none'), delayMs: Number(f.delayMs ?? 30000), forCalls: Number(f.forCalls ?? -1) };
    } catch { /* keep previous */ }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, fault }));
    return;
  }

  const body = await readBody(req);
  let parsed = null;
  try { parsed = JSON.parse(body); } catch { /* not JSON */ }
  const calls = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  // Count ONE upstream call per JSON-RPC member (a batch of 3 is 3 calls).
  for (const c of calls) {
    counters.total++;
    const m = typeof c?.method === 'string' ? c.method : 'unknown';
    counters.byMethod[m] = (counters.byMethod[m] || 0) + 1;
  }

  // ---- fault injection ----
  if (fault.forCalls === 0) fault = { ...fault, mode: 'none' };
  const active = fault.mode !== 'none' && (fault.forCalls < 0 || fault.forCalls > 0);
  if (active && fault.forCalls > 0) fault = { ...fault, forCalls: fault.forCalls - 1 };
  if (active) {
    if (fault.mode === '429') {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '5' });
      res.end('{"error":{"code":429,"message":"Too many requests"}}');
      return;
    }
    if (fault.mode === '500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":{"code":-32000,"message":"internal upstream error"}}');
      return;
    }
    if (fault.mode === 'refuse') {
      req.socket.destroy();
      return;
    }
    if (fault.mode === 'slow') {
      await sleep(fault.delayMs);
    }
    if (fault.mode === 'hang') {
      return; // never respond, never close
    }
  }

  try {
    const r = await fetch(UPSTREAM, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    if (r.status !== 200) {
      counters.upstreamNon200 = (counters.upstreamNon200 || 0) + 1;
      counters.upstreamStatuses = counters.upstreamStatuses || Object.create(null);
      counters.upstreamStatuses[r.status] = (counters.upstreamStatuses[r.status] || 0) + 1;
    }
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' });
    res.end(text);
  } catch (e) {
    counters.upstreamErrors = (counters.upstreamErrors || 0) + 1;
    counters.upstreamErrorKinds = counters.upstreamErrorKinds || Object.create(null);
    const k = String(e?.cause?.code || e?.name || 'error');
    counters.upstreamErrorKinds[k] = (counters.upstreamErrorKinds[k] || 0) + 1;
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: -32000, message: `proxy upstream failed: ${e?.message}` } }));
  }
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.listen(PORT, '127.0.0.1', () => {
  console.log(JSON.stringify({ msg: 'rpc-proxy listening', port: PORT, upstream: UPSTREAM, label: LABEL }));
});
