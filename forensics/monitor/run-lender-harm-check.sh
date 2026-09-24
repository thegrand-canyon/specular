#!/usr/bin/env bash
#
# launchd entry point for the lender-harm detector.
#
# Separate from v6-invariants.js on purpose: a default keeps the books balanced BY DESIGN
# (the loss is socialised), so the invariant monitor stays green while lenders lose money.
# Proven 2026-09-25: a real local default left every invariant passing and the only
# complaints were clock artifacts. This is the only thing that pages on lender harm.
#
# alert.js takes POSITIONAL args: <SEVERITY> <title> [jsonDetails].
set -u
NETWORK="${1:-arc-mainnet}"
REPO="${SPECULAR_REPO:-/Users/peterschroeder/Specular}"
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd "$REPO" || exit 3

OUT="$(V6_MONITOR_NETWORK="$NETWORK" node forensics/monitor/check-lender-harm.js 2>&1)"
CODE=$?
printf '%s\n' "$OUT" >> "$REPO/forensics/monitor/lender-harm-${NETWORK}.log"

if [ "$CODE" -eq 1 ]; then
    COUNT="$(printf '%s' "$OUT" | /usr/bin/python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("lenderHarmEvents", "?"))
except Exception: print("?")' 2>/dev/null || echo '?')"
    node "$REPO/forensics/monitor/alert.js" CRITICAL \
        "Lenders lost money on $NETWORK ($COUNT event(s))" \
        "{\"network\":\"$NETWORK\",\"events\":\"$COUNT\",\"see\":\"forensics/monitor/lender-harm-${NETWORK}.log\"}" >/dev/null 2>&1
elif [ "$CODE" -ne 0 ]; then
    node "$REPO/forensics/monitor/alert.js" ERROR \
        "Lender-harm check could not complete on $NETWORK (exit $CODE)" \
        "{\"network\":\"$NETWORK\",\"exitCode\":$CODE}" >/dev/null 2>&1
fi
exit "$CODE"
