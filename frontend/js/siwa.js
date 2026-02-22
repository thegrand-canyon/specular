/**
 * Sign In With Agents (SIWA) — ERC-8128
 *
 * SIWA is the agent-native authentication standard, analogous to EIP-4361
 * (Sign In With Ethereum) but with agent identity claims embedded in the
 * signed message. The signer proves:
 *   1. Control of an Ethereum wallet address
 *   2. Ownership of a registered Specular agent identity (AgentRegistryV2)
 *   3. Intent to authenticate to this specific app, nonce, and timestamp
 *
 * This enables frontends to distinguish between:
 *   - Regular wallets (no agent registration)
 *   - Registered AI agents (with reputation, credit history, pool)
 *
 * Message format follows the ERC-8128 draft standard.
 */

import { ADDRESSES, ARC_TESTNET } from './config.js';

// ── ERC-8128 SIWA message generator ───────────────────────────────────────────

/**
 * Build a SIWA sign-in message (ERC-8128 format).
 * @param {string} address   - Wallet address
 * @param {string|number} agentId - Agent ID from AgentRegistryV2
 * @param {string} nonce     - Random nonce to prevent replay
 * @returns {string} Message to sign
 */
export function buildSiwaMessage({ address, agentId, nonce, domain, uri }) {
    const issuedAt = new Date().toISOString();
    const domainStr = domain || window.location.host || 'specular.protocol';
    const uriStr    = uri    || window.location.origin || 'http://localhost:3000';

    // ERC-8128 message format
    return [
        `${domainStr} wants you to sign in with your Ethereum account:`,
        address,
        '',
        `I am Agent #${agentId} registered on Specular Protocol.`,
        '',
        `URI: ${uriStr}`,
        `Version: 1`,
        `Chain ID: ${ARC_TESTNET.chainId}`,
        `Nonce: ${nonce}`,
        `Issued At: ${issuedAt}`,
        `Agent ID: ${agentId}`,
        `Registry: ${ADDRESSES.registry}`,
        `Protocol: Specular Protocol v3`,
    ].join('\n');
}

/**
 * Generate a cryptographically random nonce.
 */
export function generateNonce() {
    const arr = new Uint8Array(16);
    crypto.getRandomValues(arr);
    return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Parse a SIWA message back into its fields.
 */
export function parseSiwaMessage(message) {
    const lines = message.split('\n');
    const parsed = {};

    for (const line of lines) {
        const m = line.match(/^([^:]+):\s*(.+)$/);
        if (m) parsed[m[1].trim()] = m[2].trim();
    }

    return {
        domain:    lines[0]?.replace(' wants you to sign in with your Ethereum account:', '').trim(),
        address:   lines[1]?.trim(),
        statement: lines[3]?.trim(),
        uri:       parsed['URI'],
        version:   parsed['Version'],
        chainId:   parsed['Chain ID'] ? Number(parsed['Chain ID']) : null,
        nonce:     parsed['Nonce'],
        issuedAt:  parsed['Issued At'],
        agentId:   parsed['Agent ID'],
        registry:  parsed['Registry'],
    };
}

// ── SIWA session management ───────────────────────────────────────────────────

const SESSION_KEY = 'specular_siwa_session';

/**
 * Sign in with agents.
 * Returns session object with address, agentId, signature, message.
 */
export async function signInWithAgents({ signer, agentId, registry }) {
    const address = await signer.getAddress();
    const nonce   = generateNonce();

    const message = buildSiwaMessage({ address, agentId, nonce });
    const signature = await signer.signMessage(message);

    // Verify signature locally (recover address)
    const recovered = ethers.verifyMessage(message, signature);
    if (recovered.toLowerCase() !== address.toLowerCase()) {
        throw new Error('SIWA: Signature verification failed');
    }

    // Verify agent ownership on-chain
    const agentOnChain = await registry['addressToAgentId(address)'](address).catch(() =>
        registry.addressToAgentId(address)
    );
    if (agentOnChain.toString() !== agentId.toString()) {
        throw new Error(`SIWA: Address ${address.slice(0,8)}... does not own agent #${agentId}`);
    }

    const session = {
        address,
        agentId:   agentId.toString(),
        message,
        signature,
        nonce,
        issuedAt:  new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
    };

    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
}

/**
 * Load existing SIWA session (if not expired).
 */
export function loadSiwaSession() {
    try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (!raw) return null;
        const session = JSON.parse(raw);
        if (new Date(session.expiresAt) < new Date()) {
            sessionStorage.removeItem(SESSION_KEY);
            return null;
        }
        return session;
    } catch {
        return null;
    }
}

/**
 * Clear SIWA session (sign out).
 */
export function clearSiwaSession() {
    sessionStorage.removeItem(SESSION_KEY);
}

