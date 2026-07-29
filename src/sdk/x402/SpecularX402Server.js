/**
 * SpecularX402Server — x402 payment middleware that auto-supplies revenue
 * into a Specular pool, turning API sellers into passive lenders.
 *
 * Closes the agent-credit loop:
 *   - Agent borrows USDC from Specular (via SpecularX402Client) to pay a
 *     paywalled API
 *   - That API runs this middleware; receives USDC payment
 *   - Middleware auto-supplies accumulated revenue into a Specular pool
 *   - Pool capital lent out to next agent
 *
 * Modes:
 *   - 'stub'        : accept any payment header (local dev / demos)
 *   - 'facilitator' : verify + settle via remote x402 facilitator
 *                     (defaults to x402.org public facilitator — base-sepolia only)
 *   - 'local'       : verify + settle directly against the chain's RPC, using
 *                     the seller's signer to broadcast transferWithAuthorization.
 *                     Works on any x402-supported EVM network including Base mainnet.
 *
 * Usage:
 *   const { SpecularX402Server } = require('@specular/sdk/x402');
 *   const x402 = new SpecularX402Server({
 *       privateKey: process.env.SELLER_KEY,
 *       network: 'base',
 *       payTo: process.env.SELLER_WALLET,
 *       poolAgentId: 49,
 *       pricing: { '/transcribe': 0.5 },
 *       autoFlushThresholdUsdc: 10,
 *       mode: 'facilitator'
 *   });
 *
 *   http.createServer(x402.handle.bind(x402))     // node:http
 *   app.use(x402.express())                       // express
 */

const { ethers } = require('ethers');
const http = require('http');
const fs = require('fs');
const { createWalletClient, createPublicClient, http: viemHttp, publicActions } = require('viem');
const { privateKeyToAccount } = require('viem/accounts');
const { base, baseSepolia } = require('viem/chains');

const VIEM_CHAINS = { base, 'base-sepolia': baseSepolia };

const NETWORKS = {
    base: {
        addresses: './src/config/base-addresses.json',
        defaultRpc: 'https://mainnet.base.org',
        x402Network: 'base',
        defaultFacilitator: 'https://x402.org/facilitator',
    },
    arc: {
        addresses: './src/config/arc-testnet-addresses.json',
        defaultRpc: 'https://arc-testnet.drpc.org',
        x402Network: 'base',  // Arc isn't an x402 native chain; demos use stub
        defaultFacilitator: null,  // no facilitator on Arc — stub only
    }
};

class SpecularX402Server {
    constructor(opts = {}) {
        const netCfg = NETWORKS[opts.network || 'base'];
        if (!netCfg) throw new Error('Unknown network: ' + opts.network);

        const addr = JSON.parse(fs.readFileSync(netCfg.addresses, 'utf8'));
        const pk = opts.privateKey || process.env.SELLER_KEY || process.env.PRIVATE_KEY;
        if (!pk) throw new Error('SpecularX402Server: no privateKey provided');
        const pkPrefixed = pk.startsWith('0x') ? pk : '0x' + pk;

        this.network = opts.network || 'base';
        this.netCfg = netCfg;
        this.addresses = addr;
        this.usdcAddr = addr.usdc;

        // batchMaxCount: 1 — many free public RPCs (drpc, ankr) reject batched calls
        this.provider = new ethers.JsonRpcProvider(opts.rpcUrl || netCfg.defaultRpc, undefined, { batchMaxCount: 1 });
        this.wallet = new ethers.Wallet(pkPrefixed, this.provider);
        this.payTo = opts.payTo || this.wallet.address;
        this.poolAgentId = opts.poolAgentId || null;  // null = no auto-supply
        this.pricing = opts.pricing || { default: 0.5 };  // USDC per route
        this.autoFlushThresholdUsdc = opts.autoFlushThresholdUsdc || 10;
        this.mode = opts.mode || (netCfg.defaultFacilitator ? 'facilitator' : 'stub');
        this.facilitatorUrl = opts.facilitatorUrl || netCfg.defaultFacilitator;
        this._pkPrefixed = pkPrefixed;

        // [F4] stub mode serves the resource and books revenue with NO payment
        // verification — fine for local dev/tests, dangerous if shipped by
        // accident (a "paywall" that collects nothing while reporting revenue).
        // Require an explicit opt-in.
        this.allowStub = opts.allowStub === true || process.env.SPECULAR_X402_ALLOW_STUB === '1';
        if (this.mode === 'stub' && !this.allowStub) {
            throw new Error(
                'SpecularX402Server: stub mode performs NO payment verification. ' +
                'To use it (tests/local dev only) pass { allowStub: true } or set ' +
                'SPECULAR_X402_ALLOW_STUB=1. For real payments use mode "local" or "facilitator".');
        }

        // [F5] Base URL used to build the payment `resource`. When set, we derive
        // it server-side instead of from client-controlled Host/X-Forwarded
        // headers.
        this.baseUrl = (opts.baseUrl || process.env.SPECULAR_X402_BASE_URL || '').replace(/\/+$/, '') || null;

        // [F6] Token gating the /__specular_x402/stats endpoint. If unset, stats
        // are served only to loopback callers (never remote).
        this.statsToken = opts.statsToken || process.env.SPECULAR_X402_STATS_TOKEN || null;

        this._earned = 0n;  // accumulated USDC (6-dec base units)
        this._requestCount = 0;
        this._lastFlushAt = null;
        this._totalFlushed = 0n;
        this._lastSettlement = null;
        this._flushInFlight = null;  // mutex: in-flight flushToPool Promise (or null)

        // Lazy-load SDK + x402 (don't pay import cost unless we'll use them)
        this._sdk = null;
        this._facilitator = null;
        this._viemSigner = null;
    }

