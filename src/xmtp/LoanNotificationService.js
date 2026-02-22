/**
 * XMTP Loan Notification Service
 *
 * Uses the XMTP decentralized messaging protocol to send wallet-to-wallet
 * notifications for loan lifecycle events in the Specular Protocol.
 *
 * Features:
 *   - Loan request/approval/repayment/default notifications
 *   - Agent → lender messages (e.g., "I've repaid loan #42")
 *   - Lender → agent messages (e.g., "Your loan is due in 3 days")
 *   - On-chain event monitoring → automatic XMTP dispatch
 *
 * XMTP is a decentralized, end-to-end encrypted messaging protocol.
 * Messages are wallet-signed and stored on the XMTP network, not any
 * centralized server. Every wallet address is a potential XMTP inbox.
 *
 * SDK: @xmtp/xmtp-js (v11)
 * Docs: https://xmtp.org/docs
 */

'use strict';

const { ethers } = require('ethers');

// ── XMTP availability check ──────────────────────────────────────────────────
// XMTP requires the @xmtp/xmtp-js package. We lazy-load it so the rest of
// Specular works even without it installed.
function requireXmtp() {
    try {
        return require('@xmtp/xmtp-js');
    } catch {
        throw new Error(
            'XMTP package not installed. Run: npm install @xmtp/xmtp-js\n' +
            'See https://xmtp.org/docs/build/get-started/overview?sdk=js'
        );
    }
}

// ── Marketplace ABI (event listeners) ────────────────────────────────────────
const MARKETPLACE_ABI = [
    'event LoanRequested(uint256 indexed agentId, uint256 indexed loanId, uint256 amount, uint256 durationDays)',
    'event LoanRepaid(uint256 indexed loanId, address indexed borrower, uint256 totalAmount, bool onTime)',
    'event LoanDefaulted(uint256 indexed loanId, address indexed borrower)',
    'event LiquiditySupplied(uint256 indexed agentId, address indexed lender, uint256 amount)',
    'function loans(uint256 agentId, uint256 loanId) view returns (uint256,uint256,uint256,address,uint256,uint256,uint256,uint256,uint8)',
    'function poolLenders(uint256 agentId, uint256 index) view returns (address)',
];

const REGISTRY_ABI = [
    'function getAgent(uint256 agentId) view returns (address wallet, string metadata, bool active, uint256 registeredAt)',
];

// ── Message templates ─────────────────────────────────────────────────────────
const TEMPLATES = {
    loanRequested: ({ agentId, loanId, amount, durationDays, borrowerAddress }) =>
        `🏦 Specular Protocol: New Loan Request\n\n` +
        `Agent #${agentId} (${borrowerAddress.slice(0,8)}...) has requested a loan:\n` +
        `• Loan ID: #${loanId}\n` +
        `• Amount: ${(Number(amount) / 1e6).toFixed(2)} USDC\n` +
        `• Duration: ${durationDays} days\n\n` +
        `Your funds in this pool may be allocated. The loan has been auto-approved.\n` +
        `Track at: https://testnet.arcscan.app`,

    loanRepaid: ({ loanId, borrowerAddress, totalAmount, onTime }) =>
        `✅ Specular Protocol: Loan Repaid\n\n` +
        `Loan #${loanId} has been fully repaid!\n` +
        `• Borrower: ${borrowerAddress.slice(0,8)}...\n` +
        `• Total repaid: ${(Number(totalAmount) / 1e6).toFixed(2)} USDC (principal + interest)\n` +
        `• On time: ${onTime ? 'Yes ✓' : 'No (late)'}\n\n` +
        `Your share of interest has been credited to your pool position.`,

    loanDefaulted: ({ loanId, borrowerAddress }) =>
        `⚠️ Specular Protocol: Loan Default\n\n` +
        `Loan #${loanId} has been marked as defaulted.\n` +
        `• Borrower: ${borrowerAddress.slice(0,8)}...\n\n` +
        `Collateral (if any) has been distributed to lenders. The borrower's ` +
        `reputation score has been penalized. We're sorry for the loss.`,

    loanDueSoon: ({ loanId, daysRemaining, amount }) =>
        `⏰ Specular Protocol: Payment Reminder\n\n` +
        `Loan #${loanId} is due in ${daysRemaining} day(s).\n` +
        `• Amount due: ${(Number(amount) / 1e6).toFixed(2)} USDC\n\n` +
        `Please ensure you have sufficient USDC to repay and maintain your credit score.`,

    newLiquiditySupplied: ({ agentId, lenderAddress, amount }) =>
        `💧 Specular Protocol: New Liquidity in Your Pool\n\n` +
        `A lender has supplied liquidity to your pool (Agent #${agentId}):\n` +
        `• Lender: ${lenderAddress.slice(0,8)}...\n` +
        `• Amount: ${(Number(amount) / 1e6).toFixed(2)} USDC\n\n` +
        `You can now request larger loans based on your credit score.`,

    reputationUpdate: ({ agentId, oldScore, newScore, reason }) => {
        const delta = newScore - oldScore;
        const emoji = delta > 0 ? '📈' : '📉';
        return `${emoji} Specular Protocol: Reputation Update\n\n` +
            `Agent #${agentId} reputation changed:\n` +
            `• Previous score: ${oldScore}\n` +
            `• New score: ${newScore} (${delta > 0 ? '+' : ''}${delta})\n` +
            `• Reason: ${reason}\n\n` +
            `Your credit limit and loan terms have been updated accordingly.`;
    },
};

