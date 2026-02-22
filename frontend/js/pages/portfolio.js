/**
 * My Portfolio
 *
 * Four-section personal dashboard for the connected wallet:
 *
 *   1. Agent Identity   — registration status, reputation score, tier, credit limit
 *   2. Borrower Loans   — active / recent loans drawn from this wallet
 *   3. My Pool          — pool stats if this wallet is a registered agent
 *   4. Lender Positions — liquidity positions across all pools (claim / withdraw)
 *
 * Data sources:
 *   - API  (/agents/:address, /pools/:id)   — rich enrichment, tier names, credit info
 *   - Contracts (marketplace, registry)     — on-chain positions, loan history
 */

import { marketplace, registry, usdc } from '../contracts.js';
import { formatUSDC, parseUSDC, agentName, showToast, setLoading,
         loanStateLabel, loanStateCss, formatDate, shortAddr } from '../utils.js';
import { getAccount, isConnected } from '../wallet.js';
import { api } from '../api.js';

// ── Entry point ────────────────────────────────────────────────────────────────

export async function renderPortfolio() {
    const app = document.getElementById('app');
    app.innerHTML = `
        <div class="page-header">
            <div>
                <h1>My Portfolio</h1>
                <p class="subtitle">Agent identity, loans, pool, and liquidity positions</p>
            </div>
            <button class="btn btn-sm" id="refreshBtn">↻ Refresh</button>
        </div>
        <div id="portfolio-content">
            <div class="loading-state"><div class="spinner"></div><p>Loading portfolio…</p></div>
        </div>
    `;

    if (!isConnected()) {
        document.getElementById('portfolio-content').innerHTML = `
            <div class="card">
                <div class="empty-state">
                    <div class="empty-icon">🔌</div>
                    <h3>Wallet Required</h3>
                    <p>Connect your wallet to view your portfolio.</p>
                    <button class="btn btn-primary"
                        onclick="document.getElementById('connectWallet').click()">
                        Connect Wallet
                    </button>
                </div>
            </div>
        `;
        return;
    }

    document.getElementById('refreshBtn')?.addEventListener('click', loadPortfolio);
    await loadPortfolio();
}

// ── Data loading ───────────────────────────────────────────────────────────────

async function loadPortfolio() {
    const content = document.getElementById('portfolio-content');
    if (!content) return;
    content.innerHTML = `<div class="loading-state"><div class="spinner"></div><p>Loading…</p></div>`;

    const account = getAccount();
    const alm     = marketplace();
    const reg     = registry();

    try {
        // ── Parallel data fetch ──────────────────────────────────────────────
        const [
            usdcBalance,
            apiProfile,
            lenderPositions,
            borrowerLoans,
        ] = await Promise.all([
            usdc().balanceOf(account).catch(() => 0n),
            api.getAgentProfile(account).catch(() => null),
            fetchLenderPositions(alm, reg, account),
            fetchBorrowerLoans(alm, account),
        ]);

        // ── My pool (only if registered agent) ──────────────────────────────
        let ownPool = null;
        if (apiProfile?.registered && apiProfile.agentId) {
            ownPool = await alm.getAgentPool(apiProfile.agentId).catch(() => null);
        }

        // ── Lender summary totals ────────────────────────────────────────────
        let totalSupplied = 0n;
        let totalEarned   = 0n;
        for (const r of lenderPositions) {
            totalSupplied += BigInt(r.pos[0]);
            totalEarned   += BigInt(r.pos[1]);
        }

        // ── Render ───────────────────────────────────────────────────────────
        content.innerHTML = `
            ${renderAgentIdentity(apiProfile, account)}
            ${renderBorrowerLoans(borrowerLoans)}
            ${ownPool ? renderOwnPool(ownPool, apiProfile.agentId) : ''}
            ${renderLenderSummary(totalSupplied, totalEarned, usdcBalance, lenderPositions.length)}
            ${renderLenderPositions(lenderPositions)}
            <div id="withdrawSection"></div>
        `;

        wireButtons(lenderPositions);

    } catch (err) {
        content.innerHTML = `<div class="error-state">Error loading portfolio: ${err.message}</div>`;
    }
}

// ── Data helpers ───────────────────────────────────────────────────────────────

