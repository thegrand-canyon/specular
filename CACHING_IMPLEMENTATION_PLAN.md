# Specular API - Caching Layer Implementation Plan

## Objective
Implement database caching to reduce response times from 1-10 seconds to 1-10 milliseconds (100-1000x improvement).

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      API Request Flow                        │
└─────────────────────────────────────────────────────────────┘

OLD (Current):
  Request → API → RPC Call (1-10s) → Response

NEW (With Caching):
  Request → API → Cache Check (1-10ms) → Response
                    ↓ (if miss)
                  RPC Call (1-10s) → Cache Update → Response

Background Sync:
  Every 30s → Fetch from RPC → Update Cache → Repeat
```

---

## Implementation Strategy

### Phase 1: In-Memory Cache with Background Sync (Today)
- **Technology:** Node.js Map/Object + setInterval
- **Pros:** Zero dependencies, instant deployment, simple
- **Cons:** Cache cleared on restart, single-instance only
- **Good for:** MVP, proof of concept, current scale

### Phase 2: Redis Cache (Future - Optional)
- **Technology:** Redis on Railway
- **Pros:** Persistent, multi-instance, advanced features
- **Cons:** Additional cost (~$5-10/month), more complexity
- **When:** If traffic exceeds 1,000 req/min or need multi-region

### Phase 3: PostgreSQL with Redis (Future - Optional)
- **Technology:** PostgreSQL + Redis hybrid
- **Pros:** Historical data, analytics, full persistence
- **Cons:** Higher cost, maintenance overhead
- **When:** If building analytics dashboard or need audit logs

---

## Phase 1 Implementation (Today)

### 1. Create Cache Manager Service

**File:** `src/cache/BlockchainCache.js`

**Features:**
- In-memory storage for agents, pools, network data
- Background sync every 30-60 seconds
- TTL (time-to-live) per data type
- Cache invalidation on errors
- Memory-efficient (store only essential data)

**Data Structures:**
```javascript
{
  agents: {
    arc: Map<agentId, agentData>,
    base: Map<agentId, agentData>
  },
  pools: {
    arc: Map<poolId, poolData>,
    base: Map<poolId, poolData>
  },
  metadata: {
    arc: { totalAgents, totalPools, lastSync },
    base: { totalAgents, totalPools, lastSync }
  }
}
```

### 2. Background Sync Worker

**File:** `src/cache/SyncWorker.js`

**Process:**
1. Every 30 seconds:
   - Fetch all agents from registry
   - Fetch all pools from marketplace
   - Update in-memory cache
   - Log sync statistics

2. Error Handling:
   - Retry failed syncs with exponential backoff
   - Keep stale data if sync fails (better than nothing)
   - Log errors but don't crash

3. Performance:
   - Batch RPC calls where possible
   - Use Promise.all for parallel fetching
   - Limit concurrent requests to avoid rate limiting

### 3. Update API Endpoints

**Changes to `MultiNetworkAPI.js`:**

```javascript
// Before (direct RPC):
app.get('/agents', async (req, res) => {
  const agents = await registry.getAllAgents(); // 1-5 seconds
  res.json(agents);
});

// After (cache-first):
app.get('/agents', async (req, res) => {
  const cachedAgents = cache.getAgents(network); // 1-10 milliseconds

  if (cachedAgents) {
    return res.json({
      ...cachedAgents,
      cached: true,
      lastSync: cache.getLastSync(network)
    });
  }

  // Fallback to RPC if cache miss (rare)
  const agents = await registry.getAllAgents();
  res.json(agents);
});
```

**Endpoints to Cache:**
- ✅ `/agents?network=X` - List all agents (high traffic)
- ✅ `/agent/:id?network=X` - Agent by ID (high traffic)
- ✅ `/pools?network=X` - List all pools (high traffic)
- ✅ `/pools/:id?network=X` - Pool by ID (medium traffic)
- ❌ `/health` - Already fast, no caching needed
- ❌ `/stats` - Real-time data, no caching

### 4. Cache Invalidation Strategy

**When to invalidate:**
- After 60 seconds (automatic TTL)
- On RPC error (force re-fetch next request)
- On manual trigger via admin endpoint

**Stale-while-revalidate:**
- Serve stale cache if < 5 minutes old
- Trigger background refresh
- User gets instant response with slightly old data

---

## Improvement 1: Base Mainnet RPC Upgrade

### Current Issue
- Public RPC: `https://mainnet.base.org`
- Problem: Throttles under concurrent load (62% success rate)
- Impact: 33% of Base requests fail under 20 concurrent requests

### Solution Options

| Provider | Cost | Rate Limit | Features |
|----------|------|------------|----------|
| **Alchemy** | Free tier: 300M CU/mo | 330 req/s | Archive data, webhooks, APIs |
| **Infura** | Free tier: 100K req/day | ~100 req/s | Reliable, industry standard |
| **QuickNode** | $9/mo starter | ~100 req/s | Fast, global CDN |
| **Ankr** | Free tier: 500M req/mo | Varies | Multi-chain, cost-effective |
| **Self-hosted** | ~$50-100/mo | Unlimited | Full control, highest latency |

