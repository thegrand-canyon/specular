// Regression test for x402 server hardening F4/F5/F6.
//
// F4: stub mode (no payment verification) must require explicit opt-in.
// F5: payment `resource` uses a server-configured baseUrl, not client Host.
// F6: /__specular_x402/stats is loopback-only (or token-gated); 500s are generic.

const { expect } = require("chai");
const path = require("path");

// The server constructor needs a network config + a private key. Use arc
// (facilitator-less → default mode 'stub') with a throwaway key.
const { SpecularX402Server } = require("../../src/sdk/x402/SpecularX402Server.js");
const DUMMY_KEY = "0x" + "11".repeat(32);

function makeOpts(extra = {}) {
    return { network: "arc", privateKey: DUMMY_KEY, ...extra };
}

describe("SpecularX402Server hardening (F4/F5/F6)", function () {
    describe("F4 — stub opt-in", function () {
        it("refuses stub mode without an explicit opt-in", function () {
            delete process.env.SPECULAR_X402_ALLOW_STUB;
            expect(() => new SpecularX402Server(makeOpts({ mode: "stub" }))).to.throw(/stub mode/i);
        });
        it("allows stub with { allowStub: true }", function () {
            expect(() => new SpecularX402Server(makeOpts({ mode: "stub", allowStub: true }))).to.not.throw();
        });
        it("allows stub with SPECULAR_X402_ALLOW_STUB=1", function () {
            process.env.SPECULAR_X402_ALLOW_STUB = "1";
            try {
                expect(() => new SpecularX402Server(makeOpts({ mode: "stub" }))).to.not.throw();
            } finally {
                delete process.env.SPECULAR_X402_ALLOW_STUB;
            }
        });
    });

    describe("F5 — server-derived resource", function () {
        it("uses configured baseUrl instead of the client Host header", function () {
            const s = new SpecularX402Server(makeOpts({ mode: "stub", allowStub: true, baseUrl: "https://api.example.com/" }));
            const req = { headers: { host: "evil.attacker.com", "x-forwarded-host": "evil.attacker.com" } };
            const reqs = s._paymentRequirements(req, "/transcribe", 0.5);
            expect(reqs.accepts[0].resource).to.equal("https://api.example.com/transcribe");
        });
        it("falls back to Host header only when no baseUrl configured", function () {
            const s = new SpecularX402Server(makeOpts({ mode: "stub", allowStub: true }));
            const req = { headers: { host: "myhost:3000" } };
            const reqs = s._paymentRequirements(req, "/x", 0.5);
            expect(reqs.accepts[0].resource).to.equal("http://myhost:3000/x");
        });
    });

    describe("F6 — stats gating", function () {
        const server = () => new SpecularX402Server(makeOpts({ mode: "stub", allowStub: true }));
        const loopback = { socket: { remoteAddress: "127.0.0.1" } };
        const remote = { socket: { remoteAddress: "203.0.113.7" }, headers: {} };

        it("allows loopback callers when no token is set", function () {
            expect(server()._statsAllowed({ ...loopback, headers: {} })).to.equal(true);
        });
        it("blocks remote callers when no token is set", function () {
            expect(server()._statsAllowed(remote)).to.equal(false);
        });
        it("with a token, requires the correct Bearer and ignores IP", function () {
            const s = new SpecularX402Server(makeOpts({ mode: "stub", allowStub: true, statsToken: "sekret" }));
            expect(s._statsAllowed({ socket: { remoteAddress: "203.0.113.7" }, headers: { authorization: "Bearer sekret" } })).to.equal(true);
            expect(s._statsAllowed({ socket: { remoteAddress: "127.0.0.1" }, headers: { authorization: "Bearer wrong" } })).to.equal(false);
            expect(s._statsAllowed({ socket: { remoteAddress: "127.0.0.1" }, headers: {} })).to.equal(false);
        });
    });
});
