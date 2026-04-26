/**
 * Background Sync Worker
 * Periodically fetches blockchain data and updates the cache
 * Runs independently to keep cache fresh without blocking API requests
 */

const { ethers } = require('ethers');

class SyncWorker {
    constructor(cache, networks, contracts, options = {}) {
        this.cache = cache;
        this.networks = networks;
        this.contracts = contracts; // Function to get contracts for a network
        this.enabled = options.enabled !== false;
        this.syncInterval = options.syncInterval || 30000; // Default: 30 seconds
        this.intervalId = null;
        this.isSyncing = false;

        // Per-network sync intervals (in milliseconds)
        this.networkIntervals = {
            arc: 300000,      // 5 minutes (49 agents = slow)
            base: 60000,      // 1 minute (1 agent = fast)
            arbitrum: 60000   // 1 minute (0 agents = fast)
        };

        // Track last sync time per network
        this.lastSyncTime = {
            arc: 0,
            base: 0,
            arbitrum: 0
        };

        // Sync timeout (3 minutes max)
        this.syncTimeout = 180000;

        console.log(`⚡ SyncWorker initialized (enabled: ${this.enabled}, intervals:`, this.networkIntervals, ')');
    }

    /**
     * Start the background sync worker
     */
    start() {
        if (!this.enabled) {
            console.log('⏸️  SyncWorker disabled (ENABLE_CACHE=false)');
            return;
        }

        if (this.intervalId) {
            console.log('⚠️  SyncWorker already running');
            return;
        }

        console.log(`🚀 Starting SyncWorker (check interval: 30s, network intervals:`, this.networkIntervals, ')');

        // Run first sync immediately
        this.syncAll().catch(err => {
            console.error('❌ Initial sync failed:', err.message);
            this.isSyncing = false; // Reset flag on error
        });

        // Then check for syncs periodically (every 30 seconds)
        // Each network will only sync when its specific interval has passed
        this.intervalId = setInterval(async () => {
            if (!this.isSyncing) {
                try {
                    await this.syncAll();
                } catch (error) {
                    console.error('❌ Sync cycle failed:', error.message);
                    this.isSyncing = false; // Reset flag on error
                }
            } else {
                console.log('⏭️  Skipping sync check (previous sync still in progress)');
            }
        }, 30000); // Check every 30 seconds

        console.log('✅ SyncWorker started successfully');
    }

