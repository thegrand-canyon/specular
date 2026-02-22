const { ethers } = require('ethers');
const ContractManager = require('./ContractManager');
const StateManager = require('./StateManager');
const EventListener = require('./EventListener');
const Validator = require('./utils/validation');
const Formatter = require('./utils/formatting');
const {
    RegistrationError,
    LoanError,
    InsufficientReputationError
} = require('./utils/errors');

/**
 * Main SpecularAgent class for interacting with the Specular Protocol
 */
class SpecularAgent {
    /**
     * Create a new SpecularAgent instance
     * @param {ethers.Wallet} wallet - Ethers.js wallet instance with provider
     * @param {Object} contractAddresses - Object containing contract addresses
     */
    constructor(wallet, contractAddresses) {
        if (!wallet || !wallet.provider) {
            throw new Error('Invalid wallet: must be ethers.Wallet instance with provider');
        }

        this.wallet = wallet;
        this.address = wallet.address;
        this.provider = wallet.provider;

        // Initialize contract manager
        this.contractManager = new ContractManager(this.provider, contractAddresses);

        // Initialize contracts with wallet signer
        this.contracts = {
            agentRegistry: this.contractManager.getContract('AgentRegistry', wallet),
            reputationManager: this.contractManager.getContract('ReputationManager', wallet),
            lendingPool: this.contractManager.getContract('LendingPool', wallet),
            mockUSDC: this.contractManager.getContract('MockUSDC', wallet)
        };

        // Initialize state manager
        this.stateManager = new StateManager(this);

        // Initialize event listener
        this.eventListener = new EventListener(this.provider, this.contracts);
    }

    /**
     * Register the agent with metadata
     * @param {string} metadata - JSON string or object containing agent metadata
     * @returns {Object} Transaction receipt
     */
    async register(metadata) {
        console.log(`Registering agent ${this.address}...`);

        // Validate and format metadata
        const metadataStr = typeof metadata === 'object' ? JSON.stringify(metadata) : metadata;
        Validator.validateMetadata(metadataStr);

        try {
            // Check if already registered
            const isRegistered = await this.contracts.agentRegistry.isRegistered(this.address);
            if (isRegistered) {
                throw new RegistrationError('Agent already registered');
            }

            // Register agent
            const tx = await this.contracts.agentRegistry.registerAgent(metadataStr);
            console.log(`Transaction sent: ${tx.hash}`);

            const receipt = await tx.wait();
            console.log(`Agent registered in block ${receipt.blockNumber}`);

            // Initialize reputation (fetch fresh nonce to avoid nonce issues)
            console.log('Initializing reputation...');
            const currentNonce = await this.wallet.provider.getTransactionCount(this.address, 'latest');
            const reputationTx = await this.contracts.reputationManager.initializeReputation(
                this.address,
                { nonce: currentNonce }
            );
            await reputationTx.wait();
            console.log('Reputation initialized');

            // Refresh state
            await this.stateManager.syncState();

            return receipt;
        } catch (error) {
            throw new RegistrationError(`Registration failed: ${error.message}`);
        }
    }

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
            const creditLimit = await this.contracts.reputationManager.calculateCreditLimit(this.address);
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
            const collateralReq = await this.contracts.reputationManager.calculateCollateralRequirement(this.address);
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
     * @param {string|number} loanId - ID of the loan to repay
     * @returns {Object} Transaction receipt
     */
    async repayLoan(loanId) {
        console.log(`Repaying loan ${loanId}...`);

        Validator.validateLoanId(loanId);

        try {
            // Get loan details
            const loan = await this.contracts.lendingPool.getLoan(loanId);

            if (loan.borrower.toLowerCase() !== this.address.toLowerCase()) {
                throw new LoanError(`Not the borrower of loan ${loanId}`, loanId);
            }

            if (Number(loan.state) !== 2) { // ACTIVE state
                throw new LoanError(`Loan ${loanId} is not in active state`, loanId);
            }

            // Calculate total repayment (principal + interest)
            const interest = await this.contracts.lendingPool.calculateInterest(
                loan.amount,
                loan.interestRate,
                loan.durationDays
            );
            const totalRepayment = loan.amount + interest;

            console.log(`Repayment amount: ${Formatter.formatUSDC(totalRepayment)} USDC`);
            console.log(`  Principal: ${Formatter.formatUSDC(loan.amount)} USDC`);
            console.log(`  Interest: ${Formatter.formatUSDC(interest)} USDC`);

            // Check balance
            const balance = await this.contracts.mockUSDC.balanceOf(this.address);
            if (balance < totalRepayment) {
                throw new LoanError(
                    `Insufficient USDC balance. Need ${Formatter.formatUSDC(totalRepayment)} USDC, have ${Formatter.formatUSDC(balance)} USDC`,
                    loanId
                );
            }

            // Approve USDC
            console.log('Approving USDC for repayment...');
            const approveTx = await this.contracts.mockUSDC.approve(
                await this.contracts.lendingPool.getAddress(),
                totalRepayment
            );
            await approveTx.wait();

            // Repay loan
            const tx = await this.contracts.lendingPool.repayLoan(loanId);
            console.log(`Transaction sent: ${tx.hash}`);

            const receipt = await tx.wait();
            console.log(`Loan ${loanId} repaid successfully`);

            // Refresh state
            await this.stateManager.syncState();

            return receipt;
        } catch (error) {
            throw new LoanError(`Loan repayment failed: ${error.message}`, loanId);
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
     * @param {string|number} loanId - Loan ID
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

    /**
     * Register event listener
     * @param {string} eventName - Event name
     * @param {Function} callback - Callback function
     */
    on(eventName, callback) {
        this.eventListener.on(eventName, callback);
    }

    /**
     * Remove event listener
     * @param {string} eventName - Event name
     * @param {Function} callback - Callback function
     */
    off(eventName, callback) {
        this.eventListener.off(eventName, callback);
    }

    /**
     * Start listening for events
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
     * Get formatted reputation with category
     * @returns {Object} Formatted reputation
     */
    async getFormattedReputation() {
        const score = await this.getReputationScore();
        return Formatter.formatReputation(score);
    }
}

module.exports = SpecularAgent;
