// Regression test for the SpecularX402Server.flushToPool() re-entrancy race.
//
// Bug (pre-fix): the in-flight guard was `if (this._flushInFlight)`. When N
// callers await the same in-flight flush and it resolves, they all resume past
// the `if` in one microtask batch, each overwriting `_flushInFlight` with its
// own supply IIFE. Every one snapshots the same residual `_earned` and supplies
// it concurrently → the pool is over-supplied and `_earned` goes negative,
// permanently corrupting revenue accounting.
//
// Fix: `while (this._flushInFlight)` re-checks the guard on resume, so exactly
// one caller drains per pass (the check-and-set that follows is synchronous).
//
// This is a pure-JS mocha test (no hardhat network) — it stubs the SDK and
// provider so the race is deterministic rather than timing-dependent (the live
// concurrent-load e2e passed even WITH the bug, because the race is flaky).

const { expect } = require("chai");
const { ethers } = require("ethers");
const { SpecularX402Server } = require("../../src/sdk/x402/SpecularX402Server.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build a server instance without touching the network/disk: bypass the
// constructor and wire only the fields flushToPool() reads.
function makeServer() {
    const srv = Object.create(SpecularX402Server.prototype);
    srv._earned = 0n;
    srv._totalFlushed = 0n;
    srv._flushInFlight = null;
    srv._lastFlushAt = null;
    srv.poolAgentId = 49;
    srv.usdcAddr = "0x" + "ab".repeat(20);
    srv.wallet = { address: "0x" + "11".repeat(20) };
    // Fake provider: balanceOf(...) always returns a huge balance, so the
    // wallet-balance clamp never masks the race.
    srv.provider = {
        call: async () => ethers.zeroPadValue(ethers.toBeHex(10n ** 18n), 32),
    };

    const state = { supplyCalls: 0, supplied: [] };
    srv._getSdk = () => ({
        onboard: async () => {},
        supply: async (_poolId, amount) => {
            state.supplyCalls++;
            // On the first supply, simulate a paid request arriving mid-flush so
            // that legitimate residual revenue exists for re-entrant drainers to
            // race on (without this, _earned drains to 0 and the guard at
            // `if (this._earned === 0n) return null` hides the bug).
            if (state.supplyCalls === 1) {
                srv._earned += ethers.parseUnits("3", 6);
            }
            await sleep(20);
            state.supplied.push(amount);
            return "0xhash" + state.supplyCalls;
        },
    });
    return { srv, state };
}

describe("SpecularX402Server.flushToPool re-entrancy", function () {
    it("collapses N concurrent flushes into one supply per drain and never over-supplies", async function () {
        const { srv, state } = makeServer();
        srv._earned = ethers.parseUnits("5", 6); // initial revenue over threshold

        // 20 concurrent threshold-triggered auto-flushes.
        await Promise.all(Array.from({ length: 20 }, () => srv.flushToPool()));

        const totalSupplied = state.supplied.reduce((a, b) => a + b, 0n);

        // Exactly two supplies: the initial 5 USDC, then the 3 USDC that arrived
        // mid-flush. The buggy `if` version fires ~19 supplies of the residual.
        expect(state.supplyCalls).to.equal(2);
        expect(ethers.formatUnits(totalSupplied, 6)).to.equal("8.0");
        expect(ethers.formatUnits(srv._totalFlushed, 6)).to.equal("8.0");

        // Accounting invariant: revenue is fully drained and NEVER negative.
        expect(srv._earned).to.equal(0n);
        expect(srv._earned >= 0n).to.equal(true);
    });
});
