/**
 * Identity Page
 *
 * Showcases the full "Onchain Agentic Economy Stack" for Specular:
 *   - ERC-8004: Agent identity & reputation (already integrated everywhere)
 *   - x402: Payment-gated credit assessment API
 *   - XMTP: Decentralized wallet-to-wallet messaging
 *   - ERC-8128/SIWA: Sign In With Agents authentication
 */

import { renderSiwaCard, loadSiwaSession } from '../siwa.js';
import { showToast } from '../utils.js';
import { getAccount, getSigner, isConnected } from '../wallet.js';
import { ADDRESSES } from '../config.js';

export async function renderIdentity() {
    const app = document.getElementById('app');
    app.innerHTML = `
        <div class="page-header">
            <div>
                <h1>Agent Identity Stack</h1>
                <p class="subtitle">Specular implements the full onchain agentic economy stack</p>
            </div>
        </div>

        <!-- Stack overview cards -->
        <div class="cards-grid" style="margin-bottom:2rem">
            ${stackCard('ERC-8004', 'badge-erc8004', '🆔',
                'Agent Identity & Reputation',
                'Agents register on-chain via AgentRegistryV2. Reputation scores (0–1000) govern credit limits, interest rates, and collateral requirements. ValidationRegistry enables peer validation bonuses.',
                'Active', true
            )}
            ${stackCard('x402', 'badge-x402', '💳',
                'HTTP Payment Protocol',
                'APIs return HTTP 402 with EIP-3009 payment requirements. Agent bots auto-pay micro-fees (1 USDC) and retry — enabling machine-native paid APIs without subscriptions or API keys.',
                'Active', true
            )}
            ${stackCard('XMTP', 'badge-xmtp', '✉️',
                'Decentralized Messaging',
                'Loan lifecycle events trigger E2E encrypted wallet-to-wallet messages via XMTP. Agents send borrow/repay/tier-promotion notifications — lenders receive instant wallet-native alerts with no email required.',
                'Active', true
            )}
            ${stackCard('ERC-8128', 'badge-siwa', '🔏',
                'Sign In With Agents',
                'Agents authenticate with a signed message proving wallet control + AgentRegistry membership. No passwords — the signed SIWA message is the credential.',
                'Active', true
            )}
        </div>

        <!-- SIWA sign-in panel -->
        <div class="section">
            <h2 class="section-title">Sign In With Agents (ERC-8128)</h2>
            <div class="two-col">
                <div id="siwaContainer"></div>
                <div class="siwa-info">
                    <h3>How it works</h3>
                    <ol class="siwa-steps">
                        <li>Connect your wallet (MetaMask)</li>
                        <li>Click "Sign in with Agent"</li>
                        <li>Sign the ERC-8128 message — proves you own this wallet</li>
                        <li>AgentRegistryV2 is checked to confirm you're a registered agent</li>
                        <li>Session stored in browser — valid 24 hours</li>
                    </ol>
                    <div class="info-box" style="margin-top:1rem">
                        <p class="hint">The signed message contains your agent ID, nonce, chain ID, and timestamp — preventing replay attacks and cross-site session theft.</p>
                    </div>
                    <div id="siwaSessionInfo" style="margin-top:1rem"></div>
                </div>
            </div>
        </div>

        <!-- x402 credit check demo — live interactive -->
        <div class="section">
            <h2 class="section-title">x402 Credit Check API</h2>
            <div class="two-col">
                <div>
                    <p class="hint" style="margin-bottom:1rem;line-height:1.6">
                        The Specular Credit Assessment API uses HTTP 402 to require payment before
                        returning credit data. Enter any agent address and click
                        <strong>Check Credit</strong> — your wallet signs a 1 USDC EIP-3009
                        authorization and the API returns a full credit report.
                    </p>
                    <div class="form-group">
                        <label>Agent Address</label>
                        <div class="input-with-badge">
                            <input class="form-input" id="creditAddr" placeholder="0x..." />
                            <button class="btn btn-sm" id="creditUseOwn" title="Use my address">Me</button>
                        </div>
                        <p class="balance-hint">API endpoint: <code>GET /credit/:address</code> — requires 1 USDC via X-PAYMENT</p>
                    </div>
                    <button class="btn btn-primary" id="creditCheckBtn" style="width:100%">
                        Check Credit (1 USDC)
                    </button>
                    <div id="creditStatus" style="margin-top:0.75rem;font-size:0.85rem;color:var(--muted);min-height:1.2rem"></div>
                </div>

                <div id="creditResult">
                    <div class="card" style="background:var(--surface2)">
                        <h3 style="margin-bottom:0.75rem">Credit Report</h3>
                        <p class="muted hint">Run a credit check to see results here.</p>
                    </div>
                </div>
            </div>

            <div style="margin-top:1.25rem;display:flex;gap:1rem;align-items:center;flex-wrap:wrap">
                <div class="stat-pill">
                    <span class="stat-label">Fee</span>
                    <span class="stat-value">1 USDC</span>
                </div>
                <div class="stat-pill">
                    <span class="stat-label">Scheme</span>
                    <span class="stat-value">EIP-3009</span>
                </div>
                <div class="stat-pill">
                    <span class="stat-label">Status</span>
                    <span class="stat-value text-green">Live</span>
                </div>
            </div>
        </div>

        <!-- XMTP notification demo -->
        <div class="section">
            <h2 class="section-title">XMTP Loan Notifications</h2>
            <div class="info-box">
                <p>On every loan lifecycle event, the LoanNotificationService sends wallet-to-wallet encrypted messages
                via XMTP. No email, no push notifications — just wallet-native, censorship-resistant communication.</p>
            </div>
            <div class="xmtp-flow" style="margin-top:1rem">
                ${xmtpFlowStep('Loan Requested', '→ All pool lenders notified via XMTP', '1')}
                ${xmtpFlowStep('Loan Approved', '→ Borrower receives approval + terms', '2')}
                ${xmtpFlowStep('Due Soon (cron)', '→ Borrower gets 3-day reminder', '3')}
                ${xmtpFlowStep('Loan Repaid', '→ Lenders notified, interest credited', '4')}
                ${xmtpFlowStep('Default', '→ All parties notified, reputation penalized', '5')}
            </div>
            <p class="hint" style="margin-top:0.75rem">
                Integrated into <code>AutonomousAgent</code> and <code>LenderAgent</code> via <code>AgentMessenger</code>.
                Enable live messaging: <code>npm install @xmtp/xmtp-js</code> — agents auto-detect and activate.
            </p>
        </div>
    `;

    // Mount SIWA card
    const siwaContainer = document.getElementById('siwaContainer');
    renderSiwaCard(siwaContainer, {
        onSignIn: (session) => {
            showToast(`Signed in as Agent #${session.agentId}`);
            updateSessionInfo(session);
        },
        onSignOut: () => {
            showToast('Signed out');
            document.getElementById('siwaSessionInfo').innerHTML = '';
        },
    });

    // Show existing session info
    const session = loadSiwaSession();
    if (session) updateSessionInfo(session);

    // ── x402 credit check wiring ─────────────────────────────────────────────

    // "Me" button — fill in connected wallet address
    document.getElementById('creditUseOwn')?.addEventListener('click', () => {
        const addr = getAccount();
        if (!addr) { showToast('Connect your wallet first', true); return; }
        document.getElementById('creditAddr').value = addr;
    });

    // Pre-fill if wallet already connected
    const myAddr = getAccount();
    if (myAddr) document.getElementById('creditAddr').value = myAddr;

    document.getElementById('creditCheckBtn')?.addEventListener('click', runCreditCheck);
}

