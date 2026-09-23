// Tests for the CLAUDE_AUDIT_DEEP findings (resetPoolAccounting fixes).
// Finding 1: must revert if agent NFT was transferred
// Finding 2: formula must use unclaimed interest (Σ position.earnedInterest), not lifetime totalEarned

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("V6 — Audit Deep fixes (resetPoolAccounting)", function () {
    let v6, registry, reputation, usdc;
    let owner, agent, agent2, lender;
    const USDC = (n) => ethers.parseUnits(n.toString(), 6);

    beforeEach(async () => {
        [owner, agent, agent2, lender] = await ethers.getSigners();
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

    describe("Finding 1: resetPoolAccounting after agent NFT transfer", () => {
        it("succeeds when agent has NOT been transferred", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(500));
            await v6.connect(agent).requestLoan(USDC(10), 7);
            // Should succeed — agent still owns the NFT
            await expect(v6.resetPoolAccounting(1)).to.not.be.reverted;
        });

        it("reverts when agent NFT has been transferred to another address", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(500));
            await v6.connect(agent).requestLoan(USDC(10), 7);
            // Transfer agent NFT to agent2
            await registry.connect(agent).transferFrom(agent.address, agent2.address, 1);
            // Now pool.agentAddress (set in createAgentPool to agent) doesn't match registry.ownerOf(1) (agent2)
            await expect(v6.resetPoolAccounting(1)).to.be.revertedWith("Agent transferred; resync via migration helpers");
        });

        it("succeeds again if NFT is transferred back", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(500));
            await registry.connect(agent).transferFrom(agent.address, agent2.address, 1);
            await expect(v6.resetPoolAccounting(1)).to.be.reverted;
            // Transfer back
            await registry.connect(agent2).transferFrom(agent2.address, agent.address, 1);
            // Now matches again
            await expect(v6.resetPoolAccounting(1)).to.not.be.reverted;
        });
    });

    describe("Finding 2: resetPoolAccounting formula uses unclaimed interest", () => {
        it("availableLiquidity == totalLiquidity when no claims have occurred", async () => {
            // Setup: supply 1000, no loans, no interest
            await v6.connect(lender).supplyLiquidity(1, USDC(1000));
            await v6.resetPoolAccounting(1);
            const pool = await v6.getAgentPool(1);
            expect(pool.availableLiquidity).to.equal(USDC(1000));
            expect(pool.totalLiquidity).to.equal(USDC(1000));
        });

        it("includes unclaimed interest in availableLiquidity", async () => {
            // Setup: supply, loan, repay (interest accrues but not claimed)
            await v6.connect(lender).supplyLiquidity(1, USDC(1000));
            // Reputation must be high enough to loan without collateral, so we set score directly
            // (default low-rep would need collateral). Just do a small loan that fits.
            await v6.connect(agent).requestLoan(USDC(100), 7);
            await v6.connect(agent).repayLoan(1);
            // Some interest accrued and is unclaimed (lender hasn't claimed yet)
            const positionPre = await v6.positions(1, lender.address);
            expect(positionPre.earnedInterest).to.be.gt(0);

            // Capture pool state
            const poolPre = await v6.getAgentPool(1);
            await v6.resetPoolAccounting(1);
            const poolPost = await v6.getAgentPool(1);

            // Expected availableLiquidity should ROUGHLY equal what mpBal can support
            // (the contract has totalLiquidity + unclaimedInterest sitting in it)
            // After reset, this should match
            const mpBal = await usdc.balanceOf(await v6.getAddress());
            // Pool's claim on USDC = availableLiquidity + 0 (no active loans)
            // mpBal includes principal + lenderInterest + platformFees
            // So availableLiquidity should be at most mpBal (minus platform fees)
            const accFees = await v6.accumulatedFees();
            expect(poolPost.availableLiquidity).to.equal(mpBal - accFees);
        });

        it("does NOT double-count interest after claim", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(1000));
            await v6.connect(agent).requestLoan(USDC(100), 7);
            await v6.connect(agent).repayLoan(1);

            // Lender claims interest
            const positionBefore = await v6.positions(1, lender.address);
            await v6.connect(lender).claimInterest(1);
            const positionAfter = await v6.positions(1, lender.address);
            expect(positionAfter.earnedInterest).to.equal(0);

            // Now reset accounting
            await v6.resetPoolAccounting(1);
            const pool = await v6.getAgentPool(1);

            // availableLiquidity should equal totalLiquidity (no unclaimed interest, no active loans)
            expect(pool.availableLiquidity).to.equal(pool.totalLiquidity);

            // Verify mpBal matches (accounting is consistent with USDC custody)
            const mpBal = await usdc.balanceOf(await v6.getAddress());
            const accFees = await v6.accumulatedFees();
            expect(pool.availableLiquidity).to.equal(mpBal - accFees);
        });

        it("under prior buggy formula, availableLiquidity would over-report after claim", async () => {
            // Sanity check: with the fix, availableLiquidity == totalLiquidity post-claim.
            // With the OLD formula (totalLiquidity + totalEarned - actualLoaned), it would
            // have been totalLiquidity + claimedInterest. We verify the fix correctly avoids that.
            await v6.connect(lender).supplyLiquidity(1, USDC(1000));
            await v6.connect(agent).requestLoan(USDC(100), 7);
            await v6.connect(agent).repayLoan(1);
            await v6.connect(lender).claimInterest(1);
            const poolBefore = await v6.getAgentPool(1);
            const totalEarnedBefore = poolBefore.totalEarned;
            expect(totalEarnedBefore).to.be.gt(0); // confirms totalEarned still > 0 even after claim

            await v6.resetPoolAccounting(1);
            const poolAfter = await v6.getAgentPool(1);
            // OLD formula: availableLiquidity = totalLiquidity + totalEarned (would be > totalLiquidity)
            // NEW formula: availableLiquidity = totalLiquidity + 0 (unclaimed interest) = totalLiquidity
            expect(poolAfter.availableLiquidity).to.equal(poolAfter.totalLiquidity);
            expect(poolAfter.availableLiquidity).to.be.lt(poolAfter.totalLiquidity + totalEarnedBefore);
        });

        it("with active loans + claims: correctly subtracts loaned amount", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(1000));
            // First loan + repay + claim (so totalEarned is positive but unclaimed is 0)
            await v6.connect(agent).requestLoan(USDC(50), 7);
            await v6.connect(agent).repayLoan(1);
            await v6.connect(lender).claimInterest(1);

            // Second loan still active
            await v6.connect(agent).requestLoan(USDC(100), 7);

            await v6.resetPoolAccounting(1);
            const pool = await v6.getAgentPool(1);

            // After: totalLiquidity = 1000 (give or take collateral effects)
            //        unclaimedInterest = 0 (just claimed)
            //        actualLoaned = 100 (second loan)
            //        availableLiquidity = totalLiquidity + 0 - 100
            expect(pool.totalLoaned).to.equal(USDC(100));
            expect(pool.availableLiquidity).to.equal(pool.totalLiquidity - USDC(100));
        });
    });
});
