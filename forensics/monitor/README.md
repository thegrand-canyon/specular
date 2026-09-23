# Specular monitoring

**What is actually running, what it watches, and how an alert reaches a human.**

> Rewritten 2026-09-24. The previous version of this file described `invariant-monitor.js`,
> a long-running daemon polling Base mainnet and Arc **testnet** for three v4-era bugs, and
> documented a `WEBHOOK_URL` env var that nothing reads any more. None of that has been the
> monitoring for months. `invariant-monitor.js` is kept only as historical context — nothing
> runs it.

Incident response: **`INCIDENT_RUNBOOK.md`** (start there when something fires).

---

## The five jobs that run on this machine

`launchctl list | grep specular`

| launchd label | runs | every | watches |
|---|---|---|---|
| `com.specular.v6-invariants-arc-mainnet` | `run-with-alert.sh arc-mainnet` | 30 min | the **canonical** Arc-mainnet marketplace (V6.2 + ReputationManagerV4) |
| `com.specular.v6-invariants-arc-mainnet-legacy` | `run-with-alert.sh arc-mainnet` with `V6_MONITOR_MARKETPLACE` | 30 min | the **superseded** V6.1 marketplace, still live and still authorized |
| `com.specular.v6-invariants-arc-staging` | `run-with-alert.sh arc-staging` | 30 min | the Arc-testnet staging stack |
| `com.specular.overdue-loans-arc-mainnet` | `run-overdue-check.sh arc-mainnet` | 60 min | ACTIVE loans past `endTime` (the invariant monitor has **no** overdue check) |
| `com.specular.rpc-health-sample` | `rpc-health-sample.sh` | 15 min | the hosted agent API's upstream-RPC health, appended to `rpc-health.jsonl` |

The plists live beside this file and are installed with `./install-v6-monitor.sh`. They
hardcode `/Users/peterschroeder/Specular`; edit the paths before installing elsewhere.

`com.specular.v6-invariants.plist` is the **retired** arc-testnet job. It is kept for
history and is deliberately not installed.

---

## Files

| file | role |
|---|---|
| `v6-invariants.js` | the checker. One run = one snapshot + 14 check families. Exit 0 clear / 1 violation / 2 could not complete. |
| `run-with-alert.sh` | launchd entry point. Fans **any** non-zero exit — including a crash the checker never got to report — into `alert.js`. |
| `check-overdue-loans.js` | read-only list of liquidation candidates. Exit 0 none / 1 some / 2 could not read. |
| `run-overdue-check.sh` | launchd entry point for the above. |
| `rpc-health-sample.sh` | one JSON line of hosted-API RPC health per run. |
| `alert.js` | the fan-out: latch file, `~/SPECULAR-ALERT.txt`, macOS banner (+ spoken CRITICAL), `alerts.log`, optional webhook. Also the dead-man's switch. |
| `INCIDENT_RUNBOOK.md` | what a human does when one of these fires. |
| `WEBHOOK_SETUP.md` / `webhook-test.js` | optional remote notification. |
| `invariant-monitor.js` | **historical** v4-era daemon. Not run by anything. |

---

## How an alert reaches you

1. `ALERT-ACTIVE.json` — a **latch**. Its existence means "unacknowledged incident".
   Never cleared automatically; clear it with `node alert.js --ack`.
