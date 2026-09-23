/**
 * LangChain Tool for Specular Protocol (NPM Standalone Version)
 *
 * Enables LangChain agents to access on-chain credit.
 * This version has all config embedded - no file system dependencies.
 */

const { ethers } = require('ethers');
const { NETWORKS, ABIS } = require('./config');

class SpecularCreditTool {
    constructor(config = {}) {
        this.name = 'specular_credit';
        this.description = `Access on-chain credit for AI agents via Specular Protocol.

Available operations:
- check_eligibility: Check credit limit and interest rate
- request_loan: Borrow USDC (specify amount and duration)
- repay_loan: Repay an active loan
- check_reputation: View current reputation score
- loan_status: Get details of a specific loan

Input should be a JSON string with 'action' and relevant parameters.

Examples:
{"action": "check_eligibility"}
{"action": "request_loan", "amount": 100, "durationDays": 30}
{"action": "repay_loan", "loanId": 1}
{"action": "check_reputation"}
{"action": "loan_status", "loanId": 1}`;

        // Network configuration
        this.network = config.network || 'base';
        this.wallet = config.wallet;

        if (!this.wallet) {
            throw new Error('Wallet is required for SpecularCreditTool');
        }

        // Load network config
        this._initializeContracts();
    }

    _initializeContracts() {
        const networkConfig = NETWORKS[this.network];
        if (!networkConfig) {
            throw new Error(`Unknown network: ${this.network}. Use 'base' or 'arc'`);
        }

        // Setup provider
        const provider = new ethers.JsonRpcProvider(
            networkConfig.rpcUrl,
            networkConfig.chainId,
            { batchMaxCount: 1 }
        );
        this.wallet = this.wallet.connect(provider);

        // Initialize contracts with embedded ABIs
        this.registry = new ethers.Contract(
            networkConfig.contracts.agentRegistry,
            ABIS.registry,
            this.wallet
        );
        this.reputation = new ethers.Contract(
            networkConfig.contracts.reputationManager,
            ABIS.reputation,
            provider  // Read-only
        );
        this.marketplace = new ethers.Contract(
            networkConfig.contracts.marketplace,
            ABIS.marketplace,
            this.wallet
        );
        this.usdc = new ethers.Contract(
            networkConfig.contracts.usdc,
            ABIS.usdc,
            this.wallet
        );

        this.addresses = networkConfig.contracts;
    }

    /**
     * Main entry point for LangChain - handles all credit operations
     */
    async _call(input) {
        try {
            const params = JSON.parse(input);
            const action = params.action;

            switch (action) {
                case 'check_eligibility':
                    return await this._checkEligibility();

                case 'request_loan':
                    return await this._requestLoan(params.amount, params.durationDays);

                case 'repay_loan':
                    return await this._repayLoan(params.loanId);

                case 'check_reputation':
                    return await this._checkReputation();

                case 'loan_status':
                    return await this._loanStatus(params.loanId);

                default:
                    return `Unknown action: ${action}. Available actions: check_eligibility, request_loan, repay_loan, check_reputation, loan_status`;
            }
        } catch (error) {
            return `Error: ${error.message}`;
        }
    }

    /**
     * Check credit eligibility
     */
    async _checkEligibility() {
        const address = this.wallet.address;

        // Check if registered
        const agentId = await this.registry.addressToAgentId(address);
        if (agentId === 0n) {
            return `Not registered. Register first by calling request_loan - auto-registration will occur.`;
        }

        // Get reputation score
        const score = await this.reputation.getReputationScore(agentId);

        // Get credit parameters
        const params = await this.marketplace.getCreditParameters(agentId);
        const maxLoan = params[0];
        const interestRate = params[1];
        const collateralPercent = params[2];

        return JSON.stringify({
            eligible: true,
            agentId: agentId.toString(),
            reputationScore: score.toString(),
            maxLoanAmount: ethers.formatUnits(maxLoan, 6) + ' USDC',
            interestRate: (Number(interestRate) / 100).toFixed(2) + '%',
            collateralRequired: collateralPercent.toString() + '%',
            network: this.network
        }, null, 2);
    }

