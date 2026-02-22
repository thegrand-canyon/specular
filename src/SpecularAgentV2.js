const { ethers } = require('ethers');
const ContractManager = require('./ContractManager');
const StateManager = require('./StateManager');
const EventListener = require('./EventListener');
const ERC8004Manager = require('./ERC8004Manager');
const Formatter = require('./utils/formatting');
const Validator = require('./utils/validation');
const { RegistrationError, LoanError, InsufficientReputationError } = require('./utils/errors');

/**
 * @class SpecularAgentV2
 * @description ERC-8004 compliant AI agent for decentralized lending with NFT identity
 */
class SpecularAgentV2 {
    constructor(wallet, contractAddresses) {
        this.wallet = wallet;
        this.address = wallet.address;

        // Initialize managers
        this.contractManager = new ContractManager(wallet.provider, contractAddresses);

        // Get contract instances (V2 contracts)
        this.contracts = {
            agentRegistry: this.contractManager.getContract('AgentRegistryV2', wallet),
            reputationManager: this.contractManager.getContract('ReputationManagerV2', wallet),
            validationRegistry: this.contractManager.getContract('ValidationRegistry', wallet),
            lendingPool: this.contractManager.getContract('LendingPoolV2', wallet),
            mockUSDC: this.contractManager.getContract('MockUSDC', wallet)
        };

        this.stateManager = new StateManager(this);
        this.eventListener = new EventListener(this);
        this.erc8004 = new ERC8004Manager(wallet, this.contracts);
    }

    // ========== ERC-8004 Identity Registry ==========

    /**
     * Register agent with ERC-8004 NFT identity
     * @param {string} agentURI - URI to agent metadata (IPFS, HTTP, etc.)
     * @param {Object} metadata - Metadata object
     * @returns {Object} Registration result with agent ID
     */
    async register(agentURI, metadata = {}) {
        console.log(`Registering ERC-8004 agent ${this.address}...`);

        try {
            // Check if already registered
            const isRegistered = await this.contracts.agentRegistry.isRegistered(this.address);
            if (isRegistered) {
                throw new RegistrationError('Agent already registered');
            }

            // Convert metadata to array format
            const metadataArray = Object.entries(metadata).map(([key, value]) => ({
                key,
                value: typeof value === 'string' ? value : JSON.stringify(value)
            }));

            // Register and get agent NFT
            const result = await this.erc8004.registerAgentNFT(agentURI, metadataArray);

            // Initialize reputation (use address-based backwards compatibility function)
            console.log('Initializing reputation...');
            const currentNonce = await this.wallet.provider.getTransactionCount(this.address, 'latest');
            const reputationTx = await this.contracts.reputationManager['initializeReputation(address)'](
                this.address,
                { nonce: currentNonce }
            );
            await reputationTx.wait();
            console.log('Reputation initialized');

            // Refresh state
            await this.stateManager.syncState();

            return result;
        } catch (error) {
            throw new RegistrationError(`Registration failed: ${error.message}`);
        }
    }

    /**
     * Get agent NFT ID
     * @returns {number} Agent NFT ID
     */
    async getAgentId() {
        return await this.erc8004.getAgentId();
    }

    /**
     * Update agent metadata URI
     * @param {string} newURI - New metadata URI
     */
    async updateAgentURI(newURI) {
        return await this.erc8004.updateAgentURI(newURI);
    }

    /**
     * Get custom metadata
     * @param {string} key - Metadata key
     * @returns {string} Metadata value
     */
    async getMetadata(key) {
        return await this.erc8004.getMetadata(key);
    }

    /**
     * Set custom metadata
     * @param {string} key - Metadata key
     * @param {string|Object} value - Metadata value
     */
    async setMetadata(key, value) {
        return await this.erc8004.setMetadata(key, value);
    }

    // ========== Lending Functions ==========

