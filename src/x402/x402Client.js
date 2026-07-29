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

// Default per-payment cap (base units, 6 decimals): 10 USDC. x402 is a
// micropayment scheme, so this is generous while still bounding the blast
// radius if a hostile paywall names a huge amount. Callers move real money by
// raising maxPayment explicitly — never by having no cap at all.
const DEFAULT_MAX_PAYMENT = 10_000000n;

// Known canonical USDC token addresses per x402 network name. The EIP-3009
// signature is only valid against `verifyingContract`; if a server picks that,
// it picks which token the buyer signs away. Where we know the real USDC we
// pin it and reject anything else.
const KNOWN_USDC = {
    'base':         '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    'arc-testnet':  '0xf2807051e292e945751A25616705a9aadfb39895',
    'base-sepolia': '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Circle official
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

        // Spend caps (base units). maxPayment bounds a single payment;
        // maxTotalSpend bounds the lifetime of this client. maxPayment defaults
        // to a safe non-null value so an unset caller can never sign away the
        // whole wallet on one hostile 402. Pass null explicitly to opt out.
        this.maxPayment = options.maxPayment === null
            ? null
            : BigInt(options.maxPayment ?? DEFAULT_MAX_PAYMENT);
        this.maxTotalSpend = options.maxTotalSpend != null ? BigInt(options.maxTotalSpend) : null;

        // If true, trust a server-supplied eip712Domain even when its
        // verifyingContract disagrees with the known USDC for the network.
        // Off by default — this is the token-substitution guard.
        this.allowUntrustedToken = options.allowUntrustedToken ?? false;

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

        // ── Spend guards: enforce BEFORE signing anything ──────────────────
        if (value <= 0n) {
            throw new Error(`[x402] refusing to sign a non-positive payment (${value})`);
        }
        if (!to || !ethers.isAddress(to)) {
            throw new Error(`[x402] refusing to sign — invalid payTo "${to}"`);
        }
        if (this.maxPayment !== null && value > this.maxPayment) {
            throw new Error(
                `[x402] payment ${Number(value) / 1e6} USDC exceeds maxPayment ` +
                `${Number(this.maxPayment) / 1e6} USDC — raise maxPayment to authorize`);
        }
        if (this.maxTotalSpend !== null && (this.totalSpent + value) > this.maxTotalSpend) {
            throw new Error(
                `[x402] payment would exceed maxTotalSpend ` +
                `${Number(this.maxTotalSpend) / 1e6} USDC (already spent ` +
                `${Number(this.totalSpent) / 1e6})`);
        }

        const validAfter  = BigInt(extra.validAfter  ?? Math.floor(Date.now() / 1000) - 60);
        const validBefore = BigInt(extra.validBefore ?? Math.floor(Date.now() / 1000) + 300);
        const nonce       = ethers.hexlify(ethers.randomBytes(32));

        // Resolve EIP-712 domain from network config
        const domain = await this._resolveDomain(asset, network, extra);

        // Token-substitution guard: the signature is only valid against
        // domain.verifyingContract, and the server picks that. The per-payment
        // cap bounds token *quantity*, not value — a substituted low-decimal or
        // high-value token can blow past the intended blast radius — so we must
        // pin the token identity, not just cap the amount.
        const knownUsdc = KNOWN_USDC[network];
        if (!this.allowUntrustedToken) {
            if (!knownUsdc) {
                // Unknown network ⇒ we have no canonical USDC to pin against, so
                // the server could name any EIP-3009 token. Refuse rather than
                // sign blind. (Previously this path skipped the guard entirely.)
                throw new Error(
                    `[x402] refusing to sign on unrecognized network "${network}" — ` +
                    `no known USDC to pin verifyingContract against; ` +
                    `set allowUntrustedToken to override`);
            }
            if (domain.verifyingContract &&
                domain.verifyingContract.toLowerCase() !== knownUsdc.toLowerCase()) {
                throw new Error(
                    `[x402] refusing to sign — verifyingContract ${domain.verifyingContract} ` +
                    `is not the known USDC for ${network} (${knownUsdc}); ` +
                    `set allowUntrustedToken to override`);
            }
        }

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
