// Regression test for SpecularSDK H1: blind-signing of API-supplied txs.
//
// register/requestLoan/repayLoan fetch an unsigned tx from `apiUrl` and sign
// it. Without validation, a compromised/MITM'd API returns
// { to: USDC, data: approve(attacker, MAX) } and the wallet drains itself.
// The fix guards every signed tx: `to` must be a known Specular/USDC address,
// and any token call must be approve(spender) to a known marketplace/router.

const { expect } = require("chai");
const { ethers } = require("ethers");
const SpecularSDK = require("../../src/sdk/SpecularSDK.js");

// Canonical addresses from the in-repo config (the trusted allowlist source).
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const MKT_BASE = "0x0a4e3C745aB95aceb45B05C28D89fe4Db8815F9a";
const REGISTRY_BASE = "0xb9996de05fD514A0cB2B81fa25448EECD4559Aaa";
const ATTACKER = "0x00000000000000000000000000000000deadbeef";

const approveCalldata = (spender, amount) =>
    "0x095ea7b3" +
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [spender, amount]).slice(2);

describe("SpecularSDK blind-signing guard (H1)", function () {
    const sdk = new SpecularSDK({ apiUrl: "https://api.specular.financial" });

    it("blocks approve(attacker) on USDC — the drain vector", function () {
        expect(() =>
            sdk._assertSafeTx({ to: USDC_BASE, data: approveCalldata(ATTACKER, ethers.MaxUint256) }, "test")
        ).to.throw(/unknown spender/i);
    });

    it("blocks non-approve token selectors (transfer/transferFrom)", function () {
        expect(() =>
            sdk._assertSafeTx({ to: USDC_BASE, data: "0xa9059cbb" + "00".repeat(64) }, "test")
        ).to.throw(/only approve/i);
    });

    it("blocks calls to an unknown (attacker) contract", function () {
        expect(() => sdk._assertSafeTx({ to: ATTACKER, data: "0x12345678" }, "test")).to.throw(
            /not a known Specular contract/i
        );
    });

    it("blocks malformed tx data", function () {
        expect(() => sdk._assertSafeTx({ to: USDC_BASE }, "test")).to.throw(/malformed/i);
    });

    it("allows approve(marketplace) on USDC — legitimate onboarding", function () {
        expect(() =>
            sdk._assertSafeTx({ to: USDC_BASE, data: approveCalldata(MKT_BASE, ethers.MaxUint256) }, "test")
        ).to.not.throw();
    });

    it("allows calls to known protocol contracts (registry, marketplace)", function () {
        expect(() => sdk._assertSafeTx({ to: REGISTRY_BASE, data: "0xdeadbeef" }, "test")).to.not.throw();
        expect(() => sdk._assertSafeTx({ to: MKT_BASE, data: "0xabcdef01" }, "test")).to.not.throw();
    });

    it("rejects plaintext http:// to a non-localhost API in the constructor", function () {
        expect(() => new SpecularSDK({ apiUrl: "http://evil.example.com" })).to.throw(/plaintext http/i);
    });

    it("still allows http://localhost for local dev", function () {
        expect(() => new SpecularSDK({ apiUrl: "http://localhost:3001" })).to.not.throw();
    });
});
