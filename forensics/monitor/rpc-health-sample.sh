#!/usr/bin/env bash
#
# Sample the hosted agent server's upstream-RPC health and append one JSON line.
#
# Why this exists: the 2026-09-22 resilience round left one open question — whether a
# DEDICATED (paid) RPC provider is needed before handing the endpoint to an outside
# platform. Caching absorbed read traffic (upstream calls fell 98%), but writes,
# simulations and relays can never be cached, and all three public Arc endpoints share our
# egress address, so they can throttle together. Rather than guess, collect evidence:
# `rate_limited` counts and `circuitOpens` over a week answer it with data.
#
# Reads nothing secret; /rpc-health is deliberately unauthenticated so a platform can
# probe the service before it holds a credential.
set -u
URL="${SPECULAR_AGENT_URL:-https://specular-agent-api-production.up.railway.app}/rpc-health"
OUT="${SPECULAR_RPC_HEALTH_LOG:-/Users/peterschroeder/Specular/forensics/monitor/rpc-health.jsonl}"
TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
BODY="$(curl -s -m 30 "$URL" || true)"
if [ -z "$BODY" ]; then
  printf '{"ts":"%s","ok":false,"error":"no response"}\n' "$TS" >> "$OUT"
  exit 0
fi
# Keep only the decision-relevant fields; the full payload is large and mostly static.
#
# [2026-09-24] The timestamp used to be passed as `python3 -c '...' TS="$TS"`, which makes
# TS=... sys.argv[1], NOT an environment variable — so `os.environ["TS"]` raised KeyError,
# the `||` fallback fired, and EVERY sample ever taken was
# {"ok":false,"error":"parse failed"} (84 of 84 rows, 15-minute cadence, zero usable data).
# The env assignment has to come BEFORE the command.
printf '%s' "$BODY" | TS="$TS" /usr/bin/python3 -c '
import sys, json, os
ts = os.environ["TS"]
try:
    d = json.load(sys.stdin)
except Exception as e:
    print(json.dumps({"ts": ts, "ok": False, "error": "unparsable: %s" % e})); raise SystemExit
c = d.get("caches", {})
row = {
    "ts": ts, "ok": True,
    "jsonRpcHitRate": round(c.get("jsonRpc", {}).get("hitRate", 0), 4),
    "readHitRate": round(c.get("readRoutes", {}).get("hitRate", 0), 4),
    "jsonRpcMisses": c.get("jsonRpc", {}).get("misses", 0),
    "networks": [],
}
# [2026-09-24] The field map below was wrong for the payload /rpc-health actually serves:
# there is no per-network "circuit" object (it is circuitOpen/circuitOpens on the network
# itself) and no per-endpoint "rateLimited" counter (throttling shows as
# lastErrorClass == "rate_limited" together with the failure count). Both therefore logged
# a constant 0 — i.e. the two numbers this whole job exists to collect. Read the real keys,
# and carry the per-endpoint call/failure counts so a week of rows can be differenced.
for n in d.get("networks", []):
    eps = n.get("endpoints", [])
    row["networks"].append({
        "network": n.get("network"),
        "circuitOpen": bool(n.get("circuitOpen")),
        "circuitOpens": int(n.get("circuitOpens") or 0),
        "retryAfterSeconds": int(n.get("retryAfterSeconds") or 0),
        "rateLimitedEndpoints": sum(1 for e in eps if e.get("lastErrorClass") == "rate_limited"),
        "calls": sum(int(e.get("calls") or 0) for e in eps),
        "failures": sum(int(e.get("failures") or 0) for e in eps),
        "down": sum(1 for e in eps if e.get("state") not in ("up", None)),
        "endpoints": len(eps),
        "perEndpoint": [{
            "endpoint": e.get("endpoint"),
            "state": e.get("state"),
            "calls": int(e.get("calls") or 0),
            "failures": int(e.get("failures") or 0),
            "lastErrorClass": e.get("lastErrorClass"),
        } for e in eps],
    })
print(json.dumps(row))
' >> "$OUT" 2>/dev/null || printf '{"ts":"%s","ok":false,"error":"parse failed"}\n' "$TS" >> "$OUT"
