/**
 * Blockchain Data Cache
 * In-memory cache for agents, pools, and network metadata
 * Reduces API response times from 1-10s to 1-10ms
 */

class BlockchainCache {
    constructor(options = {}) {
        this.enabled = options.enabled !== false; // Default: enabled
        this.ttl = options.ttl || 60000; // Default: 60 seconds

        // Cache storage
        this.cache = {
            agents: new Map(), // network -> Map<agentId, agentData>
            pools: new Map(),  // network -> Map<poolId, poolData>
            agentsList: new Map(), // network -> [agentData]
            poolsList: new Map(),  // network -> [poolData]
            metadata: new Map()   // network -> { totalAgents, totalPools, lastSync }
        };

        // Statistics
        this.stats = {
            hits: 0,
            misses: 0,
            syncs: 0,
            syncFailures: 0,
            lastSyncTime: {}
        };

        console.log(`📦 BlockchainCache initialized (enabled: ${this.enabled}, TTL: ${this.ttl}ms)`);
    }

    // ============ AGENT CACHE METHODS ============

    /**
     * Get all agents for a network
     */
    getAgents(network) {
        if (!this.enabled) return null;

        const cached = this.cache.agentsList.get(network);
        if (!cached) {
            this.stats.misses++;
            return null;
        }

        // Check if cache is fresh
        const metadata = this.cache.metadata.get(network);
        if (!metadata || this.isStale(metadata.lastSync)) {
            this.stats.misses++;
            return null;
        }

        this.stats.hits++;
        return cached;
    }

    /**
     * Get a single agent by ID
     */
    getAgent(network, agentId) {
        if (!this.enabled) return null;

        const networkCache = this.cache.agents.get(network);
        if (!networkCache) {
            this.stats.misses++;
            return null;
        }

        const agent = networkCache.get(Number(agentId));
        if (!agent) {
            this.stats.misses++;
            return null;
        }

        // Check if cache is fresh
        const metadata = this.cache.metadata.get(network);
        if (!metadata || this.isStale(metadata.lastSync)) {
            this.stats.misses++;
            return null;
        }

        this.stats.hits++;
        return agent;
    }

    /**
     * Set all agents for a network
     */
    setAgents(network, agents) {
        if (!this.enabled) return;

        // Store as both Map (for ID lookup) and Array (for list endpoint)
        const agentsMap = new Map();
        agents.forEach(agent => {
            agentsMap.set(agent.agentId, agent);
        });

        this.cache.agents.set(network, agentsMap);
        this.cache.agentsList.set(network, agents);

        // Update metadata
        this.updateMetadata(network, { totalAgents: agents.length });
    }

    // ============ POOL CACHE METHODS ============

    /**
     * Get all pools for a network
     */
    getPools(network) {
        if (!this.enabled) return null;

        const cached = this.cache.poolsList.get(network);
        if (!cached) {
            this.stats.misses++;
            return null;
        }

        // Check if cache is fresh
        const metadata = this.cache.metadata.get(network);
        if (!metadata || this.isStale(metadata.lastSync)) {
            this.stats.misses++;
            return null;
        }

        this.stats.hits++;
        return cached;
    }

    /**
     * Get a single pool by ID
     */
    getPool(network, poolId) {
        if (!this.enabled) return null;

        const networkCache = this.cache.pools.get(network);
        if (!networkCache) {
            this.stats.misses++;
            return null;
        }

        const pool = networkCache.get(Number(poolId));
        if (!pool) {
            this.stats.misses++;
            return null;
        }

        // Check if cache is fresh
        const metadata = this.cache.metadata.get(network);
        if (!metadata || this.isStale(metadata.lastSync)) {
            this.stats.misses++;
            return null;
        }

        this.stats.hits++;
        return pool;
    }

    /**
     * Set all pools for a network
     */
    setPools(network, pools) {
        if (!this.enabled) return;

        // Store as both Map (for ID lookup) and Array (for list endpoint)
        const poolsMap = new Map();
        pools.forEach(pool => {
            poolsMap.set(pool.poolId, pool);
        });

        this.cache.pools.set(network, poolsMap);
        this.cache.poolsList.set(network, pools);

        // Update metadata
        this.updateMetadata(network, { totalPools: pools.length });
    }

    // ============ METADATA METHODS ============

    /**
     * Update metadata for a network
     */
    updateMetadata(network, data) {
        const existing = this.cache.metadata.get(network) || {};
        this.cache.metadata.set(network, {
            ...existing,
            ...data,
            lastSync: Date.now()
        });

        this.stats.lastSyncTime[network] = new Date().toISOString();
    }

    /**
     * Get metadata for a network
     */
    getMetadata(network) {
        return this.cache.metadata.get(network) || null;
    }

    /**
     * Get last sync time for a network
     */
    getLastSync(network) {
        const metadata = this.cache.metadata.get(network);
        return metadata ? new Date(metadata.lastSync).toISOString() : null;
    }

    /**
     * Check if cache is stale (older than TTL)
     */
    isStale(lastSync) {
        if (!lastSync) return true;
        return (Date.now() - lastSync) > this.ttl;
    }

    // ============ CACHE MANAGEMENT ============

    /**
     * Clear cache for a specific network
     */
    clear(network) {
        if (network) {
            this.cache.agents.delete(network);
            this.cache.pools.delete(network);
            this.cache.agentsList.delete(network);
            this.cache.poolsList.delete(network);
            this.cache.metadata.delete(network);
            console.log(`🗑️  Cleared cache for network: ${network}`);
        } else {
            // Clear all
            this.cache.agents.clear();
            this.cache.pools.clear();
            this.cache.agentsList.clear();
            this.cache.poolsList.clear();
            this.cache.metadata.clear();
            console.log('🗑️  Cleared all cache');
        }
    }

    /**
     * Get cache statistics
     */
    getStats() {
        const totalRequests = this.stats.hits + this.stats.misses;
        const hitRate = totalRequests > 0
            ? ((this.stats.hits / totalRequests) * 100).toFixed(2)
            : '0';

        return {
            enabled: this.enabled,
            hits: this.stats.hits,
            misses: this.stats.misses,
            hitRate: `${hitRate}%`,
            syncs: this.stats.syncs,
            syncFailures: this.stats.syncFailures,
            lastSync: this.stats.lastSyncTime,
            cacheSize: {
                agents: this.getCacheSize('agents'),
                pools: this.getCacheSize('pools')
            }
        };
    }

    /**
     * Get cache size (number of entries)
     */
    getCacheSize(type) {
        const result = {};
        this.cache[type].forEach((data, network) => {
            result[network] = data.size;
        });
        return result;
    }

    /**
     * Record a successful sync
     */
    recordSync(network, success = true) {
        if (success) {
            this.stats.syncs++;
        } else {
            this.stats.syncFailures++;
        }

        this.stats.lastSyncTime[network] = new Date().toISOString();
    }

    /**
     * Get cache health status
     */
    getHealth() {
        const networks = Array.from(this.cache.metadata.keys());
        const health = {};

        networks.forEach(network => {
            const metadata = this.cache.metadata.get(network);
            const isStale = this.isStale(metadata?.lastSync);

            health[network] = {
                status: isStale ? 'stale' : 'healthy',
                lastSync: this.getLastSync(network),
                agents: this.cache.agents.get(network)?.size || 0,
                pools: this.cache.pools.get(network)?.size || 0
            };
        });

        return health;
    }
}

module.exports = BlockchainCache;
