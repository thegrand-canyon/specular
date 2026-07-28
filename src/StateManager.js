/**
 * Manages agent state caching and synchronization
 */
class StateManager {
    constructor(agent) {
        this.agent = agent;
        this.cache = {
            reputation: null,
            agentInfo: null,
            activeLoans: [],
            creditLimit: null,
            collateralRequirement: null,
            lastUpdate: null
        };
        // Per-key freshness timestamps. A single shared lastUpdate (set only by
        // syncState) made per-key TTLs wrong in both directions: an individual
        // refreshX() left the timestamp stale so its fresh data read as expired,
        // while syncState marked never-refreshed keys as fresh. Each key now
        // stamps itself on successful refresh.
        this.timestamps = {};
        this.cacheTTL = 30000; // 30 seconds default TTL
    }

    /**
     * Check if a specific cache key is still within its TTL.
     */
    isCacheValid(cacheKey) {
        const ts = this.timestamps[cacheKey];
        if (!ts || this.cache[cacheKey] == null) {
            return false;
        }
        return (Date.now() - ts) < this.cacheTTL;
    }

    /**
     * Mark the given cache keys as freshly fetched (now).
     */
    _stamp(...keys) {
        const now = Date.now();
        for (const k of keys) this.timestamps[k] = now;
    }

    /**
     * Update cache timestamp (back-compat): stamps every cache field.
     */
    updateTimestamp() {
        this.cache.lastUpdate = Date.now();
        this._stamp('reputation', 'agentInfo', 'activeLoans', 'creditLimit', 'collateralRequirement');
    }

    /**
     * Sync all agent state from blockchain
     */
    async syncState() {
        console.log('Syncing agent state from blockchain...');

        await Promise.all([
            this.refreshReputation(),
            this.refreshAgentInfo(),
            this.refreshLoans()
        ]);

        this.updateTimestamp();
        console.log('State sync complete');
    }

    /**
     * Refresh reputation score
     */
    async refreshReputation() {
        try {
            // Use address-based function for backwards compatibility (handles both V1 and V2)
            const score = await this.agent.contracts.reputationManager['getReputationScore(address)'](
                this.agent.address
            );
            this.cache.reputation = Number(score);

            // Also refresh credit limit and collateral requirement
            const creditLimit = await this.agent.contracts.reputationManager['calculateCreditLimit(address)'](
                this.agent.address
            );
            this.cache.creditLimit = creditLimit;

            const collateralReq = await this.agent.contracts.reputationManager['calculateCollateralRequirement(address)'](
                this.agent.address
            );
            this.cache.collateralRequirement = Number(collateralReq);

            this._stamp('reputation', 'creditLimit', 'collateralRequirement');
        } catch (error) {
            if (!error.message.includes('not initialized')) {
                console.error('Failed to refresh reputation:', error.message);
            }
        }
    }

    /**
     * Refresh agent info
     */
    async refreshAgentInfo() {
        try {
            const info = await this.agent.contracts.agentRegistry.getAgentInfo(
                this.agent.address
            );
            this.cache.agentInfo = {
                address: info.agentAddress,
                metadata: info.metadata,
                registrationTime: Number(info.registrationTime),
                isActive: info.isActive
            };
            this._stamp('agentInfo');
        } catch (error) {
            if (!error.message.includes('not registered')) {
                console.error('Failed to refresh agent info:', error.message);
            }
        }
    }

    /**
     * Refresh active loans
     */
    async refreshLoans() {
        try {
            const loanIds = await this.agent.contracts.lendingPool.getBorrowerLoans(
                this.agent.address
            );

            const loans = [];
            for (const loanId of loanIds) {
                const loan = await this.agent.contracts.lendingPool.getLoan(loanId);
                loans.push({
                    loanId: Number(loanId),
                    amount: loan.amount,
                    durationDays: Number(loan.durationDays),
                    interestRate: Number(loan.interestRate),
                    state: Number(loan.state),
                    startTime: Number(loan.startTime),
                    endTime: Number(loan.endTime),
                    collateralAmount: loan.collateralAmount
                });
            }

            this.cache.activeLoans = loans;
            this._stamp('activeLoans');
        } catch (error) {
            console.error('Failed to refresh loans:', error.message);
        }
    }

    /**
     * Get cached reputation or fetch from blockchain
     */
    async getReputation(forceRefresh = false) {
        if (!forceRefresh && this.isCacheValid('reputation') && this.cache.reputation !== null) {
            return this.cache.reputation;
        }

        await this.refreshReputation();
        return this.cache.reputation;
    }

    /**
     * Get cached agent info or fetch from blockchain
     */
    async getAgentInfo(forceRefresh = false) {
        if (!forceRefresh && this.isCacheValid('agentInfo') && this.cache.agentInfo !== null) {
            return this.cache.agentInfo;
        }

        await this.refreshAgentInfo();
        return this.cache.agentInfo;
    }

    /**
     * Get cached loans or fetch from blockchain
     */
    async getLoans(forceRefresh = false) {
        if (!forceRefresh && this.isCacheValid('activeLoans')) {
            return this.cache.activeLoans;
        }

        await this.refreshLoans();
        return this.cache.activeLoans;
    }

    /**
     * Get cached credit limit
     */
    async getCreditLimit(forceRefresh = false) {
        if (!forceRefresh && this.isCacheValid('creditLimit') && this.cache.creditLimit !== null) {
            return this.cache.creditLimit;
        }

        await this.refreshReputation();
        return this.cache.creditLimit;
    }

    /**
     * Invalidate all cache
     */
    invalidateCache() {
        this.cache = {
            reputation: null,
            agentInfo: null,
            activeLoans: [],
            creditLimit: null,
            collateralRequirement: null,
            lastUpdate: null
        };
        this.timestamps = {};
    }

    /**
     * Invalidate specific cache key
     */
    invalidateKey(key) {
        this.cache[key] = null;
        delete this.timestamps[key];
    }

    /**
     * Set cache TTL
     */
    setCacheTTL(ttl) {
        this.cacheTTL = ttl;
    }
}

module.exports = StateManager;
