import { marketplace, registry, reputation } from '../contracts.js';
import { formatUSDC, utilizationPct, reputationTier, agentName, shortAddr, showToast } from '../utils.js';
import { api } from '../api.js';

// Auto-refresh handle
let _refreshTimer = null;

export async function renderLeaderboard() {
    const app = document.getElementById('app');
    clearInterval(_refreshTimer);

    app.innerHTML = `
        <div class="page-header">
            <h1>Agent Leaderboard</h1>
            <p class="subtitle">All active liquidity pools on Specular Protocol</p>
        </div>

        <!-- Live protocol stats banner -->
        <div id="protocol-stats" class="cards-grid" style="margin-bottom:1.25rem">
            ${statsSkeleton()}
        </div>

        <!-- Pool table -->
        <div id="lb-content">
            <div class="loading-state">
                <div class="spinner"></div>
                <p>Loading agent pools...</p>
            </div>
        </div>

        <div style="display:flex;align-items:center;gap:0.75rem;margin-top:0.5rem">
            <span id="lb-timestamp" class="hint"></span>
            <button class="btn btn-sm" id="lb-refresh" title="Refresh now">↻ Refresh</button>
            <span class="hint">Auto-refreshes every 30s</span>
        </div>
    `;

    document.getElementById('lb-refresh')?.addEventListener('click', () => loadAll());

    await loadAll();

    // Auto-refresh every 30 s
    _refreshTimer = setInterval(loadAll, 30_000);
}

// ── Data loading ────────────────────────────────────────────────────────────

async function loadAll() {
    await Promise.allSettled([
        loadStats(),
        loadPools(),
    ]);
}

async function loadStats() {
    const el = document.getElementById('protocol-stats');
    if (!el) return;

    try {
        const s = await api.getStatus();
        el.innerHTML = `
            ${statCard('Total TVL',     formatMoney(s.liquidity?.tvlUsdc),                               'var(--accent-alt)')}
            ${statCard('Active Agents', s.agentCount ?? s.agents?.total ?? '—',                          'var(--blue)')}
            ${statCard('Total Loans',   s.loanCount  ?? s.loans?.total  ?? '—',                          'var(--green)')}
            ${statCard('Active Loans',  s.activeLoanCount ?? s.loans?.active ?? '—',                     'var(--yellow)')}
        `;
    } catch {
        // API not running — try contract fallback
        try {
            const alm = marketplace();
            const [totalPools] = await Promise.all([
                alm.totalPools().catch(() => 0n),
            ]);
            el.innerHTML = `
                ${statCard('Active Pools', Number(totalPools), 'var(--accent-alt)')}
                ${statCard('API Status',   '<span class="text-warning">offline</span>', 'var(--yellow)')}
            `;
        } catch {
            el.innerHTML = '';
        }
    }
}

async function loadPools() {
    const content = document.getElementById('lb-content');
    const tsEl    = document.getElementById('lb-timestamp');
    if (!content) return;

    // Try API first — much faster than 50+ sequential RPC calls
    let pools = null;
    try {
        const resp = await api.getPools({ limit: 50 });
        pools = resp.pools ?? resp;  // API may wrap in { pools: [...] }
        if (tsEl) {
            const now = new Date().toLocaleTimeString();
            tsEl.textContent = `Last updated: ${now} (via API)`;
        }
    } catch {
        // Fall back to direct contract reads
    }

    if (pools && Array.isArray(pools)) {
        renderApiPools(pools, content);
        return;
    }

    // Contract fallback
    try {
        const contractPools = await fetchContractPools();
        renderContractPools(contractPools, content);
        if (tsEl) {
            const now = new Date().toLocaleTimeString();
            tsEl.textContent = `Last updated: ${now} (via chain — API offline)`;
        }
    } catch (err) {
        content.innerHTML = `<div class="error-state">Failed to load pools: ${err.message}</div>`;
        showToast('Failed to load pools', true);
    }
}

// ── Render: API data ─────────────────────────────────────────────────────────

