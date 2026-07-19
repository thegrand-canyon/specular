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
const { assertDurationDays } = require('./duration');
const { waitForReceiptResilient } = require('./receipt');

// ERC-20 approve(address,uint256) selector — the one token call the API is
// allowed to ask us to sign (onboarding approval). transfer/transferFrom to an
// attacker is exactly what the allowlist below is here to block.
const APPROVE_SELECTOR = '0x095ea7b3';

/**
 * Build the trusted set of contract addresses from the IN-REPO config files.
 *
 * This is the crux of the blind-signing defense: the allowlist must NOT come
 * from `this.apiUrl` (the very thing we're guarding against). We load the
 * committed, canonical address books instead. We build a network-agnostic
 * superset — we only need to answer "is this a known Specular/USDC address?",
 * not "which network are we on?", and mixing networks cannot create a drain
 * because a wrong-network address is still a known non-attacker contract.
 */
function loadTrustedAddresses() {
    const targets = new Set();   // any address the API may direct a tx `to`
    const usdc = new Set();      // token addresses (approve-only, spender-checked)
    const spenders = new Set();  // valid approve spenders (marketplaces / routers)
    const add = (set, v) => { if (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v)) set.add(v.toLowerCase()); };

    let books = [];
    try { books.push(require('../config/base-addresses.json')); } catch (_) {}
    try { books.push(require('../config/arc-testnet-addresses.json')); } catch (_) {}

    for (const book of books) {
        for (const [key, val] of Object.entries(book)) {
            add(targets, val);
            const k = key.toLowerCase();
            if (k === 'usdc' || k === 'mockusdc') add(usdc, val);
            if (k.includes('marketplace') || k.includes('depositrouter')) add(spenders, val);
        }
    }
    return { targets, usdc, spenders };
}

class SpecularSDK {
    constructor({ apiUrl, wallet, rpcUrl, allowedTargets } = {}) {
        this.apiUrl = apiUrl || 'http://localhost:3001';
        this.wallet = wallet;
        this.provider = wallet ? wallet.provider : (rpcUrl ? new ethers.JsonRpcProvider(rpcUrl) : null);
        this.manifest = null;

        // Reject plaintext HTTP to a non-loopback API: a MITM could swap the
        // unsigned-tx payload we're about to sign. Localhost stays allowed for dev.
        const host = (() => { try { return new URL(this.apiUrl).hostname; } catch { return ''; } })();
        const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
        if (this.apiUrl.startsWith('http://') && !isLoopback) {
            throw new Error(`SpecularSDK: refusing plaintext http:// API for non-localhost host "${host}" — use https://`);
        }

        const trusted = loadTrustedAddresses();
        // Callers may extend the target allowlist (e.g. a freshly deployed test
        // contract) but never the token/spender rules.
        if (Array.isArray(allowedTargets)) {
            for (const a of allowedTargets) {
                if (typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)) trusted.targets.add(a.toLowerCase());
            }
        }
        this._trusted = trusted;
    }

    /**
     * Guard an API-supplied unsigned tx before we sign it. The API is a trust
     * boundary: without this, a compromised/MITM'd endpoint returns
     * `{ to: USDC, data: approve(attacker, MAX) }` (or a transfer) and the
     * wallet signs away its entire balance — a full drain.
     *
     * Invariant enforced: `to` must be a known Specular/USDC address, and any
     * call to a token address must be `approve(spender, _)` where `spender` is
     * a known marketplace/router. Everything else is refused.
     */
    _assertSafeTx(txData, opLabel) {
        if (!txData || typeof txData.to !== 'string' || typeof txData.data !== 'string') {
            throw new Error(`${opLabel}: API returned malformed tx data`);
        }
        const to = txData.to.toLowerCase();
        if (!this._trusted.targets.has(to)) {
            throw new Error(`${opLabel}: refusing to sign — target ${txData.to} is not a known Specular contract`);
        }
        if (this._trusted.usdc.has(to)) {
            const selector = txData.data.slice(0, 10).toLowerCase();
            if (selector !== APPROVE_SELECTOR) {
                throw new Error(`${opLabel}: refusing to sign — only approve() is permitted on the USDC token (got selector ${selector})`);
            }
            // approve(address spender, uint256) — first 32-byte word after the
            // selector is the spender, right-aligned.
            let spender;
            try {
                [spender] = ethers.AbiCoder.defaultAbiCoder().decode(['address', 'uint256'], '0x' + txData.data.slice(10));
            } catch (_) {
                throw new Error(`${opLabel}: refusing to sign — unparseable approve() calldata`);
            }
            if (!this._trusted.spenders.has(spender.toLowerCase())) {
                throw new Error(`${opLabel}: refusing to sign — USDC approval to unknown spender ${spender}`);
            }
        }
        return txData;
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
        if (!response.ok) throw new Error(`register: API ${response.status} ${response.statusText}`);
        const txData = await response.json();
        if (txData.error) throw new Error(txData.error);
        this._assertSafeTx(txData, 'register');

        // Sign and send transaction
        const tx = await this.wallet.sendTransaction({
            to: txData.to,
            data: txData.data
        });

        console.log(`Registration transaction sent: ${tx.hash}`);
        const { receipt } = await waitForReceiptResilient(this.provider, tx.hash);
        if (receipt.status !== 1) {
            throw new Error(`Registration tx ${tx.hash.slice(0,12)} reverted on-chain`);
        }
        console.log(`Registration confirmed in block ${receipt.blockNumber}`);

        return receipt;
    }

    /**
     * Request a loan (requires wallet).
     *
     * @param {object} params
     * @param {number|bigint|string} params.amount         loan amount in USDC base units (6 decimals)
     * @param {number|bigint} params.durationDays          loan duration in DAYS (integer, 7-365 inclusive).
     *                                                     The on-chain contract multiplies by `1 days` internally;
     *                                                     passing seconds (e.g. 604800) will be rejected locally
     *                                                     by `assertDurationDays` before any network call.
     */
    async requestLoan({ amount, durationDays }) {
        if (!this.wallet) throw new Error('Wallet required for loan request');
        assertDurationDays(durationDays, 'SpecularSDK.requestLoan');

        // Get unsigned transaction data from API
        const response = await fetch(`${this.apiUrl}/tx/request-loan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ amount, durationDays })
        });
        if (!response.ok) throw new Error(`requestLoan: API ${response.status} ${response.statusText}`);
        const txData = await response.json();

        if (txData.error) {
            throw new Error(txData.error);
        }
        this._assertSafeTx(txData, 'requestLoan');

        // Sign and send transaction
        const tx = await this.wallet.sendTransaction({
            to: txData.to,
            data: txData.data
        });

        console.log(`Loan request sent: ${tx.hash}`);
        const { receipt } = await waitForReceiptResilient(this.provider, tx.hash);
        if (receipt.status !== 1) {
            throw new Error(`Loan request tx ${tx.hash.slice(0,12)} reverted on-chain`);
        }
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
        if (!response.ok) throw new Error(`repayLoan: API ${response.status} ${response.statusText}`);
        const txData = await response.json();

        if (txData.error) {
            throw new Error(txData.error);
        }
        this._assertSafeTx(txData, 'repayLoan');

        // Sign and send transaction
        const tx = await this.wallet.sendTransaction({
            to: txData.to,
            data: txData.data
        });

        console.log(`Loan repayment sent: ${tx.hash}`);
        const { receipt } = await waitForReceiptResilient(this.provider, tx.hash);
        if (receipt.status !== 1) {
            throw new Error(`Loan repayment tx ${tx.hash.slice(0,12)} reverted on-chain`);
        }
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