    /**
     * Request a loan
     */
    async _requestLoan(amount, durationDays) {
        if (!amount || !durationDays) {
            return 'Error: amount and durationDays are required';
        }

        const amountWei = ethers.parseUnits(amount.toString(), 6);

        // Check if registered, if not, register first
        const agentId = await this.registry.addressToAgentId(this.wallet.address);
        if (agentId === 0n) {
            console.log('Not registered. Registering...');
            const registerTx = await this.registry.register(
                `https://specular.network/agents/${this.wallet.address}`,
                []
            );
            await registerTx.wait();
            console.log('Registered successfully');
        }

        // Approve USDC for collateral
        const approveTx = await this.usdc.approve(this.addresses.marketplace, amountWei);
        await approveTx.wait();

        // Request loan
        const tx = await this.marketplace.requestLoan(amountWei, durationDays);
        const receipt = await tx.wait();

        // Extract loan ID from events
        const loanRequestedEvent = receipt.logs.find(log => {
            try {
                const parsed = this.marketplace.interface.parseLog(log);
                return parsed.name === 'LoanRequested';
            } catch {
                return false;
            }
        });

        let loanId = 'unknown';
        if (loanRequestedEvent) {
            const parsed = this.marketplace.interface.parseLog(loanRequestedEvent);
            loanId = parsed.args.loanId.toString();
        }

        return JSON.stringify({
            success: true,
            loanId: loanId,
            amount: amount + ' USDC',
            duration: durationDays + ' days',
            txHash: receipt.hash,
            message: 'Loan requested successfully. USDC is now in your wallet.'
        }, null, 2);
    }

    /**
     * Repay a loan
     */
    async _repayLoan(loanId) {
        if (!loanId) {
            return 'Error: loanId is required';
        }

        // Get loan details
        const loan = await this.marketplace.loans(loanId);
        const principal = loan[2];  // loan.principal
        const interestRate = loan[3];  // loan.interestRate
        const interest = interestRate * principal / 10000n;
        const totalRepayment = principal + interest;

        // Approve USDC
        const approveTx = await this.usdc.approve(this.addresses.marketplace, totalRepayment);
        await approveTx.wait();

        // Repay
        const tx = await this.marketplace.repayLoan(loanId);
        const receipt = await tx.wait();

        return JSON.stringify({
            success: true,
            loanId: loanId.toString(),
            principal: ethers.formatUnits(principal, 6) + ' USDC',
            interest: ethers.formatUnits(interest, 6) + ' USDC',
            totalRepaid: ethers.formatUnits(totalRepayment, 6) + ' USDC',
            txHash: receipt.hash,
            message: 'Loan repaid successfully. Reputation increased!'
        }, null, 2);
    }

    /**
     * Check reputation score
     */
    async _checkReputation() {
        const agentId = await this.registry.addressToAgentId(this.wallet.address);
        if (agentId === 0n) {
            return 'Not registered yet';
        }

        const score = await this.reputation.getReputationScore(agentId);

        return JSON.stringify({
            agentId: agentId.toString(),
            reputationScore: score.toString(),
            tier: this._getTier(Number(score)),
            network: this.network
        }, null, 2);
    }

    /**
     * Get loan status
     */
    async _loanStatus(loanId) {
        if (!loanId) {
            return 'Error: loanId is required';
        }

        const loan = await this.marketplace.loans(loanId);
        const status = ['ACTIVE', 'REPAID', 'DEFAULTED'][loan[5]];  // loan.status

        return JSON.stringify({
            loanId: loanId.toString(),
            borrower: loan[1],  // loan.borrower
            amount: ethers.formatUnits(loan[2], 6) + ' USDC',  // loan.principal
            interestRate: (Number(loan[3]) / 100).toFixed(2) + '%',  // loan.interestRate
            dueDate: new Date(Number(loan[4]) * 1000).toISOString(),  // loan.dueDate
            status: status,
            collateralAmount: ethers.formatUnits(loan[6], 6) + ' USDC'  // loan.collateralAmount
        }, null, 2);
    }

    /**
     * Human-readable tier NAME for a score.
     *
     * [V7] The collateral percentage, credit limit and APR are deliberately NOT
     * in this label any more. On ReputationManagerV4 the tier table is on-chain,
     * owner-settable state (bounded by an immutable MAX_TIER_LIMIT), so a
     * hardcoded "(25% collateral)" was already wrong for V3's 500-tier and is
     * wrong for every V7 deployment. Read the real values from the contract:
     * `calculateCollateralRequirement(address)` / `calculateCreditLimit(address)`
     * — which is what `getCreditProfile` already reports.
     */
    _getTier(score) {
        if (score >= 800) return 'Elite';
        if (score >= 600) return 'Premium';
        if (score >= 500) return 'Standard';
        if (score >= 400) return 'Building';
        if (score >= 200) return 'Basic';
        return 'Starter';
    }
}

module.exports = { SpecularCreditTool };
