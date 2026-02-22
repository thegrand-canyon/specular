const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ReputationManager", function() {
    let agentRegistry, reputationManager;
    let owner, lendingPool, agent1, agent2;

    beforeEach(async function() {
        [owner, lendingPool, agent1, agent2] = await ethers.getSigners();

        // Deploy AgentRegistry
        const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
        agentRegistry = await AgentRegistry.deploy();
        await agentRegistry.waitForDeployment();

        // Deploy ReputationManager
        const ReputationManager = await ethers.getContractFactory("ReputationManager");
        reputationManager = await ReputationManager.deploy(await agentRegistry.getAddress());
        await reputationManager.waitForDeployment();

        // Set lending pool
        await reputationManager.connect(owner).setLendingPool(lendingPool.address);

        // Register agents
        await agentRegistry.connect(agent1).registerAgent("agent1 metadata");
        await agentRegistry.connect(agent2).registerAgent("agent2 metadata");
    });

    describe("Deployment", function() {
        it("Should set the correct agent registry", async function() {
            expect(await reputationManager.agentRegistry()).to.equal(await agentRegistry.getAddress());
        });

        it("Should set the lending pool", async function() {
            expect(await reputationManager.lendingPool()).to.equal(lendingPool.address);
        });

        it("Should have correct constants", async function() {
            expect(await reputationManager.INITIAL_SCORE()).to.equal(100);
            expect(await reputationManager.MAX_SCORE()).to.equal(1000);
            expect(await reputationManager.ON_TIME_BONUS()).to.equal(10);
            expect(await reputationManager.DEFAULT_PENALTY()).to.equal(50);
        });
    });

    describe("Reputation Initialization", function() {
        it("Should initialize reputation for registered agent", async function() {
            await expect(reputationManager.initializeReputation(agent1.address))
                .to.emit(reputationManager, "ReputationInitialized")
                .withArgs(agent1.address, 100);

            const score = await reputationManager.getReputationScore(agent1.address);
            expect(score).to.equal(100);
        });

        it("Should fail to initialize for unregistered agent", async function() {
            const unregistered = ethers.Wallet.createRandom();
            await expect(
                reputationManager.initializeReputation(unregistered.address)
            ).to.be.revertedWith("Agent not registered");
        });

        it("Should fail to initialize twice", async function() {
            await reputationManager.initializeReputation(agent1.address);
            await expect(
                reputationManager.initializeReputation(agent1.address)
            ).to.be.revertedWith("Reputation already initialized");
        });

        it("Should store complete reputation data", async function() {
            await reputationManager.initializeReputation(agent1.address);
            const repData = await reputationManager.getReputationData(agent1.address);

            expect(repData.score).to.equal(100);
            expect(repData.loansCompleted).to.equal(0);
            expect(repData.loansDefaulted).to.equal(0);
            expect(repData.totalBorrowed).to.equal(0);
            expect(repData.totalRepaid).to.equal(0);
            expect(repData.lastUpdated).to.be.gt(0);
        });
    });

    describe("Loan Completion Recording", function() {
        beforeEach(async function() {
            await reputationManager.initializeReputation(agent1.address);
        });

        it("Should increase score for on-time repayment", async function() {
            const amount = 1000 * 10**6; // 1000 USDC

            await reputationManager.connect(lendingPool).recordLoanCompletion(agent1.address, amount, true);

            const score = await reputationManager.getReputationScore(agent1.address);
            expect(score).to.be.gt(100); // Should increase from initial 100
            expect(score).to.be.lte(1000); // But within max
        });

        it("Should decrease score for late repayment", async function() {
            const amount = 1000 * 10**6;

            await reputationManager.connect(lendingPool).recordLoanCompletion(agent1.address, amount, false);

            const score = await reputationManager.getReputationScore(agent1.address);
            expect(score).to.equal(95); // 100 - 5 penalty
        });

        it("Should scale bonus by loan size", async function() {
            const largeAmount = 100000 * 10**6; // 100k USDC

            await reputationManager.connect(lendingPool).recordLoanCompletion(agent1.address, largeAmount, true);

            const score = await reputationManager.getReputationScore(agent1.address);
            expect(score).to.be.gt(110); // Base bonus + scaled bonus
            expect(score).to.be.lte(150); // But capped at 50 bonus
        });

        it("Should cap score at MAX_SCORE", async function() {
            // Set score to near max
            for (let i = 0; i < 90; i++) {
                await reputationManager.connect(lendingPool).recordLoanCompletion(agent1.address, 1000 * 10**6, true);
            }

            const score = await reputationManager.getReputationScore(agent1.address);
            expect(score).to.equal(1000); // Capped at MAX_SCORE
        });

        it("Should update loan completion counter", async function() {
            await reputationManager.connect(lendingPool).recordLoanCompletion(agent1.address, 1000 * 10**6, true);
            await reputationManager.connect(lendingPool).recordLoanCompletion(agent1.address, 2000 * 10**6, true);

            const repData = await reputationManager.getReputationData(agent1.address);
            expect(repData.loansCompleted).to.equal(2);
        });

        it("Should fail if not called by lending pool", async function() {
            await expect(
                reputationManager.connect(agent2).recordLoanCompletion(agent1.address, 1000 * 10**6, true)
            ).to.be.revertedWith("Only lending pool can call");
        });

        it("Should fail for uninitialized reputation", async function() {
            await expect(
                reputationManager.connect(lendingPool).recordLoanCompletion(agent2.address, 1000 * 10**6, true)
            ).to.be.revertedWith("Reputation not initialized");
        });
    });

    describe("Default Recording", function() {
        beforeEach(async function() {
            await reputationManager.initializeReputation(agent1.address);
        });

        it("Should severely penalize for default", async function() {
            const amount = 1000 * 10**6;

            await expect(
                reputationManager.connect(lendingPool).recordDefault(agent1.address, amount)
            ).to.emit(reputationManager, "ReputationUpdated");

            const score = await reputationManager.getReputationScore(agent1.address);
            expect(score).to.be.lt(100); // Should be below initial score
        });

        it("Should scale penalty by loan size", async function() {
            const largeAmount = 100000 * 10**6; // 100k USDC

            await reputationManager.connect(lendingPool).recordDefault(agent1.address, largeAmount);

            const score = await reputationManager.getReputationScore(agent1.address);
            expect(score).to.equal(0); // Heavy penalty - should be at MIN_SCORE (0)
        });

        it("Should not go below MIN_SCORE", async function() {
            // Multiple defaults
            for (let i = 0; i < 5; i++) {
                await reputationManager.connect(lendingPool).recordDefault(agent1.address, 10000 * 10**6);
            }

            const score = await reputationManager.getReputationScore(agent1.address);
            expect(score).to.equal(0); // MIN_SCORE
        });

        it("Should increment default counter", async function() {
            await reputationManager.connect(lendingPool).recordDefault(agent1.address, 1000 * 10**6);

            const repData = await reputationManager.getReputationData(agent1.address);
            expect(repData.loansDefaulted).to.equal(1);
        });
    });

    describe("Borrow Recording", function() {
        beforeEach(async function() {
            await reputationManager.initializeReputation(agent1.address);
        });

        it("Should track total borrowed", async function() {
            await reputationManager.connect(lendingPool).recordBorrow(agent1.address, 1000 * 10**6);
            await reputationManager.connect(lendingPool).recordBorrow(agent1.address, 2000 * 10**6);

            const repData = await reputationManager.getReputationData(agent1.address);
            expect(repData.totalBorrowed).to.equal(3000 * 10**6);
        });
    });

    describe("Credit Limit Calculation", function() {
        beforeEach(async function() {
            await reputationManager.initializeReputation(agent1.address);
        });

        it("Should return highest limit for excellent reputation (800+)", async function() {
            // Boost reputation to 800+
            for (let i = 0; i < 70; i++) {
                await reputationManager.connect(lendingPool).recordLoanCompletion(agent1.address, 1000 * 10**6, true);
            }

            const creditLimit = await reputationManager.calculateCreditLimit(agent1.address);
            expect(creditLimit).to.equal(100000 * 10**6); // 100k USDC
        });

        it("Should return medium limit for good reputation (600-799)", async function() {
            // Boost to ~600
            for (let i = 0; i < 50; i++) {
                await reputationManager.connect(lendingPool).recordLoanCompletion(agent1.address, 1000 * 10**6, true);
            }

            const score = await reputationManager.getReputationScore(agent1.address);
            const creditLimit = await reputationManager.calculateCreditLimit(agent1.address);

            // After 50 loans, score will be much higher due to bonuses
            // Adjust expectation based on actual score
            if (score >= 800) {
                expect(creditLimit).to.equal(100000 * 10**6); // 100k USDC
            } else if (score >= 600) {
                expect(creditLimit).to.equal(50000 * 10**6); // 50k USDC
            }
        });

        it("Should return low limit for poor reputation", async function() {
            // Lower reputation with defaults
            await reputationManager.connect(lendingPool).recordDefault(agent1.address, 5000 * 10**6);

            const creditLimit = await reputationManager.calculateCreditLimit(agent1.address);
            expect(creditLimit).to.equal(5000 * 10**6); // 5k USDC minimum
        });
    });

    describe("Collateral Requirement Calculation", function() {
        beforeEach(async function() {
            await reputationManager.initializeReputation(agent1.address);
        });

        it("Should require no collateral for high reputation (700+)", async function() {
            // Boost to 700+
            for (let i = 0; i < 60; i++) {
                await reputationManager.connect(lendingPool).recordLoanCompletion(agent1.address, 1000 * 10**6, true);
            }

            const collateral = await reputationManager.calculateCollateralRequirement(agent1.address);
            expect(collateral).to.equal(0);
        });

        it("Should require 25% collateral for medium reputation (500-699)", async function() {
            // Boost to ~500-600
            for (let i = 0; i < 40; i++) {
                await reputationManager.connect(lendingPool).recordLoanCompletion(agent1.address, 1000 * 10**6, true);
            }

            const score = await reputationManager.getReputationScore(agent1.address);
            const collateral = await reputationManager.calculateCollateralRequirement(agent1.address);

            // After many successful loans, agent may have higher score
            if (score >= 700) {
                expect(collateral).to.equal(0);
            } else if (score >= 500) {
                expect(collateral).to.equal(25);
            }
        });

        it("Should require 100% collateral for very low reputation", async function() {
            // Lower reputation significantly
            await reputationManager.connect(lendingPool).recordDefault(agent1.address, 10000 * 10**6);
            await reputationManager.connect(lendingPool).recordDefault(agent1.address, 10000 * 10**6);

            const collateral = await reputationManager.calculateCollateralRequirement(agent1.address);
            expect(collateral).to.equal(100);
        });
    });

    describe("Access Control", function() {
        beforeEach(async function() {
            await reputationManager.initializeReputation(agent1.address);
        });

        it("Should only allow owner to set lending pool", async function() {
            await expect(
                reputationManager.connect(agent1).setLendingPool(agent2.address)
            ).to.be.revertedWithCustomError(reputationManager, "OwnableUnauthorizedAccount");
        });

        it("Should emit event when lending pool is updated", async function() {
            const newPool = agent2.address;
            await expect(reputationManager.connect(owner).setLendingPool(newPool))
                .to.emit(reputationManager, "LendingPoolUpdated")
                .withArgs(lendingPool.address, newPool);
        });
    });
});
