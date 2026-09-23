#!/usr/bin/env node
//
// Specular alert fan-out — the "somebody actually finds out" layer.
//
// Before this existed a violation wrote a JSON line into a log file nobody reads
// and exited non-zero into launchd, which discards the status. This module is the
// single place that turns a detected violation into something a human sees.
//
// Channels (all best-effort, all free, all local — no paid service required):
//   1. ALERT-ACTIVE.json  — a latched file in forensics/monitor/. Its presence means
//                           "there is an unacknowledged incident". Never auto-deleted;
//                           an operator clears it with `node alert.js --ack`.
//   2. alerts.log         — append-only JSONL history of every alert ever raised.
//   3. macOS notification — osascript banner + (for CRITICAL) a spoken alert, so a
//                           logged-in operator is interrupted rather than informed.
//   4. ~/SPECULAR-ALERT.txt — plain-text file in the home dir, hard to miss in a shell.
//   5. Webhook            — ONLY if SPECULAR_ALERT_WEBHOOK is set. Opt-in, no default,
//                           nothing hardcoded. Slack/Discord-compatible JSON body.
//
// Also implements a dead-man's switch: every monitor run stamps a heartbeat file, and
// every run checks ALL known heartbeats. If a sibling job stops running, the next run
// of any other job raises a MONITOR_DOWN alert. (Nothing catches the case where every
// job is dead — see INCIDENT_RUNBOOK.md; that is what the weekly manual check is for.)
//
// CLI:
//   node alert.js <SEVERITY> <title> [jsonDetails]   raise an alert
//   node alert.js --ack                              clear the latch
//   node alert.js --status                           print latch + heartbeat state
//   node alert.js --self-test                        raise a harmless TEST alert
//
// Env:
//   SPECULAR_ALERT_WEBHOOK   opt-in webhook URL (POST application/json)
//   SPECULAR_ALERT_QUIET=1   suppress the macOS banner/voice (used by test harnesses)
//   SPECULAR_ALERT_DIR       override the directory holding the alert artifacts

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const DIR = process.env.SPECULAR_ALERT_DIR || __dirname;
const ACTIVE = path.join(DIR, 'ALERT-ACTIVE.json');
const HISTORY = path.join(DIR, 'alerts.log');
// The home-dir flag is the channel an operator trips over in a shell, so its presence has
// to mean "there is a real unacknowledged incident".
// [2026-09-24] SPECULAR_ALERT_DIR sandboxed the latch and the history but NOT this file, so
// every drill and self-test appended to the operator's REAL ~/SPECULAR-ALERT.txt while the
// latch stayed clean — the two channels disagreed, and the louder one was the lying one.
// Honour the sandbox here too: a run with SPECULAR_ALERT_DIR set keeps its flag in the
// sandbox. Unset (i.e. every launchd job) behaves exactly as before.
const HOME_FLAG = process.env.SPECULAR_ALERT_DIR
    ? path.join(DIR, 'SPECULAR-ALERT.txt')
    : path.join(os.homedir(), 'SPECULAR-ALERT.txt');
const HEARTBEAT_DIR = DIR;

const QUIET = process.env.SPECULAR_ALERT_QUIET === '1';

function notifyMac(severity, title, line) {
    if (QUIET || process.platform !== 'darwin') return;
    const safe = s => String(s).replace(/["\\]/g, ' ').slice(0, 200);
    const script = `display notification "${safe(line)}" with title "Specular ${safe(severity)}" subtitle "${safe(title)}" sound name "Basso"`;
    try { execFile('/usr/bin/osascript', ['-e', script], () => {}); } catch {}
    if (severity === 'CRITICAL') {
        try { execFile('/usr/bin/say', ['-v', 'Samantha', 'Specular critical invariant alert'], () => {}); } catch {}
    }
}

async function postWebhook(severity, title, details) {
    const url = process.env.SPECULAR_ALERT_WEBHOOK;
    if (!url) return { sent: false, reason: 'SPECULAR_ALERT_WEBHOOK unset' };
    const body = {
        text: `Specular ${severity}: ${title}`,
        username: 'specular-monitor',
        attachments: [{
            color: severity === 'CRITICAL' ? 'danger' : 'warning',
            title,
            text: '```' + JSON.stringify(details, null, 2).slice(0, 3000) + '```',
            ts: Math.floor(Date.now() / 1000),
        }],
    };
    try {
        const ctl = AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined;
        const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctl,
        });
        return { sent: r.ok, status: r.status };
    } catch (e) {
        return { sent: false, reason: e.message };
    }
}

/**
 * Raise an alert on every configured channel. Never throws — an alerting failure
 * must not mask the violation that triggered it.
 */
