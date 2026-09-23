#!/usr/bin/env bash
# RPC-failure truth test: does the monitor report a false OK when the endpoint is
# dead, slow, or serving stale/frozen data? Runs BOTH the frozen V6.0 monitor and
# the rewritten one against a fault-injecting proxy in front of the local chain.
#
# Usage: bash scripts/op-resilience/run-rpc-failure-tests.sh
set -u
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
OUT="$ROOT/forensics/output/testing-2026-09-20"
mkdir -p "$OUT" "$OUT/alert-sandbox"
export SPECULAR_ALERT_QUIET=1 SPECULAR_ALERT_DIR="$OUT/alert-sandbox"
NEW="$ROOT/forensics/monitor/v6-invariants.js"
OLD="$ROOT/scripts/op-resilience/v6-invariants-V60-baseline.js"
RESULT="$OUT/rpc-failure-matrix.txt"
: > "$RESULT"

run_case () {   # name, rpc_url, extra_env..., description
  local name="$1"; shift
  local rpc="$1"; shift
  local maxage="$1"; shift
  rm -f "$ROOT/forensics/monitor/state-local.json"
  local o n
  LOCAL_RPC_URL="$rpc" V6_MONITOR_NETWORK=local V6_MAX_BLOCK_AGE_SEC="$maxage" V6_RPC_TIMEOUT_MS=5000 \
    node "$OLD" > "$OUT/.old.out" 2>&1; o=$?
  LOCAL_RPC_URL="$rpc" V6_MONITOR_NETWORK=local V6_MAX_BLOCK_AGE_SEC="$maxage" V6_RPC_TIMEOUT_MS=5000 \
    node "$NEW" > "$OUT/.new.out" 2>&1; n=$?
  local ocodes ncodes
  ocodes=$(grep -o '"msg":"[^"]*"' "$OUT/.old.out" | grep -iE 'VIOLATION|failed|STALE|backwards|unchanged' | head -3 | tr '\n' ' ')
  ncodes=$(grep -oE '\[[A-Z][A-Z0-9-]+\]' "$OUT/.new.out" | sort -u | tr '\n' ' ')
  printf '%-22s V6.0 exit=%d %-38s | V6.1 exit=%d %s\n' "$name" "$o" "${ocodes:--}" "$n" "${ncodes:--}" | tee -a "$RESULT"
}

echo "=== RPC failure matrix ($(date -u +%Y-%m-%dT%H:%M:%SZ)) ===" | tee -a "$RESULT"

# 1. Healthy control
run_case "healthy"        "http://127.0.0.1:8545" 0

# 2. Dead endpoint (nothing listening)
run_case "dead-endpoint"  "http://127.0.0.1:8599" 0

# 3. Endpoint that answers with JSON-RPC errors
node scripts/op-resilience/fault-rpc.js --mode error --port 8556 2>/dev/null &
E=$!; sleep 1
run_case "rpc-errors"     "http://127.0.0.1:8556" 0
kill $E 2>/dev/null

# 4. Slow endpoint (30 s per response, 5 s client timeout)
node scripts/op-resilience/fault-rpc.js --mode slow --delay 30000 --port 8557 2>/dev/null &
S=$!; sleep 1
run_case "slow-endpoint"  "http://127.0.0.1:8557" 0
kill $S 2>/dev/null

# 5. Stale head: state reads fine, chain head 2 h old
node scripts/op-resilience/fault-rpc.js --mode stale --age 7200 --port 8558 2>/dev/null &
T=$!; sleep 1
run_case "stale-head-2h"  "http://127.0.0.1:8558" 1800
kill $T 2>/dev/null

# 6. Frozen RPC: same block replayed for ever, every state read still succeeds.
#    This is the case the V6.0 monitor cannot see at all — it keeps no run-to-run
#    state, so a pinned endpoint produces a clean OK indefinitely.
node scripts/op-resilience/fault-rpc.js --mode frozen --port 8559 2>/dev/null &
F=$!; sleep 1
rm -f "$ROOT/forensics/monitor/state-local.json"
# run 1 through the proxy: it pins the current head and both sides record it
LOCAL_RPC_URL="http://127.0.0.1:8559" V6_MONITOR_NETWORK=local V6_MAX_BLOCK_AGE_SEC=0 node "$NEW" >/dev/null 2>&1
# the real chain moves on...
curl -s -X POST -H 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","method":"hardhat_mine","params":["0x14"],"id":1}' http://127.0.0.1:8545 >/dev/null
# run 2 through the still-frozen proxy: every read succeeds, head has not moved
for M in "$OLD" "$NEW"; do
  LOCAL_RPC_URL="http://127.0.0.1:8559" V6_MONITOR_NETWORK=local V6_MAX_BLOCK_AGE_SEC=0 node "$M" > "$OUT/.f.out" 2>&1
  code=$?
  if [ "$M" = "$OLD" ]; then fo=$code; else fn=$code; fncodes=$(grep -oE '\[[A-Z][A-Z0-9-]+\]' "$OUT/.f.out" | sort -u | tr '\n' ' '); fi
done
printf '%-22s V6.0 exit=%d %-38s | V6.1 exit=%d %s\n' "frozen-head(2nd run)" "$fo" "(keeps no run-to-run state)" "$fn" "${fncodes:--}" | tee -a "$RESULT"
kill $F 2>/dev/null
rm -f "$OUT/.f.out"

rm -f "$OUT/.old.out" "$OUT/.new.out" "$ROOT/forensics/monitor/state-local.json"
echo "written to $RESULT"