2. `~/SPECULAR-ALERT.txt` — plain text in your home directory.
3. A macOS notification banner, plus a spoken alert for CRITICAL.
4. `alerts.log` — append-only JSONL history.
5. `SPECULAR_ALERT_WEBHOOK` — **only if you set it** in `monitor.env` (gitignored).
   Nothing is hardcoded. **It is not set on this machine today**, so every channel above is
   local: if nobody is logged in at this Mac, nobody is told. See `WEBHOOK_SETUP.md`.

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
node forensics/monitor/alert.js --status     # latch + a heartbeat per job
node forensics/monitor/alert.js --self-test  # prove the channels still work
node forensics/monitor/alert.js --ack        # clear the latch AFTER handling it
```

`SPECULAR_ALERT_DIR` sandboxes every artifact — latch, history, heartbeats **and** the
home-dir flag — so a drill cannot pollute the real channels.

---

## Running one by hand

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd ~/Specular

# canonical Arc mainnet, verbose, no alert fan-out
V6_MONITOR_NETWORK=arc-mainnet V6_EXPECTED_OWNER=0x800e305A0caDdE6289dFDFEDF38218f45C06F72C \
  node forensics/monitor/v6-invariants.js --verbose --no-alert

# a SUPERSEDED marketplace — always by ADDRESS. Superseded stacks live in the
# `supersededDeployments` LIST in the addresses file, so no fixed config key resolves them;
# V6_MONITOR_MARKETPLACE_KEY=<a key that does not exist> makes the monitor exit 2 and alert
# for ever while watching nothing.
V6_MONITOR_NETWORK=arc-mainnet V6_MONITOR_MARKETPLACE=0x358c5E69f712A4b3558333090a45A054bAeEb282 \
  node forensics/monitor/v6-invariants.js --no-alert

# overdue loans (read-only)
node forensics/monitor/check-overdue-loans.js            # NET=arc-staging|local to switch
```

### One network, several marketplaces

Setting `V6_MONITOR_MARKETPLACE` also gives that run its own **instance namespace** —
`state-<network>-<addr8>.json`, `v6-invariants-<network>-<addr8>.log`,
`heartbeat-<network>-<addr8>.json`.

That is not cosmetic. Before 2026-09-24 the two Arc-mainnet jobs shared one state file; the
legacy job ran ~30 s before the canonical job on every cycle and rewrote the shared state with
`creditPolicy: null` (a V3 reputation manager has no on-chain tier table), so the canonical
run never had a previous policy to compare against and **`CP-CHANGED` could never fire** —
the one signal a hostile owner key reliably produces. Override the namespace explicitly with
`V6_MONITOR_INSTANCE` if you need to.

---

## Env

| var | default | meaning |
|---|---|---|
| `V6_MONITOR_NETWORK` | `arc-testnet` | `arc-testnet` \| `arc-staging` \| `arc-mainnet` \| `local` |
| `V6_MONITOR_MARKETPLACE` | canonical pointer | watch this address instead; also namespaces state/log/heartbeat |
| `V6_MONITOR_INSTANCE` | derived | explicit namespace override |
| `V6_EXPECTED_OWNER` | `deployer` from the addresses file | pinned so an ownership change is detectable even if the repo is edited |
| `V6_EXPECT_PAUSED` | `0` | `1` when a pause is intentional |
| `V6_MAX_BLOCK_AGE_SEC` | `1800` | chain-head staleness threshold; `0` disables |
| `V6_MAX_RUNTIME_SEC` | `300` | watchdog; a run that outlives the interval delays the next one |
| `V6_RPC_TIMEOUT_MS` | `20000` | per-request timeout |
| `V6_SURPLUS_WARN_USDC` | `1` | unexplained-surplus WARN threshold |
| `V6_LOG_MAX_BYTES` | `5 MiB` | in-process log rotation |
| `SPECULAR_ALERT_WEBHOOK` | unset | opt-in remote notification |
| `SPECULAR_ALERT_DIR` | this directory | sandbox every alert artifact (drills/tests) |
| `SPECULAR_ALERT_QUIET` | unset | suppress banner/voice |

---

## Known gaps

These are properties of the setup, not bugs to be surprised by. Full list and consequences
in `INCIDENT_RUNBOOK.md` §6.

- **No all-jobs-dead detector.** The jobs cross-check each other's heartbeats, but a sleeping
  or powered-off Mac silences all of them. Weekly `alert.js --status` is the only backstop.
- **No remote channel is configured.** Every alert is local to this Mac.
- **Only the marketplace owner is watched.** Registry / reputation-manager / faucet ownership
  changes, `authorizePool`, `revokePool` and every fee-and-limit lever are invisible.
- **`run-overdue-check.sh` and `rpc-health-sample.sh` stamp no heartbeat.** If either job
  stops, nothing notices.
- **Read-only.** Nothing here holds a key or sends a transaction.
