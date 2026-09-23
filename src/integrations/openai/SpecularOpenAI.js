/**
 * Specular Protocol - OpenAI Function Calling Integration
 *
 * Use Specular credit operations directly with GPT-4 and other OpenAI models
 */

const { ethers } = require('ethers');

class SpecularOpenAI {
    constructor({ apiUrl, wallet, network = 'base' }) {
        this.apiUrl = apiUrl || 'http://localhost:3001';
        this.wallet = wallet;
        this.network = network;
    }

    /**
     * Get function definitions for OpenAI API
     */
    static getFunctions() {
        return require('./functions.json').functions;
    }

    /**
     * Execute a Specular function based on OpenAI function call
     */
    async executeFunction(name, args) {
        switch (name) {
            case 'specular_check_credit':
                return await this.checkCredit(args.address);

            case 'specular_get_liquidity':
                return await this.getLiquidity(args.minLiquidity);

            case 'specular_request_loan':
                return await this.requestLoan(args.amount, args.durationDays);

            case 'specular_get_loan_status':
                return await this.getLoanStatus(args.loanId);

            case 'specular_repay_loan':
                return await this.repayLoan(args.loanId);

            case 'specular_register_agent':
                return await this.registerAgent(args.name, args.metadata);

            case 'specular_get_protocol_stats':
                return await this.getProtocolStats();

            case 'specular_supply_liquidity':
                return await this.supplyLiquidity(args.agentId, args.amount);

            case 'specular_withdraw_liquidity':
                return await this.withdrawLiquidity(args.poolId, args.amount);

            case 'specular_get_lending_positions':
                return await this.getLendingPositions(args.address);

            case 'specular_get_pool_details':
                return await this.getPoolDetails(args.poolId);

            default:
                throw new Error(`Unknown function: ${name}`);
        }
    }

    async checkCredit(address) {
        const response = await fetch(`${this.apiUrl}/agents/${address}`);
        const data = await response.json();

        if (!data.registered) {
            return {
                registered: false,
                message: `Agent ${address} is not registered. Register first using specular_register_agent.`
            };
        }

        return {
            registered: true,
            agentId: data.agentId,
            reputation: {
                score: data.reputation.score,
                tier: data.reputation.tier
            },
            credit: {
                limit: data.creditLimit,
                interestRate: data.interestRate
            },
            activeLoans: data.activeLoans,
            maxActiveLoans: data.maxActiveLoans,
            canBorrow: data.activeLoans < data.maxActiveLoans
        };
    }

    async getLiquidity(minLiquidity) {
        const response = await fetch(`${this.apiUrl}/pools`);
        const data = await response.json();

        let pools = data.pools;
        if (minLiquidity) {
            pools = pools.filter(p => parseFloat(p.availableLiquidity) >= minLiquidity);
        }

        return {
            network: data.network,
            poolCount: pools.length,
            pools: pools.slice(0, 10).map(p => ({
                poolId: p.poolId,
                agentId: p.agentId,
                totalLiquidity: p.totalLiquidity,
                availableLiquidity: p.availableLiquidity,
                utilization: p.utilization
            }))
        };
    }

