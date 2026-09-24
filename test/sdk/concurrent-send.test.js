// Regression suite for `SpecularSDK.sendTransactionSerialized` — the concurrent-send fix
// from the 2026-09-25 concurrency round.
//
// THE BUG IT REMOVES, measured on Arc staging (chainId 5042002), not hypothesised — see
// `forensics/output/testing-2026-09-25/staging-nonce-burst-result.json`, phase 7.1d:
// six IDENTICAL `supplyLiquidity(agentId, 10 USDC)` calls fired with `Promise.all` from
// ONE wallet were every one of them allocated **nonce 4** by ethers (all six read
// `eth_getTransactionCount(pending)` before any had been broadcast). Identical payload
// plus identical nonce is the SAME signed transaction, so:
//   * the RPC accepted all six with no error and returned the same hash,
//   * all six receipts came back `status: 1`,
//   * and the position moved by **10 USDC instead of 60**.
// A client that checks receipts is told six times that a transaction it never made
// succeeded. Nothing on-chain is wrong; the client's accounting is.
//
// Hardhat's own signer happens to hand out distinct nonces for concurrent sends, so the
// collapse is reproduced here the deterministic way — by pinning the nonce, which is
// exactly the state a lagging `pending` view puts a client in.

const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const SpecularSDK = require("../../src/sdk/SpecularSDK");

const USDC = (n) => ethers.parseUnits(n.toString(), 6);