async function fetchLenderPositions(alm, reg, account) {
    let totalPools = 0;
    try { totalPools = Number(await alm.totalPools()); } catch {}

    const agentIds = [];
    for (let i = 0; i < totalPools; i++) {
        try { agentIds.push(BigInt(await alm.agentPoolIds(i))); } catch {}
    }

    const results = await Promise.all(agentIds.map(async agentId => {
        try {
            const [pos, poolData, agentInfo] = await Promise.all([
                alm.getLenderPosition(agentId, account),
                alm.getAgentPool(agentId).catch(() => null),
                reg.getAgentInfoById(agentId).catch(() => null),
            ]);
            if (!pos || BigInt(pos[0]) === 0n) return null;
            return { agentId, pos, poolData, agentInfo };
        } catch { return null; }
    }));

    return results.filter(Boolean);
}

async function fetchBorrowerLoans(alm, account) {
    const loans = [];
    // Walk agentLoans[account][0..N] until revert
    for (let i = 0; i < 50; i++) {
        try {
            const loanId = await alm.agentLoans(account, i);
            if (!loanId || loanId === 0n) break;
            const loan = await alm.loans(loanId);
            loans.push({ loanId: Number(loanId), loan });
        } catch { break; }
    }
    return loans;
}

// ── Section renderers ──────────────────────────────────────────────────────────

function renderAgentIdentity(profile, account) {
    if (!profile) {
        return `
            <div class="card" style="margin-bottom:1rem">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                    <h2 class="section-title" style="margin:0">Agent Identity</h2>
                </div>
                <div class="info-row"><span>Address</span><span class="monospace">${shortAddr(account)}</span></div>
                <div class="info-box" style="margin-top:0.75rem">
                    <p class="hint">API server offline — showing on-chain data only.</p>
                </div>
            </div>
        `;
    }

    if (!profile.registered) {
        return `
            <div class="card" style="margin-bottom:1rem">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                    <h2 class="section-title" style="margin:0">Agent Identity</h2>
                    <a href="#borrow" class="btn btn-primary btn-sm">Register Agent</a>
                </div>
                <div class="info-row"><span>Address</span><span class="monospace">${shortAddr(account)}</span></div>
                <div class="info-row"><span>Status</span><span class="badge tier-risk">Unregistered</span></div>
                <p class="hint" style="margin-top:0.75rem">Register to access loans, build reputation, and create a lending pool.</p>
            </div>
        `;
    }

    const rep        = profile.reputation ?? {};
    const tierCss    = tierBadgeCss(rep.tier);
    const score      = rep.score ?? 0;
    const maxScore   = 1000;
    const scorePct   = Math.min(100, Math.round((score / maxScore) * 100));
    const scoreColor = score >= 800 ? 'var(--green)' : score >= 600 ? 'var(--blue)'
                     : score >= 400 ? 'var(--accent-alt)' : score >= 200 ? 'var(--yellow)' : 'var(--red)';

    return `
        <div class="card" style="margin-bottom:1rem">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem">
                <h2 class="section-title" style="margin:0">Agent Identity</h2>
                <span class="badge ${tierCss}" style="font-size:0.85rem;padding:0.2rem 0.7rem">${rep.tier ?? '—'}</span>
            </div>

            <div class="portfolio-identity-grid">
                <!-- Score ring -->
                <div class="score-ring-wrap">
                    <svg class="score-ring" viewBox="0 0 80 80">
                        <circle cx="40" cy="40" r="34" fill="none" stroke="var(--border)" stroke-width="7"/>
                        <circle cx="40" cy="40" r="34" fill="none"
                            stroke="${scoreColor}" stroke-width="7"
                            stroke-linecap="round"
                            stroke-dasharray="${Math.round(2 * Math.PI * 34 * scorePct / 100)} 214"
                            transform="rotate(-90 40 40)"/>
                    </svg>
                    <div class="score-ring-label">
                        <span class="score-ring-value" style="color:${scoreColor}">${score}</span>
                        <span class="score-ring-sub">/ 1000</span>
                    </div>
                </div>

                <!-- Identity details -->
                <div>
                    <div class="info-row"><span>Address</span><span class="monospace">${shortAddr(account)}</span></div>
                    <div class="info-row"><span>Agent ID</span><span>#${profile.agentId}</span></div>
                    <div class="info-row"><span>Reputation Score</span><span style="font-weight:700;color:${scoreColor}">${score}</span></div>
                    <div class="info-row"><span>Credit Limit</span><span class="text-green">${rep.creditLimitUsdc != null ? rep.creditLimitUsdc.toLocaleString() + ' USDC' : '—'}</span></div>
                    <div class="info-row"><span>Interest Rate</span><span>${rep.interestRatePct != null ? rep.interestRatePct + '% APR' : '—'}</span></div>
                    <div class="info-row"><span>Collateral Required</span><span>${rep.collateralRequiredPct != null ? rep.collateralRequiredPct + '%' : '—'}</span></div>
                </div>
            </div>

            <div style="display:flex;gap:0.75rem;margin-top:1rem;flex-wrap:wrap">
                <a href="#borrow" class="btn btn-primary btn-sm">Request Loan</a>
                <a href="#supply" class="btn btn-sm">Supply Liquidity</a>
                <a href="#identity" class="btn btn-sm">SIWA / x402</a>
            </div>
        </div>
    `;
}

