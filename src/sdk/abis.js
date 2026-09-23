/**
 * ABI resolution for the SDK, shared by SpecularQuickstart and the V7 tooling.
 *
 * The SDK talks to THREE marketplace generations (V6, V6.1, V6.2) and TWO
 * reputation generations (V3, V4) with one set of contract handles, so the ABI
 * it loads must be a SUPERSET of every deployment it can meet. Capability
 * detection (`_codeHasSelector`) then decides what may actually be called:
 * a selector present in the ABI but absent from the deployed bytecode is never
 * invoked.
 *
 *  - Marketplace: `AgentLiquidityMarketplaceV62` is a strict superset of
 *    `AgentLiquidityMarketplaceV6` (it adds only `requiredSelfStake` and
 *    `selfStake`), so it is loaded directly. Every V6/V6.1 call encodes
 *    byte-identically.
 *  - Reputation: `ReputationManagerV4` is NOT a superset — it replaces the
 *    three `record*` write signatures with loanId-carrying ones. Those are
 *    `onlyAuthorizedPool` and no client calls them, but dropping them from the
 *    ABI would break operator tooling that shares this loader, so the two ABIs
 *    are UNIONed (dedup by canonical signature, V3 first).
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function artifactPath(name) {
    return path.join(REPO_ROOT, 'artifacts', 'contracts', 'core', `${name}.sol`, `${name}.json`);
}

function readAbi(name) {
    return JSON.parse(fs.readFileSync(artifactPath(name), 'utf8')).abi;
}

/** `name(type,type)` for a function fragment; a stable identity for dedup. */
function sig(f) {
    if (f.type !== 'function') return `${f.type}:${f.name || ''}:${(f.inputs || []).map((i) => i.type).join(',')}`;
    return `${f.name}(${(f.inputs || []).map((i) => i.type).join(',')})`;
}

/** Union two ABIs, keeping the first occurrence of each signature. */
function unionAbi(a, b) {
    const seen = new Set();
    const out = [];
    for (const frag of [...a, ...b]) {
        const k = `${frag.type}|${sig(frag)}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(frag);
    }
    return out;
}

let _mp = null;
let _rep = null;
let _reg = null;

/**
 * Marketplace ABI covering V6, V6.1 and V6.2. Falls back to the V6 artifact if
 * the V6.2 artifact has not been compiled in this checkout.
 */
function marketplaceAbi() {
    if (_mp) return _mp;
    try {
        _mp = readAbi('AgentLiquidityMarketplaceV62');
    } catch (_) {
        _mp = readAbi('AgentLiquidityMarketplaceV6');
    }
    return _mp;
}

/** Reputation ABI covering V3 and V4 (union; V3 signatures win on collision). */
function reputationAbi() {
    if (_rep) return _rep;
    const v3 = readAbi('ReputationManagerV3');
    let v4 = [];
    try {
        v4 = readAbi('ReputationManagerV4');
    } catch (_) {
        v4 = [];
    }
    _rep = unionAbi(v3, v4);
    return _rep;
}

function registryAbi() {
    if (_reg) return _reg;
    _reg = readAbi('AgentRegistryV2');
    return _reg;
}

module.exports = { marketplaceAbi, reputationAbi, registryAbi, unionAbi, REPO_ROOT };
