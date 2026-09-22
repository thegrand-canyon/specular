/**
 * RPC-resilience load harness (2026-09-22).
 *
 * Same scenario shape as load.mjs (health / status / mcp_read / prepare_simulate
 * at concurrency 1, 5, 20) but it ALSO reads the counting proxy's /__stats
 * before and after every cell, so each row carries the number of upstream
 * JSON-RPC calls the cell actually produced.
 *
 *   node rpc-load.mjs <baseUrl> <network> <proxyStatsUrl> <outTag>
 */
const BASE = process.argv[2] || 'http://127.0.0.1:3400';
const NET = process.argv[3] || 'arc-staging';
const PROXIES = (process.argv[4] || 'http://127.0.0.1:8545').split(',').map((s) => s.trim()).filter(Boolean);
const TAG = process.argv[5] || 'run';
const AGENT = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';

const MCP_H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

const SCENARIOS = {
  health: () => ({ url: `${BASE}/health` }),
  status: () => ({ url: `${BASE}/v1/${NET}/status` }),
  mcp_read: () => ({
    url: `${BASE}/mcp`,
    init: { method: 'POST', headers: MCP_H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_protocol_status', arguments: { network: NET } } }) },
  }),
  prepare_simulate: () => ({
    url: `${BASE}/v1/${NET}/tx/prepare/request_loan`,
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: AGENT, amount: 5, durationDays: 7, simulate: true }) },
  }),
};

function pct(sorted, p) {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

async function upstreamTotal() {
  try {
    const all = await Promise.all(PROXIES.map(async (p) => (await (await fetch(`${p}/__stats`)).json()).total));
    return all.reduce((a, b) => a + b, 0);
  } catch {
    return null;
  }
}

async function cell(name, concurrency, total) {
  const make = SCENARIOS[name];
  const lat = [];
  const codes = new Map();
  let errors = 0;
  let done = 0;
  const up0 = await upstreamTotal();
  const started = Date.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (done < total) {
        done++;
        const { url, init } = make();
        const t = Date.now();
        try {
          const r = await fetch(url, init);
          await r.text();
          lat.push(Date.now() - t);
          codes.set(r.status, (codes.get(r.status) || 0) + 1);
          if (r.status >= 400) errors++;
        } catch {
          lat.push(Date.now() - t);
          codes.set('net-error', (codes.get('net-error') || 0) + 1);
          errors++;
        }
      }
    }),
  );
  const wall = Date.now() - started;
  const up1 = await upstreamTotal();
  const s = [...lat].sort((a, b) => a - b);
  const upstream = up0 !== null && up1 !== null ? up1 - up0 : null;
  const row = {
    scenario: name,
    concurrency,
    requests: lat.length,
    wallMs: wall,
    rps: Number((lat.length / (wall / 1000)).toFixed(1)),
    p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s[s.length - 1],
    errorRate: Number(((errors / lat.length) * 100).toFixed(1)),
    upstreamCalls: upstream,
    upstreamPerRequest: upstream === null ? null : Number((upstream / lat.length).toFixed(2)),
    statuses: Object.fromEntries([...codes.entries()].map(([k, v]) => [String(k), v])),
  };
  console.log(
    `${name.padEnd(17)} c=${String(concurrency).padStart(3)}  n=${String(row.requests).padStart(4)}  ` +
    `p50=${String(row.p50).padStart(6)}ms p95=${String(row.p95).padStart(6)}ms p99=${String(row.p99).padStart(6)}ms max=${String(row.max).padStart(6)}ms  ` +
    `${String(row.rps).padStart(7)} rps  err=${String(row.errorRate).padStart(5)}%  up=${String(row.upstreamCalls).padStart(5)} (${row.upstreamPerRequest}/req)  ${JSON.stringify(row.statuses)}`,
  );
  return row;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = [];
for (const name of ['health', 'status', 'mcp_read', 'prepare_simulate']) {
  for (const c of [1, 5, 20]) {
    rows.push(await cell(name, c, 25));
    await sleep(1500);
  }
}

// Mixed realistic workload: the four scenarios interleaved, concurrency 10, 120 requests.
{
  const names = Object.keys(SCENARIOS);
  const lat = [];
  const codes = new Map();
  let done = 0;
  let errors = 0;
  const TOTAL = 120;
  const up0 = await upstreamTotal();
  const started = Date.now();
  await Promise.all(
    Array.from({ length: 10 }, async () => {
      while (done < TOTAL) {
        const i = done++;
        const { url, init } = SCENARIOS[names[i % names.length]]();
        const t = Date.now();
        try {
          const r = await fetch(url, init);
          await r.text();
          lat.push(Date.now() - t);
          codes.set(r.status, (codes.get(r.status) || 0) + 1);
          if (r.status >= 400) errors++;
        } catch {
          lat.push(Date.now() - t);
          codes.set('net-error', (codes.get('net-error') || 0) + 1);
          errors++;
        }
      }
    }),
  );
  const wall = Date.now() - started;
  const up1 = await upstreamTotal();
  const s = [...lat].sort((a, b) => a - b);
  const upstream = up0 !== null && up1 !== null ? up1 - up0 : null;
  const row = {
    scenario: 'mixed', concurrency: 10, requests: lat.length, wallMs: wall,
    rps: Number((lat.length / (wall / 1000)).toFixed(1)),
    p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s[s.length - 1],
    errorRate: Number(((errors / lat.length) * 100).toFixed(1)),
    upstreamCalls: upstream,
    upstreamPerRequest: upstream === null ? null : Number((upstream / lat.length).toFixed(2)),
    statuses: Object.fromEntries([...codes.entries()].map(([k, v]) => [String(k), v])),
  };
  console.log(
    `${'mixed'.padEnd(17)} c=${String(10).padStart(3)}  n=${String(row.requests).padStart(4)}  ` +
    `p50=${String(row.p50).padStart(6)}ms p95=${String(row.p95).padStart(6)}ms p99=${String(row.p99).padStart(6)}ms max=${String(row.max).padStart(6)}ms  ` +
    `${String(row.rps).padStart(7)} rps  err=${String(row.errorRate).padStart(5)}%  up=${String(row.upstreamCalls).padStart(5)} (${row.upstreamPerRequest}/req)  ${JSON.stringify(row.statuses)}`,
  );
  rows.push(row);
}

const fs = await import('node:fs');
const out = new URL(`./rpc-load-${TAG}.json`, import.meta.url).pathname;
const totalUp = rows.reduce((a, r) => a + (r.upstreamCalls || 0), 0);
const totalReq = rows.reduce((a, r) => a + r.requests, 0);
console.log(`\nTOTAL requests=${totalReq} upstreamCalls=${totalUp} (${(totalUp / totalReq).toFixed(2)}/req)`);
fs.writeFileSync(out, JSON.stringify({ base: BASE, network: NET, tag: TAG, at: new Date().toISOString(), totalRequests: totalReq, totalUpstreamCalls: totalUp, rows }, null, 1));
console.log(`results -> ${out}`);
