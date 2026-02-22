/**
 * x402 Credit Assessment Server
 *
 * Implements the x402 payment protocol (HTTP 402) for agent credit checks.
 * Agents must pay a small USDC fee to retrieve their credit assessment,
 * enabling micro-payment-gated AI agent APIs.
 *
 * Protocol flow:
 *   1. Agent calls GET /credit/:address
 *   2. Server responds 402 with payment requirements
 *   3. Agent signs EIP-3009 transferWithAuthorization + retries with X-PAYMENT header
 *   4. Server verifies payment on-chain and returns credit data
 */

'use strict';

const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const { ethers } = require('ethers');

// ── EIP-3009 minimal ABI (transferWithAuthorization + nonces) ────────────────
const EIP3009_ABI = [
    'function transferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce,uint8 v,bytes32 r,bytes32 s)',
    'function authorizationState(address authorizer,bytes32 nonce) view returns (bool)',
    'function DOMAIN_SEPARATOR() view returns (bytes32)',
    'event Transfer(address indexed from,address indexed to,uint256 value)',
];

const REPUTATION_ABI = [
    'function getReputationScore(address agent) view returns (uint256)',
    'function calculateCreditLimit(address agent) view returns (uint256)',
    'function calculateCollateralRequirement(address agent) view returns (uint256)',
    'function calculateInterestRate(address agent) view returns (uint256)',
];

// ── Persistent nonce store ────────────────────────────────────────────────────
// Saves used EIP-3009 nonces to a JSON file so they survive server restarts.
// This prevents replay attacks across restarts.

class NonceStore {
    constructor(filePath) {
        this._file  = filePath;
        this._nonces = new Set();
        this._load();
    }

    has(nonce) {
        return this._nonces.has(nonce);
    }

    add(nonce) {
        this._nonces.add(nonce);
        this._save();
    }

    _load() {
        try {
            const raw = fs.readFileSync(this._file, 'utf8');
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) arr.forEach(n => this._nonces.add(n));
        } catch {
            // File doesn't exist yet — start with empty store
        }
    }

    _save() {
        try {
            const dir = path.dirname(this._file);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(this._file, JSON.stringify([...this._nonces]), 'utf8');
        } catch (e) {
            console.error('[x402] Warning: could not persist nonce store:', e.message);
        }
    }
}

// ── Default configuration ─────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
    port:         3402,
    host:         '0.0.0.0',
    rpcUrl:       process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org',
    network:      'arc-testnet',
    chainId:      5042002,
    // Contract addresses (Arc Testnet)
    usdcAddress:         process.env.USDC_ADDRESS          || '0xf2807051e292e945751A25616705a9aadfb39895',
    reputationAddress:   process.env.REPUTATION_ADDRESS     || '0x94F2fa47c4488202a46dAA9038Ed9C9c4c07467F',
    // Payment settings
    feeRecipient:  process.env.FEE_RECIPIENT  || '',   // must be set in .env
    feeAmount:     process.env.CREDIT_CHECK_FEE || '1000000', // 1 USDC (6 decimals)
    maxTimeoutSec: 300,
};

class CreditAssessmentServer {
    constructor(config = {}) {
        this.cfg = { ...DEFAULT_CONFIG, ...config };

        if (!this.cfg.feeRecipient) {
            throw new Error('FEE_RECIPIENT env var required (address that receives credit-check fees)');
        }

        // batchMaxCount: 1 avoids JSON-RPC batching (free-tier dRPC limits batch size to 3)
        this.provider   = new ethers.JsonRpcProvider(this.cfg.rpcUrl, undefined, { batchMaxCount: 1 });
        this.usdc       = new ethers.Contract(this.cfg.usdcAddress, EIP3009_ABI, this.provider);
        this.reputation = new ethers.Contract(this.cfg.reputationAddress, REPUTATION_ABI, this.provider);

        // File-backed nonce store — survives server restarts, prevents replay attacks
        const nonceFile = this.cfg.nonceStorePath
            || path.join(process.cwd(), '.x402-nonces.json');
        this.usedNonces = new NonceStore(nonceFile);

        this.server = http.createServer((req, res) => this._route(req, res));
    }

