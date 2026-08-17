// Repro for the pre-mainnet self-audit accounting finding: totalLiquidity drifts
// below totalLoaned because repayLoan adds interest to availableLiquidity (not
// totalLiquidity) and withdrawLiquidity then pays that interest out as principal,
// decrementing totalLiquidity below the pool's real loaned principal. A later
// lossy liquidateLoan then does `totalLiquidity -= loss` → checked-math underflow
// → Panic(0x11) → the loan can NEVER be liquidated, so the borrower evades the
// default penalty and the pool's accounting is stuck.

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("V6 — totalLiquidity underflow bricks liquidateLoan", function () {
    let v6, registry, reputation, usdc, owner, agent, lender;
    const USDC = (n) => ethers.parseUnits(n.toString(), 6);

    beforeEach(async () => {
        [owner, agent, lender] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        reputation = await (await ethers.getContractFactory("ReputationManagerV3")).deploy(await registry.getAddress());
        usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
        v6 = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV6")).deploy(
            await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
        await reputation.authorizePool(await v6.getAddress());
        await registry.connect(agent).register("ipfs://agent", []);
        await v6.connect(agent).createAgentPool();
        for (const w of [agent, lender]) {
            await usdc.mint(w.address, USDC(1_000_000));
            await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256);
        }
        // Pump the agent to a 0%-collateral tier (score >= 600) by authorizing the
        // owner as a "pool" and recording on-time completions directly.
        await reputation.authorizePool(owner.address);
        for (let i = 0; i < 65; i++) {
            await reputation.recordLoanCompletion(agent.address, USDC(1), true);
        }
        expect(await reputation["getReputationScore(address)"](agent.address)).to.be.gte(600n);
        // Confirm 0% collateral tier so loans disburse with no collateral.
        expect(await reputation.calculateCollateralRequirement(agent.address)).to.equal(0n);
    });

    it("liquidateLoan succeeds (no underflow) after interest is withdrawn as principal", async () => {
        await v6.connect(lender).supplyLiquidity(1, USDC(2000));

        // Two 0-collateral loans of 1000 each (aggregate 2000 <= 25k limit).
        await v6.connect(agent).requestLoan(USDC(1000), 365); // loan 1
        await v6.connect(agent).requestLoan(USDC(1000), 365); // loan 2

        // Repay loan 1 → interest is added to availableLiquidity, lender earns it.
        await v6.connect(agent).repayLoan(1);

        const pool1 = await v6.getAgentPool(1);
        // availableLiquidity is now ~1000 + lenderInterest; withdraw most of it as principal.
        const withdrawAmt = pool1.availableLiquidity - USDC(1); // leave a hair
        await v6.connect(lender).withdrawLiquidity(1, withdrawAmt);

        const pool2 = await v6.getAgentPool(1);
        // The drift: totalLiquidity has sunk below the still-outstanding loaned principal.
        expect(pool2.totalLiquidity, "totalLiquidity should have drifted below totalLoaned").to.be.lt(pool2.totalLoaned);

        // Make loan 2 overdue, then try to liquidate — this underflows totalLiquidity.
        const loan2 = await v6.loans(2);
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        await ethers.provider.send("evm_increaseTime", [Number(loan2.endTime) - now + 1]);
        await ethers.provider.send("evm_mine", []);

        // FIXED: liquidation now succeeds (saturating totalLiquidity), the loan
        // is DEFAULTED, and the default penalty is recorded — no evasion.
        const scoreBefore = await reputation["getReputationScore(address)"](agent.address);
        await expect(v6.connect(owner).liquidateLoan(2)).to.not.be.reverted;
        expect(Number((await v6.loans(2)).state)).to.equal(3); // DEFAULTED
        expect(await reputation["getReputationScore(address)"](agent.address)).to.be.lt(scoreBefore);
        // totalLiquidity saturated to 0, availableLiquidity remains solvent.
        const finalPool = await v6.getAgentPool(1);
        expect(finalPool.totalLiquidity).to.equal(0n);
        expect(finalPool.availableLiquidity).to.be.lte(await usdc.balanceOf(await v6.getAddress()));
    });
});
