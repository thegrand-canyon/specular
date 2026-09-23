// Regression test for legacy x402Client F1: no spend cap / token substitution.
//
// Old behavior: _buildPaymentHeader signed an EIP-3009 authorization for
// whatever amount/token the server's 402 named, with no cap — a hostile paywall
// could name the buyer's whole balance and any token contract, draining them.
// Fix: default per-payment cap (raise explicitly), optional lifetime cap, and a
// verifyingContract pin against the known USDC per network.

const { expect } = require("chai");
const { ethers } = require("ethers");
const x402Client = require("../../src/x402/x402Client.js");

const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ATTACKER_TOKEN = "0x00000000000000000000000000000000deadbeef";
const PAYTO = "0x1111111111111111111111111111111111111111";

const req = (amt, { token = USDC_BASE, network = "base", extra } = {}) => ({
    maxAmountRequired: String(amt),
    payTo: PAYTO,
    asset: token,
    network,
    extra,
});

async function rejects(promise, re) {
    let threw = false;
    try { await promise; } catch (e) { threw = true; expect(e.message).to.match(re); }
    expect(threw, "expected rejection").to.equal(true);
}

describe("legacy x402Client spend cap + token pinning (F1)", function () {
    const wallet = ethers.Wallet.createRandom();

    it("blocks a payment above the default 10 USDC cap", async () => {
        const c = new x402Client(wallet);
        await rejects(c._buildPaymentHeader(req(100_000000)), /exceeds maxPayment/i);
    });

    it("blocks a whole-balance-sized payment", async () => {
        const c = new x402Client(wallet);
        await rejects(c._buildPaymentHeader(req(1_000_000_000000)), /exceeds maxPayment/i);
    });

    it("signs a payment under the cap", async () => {
        const c = new x402Client(wallet);
        const header = await c._buildPaymentHeader(req(5_000000));
        expect(header).to.be.a("string").with.length.greaterThan(0);
    });

    it("blocks token substitution via asset address", async () => {
        const c = new x402Client(wallet, { maxPayment: 1000_000000n });
        await rejects(
            c._buildPaymentHeader(req(1_000000, { token: ATTACKER_TOKEN })),
            /not the known USDC/i
        );
    });

    it("blocks token substitution via server-supplied eip712Domain", async () => {
        const c = new x402Client(wallet, { maxPayment: 1000_000000n });
        const extra = { eip712Domain: { name: "X", version: "1", chainId: 8453, verifyingContract: ATTACKER_TOKEN } };
        await rejects(c._buildPaymentHeader(req(1_000000, { extra })), /not the known USDC/i);
    });

    it("enforces maxTotalSpend across multiple payments", async () => {
        const c = new x402Client(wallet, { maxPayment: 1000_000000n, maxTotalSpend: 8_000000n });
        await c._buildPaymentHeader(req(5_000000)); // ok, total 5
        await rejects(c._buildPaymentHeader(req(5_000000)), /maxTotalSpend/i); // 10 > 8
    });

    it("allows opt-out via maxPayment:null for large authorized payments", async () => {
        const c = new x402Client(wallet, { maxPayment: null });
        const header = await c._buildPaymentHeader(req(100_000000));
        expect(header).to.be.a("string");
    });

    it("rejects non-positive amounts and invalid payTo", async () => {
        const c = new x402Client(wallet);
        await rejects(c._buildPaymentHeader(req(0)), /non-positive/i);
        await rejects(
            c._buildPaymentHeader({ maxAmountRequired: "1000000", payTo: "not-an-address", asset: USDC_BASE, network: "base" }),
            /invalid payTo/i
        );
    });

    it("refuses to sign on an unrecognized network (no USDC to pin against)", async () => {
        const c = new x402Client(wallet, { maxPayment: 1000_000000n });
        await rejects(
            c._buildPaymentHeader(req(1_000000, { network: "polygon", extra: { chainId: 137 } })),
            /unrecognized network/i
        );
    });

    it("allows base-sepolia against its known Circle USDC", async () => {
        const c = new x402Client(wallet);
        const BASE_SEPOLIA_USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
        const header = await c._buildPaymentHeader(req(1_000000, { token: BASE_SEPOLIA_USDC, network: "base-sepolia" }));
        expect(header).to.be.a("string");
    });

    it("allows an unknown network only when allowUntrustedToken is set", async () => {
        const c = new x402Client(wallet, { maxPayment: 1000_000000n, allowUntrustedToken: true });
        const header = await c._buildPaymentHeader(req(1_000000, { network: "polygon", extra: { chainId: 137 } }));
        expect(header).to.be.a("string");
    });

    it("signs at most ONE authorization per request even if the server keeps returning 402", async () => {
        // A hostile paywall that always 402s must not be able to collect multiple
        // independently-settleable authorizations (each _buildPaymentHeader mints
        // a fresh-nonce EIP-3009 auth).
        const c = new x402Client(wallet);
        let signCount = 0;
        const realBuild = c._buildPaymentHeader.bind(c);
        c._buildPaymentHeader = async (r) => { signCount++; return realBuild(r); };
        // Server always answers 402 with valid requirements.
        c._rawFetch = async () => ({
            status: 402,
            body: { accepts: [{ maxAmountRequired: "1000000", payTo: PAYTO, asset: USDC_BASE, network: "base", extra: {} }] },
        });
        // _parseRequirements pulls accepts[0].
        let threw = false;
        try { await c.get("http://paywall.example/x"); } catch { threw = true; }
        expect(threw, "should give up rather than keep paying").to.equal(true);
        expect(signCount, "must sign at most one authorization").to.equal(1);
    });
});
