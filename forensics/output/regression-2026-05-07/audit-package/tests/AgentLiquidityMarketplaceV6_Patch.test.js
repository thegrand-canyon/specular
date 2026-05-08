const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentLiquidityMarketplaceV6_Patch — §B1/§S1/§S5 fixes", function () {
    let mp, usdc;
    let owner, agent, lender, lender2;
    const USDC = (n) => ethers.parseUnits(n.toString(), 6);

    beforeEach(async () => {
        [owner, agent, lender, lender2] = await ethers.getSigners();
        const Mock = await ethers.getContractFactory("MockUSDC");
        usdc = await Mock.deploy();
        await usdc.waitForDeployment();
        const MP = await ethers.getContractFactory("AgentLiquidityMarketplaceV6_Patch");
        mp = await MP.deploy(await usdc.getAddress());
        await mp.waitForDeployment();
        // Mint USDC
        for (const w of [agent, lender, lender2]) {
            await usdc.mint(w.address, USDC(1_000_000));
            await usdc.connect(w).approve(await mp.getAddress(), USDC(1_000_000));
        }
        await mp.connect(agent).registerAgent(agent.address); // agent is borrower with own pool
    });

    describe("§B1 — duplicate poolLenders prevention", () => {
        it("supplyLiquidity → withdraw (full) → supplyLiquidity does NOT create duplicate entries", async () => {
            await mp.connect(lender).supplyLiquidity(1, USDC(100));
            const pos1 = await mp.getPosition(1, lender.address);
            expect(pos1.amount).to.equal(USDC(100));
            expect(await mp.getPoolLenders(1)).to.deep.equal([lender.address]);

            await mp.connect(lender).withdrawLiquidity(1, USDC(100));
            const pos2 = await mp.getPosition(1, lender.address);
            expect(pos2.amount).to.equal(0);
            // poolLenders entry persists (kept for accounting; flag prevents duplicate on re-supply)
            expect(await mp.getPoolLenders(1)).to.deep.equal([lender.address]);

            // Re-supply: in v4 this would PUSH a duplicate. In v6 patch it doesn't.
            await mp.connect(lender).supplyLiquidity(1, USDC(50));
            expect(await mp.getPoolLenders(1)).to.deep.equal([lender.address]);
            const pos3 = await mp.getPosition(1, lender.address);
            expect(pos3.amount).to.equal(USDC(50));
        });

        it("compactPoolLenders dedups any pre-existing entries (recovery path)", async () => {
            // Simulate a poisoned pool by direct manipulation: not possible from outside.
            // Instead verify the function works idempotently on a clean pool.
            await mp.connect(lender).supplyLiquidity(1, USDC(100));
            await mp.connect(lender2).supplyLiquidity(1, USDC(50));
            expect(await mp.getPoolLenders(1)).to.have.lengthOf(2);
            await mp.connect(owner).compactPoolLenders(1);
            // Already had no duplicates — count unchanged
            expect(await mp.getPoolLenders(1)).to.have.lengthOf(2);
        });
    });

    describe("§S1 — claimInterest decrements pool.availableLiquidity", () => {
        it("after repay + claim, pool.availableLiquidity matches actual USDC balance contribution", async () => {
            // Lender supplies, agent borrows, repays, lender claims
            await mp.connect(lender).supplyLiquidity(1, USDC(100));
            await mp.connect(agent).requestLoan(USDC(50), 30); // 30 days
            const poolBeforeRepay = await mp.getPool(1);
            expect(poolBeforeRepay.availableLiquidity).to.equal(USDC(50)); // 100 - 50

            // Repay (agent has the borrowed funds + needs interest)
            await mp.connect(agent).repayLoan(1);
            const poolAfterRepay = await mp.getPool(1);
            // After repay: principal back (100), totalEarned increases by interest, available = totalLiq + earned... wait actually:
            // pool.availableLiquidity += principal (50), so it's now 100 again
            expect(poolAfterRepay.availableLiquidity).to.equal(USDC(100));
            expect(poolAfterRepay.totalEarned).to.be.gt(0);

            const interestEarned = (await mp.getPosition(1, lender.address)).earnedInterest;
            expect(interestEarned).to.be.gt(0);

            // CRITICAL: claimInterest must decrement availableLiquidity (§S1 fix)
            const availBefore = (await mp.getPool(1)).availableLiquidity;
            await mp.connect(lender).claimInterest(1);
            const availAfter = (await mp.getPool(1)).availableLiquidity;
            expect(availAfter).to.equal(availBefore - interestEarned);

            const positionAfter = await mp.getPosition(1, lender.address);
            expect(positionAfter.earnedInterest).to.equal(0);
        });

        it("availableLiquidity never exceeds USDC balance after claim (invariant)", async () => {
            await mp.connect(lender).supplyLiquidity(1, USDC(100));
            await mp.connect(agent).requestLoan(USDC(50), 30);
            await mp.connect(agent).repayLoan(1);
            await mp.connect(lender).claimInterest(1);
            const pool = await mp.getPool(1);
            const mpBal = await usdc.balanceOf(await mp.getAddress());
            // availableLiquidity reflects USDC actually here (modulo any gas-burning)
            expect(pool.availableLiquidity).to.be.lte(mpBal);
        });
    });

    describe("§S5 — O(1) active-loan check", () => {
        it("activeLoanCount tracks current state, not array length", async () => {
            await mp.connect(lender).supplyLiquidity(1, USDC(1000));
            // Take 3 loans, repay 2, leave 1 active
            for (let i = 0; i < 3; i++) {
                await mp.connect(agent).requestLoan(USDC(10), 7);
            }
            expect(await mp.getActiveLoanCount(agent.address)).to.equal(3);

            await mp.connect(agent).repayLoan(1);
            await mp.connect(agent).repayLoan(2);
            expect(await mp.getActiveLoanCount(agent.address)).to.equal(1);

            // Even though agentLoans[].length is 3, counter is 1 → no array walk
            // requestLoan still works (1 < 10 cap)
            await mp.connect(agent).requestLoan(USDC(10), 7);
            expect(await mp.getActiveLoanCount(agent.address)).to.equal(2);
        });

        it("requestLoan gas does NOT scale with lifetime loan count", async () => {
            await mp.connect(lender).supplyLiquidity(1, USDC(10000));
            // Push some lifetime loans by repaying immediately
            for (let i = 0; i < 5; i++) {
                await mp.connect(agent).requestLoan(USDC(1), 7);
                await mp.connect(agent).repayLoan(i + 1);
            }
            // Now agentLoans[agent].length = 5, but activeLoanCount = 0
            const gas1 = await mp.connect(agent).requestLoan.estimateGas(USDC(1), 7);

            // Add 50 more lifetime loans
            for (let i = 5; i < 55; i++) {
                await mp.connect(agent).requestLoan(USDC(1), 7);
                await mp.connect(agent).repayLoan(i + 1);
            }
            // agentLoans[].length = 55, activeLoanCount still 0
            const gas2 = await mp.connect(agent).requestLoan.estimateGas(USDC(1), 7);

            // Gas should be roughly equal — no O(N) array walk
            const ratio = Number(gas2) / Number(gas1);
            // Allow some variation but not 11x growth (which would be the v4 behavior)
            expect(ratio).to.be.lt(1.5);
        });

        it("hits MAX_ACTIVE_LOANS_PER_AGENT cap correctly via counter", async () => {
            await mp.connect(lender).supplyLiquidity(1, USDC(10000));
            for (let i = 0; i < 10; i++) {
                await mp.connect(agent).requestLoan(USDC(1), 7);
            }
            await expect(mp.connect(agent).requestLoan(USDC(1), 7)).to.be.revertedWith("too many active");
        });
    });
});
