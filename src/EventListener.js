/**
 * Event listener for monitoring blockchain events.
 *
 * Resilience (M5): a dropped WebSocket makes ethers stop delivering events
 * SILENTLY — no error is thrown and `isListening` stays true, so a consumer
 * watching for e.g. LoanDefaulted goes blind indefinitely. This listener keeps
 * a block heartbeat and a watchdog; on a provider error or a stall it tears the
 * subscriptions down, re-subscribes, and BACKFILLS any events missed while
 * disconnected via queryFilter from the last block it saw.
 */

// Single source of truth for every subscription. `map(...args)` turns the raw
// event args into the payload we emit — reused for both live subscription and
// reconnect backfill so the two can never drift.
const EVENT_SPECS = [
    { contract: 'agentRegistry', event: 'AgentRegistered',
      map: (agent, metadata, timestamp) => ({ agent, metadata, timestamp }) },
    { contract: 'agentRegistry', event: 'MetadataUpdated',
      map: (agent, metadata) => ({ agent, metadata }) },
    { contract: 'agentRegistry', event: 'AgentDeactivated',
      map: (agent) => ({ agent }) },
    { contract: 'reputationManager', event: 'ReputationUpdated',
      map: (agent, newScore, reason) => ({ agent, newScore: Number(newScore), reason }) },
    { contract: 'reputationManager', event: 'ReputationInitialized',
      map: (agent, score) => ({ agent, score: Number(score) }) },
    { contract: 'lendingPool', event: 'LoanRequested',
      map: (loanId, borrower, amount, durationDays) => ({ loanId: Number(loanId), borrower, amount, durationDays: Number(durationDays) }) },
    { contract: 'lendingPool', event: 'LoanApproved',
      map: (loanId, interestRate) => ({ loanId: Number(loanId), interestRate: Number(interestRate) }) },
    { contract: 'lendingPool', event: 'LoanRepaid',
      map: (loanId, borrower, totalAmount, onTime) => ({ loanId: Number(loanId), borrower, totalAmount, onTime }) },
    { contract: 'lendingPool', event: 'LoanDefaulted',
      map: (loanId, borrower) => ({ loanId: Number(loanId), borrower }) },
    { contract: 'lendingPool', event: 'LiquidityDeposited',
      map: (provider, amount) => ({ provider, amount }) },
];

class EventListener {
    constructor(provider, contracts, options = {}) {
        this.provider = provider;
        this.contracts = contracts;
        this.listeners = new Map();
        this.isListening = false;

        // Reconnect machinery
        this._subs = [];              // { contract, contractName, event, handler }
        this._blockHandler = null;
        this._errorHandler = null;
        this._watchdog = null;
        this._reconnecting = false;
        this._lastSeenBlock = null;
        this._lastBlockAt = null;
        this._staleMs = options.staleMs || 60000;      // no block this long ⇒ reconnect
        this._watchdogMs = options.watchdogMs || 20000; // how often to check
    }

    /** Register an event listener */
    on(eventName, callback) {
        if (!this.listeners.has(eventName)) this.listeners.set(eventName, []);
        this.listeners.get(eventName).push(callback);
    }

    /** Remove an event listener */
    off(eventName, callback) {
        if (!this.listeners.has(eventName)) return;
        const callbacks = this.listeners.get(eventName);
        const index = callbacks.indexOf(callback);
        if (index > -1) callbacks.splice(index, 1);
    }

    /** Start listening for events */
    async start() {
        if (this.isListening) {
            console.log('Event listener already running');
            return;
        }
        this.isListening = true;
        console.log('Starting event listener...');

        this._subscribeAll();
        this._startHeartbeat();

        console.log('Event listener started');
    }

    /**
     * Subscribe to every spec, recording the exact handler we attached so we
     * can later detach ONLY ours — never removeAllListeners() on the shared
     * contract instances, which would kill subscriptions other code registered.
     */
    _subscribeAll() {
        for (const spec of EVENT_SPECS) {
            const contract = this.contracts && this.contracts[spec.contract];
            if (!contract || typeof contract.on !== 'function') continue;
            const handler = (...args) => this.emit(spec.event, spec.map(...args));
            contract.on(spec.event, handler);
            this._subs.push({ contract, contractName: spec.contract, event: spec.event, handler });
        }
    }

