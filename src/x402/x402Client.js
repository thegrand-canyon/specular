/**
 * x402 Client Middleware
 *
 * Enables agent bots to automatically handle HTTP 402 "Payment Required"
 * responses using EIP-3009 transferWithAuthorization signatures.
 *
 * Usage:
 *   const client = new x402Client(wallet, usdcContract);
 *   const assessment = await client.get('http://localhost:3402/credit/0xABC...');
 */

'use strict';

const http  = require('http');
const https = require('https');
const { ethers } = require('ethers');

const EIP3009_TYPES = {
    TransferWithAuthorization: [
        { name: 'from',        type: 'address' },
        { name: 'to',          type: 'address' },
        { name: 'value',       type: 'uint256' },
        { name: 'validAfter',  type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce',       type: 'bytes32' },
    ],
};

class x402Client {
    /**
     * @param {ethers.Wallet}   wallet  - Signer wallet with USDC balance
     * @param {object}          options
     * @param {number}          options.maxRetries      - Max payment retries (default 2)
     * @param {boolean}         options.verbose         - Log payment events (default false)
     * @param {object}          options.domainOverrides - Override EIP-712 domain per network
     */
    constructor(wallet, options = {}) {
        this.wallet   = wallet;
        this.maxRetries = options.maxRetries ?? 2;
        this.verbose    = options.verbose    ?? false;
        this.domainOverrides = options.domainOverrides ?? {};

        // Track spend for budget limits
        this.totalSpent = 0n; // in token base units
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Make a GET request, automatically paying any 402 responses.
     * @param {string} url
     * @param {object} requestHeaders  Additional headers
     * @returns {Promise<object>}      Parsed JSON response body
     */
    async get(url, requestHeaders = {}) {
        return this._fetchWithPayment('GET', url, null, requestHeaders);
    }

    /**
     * Make a POST request, automatically paying any 402 responses.
     */
    async post(url, body, requestHeaders = {}) {
        return this._fetchWithPayment('POST', url, body, requestHeaders);
    }

    /**
     * Total USDC spent on x402 payments (in human-readable form).
     */
    get totalSpentUsdc() {
        return Number(this.totalSpent) / 1e6;
    }

    // ── Core fetch-with-payment loop ───────────────────────────────────────────

    async _fetchWithPayment(method, url, body, headers, retryCount = 0) {
        const response = await this._rawFetch(method, url, body, headers);

        if (response.status === 402) {
            if (retryCount >= this.maxRetries) {
                throw new Error(`[x402] Max retries (${this.maxRetries}) exceeded for ${url}`);
            }

            const requirements = this._parseRequirements(response.body);
            if (!requirements) {
                throw new Error(`[x402] 402 response missing payment requirements: ${JSON.stringify(response.body)}`);
            }

            this._log(`Payment required for ${url}:`);
            this._log(`  Amount: ${Number(requirements.maxAmountRequired) / 1e6} USDC → ${requirements.payTo}`);

            const paymentHeader = await this._buildPaymentHeader(requirements);

            // Retry with payment
            return this._fetchWithPayment(method, url, body, {
                ...headers,
                'X-PAYMENT': paymentHeader,
            }, retryCount + 1);
        }

        if (response.status >= 400) {
            throw new Error(`[x402] HTTP ${response.status}: ${JSON.stringify(response.body)}`);
        }

        return response.body;
    }

    // ── EIP-3009 payment builder ───────────────────────────────────────────────

    /**
     * Build the X-PAYMENT header value (base64 JSON) using EIP-3009.
     */
    async _buildPaymentHeader(requirements) {
        const { maxAmountRequired, payTo, asset, extra = {}, network } = requirements;

        const from        = this.wallet.address;
        const to          = payTo;
        const value       = BigInt(maxAmountRequired);
        const validAfter  = BigInt(extra.validAfter  ?? Math.floor(Date.now() / 1000) - 60);
        const validBefore = BigInt(extra.validBefore ?? Math.floor(Date.now() / 1000) + 300);
        const nonce       = ethers.hexlify(ethers.randomBytes(32));

        // Resolve EIP-712 domain from network config
        const domain = await this._resolveDomain(asset, network, extra);

        const sig = await this.wallet.signTypedData(domain, EIP3009_TYPES, {
            from, to, value, validAfter, validBefore, nonce,
        });
        const { v, r, s } = ethers.Signature.from(sig);

        this.totalSpent += value;
        this._log(`  Signed EIP-3009 transfer: nonce=${nonce.slice(0, 10)}...`);

        const payload = {
            x402Version: 1,
            scheme:      'eip3009',
            network,
            payload: {
                from, to,
                value:       value.toString(),
                validAfter:  validAfter.toString(),
                validBefore: validBefore.toString(),
                nonce,
                v, r, s,
            },
        };

        return Buffer.from(JSON.stringify(payload)).toString('base64');
    }

    async _resolveDomain(tokenAddress, network, extra) {
        // If the server embedded the full EIP-712 domain in the requirements, use it directly.
        // This guarantees client and server always use the same domain.
        if (extra?.eip712Domain) {
            return extra.eip712Domain;
        }

        // Check for manual override (legacy / testing)
        if (this.domainOverrides[tokenAddress]) {
            return this.domainOverrides[tokenAddress];
        }

        // Known networks
        const chainIds = {
            'arc-testnet':       5042002,
            'sepolia':           11155111,
            'base-sepolia':      84532,
            'arbitrum-sepolia':  421614,
            'optimism-sepolia':  11155420,
            'polygon-amoy':      80002,
            'mainnet':           1,
            'base':              8453,
        };

        const chainId = chainIds[network] ?? extra?.chainId;
        if (!chainId) throw new Error(`[x402] Unknown network for EIP-712 domain: ${network}`);

        return {
            name:              extra?.tokenName ?? 'USD Coin',
            version:           extra?.tokenVersion ?? '1',
            chainId,
            verifyingContract: tokenAddress,
        };
    }

    // ── HTTP helpers ───────────────────────────────────────────────────────────

    _rawFetch(method, url, body, headers) {
        return new Promise((resolve, reject) => {
            const parsed   = new URL(url);
            const isHttps  = parsed.protocol === 'https:';
            const lib      = isHttps ? https : http;

            const bodyStr = body ? JSON.stringify(body) : null;
            const opts = {
                hostname: parsed.hostname,
                port:     parsed.port || (isHttps ? 443 : 80),
                path:     parsed.pathname + parsed.search,
                method,
                headers: {
                    'Content-Type': 'application/json',
                    'Accept':       'application/json',
                    'User-Agent':   'Specular-x402-Client/1.0',
                    ...headers,
                    ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
                },
            };

            const req = lib.request(opts, (res) => {
                let raw = '';
                res.on('data', (chunk) => (raw += chunk));
                res.on('end', () => {
                    let parsed;
                    try { parsed = JSON.parse(raw); } catch { parsed = raw; }
                    resolve({ status: res.statusCode, headers: res.headers, body: parsed });
                });
            });

            req.on('error', reject);
            if (bodyStr) req.write(bodyStr);
            req.end();
        });
    }

    _parseRequirements(body) {
        // x402 body format: { x402Version, error, accepts: [{ scheme, maxAmountRequired, ... }] }
        if (body && Array.isArray(body.accepts) && body.accepts.length > 0) {
            return body.accepts.find(r => r.scheme === 'eip3009') || body.accepts[0];
        }
        // Legacy/simple format
        if (body && body.x402) return body.x402;
        return null;
    }

    _log(msg) {
        if (this.verbose) console.log(`[x402]`, msg);
    }
}

module.exports = x402Client;
