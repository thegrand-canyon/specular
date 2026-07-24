// Regression test for ContractManager M4: write-retry re-broadcast.
//
// Old behavior: callContract retried the WHOLE call on any error. If a write tx
// broadcast successfully but result.wait() then threw a transient RPC error,
// the catch re-issued contract[method](...) → a SECOND on-chain transaction
// (duplicate loan/approval). Fix: classify read vs write by stateMutability;
// writes send exactly once, and a transient wait() failure polls the receipt
// by hash instead of re-sending.

const { expect } = require("chai");
const ContractManager = require("../../src/ContractManager.js");

// callContract only touches contract/interface/runner — construct a bare CM.
const cm = Object.create(ContractManager.prototype);
const call = (contract, method, params, opts) => cm.callContract(contract, method, params, opts);

function writeContract(fn, { stateMutability = "nonpayable" } = {}) {
    return {
        target: "0xcontract",
        runner: { provider: this && this.provider },
        interface: { getFunction: () => ({ stateMutability }) },
        [Object.keys({ fn })[0]]: fn,
    };
}

describe("ContractManager.callContract write-once (M4)", function () {
    it("sends a write exactly once despite a transient wait() failure, recovering via receipt poll", async () => {
        let sendCount = 0;
        let waitCount = 0;
        const receipt = { status: 1, blockNumber: 42 };
        const provider = { getTransactionReceipt: async () => (waitCount >= 1 ? receipt : null) };
        const txResp = {
            hash: "0xabc",
            provider,
            wait: async () => {
                waitCount++;
                if (waitCount === 1) throw new Error("timeout: RPC 503");
                return receipt;
            },
        };
        const contract = {
            target: "0xc",
            runner: { provider },
            interface: { getFunction: () => ({ stateMutability: "nonpayable" }) },
            requestLoan: async () => { sendCount++; return txResp; },
        };

        const out = await call(contract, "requestLoan", [100, 30], { retryDelay: 1 });
        expect(sendCount, "write must be broadcast exactly once").to.equal(1);
        expect(out.receipt.blockNumber).to.equal(42);
    });

    it("treats an on-chain revert as terminal — no re-send", async () => {
        let sendCount = 0;
        const provider = { getTransactionReceipt: async () => null };
        const revertTx = {
            hash: "0xdef",
            provider,
            wait: async () => { throw new Error("execution reverted: Not the borrower"); },
        };
        const contract = {
            target: "0xc",
            runner: { provider },
            interface: { getFunction: () => ({ stateMutability: "nonpayable" }) },
            repayLoan: async () => { sendCount++; return revertTx; },
        };

        let threw = false;
        try { await call(contract, "repayLoan", [1], { retryDelay: 1 }); } catch { threw = true; }
        expect(threw).to.equal(true);
        expect(sendCount, "reverted write must not be re-sent").to.equal(1);
    });

    it("still retries reads (view/pure) wholesale on transient errors", async () => {
        let readCount = 0;
        const contract = {
            target: "0xc",
            runner: { provider: {} },
            interface: { getFunction: () => ({ stateMutability: "view" }) },
            getScore: async () => {
                readCount++;
                if (readCount < 2) throw new Error("temporary network glitch");
                return 950n;
            },
        };
        const score = await call(contract, "getScore", ["0xagent"], { retryDelay: 1 });
        expect(score).to.equal(950n);
        expect(readCount).to.equal(2);
    });
});