    /** Detach only the handlers we attached. */
    _unsubscribeAll() {
        for (const sub of this._subs) {
            try { sub.contract.off(sub.event, sub.handler); } catch (_) { /* ignore */ }
        }
        this._subs = [];
    }

    /**
     * Block heartbeat + watchdog. If the provider can't emit 'block'/'error'
     * (e.g. a non-standard provider), this quietly no-ops — start() still works.
     */
    _startHeartbeat() {
        if (!this.provider || typeof this.provider.on !== 'function') return;

        this._blockHandler = (blockNumber) => {
            this._lastSeenBlock = Number(blockNumber);
            this._lastBlockAt = Date.now();
        };
        this._errorHandler = () => { this._reconnect('provider error'); };

        try {
            this.provider.on('block', this._blockHandler);
            this.provider.on('error', this._errorHandler);
        } catch (_) { /* provider doesn't support these events */ }

        this._lastBlockAt = Date.now(); // grace period before first watchdog check
        this._watchdog = setInterval(() => {
            if (!this.isListening || this._reconnecting) return;
            if (this._lastBlockAt && (Date.now() - this._lastBlockAt) > this._staleMs) {
                this._reconnect('block stall');
            }
        }, this._watchdogMs);
        if (typeof this._watchdog.unref === 'function') this._watchdog.unref();
    }

    _stopHeartbeat() {
        if (this._watchdog) { clearInterval(this._watchdog); this._watchdog = null; }
        if (this.provider && typeof this.provider.off === 'function') {
            try { if (this._blockHandler) this.provider.off('block', this._blockHandler); } catch (_) {}
            try { if (this._errorHandler) this.provider.off('error', this._errorHandler); } catch (_) {}
        }
        this._blockHandler = null;
        this._errorHandler = null;
    }

    /**
     * Tear down and re-establish subscriptions, backfilling events missed while
     * disconnected. Guarded against re-entrancy so a burst of provider errors
     * triggers a single reconnect.
     */
    async _reconnect(reason) {
        if (this._reconnecting || !this.isListening) return;
        this._reconnecting = true;
        const from = this._lastSeenBlock;
        console.warn(`Event listener reconnecting (${reason})…`);
        try {
            this._unsubscribeAll();
            this._subscribeAll();
            if (from != null) await this._backfill(from + 1);
            console.warn('Event listener reconnected');
        } catch (e) {
            console.error('Event listener reconnect failed:', e.message);
        } finally {
            this._lastBlockAt = Date.now();
            this._reconnecting = false;
        }
    }

    /** Re-emit events between `fromBlock` and head that we may have missed. */
    async _backfill(fromBlock) {
        for (const spec of EVENT_SPECS) {
            const contract = this.contracts && this.contracts[spec.contract];
            if (!contract || typeof contract.queryFilter !== 'function') continue;
            let filter;
            try { filter = contract.filters[spec.event](); } catch (_) { continue; }
            let events;
            try { events = await contract.queryFilter(filter, fromBlock, 'latest'); } catch (_) { continue; }
            for (const ev of events) {
                try { this.emit(spec.event, spec.map(...ev.args)); } catch (_) { /* ignore one bad event */ }
            }
        }
    }

    /** Stop listening for events */
    stop() {
        if (!this.isListening) return;
        console.log('Stopping event listener...');
        this._stopHeartbeat();
        this._unsubscribeAll();  // precise removal — do NOT removeAllListeners() on shared contracts
        this.isListening = false;
        console.log('Event listener stopped');
    }

    /** Emit event to registered callbacks */
    emit(eventName, data) {
        if (!this.listeners.has(eventName)) return;
        for (const callback of this.listeners.get(eventName)) {
            try { callback(data); } catch (error) {
                console.error(`Error in ${eventName} callback:`, error);
            }
        }
    }

    /**
     * Query past events. Note: a fromBlock of 0 can exceed public-RPC block-range
     * limits on busy networks — pass a bounded range for large histories.
     */
    async queryPastEvents(contractName, eventName, fromBlock = 0, toBlock = 'latest') {
        const contract = this.contracts[contractName];
        const filter = contract.filters[eventName]();
        const events = await contract.queryFilter(filter, fromBlock, toBlock);
        return events.map(event => ({
            blockNumber: event.blockNumber,
            transactionHash: event.transactionHash,
            args: event.args
        }));
    }

    /** Remove all registered app-level callbacks (not contract subscriptions). */
    removeAllListeners() {
        this.listeners.clear();
    }
}

module.exports = EventListener;