    _getViemSigner() {
        if (this._viemSigner) return this._viemSigner;
        const chain = VIEM_CHAINS[this.netCfg.x402Network] || base;
        const account = privateKeyToAccount(this._pkPrefixed);
        const transport = viemHttp(this.provider._getConnection?.().url || this.netCfg.defaultRpc);
        // walletClient + publicActions = SignerWallet for x402's local settle/verify
        this._viemSigner = createWalletClient({ account, chain, transport }).extend(publicActions);
        return this._viemSigner;
    }

    _getSdk() {
        if (!this._sdk) {
            const { SpecularQuickstart } = require('../SpecularQuickstart');
            this._sdk = new SpecularQuickstart(this.wallet, this.network);
        }
        return this._sdk;
    }

    _getFacilitator() {
        if (this._facilitator) return this._facilitator;
        if (this.mode !== 'facilitator') return null;
        const { useFacilitator } = require('x402/verify');
        this._facilitator = useFacilitator({ url: this.facilitatorUrl });
        return this._facilitator;
    }

    _priceFor(routePath) {
        const exact = this.pricing[routePath];
        if (exact !== undefined) return exact;
        return this.pricing.default ?? 0.5;
    }

    _paymentRequirements(req, routePath, priceUsdc) {
        // [F5] Prefer the server-configured baseUrl. Only fall back to
        // client-controlled Host/X-Forwarded-* headers when no baseUrl is set
        // (a spoofed Host can otherwise poison a facilitator's replay-key/logs).
        let resource;
        if (this.baseUrl) {
            resource = `${this.baseUrl}${routePath}`;
        } else {
            const proto = req.headers['x-forwarded-proto'] || 'http';
            const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost';
            resource = `${proto}://${host}${routePath}`;
        }
        return {
            x402Version: 1,
            error: 'X-PAYMENT header is required',
            accepts: [{
                scheme: 'exact',
                network: this.netCfg.x402Network,
                maxAmountRequired: String(Math.floor(priceUsdc * 1_000_000)),
                resource,
                description: `Payment for ${routePath}`,
                mimeType: 'application/json',
                payTo: this.payTo,
                maxTimeoutSeconds: 60,
                asset: this.usdcAddr,
                extra: {
                    name: 'USD Coin',
                    version: '2',
                }
            }]
        };
    }