function renderBorrowerLoans(loans) {
    if (loans.length === 0) {
        return `
            <div class="card section" style="margin-bottom:1rem">
                <h2 class="section-title">My Loans</h2>
                <div class="empty-state" style="padding:1.5rem 0">
                    <div class="empty-icon">📋</div>
                    <p class="hint">No loans found for this wallet.</p>
                    <a href="#borrow" class="btn btn-primary btn-sm">Request a Loan</a>
                </div>
            </div>
        `;
    }

    // Sort: active first, then by loanId desc
    const sorted = [...loans].sort((a, b) => {
        const aActive = Number(a.loan.state) === 1;
        const bActive = Number(b.loan.state) === 1;
        if (aActive && !bActive) return -1;
        if (!aActive && bActive) return 1;
        return b.loanId - a.loanId;
    });

    return `
        <div class="card section" style="margin-bottom:1rem">
            <h2 class="section-title">My Loans</h2>
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Loan #</th>
                            <th>Pool</th>
                            <th>Amount</th>
                            <th>Rate</th>
                            <th>Due</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${sorted.map(({ loanId, loan }) => {
                            const state     = Number(loan.state);
                            const label     = loanStateLabel(state);
                            const css       = loanStateCss(state);
                            const amount    = formatUSDC(loan.amount);
                            const ratePct   = (Number(loan.interestRate) / 100).toFixed(2);
                            const dueDate   = loan.endTime && BigInt(loan.endTime) > 0n
                                ? formatDate(loan.endTime) : '—';
                            const dueSoon   = state === 1 && loan.endTime
                                && (Number(loan.endTime) * 1000 - Date.now()) < 3 * 86400 * 1000;

                            return `
                                <tr class="${state === 1 ? 'row-active-loan' : ''}">
                                    <td><strong>#${loanId}</strong></td>
                                    <td><a href="#pool/${loan.agentId}" class="pool-link">Pool #${loan.agentId}</a></td>
                                    <td>${amount} USDC</td>
                                    <td>${ratePct}% APR</td>
                                    <td style="${dueSoon ? 'color:var(--yellow)' : ''}">${dueDate}${dueSoon ? ' ⚠' : ''}</td>
                                    <td>
                                        <span class="badge ${css}">${label}</span>
                                        ${state === 1 ? `<button class="btn btn-sm btn-primary repay-btn" style="margin-left:0.5rem" data-loanid="${loanId}">Repay</button>` : ''}
                                    </td>
                                </tr>
                            `;
                        }).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function renderOwnPool(pool, agentId) {
    const total     = formatUSDC(pool.totalLiquidity ?? pool[1] ?? 0n);
    const available = formatUSDC(pool.availableLiquidity ?? pool[2] ?? 0n);
    const loaned    = formatUSDC(pool.totalLoaned ?? pool[3] ?? 0n);
    const earned    = formatUSDC(pool.totalEarned ?? pool[4] ?? 0n);
    const util      = pool.utilizationRate ?? pool[5] ?? 0n;
    const utilPct   = (Number(util) / 100).toFixed(1);
    const lenders   = Number(pool.lenderCount ?? pool[6] ?? 0n);

    return `
        <div class="card section" style="margin-bottom:1rem">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem">
                <h2 class="section-title" style="margin:0">My Pool <span class="muted" style="font-size:0.85rem;font-weight:400">#${agentId}</span></h2>
                <a href="#pool/${agentId}" class="btn btn-sm">View Details →</a>
            </div>
            <div class="cards-grid" style="grid-template-columns:repeat(auto-fit,minmax(140px,1fr))">
                <div class="card stat-card" style="margin:0">
                    <div class="stat-label">Total Liquidity</div>
                    <div class="stat-value">${total}</div>
                    <div class="stat-unit">USDC</div>
                </div>
                <div class="card stat-card" style="margin:0">
                    <div class="stat-label">Available</div>
                    <div class="stat-value text-green">${available}</div>
                    <div class="stat-unit">USDC</div>
                </div>
                <div class="card stat-card" style="margin:0">
                    <div class="stat-label">Total Loaned</div>
                    <div class="stat-value">${loaned}</div>
                    <div class="stat-unit">USDC</div>
                </div>
                <div class="card stat-card" style="margin:0">
                    <div class="stat-label">Interest Earned</div>
                    <div class="stat-value text-green">${earned}</div>
                    <div class="stat-unit">USDC</div>
                </div>
                <div class="card stat-card" style="margin:0">
                    <div class="stat-label">Utilization</div>
                    <div class="stat-value">${utilPct}%</div>
                    <div class="stat-unit">&nbsp;</div>
                </div>
                <div class="card stat-card" style="margin:0">
                    <div class="stat-label">Lenders</div>
                    <div class="stat-value">${lenders}</div>
                    <div class="stat-unit">&nbsp;</div>
                </div>
            </div>
        </div>
    `;
}

function renderLenderSummary(totalSupplied, totalEarned, usdcBalance, posCount) {
    return `
        <div class="cards-grid" style="margin-bottom:1rem">
            <div class="card stat-card">
                <div class="stat-label">Total Supplied</div>
                <div class="stat-value">${formatUSDC(totalSupplied)}</div>
                <div class="stat-unit">USDC</div>
            </div>
            <div class="card stat-card">
                <div class="stat-label">Total Earned</div>
                <div class="stat-value text-green">${formatUSDC(totalEarned)}</div>
                <div class="stat-unit">USDC</div>
            </div>
            <div class="card stat-card">
                <div class="stat-label">Active Positions</div>
                <div class="stat-value">${posCount}</div>
                <div class="stat-unit">&nbsp;</div>
            </div>
            <div class="card stat-card">
                <div class="stat-label">USDC Balance</div>
                <div class="stat-value">${formatUSDC(usdcBalance)}</div>
                <div class="stat-unit">in wallet</div>
            </div>
        </div>
    `;
}

function renderLenderPositions(results) {
    if (results.length === 0) {
        return `
            <div class="card section">
                <h2 class="section-title">Lender Positions</h2>
                <div class="empty-state" style="padding:1.5rem 0">
                    <div class="empty-icon">💰</div>
                    <p class="hint">No liquidity positions yet.</p>
                    <a href="#leaderboard" class="btn btn-primary btn-sm">Browse Pools</a>
                </div>
            </div>
        `;
    }

    return `
        <div class="card section">
            <h2 class="section-title">Lender Positions</h2>
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Pool</th>
                            <th>Supplied</th>
                            <th>Earned</th>
                            <th>Share</th>
                            <th>Since</th>
                            <th>Actions</th>
                        </tr>
                    </thead>
                    <tbody id="positionsBody">
                        ${results.map(r => renderPositionRow(r)).join('')}
                    </tbody>
                </table>
            </div>
        </div>
    `;
}

function renderPositionRow(r) {
    const [amount, earnedInterest, depositTimestamp, shareOfPool] = r.pos;
    const name      = agentName(r.agentInfo, r.agentId);
    const sharePct  = Number(shareOfPool) > 0 ? (Number(shareOfPool) / 100).toFixed(1) + '%' : '—';
    const since     = depositTimestamp && BigInt(depositTimestamp) > 0n
        ? new Date(Number(depositTimestamp) * 1000).toLocaleDateString() : '—';

    return `
        <tr>
            <td>
                <a href="#pool/${r.agentId}" class="pool-link">${name}</a>
                <span class="agent-id-small muted"> #${r.agentId}</span>
            </td>
            <td>${formatUSDC(amount)} USDC</td>
            <td class="text-green">${formatUSDC(earnedInterest)} USDC</td>
            <td>${sharePct}</td>
            <td>${since}</td>
            <td class="actions-cell">
                ${Number(earnedInterest) > 0
                    ? `<button class="btn btn-sm btn-success claim-pos-btn" data-agentid="${r.agentId}">Claim</button>`
                    : ''}
                <button class="btn btn-sm btn-outline withdraw-pos-btn"
                    data-agentid="${r.agentId}"
                    data-amount="${amount}">Withdraw</button>
            </td>
        </tr>
    `;
}

// ── Button wiring ──────────────────────────────────────────────────────────────

function wireButtons(lenderPositions) {
    // Claim interest
    document.querySelectorAll('.claim-pos-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const agentId = BigInt(btn.dataset.agentid);
            setLoading(btn, true);
            try {
                const tx = await marketplace(true).claimInterest(agentId);
                await tx.wait();
                showToast('Interest claimed!');
                await loadPortfolio();
            } catch (err) {
                showToast('Claim failed: ' + (err.reason || err.message), true);
                setLoading(btn, false);
            }
        });
    });

    // Withdraw liquidity
    document.querySelectorAll('.withdraw-pos-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            showWithdrawSection(BigInt(btn.dataset.agentid), BigInt(btn.dataset.amount));
        });
    });

    // Repay loan
    document.querySelectorAll('.repay-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const loanId = Number(btn.dataset.loanid);
            setLoading(btn, true);
            try {
                const tx = await marketplace(true).repayLoan(loanId);
                await tx.wait();
                showToast(`Loan #${loanId} repaid!`);
                await loadPortfolio();
            } catch (err) {
                showToast('Repay failed: ' + (err.reason || err.message), true);
                setLoading(btn, false);
            }
        });
    });
}

