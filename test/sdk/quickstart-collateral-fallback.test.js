// Regression test for the collateral-approval fallback (2026-08). The current
// SDK's D2 exact-approval broke against the DEPLOYED Base V6, which pulls
// marginally MORE collateral than amount*pct/100 (surfaced by the live P4
// journey). borrow()/repay() now: approve exact, and on an allowance revert,
// approve a bounded buffer, retry once, then revoke the leftover.
//
// Pure-JS test: bypass the constructor and wire mock contracts so we can force
// the "exact approval too low" condition (the fixed V6 pulls exactly, so it
// can't reproduce it on-chain).

const { expect } = require("chai");
const { ethers } = require("ethers");
const { SpecularQuickstart } = require("../../src/sdk/SpecularQuickstart.js");

function makeSdk() {
    const sdk = Object.create(SpecularQuickstart.prototype);
    sdk.cfg = { decimals: 6 };
    sdk.network = "arc-staging";
    sdk.wallet = { address: "0x" + "11".repeat(20) };
    sdk.addresses = { marketplace: "0x" + "22".repeat(20) };

    const state = {
        allowance: 0n,
        approvals: [],   // every approve() amount, in order
        requestAttempts: [], // allowance seen at each requestLoan attempt
        collateralPulled: 0n,
        revoked: false,
    };

    // Mock USDC allowance/approve.
    sdk.usdc = {
        allowance: async () => state.allowance,
        approve: async (_spender, amt) => {
            state.approvals.push(amt);
            state.allowance = amt;
            return { wait: async () => ({}) };
        },
    };
    // Fresh agent → 100% collateral.
    sdk.reputation = { calculateCollateralRequirement: async () => 100n };

    // Marketplace that pulls collateral = amount + 1 base unit (contract wants
    // MORE than the exact formula) — reverts if allowance can't cover it.
    sdk.marketplace = {
        interface: { parseLog: () => ({ name: "LoanRequested", args: { loanId: 7n } }) },
        requestLoan: async (amt /*, dur */) => {
            const needed = amt + 1n; // pulls 1 base unit more than exact
            state.requestAttempts.push(state.allowance);
            if (state.allowance < needed) {
                throw new Error('execution reverted: "ERC20: transfer amount exceeds allowance"');
            }
            state.allowance -= needed; // consume
            state.collateralPulled = needed;
            return { hash: "0xloan", wait: async () => ({ logs: [{}] }) };
        },
        loans: async () => ({ 1: sdk.wallet.address, "1": sdk.wallet.address }),
    };
    // loans() poll returns the borrower at index 1.
    sdk.marketplace.loans = async () => [0n, sdk.wallet.address];

    return { sdk, state };
}

describe("SpecularQuickstart collateral-approval fallback", function () {
    it("retries with a bounded buffer when the contract pulls more than exact, then revokes leftover", async () => {
        const { sdk, state } = makeSdk();
        sdk.onboard = async () => {}; // skip onboarding

        const res = await sdk.borrow(0.5, 7);
        expect(res.loanId).to.equal(7);

        // First approval is EXACT collateral (0.5 USDC); the exact path is tried first.
        expect(state.approvals[0]).to.equal(ethers.parseUnits("0.5", 6));
        // Two requestLoan attempts: exact (rejected), buffered (succeeds).
        expect(state.requestAttempts.length).to.equal(2);
        // Buffer approval = collateral + principal (0.5 + 0.5 = 1.0 USDC) — bounded.
        expect(state.approvals[1]).to.equal(ethers.parseUnits("1.0", 6));
        // Leftover allowance was revoked (final approve to 0).
        expect(state.approvals[state.approvals.length - 1]).to.equal(0n);
        expect(state.allowance).to.equal(0n);
    });

    it("common path stays EXACT: one approval, one attempt, no buffer/revoke when the contract pulls exactly", async () => {
        const { sdk, state } = makeSdk();
        sdk.onboard = async () => {};
        // Override marketplace to pull EXACTLY the formula amount.
        sdk.marketplace.requestLoan = async (amt) => {
            state.requestAttempts.push(state.allowance);
            if (state.allowance < amt) throw new Error('exceeds allowance');
            state.allowance -= amt;
            return { hash: "0xloan", wait: async () => ({ logs: [{}] }) };
        };

        await sdk.borrow(0.5, 7);
        // Exactly one approval (the exact collateral) and one requestLoan attempt.
        expect(state.requestAttempts.length).to.equal(1);
        // No buffer approval; allowance already 0 so revoke is a no-op (no extra approve).
        expect(state.approvals).to.deep.equal([ethers.parseUnits("0.5", 6)]);
    });
});