// ── x402 credit check implementation ─────────────────────────────────────────

const API_URL = 'http://localhost:3001';

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

async function runCreditCheck() {
    const address = document.getElementById('creditAddr')?.value?.trim();
    if (!address || !ethers.isAddress(address)) {
        showToast('Enter a valid Ethereum address', true);
        return;
    }

    const signer = getSigner();
    if (!signer) {
        showToast('Connect your wallet first — MetaMask signs the 1 USDC authorization', true);
        return;
    }

    const btn    = document.getElementById('creditCheckBtn');
    const status = document.getElementById('creditStatus');
    const result = document.getElementById('creditResult');

    btn.disabled = true;
    btn.textContent = 'Requesting…';
    status.textContent = 'Step 1/3 — Requesting credit report…';
    result.innerHTML = `<div class="loading-state" style="padding:1.5rem"><div class="spinner"></div><p>Contacting credit API…</p></div>`;

    try {
        // Step 1: Initial request — expect 402
        const resp1 = await fetch(`${API_URL}/credit/${address}`, {
            headers: { 'Accept': 'application/json' },
            signal: AbortSignal.timeout(10000),
        });

        if (resp1.ok) {
            // Already returned 200 (shouldn't happen on first call, but handle it)
            const data = await resp1.json();
            renderCreditReport(data, result);
            status.textContent = 'Credit report loaded (no payment required).';
            return;
        }

        if (resp1.status !== 402) {
            const body = await resp1.json().catch(() => ({}));
            throw new Error(body.error || `Unexpected HTTP ${resp1.status}`);
        }

        const body1 = await resp1.json();
        const requirements = body1?.accepts?.[0];
        if (!requirements) throw new Error('402 response missing payment requirements');

        const feeUsdc = (Number(requirements.maxAmountRequired) / 1e6).toFixed(2);
        status.textContent = `Step 2/3 — Signing ${feeUsdc} USDC EIP-3009 authorization in MetaMask…`;

        // Step 2: Build and sign EIP-3009 typed data
        const paymentHeader = await buildPaymentHeader(signer, requirements);

        status.textContent = 'Step 3/3 — Sending payment and retrieving credit report…';

        // Step 3: Retry with X-PAYMENT header
        const resp2 = await fetch(`${API_URL}/credit/${address}`, {
            headers: { 'Accept': 'application/json', 'X-PAYMENT': paymentHeader },
            signal: AbortSignal.timeout(15000),
        });

        if (!resp2.ok) {
            const body2 = await resp2.json().catch(() => ({}));
            throw new Error(body2.error || `Payment rejected (HTTP ${resp2.status})`);
        }

        const report = await resp2.json();
        renderCreditReport(report, result);
        status.textContent = `Credit report loaded. 1 USDC paid via EIP-3009.`;
        showToast('Credit report fetched via x402');

    } catch (err) {
        const msg = err.name === 'AbortError' ? 'API timeout — is the server running?' : err.message;
        status.textContent = `Error: ${msg}`;
        result.innerHTML = `<div class="error-state">x402 failed: ${msg}</div>`;
        showToast('Credit check failed: ' + msg.slice(0, 60), true);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Check Credit (1 USDC)';
    }
}

