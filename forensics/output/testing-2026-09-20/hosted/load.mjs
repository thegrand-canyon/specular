/**
 * Load harness for the Specular hosted agent server.
 *
 * node load.mjs <baseUrl> <profile>
 *   profile "live"  : moderate, paced, budgeted (<= ~400 requests, <= 40 req/min)
 *   profile "local" : heavy ramp to find the breaking point
 *
 * Reports p50/p95/p99/max latency, throughput and status breakdown per cell.
 */
const BASE = process.argv[2] || 'http://127.0.0.1:3400';
const PROFILE = process.argv[3] || 'local';
const NET = process.argv[4] || 'arc-mainnet';
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

async function cell(name, concurrency, total) {
  const make = SCENARIOS[name];
  const lat = [];
  const codes = new Map();
  let errors = 0;
  let done = 0;
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
        } catch (e) {
          lat.push(Date.now() - t);
          codes.set('net-error', (codes.get('net-error') || 0) + 1);
          errors++;
        }
      }
    }),
  );
  const wall = Date.now() - started;
  const s = [...lat].sort((a, b) => a - b);
  const row = {
    scenario: name,
    concurrency,
    requests: lat.length,
    wallMs: wall,
    rps: Number((lat.length / (wall / 1000)).toFixed(1)),
    p50: pct(s, 50), p95: pct(s, 95), p99: pct(s, 99), max: s[s.length - 1],
    errorRate: Number(((errors / lat.length) * 100).toFixed(1)),
    statuses: Object.fromEntries([...codes.entries()].map(([k, v]) => [String(k), v])),
  };
  console.log(
    `${name.padEnd(17)} c=${String(concurrency).padStart(3)}  n=${String(row.requests).padStart(4)}  ` +
    `p50=${String(row.p50).padStart(5)}ms p95=${String(row.p95).padStart(5)}ms p99=${String(row.p99).padStart(6)}ms max=${String(row.max).padStart(6)}ms  ` +
    `${String(row.rps).padStart(6)} rps  err=${row.errorRate}%  ${JSON.stringify(row.statuses)}`,
  );
  return row;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = [];
if (PROFILE === 'live') {
  // Budget: 4 scenarios x 3 concurrencies x 25 requests = 300 requests, paced under the
  // public 120 req/min per-IP limit. Never attempts to exhaust the service.
  for (const name of ['health', 'status', 'mcp_read', 'prepare_simulate']) {
    for (const c of [1, 5, 20]) {
      rows.push(await cell(name, c, 25));
      await sleep(20_000);   // stay well under 120 req/min
    }
  }
} else {
  // Local: separate server capacity (cached /health) from RPC-bound work, then ramp past
  // SPECULAR_MAX_INFLIGHT to observe load shedding.
  for (const c of [1, 5, 20, 50, 100, 200, 400]) rows.push(await cell('health', c, Math.max(200, c * 5)));
  for (const c of [1, 5, 20, 50, 100]) rows.push(await cell('status', c, Math.max(60, c * 3)));
  for (const c of [1, 5, 20, 50]) rows.push(await cell('mcp_read', c, Math.max(60, c * 3)));
  for (const c of [1, 5, 20]) rows.push(await cell('prepare_simulate', c, Math.max(30, c * 3)));
}

const out = new URL(`./load-${PROFILE}.json`, import.meta.url).pathname;
const fs = await import('node:fs');
fs.writeFileSync(out, JSON.stringify({ base: BASE, profile: PROFILE, network: NET, at: new Date().toISOString(), rows }, null, 1));
console.log(`\nresults -> ${out}`);
