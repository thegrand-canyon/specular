// Track E — API stress test on tx-builder endpoints.
// 500 concurrent POST /tx/request-loan requests in waves of 50 concurrent.
// Measures throughput, p50/p95/p99 latency, error rate.

const { spawn } = require('child_process');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const PORT = 3096;
const URL = `http://127.0.0.1:${PORT}`;
const OUT = './forensics/output/regression-2026-05-07';
const TOTAL = 500;
const CONCURRENT = 50; // max in-flight at once

let server;

async function waitForServer(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await fetch(`${URL}/health?network=arc`);
            if (r.status < 500) return;
        } catch {}
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('API never started');
}

async function makeRequest() {
    const t0 = performance.now();
    const amount = String(Math.floor(Math.random() * 100000) + 100);
    const durationDays = 7 + Math.floor(Math.random() * 30);
    try {
        const r = await fetch(`${URL}/tx/request-loan?network=arc`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount, durationDays }),
        });
        const elapsed = performance.now() - t0;
        const body = await r.json();
        return { ok: r.status === 200, elapsed, status: r.status, hasData: !!body.data };
    } catch (e) {
        return { ok: false, elapsed: performance.now() - t0, error: e.message };
    }
}

async function runWave(n) {
    const promises = [];
    for (let i = 0; i < n; i++) promises.push(makeRequest());
    return await Promise.all(promises);
}

(async () => {
    console.log(`=== Track E: API stress (${TOTAL} reqs, ${CONCURRENT} concurrent) ===`);
    console.log('Spawning API on port', PORT);
    server = spawn('node', [path.join(__dirname, '..', '..', 'src', 'api', 'MultiNetworkAPI.js')], {
        env: { ...process.env, PORT: String(PORT), ENABLE_CACHE: 'false' },
        stdio: ['ignore', 'ignore', 'ignore'],
    });
    try {
        await waitForServer();
        console.log('API ready.\n');

        const allResults = [];
        const startMs = Date.now();
        let sent = 0;
        while (sent < TOTAL) {
            const batchSize = Math.min(CONCURRENT, TOTAL - sent);
            const wave = await runWave(batchSize);
            allResults.push(...wave);
            sent += batchSize;
            if (sent % 100 === 0 || sent === TOTAL) {
                const elapsedSec = (Date.now() - startMs) / 1000;
                console.log(`  ${sent}/${TOTAL} reqs sent (${(sent/elapsedSec).toFixed(1)} req/s)`);
            }
        }
        const totalElapsed = (Date.now() - startMs) / 1000;

        // Stats
        const ok = allResults.filter(r => r.ok);
        const err = allResults.filter(r => !r.ok);
        const latencies = ok.map(r => r.elapsed).sort((a, b) => a - b);
        const pct = (p) => latencies[Math.floor(latencies.length * p / 100)] || 0;

        console.log(`\n=== RESULTS ===`);
        console.log(`Total: ${TOTAL}, OK: ${ok.length}, Errors: ${err.length}`);
        console.log(`Elapsed: ${totalElapsed.toFixed(1)}s, throughput: ${(TOTAL / totalElapsed).toFixed(1)} req/s`);
        console.log(`Latency (ms): p50=${pct(50).toFixed(1)}, p95=${pct(95).toFixed(1)}, p99=${pct(99).toFixed(1)}, max=${pct(100).toFixed(1)}`);
        console.log(`All returned valid calldata: ${ok.every(r => r.hasData)}`);
        if (err.length > 0) {
            const errSample = err.slice(0, 5).map(e => e.error || `status ${e.status}`);
            console.log(`Error sample: ${JSON.stringify(errSample)}`);
        }

        fs.writeFileSync(path.join(OUT, '44-load-e-api-stress.json'), JSON.stringify({
            total: TOTAL, concurrent: CONCURRENT,
            ok: ok.length, errors: err.length,
            throughput_req_per_sec: TOTAL / totalElapsed,
            elapsed_sec: totalElapsed,
            latency_ms: { p50: pct(50), p95: pct(95), p99: pct(99), max: pct(100) },
            all_valid: ok.every(r => r.hasData),
        }, null, 2));
        console.log('\nSaved.');
    } finally {
        if (server && !server.killed) server.kill('SIGTERM');
    }
})().catch(e => { console.error('FATAL:', e); if (server) server.kill('SIGTERM'); process.exit(2); });