    /**
     * Request a loan
     * @param {number} amount - Loan amount in USDC (without decimals)
     * @param {number} durationDays - Loan duration in days
     * @returns {string} Loan ID
     */
    async requestLoan(amount, durationDays) {
        console.log(`Requesting loan: ${amount} USDC for ${durationDays} days`);

        // Validate inputs
        Validator.validateLoanAmount(amount);
        Validator.validateLoanDuration(durationDays);

        try {
            // Check if agent is registered and active
            const isActive = await this.contracts.agentRegistry.isAgentActive(this.address);
            if (!isActive) {
                throw new LoanError('Agent not registered or inactive');
            }

            // Get reputation score and check credit limit
            const reputation = await this.getReputationScore();
            const creditLimit = await this.contracts.reputationManager['calculateCreditLimit(address)'](this.address);
            const creditLimitUSDC = Number(Formatter.formatUSDC(creditLimit));

            if (amount > creditLimitUSDC) {
                throw new InsufficientReputationError(
                    `Loan amount ${amount} USDC exceeds credit limit ${creditLimitUSDC} USDC`,
                    reputation,
                    'Higher'
                );
            }

            // Convert amount to token units (6 decimals)
            const amountInTokens = Formatter.parseUSDC(amount);

            // Check if collateral is required
            const collateralReq = await this.contracts.reputationManager['calculateCollateralRequirement(address)'](this.address);
            const collateralAmount = (amountInTokens * BigInt(collateralReq)) / 100n;

            if (collateralAmount > 0) {
                console.log(`Collateral required: ${Formatter.formatUSDC(collateralAmount)} USDC (${collateralReq}%)`);

                // Check USDC balance
                const balance = await this.contracts.mockUSDC.balanceOf(this.address);
                if (balance < collateralAmount) {
                    throw new LoanError(`Insufficient USDC balance for collateral. Need ${Formatter.formatUSDC(collateralAmount)} USDC`);
                }

                // Approve USDC for lending pool
                console.log('Approving USDC for collateral...');
                const approveTx = await this.contracts.mockUSDC.approve(
                    await this.contracts.lendingPool.getAddress(),
                    collateralAmount
                );
                await approveTx.wait();
                console.log('USDC approved');
            }

            // Request loan (fetch fresh nonce to avoid nonce issues after approval)
            const currentNonce = await this.wallet.provider.getTransactionCount(this.address, 'latest');
            const tx = await this.contracts.lendingPool.requestLoan(
                amountInTokens,
                durationDays,
                { nonce: currentNonce }
            );
            console.log(`Transaction sent: ${tx.hash}`);

            const receipt = await tx.wait();

            // Parse LoanRequested event to get loan ID
            const events = this.contractManager.parseEventLogs(receipt, this.contracts.lendingPool, 'LoanRequested');

            if (events.length === 0) {
                throw new LoanError('LoanRequested event not found in transaction');
            }

            const loanId = events[0].args.loanId;
            console.log(`Loan requested successfully. Loan ID: ${loanId}`);

            // Refresh state
            await this.stateManager.refreshLoans();

            return loanId.toString();
        } catch (error) {
            throw new LoanError(`Loan request failed: ${error.message}`);
        }
    }

    /**
     * Repay a loan
     * @param {number} loanId - Loan ID to repay
     * @returns {Object} Transaction receipt
     */
    async repayLoan(loanId) {
        Validator.validateLoanId(loanId);

        try {
            const loan = await this.contracts.lendingPool.loans(loanId);

            // Calculate total amount (principal + interest)
            const totalAmount = await this.contracts.lendingPool.calculateTotalRepayment(loanId);

            console.log(`Repaying loan ${loanId}: ${Formatter.formatUSDC(totalAmount)} USDC`);

            // Approve USDC
            const approveTx = await this.contracts.mockUSDC.approve(
                await this.contracts.lendingPool.getAddress(),
                totalAmount
            );
            await approveTx.wait();

            // Repay loan
            const tx = await this.contracts.lendingPool.repayLoan(loanId);
            const receipt = await tx.wait();

            console.log(`Loan repaid in block ${receipt.blockNumber}`);

            // Refresh state
            await this.stateManager.refreshLoans();
            await this.stateManager.refreshReputation();

            return receipt;
        } catch (error) {
            throw new LoanError(`Loan repayment failed: ${error.message}`);
        }
    }

    /**
     * Get reputation score
     * @param {boolean} forceRefresh - Force refresh from blockchain
     * @returns {number} Reputation score (0-1000)
     */
    async getReputationScore(forceRefresh = false) {
        return await this.stateManager.getReputation(forceRefresh);
    }

    /**
     * Get agent information
     * @param {boolean} forceRefresh - Force refresh from blockchain
     * @returns {Object} Agent info
     */
    async getAgentInfo(forceRefresh = false) {
        return await this.stateManager.getAgentInfo(forceRefresh);
    }

