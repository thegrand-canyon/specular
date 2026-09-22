/**
 * STATE + EVENT LAYERS under failure.
 *
 * StateManager: does it ever serve stale credit data past TTL? Can a cache
 * entry survive a chain reorg?
 * EventListener: reconnect, duplicate events, and — the case the existing
 * regression suite did not cover — a backfill that itself fails.
 */

const { expect } = require('chai');
const { EventEmitter } = require('events');
const StateManager = require('../../src/StateManager.js');
const EventListener = require('../../src/EventListener.js');

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ fixtures

function makeAgent() {
    const state = { score: 700n, limit: 25_000_000000n, coll: 0n, head: 100, fail: false, calls: 0 };
    const guard = async (v) => {
        state.calls++;
        if (state.fail) throw new Error('server response 503');
        return v;
    };
    const agent = {
        address: '0x' + '11'.repeat(20),
        provider: { getBlockNumber: async () => state.head },
        contracts: {
            reputationManager: {
                'getReputationScore(address)': () => guard(state.score),
                'calculateCreditLimit(address)': () => guard(state.limit),
                'calculateCollateralRequirement(address)': () => guard(state.coll),
            },
            agentRegistry: {
                getAgentInfo: () => guard({ agentAddress: agent.address, metadata: 'm', registrationTime: 1n, isActive: true }),
            },
            lendingPool: {
                getBorrowerLoans: () => guard([]),
            },
        },
    };
    return { agent, state };
}

describe('StateManager under failure', function () {
    it('serves a fresh value from cache without refetching', async () => {
        const { agent, state } = makeAgent();
        const sm = new StateManager(agent);
        expect(await sm.getReputation()).to.equal(700);
        const calls = state.calls;
        expect(await sm.getReputation()).to.equal(700);
        expect(state.calls, 'second read came from cache').to.equal(calls);
    });

    it('[F-R12] must NOT serve stale credit data past its TTL when the refresh fails', async () => {
        const { agent, state } = makeAgent();
        const sm = new StateManager(agent);
        sm.setCacheTTL(10);
        expect(await sm.getCreditLimit()).to.equal(25_000_000000n);

        // credit limit is slashed on chain…
        state.limit = 1_000000n;
        // …but the RPC is now broken, so the SDK cannot see it.
        state.fail = true;
        await tick(25); // TTL expires

        let err = null, got = null;
        try { got = await sm.getCreditLimit(); } catch (e) { err = e; }
        if (!err) {
            throw new Error(
                `StateManager returned ${got} for an expired key whose refresh failed — an agent would size a loan ` +
                'against a credit limit that no longer exists, with no signal that the read failed.');
        }
        expect(err.code).to.equal('SPECULAR_STATE_STALE');
        expect(err.message).to.match(/stale/i);
    });

    it('[F-R12] recovers silently once the RPC comes back', async () => {
        const { agent, state } = makeAgent();
        const sm = new StateManager(agent);
        sm.setCacheTTL(10);
        await sm.getReputation();
        state.fail = true;
        await tick(25);
        try { await sm.getReputation(); } catch (_) { /* expected */ }
        state.fail = false;
        state.score = 800n;
        expect(await sm.getReputation()).to.equal(800);
    });

    it('a genuinely uninitialized reputation is still reported as absent, not as an error', async () => {
        const { agent } = makeAgent();
        agent.contracts.reputationManager['getReputationScore(address)'] = async () => {
            throw new Error('Reputation not initialized');
        };
        const sm = new StateManager(agent);
        const v = await sm.getReputation();
        expect(v === null || v === undefined).to.equal(true);
    });

    it('[F-R13] a cache entry must not survive a chain reorg', async () => {
        const { agent, state } = makeAgent();
        const sm = new StateManager(agent);
        sm.headCheckIntervalMs = 0;      // check every read
        sm.setCacheTTL(60000);           // long TTL: only the reorg can invalidate
        expect(await sm.getReputation()).to.equal(700);

        // the chain reorgs 3 blocks away and the agent's score is different there
        state.head = 97;
        state.score = 120n;

        const after = await sm.getReputation();
        expect(after, 'the pre-reorg cached score was served after the rollback').to.equal(120);
    });

    it('[F-R13] a normally advancing head never invalidates the cache', async () => {
        const { agent, state } = makeAgent();
        const sm = new StateManager(agent);
        sm.headCheckIntervalMs = 0;
        expect(await sm.getReputation()).to.equal(700);
        const calls = state.calls;
        state.head = 105;
        expect(await sm.getReputation()).to.equal(700);
        expect(state.calls, 'no refetch for a forward-moving head').to.equal(calls);
    });
});

// ---------------------------------------------------------------- EventListener

