#!/usr/bin/env bash
# How long does each monitor take before it gives up on a slow RPC?
# The V6.0 monitor has no per-request timeout at all, so it blocks for as long as
# the endpoint takes — and launchd will not start the next scheduled run while the
# previous one is still alive, which is how "monitored every 30 min" silently
# becomes "monitored once, hours ago".
set -u
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
DELAY="${1:-20000}"
PORT=8561

node scripts/op-resilience/fault-rpc.js --mode slow --delay "$DELAY" --port "$PORT" 2>/dev/null &
PROXY=$!
sleep 1

start=$SECONDS
LOCAL_RPC_URL="http://127.0.0.1:$PORT" V6_MONITOR_NETWORK=local \
  node scripts/op-resilience/v6-invariants-V60-baseline.js >/dev/null 2>&1
echo "V6.0 exit=$? elapsed=$((SECONDS - start))s  (per-call delay ${DELAY}ms, no client timeout)"

start=$SECONDS
LOCAL_RPC_URL="http://127.0.0.1:$PORT" V6_MONITOR_NETWORK=local V6_RPC_TIMEOUT_MS=5000 \
  V6_MAX_BLOCK_AGE_SEC=0 SPECULAR_ALERT_QUIET=1 SPECULAR_ALERT_DIR="$ROOT/forensics/output/testing-2026-09-20/alert-sandbox" \
  node forensics/monitor/v6-invariants.js >/dev/null 2>&1
echo "V6.1 exit=$? elapsed=$((SECONDS - start))s  (5s timeout + bounded retries)"

kill $PROXY 2>/dev/null