async function raise(severity, title, details = {}, opts = {}) {
    const entry = {
        ts: new Date().toISOString(),
        severity,
        title,
        network: details.network || process.env.V6_MONITOR_NETWORK || 'unknown',
        host: os.hostname(),
        details,
    };
    const channels = {};

    try { fs.appendFileSync(HISTORY, JSON.stringify(entry) + '\n'); channels.history = true; }
    catch (e) { channels.history = e.message; }

    // Latch: keep the FIRST unacknowledged alert, but record repeat count + latest.
    try {
        let latch = { firstSeen: entry.ts, count: 0, first: entry };
        if (fs.existsSync(ACTIVE)) {
            try { latch = JSON.parse(fs.readFileSync(ACTIVE, 'utf8')); } catch {}
        }
        latch.count = (latch.count || 0) + 1;
        latch.lastSeen = entry.ts;
        latch.latest = entry;
        latch.acknowledged = false;
        fs.writeFileSync(ACTIVE, JSON.stringify(latch, null, 2));
        channels.latch = true;
    } catch (e) { channels.latch = e.message; }

    const line = `${entry.ts} [${severity}] ${entry.network}: ${title}`;
    try {
        fs.appendFileSync(HOME_FLAG,
            `${line}\n${JSON.stringify(details, null, 2)}\n` +
            `-> runbook: forensics/monitor/INCIDENT_RUNBOOK.md\n` +
            `-> clear with: node forensics/monitor/alert.js --ack\n\n`);
        channels.homeFlag = HOME_FLAG;
    } catch (e) { channels.homeFlag = e.message; }

    notifyMac(severity, title, line);
    channels.macNotification = !QUIET && process.platform === 'darwin';

    channels.webhook = await postWebhook(severity, title, details);

    if (!opts.silent) console.log(JSON.stringify({ alert: entry, channels }));
    return { entry, channels };
}

// ---- heartbeat / dead-man's switch -------------------------------------------------

function heartbeatPath(network) { return path.join(HEARTBEAT_DIR, `heartbeat-${network}.json`); }

function stamp(network, extra = {}) {
    try {
        fs.writeFileSync(heartbeatPath(network), JSON.stringify({
            network, ts: new Date().toISOString(), epoch: Date.now(), ...extra,
        }, null, 2));
    } catch {}
}

/**
 * Check every heartbeat file in the directory. Any heartbeat older than
 * `maxAgeSec` means that monitor job has stopped running (launchd unloaded, node
 * missing, machine asleep past the window, …) — which is itself an incident,
 * because a monitor that is not running reports no violations.
 */
async function checkHeartbeats(maxAgeSec = 5400, selfNetwork = null) {
    const stale = [];
    let files = [];
    try { files = fs.readdirSync(HEARTBEAT_DIR).filter(f => /^heartbeat-.*\.json$/.test(f)); } catch {}
    for (const f of files) {
        const net = f.replace(/^heartbeat-/, '').replace(/\.json$/, '');
        if (net === selfNetwork) continue; // just stamped
        try {
            const hb = JSON.parse(fs.readFileSync(path.join(HEARTBEAT_DIR, f), 'utf8'));
            const ageSec = Math.round((Date.now() - hb.epoch) / 1000);
            if (ageSec > maxAgeSec) stale.push({ network: net, lastRun: hb.ts, ageSec, maxAgeSec });
        } catch {}
    }
    if (stale.length) {
        await raise('CRITICAL', 'MONITOR_DOWN: a sibling invariant monitor stopped running', { stale }, { silent: true });
    }
    return stale;
}

// ---- CLI ---------------------------------------------------------------------------

if (require.main === module) {
    const [a, b, c] = process.argv.slice(2);
    (async () => {
        if (a === '--ack') {
            let out = { acknowledged: false };
            if (fs.existsSync(ACTIVE)) {
                const latch = JSON.parse(fs.readFileSync(ACTIVE, 'utf8'));
                latch.acknowledged = true;
                latch.acknowledgedAt = new Date().toISOString();
                fs.appendFileSync(HISTORY, JSON.stringify({ ts: latch.acknowledgedAt, severity: 'INFO', title: 'ALERT ACKNOWLEDGED', details: { count: latch.count } }) + '\n');
                fs.unlinkSync(ACTIVE);
                out = { acknowledged: true, clearedCount: latch.count };
            }
            try { if (fs.existsSync(HOME_FLAG)) fs.unlinkSync(HOME_FLAG); } catch {}
            console.log(JSON.stringify(out));
            return;
        }
        if (a === '--status') {
            const latch = fs.existsSync(ACTIVE) ? JSON.parse(fs.readFileSync(ACTIVE, 'utf8')) : null;
            const beats = {};
            for (const f of (fs.existsSync(HEARTBEAT_DIR) ? fs.readdirSync(HEARTBEAT_DIR) : [])) {
                if (!/^heartbeat-.*\.json$/.test(f)) continue;
                const hb = JSON.parse(fs.readFileSync(path.join(HEARTBEAT_DIR, f), 'utf8'));
                beats[hb.network] = { lastRun: hb.ts, ageSec: Math.round((Date.now() - hb.epoch) / 1000), ...(hb.lastExitCode !== undefined ? { lastExitCode: hb.lastExitCode } : {}) };
            }
            console.log(JSON.stringify({ activeAlert: latch, heartbeats: beats, webhookConfigured: !!process.env.SPECULAR_ALERT_WEBHOOK }, null, 2));
            return;
        }
        if (a === '--self-test') {
            await raise('WARN', 'SELF TEST — alert path verification (not a real incident)', { note: 'triggered by --self-test' });
            return;
        }
        if (!a) { console.error('usage: alert.js <SEVERITY> <title> [jsonDetails] | --ack | --status | --self-test'); process.exit(64); }
        let details = {};
        if (c) { try { details = JSON.parse(c); } catch { details = { raw: c }; } }
        await raise(a, b || '(no title)', details);
    })();
}

module.exports = { raise, stamp, checkHeartbeats, ACTIVE, HISTORY, HOME_FLAG, heartbeatPath };
