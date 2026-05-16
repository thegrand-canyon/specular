// Tests for CLAUDE_AUDIT_WORLDCLASS fixes (W2, W3).
// W2: setPlatformFeeRate emits PlatformFeeRateChanged event
// W3: claimInterest validates pool.availableLiquidity BEFORE writing position.earnedInterest=0

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("V6 — Audit World-Class fixes", function () {
    let v6, registry, reputation, usdc;
    let owner, agent, lender;
    const USDC = (n) => ethers.parseUnits(n.toString(), 6);

    beforeEach(async () => {
        [owner, agent, lender] = await ethers.getSigners();
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

    describe("W2: setPlatformFeeRate emits PlatformFeeRateChanged", () => {
        it("emits event with old + new rate", async () => {
            // Initial rate is 100 (1%) per the constant default
            await expect(v6.setPlatformFeeRate(250))
                .to.emit(v6, "PlatformFeeRateChanged")
                .withArgs(100, 250);
        });

        it("emits event even when rate doesn't change", async () => {
            // Set same rate as current
            await expect(v6.setPlatformFeeRate(100))
                .to.emit(v6, "PlatformFeeRateChanged")
                .withArgs(100, 100);
        });

        it("still rejects rates above 500 with the original message", async () => {
            await expect(v6.setPlatformFeeRate(501)).to.be.revertedWith("Fee too high");
        });

        it("non-owner cannot trigger", async () => {
            await expect(v6.connect(lender).setPlatformFeeRate(200)).to.be.reverted;
        });
    });

    describe("W3: claimInterest validates before writing state", () => {
        it("rejects when no interest with original message (validate-first preserved)", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(100));
            await expect(v6.connect(lender).claimInterest(1)).to.be.revertedWith("No interest to claim");
        });

        it("succeeds normal claim path", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(100));
            await v6.connect(agent).requestLoan(USDC(50), 7);
            await v6.connect(agent).repayLoan(1);
            const positionBefore = await v6.positions(1, lender.address);
            expect(positionBefore.earnedInterest).to.be.gt(0);
            await v6.connect(lender).claimInterest(1);
            const positionAfter = await v6.positions(1, lender.address);
            expect(positionAfter.earnedInterest).to.equal(0);
        });

        it("after claim, position.earnedInterest is 0 and availableLiquidity correctly decremented", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(100));
            await v6.connect(agent).requestLoan(USDC(50), 7);
            await v6.connect(agent).repayLoan(1);
            const poolBefore = await v6.getAgentPool(1);
            const interest = (await v6.positions(1, lender.address)).earnedInterest;
            await v6.connect(lender).claimInterest(1);
            const poolAfter = await v6.getAgentPool(1);
            expect(poolAfter.availableLiquidity).to.equal(poolBefore.availableLiquidity - interest);
        });
    });
});