    /**
     * Process one request. Returns { ok, status, body, paymentResult }.
     * - If no payment header: returns 402 + requirements
     * - If invalid payment: returns 402 + reason
     * - If valid: returns ok=true so caller can proceed
     */
    async process(req, routePath) {
        const priceUsdc = this._priceFor(routePath || req.url);
        const requirements = this._paymentRequirements(req, routePath || req.url, priceUsdc);

        // Look for x402 payment header (spec uses 'X-PAYMENT'; older drafts used 'PAYMENT-SIGNATURE')
        const headerStr = req.headers['x-payment'] || req.headers['payment-signature'];
        if (!headerStr) {
            return { ok: false, status: 402, body: requirements };
        }

        // Stub mode: accept anything that looks like a payment
        if (this.mode === 'stub') {
            this._recordRevenue(BigInt(requirements.accepts[0].maxAmountRequired));
            return { ok: true, headerSnippet: String(headerStr).slice(0, 40) + '...' };
        }

        // Decode payment payload (base64 JSON)
        let payload;
        try {
            payload = JSON.parse(Buffer.from(String(headerStr), 'base64').toString('utf8'));
        } catch (e) {
            return { ok: false, status: 402, body: { error: 'malformed payment header', ...requirements } };
        }

        // Local mode: verify + settle directly against RPC (works on Base mainnet)
        if (this.mode === 'local') {
            const { verify, settle } = require('x402/facilitator');
            const signer = this._getViemSigner();
            const verifyRes = await verify(signer, payload, requirements.accepts[0]);
            if (!verifyRes || verifyRes.isValid === false) {
                return { ok: false, status: 402, body: { error: 'invalid payment', reason: verifyRes?.invalidReason, ...requirements } };
            }
            const settleRes = await settle(signer, payload, requirements.accepts[0]);
            if (!settleRes || settleRes.success === false) {
                return { ok: false, status: 402, body: { error: 'settlement failed', reason: settleRes?.errorReason, ...requirements } };
            }
            this._lastSettlement = settleRes;
            this._recordRevenue(BigInt(requirements.accepts[0].maxAmountRequired));
            return { ok: true, settlement: settleRes };
        }

        // Facilitator mode: verify + settle via remote facilitator
        const fac = this._getFacilitator();
        const verifyRes = await fac.verify(payload, requirements.accepts[0]);
        if (!verifyRes || verifyRes.isValid === false) {
            return { ok: false, status: 402, body: { error: 'invalid payment', reason: verifyRes?.invalidReason, ...requirements } };
        }

        const settleRes = await fac.settle(payload, requirements.accepts[0]);
        if (!settleRes || settleRes.success === false) {
            return { ok: false, status: 402, body: { error: 'settlement failed', reason: settleRes?.errorReason, ...requirements } };
        }

        this._lastSettlement = settleRes;
        this._recordRevenue(BigInt(requirements.accepts[0].maxAmountRequired));
        return { ok: true, settlement: settleRes };
    }

    _recordRevenue(amountBase) {
        this._earned += amountBase;
        this._requestCount += 1;
        if (this.poolAgentId && this._earned >= ethers.parseUnits(String(this.autoFlushThresholdUsdc), 6)) {
            this.flushToPool().catch(e => console.error('[SpecularX402Server] auto-flush failed:', e.message));
        }
    }

    /**
     * Supply accumulated revenue into the configured Specular pool. Idempotent
     * if nothing to flush. Returns { txHash, amountUsdc } or null.
     *
     * Serialized: only one flush runs at a time. Concurrent calls await the
     * in-flight one and then re-enter to drain any revenue accumulated during
     * that flush (necessary because new requests may arrive mid-flush).
     */
    async flushToPool() {
        if (!this.poolAgentId) return null;
        // If a flush is in-flight, wait for it; then re-check and potentially
        // run our own (to drain revenue that arrived during the prior flush).
        // This MUST be a `while`, not an `if`: when N callers await the same
        // in-flight flush and it resolves, they all resume past this guard in
        // the same microtask batch. A plain `if` lets every one of them fall
        // through and overwrite `_flushInFlight` with its own IIFE, each
        // snapshotting the same `_earned` and supplying it concurrently
        // (double-supply + negative `_earned`). Looping re-checks the guard so
        // exactly one caller proceeds per drain — the check-and-set below is
        // synchronous, so no other caller can interleave before it reassigns.
        while (this._flushInFlight) {
            try { await this._flushInFlight; } catch (e) { /* ignore */ }
        }
        if (this._earned === 0n) return null;

        this._flushInFlight = (async () => {
            const sdk = this._getSdk();
            await sdk.onboard().catch(() => {});

            const usdc = new ethers.Contract(this.usdcAddr,
                ['function balanceOf(address) view returns (uint256)'], this.provider);
            const bal = await usdc.balanceOf(this.wallet.address);

            // Snapshot _earned now; deduct AFTER the supply tx confirms
            const snapshot = this._earned;
            const toSupply = bal < snapshot ? bal : snapshot;
            if (toSupply === 0n) return null;

            const amountUsdc = Number(ethers.formatUnits(toSupply, 6));
            const txHash = await sdk.supply(this.poolAgentId, toSupply);
            this._earned -= toSupply;
            this._totalFlushed += toSupply;
            this._lastFlushAt = new Date().toISOString();
            console.log(`[SpecularX402Server] Flushed ${amountUsdc} USDC into pool ${this.poolAgentId}: ${txHash}`);
            return { txHash, amountUsdc };
        })();

        try {
            return await this._flushInFlight;
        } finally {
            this._flushInFlight = null;
        }
    }

