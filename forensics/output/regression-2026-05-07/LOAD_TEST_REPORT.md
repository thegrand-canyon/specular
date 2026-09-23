# Load Test Report — 2026-05-12

Comprehensive load testing across Arc + Base + API. Bottom-line: the **contracts handle sustained load well; the bottleneck is the public Arc RPC (drpc.org free tier)**.

## Tests run

### Track A — 20-agent horizontal scale (Arc V6)
**Goal**: 20 fresh agents, 60 lenders (3 per agent), each agent does full loan lifecycle.

**Outcome**: PARTIAL — completed in 4 phases:
- ✅ All 20 agents + 60 lenders funded (160 transactions, 694 seconds = 4.3 tx/s)
- ✅ 12/20 agents successfully registered + created V6 pools
- ❌ Hit drpc.org free-tier 408 timeout at ~110 sustained transactions
- §S1/§B1 invariants held throughout the partial run

**V6 state after**: totalPools went 1 → 13. All 12 new pools active.

### Track B — 200-loan churn (Arc V6)
**Goal**: Single agent takes 200 sequential loans (5× our prior 100-loan test), confirming §S5 fix at higher history depth.

**Outcome**: PARTIAL — 60 loans completed before script-side bug:
- Gas range stayed **flat at 337,526 — 371,726** across all 60 loans
- §S5 fix confirmed at the 60-loan mark
- Script bug: `withRetry` mechanism re-broadcast a repay tx after a network timeout that had actually succeeded; second attempt reverted "Loan not active"
- Cleanup: 6 residual active loans all repaid; pool restored to clean state

### Track D — Arc v4 §S5 live push
**Outcome**: SKIPPED. Same RPC ceiling would apply (sustained tx broadcast). Existing v4 evidence (agent #43 at 777 loans = 3.94M gas, regression equation `gas ≈ 4,643 × N + 348,994`) is already definitive.

### Track E — API stress (local, no chain)
**Goal**: 500 concurrent POST `/tx/request-loan` requests against the local MultiNetworkAPI server.

**Outcome**: ✅ COMPLETE — full pass:
- **500/500 successful, 0 errors**
- **Throughput: 4,425 req/s**
- Latency: p50 = 5.2 ms, p95 = 24.4 ms, p99 = 26.9 ms
- All responses returned valid calldata

## Bottom line per fix

| Fix | Evidence quality | Source |
|-----|------------------|--------|
| §B1 (no duplicates) | Strong | Hardhat 363 tests, Foundry 10,240 sequences, multi-lender live demo, 60+ live cycles |
| §S1 (avail decrement) | Strong | Hardhat + Foundry + live verification post-claim |
| §S5 (counter not array walk) | Strong | Linear regression on 4 v4 agents, 60 live V6 loans with FLAT gas, Foundry 10,240 sequences |

## RPC ceiling — operational finding

drpc.org free-tier API limits us to ~50 sustained tx/min before throwing 408s. This is **not** a contract limitation — it's the RPC service tier.

**Workarounds for true large-scale load testing:**
- Upgrade to a paid Arc Testnet RPC provider (Alchemy doesn't yet support Arc; check with Circle for Arc-specific endpoints)
- Self-hosted Arc Testnet node
- Use Hardhat fork (offline, no RPC limits) for high-throughput simulation — our Foundry invariant tests effectively do this at 10,240 sequences

## Cumulative cost (2026-05-12 session)

- Arc ETH spent: ~5 ETH (out of 333 remaining)
- USDC committed (most cleaned up): ~30,000 USDC into pools/agents; all withdrawn or reclaimed
- Base ETH: 0 (no Base broadcasts this session)
- Base USDC: 0

## Net state changes

- V6 has 13 pools (was 1 at start of session)
- Pool 49 cleanly reset to lenderCount=1, avail=0.076 USDC (residual platform fees)
- 12 new agents registered on AgentRegistryV2 (now totalAgents = ~112)
- No invariant violations across all snapshots taken
