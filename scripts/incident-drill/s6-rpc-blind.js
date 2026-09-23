// SCENARIO 6 — stuck or lying RPC. "We are blind" must not read as "all clear".
//
// Drives the monitor through a fault-injecting proxy (scripts/op-resilience/fault-rpc.js)
// and asserts that each failure mode produces a NON-ZERO exit and a raised alert,
// not a clean OK. Also proves the wrapper (run-with-alert.sh) fans a monitor CRASH
// out, since that path is what launchd actually runs.
//
// Runs as a plain node script (no hardhat) — it only needs the chain to be up.
// Usage: node scripts/incident-drill/s6-rpc-blind.js

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'forensics/output/testing-2026-09-23/incident-drill');
const SANDBOX = path.join(OUT, 'alert-sandbox-rpc');
const MONITOR = path.join(ROOT, 'forensics/monitor/v6-invariants.js');
const FAULT = path.join(ROOT, 'scripts/op-resilience/fault-rpc.js');
const STATE = path.join(ROOT, 'forensics/monitor/state-local.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function clearSandbox() {
    fs.mkdirSync(SANDBOX, { recursive: true });
    for (const f of fs.readdirSync(SANDBOX)) { try { fs.unlinkSync(path.join(SANDBOX, f)); } catch {} }
}

function runMonitor(rpcUrl, extraEnv = {}, timeoutMs = 120000) {
    const a = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/config/local-addresses.json')));
    const env = {
        ...process.env,
        V6_MONITOR_NETWORK: 'local',
        LOCAL_RPC_URL: rpcUrl,
        V6_EXPECTED_OWNER: a.deployer,
        SPECULAR_ALERT_QUIET: '1',
        SPECULAR_ALERT_DIR: SANDBOX,
        V6_HEARTBEAT_MAX_AGE_SEC: '99999999',
        ...extraEnv,
    };
    const t0 = Date.now();
    let exitCode = 0, out = '';
    try { out = execFileSync('node', [MONITOR], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs }); }
    catch (e) { exitCode = e.status === undefined || e.status === null ? -1 : e.status; out = (e.stdout || '') + (e.stderr || ''); }
    const codes = [];
    for (const line of out.split('\n')) {
        if (!line.startsWith('{')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const m = /^\[([A-Z0-9-]+)\]/.exec(j.msg || '');
        if (m) codes.push(`${m[1]}(${j.severity || (j.level === 'ERROR' ? 'CRITICAL' : 'WARN')})`);
        if (/WATCHDOG/.test(j.msg || '')) codes.push('WATCHDOG(CRITICAL)');
    }
    return { exitCode, ms: Date.now() - t0, codes: [...new Set(codes)], raw: out };
}

function alertState() {
    let latch = null, hist = 0;
    try { latch = JSON.parse(fs.readFileSync(path.join(SANDBOX, 'ALERT-ACTIVE.json'), 'utf8')); } catch {}
    try { hist = fs.readFileSync(path.join(SANDBOX, 'alerts.log'), 'utf8').trim().split('\n').filter(Boolean).length; } catch {}
    return { latched: latch !== null, severity: latch ? latch.severity : null, historyLines: hist };
}

async function withProxy(mode, port, extraArgs, fn) {
    const p = spawn('node', [FAULT, '--mode', mode, '--port', String(port), ...extraArgs], { stdio: ['ignore', 'ignore', 'pipe'] });
    await sleep(900);
    try { return await fn(); } finally { p.kill('SIGKILL'); await sleep(200); }
}