    /**
     * Get loan status
     * @param {number} loanId - Loan ID
     * @returns {Object} Loan details
     */
    async getLoanStatus(loanId) {
        Validator.validateLoanId(loanId);

        try {
            const loan = await this.contracts.lendingPool.getLoan(loanId);

            return {
                loanId: loanId.toString(),
                borrower: loan.borrower,
                amount: Formatter.formatUSDC(loan.amount),
                durationDays: Number(loan.durationDays),
                interestRate: Formatter.formatInterestRate(loan.interestRate),
                state: Formatter.formatLoanState(loan.state),
                startTime: loan.startTime > 0 ? Formatter.formatTimestamp(loan.startTime) : null,
                endTime: loan.endTime > 0 ? Formatter.formatTimestamp(loan.endTime) : null,
                collateralAmount: Formatter.formatUSDC(loan.collateralAmount)
            };
        } catch (error) {
            throw new LoanError(`Failed to get loan status: ${error.message}`, loanId);
        }
    }

    /**
     * Get all loans for this agent
     * @param {boolean} forceRefresh - Force refresh from blockchain
     * @returns {Array} Array of loan objects
     */
    async getLoans(forceRefresh = false) {
        return await this.stateManager.getLoans(forceRefresh);
    }

    /**
     * Get credit limit based on reputation
     * @returns {string} Credit limit in USDC
     */
    async getCreditLimit() {
        const limit = await this.stateManager.getCreditLimit();
        // Handle case where reputation is not initialized yet
        if (limit === null || limit === undefined) {
            return '0.0';
        }
        return Formatter.formatUSDC(limit);
    }

    /**
     * Update agent metadata
     * @param {string} metadata - New metadata
     * @returns {Object} Transaction receipt
     */
    async updateMetadata(metadata) {
        const metadataStr = typeof metadata === 'object' ? JSON.stringify(metadata) : metadata;
        Validator.validateMetadata(metadataStr);

        const tx = await this.contracts.agentRegistry.updateMetadata(metadataStr);
        const receipt = await tx.wait();

        await this.stateManager.refreshAgentInfo();

        return receipt;
    }

    // ========== ERC-8004 Feedback Functions ==========

    /**
     * Submit feedback for another agent
     * @param {number} targetAgentId - Agent ID to give feedback to
     * @param {number} score - Feedback score
     * @param {Object} options - Feedback options
     */
    async giveFeedback(targetAgentId, score, options = {}) {
        return await this.erc8004.giveFeedback(targetAgentId, score, options);
    }

    /**
     * Get all feedback for this agent
     * @param {Object} filters - Optional filters
     */
    async getFeedback(filters = {}) {
        return await this.erc8004.getAllFeedback(null, filters);
    }

    /**
     * Get feedback summary
     * @param {Object} filters - Optional filters
     */
    async getFeedbackSummary(filters = {}) {
        return await this.erc8004.getFeedbackSummary(null, filters);
    }

    /**
     * Respond to feedback
     * @param {string} feedbackHash - Hash of feedback
     * @param {string} response - Response text
     */
    async respondToFeedback(feedbackHash, response) {
        return await this.erc8004.respondToFeedback(feedbackHash, response);
    }

    // ========== ERC-8004 Validation Functions ==========

    /**
     * Request validation from a validator
     * @param {string} validatorAddress - Validator's address
     * @param {Object} options - Request options
     */
    async requestValidation(validatorAddress, options = {}) {
        return await this.erc8004.requestValidation(validatorAddress, options);
    }

    /**
     * Get validation status
     * @param {string} requestHash - Validation request hash
     */
    async getValidationStatus(requestHash) {
        return await this.erc8004.getValidationStatus(requestHash);
    }

    /**
     * Get validation summary
     * @param {Object} filters - Optional filters
     */
    async getValidationSummary(filters = {}) {
        return await this.erc8004.getValidationSummary(null, filters);
    }

    /**
     * Get all approved validators
     */
    async getApprovedValidators() {
        return await this.erc8004.getApprovedValidators();
    }

    // ========== Event Listener Functions ==========

    /**
     * Start listening for blockchain events
     */
    async startListening() {
        await this.eventListener.start();
    }

    /**
     * Stop listening for events
     */
    stopListening() {
        this.eventListener.stop();
    }

    /**
     * Register event handler
     * @param {string} eventName - Event name
     * @param {Function} callback - Event handler
     */
    on(eventName, callback) {
        this.eventListener.on(eventName, callback);
    }

    /**
     * Get formatted reputation with category
     * @returns {Object} Formatted reputation
     */
    async getFormattedReputation() {
        const score = await this.getReputationScore();
        return Formatter.formatReputation(score);
    }
}

module.exports = SpecularAgentV2;
