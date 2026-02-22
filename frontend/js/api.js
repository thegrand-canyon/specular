/**
 * Specular Agent API — browser client
 *
 * Hits the local API server (default http://localhost:3001).
 * Auto-discovers the manifest on first use; all methods return plain objects.
 *
 * Usage:
 *   import { api } from './api.js';
 *   const status = await api.getStatus();
 *   const pools  = await api.getPools();
 */

const DEFAULT_BASE = 'http://localhost:3001';

class SpecularAPI {
    constructor(baseUrl = DEFAULT_BASE) {
        this.base      = baseUrl.replace(/\/$/, '');
        this._manifest = null;
    }

    // ── Discovery ────────────────────────────────────────────

    async discover() {
        if (this._manifest) return this._manifest;
        this._manifest = await this._get('/.well-known/specular.json');
        return this._manifest;
    }

    // ── Protocol reads ───────────────────────────────────────

    /** { ok, block, latencyMs } */
    async health() {
        return this._get('/health');
    }

    /**
     * Live protocol status.
     * Returns { tvlUsdc, agentCount, loanCount, activeLoanCount, topPools, ... }
     */
    async getStatus() {
        return this._get('/status');
    }

    /**
     * Active pools sorted by available liquidity.
     * @param {object} [filters]  { minLiquidity, limit }
     */
    async getPools(filters = {}) {
        const qs = new URLSearchParams();
        if (filters.minLiquidity) qs.set('minLiquidity', filters.minLiquidity);
        if (filters.limit)        qs.set('limit',        filters.limit);
        const q = qs.toString() ? `?${qs}` : '';
        return this._get(`/pools${q}`);
    }

    /** Single pool detail. */
    async getPool(poolId) {
        return this._get(`/pools/${poolId}`);
    }

    /**
     * Agent profile: registration, reputation, credit tier, active loans.
     * @param {string} address
     */
    async getAgentProfile(address) {
        return this._get(`/agents/${address}`);
    }

    /** Loan state and details. */
    async getLoan(loanId) {
        return this._get(`/loans/${loanId}`);
    }

    // ── HTTP helper ──────────────────────────────────────────

    async _get(path) {
        const url = `${this.base}${path}`;
        const res = await fetch(url, {
            headers: { 'Accept': 'application/json' },
            // Short timeout — if the API isn't running, fail fast
            signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body?.error || `HTTP ${res.status}`);
        }
        return res.json();
    }
}

// Singleton — import { api } from './api.js'
export const api = new SpecularAPI();
