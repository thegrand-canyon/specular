// Tests for the 4 fixes from CLAUDE_REVIEW.md.

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("V6 — Claude review fixes (4 low-severity findings)", function () {
    let v6, registry, reputation, usdc;
    let owner, agent, lender, other;
    const USDC = (n) => ethers.parseUnits(n.toString(), 6);

    beforeEach(async () => {
        [owner, agent, lender, other] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("AgentRegistryV2");
        registry = await Registry.deploy();
        const Rep = await ethers.getContractFactory("ReputationManagerV3");
        reputation = await Rep.deploy(await registry.getAddress());
        const Mock = await ethers.getContractFactory("MockUSDC");
        usdc = await Mock.deploy();
        const V6 = await ethers.getContractFactory("AgentLiquidityMarketplaceV6");
        v6 = await V6.deploy(
            await registry.getAddress(),
            await reputation.getAddress(),
            await usdc.getAddress()
        );
        await reputation.authorizePool(await v6.getAddress());
        await registry.connect(agent).register("ipfs://agent", []);
        await v6.connect(agent).createAgentPool();
        for (const w of [agent, lender]) {
            await usdc.mint(w.address, USDC(10_000));
            await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256);
        }
    });

    describe("Fix 1: seedPool validates agentAddress matches registry", () => {
        it("rejects seedPool with mismatched agentAddress (random address)", async () => {
            // owner.address is NOT registered as any agent
            await expect(
                v6.seedPool(99, owner.address, USDC(100), USDC(100), 0)
            ).to.be.revertedWith("agentAddress/agentId mismatch");
        });

        it("rejects seedPool with mismatched agentId (registered address but wrong agentId)", async () => {
            // agent.address is registered as agentId 1, not 99
            await expect(
                v6.seedPool(99, agent.address, USDC(100), USDC(100), 0)
            ).to.be.revertedWith("agentAddress/agentId mismatch");
        });

        it("accepts seedPool with matched registry data", async () => {
            // Register a new agent
            await registry.connect(lender).register("ipfs://test", []);
            const aid = await registry.addressToAgentId(lender.address);
            await v6.seedPool(aid, lender.address, USDC(100), USDC(100), 0);
            const pool = await v6.getAgentPool(aid);
            expect(pool.totalLiquidity).to.equal(USDC(100));
        });

        it("still validates after agent registration but before mint of token", async () => {
            // Just register, no mint
            await registry.connect(other).register("ipfs://other", []);
            const aid = await registry.addressToAgentId(other.address);
            // seedPool should succeed even without mint state
            await v6.seedPool(aid, other.address, 0, 0, 0);
            // Use raw mapping accessor to inspect isActive
            const raw = await v6.agentPools(aid);
            expect(raw.isActive).to.equal(true);
        });
    });

    describe("Fix 2: seedPosition enforces Σ positions ≤ pool.totalLiquidity", () => {
        beforeEach(async () => {
            // Seed pool with totalLiquidity = 100 USDC
            await v6.seedPool(1, agent.address, USDC(100), USDC(100), 0);
        });

        it("accepts a single position equal to totalLiquidity", async () => {
            await v6.seedPosition(1, lender.address, USDC(100), 0, 0);
            const pos = await v6.positions(1, lender.address);
            expect(pos.amount).to.equal(USDC(100));
        });

        it("accepts two positions summing exactly to totalLiquidity", async () => {
            await v6.seedPosition(1, lender.address, USDC(60), 0, 0);
            await v6.seedPosition(1, other.address, USDC(40), 0, 0);
            const sumPos = (await v6.positions(1, lender.address)).amount + (await v6.positions(1, other.address)).amount;
            expect(sumPos).to.equal(USDC(100));
        });

        it("rejects when Σ positions would exceed totalLiquidity", async () => {
            await v6.seedPosition(1, lender.address, USDC(80), 0, 0);
            // Trying to seed another 30 → sum=110 > totalLiq=100 → revert
            await expect(
                v6.seedPosition(1, other.address, USDC(30), 0, 0)
            ).to.be.revertedWith("Position sum exceeds totalLiquidity");
        });

        it("allows reducing a position to free room for another", async () => {
            await v6.seedPosition(1, lender.address, USDC(80), 0, 0);
            // Reduce lender's position to 30, now there's 70 room
            await v6.seedPosition(1, lender.address, USDC(30), 0, 0);
            // Now seed other at 60 (total = 30+60 = 90 ≤ 100)
            await v6.seedPosition(1, other.address, USDC(60), 0, 0);
            expect((await v6.positions(1, lender.address)).amount).to.equal(USDC(30));
            expect((await v6.positions(1, other.address)).amount).to.equal(USDC(60));
        });

        it("rejects single position exceeding totalLiquidity alone", async () => {
            await expect(
                v6.seedPosition(1, lender.address, USDC(101), 0, 0)
            ).to.be.revertedWith("Position sum exceeds totalLiquidity");
        });
    });

    describe("Fix 3: requestLoan rejects amount=0", () => {
        beforeEach(async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(100));
        });

        it("rejects requestLoan(0, 7)", async () => {
            await expect(v6.connect(agent).requestLoan(0, 7))
                .to.be.revertedWith("Amount must be > 0");
        });

        it("still accepts requestLoan(amount > 0)", async () => {
            await v6.connect(agent).requestLoan(USDC(10), 7);
            expect(await v6.activeLoanCount(1)).to.equal(1);
        });

        it("an agent can no longer block their own slot with 0-amount loans", async () => {
            // Pre-fix: 10× zero-loans would fill MAX_ACTIVE_LOANS cap
            for (let i = 0; i < 10; i++) {
                await expect(v6.connect(agent).requestLoan(0, 7))
                    .to.be.revertedWith("Amount must be > 0");
            }
            // Cap is still empty
            expect(await v6.activeLoanCount(1)).to.equal(0);
        });
    });

    describe("Fix 4: withdrawLiquidity rejects amount=0", () => {
        beforeEach(async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(100));
        });

        it("rejects withdrawLiquidity(amount=0)", async () => {
            await expect(v6.connect(lender).withdrawLiquidity(1, 0))
                .to.be.revertedWith("Amount must be > 0");
        });

        it("still accepts withdrawLiquidity(amount > 0)", async () => {
            await v6.connect(lender).withdrawLiquidity(1, USDC(50));
            const pos = await v6.positions(1, lender.address);
            expect(pos.amount).to.equal(USDC(50));
        });

        it("doesn't emit useless events for zero-amount calls", async () => {
            // Pre-fix this would emit LiquidityWithdrawn(_,_,0)
            await expect(v6.connect(lender).withdrawLiquidity(1, 0))
                .to.be.revertedWith("Amount must be > 0");
        });
    });
});
