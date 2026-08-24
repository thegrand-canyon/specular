// SECURITY TEST — exhaustive access-control negatives. Every restricted function
// called by the WRONG party must revert. Covers marketplace, reputation, faucet.

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SECURITY: access control (every wrong-caller reverts)", function () {
    let v6, registry, reputation, faucet, usdc;
    let owner, attacker, agent, lender;
    const USDC = (n) => ethers.parseUnits(String(n), 6);

    beforeEach(async () => {
        [owner, attacker, agent, lender] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        reputation = await (await ethers.getContractFactory("ReputationManagerV3")).deploy(await registry.getAddress());
        usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
        v6 = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV6")).deploy(
            await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
        faucet = await (await ethers.getContractFactory("AgentCreditFaucet")).deploy(await registry.getAddress(), await usdc.getAddress());
        await reputation.authorizePool(await v6.getAddress());
        await registry.connect(agent).register("ipfs://a", []);
        await v6.connect(agent).createAgentPool();
        for (const w of [agent, lender]) { await usdc.mint(w.address, USDC(100000)); await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256); }
    });

    describe("marketplace owner-only (attacker must be rejected)", () => {
        const A = () => v6.connect(attacker);
        it("liquidateLoan", async () => { await expect(A().liquidateLoan(1)).to.be.reverted; });
        it("withdrawFees", async () => { await expect(A().withdrawFees(1)).to.be.reverted; });
        it("pause / unpause", async () => { await expect(A().pause()).to.be.reverted; await expect(A().unpause()).to.be.reverted; });
        it("seedPool / seedPosition", async () => {
            await expect(A().seedPool(1, agent.address, 0, 0, 0)).to.be.reverted;
            await expect(A().seedPosition(1, lender.address, USDC(1), 0, 0)).to.be.reverted;
        });
        it("compactPoolLenders / setMigrationFinalized / resetPoolAccounting", async () => {
            await expect(A().compactPoolLenders(1)).to.be.reverted;
            await expect(A().setMigrationFinalized()).to.be.reverted;
            await expect(A().resetPoolAccounting(1)).to.be.reverted;
        });
        it("all setters (fee, minHold, bindBorrow, minSupply)", async () => {
            await expect(A().setPlatformFeeRate(200)).to.be.reverted;
            await expect(A().setMinHoldForReputationReward(3600)).to.be.reverted;
            await expect(A().setBindBorrowToPoolCreator(true)).to.be.reverted;
            await expect(A().setMinSupplyAmount(USDC(1))).to.be.reverted;
        });
        it("renounceOwnership reverts even for the owner", async () => {
            await expect(v6.connect(owner).renounceOwnership()).to.be.revertedWith("Ownership cannot be renounced");
        });
    });

    describe("borrower-only / position-owner", () => {
        it("cannot repay another agent's loan", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(1000));
            await v6.connect(agent).requestLoan(USDC(10), 7);
            await expect(v6.connect(attacker).repayLoan(1)).to.be.revertedWith("Not the borrower");
        });
        it("withdrawing a pool you have no position in yields nothing / reverts", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(1000));
            // attacker has no position → Insufficient balance
            await expect(v6.connect(attacker).withdrawLiquidity(1, USDC(1))).to.be.revertedWith("Insufficient balance");
        });
        it("claiming interest with no position reverts", async () => {
            await expect(v6.connect(attacker).claimInterest(1)).to.be.revertedWith("No interest to claim");
        });
        it("requestLoan from a non-registered attacker reverts", async () => {
            await expect(v6.connect(attacker).requestLoan(USDC(10), 7)).to.be.revertedWith("Not a registered agent");
        });
    });

    describe("reputation manager", () => {
        it("recordBorrow/Completion/Default rejected from a non-authorized pool", async () => {
            await expect(reputation.connect(attacker).recordBorrow(agent.address, USDC(1))).to.be.reverted;
            await expect(reputation.connect(attacker).recordLoanCompletion(agent.address, USDC(1), true)).to.be.reverted;
            await expect(reputation.connect(attacker).recordDefault(agent.address, USDC(1))).to.be.reverted;
        });
        it("owner-only setters rejected from attacker", async () => {
            await expect(reputation.connect(attacker).authorizePool(attacker.address)).to.be.reverted;
            await expect(reputation.connect(attacker).revokePool(await v6.getAddress())).to.be.reverted;
            await expect(reputation.connect(attacker).setValidationRegistry(attacker.address)).to.be.reverted;
            await expect(reputation.connect(attacker).setBonusReferenceAmount(USDC(50))).to.be.reverted;
            await expect(reputation.connect(attacker).setReputationRateLimit(20, 3600)).to.be.reverted;
        });
        it("cannot initializeReputation for an agent you don't own", async () => {
            // attacker isn't the owner of agentId 1
            await expect(reputation.connect(attacker)["initializeReputation(uint256)"](1)).to.be.reverted;
        });
    });

    describe("faucet owner-only", () => {
        it("setClaimAmount / setMaxEligibleAgentId / drain / notifyRefill rejected from attacker", async () => {
            await expect(faucet.connect(attacker).setClaimAmount(USDC(5))).to.be.reverted;
            await expect(faucet.connect(attacker).setMaxEligibleAgentId(100)).to.be.reverted;
            await expect(faucet.connect(attacker).drain(USDC(1))).to.be.reverted;
            await expect(faucet.connect(attacker).notifyRefill()).to.be.reverted;
        });
    });
});
