// Regression test for SpecularQuickstart.borrow validation (L2/L3).
//
// borrow() is the single choke point every LLM tool wrapper funnels through.
// It must reject NaN/Infinity/≤0 amounts and non-integer/out-of-range durations
// BEFORE any onboarding tx or on-chain call — otherwise a malformed LLM tool
// call burns gas and dies opaquely inside parseUnits or reverts on-chain.

const { expect } = require("chai");
const { ethers } = require("ethers");
const { SpecularQuickstart } = require("../../src/sdk/SpecularQuickstart.js");

// Offline provider — validation throws before any network call is attempted.
const wallet = ethers.Wallet.createRandom().connect(new ethers.JsonRpcProvider("http://localhost:1"));

async function rejects(promise, re) {
    let threw = false;
    try { await promise; } catch (e) { threw = true; expect(e.message).to.match(re); }
    expect(threw, "expected rejection").to.equal(true);
}

describe("SpecularQuickstart.borrow input validation (L2/L3)", function () {
    const sdk = new SpecularQuickstart(wallet, "arc");

    it("rejects NaN / Infinity / non-positive amounts", async () => {
        await rejects(sdk.borrow(NaN, 30), /amount must be a positive number/i);
        await rejects(sdk.borrow(Infinity, 30), /amount must be a positive number/i);
        await rejects(sdk.borrow(-5, 30), /amount must be a positive number/i);
        await rejects(sdk.borrow(0, 30), /amount must be a positive number/i);
    });

    it("rejects NaN / non-integer / out-of-range durations", async () => {
        await rejects(sdk.borrow(100, NaN), /durationDays must be an integer/i);
        await rejects(sdk.borrow(100, 7.5), /durationDays must be an integer/i);
        await rejects(sdk.borrow(100, 5), /below/i);
        await rejects(sdk.borrow(100, 400), /exceeds max/i);
    });

    it("gives a seconds-vs-days hint for the classic mistake", async () => {
        await rejects(sdk.borrow(100, 7 * 86400), /expressed in seconds/i);
    });
});
