const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentCreditFaucet", function () {
    let faucet, registry, usdc;
    let owner, agent, agent2, agent3, stranger;
    const USDC = (n) => ethers.parseUnits(n.toString(), 6);

    beforeEach(async () => {
        [owner, agent, agent2, agent3, stranger] = await ethers.getSigners();
        const Registry = await ethers.getContractFactory("AgentRegistryV2");
        registry = await Registry.deploy();
        const Mock = await ethers.getContractFactory("MockUSDC");
        usdc = await Mock.deploy();
        const Faucet = await ethers.getContractFactory("AgentCreditFaucet");
        faucet = await Faucet.deploy(await registry.getAddress(), await usdc.getAddress());

        await usdc.mint(await faucet.getAddress(), USDC(1000));
        await registry.connect(agent).register("ipfs://a1", []);
        await registry.connect(agent2).register("ipfs://a2", []);
        await registry.connect(agent3).register("ipfs://a3", []);
    });

    describe("basic claim flow", () => {
        it("registered agent within cap can claim", async () => {
            await faucet.setMaxEligibleAgentId(100);
            await expect(faucet.connect(agent).claim())
                .to.emit(faucet, "Claimed")
                .withArgs(1, agent.address, USDC(10));
            expect(await usdc.balanceOf(agent.address)).to.equal(USDC(10));
            expect(await faucet.claimed(1)).to.equal(true);
            expect(await faucet.totalGranted()).to.equal(USDC(10));
        });

        it("non-registered caller cannot claim", async () => {
            await faucet.setMaxEligibleAgentId(100);
            await expect(faucet.connect(stranger).claim()).to.be.revertedWith("Not a registered agent");
        });

        it("registered agent OUTSIDE cap cannot claim", async () => {
            await faucet.setMaxEligibleAgentId(0); // cap = 0 → all blocked
            await expect(faucet.connect(agent).claim()).to.be.revertedWith("Agent not yet eligible");
        });

        it("agent cannot double-claim", async () => {
            await faucet.setMaxEligibleAgentId(100);
            await faucet.connect(agent).claim();
            await expect(faucet.connect(agent).claim()).to.be.revertedWith("Already claimed");
        });

        it("isEligible matches actual claim behavior", async () => {
            await faucet.setMaxEligibleAgentId(2);
            expect(await faucet.isEligible(1)).to.equal(true);
            expect(await faucet.isEligible(2)).to.equal(true);
            expect(await faucet.isEligible(3)).to.equal(false);
            await faucet.connect(agent).claim();
            expect(await faucet.isEligible(1)).to.equal(false);
        });
    });

    describe("owner controls", () => {
        it("only owner can setMaxEligibleAgentId", async () => {
            await expect(faucet.connect(agent).setMaxEligibleAgentId(100)).to.be.reverted;
            await faucet.setMaxEligibleAgentId(100);
            expect(await faucet.maxEligibleAgentId()).to.equal(100);
        });

        it("owner can change claimAmount within cap", async () => {
            await faucet.setMaxEligibleAgentId(100);
            await faucet.setClaimAmount(USDC(25));
            expect(await faucet.claimAmount()).to.equal(USDC(25));
            await faucet.connect(agent).claim();
            expect(await usdc.balanceOf(agent.address)).to.equal(USDC(25));
        });

        it("claimAmount capped at 100 USDC", async () => {
            await expect(faucet.setClaimAmount(USDC(101))).to.be.revertedWith("Claim amount too high (>100 USDC)");
        });

        it("owner can drain remaining USDC", async () => {
            const before = await usdc.balanceOf(owner.address);
            await faucet.drain(USDC(500));
            expect(await usdc.balanceOf(owner.address)).to.equal(before + USDC(500));
        });

        it("drain capped at balance", async () => {
            await expect(faucet.drain(USDC(2000))).to.be.revertedWith("Insufficient");
        });
    });

    describe("edge cases", () => {
        it("claim reverts when faucet empty", async () => {
            await faucet.setMaxEligibleAgentId(100);
            await faucet.drain(USDC(1000));
            await expect(faucet.connect(agent).claim()).to.be.revertedWith("Faucet empty");
        });

        it("claimAmount=0 disables the faucet via Faucet inactive", async () => {
            await faucet.setMaxEligibleAgentId(100);
            await faucet.setClaimAmount(0);
            await expect(faucet.connect(agent).claim()).to.be.revertedWith("Faucet inactive");
        });

        it("multiple agents can claim", async () => {
            await faucet.setMaxEligibleAgentId(100);
            await faucet.connect(agent).claim();
            await faucet.connect(agent2).claim();
            await faucet.connect(agent3).claim();
            expect(await faucet.totalGranted()).to.equal(USDC(30));
            expect(await usdc.balanceOf(agent.address)).to.equal(USDC(10));
            expect(await usdc.balanceOf(agent2.address)).to.equal(USDC(10));
            expect(await usdc.balanceOf(agent3.address)).to.equal(USDC(10));
        });

        it("balance() returns current USDC balance", async () => {
            expect(await faucet.balance()).to.equal(USDC(1000));
            await faucet.setMaxEligibleAgentId(100);
            await faucet.connect(agent).claim();
            expect(await faucet.balance()).to.equal(USDC(990));
        });
    });
});
