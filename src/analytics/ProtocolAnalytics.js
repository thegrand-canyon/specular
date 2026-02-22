/**
 * ProtocolAnalytics
 *
 * A reusable class that reads on-chain state from the Specular Protocol
 * contracts and exposes high-level analytics methods.
 *
 * Compatible with both Hardhat scripts (pass `ethers.provider`) and the
 * Specular SDK (pass any ethers-compatible provider). Does NOT depend on
 * Hardhat itself — uses pure ethers.js.
 *
 * @example
 * const { ethers } = require('ethers');
 * const { ProtocolAnalytics } = require('./src/analytics/ProtocolAnalytics');
 *
 * const provider = new ethers.JsonRpcProvider('https://rpc.arc-testnet.example');
 * const addresses = require('./src/config/arc-testnet-addresses.json');
 *
 * const analytics = new ProtocolAnalytics(provider, addresses);
 *
 * const tvl         = await analytics.getTVL();
 * const utilization = await analytics.getUtilizationRate();
 * const snapshot    = await analytics.getFullSnapshot();
 */

'use strict';

const { ethers } = require('ethers');

// ─── ABIs (minimal interface pattern) ────────────────────────────────────────

const AGENT_REGISTRY_ABI = [
    'function totalAgents() view returns (uint256)',
    'function getAgentInfo(uint256 agentId) view returns (uint256 id, address owner, string agentURI, uint256 registeredAt, bool isActive)',
];

const REPUTATION_MANAGER_ABI = [
    'function getReputationScore(uint256 agentId) view returns (uint256)',
];

const MARKETPLACE_ABI = [
    'function agentPools(uint256 agentId) view returns (uint256 agentId, address owner, uint256 totalLiquidity, uint256 availableLiquidity, uint256 totalLoaned, uint256 totalEarned, bool isActive)',
    'function loans(uint256 loanId) view returns (address borrower, uint256 agentId, uint256 principal, uint256 collateral, uint256 interestRate, uint256 startTime, uint256 durationDays, uint256 totalRepayment, uint256 repaidAmount, uint8 state)',
    'function nextLoanId() view returns (uint256)',
    'function accumulatedFees() view returns (uint256)',
];

// ─── Internal constants ───────────────────────────────────────────────────────

/** Loan state enum values. */
const LOAN_STATE = Object.freeze({ PENDING: 0, ACTIVE: 1, REPAID: 2, DEFAULTED: 3 });

/** USDC uses 6 decimal places. */
const USDC_DECIMALS = 6;

// ─── ProtocolAnalytics class ─────────────────────────────────────────────────

/**
 * @typedef {object} ContractAddresses
 * @property {string} agentRegistryV2          - AgentRegistryV2 contract address.
 * @property {string} reputationManagerV3      - ReputationManagerV3 contract address.
 * @property {string} agentLiquidityMarketplace - AgentLiquidityMarketplace contract address.
 */

/**
 * @typedef {object} AgentSummary
 * @property {number}  agentId
 * @property {number}  reputation
 * @property {bigint}  totalLiquidity     - Raw USDC units.
 * @property {bigint}  availableLiquidity - Raw USDC units.
 * @property {bigint}  totalLoaned        - Raw USDC units.
 * @property {bigint}  totalEarned        - Raw USDC units.
 * @property {number}  utilizationPct     - 0–100.
 * @property {boolean} isActive
 */

/**
 * @typedef {object} LoanStats
 * @property {number} total
 * @property {number} active
 * @property {number} pending
 * @property {number} completed   - Repaid loans.
 * @property {number} defaulted
 * @property {bigint} totalVolume - Sum of all principals in raw USDC units.
 */

/**
 * @typedef {object} ProtocolSnapshot
 * @property {bigint}           tvl
 * @property {number}           utilizationRate
 * @property {LoanStats}        loanStats
 * @property {AgentSummary[]}   topAgents
 * @property {bigint}           protocolRevenue
 * @property {object}           apyEstimates   - Map of agentId → APY percentage string.
 * @property {string}           snapshotAt     - ISO timestamp.
 */

