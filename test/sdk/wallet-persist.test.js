// Regression test for walletPersist H2: plaintext keys on disk + path traversal.
//
// Old behavior: wrote raw { privateKey } JSON to tmpdir, publicly exported,
// with an unsanitized `label` (path traversal) and no opt-in gate.
// Hardened: encrypted ethers keystore, SPECULAR_ALLOW_KEY_PERSIST gate,
// password required, label sanitized, legacy plaintext migrated on load.

const { expect } = require("chai");
const { ethers } = require("ethers");
const fs = require("fs");
const os = require("os");
const path = require("path");
const wp = require("../../src/sdk/walletPersist.js");

// Offline provider — createRandom().connect and fromEncryptedJson never hit it.
const provider = new ethers.JsonRpcProvider();

describe("walletPersist hardening (H2)", function () {
    this.timeout(20000); // scrypt keystore encrypt/decrypt is intentionally slow

    let dir;
    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "wp-test-"));
        process.env.SPECULAR_ALLOW_KEY_PERSIST = "1";
        process.env.SPECULAR_KEYSTORE_PASSWORD = "testpass123";
    });
    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
        delete process.env.SPECULAR_ALLOW_KEY_PERSIST;
        delete process.env.SPECULAR_KEYSTORE_PASSWORD;
    });

    it("refuses to run without the opt-in flag", async () => {
        delete process.env.SPECULAR_ALLOW_KEY_PERSIST;
        await expectReject(wp.loadOrCreateWallet({ label: "x", provider, persistDir: dir }), /disabled/i);
    });

    it("rejects path-traversal labels", async () => {
        await expectReject(
            wp.loadOrCreateWallet({ label: "../../evil", provider, persistDir: dir }),
            /invalid label/i
        );
        expect(() => wp.peekAddress("../../evil", dir)).to.throw(/invalid label/i);
    });

    it("requires a keystore password", async () => {
        delete process.env.SPECULAR_KEYSTORE_PASSWORD;
        await expectReject(wp.loadOrCreateWallet({ label: "x", provider, persistDir: dir }), /PASSWORD/i);
    });

    it("stores an ENCRYPTED keystore (no plaintext privateKey) with mode 0600", async () => {
        const w = await wp.loadOrCreateWallet({ label: "lt", provider, persistDir: dir });
        const file = path.join(dir, "lt.json");
        const content = fs.readFileSync(file, "utf8");
        expect(content).to.not.include("privateKey");
        expect(content.toLowerCase()).to.include("crypto");
        expect((fs.statSync(file).mode & 0o777).toString(8)).to.equal("600");
        // reload + peek recover the same address
        const w2 = await wp.loadOrCreateWallet({ label: "lt", provider, persistDir: dir });
        expect(w2.address).to.equal(w.address);
        expect(wp.peekAddress("lt", dir).toLowerCase()).to.equal(w.address.toLowerCase());
    });

    it("migrates a legacy plaintext keyfile to encrypted form, preserving the address", async () => {
        const legacyWallet = ethers.Wallet.createRandom();
        const file = path.join(dir, "legacy.json");
        fs.writeFileSync(file, JSON.stringify({ privateKey: legacyWallet.privateKey, address: legacyWallet.address }));
        const migrated = await wp.loadOrCreateWallet({ label: "legacy", provider, persistDir: dir });
        expect(migrated.address).to.equal(legacyWallet.address);
        const after = fs.readFileSync(file, "utf8");
        expect(after).to.not.include("privateKey");
        expect(after.toLowerCase()).to.include("crypto");
    });
});

async function expectReject(promise, re) {
    let threw = false;
    try {
        await promise;
    } catch (e) {
        threw = true;
        expect(e.message).to.match(re);
    }
    expect(threw, "expected promise to reject").to.equal(true);
}
