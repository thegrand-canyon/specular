#!/usr/bin/env bash
# Dead-man's switch test: if one network's monitor job stops running, does any
# other job notice? (Nothing in the V6.0 setup did — a job that stops simply stops,
# and the silence looks exactly like "all clear".)
set -u
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd "$(dirname "$0")/../.."
ROOT="$(pwd)"
SANDBOX="$ROOT/forensics/output/testing-2026-09-20/deadman-sandbox"
rm -rf "$SANDBOX"; mkdir -p "$SANDBOX"
export SPECULAR_ALERT_DIR="$SANDBOX" SPECULAR_ALERT_QUIET=1

# A sibling job that last ran 4 hours ago (threshold 90 min)
node -e '
const fs=require("fs");
fs.writeFileSync(process.argv[1]+"/heartbeat-arc-mainnet.json", JSON.stringify({
  network:"arc-mainnet", ts:new Date(Date.now()-4*3600e3).toISOString(), epoch:Date.now()-4*3600e3, lastExitCode:0
}));' "$SANDBOX"

rm -f "$ROOT/forensics/monitor/state-local.json"
V6_MONITOR_NETWORK=local V6_MAX_BLOCK_AGE_SEC=0 LOCAL_RPC_URL=http://127.0.0.1:8545 \
  node forensics/monitor/v6-invariants.js --quiet >/dev/null 2>&1
echo "local monitor exit=$? (healthy chain, so its OWN checks pass)"

echo "--- alerts raised by the dead-man's switch ---"
if [ -f "$SANDBOX/alerts.log" ]; then
  node -e '
  const fs=require("fs");
  for (const l of fs.readFileSync(process.argv[1],"utf8").trim().split("\n")) {
    const a=JSON.parse(l);
    console.log(a.severity, "|", a.title, "|", JSON.stringify(a.details));
  }' "$SANDBOX/alerts.log"
else
  echo "NONE — dead-man switch did not fire"
fi
rm -f "$ROOT/forensics/monitor/state-local.json"