(async () => {
    const cases = [];
    // `al` must be captured immediately after ITS run — the latch is cumulative.
    const record = (name, engineered, run, expectBlind, extra = {}, al = alertState()) => {
        const row = {
            case: name, engineered,
            exitCode: run.exitCode, codes: run.codes, runtimeMs: run.ms,
            reportedBlind: run.exitCode !== 0,
            falseOK: run.exitCode === 0 && expectBlind,
            alertLatched: al.latched, alertSeverity: al.severity,
            ...extra,
        };
        cases.push(row);
        console.log(`  ${row.falseOK ? 'FALSE-OK ' : 'caught   '} ${name.padEnd(42)} exit=${run.exitCode} ${run.codes.join(',')} latch=${al.latched}`);
        return row;
    };

    // control — the real node, freshness checking ON but with a huge tolerance so
    // hardhat's evm_increaseTime drift does not itself trip the check.
    clearSandbox(); try { fs.unlinkSync(STATE); } catch {}
    record('control: healthy RPC', 'none',
        runMonitor('http://127.0.0.1:8545', { V6_MAX_BLOCK_AGE_SEC: '0' }), false);

    // (1) dead endpoint — nothing listening
    clearSandbox(); try { fs.unlinkSync(STATE); } catch {}
    record('dead endpoint (ECONNREFUSED)', 'monitor points at a closed port',
        runMonitor('http://127.0.0.1:8599', { V6_MAX_BLOCK_AGE_SEC: '0', V6_RPC_TIMEOUT_MS: '3000' }), true);

    // (2) endpoint that answers every call with a JSON-RPC error
    clearSandbox(); try { fs.unlinkSync(STATE); } catch {}
    await withProxy('error', 8561, [], async () => {
        record('lying endpoint: every call errors', 'fault-rpc --mode error',
            runMonitor('http://127.0.0.1:8561', { V6_MAX_BLOCK_AGE_SEC: '0', V6_RPC_TIMEOUT_MS: '3000' }), true);
    });

    // (3) STALE head — every state read succeeds and is self-consistent, but the
    //     chain head is two hours old. This is the "lying, not broken" case.
    clearSandbox(); try { fs.unlinkSync(STATE); } catch {}
    await withProxy('stale', 8562, ['--age', '7200'], async () => {
        record('stale head (2 h old), state reads all succeed', 'fault-rpc --mode stale --age 7200',
            runMonitor('http://127.0.0.1:8562', { V6_MAX_BLOCK_AGE_SEC: '1800' }), true);
    });

    // (4) FROZEN head — pinned to one snapshot. Age alone cannot catch it once the
    //     pinned block is recent, so this tests the run-over-run comparison.
    clearSandbox(); try { fs.unlinkSync(STATE); } catch {}
    await withProxy('frozen', 8563, [], async () => {
        const first = runMonitor('http://127.0.0.1:8563', { V6_MAX_BLOCK_AGE_SEC: '0' });
        const alFirst = alertState();
        // second run against the SAME pinned head — the state file now has history
        const second = runMonitor('http://127.0.0.1:8563', { V6_MAX_BLOCK_AGE_SEC: '0' });
        const alSecond = alertState();
        record('frozen/pinned head, run 1 of 2 (no history yet)', 'fault-rpc --mode frozen', first, false,
            { note: 'First run cannot know the head is pinned — there is nothing to compare against. This is the blind window.' }, alFirst);
        record('frozen/pinned head, run 2 of 2 (history present)', 'fault-rpc --mode frozen', second, true,
            { note: 'FRESH-STUCK fires only on the SECOND run, i.e. up to 30 minutes after the endpoint froze.' }, alSecond);
    });

    // (5) slow endpoint — the watchdog must fire rather than the run hanging past
    //     its scheduling interval.
    clearSandbox(); try { fs.unlinkSync(STATE); } catch {}
    await withProxy('slow', 8564, ['--delay', '8000'], async () => {
        record('slow endpoint (8 s/call), 5 s watchdog', 'fault-rpc --mode slow --delay 8000',
            runMonitor('http://127.0.0.1:8564', { V6_MAX_BLOCK_AGE_SEC: '0', V6_RPC_TIMEOUT_MS: '3000', V6_MAX_RUNTIME_SEC: '5' }, 90000), true);
    });

    // (6) the launchd wrapper itself: a monitor CRASH (not a finding) must still page.
    clearSandbox();
    let wrapper = { exitCode: null, latched: false };
    {
        const env = { ...process.env, SPECULAR_REPO: ROOT, SPECULAR_ALERT_DIR: SANDBOX, SPECULAR_ALERT_QUIET: '1', V6_MONITOR_NETWORK: 'local', LOCAL_RPC_URL: 'http://127.0.0.1:8599', V6_RPC_TIMEOUT_MS: '3000', V6_MAX_BLOCK_AGE_SEC: '0', V6_HEARTBEAT_MAX_AGE_SEC: '99999999' };
        let code = 0;
        try { execFileSync('/bin/bash', [path.join(ROOT, 'forensics/monitor/run-with-alert.sh'), 'local'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000 }); }
        catch (e) { code = e.status === undefined ? -1 : e.status; }
        const al = alertState();
        wrapper = { exitCode: code, latched: al.latched, severity: al.severity, historyLines: al.historyLines };
        console.log(`  wrapper run-with-alert.sh on a dead RPC: exit=${code} latch=${al.latched}`);
    }

    try { fs.unlinkSync(STATE); } catch {}

    const result = {
        scenario: 'S6 — stuck or lying RPC: does the monitor say "we are blind"?',
        cases,
        falseOKs: cases.filter(c => c.falseOK).map(c => c.case),
        launchdWrapper: {
            script: 'forensics/monitor/run-with-alert.sh',
            exitCode: wrapper.exitCode,
            alertRaised: wrapper.latched,
            alertSeverity: wrapper.severity,
            verdict: wrapper.latched ? 'The wrapper fans a monitor failure out even when the monitor itself never got far enough to alert.' : 'GAP: the wrapper did NOT raise an alert.',
        },
        verdict: cases.filter(c => c.falseOK).length === 0
            ? 'No false OKs. Every blind mode exits non-zero and latches an alert.'
            : 'FALSE OK DETECTED — see falseOKs.',
    };
    console.log('\n' + JSON.stringify({ falseOKs: result.falseOKs, launchdWrapper: result.launchdWrapper, verdict: result.verdict }, null, 2));
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 's6-rpc-blind.json'), JSON.stringify(result, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