### Recommendation: **Alchemy Free Tier**

**Why Alchemy:**
- ✅ Free tier: 300M compute units/month (enough for 1M+ requests)
- ✅ 330 req/s rate limit (vs current public RPC ~10 req/s)
- ✅ 99.9% uptime SLA
- ✅ Archive node access (historical data)
- ✅ Enhanced APIs (batch requests, subscriptions)
- ✅ Easy upgrade path to paid ($49/mo for 10x more)

**Setup Steps:**
1. Sign up at https://www.alchemy.com
2. Create a new Base Mainnet app
3. Copy API key and RPC URL
4. Update `NETWORKS.base.rpcUrl` in config
5. Test with load testing script

**Expected Improvement:**
- Success rate: 62% → 100%
- Response times: 4-186 seconds → 200-500ms (10-1000x faster)
- Concurrent request handling: 10 → 330 (33x increase)

---

## Implementation Timeline

### Today (Phase 1):
1. **Hour 1:** Create `BlockchainCache.js` and `SyncWorker.js`
2. **Hour 2:** Update API endpoints to use cache-first approach
3. **Hour 3:** Test and deploy
4. **Hour 4:** Sign up for Alchemy, update Base RPC, test

### Expected Results:
- Arc response times: 325ms avg → **10-50ms avg** (7-30x faster)
- Base response times: 4-186s avg → **200-500ms avg** (10-1000x faster)
- Base success rate: 62% → **100%** (38% improvement)
- Throughput: 45 req/s → **300+ req/s** (7x increase)

---

## Monitoring & Metrics

### Cache Hit Rate
- Target: >95% hit rate for list endpoints
- Metric: `cacheHits / (cacheHits + cacheMisses)`

### Sync Health
- Last successful sync timestamp
- Sync failures count
- Sync duration (should be <5 seconds)

### Performance Improvement
- Before/after response time comparison
- p50, p95, p99 metrics
- Success rate by endpoint

### Add to `/stats` endpoint:
```json
{
  "cache": {
    "enabled": true,
    "hitRate": "96.7%",
    "lastSync": {
      "arc": "2026-03-26T10:15:30.000Z",
      "base": "2026-03-26T10:15:31.000Z"
    },
    "syncHealth": {
      "arc": "healthy",
      "base": "healthy"
    },
    "entries": {
      "arc": { "agents": 49, "pools": 8 },
      "base": { "agents": 1, "pools": 1 }
    }
  }
}
```

---

## Rollback Plan

If caching causes issues:

1. **Disable cache via env var:**
   ```bash
   ENABLE_CACHE=false npm start
   ```

2. **Kill background sync:**
   - Sync worker respects `ENABLE_CACHE` flag
   - No restart needed

3. **Revert to direct RPC:**
   - Cache-first code has fallback to RPC
   - Graceful degradation built-in

---

## Future Enhancements (Phase 2+)

### Redis Integration
- Persistent cache across restarts
- Shared cache for multi-instance deployments
- Advanced features: pub/sub, sorted sets, TTL

### PostgreSQL Integration
- Store historical data for analytics
- Track agent reputation over time
- Generate insights and reports

### Real-time Updates
- WebSocket connections for live data
- Subscribe to blockchain events
- Push updates to clients

### Advanced Caching
- Predictive pre-fetching (warm cache for popular queries)
- Regional caching (edge locations worldwide)
- Smart cache invalidation (only update changed data)

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Stale data shown to users | High | Low | Add "Last synced" timestamp, 30s TTL |
| Memory usage increase | Medium | Low | Monitor heap, limit cache size |
| Sync failures | Low | Medium | Keep stale data, log errors, retry |
| RPC rate limits | Low | High | Respect limits, add backoff, use Alchemy |

---

## Success Criteria

✅ **Must Have:**
- Response times <100ms for cached endpoints
- Cache hit rate >90%
- Zero data corruption or staleness issues
- Base Mainnet success rate >95%

✅ **Nice to Have:**
- Response times <50ms for cached endpoints
- Cache hit rate >98%
- Sync failures <1% per day
- Memory usage <100 MB for cache

---

## Summary

**Improvement #1: Base RPC Upgrade**
- Sign up for Alchemy (free)
- Update RPC URL
- Test and deploy
- **Expected result:** 62% → 100% success rate

**Improvement #2: Caching Layer**
- Build in-memory cache with background sync
- Update API to serve from cache
- Deploy and monitor
- **Expected result:** 325ms → 10-50ms avg response time

**Combined Impact:**
- **100x faster** on cached endpoints
- **10-1000x faster** on Base Mainnet
- **38% fewer errors** on Base
- **7x higher throughput** overall
- **Zero new dependencies** (Phase 1)
- **Zero infrastructure changes** (Phase 1)

**Timeline:** 4 hours to implement and deploy both improvements.

Let's do it! 🚀
