'use strict';
/**
 * Specular Lender Agent
 *
 * Passive yield agent — supplies USDC to a lending pool and monitors
 * earnings while the borrower agent runs its cycles.
 *
 * Flow:
 *   1. Register (if needed)
 *   2. Supply USDC to a target pool
 *   3. Poll pool stats every N seconds, reporting accrued interest
 *   4. Summarize total yield earned at the end
 */

const { SpecularSDK }    = require('../sdk/SpecularSDK');
const { AgentMessenger } = require('../xmtp/AgentMessenger');

class LenderAgent {
    /**
     * @param {object}        opts
     * @param {ethers.Wallet} opts.wallet        - Funded wallet (needs USDC + ETH)
     * @param {string}        opts.apiUrl        - Specular Agent API base URL
     * @param {object}        [opts.config]
     * @param {number}        opts.config.targetPoolId   - Pool to supply liquidity to
     * @param {number}        opts.config.supplyUsdc     - USDC amount to supply
     * @param {number}        opts.config.pollIntervalMs - How often to check earnings (default: 12000)
     * @param {number}        opts.config.totalDurationMs- How long to run (default: 120000)
     * @param {string}        [opts.borrowerAddress]     - Borrower wallet address for XMTP notifications
     * @param {string}        [opts.xmtpEnv]             - 'dev' (default) | 'production'
     */
    constructor(opts = {}) {
        if (!opts.wallet) throw new Error('LenderAgent: wallet required');
        if (!opts.apiUrl) throw new Error('LenderAgent: apiUrl required');

        this.wallet = opts.wallet;
        this.sdk    = new SpecularSDK({ apiUrl: opts.apiUrl, wallet: opts.wallet, verbose: false });
        this.borrowerAddress = opts.borrowerAddress ?? null;
        this.xmtpEnv         = opts.xmtpEnv ?? 'dev';
        this.messenger       = null;  // initialised in run()

        const cfg = opts.config ?? {};
        this.cfg = {
            targetPoolId:    cfg.targetPoolId    ?? 5,
            supplyUsdc:      cfg.supplyUsdc      ?? 100,
            pollIntervalMs:  cfg.pollIntervalMs  ?? 12000,
            totalDurationMs: cfg.totalDurationMs ?? 120000,
        };

        this.agentId         = null;
        this.supplyTxHash    = null;
        this.baselineEarned  = null;  // pool.totalEarnedUsdc before our supply
        this.stats = { supplied: 0, finalEarned: 0 };
    }

    // ── Main entry ─────────────────────────────────────────────────────────────

    async run() {
        this._log('─'.repeat(40));
        this._log('  Lender Agent starting');
        this._log(`  Wallet: ${this.wallet.address}`);
        this._log(`  Supply: ${this.cfg.supplyUsdc} USDC → pool #${this.cfg.targetPoolId}`);
        if (this.borrowerAddress) this._log(`  Notifying: ${this.borrowerAddress} via XMTP`);
        this._log('─'.repeat(40));

        // Initialise XMTP messenger (gracefully no-ops if package missing)
        this.messenger = await AgentMessenger.create(this.wallet, this.xmtpEnv);

        // Step 1: register
        await this._ensureRegistered();

        // Step 2: snapshot pool before supply (tolerate 404 if pool not yet initialized)
        try {
            const poolBefore = await this._pollPool('before supply');
            this.baselineEarned = poolBefore.totalEarnedUsdc ?? 0;
        } catch (err) {
            if (err.message?.includes('404') || err.message?.includes('not found')) {
                this._log(`  Pool #${this.cfg.targetPoolId} not yet initialized — will be created on first supply`);
                this.baselineEarned = 0;
            } else {
                throw err;
            }
        }

        // Step 3: supply liquidity
        await this._supply();

        // Step 4: monitor for totalDurationMs
        await this._monitor();

        this._printSummary();
    }

    // ── Steps ──────────────────────────────────────────────────────────────────

    async _ensureRegistered() {
        const profile = await this.sdk.getAgentProfile(this.wallet.address);
        if (!profile.registered) {
            this._log('Registering...');
            await this._withRetry(() => this.sdk.register({ name: 'LenderAgent' }), 'register');
            await this._sleep(3000);
            const updated = await this.sdk.getAgentProfile(this.wallet.address);
            this.agentId = updated.agentId;
            this._log(`Registered as Agent #${this.agentId}`);
        } else {
            this.agentId = profile.agentId;
            this._log(`Agent #${this.agentId} | score ${profile.reputation?.score} (${profile.reputation?.tier})`);
        }
    }

