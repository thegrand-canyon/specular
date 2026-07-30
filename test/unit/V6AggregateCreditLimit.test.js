// Regression test for audit finding H-3 (2026-07): the credit limit was
// enforced per-loan, not in aggregate. With MAX_ACTIVE_LOANS_PER_AGENT
// concurrent loans an agent could borrow many multiples of its limit. Fix:
// track outstandingPrincipal and require outstanding + amount <= creditLimit.

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("V6 — aggregate credit limit (H-3)", function () {
    let v6, registry, reputation, usdc;
    let owner, agent, lender;
    const USDC = (n) => ethers.parseUnits(n.toString(), 6);

    beforeEach(async () => {
        [owner, agent, lender] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        reputation = await (await ethers.getContractFactory("ReputationManagerV3")).deploy(await registry.getAddress());
        usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
        v6 = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV6")).deploy(
            await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress()
        );
        await reputation.authorizePool(await v6.getAddress());
        await registry.connect(agent).register("ipfs://agent", []);
        await v6.connect(agent).createAgentPool();
        for (const w of [agent, lender]) {
            await usdc.mint(w.address, USDC(100_000));
            await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256);
        }
        await v6.connect(lender).supplyLiquidity(1, USDC(50_000));
    });

    it("rejects a second loan whose principal pushes aggregate over the credit limit", async () => {
        const limit = await reputation.calculateCreditLimit(agent.address); // score 0 → 1000 USDC
        const first = (limit * 70n) / 100n;   // 70% of limit
        const second = (limit * 40n) / 100n;  // 40% — sum 110% > limit

        await v6.connect(agent).requestLoan(first, 30);
        expect(await v6.outstandingPrincipal(agent.address)).to.equal(first);

        // Under the old per-loan check this passed (second <= limit); now the
        // aggregate first+second exceeds the limit and must revert.
        await expect(v6.connect(agent).requestLoan(second, 30)).to.be.revertedWith("Exceeds credit limit");
    });

    it("frees aggregate capacity after repayment", async () => {
        const limit = await reputation.calculateCreditLimit(agent.address);
        const first = (limit * 70n) / 100n;
        const second = (limit * 40n) / 100n;

        await v6.connect(agent).requestLoan(first, 30);   // loan 1
        await v6.connect(agent).repayLoan(1);             // frees principal
        expect(await v6.outstandingPrincipal(agent.address)).to.equal(0n);

        // Now the 40% loan fits.
        await expect(v6.connect(agent).requestLoan(second, 30)).to.not.be.reverted;
        expect(await v6.outstandingPrincipal(agent.address)).to.equal(second);
    });

    it("allows borrowing up to exactly the limit in aggregate", async () => {
        const limit = await reputation.calculateCreditLimit(agent.address);
        const half = limit / 2n;
        await v6.connect(agent).requestLoan(half, 30);
        await v6.connect(agent).requestLoan(limit - half, 30); // sum == limit, OK
        expect(await v6.outstandingPrincipal(agent.address)).to.equal(limit);
        // One more base unit over the limit must revert.
        await expect(v6.connect(agent).requestLoan(1n, 30)).to.be.revertedWith("Exceeds credit limit");
    });
});
