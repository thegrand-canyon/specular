# Live load verification — hosted agent server (2026-09-22)

Target: `https://specular-agent-api-production.up.railway.app`, the build deployed
2026-09-22 with the RPC-resilience work (multi-endpoint failover, two cache layers,
request coalescing, bounded deadlines, per-network circuit breaker) and the 2026-09-21
security hardening (H-1…H-15).

This is an independent check of the two fixes that could only be proven in production:
the latency collapse, and the rate limiter being keyed on the **caller** rather than the
hosting edge. Harness: `/tmp/loadtest.js` (plain `fetch`, bounded to ~350 requests total).

## Latency

| Route | Concurrency | n | p50 | p95 | p99 | Throughput |
|---|---|---|---|---|---|---|
| `/health` | 1 | 20 | 81 ms | 400 ms | 400 ms | 10.1 rps |
| `/health` | 5 | 40 | 69 ms | 203 ms | 203 ms | 54.5 rps |
| `/v1/arc-mainnet/status` | 1 | 20 | 60 ms | 202 ms | 202 ms | 14.9 rps |
| `/v1/arc-mainnet/status` | 5 | 40 | 60 ms | **67 ms** | 71 ms | 81.8 rps |
| `/v1/networks` | 5 | 30 | 59 ms | 69 ms | 69 ms | 82.2 rps |

All 200s, zero errors.

**Comparison with the pre-fix build.** The 2026-09-21 hosted-server round measured
`/v1/arc-mainnet/status` at concurrency 5 with **p95 164 s**, and p99 300 s at concurrency
20 — requests dying on Node's default socket timeout while queued behind a public RPC. The
same route now answers at **p95 67 ms** under the same concurrency, roughly a 2,400×
improvement. The first request in each cold phase still pays the uncached cost (the 400 ms
and 202 ms p95 figures at concurrency 1 are single cold misses in a 20-request sample),
which is the expected shape for a cache with a short head TTL.

## Rate limiter — the H-10 fix, confirmed in production

Burst: concurrency 20, 200 requests, immediately after ~150 requests in the phases above.

```
/v1/arc-mainnet/status burst  c=20 n=200  p50=60ms p95=196ms p99=216ms  271.0 rps
                              codes={"200":30,"429":170}
after burst: 429  Retry-After: 58
```

30 requests served and 170 refused is consistent with a 120/minute budget already partly
spent by the preceding phases, and the refusals carry a correct `Retry-After`.

This is the finding that mattered. Before the fix the limiter resolved `req.ip` to
Railway's edge, so the "per-IP" bucket was **shared by every caller**: the earlier round
recorded **zero 429s across 300 live requests** and confirmed the logged client address was
the edge, not the caller. One client could have exhausted the quota for everyone, and a
client could have multiplied its own quota across edge addresses. The limiter now counts
against the actual caller.

## What this does and does not establish

- **Does**: the deployed build is fast under the concurrency a handful of agents would
  generate, serves reads almost entirely from cache, and enforces a correct per-caller quota.
- **Does not**: say anything about sustained multi-agent *write* traffic. Prepared
  transactions, simulations and relays are never cacheable and go straight to upstream RPC,
  which remains the binding constraint. The quota exhaustion that forced an endpoint switch
  mid-testing was caused by exactly that kind of traffic.
- **Does not**: cover the V7 client changes, which are not deployed yet. Re-run this after
  that deployment.

Conclusion unchanged from the RPC-resilience report: a dedicated RPC provider is no longer a
blocker for read-heavy access, but is still required before committing to throughput or
latency for an external platform. Watch `/rpc-health` `rate_limited` and `circuitOpens`
for a week and buy on that evidence.