// ── Withdraw form ──────────────────────────────────────────────────────────────

function showWithdrawSection(agentId, maxAmount) {
    const sec = document.getElementById('withdrawSection');
    if (!sec) return;

    sec.innerHTML = `
        <div class="card form-card" style="margin-top:1rem">
            <h3>Withdraw from Pool #${agentId}</h3>
            <div class="form-group">
                <label>Amount to Withdraw (USDC)</label>
                <div class="input-with-badge">
                    <input type="number" id="withdrawAmount" class="form-input"
                        placeholder="0.00" max="${Number(maxAmount) / 1e6}" min="0.01" step="0.01">
                    <button class="btn btn-sm btn-outline" id="withdrawMaxBtn">MAX</button>
                </div>
                <div class="balance-hint">Max: ${formatUSDC(maxAmount)} USDC</div>
            </div>
            <div class="form-row" style="display:flex;gap:0.75rem">
                <button class="btn btn-primary" id="withdrawConfirmBtn">Confirm Withdraw</button>
                <button class="btn btn-outline" id="withdrawCancelBtn">Cancel</button>
            </div>
        </div>
    `;

    sec.scrollIntoView({ behavior: 'smooth' });

    document.getElementById('withdrawMaxBtn')?.addEventListener('click', () => {
        const input = document.getElementById('withdrawAmount');
        if (input) input.value = (Number(maxAmount) / 1e6).toFixed(6);
    });

    document.getElementById('withdrawCancelBtn')?.addEventListener('click', () => {
        sec.innerHTML = '';
    });

    document.getElementById('withdrawConfirmBtn')?.addEventListener('click', async () => {
        const amtStr = document.getElementById('withdrawAmount')?.value;
        const amount = parseUSDC(amtStr || '0');
        const btn    = document.getElementById('withdrawConfirmBtn');
        if (amount <= 0n) { showToast('Enter a valid amount', true); return; }
        if (amount > BigInt(maxAmount)) { showToast('Amount exceeds your supplied balance', true); return; }
        setLoading(btn, true);
        try {
            const tx = await marketplace(true).withdrawLiquidity(agentId, amount);
            await tx.wait();
            showToast(`Withdrawn ${formatUSDC(amount)} USDC successfully!`);
            await loadPortfolio();
        } catch (err) {
            showToast('Withdrawal failed: ' + (err.reason || err.message), true);
            setLoading(btn, false);
        }
    });
}

// ── Tier badge helper ──────────────────────────────────────────────────────────

function tierBadgeCss(tier) {
    return {
        PRIME:     'tier-excellent',
        STANDARD:  'tier-good',
        SUBPRIME:  'tier-average',
        HIGH_RISK: 'tier-below',
        UNRATED:   'tier-risk',
    }[tier] ?? 'tier-risk';
}