    // ── Routing ────────────────────────────────────────────────────────────────

    _route(req, res) {
        const url = req.url.split('?')[0];

        if (req.method === 'GET' && url === '/health') {
            return this._json(res, 200, { status: 'ok', server: 'x402-credit-assessment' });
        }

        const creditMatch = url.match(/^\/credit\/?(0x[0-9a-fA-F]{40})?$/);
        if (req.method === 'GET' && creditMatch) {
            return this._handleCredit(req, res, creditMatch[1]);
        }

        return this._json(res, 404, { error: 'Not found' });
    }

    // ── Credit endpoint ────────────────────────────────────────────────────────

    async _handleCredit(req, res, agentAddress) {
        if (!agentAddress || !ethers.isAddress(agentAddress)) {
            return this._json(res, 400, { error: 'Invalid agent address. Use /credit/0x...' });
        }

        const paymentHeader = req.headers['x-payment'];

        // No payment header → return 402 with requirements
        if (!paymentHeader) {
            return this._require402(res, agentAddress);
        }

        // Parse and verify payment
        try {
            const verified = await this._verifyPayment(paymentHeader, agentAddress);
            if (!verified.ok) {
                return this._json(res, 402, {
                    error:   'Payment invalid',
                    reason:  verified.reason,
                    x402:    this._paymentRequirements(agentAddress),
                });
            }
        } catch (err) {
            console.error('[x402] Payment verification error:', err.message);
            return this._json(res, 402, {
                error: 'Payment verification failed',
                x402:  this._paymentRequirements(agentAddress),
            });
        }

        // Fetch credit assessment from on-chain contracts
        try {
            const [repScore, creditLimit, collateral, interestRate] = await Promise.all([
                this.reputation.getReputationScore(agentAddress),
                this.reputation.calculateCreditLimit(agentAddress),
                this.reputation.calculateCollateralRequirement(agentAddress),
                this.reputation.calculateInterestRate(agentAddress),
            ]);

            const assessment = this._buildAssessment(agentAddress, repScore, creditLimit, collateral, interestRate);
            return this._json(res, 200, assessment);
        } catch (err) {
            console.error('[x402] Contract read error:', err.message);
            return this._json(res, 500, { error: 'Failed to fetch on-chain credit data' });
        }
    }

    // ── 402 response helpers ───────────────────────────────────────────────────

    _require402(res, agentAddress) {
        const requirements = this._paymentRequirements(agentAddress);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('X-402-Version', '1');
        res.statusCode = 402;
        res.end(JSON.stringify({
            x402Version: 1,
            error:       'Payment Required',
            accepts:     [requirements],
        }));
    }

    _paymentRequirements(agentAddress) {
        const validAfter  = Math.floor(Date.now() / 1000) - 60;   // 1 min grace
        const validBefore = Math.floor(Date.now() / 1000) + this.cfg.maxTimeoutSec;

        return {
            scheme:             'eip3009',
            network:            this.cfg.network,
            maxAmountRequired:  this.cfg.feeAmount,
            resource:           `/credit/${agentAddress}`,
            description:        'Specular Credit Assessment Fee (1 USDC)',
            mimeType:           'application/json',
            payTo:              this.cfg.feeRecipient,
            maxTimeoutSeconds:  this.cfg.maxTimeoutSec,
            asset:              this.cfg.usdcAddress,
            extra: {
                decimals:     6,
                validAfter,
                validBefore,
                // Full EIP-712 domain — client MUST use exactly this when signing
                eip712Domain: {
                    name:              this.cfg.tokenName || 'USD Coin',
                    version:           '1',
                    chainId:           this.cfg.chainId,
                    verifyingContract: this.cfg.usdcAddress,
                },
            },
        };
    }

    // ── Payment verification ───────────────────────────────────────────────────