function renderApiPools(pools, content) {
    if (!pools.length) {
        content.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🏊</div>
                <h3>No active agent pools found</h3>
                <p>Run the agent simulation to create pools, or connect your wallet to create one.</p>
            </div>
        `;
        return;
    }

    const rows = pools.map((p, i) => {
        // API returns `id`; contract fallback uses `agentId`
        const poolId = p.id ?? p.agentId;
        const tier   = apiTier(p.creditTier ?? p.tier);
        const score  = p.reputationScore ?? p.reputation?.score ?? '—';
        const name   = p.name || p.agentName || `Agent #${poolId}`;
        const avail  = p.availableLiquidityUsdc ?? 0;
        const total  = p.totalLiquidityUsdc ?? 0;
        const earned = p.totalEarnedUsdc ?? 0;
        const util   = Number(p.utilizationPct ?? 0);

        return `
            <tr class="pool-row" onclick="window.location.hash='pool/${poolId}'">
                <td class="rank">#${i + 1}</td>
                <td>
                    <div class="agent-cell">
                        <span class="agent-id">#${poolId}</span>
                        <span class="agent-name">${name}</span>
                    </div>
                </td>
                <td>
                    <span class="badge ${tier.css}">${score}</span>
                    <span class="tier-label">${tier.label}</span>
                </td>
                <td>${formatMoney(total)} USDC</td>
                <td class="text-green">${formatMoney(avail)} USDC</td>
                <td>
                    <div class="util-bar-wrap">
                        <div class="util-bar" style="width:${Math.min(100,util)}%"></div>
                    </div>
                    <span class="util-label">${util}%</span>
                </td>
                <td class="monospace text-green">${typeof earned === 'number' ? earned.toFixed(4) : earned}</td>
                <td>
                    <button class="btn btn-sm btn-primary"
                        onclick="event.stopPropagation(); window.location.hash='pool/${poolId}'">
                        View
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    content.innerHTML = `
        <div class="card">
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Rank</th>
                            <th>Agent</th>
                            <th>Reputation</th>
                            <th>Total Liquidity</th>
                            <th>Available</th>
                            <th>Utilization</th>
                            <th>Earned</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>
        <p class="hint">${pools.length} active pool${pools.length !== 1 ? 's' : ''} found</p>
    `;
}

// ── Render: contract data (fallback) ─────────────────────────────────────────

async function fetchContractPools() {
    const alm = marketplace();
    const reg = registry();
    const rep = reputation();

    let total;
    try {
        total = Number(await alm.totalPools());
    } catch {
        total = 0;
    }
    if (total === 0) return [];

    const agentIdPromises = [];
    for (let i = 0; i < total; i++) {
        agentIdPromises.push(alm.agentPoolIds(i).catch(() => null));
    }
    const rawIds   = await Promise.all(agentIdPromises);
    const agentIds = [...new Set(rawIds.filter(id => id != null).map(id => BigInt(id)))];

    const poolPromises = agentIds.map(async (agentId) => {
        try {
            const [poolData, rawPool, repScore] = await Promise.all([
                alm.getAgentPool(agentId).catch(() => null),
                alm.agentPools(agentId).catch(() => null),
                rep['getReputationScore(uint256)'](agentId).catch(() => 0n),
            ]);
            if (!rawPool || !rawPool[6]) return null;
            let agentInfo = null;
            try { agentInfo = await reg.getAgentInfoById(agentId); } catch {}
            return { agentId, poolData, rawPool, agentInfo, repScore };
        } catch {
            return null;
        }
    });

    const results = await Promise.all(poolPromises);
    const valid   = results.filter(Boolean);
    valid.sort((a, b) => Number(b.repScore - a.repScore));
    return valid;
}

function renderContractPools(pools, content) {
    if (!pools.length) {
        content.innerHTML = `
            <div class="empty-state">
                <div class="empty-icon">🏊</div>
                <h3>No active agent pools found</h3>
                <p>Run the bot simulation to create pools, or connect your wallet to create one.</p>
            </div>
        `;
        return;
    }

    const rows = pools.map((p, i) => {
        const [agentAddress, totalLiq, availLiq, totalLoaned, totalEarned, utilRate, lenderCount] =
            p.poolData || [p.rawPool[1], p.rawPool[2], p.rawPool[3], p.rawPool[4], p.rawPool[5], 0n, 0n];

        const tier  = reputationTier(p.repScore);
        const util  = utilizationPct(totalLoaned, totalLiq);
        const name  = agentName(p.agentInfo, p.agentId);

        return `
            <tr class="pool-row" onclick="window.location.hash='pool/${p.agentId}'">
                <td class="rank">#${i + 1}</td>
                <td class="agent-cell">
                    <span class="agent-id">${p.agentId}</span>
                    <span class="agent-name">${name}</span>
                </td>
                <td><span class="badge ${tier.css}">${Number(p.repScore)}</span> <span class="tier-label">${tier.label}</span></td>
                <td>${formatUSDC(totalLiq)} USDC</td>
                <td>${formatUSDC(availLiq)} USDC</td>
                <td>
                    <div class="util-bar-wrap">
                        <div class="util-bar" style="width:${util}%"></div>
                    </div>
                    <span class="util-label">${util.toFixed(1)}%</span>
                </td>
                <td>—</td>
                <td>
                    <button class="btn btn-sm btn-primary"
                        onclick="event.stopPropagation(); window.location.hash='pool/${p.agentId}'">
                        View
                    </button>
                </td>
            </tr>
        `;
    }).join('');

    content.innerHTML = `
        <div class="card">
            <div class="table-wrap">
                <table class="data-table">
                    <thead>
                        <tr>
                            <th>Rank</th>
                            <th>Agent</th>
                            <th>Reputation</th>
                            <th>Total Liquidity</th>
                            <th>Available</th>
                            <th>Utilization</th>
                            <th>Earned</th>
                            <th></th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
        </div>
        <p class="hint">${pools.length} active pool${pools.length !== 1 ? 's' : ''} found</p>
    `;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function statCard(label, value, color = 'var(--text)') {
    return `
        <div class="card stat-card">
            <div class="stat-label">${label}</div>
            <div class="stat-value" style="color:${color}">${value}</div>
        </div>
    `;
}

function statsSkeleton() {
    return ['Total TVL','Active Agents','Total Loans','Active Loans'].map(label => `
        <div class="card stat-card">
            <div class="stat-label">${label}</div>
            <div class="stat-value muted">—</div>
        </div>
    `).join('');
}

/** Format number as compact money string: 1234567 → "1.23M", 716000 → "716K" */
function formatMoney(val) {
    if (val === undefined || val === null) return '—';
    const n = Number(val);
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
    return n.toFixed(2);
}

/** Map API tier strings to badge CSS */
function apiTier(tier) {
    switch ((tier || '').toUpperCase()) {
        case 'PRIME':     return { label: 'Prime',     css: 'tier-excellent' };
        case 'STANDARD':  return { label: 'Standard',  css: 'tier-good'      };
        case 'SUBPRIME':  return { label: 'Subprime',  css: 'tier-average'   };
        case 'HIGH_RISK': return { label: 'High Risk', css: 'tier-below'     };
        case 'UNRATED':   return { label: 'Unrated',   css: 'tier-risk'      };
        default:          return { label: tier || '—', css: 'tier-risk'      };
    }
}
