/**
 * Event listener for monitoring blockchain events
 */
class EventListener {
    constructor(provider, contracts) {
        this.provider = provider;
        this.contracts = contracts;
        this.listeners = new Map();
        this.isListening = false;
    }

    /**
     * Register an event listener
     */
    on(eventName, callback) {
        if (!this.listeners.has(eventName)) {
            this.listeners.set(eventName, []);
        }
        this.listeners.get(eventName).push(callback);
    }

    /**
     * Remove an event listener
     */
    off(eventName, callback) {
        if (!this.listeners.has(eventName)) {
            return;
        }

        const callbacks = this.listeners.get(eventName);
        const index = callbacks.indexOf(callback);
        if (index > -1) {
            callbacks.splice(index, 1);
        }
    }

    /**
     * Start listening for events
     */
    async start() {
        if (this.isListening) {
            console.log('Event listener already running');
            return;
        }

        this.isListening = true;
        console.log('Starting event listener...');

        // Listen for AgentRegistry events
        this.contracts.agentRegistry.on('AgentRegistered', (agent, metadata, timestamp) => {
            this.emit('AgentRegistered', { agent, metadata, timestamp });
        });

        this.contracts.agentRegistry.on('MetadataUpdated', (agent, metadata) => {
            this.emit('MetadataUpdated', { agent, metadata });
        });

        this.contracts.agentRegistry.on('AgentDeactivated', (agent) => {
            this.emit('AgentDeactivated', { agent });
        });

        // Listen for ReputationManager events
        this.contracts.reputationManager.on('ReputationUpdated', (agent, newScore, reason) => {
            this.emit('ReputationUpdated', {
                agent,
                newScore: Number(newScore),
                reason
            });
        });

        this.contracts.reputationManager.on('ReputationInitialized', (agent, score) => {
            this.emit('ReputationInitialized', {
                agent,
                score: Number(score)
            });
        });

        // Listen for LendingPool events
        this.contracts.lendingPool.on('LoanRequested', (loanId, borrower, amount, durationDays) => {
            this.emit('LoanRequested', {
                loanId: Number(loanId),
                borrower,
                amount,
                durationDays: Number(durationDays)
            });
        });

        this.contracts.lendingPool.on('LoanApproved', (loanId, interestRate) => {
            this.emit('LoanApproved', {
                loanId: Number(loanId),
                interestRate: Number(interestRate)
            });
        });

        this.contracts.lendingPool.on('LoanRepaid', (loanId, borrower, totalAmount, onTime) => {
            this.emit('LoanRepaid', {
                loanId: Number(loanId),
                borrower,
                totalAmount,
                onTime
            });
        });

        this.contracts.lendingPool.on('LoanDefaulted', (loanId, borrower) => {
            this.emit('LoanDefaulted', {
                loanId: Number(loanId),
                borrower
            });
        });

        this.contracts.lendingPool.on('LiquidityDeposited', (provider, amount) => {
            this.emit('LiquidityDeposited', {
                provider,
                amount
            });
        });

        console.log('Event listener started');
    }

    /**
     * Stop listening for events
     */
    stop() {
        if (!this.isListening) {
            return;
        }

        console.log('Stopping event listener...');

        // Remove all listeners from contracts
        this.contracts.agentRegistry.removeAllListeners();
        this.contracts.reputationManager.removeAllListeners();
        this.contracts.lendingPool.removeAllListeners();

        this.isListening = false;
        console.log('Event listener stopped');
    }

    /**
     * Emit event to registered callbacks
     */
    emit(eventName, data) {
        if (!this.listeners.has(eventName)) {
            return;
        }

        const callbacks = this.listeners.get(eventName);
        for (const callback of callbacks) {
            try {
                callback(data);
            } catch (error) {
                console.error(`Error in ${eventName} callback:`, error);
            }
        }
    }

    /**
     * Query past events
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

    /**
     * Remove all listeners
     */
    removeAllListeners() {
        this.listeners.clear();
    }
}

module.exports = EventListener;
