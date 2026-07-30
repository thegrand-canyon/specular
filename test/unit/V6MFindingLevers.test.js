// Tests for the M-1 / M-2 owner-configurable protective levers (audit 2026-07).
// Both default to CURRENT behavior (off); the owner enables them per risk
// tolerance. Redeploy ships the mechanism so no further redeploy is needed.
//
// M-1 (bindBorrowToPoolCreator): a transferred agent NFT must not be able to
//     borrow against existing lenders once enabled.
// M-2 (minHoldForReputationReward): an on-time repayment earns reputation only
//     if the loan was held long enough — blunts request→repay farming.

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("V6 — M-finding protective levers (M-1/M-2)", function () {
    let v6, registry, reputation, usdc;
    let owner, agent, buyer, lender;
    const USDC = (n) => ethers.parseUnits(n.toString(), 6);

    beforeEach(async () => {
        [owner, agent, buyer, lender] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        reputation = await (await ethers.getContractFactory("ReputationManagerV3")).deploy(await registry.getAddress());
        usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
        v6 = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV6")).deploy(
            await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress()
        );
        await reputation.authorizePool(await v6.getAddress());
        await registry.connect(agent).register("ipfs://agent", []);
        await v6.connect(agent).createAgentPool();
        for (const w of [agent, buyer, lender]) {
            await usdc.mint(w.address, USDC(100_000));
            await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256);
        }
        await v6.connect(lender).supplyLiquidity(1, USDC(10_000));
    });

    describe("defaults preserve current behavior", () => {
        it("both levers default off", async () => {
            expect(await v6.minHoldForReputationReward()).to.equal(0n);
            expect(await v6.bindBorrowToPoolCreator()).to.equal(false);
        });
        it("with defaults, an on-time repay still earns reputation immediately", async () => {
            await v6.connect(agent).requestLoan(USDC(10), 30);
            await v6.connect(agent).repayLoan(1);
            expect(await reputation["getReputationScore(address)"](agent.address)).to.be.gt(0n);
        });
    });

    describe("M-2 — minHoldForReputationReward", () => {
        it("gates the reputation reward on hold time when enabled", async () => {
            await v6.setMinHoldForReputationReward(24 * 60 * 60); // 1 day
            // Immediate repay → no reputation reward.
            await v6.connect(agent).requestLoan(USDC(10), 30);
            await v6.connect(agent).repayLoan(1);
            expect(await reputation["getReputationScore(address)"](agent.address)).to.equal(0n);

            // Hold ≥ 1 day, then repay → reward applies.
            await v6.connect(agent).requestLoan(USDC(10), 30);
            await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
            await ethers.provider.send("evm_mine", []);
            await v6.connect(agent).repayLoan(2);
            expect(await reputation["getReputationScore(address)"](agent.address)).to.be.gt(0n);
        });
        it("rejects a min hold above the max loan duration", async () => {
            await expect(v6.setMinHoldForReputationReward(400 * 24 * 60 * 60)).to.be.revertedWith("Min hold exceeds max duration");
        });
        it("only owner can set it", async () => {
            await expect(v6.connect(agent).setMinHoldForReputationReward(3600)).to.be.reverted;
        });
    });

    describe("M-1 — bindBorrowToPoolCreator", () => {
        it("blocks a transferred-NFT owner from borrowing when enabled", async () => {
            await v6.setBindBorrowToPoolCreator(true);
            // Before transfer, the creator can borrow normally.
            await expect(v6.connect(agent).requestLoan(USDC(10), 30)).to.not.be.reverted;

            // Transfer the agent NFT to buyer. buyer now maps to agentId 1 but is
            // NOT the pool creator → blocked by the M-1 lever. (The creator is
            // also blocked, now via "Not a registered agent" since they gave up
            // the NFT — so the pool is effectively frozen for borrowing on
            // transfer, protecting existing lenders.)
            await registry.connect(agent).transferFrom(agent.address, buyer.address, 1);
            await expect(v6.connect(buyer).requestLoan(USDC(10), 30)).to.be.revertedWith("Borrow restricted to pool creator");
            await expect(v6.connect(agent).requestLoan(USDC(10), 30)).to.be.revertedWith("Not a registered agent");
        });
        it("with the lever off, a transferred-NFT owner can borrow (current behavior)", async () => {
            await registry.connect(agent).transferFrom(agent.address, buyer.address, 1);
            await expect(v6.connect(buyer).requestLoan(USDC(10), 30)).to.not.be.reverted;
        });
        it("only owner can toggle it", async () => {
            await expect(v6.connect(agent).setBindBorrowToPoolCreator(true)).to.be.reverted;
        });
    });
});
