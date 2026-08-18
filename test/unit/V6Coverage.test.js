// V6 coverage gap-fillers: liquidateLoan, pause/unpause, setMigrationFinalized hardness.
// These functions were inherited from v4 (so v4 tests cover them) but not directly
// exercised in V6 unit tests, which lowered V6 coverage to 73%. This closes the gap.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("V6 coverage gap-fillers", function () {
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

    describe("liquidateLoan on V6", () => {
        it("decrements activeLoanCount on liquidation", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(500));
            await v6.connect(agent).requestLoan(USDC(100), 7);
            expect(await v6.activeLoanCount(1)).to.equal(1);

            // Fast-forward past loan endTime
            await time.increase(8 * 24 * 3600);
            await v6.liquidateLoan(1);
            expect(await v6.activeLoanCount(1)).to.equal(0, '§S5: counter must decrement on liquidation');

            const loan = await v6.loans(1);
            expect(Number(loan.state)).to.equal(3); // DEFAULTED
        });

        it("reverts if loan not yet overdue", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(500));
            await v6.connect(agent).requestLoan(USDC(100), 7);
            await expect(v6.liquidateLoan(1)).to.be.revertedWith("Loan not overdue");
        });

        it("reverts if loan not active", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(500));
            await v6.connect(agent).requestLoan(USDC(100), 7);
            await v6.connect(agent).repayLoan(1);
            await time.increase(8 * 24 * 3600);
            await expect(v6.liquidateLoan(1)).to.be.revertedWith("Loan not active");
        });

        it("non-owner cannot liquidate", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(500));
            await v6.connect(agent).requestLoan(USDC(100), 7);
            await time.increase(8 * 24 * 3600);
            await expect(v6.connect(lender).liquidateLoan(1)).to.be.reverted;
        });

        it("returns collateral to pool", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(500));
            await v6.connect(agent).requestLoan(USDC(100), 7);
            const beforePool = await v6.getAgentPool(1);
            await time.increase(8 * 24 * 3600);
            await v6.liquidateLoan(1);
            const afterPool = await v6.getAgentPool(1);
            // availableLiquidity increases by collateral seized
            expect(afterPool.availableLiquidity).to.be.gt(beforePool.availableLiquidity);
        });
    });

    describe("pause / unpause on V6", () => {
        it("only owner can pause", async () => {
            await expect(v6.connect(lender).pause()).to.be.reverted;
        });

        it("supplyLiquidity reverts when paused", async () => {
            await v6.pause();
            await expect(v6.connect(lender).supplyLiquidity(1, USDC(100)))
                .to.be.revertedWithCustomError(v6, "EnforcedPause");
        });

        it("requestLoan reverts when paused", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(500));
            await v6.pause();
            await expect(v6.connect(agent).requestLoan(USDC(100), 7))
                .to.be.revertedWithCustomError(v6, "EnforcedPause");
        });

        it("repayLoan reverts when paused", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(500));
            await v6.connect(agent).requestLoan(USDC(100), 7);
            await v6.pause();
            await expect(v6.connect(agent).repayLoan(1))
                .to.be.revertedWithCustomError(v6, "EnforcedPause");
        });

        it("liquidateLoan still works when paused (intentional — recovery path)", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(500));
            await v6.connect(agent).requestLoan(USDC(100), 7);
            await time.increase(8 * 24 * 3600);
            await v6.pause();
            // liquidateLoan does NOT have whenNotPaused — by design
            await v6.liquidateLoan(1);
            const loan = await v6.loans(1);
            expect(Number(loan.state)).to.equal(3); // DEFAULTED
        });

        it("unpause restores normal operation", async () => {
            await v6.pause();
            await v6.unpause();
            await v6.connect(lender).supplyLiquidity(1, USDC(100));
            const pos = await v6.positions(1, lender.address);
            expect(pos.amount).to.equal(USDC(100));
        });
    });

    describe("setMigrationFinalized hardness", () => {
        it("fresh contract has migrationFinalized=false", async () => {
            expect(await v6.migrationFinalized()).to.equal(false);
        });

        it("seedPool works before finalization", async () => {
            // Register a new agent first (post-fix #1: seedPool validates agentAddress in registry)
            await registry.connect(lender).register("ipfs://seed-pool-test", []);
            const aid = await registry.addressToAgentId(lender.address);
            await v6.seedPool(aid, lender.address, USDC(100), USDC(100), 0);
            const pool = await v6.getAgentPool(aid);
            expect(pool.totalLiquidity).to.equal(USDC(100));
        });

        it("setMigrationFinalized locks all seed* functions permanently", async () => {
            await v6.setMigrationFinalized();
            expect(await v6.migrationFinalized()).to.equal(true);
            await expect(v6.seedPool(99, owner.address, 0, 0, 0)).to.be.revertedWith("Migration finalized");
            await expect(v6.seedPosition(1, lender.address, 0, 0, 0)).to.be.revertedWith("Migration finalized");
            await expect(v6.setMigrationFinalized()).to.be.revertedWith("Migration finalized");
        });

        it("compactPoolLenders still works post-finalization (intentional)", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(100));
            await v6.setMigrationFinalized();
            // compactPoolLenders is NOT gated by whileMigrating
            await v6.compactPoolLenders(1);
            const pool = await v6.getAgentPool(1);
            expect(pool.lenderCount).to.equal(1);
        });

        it("normal user operations work after finalization", async () => {
            await v6.setMigrationFinalized();
            await v6.connect(lender).supplyLiquidity(1, USDC(100));
            await v6.connect(agent).requestLoan(USDC(50), 7);
            await v6.connect(agent).repayLoan(1);
            // pool earned interest
            const pool = await v6.getAgentPool(1);
            expect(pool.totalEarned).to.be.gt(0);
        });

        it("non-owner cannot finalize", async () => {
            await expect(v6.connect(lender).setMigrationFinalized()).to.be.reverted;
        });
    });

    describe("legacy helpers retained from v4", () => {
        it("totalPools returns correct count", async () => {
            expect(await v6.totalPools()).to.equal(1);
            // Register another agent + seedPool (post-fix #1: seedPool validates registry)
            await registry.connect(lender).register("ipfs://totalPools-test", []);
            const aid = await registry.addressToAgentId(lender.address);
            await v6.seedPool(aid, lender.address, 0, 0, 0);
            expect(await v6.totalPools()).to.equal(2);
        });

        it("getActiveAgents reverts as expected (v4 design)", async () => {
            await expect(v6.getActiveAgents()).to.be.revertedWith("Use front-end to query specific agents");
        });

        it("setPlatformFeeRate works for owner", async () => {
            await v6.setPlatformFeeRate(200);
            expect(await v6.platformFeeRate()).to.equal(200);
        });

        it("setPlatformFeeRate caps at 5%", async () => {
            await expect(v6.setPlatformFeeRate(501)).to.be.revertedWith("Fee too high");
        });
    });
});
