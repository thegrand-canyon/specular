/**
 * Fault-injecting JSON-RPC layer for SDK robustness testing.
 *
 * Wraps hardhat's in-process EIP-1193 provider and hands the result to
 * ethers' BrowserProvider, so the SDK under test speaks real JSON-RPC and
 * every single request passes through `FaultyTransport.request()` where we
 * can drop it, corrupt it, delay it, or answer it from a stale block.
 *
 * This is deliberately at the TRANSPORT layer (not a stub of the SDK's own
 * methods): it reproduces what a third-party agent actually sees on a flaky
 * public RPC — 429/500/timeout, load-balanced replicas at different heights,
 * connection resets mid-wait, receipts that never arrive.
 */

const { ethers } = require('ethers');
const hre = require('hardhat');

/** Build an RPC-shaped error the way ethers/`JsonRpcProvider` surfaces one. */
function rpcError(status, message) {
    const e = new Error(message || `server response ${status}`);
    e.code = 'SERVER_ERROR';
    e.status = status;
    e.shortMessage = message || `server response ${status}`;
    return e;
}

function timeoutError() {
    const e = new Error('request timeout');
    e.code = 'TIMEOUT';
    e.shortMessage = 'request timeout';
    return e;
}

function connectionDropped() {
    const e = new Error('socket hang up (ECONNRESET)');
    e.code = 'NETWORK_ERROR';
    e.shortMessage = 'socket hang up';
    return e;
}

/**
 * Rules are evaluated in insertion order. Each rule:
 *   { name, match(method, params), act(ctx) , times }
 * `act` may return:
 *   { throw: Error }         -> the request fails
 *   { result: any }          -> answer with this value, never touching the node
 *   { forward: {method,params} } -> rewrite and forward
 *   undefined                -> fall through to the next rule / the node
 */
class FaultyTransport {
    constructor(base) {
        this.base = base;
        this.rules = [];
        this.log = [];          // every {method, params} that reached us
        this.forwarded = [];    // every {method, params} that reached the node
    }

    addRule(rule) {
        this.rules.push({ times: Infinity, hits: 0, ...rule });
        return this;
    }

    clearRules() { this.rules = []; return this; }

    counts(method) { return this.log.filter((c) => c.method === method).length; }

    sent() { return this.forwarded.filter((c) => c.method === 'eth_sendRawTransaction' || c.method === 'eth_sendTransaction'); }

    async request(args) {
        const { method, params } = args;
        this.log.push({ method, params });
        for (const rule of this.rules) {
            if (rule.hits >= rule.times) continue;
            let m;
            try { m = rule.match(method, params); } catch (_) { m = false; }
            if (!m) continue;
            rule.hits++;
            const out = await rule.act({ method, params, base: this.base, transport: this });
            if (!out) continue;                      // rule declined after all
            if (out.throw) throw out.throw;
            if ('result' in out) return out.result;
            if (out.forward) {
                this.forwarded.push(out.forward);
                return this.base.request(out.forward);
            }
        }
        this.forwarded.push({ method, params });
        return this.base.request(args);
    }

    // BrowserProvider only needs `request`, but some ethers paths sniff `send`.
    send(method, params) { return this.request({ method, params }); }
}

/** A provider whose every RPC call is interceptable. */
function makeFaultyProvider(baseProvider = hre.network.provider) {
    const transport = new FaultyTransport(baseProvider);
    const provider = new ethers.BrowserProvider(transport, undefined, { cacheTimeout: -1 });
    provider.pollingInterval = 50;
    return { provider, transport };
}

// ---------------------------------------------------------------- rule kits

/** Fail the first `times` occurrences of `method` with an HTTP status. */
const failMethod = (method, status, times = 1) => ({
    name: `${method}:${status}`,
    times,
    match: (m) => m === method,
    act: () => ({ throw: status === 'timeout' ? timeoutError() : rpcError(status) }),
});

/** Every request throws ECONNRESET once armed (simulates the socket dying). */
const dropConnection = (times = Infinity) => ({
    name: 'drop',
    times,
    match: () => true,
    act: () => ({ throw: connectionDropped() }),
});

/**
 * Serve every `eth_call` from a block `behind` blocks in the past, and report
 * `eth_blockNumber` at that lagged height. This is what a load-balanced public
 * RPC does when it routes you to a replica that is minutes/hours behind.
 */
const staleReads = (behind) => ({
    name: `stale:${behind}`,
    match: (m) => m === 'eth_call' || m === 'eth_blockNumber',
    act: async ({ method, params, base }) => {
        const headHex = await base.request({ method: 'eth_blockNumber', params: [] });
        const lagged = Math.max(0, parseInt(headHex, 16) - behind);
        if (method === 'eth_blockNumber') return { result: '0x' + lagged.toString(16) };
        const p = [...params];
        p[1] = '0x' + lagged.toString(16);
        return { forward: { method: 'eth_call', params: p } };
    },
});

/** `eth_getTransactionReceipt` always answers "not mined yet". */
const swallowReceipts = (times = Infinity) => ({
    name: 'no-receipt',
    times,
    match: (m) => m === 'eth_getTransactionReceipt',
    act: () => ({ result: null }),
});

/**
 * Answer `eth_call` to `to` with a canned return value — used to simulate an
 * inconsistent replica (registry says registered, marketplace says not) and
 * missing-selector vs transient-error ambiguity.
 */
const cannedCall = (to, selector, result, times = Infinity) => ({
    name: `canned:${selector}`,
    times,
    match: (m, p) =>
        m === 'eth_call' &&
        p[0] &&
        (!to || String(p[0].to).toLowerCase() === String(to).toLowerCase()) &&
        String(p[0].data || '').toLowerCase().startsWith(selector.toLowerCase()),
    act: () => ({ result }),
});

/** Throw on `eth_call`s matching a selector (transient RPC failure of one view). */
const failCall = (to, selector, err, times = Infinity) => ({
    name: `failcall:${selector}`,
    times,
    match: (m, p) =>
        m === 'eth_call' &&
        p[0] &&
        (!to || String(p[0].to).toLowerCase() === String(to).toLowerCase()) &&
        String(p[0].data || '').toLowerCase().startsWith(selector.toLowerCase()),
    act: () => ({ throw: err }),
});

/**
 * The classic "submitted but no receipt": the raw tx IS forwarded to the node
 * (so it really mines) but the send response is reported as a network failure,
 * exactly like a proxy that times out after relaying. A double-submitting SDK
 * will show a second eth_sendRawTransaction with different calldata/nonce.
 */
const sendThenLoseResponse = (times = 1) => ({
    name: 'send-lost-response',
    times,
    match: (m) => m === 'eth_sendRawTransaction',
    act: async ({ params, base, transport }) => {
        transport.forwarded.push({ method: 'eth_sendRawTransaction', params });
        try { await base.request({ method: 'eth_sendRawTransaction', params }); } catch (_) { /* already known */ }
        return { throw: timeoutError() };
    },
});

/** Selector helper for a 4-byte function signature. */
const sel = (contract, name) => contract.interface.getFunction(name).selector;

/** ABI-encoded revert for `require(false, reason)` — what a node returns on a revert. */
function revertData(reason) {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    return '0x08c379a0' + coder.encode(['string'], [reason]).slice(2);
}

module.exports = {
    FaultyTransport,
    makeFaultyProvider,
    rpcError,
    timeoutError,
    connectionDropped,
    failMethod,
    dropConnection,
    staleReads,
    swallowReceipts,
    cannedCall,
    failCall,
    sendThenLoseResponse,
    sel,
    revertData,
};