describe("SDK concurrent sends (concurrency round 2026-09-25)", function () {
    this.timeout(300000);
    let owner, agent, registry, reputation, usdc, mp, mpAddr, aid;

    before(async () => {
        [owner, agent] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        reputation = await (await ethers.getContractFactory("ReputationManagerV4")).deploy(await registry.getAddress());
        usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
        mp = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV62")).deploy(
            await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
        mpAddr = await mp.getAddress();
        await reputation.authorizePool(mpAddr);
        await mp.setMinSupplyAmount(USDC(1));

        await usdc.mint(agent.address, USDC(1_000_000));
        await usdc.connect(agent).approve(mpAddr, ethers.MaxUint256);
        await registry.connect(agent).register("ipfs://conc-send", []);
        aid = await registry.addressToAgentId(agent.address);
        await mp.connect(agent).createAgentPool();
    });

    /** A fresh plain ethers wallet, funded and approved — one per test, so no test can
     *  inherit another's nonce state (which is the whole subject here). */
    async function freshLender() {
        const w = ethers.Wallet.createRandom().connect(ethers.provider);
        await owner.sendTransaction({ to: w.address, value: ethers.parseEther("10") });
        await usdc.mint(w.address, USDC(1_000_000));
        await usdc.connect(w).approve(mpAddr, ethers.MaxUint256);
        return w;
    }
    const supplyData = () => mp.interface.encodeFunctionData("supplyLiquidity", [aid, USDC(10)]);

    it("identical payload + one shared nonce is ONE transaction, however many times it is sent", async () => {
        const w = await freshLender();
        const before = (await mp.positions(aid, w.address)).amount;
        const n = await w.getNonce("pending");

        let sent;
        await network.provider.send("evm_setAutomine", [false]);
        try {
            sent = await Promise.all([...Array(4).keys()].map(() =>
                w.sendTransaction({ to: mpAddr, data: supplyData(), gasLimit: 400_000, nonce: n })
                    .then((tx) => ({ hash: tx.hash }), (e) => ({ err: e.shortMessage || e.message }))));
            await network.provider.send("evm_mine", []);
        } finally {
            await network.provider.send("evm_setAutomine", [true]);
        }

        const ok = sent.filter((x) => x.hash);
        expect(new Set(ok.map((x) => x.hash)).size, "four calls, one signed transaction").to.equal(1);
        for (const x of ok) {
            const rc = await ethers.provider.getTransactionReceipt(x.hash);
            expect(rc.status).to.equal(1);
        }
        // Only one supply actually happened, whatever the four calls reported.
        expect((await mp.positions(aid, w.address)).amount - before).to.equal(USDC(10));

        // Hardhat/EDR at least SAYS something about the duplicates ("Known transaction").
        // The Arc-staging RPC did not: it accepted all six, returned the same hash each
        // time and reported status 1 six over — which is what makes the real-chain
        // version of this silent. Either way the fix is the same: never let two sends
        // from one wallet share a nonce.
        const errs = sent.filter((x) => x.err).map((x) => x.err);
        expect(errs.length + ok.length).to.equal(4);
        if (errs.length) expect(errs.join(" | ")).to.match(/Known transaction|already known|nonce/i);
    });

    it("sendTransactionSerialized gives every concurrent call its own nonce, and all of them land", async () => {
        const w = await freshLender();
        const sdk = new SpecularSDK({ apiUrl: "http://localhost:3001", wallet: w, allowedTargets: [mpAddr] });
        const before = (await mp.positions(aid, w.address)).amount;

        let sent;
        await network.provider.send("evm_setAutomine", [false]);
        try {
            sent = await Promise.all([...Array(4).keys()].map(() =>
                sdk.sendTransactionSerialized({ to: mpAddr, data: supplyData() })));
            await network.provider.send("evm_mine", []);
        } finally {
            await network.provider.send("evm_setAutomine", [true]);
        }

        expect(new Set(sent.map((t) => t.nonce)).size, "nonces must be distinct").to.equal(4);
        expect(new Set(sent.map((t) => t.hash)).size, "transactions must be distinct").to.equal(4);
        for (const t of sent) {
            const rc = await ethers.provider.getTransactionReceipt(t.hash);
            expect(rc.status, `tx ${t.hash} failed`).to.equal(1);
        }
        expect((await mp.positions(aid, w.address)).amount - before).to.equal(USDC(40));
    });

    it("the serialised nonces are contiguous — no gap, which would make every later tx unminable", async () => {
        const w = await freshLender();
        const sdk = new SpecularSDK({ apiUrl: "http://localhost:3001", wallet: w, allowedTargets: [mpAddr] });
        const start = await w.getNonce("pending");
        let sent;
        await network.provider.send("evm_setAutomine", [false]);
        try {
            sent = await Promise.all([...Array(5).keys()].map(() =>
                sdk.sendTransactionSerialized({ to: mpAddr, data: supplyData() })));
            await network.provider.send("evm_mine", []);
        } finally {
            await network.provider.send("evm_setAutomine", [true]);
        }
        const nonces = sent.map((t) => t.nonce).sort((a, b) => a - b);
        expect(nonces).to.deep.equal([start, start + 1, start + 2, start + 3, start + 4]);
    });

    it("a failed send re-anchors the cursor instead of leaving a gap behind it", async () => {
        const w = await freshLender();
        const sdk = new SpecularSDK({ apiUrl: "http://localhost:3001", wallet: w, allowedTargets: [mpAddr] });
        const before = await w.getNonce("pending");
        // amount 0 reverts "Amount must be > 0"; with automine on, hardhat refuses it at
        // send time — the "nothing was broadcast" case, past which the cursor must NOT move.
        const bad = mp.interface.encodeFunctionData("supplyLiquidity", [aid, 0]);
        let threw = false;
        try { await sdk.sendTransactionSerialized({ to: mpAddr, data: bad }); } catch (_) { threw = true; }
        expect(threw, "the reverting send should have thrown").to.equal(true);

        const tx = await sdk.sendTransactionSerialized({ to: mpAddr, data: supplyData() });
        const rc = await tx.wait();
        expect(rc.status).to.equal(1);
        expect(tx.nonce, "a gap was left behind the failed send").to.equal(before);
    });

    it("falls back cleanly for a wallet without getNonce (custom signers, test doubles)", async () => {
        const calls = [];
        const stub = {
            address: owner.address,
            provider: ethers.provider,
            sendTransaction: async (req) => { calls.push(req); return { hash: `0x${"ab".repeat(32)}` }; },
        };
        const sdk = new SpecularSDK({ apiUrl: "http://localhost:3001", wallet: stub, allowedTargets: [mpAddr] });
        const out = await Promise.all([1, 2, 3].map(() => sdk.sendTransactionSerialized({ to: mpAddr, data: supplyData() })));
        expect(out).to.have.length(3);
        expect(calls).to.have.length(3);
        for (const c of calls) expect(c.nonce, "no nonce should be forced onto a wallet that cannot report one").to.equal(undefined);
    });
});