    /**
     * Verify an x402 payment header.
     * Expects base64-encoded JSON:
     * {
     *   x402Version: 1,
     *   scheme: "eip3009",
     *   network: "arc-testnet",
     *   payload: {
     *     from, to, value, validAfter, validBefore, nonce,
     *     v, r, s      ← EIP-3009 signature components
     *   }
     * }
     */
    async _verifyPayment(header, agentAddress) {
        let parsed;
        try {
            const decoded = Buffer.from(header, 'base64').toString('utf8');
            parsed = JSON.parse(decoded);
        } catch {
            return { ok: false, reason: 'Malformed X-PAYMENT header (expected base64 JSON)' };
        }

        const { scheme, network, payload } = parsed;

        if (scheme !== 'eip3009') {
            return { ok: false, reason: `Unsupported scheme: ${scheme}` };
        }
        if (network !== this.cfg.network) {
            return { ok: false, reason: `Wrong network: expected ${this.cfg.network}, got ${network}` };
        }

        const { from, to, value, validAfter, validBefore, nonce, v, r, s } = payload;

        // Basic field checks
        if (!from || !to || !value || !nonce || !v || !r || !s) {
            return { ok: false, reason: 'Missing EIP-3009 payload fields' };
        }
        if (to.toLowerCase() !== this.cfg.feeRecipient.toLowerCase()) {
            return { ok: false, reason: `Payment must go to fee recipient ${this.cfg.feeRecipient}` };
        }
        if (BigInt(value) < BigInt(this.cfg.feeAmount)) {
            return { ok: false, reason: `Insufficient payment: need ${this.cfg.feeAmount}, got ${value}` };
        }
        const now = Math.floor(Date.now() / 1000);
        if (now < Number(validAfter))  return { ok: false, reason: 'Payment not yet valid' };
        if (now > Number(validBefore)) return { ok: false, reason: 'Payment authorization expired' };

        // Prevent replay
        if (this.usedNonces.has(nonce)) {
            return { ok: false, reason: 'Payment nonce already used (replay)' };
        }

        // Check on-chain nonce state (has authorization been used?)
        // Gracefully skip if token doesn't implement EIP-3009 (e.g. MockUSDC in dev)
        try {
            const alreadyUsed = await this.usdc.authorizationState(from, nonce);
            if (alreadyUsed) {
                return { ok: false, reason: 'EIP-3009 nonce already used on-chain' };
            }
        } catch {
            // Token doesn't implement authorizationState — fall through to sig-only verification
            console.log(`[x402] authorizationState not available (dev token) — verifying signature only`);
        }

        // Attempt on-chain settlement via transferWithAuthorization.
        // If the token doesn't support it (dev/mock USDC), fall back to sig verification.
        const signer = this._getSettlementSigner();
        if (signer) {
            try {
                const usdcWrite = this.usdc.connect(signer);
                const tx = await usdcWrite.transferWithAuthorization(
                    from, to, value, validAfter, validBefore, nonce, v, r, s
                );
                await tx.wait();
                console.log(`[x402] Payment settled on-chain: ${tx.hash}`);
            } catch (err) {
                // Token doesn't support transferWithAuthorization — verify signature only
                console.log(`[x402] On-chain settlement unavailable (${err.code}) — verifying signature`);
                const ok = this._verifyEip3009Sig({ from, to, value, validAfter, validBefore, nonce, v, r, s });
                if (!ok) return { ok: false, reason: 'EIP-3009 signature invalid' };
                console.log(`[x402] Signature verified (sig-only mode)`);
            }
        } else {
            // Dev mode: verify signature locally only
            const ok = this._verifyEip3009Sig({ from, to, value, validAfter, validBefore, nonce, v, r, s });
            if (!ok) return { ok: false, reason: 'EIP-3009 signature invalid' };
            console.log(`[x402] Payment verified (dev mode, no on-chain settlement)`);
        }

        this.usedNonces.add(nonce);
        return { ok: true };
    }

    _getSettlementSigner() {
        const pk = process.env.SERVER_PRIVATE_KEY;
        if (!pk) return null;
        return new ethers.Wallet(pk, this.provider);
    }