/**
 * Verify a SIWA session's signature + expiry (for server-side or re-checks).
 */
export function verifySiwaSession(session) {
    if (!session?.signature || !session?.message) return false;
    if (new Date(session.expiresAt) < new Date()) return false;
    try {
        const recovered = ethers.verifyMessage(session.message, session.signature);
        return recovered.toLowerCase() === session.address.toLowerCase();
    } catch {
        return false;
    }
}

// ── UI component ──────────────────────────────────────────────────────────────

/**
 * Render the SIWA sign-in card into a container element.
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {Function} opts.onSignIn  - Called with session after successful sign-in
 * @param {Function} opts.onSignOut - Called after sign-out
 */
export function renderSiwaCard(container, { onSignIn, onSignOut } = {}) {
    const existing = loadSiwaSession();

    if (existing) {
        container.innerHTML = siwaSignedInHtml(existing);
        container.querySelector('#siwaSignOut')?.addEventListener('click', () => {
            clearSiwaSession();
            renderSiwaCard(container, { onSignIn, onSignOut });
            onSignOut?.();
        });
        return existing;
    }

    container.innerHTML = siwaSignInHtml();

    container.querySelector('#siwaBtn')?.addEventListener('click', async () => {
        const btn       = container.querySelector('#siwaBtn');
        const statusEl  = container.querySelector('#siwaStatus');

        btn.disabled    = true;
        btn.textContent = 'Signing...';
        statusEl.textContent = '';
        statusEl.className   = 'siwa-status';

        try {
            // Need wallet + registry contract
            const { getSigner, getAccount } = await import('./wallet.js');
            const { getContracts }           = await import('./contracts.js');

            const signer   = getSigner();
            const account  = getAccount();
            if (!signer || !account) throw new Error('Connect your wallet first');

            const { registry } = getContracts();
            if (!registry) throw new Error('Contracts not loaded');

            // Look up agent ID for this address
            const agentId = await registry.addressToAgentId(account);
            if (!agentId || agentId.toString() === '0') {
                throw new Error('This wallet is not a registered Specular agent');
            }

            const session = await signInWithAgents({ signer, agentId, registry });
            renderSiwaCard(container, { onSignIn, onSignOut });
            onSignIn?.(session);

        } catch (err) {
            statusEl.textContent = err.message;
            statusEl.className   = 'siwa-status siwa-error';
            btn.disabled    = false;
            btn.textContent = 'Sign in with Agent';
        }
    });

    return null;
}

// ── HTML templates ─────────────────────────────────────────────────────────────

function siwaSignInHtml() {
    return `
        <div class="siwa-card">
            <div class="siwa-logo">🤖</div>
            <h3 class="siwa-title">Sign In With Agents</h3>
            <p class="siwa-desc">
                Prove your agent identity on-chain using ERC-8128.<br>
                Your wallet signs a message verifying your AgentRegistry registration.
            </p>
            <button class="btn btn-primary siwa-btn" id="siwaBtn">
                Sign in with Agent
            </button>
            <p class="siwa-status" id="siwaStatus"></p>
            <p class="siwa-footnote">
                Secured by <a href="https://eips.ethereum.org/EIPS/eip-4361" target="_blank" rel="noopener">ERC-8128</a>
                · No password · Wallet-native
            </p>
        </div>
    `;
}

function siwaSignedInHtml(session) {
    const shortAddr = a => `${a.slice(0,6)}...${a.slice(-4)}`;
    const issuedDate = new Date(session.issuedAt).toLocaleString();
    const valid = verifySiwaSession(session);

    return `
        <div class="siwa-card siwa-signed-in">
            <div class="siwa-logo">✅</div>
            <h3 class="siwa-title">Signed In</h3>
            <div class="siwa-identity">
                <div class="siwa-field">
                    <span class="siwa-label">Agent ID</span>
                    <span class="siwa-value siwa-highlight">#${session.agentId}</span>
                </div>
                <div class="siwa-field">
                    <span class="siwa-label">Wallet</span>
                    <span class="siwa-value siwa-mono">${shortAddr(session.address)}</span>
                </div>
                <div class="siwa-field">
                    <span class="siwa-label">Authenticated</span>
                    <span class="siwa-value">${issuedDate}</span>
                </div>
                <div class="siwa-field">
                    <span class="siwa-label">Signature</span>
                    <span class="siwa-value ${valid ? 'siwa-ok' : 'siwa-err'}">
                        ${valid ? 'Valid ✓' : 'Invalid ✗'}
                    </span>
                </div>
            </div>
            <details class="siwa-details">
                <summary>View signed message</summary>
                <pre class="siwa-message">${escapeHtml(session.message)}</pre>
            </details>
            <button class="btn btn-secondary siwa-btn-sm" id="siwaSignOut">Sign Out</button>
        </div>
    `;
}

function escapeHtml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