    /** Stats snapshot for monitoring. */
    stats() {
        return {
            mode: this.mode,
            network: this.network,
            sellerWallet: this.wallet.address,
            payTo: this.payTo,
            poolAgentId: this.poolAgentId,
            requestCount: this._requestCount,
            pendingUsdc: ethers.formatUnits(this._earned, 6),
            totalFlushedUsdc: ethers.formatUnits(this._totalFlushed, 6),
            lastFlushAt: this._lastFlushAt,
            autoFlushThresholdUsdc: this.autoFlushThresholdUsdc,
        };
    }

    /**
     * node:http style request handler. Wraps the user's handler with x402 gating.
     *
     *   const x402 = new SpecularX402Server({...});
     *   http.createServer(x402.handle(async (req, res) => {
     *       // payment already verified; do work
     *       res.writeHead(200); res.end(...);
     *   }));
     */
    /**
     * [F6] Is this caller allowed to read /__specular_x402/stats? Stats expose
     * wallet/pool/revenue, so: if a statsToken is configured, require it in an
     * Authorization: Bearer header; otherwise only loopback callers may read.
     */
    _statsAllowed(req) {
        if (this.statsToken) {
            const auth = req.headers['authorization'] || '';
            return auth === `Bearer ${this.statsToken}`;
        }
        const ip = (req.socket && req.socket.remoteAddress) || (req.connection && req.connection.remoteAddress) || '';
        return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
    }

    handle(handler) {
        return async (req, res) => {
            if (req.url === '/__specular_x402/stats' && req.method === 'GET') {
                if (!this._statsAllowed(req)) {
                    // Don't reveal the endpoint exists to unauthorized callers.
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'not found' }));
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(this.stats(), null, 2));
                return;
            }

            try {
                const result = await this.process(req, req.url);
                if (!result.ok) {
                    res.writeHead(result.status, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify(result.body));
                    return;
                }
                // Payment valid — invoke handler
                await handler(req, res, result);
            } catch (e) {
                // Log detail server-side; return a generic body (don't leak RPC
                // URLs / addresses / ethers internals to unauthenticated clients).
                console.error('[SpecularX402Server] error:', e.message);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'internal error' }));
            }
        };
    }

    /**
     * Express-style middleware. Mounts payment gating before the next handler.
     *
     *   app.post('/transcribe', x402.express(), (req, res) => {
     *       res.json({ result: 'done' });
     *   });
     */
    express() {
        return async (req, res, next) => {
            if (req.url === '/__specular_x402/stats' && req.method === 'GET') {
                if (!this._statsAllowed(req)) {
                    return res.status(404).json({ error: 'not found' });
                }
                return res.status(200).json(this.stats());
            }
            try {
                const result = await this.process(req, req.path || req.url);
                if (!result.ok) {
                    return res.status(result.status).json(result.body);
                }
                req.x402 = result;
                next();
            } catch (e) {
                console.error('[SpecularX402Server] express error:', e.message);
                res.status(500).json({ error: 'internal error' });
            }
        };
    }

    /**
     * Schedule periodic flush. Returns the interval handle so caller can clear.
     */
    startAutoFlush(intervalMs = 60_000) {
        return setInterval(() => {
            this.flushToPool().catch(e => console.error('[SpecularX402Server] periodic flush failed:', e.message));
        }, intervalMs);
    }
}

module.exports = { SpecularX402Server };
