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

        // [ROBUSTNESS F-R12] Per-key refresh errors. A refresh that fails used to
        // be swallowed here, leaving the PREVIOUS value in `cache` — and the
        // getters then returned it even though its TTL had expired and nothing
        // had been re-read. An unattended agent sizing a loan off a credit limit
        // that is minutes or hours old, with no signal that the read failed, is
        // exactly the silent-stale-state failure this pass is looking for.
        this.errors = {};

        // [ROBUSTNESS F-R13] Reorg awareness. Nothing here used to be tied to a
        // block, so a cache entry populated on a block that was later reorged
        // away kept being served for the rest of its TTL.
        this.headCheckIntervalMs = 5000;
        this._maxSeenBlock = null;
        this._lastHeadCheck = 0;
    }

    /** Provider for the head check, if the owning agent exposes one. */
    get _provider() {
        const p = this.agent && (this.agent.provider || (this.agent.wallet && this.agent.wallet.provider));
        return p && typeof p.getBlockNumber === 'function' ? p : null;
    }

    /**
     * [F-R13] Drop the whole cache if the chain head went backwards (a reorg, or
     * an RPC that load-balanced onto a lagging replica). Rate-limited to one
     * `eth_blockNumber` per `headCheckIntervalMs`, so it costs far less than
     * the refetch it prevents.
     * @returns {Promise<boolean>} true when a rollback was detected and the cache dropped
     */
    async checkForReorg() {
        const p = this._provider;
        if (!p) return false;
        const now = Date.now();
        if (now - this._lastHeadCheck < this.headCheckIntervalMs) return false;
        this._lastHeadCheck = now;
        let head;
        try { head = Number(await p.getBlockNumber()); } catch (_) { return false; }
        if (!Number.isFinite(head)) return false;
        if (this._maxSeenBlock !== null && head < this._maxSeenBlock) {
            const from = this._maxSeenBlock;
            this._maxSeenBlock = head;
            this.invalidateCache();
            console.warn(`StateManager: chain head went backwards (${from} -> ${head}); cache dropped (reorg or lagging RPC).`);
            return true;
        }
        if (this._maxSeenBlock === null || head > this._maxSeenBlock) this._maxSeenBlock = head;
        return false;
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
        for (const k of keys) { this.timestamps[k] = now; delete this.errors[k]; }
    }

    /**
     * [F-R12] Return the cached value, or THROW if the last refresh of this key
     * failed and the cached value is not fresh. Never serve expired data as if
     * it were current.
     */
    _serve(key) {
        if (this.isCacheValid(key)) return this.cache[key];
        const err = this.errors[key];
        if (err) {
            const e = new Error(
                `StateManager: ${key} could not be refreshed (${err.message}) and the cached value is stale ` +
                '— refusing to return it. Retry, or read the contract directly.');
            e.code = 'SPECULAR_STATE_STALE';
            e.cause = err;
            throw e;
        }
        return this.cache[key];
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
            // "not initialized" is a legitimate answer for a fresh agent, not a
            // read failure — everything else is recorded so the getters refuse
            // to serve the stale previous value. (F-R12)
            const benign = error.message.includes('not initialized');
            for (const k of ['reputation', 'creditLimit', 'collateralRequirement']) {
                this.errors[k] = benign ? undefined : error;
                if (benign) delete this.errors[k];
            }
            if (!benign) console.error('Failed to refresh reputation:', error.message);
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
            const benign = error.message.includes('not registered');
            if (benign) delete this.errors.agentInfo;
            else { this.errors.agentInfo = error; console.error('Failed to refresh agent info:', error.message); }
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
            this.errors.activeLoans = error;
            console.error('Failed to refresh loans:', error.message);
        }
    }

    /**
     * Get cached reputation or fetch from blockchain
     */
    async getReputation(forceRefresh = false) {
        await this.checkForReorg();
        if (!forceRefresh && this.isCacheValid('reputation') && this.cache.reputation !== null) {
            return this.cache.reputation;
        }

        await this.refreshReputation();
        return this._serve('reputation');
    }

    /**
     * Get cached agent info or fetch from blockchain
     */
    async getAgentInfo(forceRefresh = false) {
        await this.checkForReorg();
        if (!forceRefresh && this.isCacheValid('agentInfo') && this.cache.agentInfo !== null) {
            return this.cache.agentInfo;
        }

        await this.refreshAgentInfo();
        return this._serve('agentInfo');
    }

    /**
     * Get cached loans or fetch from blockchain
     */
    async getLoans(forceRefresh = false) {
        await this.checkForReorg();
        if (!forceRefresh && this.isCacheValid('activeLoans')) {
            return this.cache.activeLoans;
        }

        await this.refreshLoans();
        return this._serve('activeLoans');
    }

    /**
     * Get cached credit limit
     */
    async getCreditLimit(forceRefresh = false) {
        await this.checkForReorg();
        if (!forceRefresh && this.isCacheValid('creditLimit') && this.cache.creditLimit !== null) {
            return this.cache.creditLimit;
        }

        await this.refreshReputation();
        return this._serve('creditLimit');
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
        this.errors = {};
    }

    /**
     * Invalidate specific cache key
     */
    invalidateKey(key) {
        this.cache[key] = null;
        delete this.timestamps[key];
        delete this.errors[key];
    }

    /**
     * Set cache TTL
     */
    setCacheTTL(ttl) {
        this.cacheTTL = ttl;
    }
}

module.exports = StateManager;