    async _supply() {
        this._log(`\nSupplying ${this.cfg.supplyUsdc} USDC to pool #${this.cfg.targetPoolId}...`);
        try {
            const result = await this._withRetry(
                () => this.sdk.supplyLiquidity({
                    agentId: this.cfg.targetPoolId,
                    amount:  this.cfg.supplyUsdc,
                }),
                'supplyLiquidity'
            );
            this.supplyTxHash = result.txHash;
            this.stats.supplied = this.cfg.supplyUsdc;
            this._log(`  Supplied! tx: ${result.txHash}`);

            // Notify borrower via XMTP
            if (this.borrowerAddress) {
                await this.messenger.send(
                    this.borrowerAddress,
                    AgentMessenger.msg.supplied(this.cfg.targetPoolId, this.cfg.supplyUsdc, this.wallet.address),
                );
            }
        } catch (err) {
            this._log(`  Supply failed: ${err.message.slice(0, 100)}`);
            this._log('  Continuing in monitor-only mode...');
        }
    }

    async _monitor() {
        const deadline = Date.now() + this.cfg.totalDurationMs;
        let polls = 0;
        let lastMsgCount = 0;

        this._log(`\nMonitoring pool #${this.cfg.targetPoolId} earnings...`);

        while (Date.now() < deadline) {
            await this._sleep(this.cfg.pollIntervalMs);
            polls++;

            try {
                const pool = await this._pollPool(`poll #${polls}`);
                this.stats.finalEarned = (pool.totalEarnedUsdc ?? 0) - this.baselineEarned;
            } catch {
                // tolerate intermittent failures
            }

            // Check for XMTP messages from borrower
            if (this.borrowerAddress && !this.messenger._noop) {
                try {
                    const msgs = await this.messenger.readFrom(this.borrowerAddress, 20);
                    if (msgs.length > lastMsgCount) {
                        const newMsgs = msgs.slice(lastMsgCount);
                        for (const m of newMsgs) {
                            this._log(`  [XMTP] ${m.sent.toISOString()} — ${m.content.split('\n')[0]}`);
                        }
                        lastMsgCount = msgs.length;
                    }
                } catch {
                    // tolerate
                }
            }
        }
    }

    async _pollPool(label) {
        const pool = await this.sdk.getPool(this.cfg.targetPoolId);
        const earned    = pool.totalEarnedUsdc ?? 0;
        const available = pool.availableLiquidityUsdc ?? 0;
        const total     = pool.totalLiquidityUsdc ?? 0;
        const util      = pool.utilizationPct ?? '?';
        const sinceBase = this.baselineEarned !== null
            ? ` (+${(earned - this.baselineEarned).toFixed(6)} since start)`
            : '';

        this._log(`  [${label}] pool #${this.cfg.targetPoolId}: ` +
            `${available.toLocaleString()} USDC avail | ` +
            `earned ${earned.toFixed(6)}${sinceBase} | util ${util}%`);

        return pool;
    }

    _printSummary() {
        this._log('\n' + '─'.repeat(40));
        this._log('  Lender Agent complete');
        this._log('─'.repeat(40));
        this._log(`  Supplied:         ${this.stats.supplied} USDC`);
        this._log(`  Pool earned (Δ):  ${this.stats.finalEarned.toFixed(6)} USDC (net pool interest since supply)`);
        this._log(`  XMTP messages:    ${this.messenger?.sentCount ?? 0} sent`);
        this._log('─'.repeat(40));
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    async _withRetry(fn, label, maxAttempts = 4, baseDelayMs = 4000) {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                return await fn();
            } catch (err) {
                const isTimeout = err.message?.includes('408') || err.message?.includes('timeout') || err.code === 'SERVER_ERROR';
                if (!isTimeout || attempt === maxAttempts) throw err;
                const delay = baseDelayMs * attempt;
                this._log(`  [retry] ${label} attempt ${attempt}/${maxAttempts} — waiting ${delay / 1000}s...`);
                await this._sleep(delay);
            }
        }
    }

    _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    _log(msg) {
        const ts = new Date().toTimeString().slice(0, 8);
        console.log(`[${ts}] [LENDER] ${msg}`);
    }
}

module.exports = { LenderAgent };
