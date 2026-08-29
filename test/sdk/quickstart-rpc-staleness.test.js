// Regression tests for the RPC read-after-write staleness hardening (2026-08),
// surfaced by the live Base P4 run. These shipped live-validated only; this
// closes the unit-test gap.
//   1. _approveExact polls until the new allowance is visible (stale replica).
//   2. borrow() retries requestLoan on transient "Insufficient pool liquidity" /
//      "Not a registered agent" (prior supply/registration not yet propagated).

const { expect } = require("chai");
const { ethers } = require("ethers");
const { SpecularQuickstart } = require("../../src/sdk/SpecularQuickstart.js");

function baseSdk() {
    const sdk = Object.create(SpecularQuickstart.prototype);
    sdk.cfg = { decimals: 6 };
    sdk.network = "arc-staging";
    sdk.wallet = { address: "0x" + "11".repeat(20) };
    sdk.addresses = { marketplace: "0x" + "22".repeat(20) };
    sdk.onboard = async () => {};
    return sdk;
}

describe("SpecularQuickstart RPC-staleness hardening", function () {
    it("_approveExact polls until the new allowance is visible (stale replica lag)", async () => {
        const sdk = baseSdk();
        let realAllowance = 0n;
        let readCount = 0;
        // Simulate a load-balanced RPC: the approve sets the real value, but the
        // first few allowance() reads still return the STALE 0 before catching up.
        sdk.usdc = {
            allowance: async () => {
                readCount++;
                // First read (the pre-approve check) sees 0; after approve, the
                // next 2 reads are still stale (0), then it propagates.
                if (readCount <= 3) return 0n;
                return realAllowance;
            },
            approve: async (_s, amt) => { realAllowance = amt; return { wait: async () => ({}) }; },
        };
        const hash = await sdk._approveExact(ethers.parseUnits("5", 6));
        // It approved and then polled until the fresh allowance was visible.
        expect(hash).to.not.equal(null);
        expect(readCount).to.be.greaterThan(3); // kept reading past the stale window
    });

    it("_approveExact skips (no tx) when allowance already covers", async () => {
        const sdk = baseSdk();
        let approved = false;
        sdk.usdc = {
            allowance: async () => ethers.parseUnits("100", 6),
            approve: async () => { approved = true; return { wait: async () => ({}) }; },
        };
        const res = await sdk._approveExact(ethers.parseUnits("5", 6));
        expect(res).to.equal(null);
        expect(approved).to.equal(false);
    });

    it("borrow() retries requestLoan when the supplied liquidity hasn't propagated yet", async () => {
        const sdk = baseSdk();
        sdk.reputation = { calculateCollateralRequirement: async () => 0n }; // 0% tier, no collateral
        sdk.usdc = { allowance: async () => ethers.parseUnits("1000", 6), approve: async () => ({ wait: async () => ({}) }) };
        let attempts = 0;
        sdk.marketplace = {
            interface: { parseLog: () => ({ name: "LoanRequested", args: { loanId: 3n } }) },
            requestLoan: async () => {
                attempts++;
                // First two attempts: pool liquidity not yet visible (RPC lag). Then it works.
                if (attempts <= 2) throw new Error('execution reverted: "Insufficient pool liquidity"');
                return { hash: "0xok", wait: async () => ({ logs: [{}] }) };
            },
            loans: async () => [0n, sdk.wallet.address],
        };
        const res = await sdk.borrow(5, 7);
        expect(res.loanId).to.equal(3);
        expect(attempts).to.equal(3); // retried twice, succeeded on the third
    });

    it("borrow() surfaces a genuine (non-transient) revert instead of looping forever", async () => {
        const sdk = baseSdk();
        sdk.reputation = { calculateCollateralRequirement: async () => 0n };
        sdk.usdc = { allowance: async () => ethers.parseUnits("1000", 6), approve: async () => ({ wait: async () => ({}) }) };
        sdk.marketplace = {
            interface: { parseLog: () => null },
            requestLoan: async () => { throw new Error("execution reverted: Exceeds credit limit"); },
            loans: async () => [0n, sdk.wallet.address],
        };
        let threw = false;
        try { await sdk.borrow(5, 7); } catch (e) { threw = true; expect(e.message).to.match(/Exceeds credit limit/); }
        expect(threw).to.equal(true);
    });
});