// ── Main class ────────────────────────────────────────────────────────────────

class LoanNotificationService {
    /**
     * @param {object} config
     * @param {ethers.Signer}  config.signer             - Protocol operator's signer (for sending notifs)
     * @param {ethers.Provider} config.provider
     * @param {string}         config.marketplaceAddress
     * @param {string}         config.registryAddress
     * @param {string}         config.xmtpEnv            - 'dev' | 'production' (default: 'dev')
     * @param {boolean}        config.verbose
     */
    constructor(config) {
        this.signer    = config.signer;
        this.provider  = config.provider || config.signer.provider;
        this.xmtpEnv   = config.xmtpEnv || 'dev';
        this.verbose   = config.verbose  || false;

        this.marketplace = new ethers.Contract(
            config.marketplaceAddress, MARKETPLACE_ABI, this.provider
        );
        this.registry = new ethers.Contract(
            config.registryAddress, REGISTRY_ABI, this.provider
        );

        this.xmtpClient = null;   // initialized lazily in start()
        this.listeners  = [];     // active ethers event listeners
        this.convCache  = {};     // address → XMTP Conversation cache
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    async start() {
        const { Client } = requireXmtp();

        this._log('Connecting XMTP client...');
        this.xmtpClient = await Client.create(this.signer, { env: this.xmtpEnv });
        this._log(`XMTP client ready: ${this.xmtpClient.address}`);

        await this._attachEventListeners();
        this._log('Loan notification service started — listening for on-chain events');
    }

    stop() {
        for (const { contract, event, handler } of this.listeners) {
            contract.off(event, handler);
        }
        this.listeners = [];
        this._log('Notification service stopped');
    }

    // ── On-chain event listeners ───────────────────────────────────────────────

    async _attachEventListeners() {
        // LoanRequested → notify lenders in the pool
        const onLoanRequested = async (agentId, loanId, amount, durationDays, event) => {
            try {
                const borrowerAddress = await this._getAgentWallet(agentId);
                const lenders         = await this._getPoolLenders(agentId);
                const msg = TEMPLATES.loanRequested({
                    agentId: agentId.toString(),
                    loanId:  loanId.toString(),
                    amount, durationDays,
                    borrowerAddress,
                });
                await this._broadcast(lenders, msg, `LoanRequested #${loanId}`);
            } catch (err) {
                this._log(`LoanRequested handler error: ${err.message}`);
            }
        };

        // LoanRepaid → notify lenders
        const onLoanRepaid = async (loanId, borrowerAddress, totalAmount, onTime, event) => {
            try {
                const agentId = await this._getAgentIdFromLoan(loanId);
                const lenders = await this._getPoolLenders(agentId);
                const msg = TEMPLATES.loanRepaid({
                    loanId: loanId.toString(), borrowerAddress, totalAmount, onTime,
                });
                await this._broadcast(lenders, msg, `LoanRepaid #${loanId}`);
            } catch (err) {
                this._log(`LoanRepaid handler error: ${err.message}`);
            }
        };

        // LoanDefaulted → notify lenders + borrower
        const onLoanDefaulted = async (loanId, borrowerAddress, event) => {
            try {
                const agentId = await this._getAgentIdFromLoan(loanId);
                const lenders = await this._getPoolLenders(agentId);
                const msg = TEMPLATES.loanDefaulted({
                    loanId: loanId.toString(), borrowerAddress,
                });
                await this._broadcast([...lenders, borrowerAddress], msg, `LoanDefaulted #${loanId}`);
            } catch (err) {
                this._log(`LoanDefaulted handler error: ${err.message}`);
            }
        };

        // LiquiditySupplied → notify the agent (new liquidity for them)
        const onLiquiditySupplied = async (agentId, lenderAddress, amount, event) => {
            try {
                const agentWallet = await this._getAgentWallet(agentId);
                const msg = TEMPLATES.newLiquiditySupplied({
                    agentId: agentId.toString(), lenderAddress, amount,
                });
                await this._send(agentWallet, msg, `LiquiditySupplied agent #${agentId}`);
            } catch (err) {
                this._log(`LiquiditySupplied handler error: ${err.message}`);
            }
        };

        this.marketplace.on('LoanRequested',    onLoanRequested);
        this.marketplace.on('LoanRepaid',       onLoanRepaid);
        this.marketplace.on('LoanDefaulted',    onLoanDefaulted);
        this.marketplace.on('LiquiditySupplied', onLiquiditySupplied);

        this.listeners.push(
            { contract: this.marketplace, event: 'LoanRequested',    handler: onLoanRequested },
            { contract: this.marketplace, event: 'LoanRepaid',       handler: onLoanRepaid },
            { contract: this.marketplace, event: 'LoanDefaulted',    handler: onLoanDefaulted },
            { contract: this.marketplace, event: 'LiquiditySupplied', handler: onLiquiditySupplied },
        );

        this._log(`Listening to 4 marketplace events`);
    }

    // ── Manual notification triggers (for testing / cron jobs) ────────────────

    /**
     * Send a "loan due soon" reminder to a borrower.
     */
    async sendDueSoonReminder(borrowerAddress, loanId, daysRemaining, amount) {
        const msg = TEMPLATES.loanDueSoon({
            loanId: loanId.toString(), daysRemaining, amount,
        });
        await this._send(borrowerAddress, msg, `DueSoon reminder loan #${loanId}`);
    }

    /**
     * Send a reputation update notification to an agent.
     */
    async sendReputationUpdate(agentAddress, agentId, oldScore, newScore, reason) {
        const msg = TEMPLATES.reputationUpdate({
            agentId: agentId.toString(), oldScore, newScore, reason,
        });
        await this._send(agentAddress, msg, `ReputationUpdate agent #${agentId}`);
    }

    /**
     * Send a custom message to any address (e.g., governance announcements).
     */
    async sendCustom(toAddress, message) {
        await this._send(toAddress, message, 'custom');
    }

    // ── XMTP send helpers ──────────────────────────────────────────────────────

    async _send(toAddress, message, label = '') {
        if (!this.xmtpClient) throw new Error('Service not started — call start() first');

        // Check if recipient has an XMTP identity
        const canMessage = await this.xmtpClient.canMessage(toAddress);
        if (!canMessage) {
            this._log(`[XMTP] ${toAddress} has no XMTP identity — skip "${label}"`);
            return false;
        }

        // Reuse cached conversation
        if (!this.convCache[toAddress]) {
            this.convCache[toAddress] = await this.xmtpClient.conversations.newConversation(toAddress);
        }
        const conv = this.convCache[toAddress];
        await conv.send(message);
        this._log(`[XMTP] Sent "${label}" → ${toAddress.slice(0,8)}...`);
        return true;
    }

    async _broadcast(addresses, message, label = '') {
        const unique = [...new Set(addresses.filter(a => ethers.isAddress(a)))];
        this._log(`[XMTP] Broadcasting "${label}" to ${unique.length} address(es)`);
        const results = await Promise.allSettled(
            unique.map(addr => this._send(addr, message, label))
        );
        const sent = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
        this._log(`[XMTP] Delivered to ${sent}/${unique.length}`);
        return sent;
    }

    // ── On-chain data helpers ──────────────────────────────────────────────────

    async _getAgentWallet(agentId) {
        const [wallet] = await this.registry.getAgent(agentId);
        return wallet;
    }

    async _getPoolLenders(agentId, maxLenders = 50) {
        const lenders = [];
        for (let i = 0; i < maxLenders; i++) {
            try {
                const lender = await this.marketplace.poolLenders(agentId, i);
                if (!lender || lender === ethers.ZeroAddress) break;
                lenders.push(lender);
            } catch {
                break;
            }
        }
        return lenders;
    }

    async _getAgentIdFromLoan(loanId) {
        // LoanRepaid event includes borrower address; look up agentId from registry
        // Simplified: scan agentIds — in production, index this via events
        return 0n;
    }

    _log(msg) {
        if (this.verbose) console.log(`[LoanNotif]`, msg);
    }
}

module.exports = LoanNotificationService;
