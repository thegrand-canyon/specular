// SECURITY TEST — loan state-machine + input/boundary attacks. Each must revert
// with the documented reason. Revert strings verified against source.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SECURITY: state-machine + boundary", function () {
    let v6, registry, reputation, usdc, owner, agent, lender;
    const USDC = (n) => ethers.parseUnits(String(n), 6);

    beforeEach(async () => {
        [owner, agent, lender] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        reputation = await (await ethers.getContractFactory("ReputationManagerV3")).deploy(await registry.getAddress());
        usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
        v6 = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV6")).deploy(
            await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
        await reputation.authorizePool(await v6.getAddress());
        await registry.connect(agent).register("ipfs://a", []);
        await v6.connect(agent).createAgentPool();
        for (const w of [agent, lender]) { await usdc.mint(w.address, USDC(100000)); await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256); }
        await v6.connect(lender).supplyLiquidity(1, USDC(5000));
    });

    async function makeLoan(amount = USDC(100), dur = 7) {
        const r = await (await v6.connect(agent).requestLoan(amount, dur)).wait();
        for (const lg of r.logs) { try { const p = v6.interface.parseLog(lg); if (p?.name === "LoanRequested") return p.args.loanId; } catch {} }
    }

    describe("loan state machine", () => {
        it("double-repay reverts (Loan not active)", async () => {
            const id = await makeLoan();
            await v6.connect(agent).repayLoan(id);
            await expect(v6.connect(agent).repayLoan(id)).to.be.revertedWith("Loan not active");
        });
        it("repay after default reverts", async () => {
            const id = await makeLoan();
            await time.increase(8 * 24 * 3600);
            await v6.connect(owner).liquidateLoan(id);
            await expect(v6.connect(agent).repayLoan(id)).to.be.revertedWith("Loan not active");
        });
        it("liquidate before due reverts (Loan not overdue)", async () => {
            const id = await makeLoan();
            await expect(v6.connect(owner).liquidateLoan(id)).to.be.revertedWith("Loan not overdue");
        });
        it("liquidate twice reverts", async () => {
            const id = await makeLoan();
            await time.increase(8 * 24 * 3600);
            await v6.connect(owner).liquidateLoan(id);
            await expect(v6.connect(owner).liquidateLoan(id)).to.be.revertedWith("Loan not active");
        });
        it("liquidate a REPAID loan reverts", async () => {
            const id = await makeLoan();
            await v6.connect(agent).repayLoan(id);
            await time.increase(8 * 24 * 3600);
            await expect(v6.connect(owner).liquidateLoan(id)).to.be.revertedWith("Loan not active");
        });
        it("operate on a non-existent loan reverts", async () => {
            await expect(v6.connect(agent).repayLoan(9999)).to.be.reverted;
            await expect(v6.connect(owner).liquidateLoan(9999)).to.be.revertedWith("Loan not active");
        });
        it("create duplicate pool reverts", async () => {
            await expect(v6.connect(agent).createAgentPool()).to.be.reverted;
        });
    });

    describe("zero / boundary inputs", () => {
        it("zero-amount supply/withdraw/borrow revert", async () => {
            await expect(v6.connect(lender).supplyLiquidity(1, 0)).to.be.revertedWith("Amount must be > 0");
            await expect(v6.connect(lender).withdrawLiquidity(1, 0)).to.be.revertedWith("Amount must be > 0");
            await expect(v6.connect(agent).requestLoan(0, 7)).to.be.revertedWith("Amount must be > 0");
        });
        it("duration below MIN / above MAX / zero revert", async () => {
            await expect(v6.connect(agent).requestLoan(USDC(10), 6)).to.be.revertedWith("Invalid duration");
            await expect(v6.connect(agent).requestLoan(USDC(10), 366)).to.be.revertedWith("Invalid duration");
            await expect(v6.connect(agent).requestLoan(USDC(10), 0)).to.be.revertedWith("Invalid duration");
        });
        it("supply/borrow on an inactive pool reverts", async () => {
            await expect(v6.connect(lender).supplyLiquidity(999, USDC(10))).to.be.revertedWith("Pool not active");
        });
        it("register with empty URI / twice reverts", async () => {
            await expect(registry.connect(lender).register("", [])).to.be.revertedWith("Agent URI cannot be empty");
            await expect(registry.connect(agent).register("ipfs://again", [])).to.be.revertedWith("Agent already registered");
        });
        it("owner setter bounds enforced", async () => {
            await expect(v6.setPlatformFeeRate(501)).to.be.revertedWith("Fee too high");
            await expect(v6.setMinHoldForReputationReward(8 * 24 * 3600)).to.be.revertedWith("Min hold exceeds min loan duration");
            await expect(v6.setMinSupplyAmount(USDC(101))).to.be.revertedWith("Min supply too high (>100 USDC)");
            await expect(reputation.setBonusReferenceAmount(0)).to.be.revertedWith("Reference must be > 0");
            await expect(reputation.setReputationRateLimit(20, 0)).to.be.revertedWith("Window must be > 0");
        });
    });

    describe("solvency negatives", () => {
        it("withdraw more than deposited reverts", async () => {
            await expect(v6.connect(lender).withdrawLiquidity(1, USDC(999999))).to.be.revertedWith("Insufficient balance");
        });
        it("claim interest twice reverts", async () => {
            const id = await makeLoan();
            await v6.connect(agent).repayLoan(id);
            await v6.connect(lender).claimInterest(1);
            await expect(v6.connect(lender).claimInterest(1)).to.be.revertedWith("No interest to claim");
        });
        it("withdraw fees beyond accumulated reverts", async () => {
            await expect(v6.withdrawFees(USDC(999999))).to.be.revertedWith("Insufficient fees");
        });
    });
});
