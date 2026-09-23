#!/usr/bin/env bash
#
# launchd entry point for the invariant monitor.
#
# Why this exists: launchd discards a job's exit status. Before this wrapper, a
# violation wrote a JSON line into a log file and exited 1 into a void — and a
# CRASH (unhandled rejection on an RPC failure, which has happened 15 times on
# arc-testnet) wrote nothing at all. This wrapper guarantees that ANY non-zero
# exit — violation, monitor failure, crash, watchdog timeout — reaches alert.js,
# which latches a file, writes ~/SPECULAR-ALERT.txt, raises a macOS banner and
# POSTs to SPECULAR_ALERT_WEBHOOK when that is set.
#
# Usage (plist ProgramArguments):
#   /bin/bash /Users/peterschroeder/Specular/forensics/monitor/run-with-alert.sh arc-mainnet
#
# Env (set in the plist's EnvironmentVariables, or a sourced env file):
#   SPECULAR_ALERT_WEBHOOK   opt-in webhook URL — never hardcode one here
#   V6_EXPECTED_OWNER        expected owner address for the network
#   ARC_MAINNET_RPC_URL / ARC_TESTNET_RPC_URL
set -u

NETWORK="${1:-arc-testnet}"
REPO="${SPECULAR_REPO:-/Users/peterschroeder/Specular}"
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd "$REPO" || exit 3

# An env file lets secrets (webhook URL) stay out of the plist and out of git.
# shellcheck disable=SC1091
[ -f "$REPO/forensics/monitor/monitor.env" ] && . "$REPO/forensics/monitor/monitor.env"

CAPTURE="$(mktemp -t specular-monitor)"
V6_MONITOR_NETWORK="$NETWORK" node forensics/monitor/v6-invariants.js --quiet > "$CAPTURE" 2>&1
CODE=$?

cat "$CAPTURE"

if [ "$CODE" -ne 0 ]; then
    # The monitor alerts on its own for findings it understands, and records that
    # in its heartbeat. This branch is the catch-all for everything it CANNOT
    # report on: a crash before it logged anything, OOM, node missing, repo moved.
    # Heartbeat name must match v6-invariants.js's INSTANCE, which is the network name
    # unless a specific (superseded) marketplace is being watched — those get their own
    # state/log/heartbeat so two jobs on one network cannot overwrite each other.
    INSTANCE="$NETWORK"
    if [ -n "${V6_MONITOR_INSTANCE:-}" ]; then
        INSTANCE="$V6_MONITOR_INSTANCE"
    elif [ -n "${V6_MONITOR_MARKETPLACE:-}" ]; then
        SHORT=$(printf '%s' "${V6_MONITOR_MARKETPLACE#0x}" | cut -c1-8 | tr '[:upper:]' '[:lower:]')
        INSTANCE="$NETWORK-$SHORT"
    fi
    HB="${SPECULAR_ALERT_DIR:-$REPO/forensics/monitor}/heartbeat-$INSTANCE.json"
    ALREADY=""
    if [ -f "$HB" ]; then
        ALREADY=$(node -e 'try{const h=require(process.argv[1]);process.stdout.write(h.alerted&&(Date.now()-h.epoch)<120000?"1":"")}catch(e){}' "$HB" 2>/dev/null)
    fi
    if [ -z "$ALREADY" ]; then
        TAIL="$(tail -c 1500 "$CAPTURE" | tr '\n' ' ' | tr -d '"')"
        node forensics/monitor/alert.js CRITICAL \
            "invariant monitor exited $CODE on $NETWORK with no alert of its own (crash?)" \
            "{\"network\":\"$NETWORK\",\"exitCode\":$CODE,\"output\":\"$TAIL\"}" >/dev/null 2>&1
    fi
fi

rm -f "$CAPTURE"
exit "$CODE"