    /**
     * Stop the background sync worker
     */
    stop() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
            console.log('🛑 SyncWorker stopped');
        }
    }

    /**
     * Sync all networks
     */
    async syncAll() {
        this.isSyncing = true;
        const startTime = Date.now();

        console.log('\n🔄 Starting sync cycle...');

        const networkKeys = Object.keys(this.networks);
        const results = [];
        const now = Date.now();

        for (const networkKey of networkKeys) {
            try {
                // Check if enough time has passed since last sync
                const interval = this.networkIntervals[networkKey] || this.syncInterval;
                const timeSinceLastSync = now - this.lastSyncTime[networkKey];

                if (timeSinceLastSync < interval) {
                    const timeRemaining = Math.ceil((interval - timeSinceLastSync) / 1000);
                    console.log(`  ⏭️  Skipping ${networkKey} (next sync in ${timeRemaining}s)`);
                    results.push({ network: networkKey, skipped: true });
                    continue;
                }

                // Sync with timeout
                await Promise.race([
                    this.syncNetwork(networkKey),
                    new Promise((_, reject) =>
                        setTimeout(() => reject(new Error(`Sync timeout after ${this.syncTimeout / 1000}s`)), this.syncTimeout)
                    )
                ]);

                this.lastSyncTime[networkKey] = Date.now();
                results.push({ network: networkKey, success: true });
            } catch (error) {
                console.error(`❌ Failed to sync ${networkKey}:`, error.message);
                results.push({ network: networkKey, success: false, error: error.message });
                this.cache.recordSync(networkKey, false);
            }
        }

        const duration = Date.now() - startTime;
        const successCount = results.filter(r => r.success).length;
        const skippedCount = results.filter(r => r.skipped).length;

        console.log(`✅ Sync cycle complete (${successCount} synced, ${skippedCount} skipped, ${duration}ms)`);
        this.isSyncing = false;
    }

    /**
     * Sync a single network
     */
    async syncNetwork(networkKey) {
        const startTime = Date.now();
        console.log(`  📡 Syncing ${networkKey}...`);

        const { registry, marketplace, reputationManager } = this.contracts(networkKey);

        // Fetch agents and pools in parallel
        const [agents, pools] = await Promise.all([
            this.fetchAllAgents(networkKey, registry, reputationManager, marketplace),
            this.fetchAllPools(networkKey, marketplace, registry)
        ]);

        // Update cache
        this.cache.setAgents(networkKey, agents);
        this.cache.setPools(networkKey, pools);
        this.cache.recordSync(networkKey, true);

        const duration = Date.now() - startTime;
        console.log(`  ✅ ${networkKey}: ${agents.length} agents, ${pools.length} pools (${duration}ms)`);
    }

    /**
     * Fetch all agents from the blockchain
     */
    async fetchAllAgents(networkKey, registry, reputationManager, marketplace) {
        const network = this.networks[networkKey];
        const totalAgents = Number(await registry.totalAgents());

        if (totalAgents === 0) {
            return [];
        }

        const agents = [];
        const batchSize = 10; // Fetch 10 agents at a time

        for (let i = 1; i <= totalAgents; i += batchSize) {
            const batch = [];

            for (let j = i; j < Math.min(i + batchSize, totalAgents + 1); j++) {
                batch.push(this.fetchAgent(j, registry, reputationManager, marketplace));
            }

            const batchResults = await Promise.all(batch);
            agents.push(...batchResults.filter(a => a !== null));
        }

        return agents;
    }

    /**
     * Fetch a single agent's data
     */
    async fetchAgent(agentId, registry, reputationManager, marketplace) {
        try {
            const agent = await registry.agents(agentId);

            // Skip inactive or non-existent agents
            if (!agent.isActive && agent.owner === ethers.ZeroAddress) {
                return null;
            }

            const agentAddress = agent.agentWallet;

            // Fetch reputation and credit data
            const [score, limit, interestRate] = await Promise.all([
                reputationManager['getReputationScore(address)'](agentAddress),
                reputationManager['calculateCreditLimit(address)'](agentAddress),
                reputationManager.calculateInterestRate(agentAddress)
            ]);

            // Get active pools for this agent
            const totalPools = await marketplace.totalPools();
            const agentPools = [];

            for (let i = 0; i < Number(totalPools); i++) {
                try {
                    const poolAgentId = await marketplace.agentPoolIds(i);
                    if (poolAgentId === BigInt(agentId)) {
                        const pool = await marketplace.agentPools(poolAgentId);
                        if (pool.isActive) {
                            agentPools.push({
                                poolId: i + 1,
                                liquidity: Number(ethers.formatUnits(pool.totalLiquidity, 6)),
                                available: Number(ethers.formatUnits(pool.availableLiquidity, 6))
                            });
                        }
                    }
                } catch (e) {
                    // Pool might not exist, skip
                }
            }

            return {
                agentId: Number(agentId),
                owner: agent.owner,
                agentWallet: agent.agentWallet,
                agentURI: agent.agentURI,
                reputationScore: Number(score),
                creditLimit: Number(ethers.formatUnits(limit, 6)),
                interestRate: Number(interestRate) / 100,
                registrationTime: Number(agent.registrationTime),
                isActive: agent.isActive,
                pools: agentPools
            };
        } catch (error) {
            console.error(`    ⚠️  Failed to fetch agent ${agentId}:`, error.message);
            return null;
        }
    }

    /**
     * Fetch all pools from the blockchain
     */
    async fetchAllPools(networkKey, marketplace, registry) {
        const network = this.networks[networkKey];
        const totalPools = Number(await marketplace.totalPools());

        if (totalPools === 0) {
            return [];
        }

        const pools = [];
        const batchSize = 10;

        for (let i = 0; i < totalPools; i += batchSize) {
            const batch = [];

            for (let j = i; j < Math.min(i + batchSize, totalPools); j++) {
                batch.push(this.fetchPool(j, marketplace, registry));
            }

            const batchResults = await Promise.all(batch);
            pools.push(...batchResults.filter(p => p !== null));
        }

        return pools;
    }

    /**
     * Fetch a single pool's data
     */
    async fetchPool(poolIndex, marketplace, registry) {
        try {
            const agentId = await marketplace.agentPoolIds(poolIndex);
            const pool = await marketplace.agentPools(agentId);

            if (!pool.isActive) {
                return null;
            }

            // Get agent info
            const agent = await registry.agents(agentId);

            return {
                poolId: poolIndex + 1,
                agentId: Number(agentId),
                agentWallet: agent.agentWallet,
                agentOwner: agent.owner,
                totalLiquidity: Number(ethers.formatUnits(pool.totalLiquidity, 6)),
                availableLiquidity: Number(ethers.formatUnits(pool.availableLiquidity, 6)),
                totalLoaned: Number(ethers.formatUnits(pool.totalLiquidity - pool.availableLiquidity, 6)),
                totalEarned: Number(ethers.formatUnits(pool.totalEarned, 6)),
                isActive: pool.isActive
            };
        } catch (error) {
            console.error(`    ⚠️  Failed to fetch pool ${poolIndex}:`, error.message);
            return null;
        }
    }

    /**
     * Force sync a specific network (useful for debugging)
     */
    async forceSyncNetwork(networkKey) {
        console.log(`🔨 Force syncing ${networkKey}...`);
        await this.syncNetwork(networkKey);
    }
}

module.exports = SyncWorker;