    _verifyEip3009Sig({ from, to, value, validAfter, validBefore, nonce, v, r, s }) {
        // Reconstruct EIP-712 typed data hash for EIP-3009 TransferWithAuthorization
        // Domain MUST match what we sent in the payment requirements (eip712Domain field)
        try {
            const domain = {
                name:              this.cfg.tokenName || 'USD Coin',
                version:           '1',
                chainId:           this.cfg.chainId,
                verifyingContract: this.cfg.usdcAddress,
            };
            const types = {
                TransferWithAuthorization: [
                    { name: 'from',        type: 'address' },
                    { name: 'to',          type: 'address' },
                    { name: 'value',       type: 'uint256' },
                    { name: 'validAfter',  type: 'uint256' },
                    { name: 'validBefore', type: 'uint256' },
                    { name: 'nonce',       type: 'bytes32' },
                ],
            };
            const message = { from, to, value: BigInt(value), validAfter: BigInt(validAfter), validBefore: BigInt(validBefore), nonce };
            const digest  = ethers.TypedDataEncoder.hash(domain, types, message);
            const sig     = ethers.Signature.from({ v, r, s });
            const recovered = ethers.recoverAddress(digest, sig);
            return recovered.toLowerCase() === from.toLowerCase();
        } catch {
            return false;
        }
    }

    // ── Credit assessment builder ──────────────────────────────────────────────

    _buildAssessment(agentAddress, repScore, creditLimit, collateral, interestRate) {
        const score = Number(repScore);
        const limit = Number(creditLimit) / 1e6; // USDC human-readable
        const rate  = Number(interestRate) / 100; // basis points → percent

        let tier, recommendation;
        if (score >= 800)      { tier = 'PRIME';      recommendation = 'Approve — excellent credit history'; }
        else if (score >= 600) { tier = 'STANDARD';   recommendation = 'Approve — good credit history'; }
        else if (score >= 400) { tier = 'SUBPRIME';   recommendation = 'Approve with collateral'; }
        else if (score >= 200) { tier = 'HIGH_RISK';  recommendation = 'Caution — limited history'; }
        else                   { tier = 'UNRATED';    recommendation = 'Deny or require full collateral'; }

        return {
            agentAddress,
            creditScore:         score,
            tier,
            recommendation,
            creditLimit:         `${limit.toLocaleString()} USDC`,
            creditLimitRaw:      creditLimit.toString(),
            interestRate:        `${rate.toFixed(2)}% APR`,
            interestRateBps:     interestRate.toString(),
            collateralRequired:  `${collateral.toString()}%`,
            loanTerms: {
                minDurationDays: 7,
                maxDurationDays: 365,
                autoApproveEligible: score >= 100 && limit <= 50000,
            },
            assessedAt:  new Date().toISOString(),
            protocol:    'Specular Protocol v3',
            dataSource:  'on-chain (ReputationManagerV3)',
        };
    }

    // ── Helpers ────────────────────────────────────────────────────────────────

    _json(res, status, body) {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.statusCode = status;
        res.end(JSON.stringify(body, null, 2));
    }

    // ── Lifecycle ──────────────────────────────────────────────────────────────

    start() {
        return new Promise((resolve) => {
            this.server.listen(this.cfg.port, this.cfg.host, () => {
                console.log(`\n[x402] Credit Assessment Server running`);
                console.log(`  URL:          http://${this.cfg.host}:${this.cfg.port}`);
                console.log(`  Fee:          ${Number(this.cfg.feeAmount) / 1e6} USDC per credit check`);
                console.log(`  Fee recipient: ${this.cfg.feeRecipient}`);
                console.log(`  Network:      ${this.cfg.network} (chainId ${this.cfg.chainId})\n`);
                resolve(this);
            });
        });
    }

    stop() {
        return new Promise((resolve, reject) => {
            this.server.close((err) => err ? reject(err) : resolve());
        });
    }
}

module.exports = CreditAssessmentServer;

// ── CLI entry point ────────────────────────────────────────────────────────────
if (require.main === module) {
    require('dotenv').config();
    const server = new CreditAssessmentServer({
        feeRecipient: process.env.FEE_RECIPIENT,
    });
    server.start().catch((err) => {
        console.error('[x402] Failed to start:', err.message);
        process.exit(1);
    });
}
