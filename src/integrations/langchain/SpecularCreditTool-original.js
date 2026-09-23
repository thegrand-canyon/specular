/**
 * LangChain Tool for Specular Protocol
 *
 * Enables LangChain agents to access on-chain credit:
 * - Check credit eligibility
 * - Request USDC loans
 * - Repay loans
 * - Track reputation
 *
 * @example
 * import { SpecularCreditTool } from '@specular/langchain';
 *
 * const creditTool = new SpecularCreditTool({
 *   wallet: myEthersWallet,
 *   network: 'base' // or 'arc'
 * });
 *
 * // Use in LangChain agent
 * const agent = new OpenAIAgent({
 *   tools: [creditTool]
 * });
 */

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

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
        const configPath = this.network === 'base'
            ? '../../../src/config/base-addresses.json'
            : '../../../src/config/arc-testnet-addresses.json';

        const addresses = JSON.parse(
            fs.readFileSync(path.join(__dirname, configPath))
        );

        // Setup provider
        const rpcUrl = this.network === 'base'
            ? 'https://mainnet.base.org'
            : process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';

        const provider = new ethers.JsonRpcProvider(rpcUrl, undefined, { batchMaxCount: 1 });
        this.wallet = this.wallet.connect(provider);

        // Load ABIs
        const registryAbi = JSON.parse(
            fs.readFileSync(path.join(__dirname, '../../../artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json'))
        ).abi;
        const reputationAbi = JSON.parse(
            fs.readFileSync(path.join(__dirname, '../../../artifacts/contracts/core/ReputationManagerV3.sol/ReputationManagerV3.json'))
        ).abi;
        const marketplaceAbi = JSON.parse(
            fs.readFileSync(path.join(__dirname, '../../../artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json'))
        ).abi;
        const usdcAbi = [
            'function approve(address,uint256) returns (bool)',
            'function balanceOf(address) view returns (uint256)'
        ];

        // Initialize contracts
        this.registry = new ethers.Contract(
            addresses.agentRegistryV2 || addresses.agentRegistry,
            registryAbi,
            this.wallet
        );
        this.reputation = new ethers.Contract(
            addresses.reputationManagerV3 || addresses.reputationManager,
            reputationAbi,
            provider
        );
        this.marketplace = new ethers.Contract(
            addresses.agentLiquidityMarketplace,
            marketplaceAbi,
            this.wallet
        );
        this.usdc = new ethers.Contract(
            addresses.usdc || addresses.mockUSDC,
            usdcAbi,
            this.wallet
        );

        this.addresses = addresses;
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
        const maxLoan = params.maxLoanAmount;
        const interestRate = params.interestRate;
        const collateralPercent = params.collateralPercent;

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
        const approveTx = await this.usdc.approve(this.addresses.agentLiquidityMarketplace, amountWei);
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
        const principal = loan.principal;
        const interest = loan.interestRate * principal / 10000n;
        const totalRepayment = principal + interest;

        // Approve USDC
        const approveTx = await this.usdc.approve(this.addresses.agentLiquidityMarketplace, totalRepayment);
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
        const status = ['ACTIVE', 'REPAID', 'DEFAULTED'][loan.status];

        return JSON.stringify({
            loanId: loanId.toString(),
            borrower: loan.borrower,
            amount: ethers.formatUnits(loan.principal, 6) + ' USDC',
            interestRate: (Number(loan.interestRate) / 100).toFixed(2) + '%',
            dueDate: new Date(Number(loan.dueDate) * 1000).toISOString(),
            status: status,
            collateralAmount: ethers.formatUnits(loan.collateralAmount, 6) + ' USDC'
        }, null, 2);
    }

    _getTier(score) {
        if (score >= 800) return 'Elite (0% collateral)';
        if (score >= 600) return 'Premium (0% collateral)';
        if (score >= 400) return 'Standard (25% collateral)';
        if (score >= 200) return 'Basic (50% collateral)';
        return 'Starter (100% collateral)';
    }
}

module.exports = { SpecularCreditTool };
