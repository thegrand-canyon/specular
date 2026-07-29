// Regression test for EventListener M5 (reconnect/backfill) + L9 (precise removal).
//
// M5: a dropped WS makes ethers stop delivering events silently. The listener
// now keeps a block heartbeat and, on provider 'error' or a stall, re-subscribes
// and backfills missed events via queryFilter from the last block it saw.
// L9: stop() must remove only the handlers WE attached, never removeAllListeners()
// on the shared contract instances (which would kill other code's subscriptions).

const { expect } = require("chai");
const { EventEmitter } = require("events");
const EventListener = require("../../src/EventListener.js");

function mockContract() {
    const ee = new EventEmitter();
    const c = {
        _backfill: {},
        on: (e, h) => ee.on(e, h),
        off: (e, h) => ee.off(e, h),
        listenerCount: (e) => ee.listenerCount(e),
        fire: (e, ...a) => ee.emit(e, ...a),
        filters: new Proxy({}, { get: (_, e) => () => ({ _ev: e }) }),
        queryFilter: async (filter) => c._backfill[filter._ev] || [],
    };
    return c;
}

function makeListener(opts) {
    const provider = new EventEmitter();
    const contracts = {
        agentRegistry: mockContract(),
        reputationManager: mockContract(),
        lendingPool: mockContract(),
    };
    return { provider, contracts, el: new EventListener(provider, contracts, opts) };
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe("EventListener reconnect + backfill (M5/L9)", function () {
    it("delivers live events and tracks a block heartbeat", async () => {
        const { provider, contracts, el } = makeListener();
        const seen = [];
        el.on("LoanDefaulted", (d) => seen.push(d.loanId));
        await el.start();

        contracts.lendingPool.fire("LoanDefaulted", 7n, "0xabc");
        provider.emit("block", 100);

        expect(seen).to.deep.equal([7]);
        expect(el._lastSeenBlock).to.equal(100);
        el.stop();
    });

    it("backfills events missed during a disconnect and re-subscribes exactly once", async () => {
        const { provider, contracts, el } = makeListener();
        const seen = [];
        el.on("LoanDefaulted", (d) => seen.push(d.loanId));
        await el.start();

        provider.emit("block", 100);
        // A LoanDefaulted(9) happened while disconnected.
        contracts.lendingPool._backfill["LoanDefaulted"] = [{ args: [9n, "0xdef"] }];

        provider.emit("error", new Error("WS closed"));
        await tick();

        expect(seen).to.include(9);
        expect(contracts.lendingPool.listenerCount("LoanDefaulted"), "no duplicate subscription").to.equal(1);
        el.stop();
    });

    it("stop() removes only our handlers, leaving foreign subscriptions intact (L9)", async () => {
        const { contracts, el } = makeListener();
        await el.start();
        expect(contracts.lendingPool.listenerCount("LoanRepaid")).to.equal(1); // ours

        const foreign = () => {};
        contracts.lendingPool.on("LoanRepaid", foreign);
        expect(contracts.lendingPool.listenerCount("LoanRepaid")).to.equal(2);

        el.stop();
        expect(contracts.lendingPool.listenerCount("LoanRepaid"), "foreign listener must survive").to.equal(1);
    });

    it("dedupes an event delivered both live and by backfill (same txHash:logIndex)", async () => {
        const { provider, contracts, el } = makeListener();
        const seen = [];
        el.on("LoanDefaulted", (d) => seen.push(d.loanId));
        await el.start();
        provider.emit("block", 100);

        // Live delivery carries an EventLog as the trailing arg.
        const evMeta = { transactionHash: "0xtx1", index: 3 };
        contracts.lendingPool.fire("LoanDefaulted", 9n, "0xdef", evMeta);
        // The SAME event (identical txHash:logIndex) shows up in the backfill.
        contracts.lendingPool._backfill["LoanDefaulted"] = [{ args: [9n, "0xdef"], transactionHash: "0xtx1", index: 3 }];
        provider.emit("error", new Error("WS closed"));
        await tick();

        expect(seen.filter((id) => id === 9)).to.have.lengthOf(1); // emitted once, not twice
        el.stop();
    });

    it("advances _lastSeenBlock to the backfill head so a second reconnect doesn't re-query the window", async () => {
        const { provider, contracts, el } = makeListener();
        await el.start();
        provider.emit("block", 100);
        provider.getBlockNumber = async () => 150;

        let queryCount = 0;
        const origQF = contracts.lendingPool.queryFilter;
        contracts.lendingPool.queryFilter = async (f, from, to) => { if (f._ev === "LoanDefaulted") queryCount++; return origQF(f, from, to); };

        provider.emit("error", new Error("drop 1"));
        await tick();
        expect(el._lastSeenBlock).to.equal(150); // advanced to head
        const afterFirst = queryCount;

        provider.emit("error", new Error("drop 2"));
        await tick();
        // second reconnect backfills from 151, not from 101 again
        expect(queryCount).to.equal(afterFirst + 1);
        el.stop();
    });

    it("no-ops the heartbeat when the provider can't emit block/error", async () => {
        // provider without .on — should not throw on start/stop
        const contracts = { agentRegistry: mockContract(), reputationManager: mockContract(), lendingPool: mockContract() };
        const el = new EventListener({}, contracts);
        await el.start();
        contracts.lendingPool.fire("LoanRequested", 1n, "0xabc", 1000000n, 30n);
        el.stop();
        expect(el.isListening).to.equal(false);
    });
});