    async requestLoan(amount, durationDays) {
        if (!this.wallet) {
            throw new Error('Wallet required for loan requests. Initialize SpecularOpenAI with a wallet.');
        }

        // Get unsigned transaction
        const response = await fetch(`${this.apiUrl}/tx/request-loan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount, durationDays })
        });
        const txData = await response.json();

        if (txData.error) {
            throw new Error(txData.error);
        }

        // Sign and send
        const tx = await this.wallet.sendTransaction({
            to: txData.to,
            data: txData.data
        });

        const receipt = await tx.wait();

        return {
            success: true,
            amount,
            durationDays,
            transaction: tx.hash,
            blockNumber: receipt.blockNumber,
            message: `Loan request for ${amount} USDC for ${durationDays} days submitted successfully`
        };
    }

    async getLoanStatus(loanId) {
        const response = await fetch(`${this.apiUrl}/loans/${loanId}`);
        const data = await response.json();

        return {
            loanId,
            borrower: data.borrower,
            principal: data.principal,
            interestRate: data.interestRate,
            status: data.status,
            startTime: data.startTime,
            dueDate: data.dueDate,
            timeToExpiry: data.timeToExpiry,
            amountRepaid: data.amountRepaid,
            network: data.network
        };
    }

    async repayLoan(loanId) {
        if (!this.wallet) {
            throw new Error('Wallet required for loan repayment. Initialize SpecularOpenAI with a wallet.');
        }

        // Get unsigned transaction
        const response = await fetch(`${this.apiUrl}/tx/repay-loan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ loanId })
        });
        const txData = await response.json();

        if (txData.error) {
            throw new Error(txData.error);
        }

        // Sign and send
        const tx = await this.wallet.sendTransaction({
            to: txData.to,
            data: txData.data
        });

        const receipt = await tx.wait();

        return {
            success: true,
            loanId,
            transaction: tx.hash,
            blockNumber: receipt.blockNumber,
            message: `Loan ${loanId} repaid successfully. Reputation updated.`
        };
    }

    async registerAgent(name, metadata = []) {
        if (!this.wallet) {
            throw new Error('Wallet required for registration. Initialize SpecularOpenAI with a wallet.');
        }

        const agentURI = `specular://${this.wallet.address}/${name}`;

        // Get unsigned transaction
        const response = await fetch(`${this.apiUrl}/tx/register`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentURI, metadata })
        });
        const txData = await response.json();

        if (txData.error) {
            throw new Error(txData.error);
        }

        // Sign and send
        const tx = await this.wallet.sendTransaction({
            to: txData.to,
            data: txData.data
        });

        const receipt = await tx.wait();

        return {
            success: true,
            name,
            address: this.wallet.address,
            transaction: tx.hash,
            blockNumber: receipt.blockNumber,
            message: `Agent "${name}" registered successfully`
        };
    }

    async getProtocolStats() {
        const response = await fetch(`${this.apiUrl}/status`);
        const data = await response.json();

        return {
            network: data.network,
            totalPools: data.totalPools,
            tvl: data.tvl,
            operational: true
        };
    }

    async supplyLiquidity(agentId, amount) {
        if (!this.wallet) {
            throw new Error('Wallet required for supplying liquidity');
        }

        // Get unsigned transaction
        const response = await fetch(`${this.apiUrl}/tx/supply-liquidity`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId, amount })
        });
        const txData = await response.json();

        if (txData.error) {
            throw new Error(txData.error);
        }

        // Sign and send
        const tx = await this.wallet.sendTransaction({
            to: txData.to,
            data: txData.data
        });

        const receipt = await tx.wait();

        return {
            success: true,
            agentId,
            amount,
            transaction: tx.hash,
            blockNumber: receipt.blockNumber,
            message: `Supplied ${amount} USDC to agent ${agentId}'s pool. You are now earning yield.`
        };
    }

    async withdrawLiquidity(poolId, amount) {
        if (!this.wallet) {
            throw new Error('Wallet required for withdrawing liquidity');
        }

        // Get unsigned transaction
        const response = await fetch(`${this.apiUrl}/tx/withdraw-liquidity`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ poolId, amount })
        });
        const txData = await response.json();

        if (txData.error) {
            throw new Error(txData.error);
        }

        // Sign and send
        const tx = await this.wallet.sendTransaction({
            to: txData.to,
            data: txData.data
        });

        const receipt = await tx.wait();

        return {
            success: true,
            poolId,
            amount,
            transaction: tx.hash,
            blockNumber: receipt.blockNumber,
            message: `Withdrawn ${amount} USDC from pool ${poolId}. Principal and interest returned to wallet.`
        };
    }

    async getLendingPositions(address) {
        const addr = address || this.wallet?.address;
        if (!addr) {
            throw new Error('Address required (provide address or configure wallet)');
        }

        const response = await fetch(`${this.apiUrl}/lenders/${addr}`);
        const data = await response.json();

        if (!data.positions || data.positions.length === 0) {
            return {
                address: addr,
                positions: [],
                totalSupplied: '0',
                totalEarned: '0',
                message: 'No active lending positions'
            };
        }

        return {
            address: addr,
            totalSupplied: data.totalSupplied,
            totalEarned: data.totalEarned,
            positions: data.positions.map(p => ({
                poolId: p.poolId,
                agentId: p.agentId,
                supplied: p.supplied,
                earnedInterest: p.earnedInterest,
                apy: p.apy,
                utilization: p.utilization
            }))
        };
    }

    async getPoolDetails(poolId) {
        const response = await fetch(`${this.apiUrl}/pools/${poolId}`);
        const data = await response.json();

        if (data.error) {
            throw new Error(data.error);
        }

        return {
            poolId,
            agentId: data.agentId,
            agentAddress: data.agentAddress,
            agentScore: data.agentScore,
            agentTier: data.agentTier,
            totalLiquidity: data.totalLiquidity,
            availableLiquidity: data.availableLiquidity,
            totalBorrowed: data.totalBorrowed,
            utilization: data.utilization,
            currentAPY: data.currentAPY,
            lenderCount: data.lenderCount,
            avgPosition: data.avgPosition,
            totalInterestEarned: data.totalInterestEarned
        };
    }
}

module.exports = { SpecularOpenAI };