function mockContract() {
    const ee = new EventEmitter();
    const c = {
        _backfill: {},
        _throwOnQuery: false,
        on: (e, h) => ee.on(e, h),
        off: (e, h) => ee.off(e, h),
        listenerCount: (e) => ee.listenerCount(e),
        fire: (e, ...a) => ee.emit(e, ...a),
        filters: new Proxy({}, { get: (_, e) => () => ({ _ev: e }) }),
        queryFilter: async (filter) => {
            if (c._throwOnQuery) throw new Error('server response 429');
            return c._backfill[filter._ev] || [];
        },
    };
    return c;
}

function makeListener(opts) {
    const provider = new EventEmitter();
    provider.getBlockNumber = async () => provider._head || 150;
    const contracts = {
        agentRegistry: mockContract(),
        reputationManager: mockContract(),
        lendingPool: mockContract(),
    };
    return { provider, contracts, el: new EventListener(provider, contracts, opts) };
}

const evLog = (tx, idx) => ({ transactionHash: tx, index: idx });

describe('EventListener under failure', function () {
    it('[F-R14] a backfill that FAILS must not advance the marker and silently lose the window', async () => {
        const { provider, contracts, el } = makeListener();
        const seen = [];
        el.on('LoanDefaulted', (d) => seen.push(d.loanId));
        await el.start();
        provider.emit('block', 100);
        await tick();

        // the WS dies; while it is down a default happens
        contracts.lendingPool._backfill.LoanDefaulted = [
            { args: [7n, '0xabc'], transactionHash: '0xdead', index: 0, log: evLog('0xdead', 0) },
        ];
        // …and the same outage breaks queryFilter
        contracts.lendingPool._throwOnQuery = true;
        provider._head = 140;
        provider.emit('error', new Error('WS closed'));
        await tick(80);

        expect(seen, 'the event could not be backfilled').to.deep.equal([]);
        expect(el._lastSeenBlock, 'marker must NOT advance past a window we failed to read').to.equal(100);
        expect(el.lastBackfillIncomplete).to.equal(true);

        // the RPC recovers; the next reconnect re-reads the same window
        contracts.lendingPool._throwOnQuery = false;
        provider.emit('error', new Error('WS closed again'));
        await tick(80);
        expect(seen, 'the missed default is delivered on the retry').to.deep.equal([7]);
        expect(el._lastSeenBlock).to.equal(140);
        el.stop();
    });

    it('a successful backfill advances the marker and dedupes against live delivery', async () => {
        const { provider, contracts, el } = makeListener();
        const seen = [];
        el.on('LoanRepaid', (d) => seen.push(d.loanId));
        await el.start();
        provider.emit('block', 100);
        await tick();
        contracts.lendingPool.fire('LoanRepaid', 3n, '0xabc', 10n, true, { log: evLog('0xaaa', 1) });
        contracts.lendingPool._backfill.LoanRepaid = [
            { args: [3n, '0xabc', 10n, true], transactionHash: '0xaaa', index: 1, log: evLog('0xaaa', 1) },
            { args: [4n, '0xabc', 10n, true], transactionHash: '0xbbb', index: 0, log: evLog('0xbbb', 0) },
        ];
        provider._head = 130;
        provider.emit('error', new Error('WS closed'));
        await tick(80);
        expect(seen, 'live event delivered once, only the genuinely missed one added').to.deep.equal([3, 4]);
        expect(el._lastSeenBlock).to.equal(130);
        el.stop();
    });

    it('a stalled block feed triggers a reconnect via the watchdog', async () => {
        const { provider, el } = makeListener({ staleMs: 20, watchdogMs: 10 });
        await el.start();
        provider.emit('block', 100);
        await tick();
        el._lastBlockAt = Date.now() - 1000; // no blocks for a while
        await tick(60);
        expect(el.isListening).to.equal(true);
        expect(el._lastSeenBlock).to.be.gte(100);
        el.stop();
    });

    it('events that occur while the listener is STOPPED are not backfilled on restart (documented gap)', async () => {
        const { provider, contracts, el } = makeListener();
        const seen = [];
        el.on('LoanDefaulted', (d) => seen.push(d.loanId));
        await el.start();
        provider.emit('block', 100);
        await tick();
        el.stop();
        contracts.lendingPool._backfill.LoanDefaulted = [
            { args: [9n, '0xabc'], transactionHash: '0xfff', index: 0, log: evLog('0xfff', 0) },
        ];
        await el.start();
        await tick(50);
        // start() does NOT replay — integrators restarting a bot must call
        // queryPastEvents() themselves from their own persisted checkpoint.
        expect(seen).to.deep.equal([]);
        el.stop();
    });
});
