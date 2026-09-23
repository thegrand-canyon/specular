#!/usr/bin/env bash
#
# launchd entry point for the overdue-loan check.
#
# Why separate from v6-invariants.js: that monitor asserts ACCOUNTING invariants, and an
# overdue loan violates none of them — a borrower a full day past endTime produces a clean
# exit 0 (measured in the 2026-09-23 incident drill). `liquidateLoan` is the protocol's
# only recovery action, so somebody has to be told it is available.
#
# alert.js takes POSITIONAL args: <SEVERITY> <title> [jsonDetails]. An earlier version of
# this wrapper invented `--raise --severity ...`; alert.js would have treated "--raise" as
# the severity and the whole alert path would have been decorative. Verified by forcing a
# non-zero exit and confirming the latch file appears.
#
# [2026-09-24] The details argument was ALSO decorative, for a second reason. It was built
# with sed+awk inline in the `node ... "$( ... )"` argument list, and the resulting
# `{"network":"x","detail":"..."}` was brace-expanded by the shell into TWO words. alert.js
# got `"network":"local"` as its details argument (invalid JSON -> {raw:...}), the real
# payload landed in an argv slot it ignores, and the alert's `network` field read "unknown".
# So a 3am page said "overdue loans" and carried no loan ids, no principals and no
# days-overdue. Build the JSON with a JSON encoder, assign it to a variable FIRST, and pass
# that variable quoted — never construct a JSON argument inline.
set -u
NETWORK="${1:-arc-mainnet}"
REPO="${SPECULAR_REPO:-/Users/peterschroeder/Specular}"
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd "$REPO" || exit 3

OUT="$(V6_MONITOR_NETWORK="$NETWORK" node forensics/monitor/check-overdue-loans.js 2>&1)"
CODE=$?
printf '%s\n' "$OUT" >> "$REPO/forensics/monitor/overdue-${NETWORK}.log"

if [ "$CODE" -eq 1 ]; then
    DETAILS="$(printf '%s' "$OUT" | node -e '
        const fs = require("fs");
        const raw = fs.readFileSync(0, "utf8");
        let report; try { report = JSON.parse(raw); } catch { report = { unparsed: raw.slice(0, 4000) }; }
        process.stdout.write(JSON.stringify({ network: process.argv[1], report }));
    ' "$NETWORK")"
    node "$REPO/forensics/monitor/alert.js" CRITICAL \
        "Overdue loans awaiting liquidation on $NETWORK" \
        "$DETAILS" >/dev/null 2>&1
elif [ "$CODE" -ne 0 ]; then
    node "$REPO/forensics/monitor/alert.js" ERROR \
        "Overdue-loan check could not complete on $NETWORK (exit $CODE)" \
        "{\"network\":\"$NETWORK\",\"exitCode\":$CODE}" >/dev/null 2>&1
fi
exit "$CODE"