class ProtocolAnalytics {
    /**
     * @param {ethers.Provider} provider         - Any ethers-compatible provider.
     * @param {ContractAddresses} contractAddresses - Deployed contract addresses.
     */
    constructor(provider, contractAddresses) {
        if (!provider) throw new Error('ProtocolAnalytics: provider is required');
        if (!contractAddresses) throw new Error('ProtocolAnalytics: contractAddresses is required');

        this._provider = provider;

        // Instantiate contracts lazily on first use
        this._addresses = contractAddresses;
        this._agentRegistry    = null;
        this._reputationMgr    = null;
        this._marketplace      = null;
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /**
     * Lazily initialise contract instances and return them.
     * @returns {{ agentRegistry, reputationMgr, marketplace }}
     * @private
     */
    _contracts() {
        if (!this._agentRegistry) {
            this._agentRegistry = new ethers.Contract(
                this._addresses.agentRegistryV2,
                AGENT_REGISTRY_ABI,
                this._provider
            );
            this._reputationMgr = new ethers.Contract(
                this._addresses.reputationManagerV3,
                REPUTATION_MANAGER_ABI,
                this._provider
            );
            this._marketplace = new ethers.Contract(
                this._addresses.agentLiquidityMarketplace,
                MARKETPLACE_ABI,
                this._provider
            );
        }
        return {
            agentRegistry: this._agentRegistry,
            reputationMgr: this._reputationMgr,
            marketplace:   this._marketplace,
        };
    }

    /**
     * Fetch all active pool data with reputation scores.
     * Agents that throw on any call are silently skipped.
     *
     * @returns {Promise<AgentSummary[]>}
     * @private
     */
    async _fetchPools() {
        const { agentRegistry, reputationMgr, marketplace } = this._contracts();
        const totalAgents = Number(await agentRegistry.totalAgents());
        const pools = [];

        for (let agentId = 1; agentId <= totalAgents; agentId++) {
            try {
                const p   = await marketplace.agentPools(agentId);
                const rep = Number(await reputationMgr['getReputationScore(uint256)'](agentId));

                const util = p.totalLiquidity > 0n
                    ? Number(p.totalLoaned * 10000n / p.totalLiquidity) / 100
                    : 0;

                pools.push({
                    agentId,
                    reputation:         rep,
                    totalLiquidity:     p.totalLiquidity,
                    availableLiquidity: p.availableLiquidity,
                    totalLoaned:        p.totalLoaned,
                    totalEarned:        p.totalEarned,
                    utilizationPct:     util,
                    isActive:           p.isActive,
                });
            } catch {
                // Skip agents with no pool or transient RPC errors
            }
        }

        return pools;
    }

    /**
     * Fetch all loans from the marketplace.
     * Loans that fail to fetch are silently skipped.
     *
     * @returns {Promise<Array<object>>}
     * @private
     */
    async _fetchLoans() {
        const { marketplace } = this._contracts();
        const nextLoanId = Number(await marketplace.nextLoanId());
        const totalLoans = Math.max(0, nextLoanId - 1);
        const loans = [];

        for (let loanId = 1; loanId <= totalLoans; loanId++) {
            try {
                const l = await marketplace.loans(loanId);
                loans.push({
                    loanId,
                    borrower:      l.borrower,
                    agentId:       Number(l.agentId),
                    principal:     l.principal,
                    interestRate:  Number(l.interestRate),
                    startTime:     Number(l.startTime),
                    durationDays:  Number(l.durationDays),
                    totalRepayment: l.totalRepayment,
                    repaidAmount:  l.repaidAmount,
                    state:         Number(l.state),
                });
            } catch {
                // Skip
            }
        }

        return loans;
    }

    /**
     * Compute accrued interest for an ACTIVE loan up to the current moment.
     *
     * @param {object} loan
     * @returns {bigint} Accrued interest in raw USDC units.
     * @private
     */
    _accruedInterest(loan) {
        if (loan.state !== LOAN_STATE.ACTIVE) return 0n;
        const nowSec      = BigInt(Math.floor(Date.now() / 1000));
        const elapsedDays = (nowSec - BigInt(loan.startTime)) / 86400n;
        return (loan.principal * BigInt(loan.interestRate) * elapsedDays) / (365n * 10000n);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Total Value Locked: sum of totalLiquidity across all active pools.
     *
     * @returns {Promise<bigint>} TVL in raw USDC units (6 decimals).
     */
    async getTVL() {
        const pools = await this._fetchPools();
        return pools
            .filter(p => p.isActive)
            .reduce((acc, p) => acc + p.totalLiquidity, 0n);
    }

    /**
     * Protocol-wide utilization rate: total borrowed / TVL as a percentage.
     *
     * @returns {Promise<number>} 0–100 percentage, rounded to 2 decimal places.
     */
    async getUtilizationRate() {
        const pools = await this._fetchPools();
        const active = pools.filter(p => p.isActive);

        const tvl      = active.reduce((s, p) => s + p.totalLiquidity, 0n);
        const borrowed = active.reduce((s, p) => s + p.totalLoaned,    0n);

        if (tvl === 0n) return 0;
        return Math.round(Number(borrowed * 10000n / tvl)) / 100;
    }

    /**
     * Top N agents sorted by reputation score (descending).
     * Includes pool metrics and utilization for each agent.
     *
     * @param {number} [n=10] - Number of agents to return.
     * @returns {Promise<AgentSummary[]>}
     */
    async getTopAgents(n = 10) {
        const pools = await this._fetchPools();
        return [...pools]
            .sort((a, b) => b.reputation - a.reputation)
            .slice(0, n);
    }

    /**
     * Aggregate loan statistics across the entire protocol.
     *
     * @returns {Promise<LoanStats>}
     */
    async getLoanStats() {
        const loans = await this._fetchLoans();

        return {
            total:       loans.length,
            active:      loans.filter(l => l.state === LOAN_STATE.ACTIVE).length,
            pending:     loans.filter(l => l.state === LOAN_STATE.PENDING).length,
            completed:   loans.filter(l => l.state === LOAN_STATE.REPAID).length,
            defaulted:   loans.filter(l => l.state === LOAN_STATE.DEFAULTED).length,
            totalVolume: loans.reduce((s, l) => s + l.principal, 0n),
        };
    }

    /**
     * Estimate the annualised APY for a specific agent pool.
     *
     * The estimate uses totalEarned / totalLiquidity when historical earnings
     * exist; otherwise it falls back to the active loan's stated interest rate.
     *
     * @param {number} agentId
     * @returns {Promise<number>} APY as a percentage (e.g. 5.25 for 5.25%).
     */
    async getAPYEstimate(agentId) {
        const { marketplace } = this._contracts();

        let pool;
        try {
            pool = await marketplace.agentPools(agentId);
        } catch {
            return 0;
        }

        if (pool.totalLiquidity === 0n) return 0;

        if (pool.totalEarned > 0n) {
            const bps = Number(pool.totalEarned * 10000n / pool.totalLiquidity);
            return Math.round(bps) / 100;
        }

        // Fall back to the active loan's rate
        const loans = await this._fetchLoans();
        const activeLoan = loans.find(l => l.agentId === agentId && l.state === LOAN_STATE.ACTIVE);
        if (activeLoan) {
            return activeLoan.interestRate / 100;
        }

        return 0;
    }

    /**
     * Total platform fees collected by the protocol.
     *
     * @returns {Promise<bigint>} Accumulated fees in raw USDC units.
     */
    async getProtocolRevenue() {
        const { marketplace } = this._contracts();
        return await marketplace.accumulatedFees();
    }

    /**
     * Build a full protocol snapshot combining all analytics in a single call.
     * This is more efficient than calling each method individually because pools
     * and loans are fetched only once.
     *
     * @returns {Promise<ProtocolSnapshot>}
     */
    async getFullSnapshot() {
        const { marketplace } = this._contracts();

        // Fetch pools, loans, and fees in parallel
        const [pools, loans, fees] = await Promise.all([
            this._fetchPools(),
            this._fetchLoans(),
            marketplace.accumulatedFees(),
        ]);

        const activePools = pools.filter(p => p.isActive);

        // TVL and utilization
        const tvl      = activePools.reduce((s, p) => s + p.totalLiquidity, 0n);
        const borrowed = activePools.reduce((s, p) => s + p.totalLoaned,    0n);
        const utilRate = tvl > 0n
            ? Math.round(Number(borrowed * 10000n / tvl)) / 100
            : 0;

        // Loan stats
        const loanStats = {
            total:       loans.length,
            active:      loans.filter(l => l.state === LOAN_STATE.ACTIVE).length,
            pending:     loans.filter(l => l.state === LOAN_STATE.PENDING).length,
            completed:   loans.filter(l => l.state === LOAN_STATE.REPAID).length,
            defaulted:   loans.filter(l => l.state === LOAN_STATE.DEFAULTED).length,
            totalVolume: loans.reduce((s, l) => s + l.principal, 0n),
        };

        // Top agents (up to 10)
        const topAgents = [...activePools]
            .sort((a, b) => b.reputation - a.reputation)
            .slice(0, 10);

        // APY estimates for each active pool
        const apyEstimates = {};
        for (const pool of activePools) {
            let apy = 0;
            if (pool.totalLiquidity > 0n) {
                if (pool.totalEarned > 0n) {
                    apy = Math.round(Number(pool.totalEarned * 10000n / pool.totalLiquidity)) / 100;
                } else {
                    const activeLoan = loans.find(
                        l => l.agentId === pool.agentId && l.state === LOAN_STATE.ACTIVE
                    );
                    if (activeLoan) apy = activeLoan.interestRate / 100;
                }
            }
            apyEstimates[pool.agentId] = apy;
        }

        return {
            tvl,
            utilizationRate: utilRate,
            loanStats,
            topAgents,
            protocolRevenue: fees,
            apyEstimates,
            snapshotAt: new Date().toISOString(),
        };
    }

    // ── Utility / formatting helpers ──────────────────────────────────────────

    /**
     * Format a raw USDC bigint to a human-readable decimal string.
     *
     * @param {bigint} raw - Value with 6 decimal places.
     * @returns {string}  e.g. "1234.56"
     */
    static formatUSDC(raw) {
        return ethers.formatUnits(raw, USDC_DECIMALS);
    }

    /**
     * Parse a USDC decimal string back to raw bigint units.
     *
     * @param {string} amount - e.g. "1234.56"
     * @returns {bigint}
     */
    static parseUSDC(amount) {
        return ethers.parseUnits(String(amount), USDC_DECIMALS);
    }
}

module.exports = { ProtocolAnalytics, LOAN_STATE };
