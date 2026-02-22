/**
 * Specular SDK - Simplified interface for AI agents
 * 
 * Auto-discovers the Specular protocol and provides simple methods for:
 * - Registering as an agent
 * - Requesting loans
 * - Repaying loans
 * - Checking reputation and credit limits
 */

const { ethers } = require('ethers');

class SpecularSDK {
    constructor({ apiUrl, wallet, rpcUrl }) {
        this.apiUrl = apiUrl || 'http://localhost:3001';
        this.wallet = wallet;
        this.provider = wallet ? wallet.provider : (rpcUrl ? new ethers.JsonRpcProvider(rpcUrl) : null);
        this.manifest = null;
    }

    /**
     * Auto-discover the Specular protocol
     */
    async discover() {
        const response = await fetch(`${this.apiUrl}/.well-known/specular.json`);
        this.manifest = await response.json();
        return this.manifest;
    }

    /**
     * Get protocol status
     */
    async getStatus() {
        const response = await fetch(`${this.apiUrl}/status`);
        return await response.json();
    }

    /**
     * Get agent profile by address
     */
    async getAgentProfile(address) {
        const response = await fetch(`${this.apiUrl}/agents/${address}`);
        return await response.json();
    }

    /**
     * Get my profile (requires wallet)
     */
    async getMyProfile() {
        if (!this.wallet) throw new Error('Wallet required');
        return this.getAgentProfile(this.wallet.address);
    }

    /**
     * List available liquidity pools
     */
    async getPools(options = {}) {
        const response = await fetch(`${this.apiUrl}/pools`);
        const data = await response.json();
        
        // Filter by minimum liquidity if specified
        if (options.minLiquidity) {
            data.pools = data.pools.filter(p => 
                parseFloat(p.availableLiquidity) >= options.minLiquidity
            );
        }
        
        return data;
    }

    /**
     * Get specific pool details
     */
    async getPool(poolId) {
        const response = await fetch(`${this.apiUrl}/pools/${poolId}`);
        return await response.json();
    }

    /**
     * Get loan details
     */
    async getLoan(loanId) {
        const response = await fetch(`${this.apiUrl}/loans/${loanId}`);
        return await response.json();
    }

    /**
     * Register as a new agent (requires wallet)
     */
    async register(options = {}) {
        if (!this.wallet) throw new Error('Wallet required for registration');

        // Get unsigned transaction data from API
        const response = await fetch(`${this.apiUrl}/tx/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        });
        const txData = await response.json();

        // Sign and send transaction
        const tx = await this.wallet.sendTransaction({
            to: txData.to,
            data: txData.data
        });

        console.log(`Registration transaction sent: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`Registration confirmed in block ${receipt.blockNumber}`);

        return receipt;
    }

    /**
     * Request a loan (requires wallet)
     */
    async requestLoan({ amount, durationDays }) {
        if (!this.wallet) throw new Error('Wallet required for loan request');

        // Get unsigned transaction data from API
        const response = await fetch(`${this.apiUrl}/tx/request-loan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount, durationDays })
        });
        const txData = await response.json();

        if (txData.error) {
            throw new Error(txData.error);
        }

        // Sign and send transaction
        const tx = await this.wallet.sendTransaction({
            to: txData.to,
            data: txData.data
        });

        console.log(`Loan request sent: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`Loan request confirmed in block ${receipt.blockNumber}`);

        // Extract loan ID from events
        // Note: In production, parse events properly. For demo, return receipt
        return receipt;
    }

    /**
     * Repay a loan (requires wallet)
     */
    async repayLoan(loanId) {
        if (!this.wallet) throw new Error('Wallet required for loan repayment');

        // Get unsigned transaction data from API
        const response = await fetch(`${this.apiUrl}/tx/repay-loan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ loanId })
        });
        const txData = await response.json();

        if (txData.error) {
            throw new Error(txData.error);
        }

        // Sign and send transaction
        const tx = await this.wallet.sendTransaction({
            to: txData.to,
            data: txData.data
        });

        console.log(`Loan repayment sent: ${tx.hash}`);
        const receipt = await tx.wait();
        console.log(`Loan repaid in block ${receipt.blockNumber}`);

        return receipt;
    }

    /**
     * Check if agent needs to register
     */
    async needsRegistration(address) {
        const profile = await this.getAgentProfile(address || this.wallet?.address);
        return !profile.registered;
    }
}

module.exports = SpecularSDK;
