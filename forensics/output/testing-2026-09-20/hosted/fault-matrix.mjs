/**
 * Failure-mode matrix (2026-09-22).
 *
 * Drives the counting proxy through each injected upstream fault and records
 * what ONE `/v1/{net}/status` request does: status code, wall time, body.
 *
 *   node fault-matrix.mjs <baseUrl> <network> <proxyA[,proxyB]> <tag>
 *
 * Run once against the pre-change build and once against the fixed build.
 */
const BASE = process.argv[2] || 'http://127.0.0.1:3400';
const NET = process.argv[3] || 'arc-staging';
const PROXIES = (process.argv[4] || 'http://127.0.0.1:8545').split(',').map((s) => s.trim()).filter(Boolean);
const TAG = process.argv[5] || 'run';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setFault(proxy, body) {
  await fetch(`${proxy}/__fault`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
async function stats(proxy) {
  return (await (await fetch(`${proxy}/__stats`)).json());
}

async function probe(path = `/v1/${NET}/status`) {
  const t = Date.now();
  try {
    const r = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(400_000) });
    const text = await r.text();
    let err = null;
    try { err = JSON.parse(text).error ?? null; } catch { err = text.slice(0, 120); }
    return { ms: Date.now() - t, status: r.status, retryAfter: r.headers.get('retry-after'), error: typeof err === 'string' ? err.slice(0, 160) : null };
  } catch (e) {
    return { ms: Date.now() - t, status: 'client-abort', error: String(e?.name || e) };
  }
}

const CASES = [
  { name: '429 Too Many Requests (all endpoints)', fault: { mode: '429' }, all: true },
  { name: '500 upstream error (all endpoints)', fault: { mode: '500' }, all: true },
  { name: 'connection refused / socket destroyed (all endpoints)', fault: { mode: 'refuse' }, all: true },
  { name: 'slow upstream, 30 s per call (all endpoints)', fault: { mode: 'slow', delayMs: 30_000 }, all: true },
  { name: 'hung upstream, never answers (all endpoints)', fault: { mode: 'hang' }, all: true },
  { name: 'primary endpoint 429, secondary healthy', fault: { mode: '429' }, all: false },
  { name: 'primary endpoint hangs, secondary healthy', fault: { mode: 'hang' }, all: false },
];

const rows = [];
for (const c of CASES) {
  if (!c.all && PROXIES.length < 2) continue;
  // reset health: clear faults, wait out any backoff, warm the endpoints
  for (const p of PROXIES) await setFault(p, { mode: 'none' });
  await sleep(6_000);
  await probe(); // warm / recover
  await sleep(500);

  const targets = c.all ? PROXIES : [PROXIES[0]];
  for (const p of targets) await setFault(p, c.fault);
  // let any cached answer expire so the request must reach the upstream
  await sleep(6_000);

  const first = await probe();
  const second = await probe();
  const up = await Promise.all(PROXIES.map(stats));
  rows.push({
    case: c.name,
    first,
    second,
    upstreamCallsByEndpoint: up.map((u) => ({ upstream: u.upstream, total: u.total })),
  });
  console.log(
    `${c.name.padEnd(52)} first: ${String(first.status).padStart(12)} in ${String(first.ms).padStart(7)}ms | repeat: ${String(second.status).padStart(12)} in ${String(second.ms).padStart(7)}ms | ${first.error ?? ''}`,
  );
}
for (const p of PROXIES) await setFault(p, { mode: 'none' });

const fs = await import('node:fs');
const out = new URL(`./fault-matrix-${TAG}.json`, import.meta.url).pathname;
fs.writeFileSync(out, JSON.stringify({ base: BASE, network: NET, tag: TAG, at: new Date().toISOString(), rows }, null, 1));
console.log(`\nresults -> ${out}`);
