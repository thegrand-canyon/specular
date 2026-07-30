import { LOAN_STATES } from './config.js';

export function formatUSDC(val) {
    if (val === undefined || val === null) return '0.00';
    const n = Number(val) / 1_000_000;
    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function parseUSDC(s) {
    const n = parseFloat(s);
    if (isNaN(n) || n <= 0) return 0n;
    return BigInt(Math.round(n * 1_000_000));
}

export function shortAddr(addr) {
    if (!addr) return '';
    return addr.slice(0, 6) + '...' + addr.slice(-4);
}

export function utilizationPct(totalLoaned, totalLiquidity) {
    if (!totalLiquidity || BigInt(totalLiquidity) === 0n) return 0;
    return Math.min(100, Number((BigInt(totalLoaned) * 10000n) / BigInt(totalLiquidity)) / 100);
}

export function reputationTier(score) {
    const n = Number(score);
    if (n >= 800) return { label: 'Excellent', css: 'tier-excellent' };
    if (n >= 600) return { label: 'Good',      css: 'tier-good'      };
    if (n >= 400) return { label: 'Average',   css: 'tier-average'   };
    if (n >= 200) return { label: 'Below Avg', css: 'tier-below'     };
    return               { label: 'High Risk', css: 'tier-risk'      };
}

export function loanStateLabel(stateIndex) {
    return LOAN_STATES[Number(stateIndex)] || 'Unknown';
}

export function loanStateCss(stateIndex) {
    const s = Number(stateIndex);
    return ['badge-warning', 'badge-info', 'badge-success', 'badge-danger'][s] || '';
}

export function formatDate(ts) {
    if (!ts || ts === 0n) return '-';
    return new Date(Number(ts) * 1000).toLocaleDateString();
}

export function showToast(msg, isError = false) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.className = 'toast show' + (isError ? ' toast-error' : '');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.className = 'toast', 3500);
}

export function setLoading(btn, loading) {
    if (!btn) return;
    btn.disabled = loading;
    btn.dataset.originalText = btn.dataset.originalText || btn.textContent;
    btn.textContent = loading ? 'Processing...' : btn.dataset.originalText;
}

// Escape a string for safe interpolation into innerHTML. Use for any value
// that originates off-chain / from the API / from an agent (all untrusted).
export function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export function agentName(agentInfo, agentId) {
    if (!agentInfo) return `Agent #${agentId}`;
    const uri = agentInfo.agentURI || agentInfo[3];
    if (!uri) return `Agent #${agentId}`;
    // Extract name from URI like https://specular.ai/agents/agentbot-alpha.
    // agentURI is attacker-controlled (registration is permissionless) and this
    // name is interpolated into innerHTML across the app (leaderboard, pool,
    // portfolio, supply). A name slug only ever needs letters/digits/space/
    // hyphen, so strip everything else — this neutralizes markup injection at
    // the source for every consumer, whether they use innerHTML or textContent.
    const parts = String(uri).split('/');
    const slug = parts[parts.length - 1];
    if (!slug) return `Agent #${agentId}`;
    const clean = slug.replace(/-/g, ' ').replace(/[^\w \-]/g, '').trim();
    if (!clean) return `Agent #${agentId}`;
    return clean.replace(/\b\w/g, c => c.toUpperCase());
}