async function buildPaymentHeader(signer, requirements) {
    const { maxAmountRequired, payTo, asset, extra = {} } = requirements;

    const from        = await signer.getAddress();
    const to          = payTo;
    const value       = BigInt(maxAmountRequired);
    const validAfter  = BigInt(extra.validAfter  ?? Math.floor(Date.now() / 1000) - 60);
    const validBefore = BigInt(extra.validBefore ?? Math.floor(Date.now() / 1000) + 300);
    const nonce       = ethers.hexlify(ethers.randomBytes(32));

    const domain = extra.eip712Domain ?? {
        name:              extra.tokenName ?? 'USD Coin',
        version:           '1',
        chainId:           extra.chainId ?? 5042002,
        verifyingContract: asset,
    };

    const sig = await signer.signTypedData(domain, EIP3009_TYPES, {
        from, to, value, validAfter, validBefore, nonce,
    });
    const { v, r, s } = ethers.Signature.from(sig);

    const payload = {
        x402Version: 1,
        scheme:      'eip3009',
        network:     requirements.network,
        payload: {
            from, to,
            value:       value.toString(),
            validAfter:  validAfter.toString(),
            validBefore: validBefore.toString(),
            nonce, v, r, s,
        },
    };

    return btoa(JSON.stringify(payload));
}

function renderCreditReport(report, container) {
    const tierCss = {
        PRIME:     'tier-excellent',
        STANDARD:  'tier-good',
        SUBPRIME:  'tier-average',
        HIGH_RISK: 'tier-below',
        UNRATED:   'tier-risk',
    }[report.tier] ?? 'tier-risk';

    container.innerHTML = `
        <div class="card highlight-card">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                <h3 style="margin:0">Credit Report</h3>
                <span class="badge ${tierCss}">${report.tier}</span>
            </div>
            <div class="info-row"><span>Address</span><span class="monospace">${shortAddr(report.agentAddress)}</span></div>
            <div class="info-row"><span>Credit Score</span><span style="font-weight:700;font-size:1.1rem">${report.creditScore}</span></div>
            <div class="info-row"><span>Credit Limit</span><span class="text-green">${report.creditLimit}</span></div>
            <div class="info-row"><span>Interest Rate</span><span>${report.interestRate}</span></div>
            <div class="info-row"><span>Collateral</span><span>${report.collateralRequired}</span></div>
            <div class="info-row"><span>Recommendation</span><span class="text-accent">${report.recommendation}</span></div>
            <div class="info-row" style="border-top:1px solid var(--border);margin-top:0.5rem;padding-top:0.5rem">
                <span class="hint">Assessed</span>
                <span class="hint">${new Date(report.assessedAt).toLocaleTimeString()}</span>
            </div>
        </div>
    `;
}

function shortAddr(addr) {
    if (!addr) return '';
    return addr.slice(0, 8) + '…' + addr.slice(-6);
}

function updateSessionInfo(session) {
    const el = document.getElementById('siwaSessionInfo');
    if (!el) return;
    el.innerHTML = `
        <div class="info-box">
            <p class="hint">
                Active SIWA session: Agent #${session.agentId}<br>
                Nonce: <code>${session.nonce}</code><br>
                Expires: ${new Date(session.expiresAt).toLocaleString()}
            </p>
        </div>
    `;
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function stackCard(label, badgeClass, icon, title, desc, status, live) {
    return `
        <div class="card">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:0.75rem">
                <span class="stack-badge ${badgeClass}">${label}</span>
                <span class="hint" style="color:${live ? 'var(--green)' : 'var(--accent-alt)'}">${status} ${live ? '●' : '○'}</span>
            </div>
            <div style="font-size:1.75rem;margin-bottom:0.5rem">${icon}</div>
            <h3 style="font-size:1rem;margin-bottom:0.5rem">${title}</h3>
            <p class="hint" style="line-height:1.5">${desc}</p>
        </div>
    `;
}

function xmtpFlowStep(event, action, num) {
    return `
        <div style="display:flex;gap:1rem;align-items:flex-start;padding:0.6rem 0;border-bottom:1px solid var(--border)">
            <span style="background:var(--accent);color:#000;width:1.5rem;height:1.5rem;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:0.75rem;font-weight:700;flex-shrink:0">${num}</span>
            <div>
                <span style="font-weight:600">${event}</span>
                <span class="muted" style="margin-left:0.5rem;font-size:0.85rem">${action}</span>
            </div>
        </div>
    `;
}
