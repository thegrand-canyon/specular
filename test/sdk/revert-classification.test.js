// Regression suite for `src/sdk/revert.js` — the client-side race handling added by the
// 2026-09-25 concurrency round.
//
// WHY THIS EXISTS. Every local race in that round ended the same way: the contract is
// safe, and the loser of the race gets a revert. What the loser then DOES is a client
// decision, and the SDK gave it nothing to decide with — `SpecularSDK` threw
// "Loan request tx 0xabc… reverted on-chain", with no reason and no hint of whether the
// same call would succeed if simply re-sent. Two of the most common contended refusals
// ("Insufficient pool liquidity", "Pool lender capacity reached") are exactly the ones a
// client SHOULD retry, and one ("Loan not active") is the one it must NOT retry because
// it may mean the loan was liquidated.
//
// These tests build the failures on a real chain — including a genuinely
// position-dependent one inside a hand-built block — and assert the classification.

const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const {
    decodeRevertData, classifyRevertReason, explainFailedTx, RETRYABLE, ACTIONABLE,
} = require("../../src/sdk/revert");

const USDC = (n) => ethers.parseUnits(n.toString(), 6);
const DAY = 24 * 60 * 60;

describe("SDK revert classification (concurrency round 2026-09-25)", function () {
    this.timeout(300000);
    let owner, agent, lender, other, registry, reputation, usdc, mp, mpAddr, aid;

    before(async () => {
        [owner, agent, lender, other] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        reputation = await (await ethers.getContractFactory("ReputationManagerV4")).deploy(await registry.getAddress());
        usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
        mp = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV62")).deploy(
            await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
        mpAddr = await mp.getAddress();
        await reputation.authorizePool(mpAddr);
        await mp.setMinSupplyAmount(USDC(10));
        await mp.setMinHoldForReputationReward(0);

        for (const w of [agent, lender, other]) {
            await usdc.mint(w.address, USDC(1_000_000));
            await usdc.connect(w).approve(mpAddr, ethers.MaxUint256);
        }
        await registry.connect(agent).register("ipfs://revert-test", []);
        aid = await registry.addressToAgentId(agent.address);
        await mp.connect(agent).createAgentPool();
        await mp.connect(lender).supplyLiquidity(aid, USDC(500));
    });

    // ───────────────────────────────────────────────────────── pure decoding
    it("decodes Error(string) and Panic(uint) revert payloads", () => {
        const enc = ethers.concat(["0x08c379a0", ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["Insufficient pool liquidity"])]);
        expect(decodeRevertData(enc)).to.equal("Insufficient pool liquidity");
        const panic = ethers.concat(["0x4e487b71", ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [0x11])]);
        expect(decodeRevertData(panic)).to.equal("Panic(0x11)");
        expect(decodeRevertData("0x")).to.equal(null);
        expect(decodeRevertData(null)).to.equal(null);
    });

    // ──────────────────────────────────────────── the classification table
    it("classifies the contended refusals as retryable and the caller's own mistakes as not", () => {
        for (const r of [
            "Insufficient pool liquidity", "Pool lender capacity reached",
            "Last slot reserved for agent self-stake", "Top-up would forfeit in-flight interest",
            "Drain underflow", "Pausable: paused",
        ]) {
            expect(classifyRevertReason(r).class, `${r} should be retryable`).to.equal(RETRYABLE);
        }
        for (const r of [
            "Exceeds credit limit", "Too many active loans", "Insufficient self-stake",
            "Self-stake locked while borrowing", "ERC20InsufficientAllowance(0x0, 0, 1)",
        ]) {
            expect(classifyRevertReason(r).class, `${r} should be actionable`).to.equal(ACTIONABLE);
        }
        for (const r of ["Amount must be > 0", "Invalid duration", "Not a registered agent", "Loan not active"]) {
            expect(classifyRevertReason(r).class, `${r} should not be retryable`).to.not.equal(RETRYABLE);
        }
        // the one that must never be retried blindly, and must say why
        const la = classifyRevertReason("Loan not active");
        expect(la.advice).to.match(/liquidat/i);
    });

    it("gives every classification an actionable sentence, and never returns an empty reason", () => {
        for (const r of ["Insufficient pool liquidity", "something nobody mapped", ""]) {
            const c = classifyRevertReason(r);
            expect(c.reason.length, `empty reason for "${r}"`).to.be.greaterThan(0);
            expect(c.advice.length).to.be.greaterThan(0);
            expect([RETRYABLE, ACTIONABLE, "terminal"]).to.include(c.class);
        }
    });

    // ───────────────────────────────── real on-chain failures, mined and explained
    it("explains a real failed transaction from its receipt (reason + class), and returns null for a successful one", async () => {
        // hardhat rejects a failing transaction at SEND time while automine is on, so the
        // only way to get a mined-but-failed receipt (which is what a real chain hands a
        // client) is to build the block by hand.
        await network.provider.send("evm_setAutomine", [false]);
        const tx = await mp.connect(lender).withdrawLiquidity(aid, USDC(100_000), { gasLimit: 300_000 });
        await network.provider.send("evm_mine", []);
        await network.provider.send("evm_setAutomine", [true]);
        const rc = await ethers.provider.getTransactionReceipt(tx.hash);
        expect(rc.status).to.equal(0);
        const x = await explainFailedTx(ethers.provider, tx.hash);
        expect(x.reason).to.equal("Insufficient balance");
        expect(x.class).to.equal(ACTIONABLE);
        expect(x.hash).to.equal(tx.hash);

        const ok = await mp.connect(other).supplyLiquidity(aid, USDC(50));
        await ok.wait();
        expect(await explainFailedTx(ethers.provider, ok.hash)).to.equal(null);
    });

    it("flags a POSITION-DEPENDENT failure: a withdrawal placed ahead of the repayment that funds it", async () => {
        // drain the pool with a loan, then build one block: [withdraw, repay]
        await mp.connect(agent).supplyLiquidity(aid, USDC(600));
        await reputation.authorizePool(owner.address);
        // give the agent a ladder big enough to draw the pool down
        await reputation.recordBorrow(agent.address, 9_000_001, USDC(600));
        await network.provider.send("evm_increaseTime", [7 * DAY]);
        await network.provider.send("evm_mine", []);
        await reputation.recordLoanCompletion(agent.address, 9_000_001, USDC(600), true, 0);

        const loanId = await mp.nextLoanId();
        await mp.connect(agent).requestLoan(USDC(1000), 7);
        const avail = (await mp.getAgentPool(aid)).availableLiquidity;
        expect(avail < USDC(500)).to.equal(true);

        await network.provider.send("evm_setAutomine", [false]);
        const wTx = await mp.connect(lender).withdrawLiquidity(aid, USDC(500), { gasLimit: 400_000 });
        const rTx = await mp.connect(agent).repayLoan(loanId, { gasLimit: 1_500_000 });
        await network.provider.send("evm_mine", []);
        await network.provider.send("evm_setAutomine", [true]);

        const wRc = await ethers.provider.getTransactionReceipt(wTx.hash);
        const rRc = await ethers.provider.getTransactionReceipt(rTx.hash);
        expect(rRc.status, "the repayment should have landed").to.equal(1);
        expect(wRc.status, "the withdrawal should have lost the race").to.equal(0);

        const x = await explainFailedTx(ethers.provider, wTx.hash);
        expect(x.reason).to.equal("Insufficient pool liquidity");
        expect(x.class).to.equal(RETRYABLE);
        expect(x.positional, "a revert curable by re-sending must be flagged positional").to.equal(true);
        expect(x.positionalNote).to.equal("would-succeed-if-placed-later");
        expect(x.advice).to.match(/retry|re-?send|again/i);
    });

    // ───────────────────────────────── the SDK surfaces it instead of swallowing it
    it("SpecularSDK.requestLoan throws an error carrying the reason, class and retryable flag", async () => {
        const SpecularSDK = require("../../src/sdk/SpecularSDK");
        // Produce a REAL mined-but-failed transaction. (`other` is not a registered agent,
        // so requestLoan reverts "Not a registered agent".) A client on a live chain sees
        // exactly this: the transaction was broadcast, mined, and has status 0.
        const data = mp.interface.encodeFunctionData("requestLoan", [USDC(10), 7]);
        await network.provider.send("evm_setAutomine", [false]);
        const raw = await other.sendTransaction({ to: mpAddr, data, gasLimit: 900_000 });
        await network.provider.send("evm_mine", []);
        await network.provider.send("evm_setAutomine", [true]);
        expect((await ethers.provider.getTransactionReceipt(raw.hash)).status).to.equal(0);

        // The SDK signs and broadcasts through `this.wallet`; stub that one step so the
        // test exercises the SDK's FAILURE HANDLING rather than hardhat's send-time
        // simulation (which rejects a reverting call before it is ever broadcast).
        const stubWallet = { address: other.address, provider: ethers.provider, sendTransaction: async () => raw };
        const sdk = new SpecularSDK({ apiUrl: "http://localhost:3001", wallet: stubWallet, allowedTargets: [mpAddr] });
        const realFetch = global.fetch;
        global.fetch = async () => ({ ok: true, status: 200, statusText: "OK", json: async () => ({ to: mpAddr, data }) });
        try {
            let caught = null;
            try { await sdk.requestLoan({ amount: USDC(10).toString(), durationDays: 7 }); } catch (e) { caught = e; }
            expect(caught, "requestLoan should have thrown").to.not.equal(null);
            expect(caught.message).to.match(/Not a registered agent/);
            expect(caught.revertReason).to.equal("Not a registered agent");
            expect(caught.failureClass).to.equal("terminal");
            expect(caught.retryable).to.equal(false);
            expect(caught.txHash).to.equal(raw.hash);
            expect(caught.advice).to.match(/register/i);
        } finally {
            global.fetch = realFetch;
        }
    });
});
