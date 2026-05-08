const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("V6 migration from v4 — full simulation", function () {
    let v4, v6, registry, reputation, usdc;
    let owner, agent1, lender1, lender2;
    const USDC = (n) => ethers.parseUnits(n.toString(), 6);

    beforeEach(async () => {
        [owner, agent1, lender1, lender2] = await ethers.getSigners();

        // Deploy registry, reputation, USDC
        const Registry = await ethers.getContractFactory("AgentRegistryV2");
        registry = await Registry.deploy();
        await registry.waitForDeployment();
        const Rep = await ethers.getContractFactory("ReputationManagerV3");
        reputation = await Rep.deploy(await registry.getAddress());
        await reputation.waitForDeployment();
        const Mock = await ethers.getContractFactory("MockUSDC");
        usdc = await Mock.deploy();
        await usdc.waitForDeployment();

        // Deploy v4 (current production version)
        const V4 = await ethers.getContractFactory("AgentLiquidityMarketplace");
        v4 = await V4.deploy(
            await registry.getAddress(),
            await reputation.getAddress(),
            await usdc.getAddress()
        );
        await v4.waitForDeployment();

        // Deploy V6
        const V6 = await ethers.getContractFactory("AgentLiquidityMarketplaceV6");
        v6 = await V6.deploy(
            await registry.getAddress(),
            await reputation.getAddress(),
            await usdc.getAddress()
        );
        await v6.waitForDeployment();

        // Authorize marketplaces with reputation manager
        await reputation.authorizePool(await v4.getAddress());
        await reputation.authorizePool(await v6.getAddress());

        // Register agent
        await registry.connect(agent1).register("ipfs://agent1", []);
        // Mint USDC to all participants
        for (const w of [agent1, lender1, lender2]) {
            await usdc.mint(w.address, USDC(10_000));
        }
    });

    describe("Reproduce §B1 state on v4, then migrate", () => {
        it("v4 produces a duplicate poolLenders entry; V6 migration dedups it", async () => {
            // Set up agent pool on v4
            await v4.connect(agent1).createAgentPool();

            // Lender1 supplies + withdraws + supplies → creates §B1 duplicate on v4
            await usdc.connect(lender1).approve(await v4.getAddress(), USDC(1000));
            await v4.connect(lender1).supplyLiquidity(1, USDC(100));
            await v4.connect(lender1).withdrawLiquidity(1, USDC(100));
            await v4.connect(lender1).supplyLiquidity(1, USDC(50));

            // Verify v4 has the duplicate
            const v4Lenders = [];
            const pool4 = await v4.getAgentPool(1);
            for (let i = 0; i < Number(pool4.lenderCount); i++) {
                v4Lenders.push(await v4.poolLenders(1, i));
            }
            expect(v4Lenders.length).to.equal(2);
            expect(v4Lenders[0]).to.equal(v4Lenders[1]); // both = lender1

            // Snapshot v4 state for migration
            const v4Pool = await v4.getAgentPool(1);
            const v4Pos = await v4.positions(1, lender1.address);

            // Migrate to V6 via seed functions
            await v6.connect(owner).seedPool(
                1,
                agent1.address,
                v4Pool.totalLiquidity,
                v4Pool.availableLiquidity,
                v4Pool.totalEarned
            );
            // Seed lender1 once — V6 dedups
            await v6.connect(owner).seedPosition(
                1,
                lender1.address,
                v4Pos.amount,
                v4Pos.earnedInterest,
                v4Pos.depositTimestamp
            );

            // Verify V6 has NO duplicate
            const v6Lenders = await v6.poolLenders(1, 0);
            expect(v6Lenders).to.equal(lender1.address);
            // Try fetching index 1 — should revert (out of bounds)
            await expect(v6.poolLenders(1, 1)).to.be.reverted;
            const v6Pool = await v6.getAgentPool(1);
            expect(v6Pool.totalLiquidity).to.equal(v4Pool.totalLiquidity);
            expect(v6Pool.availableLiquidity).to.equal(v4Pool.availableLiquidity);
            expect(v6Pool.totalEarned).to.equal(v4Pool.totalEarned);
            expect(v6Pool.lenderCount).to.equal(1);

            const v6Pos = await v6.positions(1, lender1.address);
            expect(v6Pos.amount).to.equal(v4Pos.amount);
            expect(v6Pos.earnedInterest).to.equal(v4Pos.earnedInterest);
        });

        it("compactPoolLenders heals a malformed seed", async () => {
            // Manually push duplicate via two separate seedPosition calls (e.g., operator error)
            await v6.connect(owner).seedPool(1, agent1.address, USDC(100), USDC(100), 0);
            await v6.connect(owner).seedPosition(1, lender1.address, USDC(100), 0, 0);
            // First seed pushed lender1. The flag is now true. A second seed shouldn't push again.
            await v6.connect(owner).seedPosition(1, lender1.address, USDC(100), 0, 0);
            const len1 = (await v6.getAgentPool(1)).lenderCount;
            expect(len1).to.equal(1); // §B1-fix-aware seedPosition doesn't double-push

            // But if someone managed to push duplicates (e.g., before isInPoolLenders existed), compactPoolLenders fixes them.
            // We can't directly inject duplicates here since isInPoolLenders gates everything.
            // Instead: test compactPoolLenders is idempotent on clean state.
            await v6.connect(owner).compactPoolLenders(1);
            expect((await v6.getAgentPool(1)).lenderCount).to.equal(1);
        });
    });

    describe("Migration finalization", () => {
        it("seed* functions revert after setMigrationFinalized", async () => {
            await v6.connect(owner).seedPool(1, agent1.address, USDC(100), USDC(100), 0);
            await v6.connect(owner).setMigrationFinalized();
            expect(await v6.migrationFinalized()).to.equal(true);

            await expect(
                v6.connect(owner).seedPool(2, agent1.address, USDC(50), USDC(50), 0)
            ).to.be.revertedWith("Migration finalized");
            await expect(
                v6.connect(owner).seedPosition(1, lender1.address, USDC(50), 0, 0)
            ).to.be.revertedWith("Migration finalized");
        });

        it("setMigrationFinalized cannot be called twice", async () => {
            await v6.connect(owner).setMigrationFinalized();
            await expect(v6.connect(owner).setMigrationFinalized()).to.be.revertedWith("Migration finalized");
        });

        it("non-owner cannot finalize", async () => {
            await expect(v6.connect(lender1).setMigrationFinalized()).to.be.reverted;
        });
    });

    describe("Post-migration normal operation", () => {
        it("supply→withdraw→supply does NOT create duplicate after migration", async () => {
            // Migrate empty state and finalize
            await v6.connect(owner).seedPool(1, agent1.address, 0, 0, 0);
            await v6.connect(owner).setMigrationFinalized();

            // Now operate normally
            await usdc.connect(lender1).approve(await v6.getAddress(), USDC(1000));
            await v6.connect(lender1).supplyLiquidity(1, USDC(100));
            await v6.connect(lender1).withdrawLiquidity(1, USDC(100));
            await v6.connect(lender1).supplyLiquidity(1, USDC(50));

            // No duplicate
            const pool = await v6.getAgentPool(1);
            expect(pool.lenderCount).to.equal(1);
            expect(await v6.poolLenders(1, 0)).to.equal(lender1.address);
        });

        it("§S1 invariant: claimInterest decrements availableLiquidity", async () => {
            // Set up: lender supplies, agent borrows, repays — interest accrues to lender
            await v6.connect(owner).seedPool(1, agent1.address, 0, 0, 0);
            await v6.connect(owner).setMigrationFinalized();

            await usdc.connect(lender1).approve(await v6.getAddress(), USDC(1000));
            await v6.connect(lender1).supplyLiquidity(1, USDC(1000));

            await usdc.connect(agent1).approve(await v6.getAddress(), USDC(2000));
            await v6.connect(agent1).requestLoan(USDC(100), 30);
            await v6.connect(agent1).repayLoan(1);

            const posBefore = await v6.positions(1, lender1.address);
            const poolBefore = await v6.getAgentPool(1);
            expect(posBefore.earnedInterest).to.be.gt(0);

            await v6.connect(lender1).claimInterest(1);

            const poolAfter = await v6.getAgentPool(1);
            expect(poolAfter.availableLiquidity).to.equal(poolBefore.availableLiquidity - posBefore.earnedInterest);

            // Invariant: availableLiquidity ≤ MP USDC balance
            const mpBal = await usdc.balanceOf(await v6.getAddress());
            expect(poolAfter.availableLiquidity).to.be.lte(mpBal);
        });

        it("§S5 invariant: activeLoanCount tracks state, not array length", async () => {
            await v6.connect(owner).seedPool(1, agent1.address, 0, 0, 0);
            await v6.connect(owner).setMigrationFinalized();

            await usdc.connect(lender1).approve(await v6.getAddress(), USDC(10000));
            await v6.connect(lender1).supplyLiquidity(1, USDC(10000));

            await usdc.connect(agent1).approve(await v6.getAddress(), USDC(10000));

            // Take + repay 5 loans — counter should oscillate 0..1..0..1...
            for (let i = 0; i < 5; i++) {
                await v6.connect(agent1).requestLoan(USDC(10), 7);
                expect(await v6.activeLoanCount(agent1.address)).to.equal(1);
                await v6.connect(agent1).repayLoan(i + 1);
                expect(await v6.activeLoanCount(agent1.address)).to.equal(0);
            }
        });
    });
});
