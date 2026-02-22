const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("AgentLiquidityMarketplace", function () {
    let agentRegistry, reputationManager, usdc, marketplace;
    let owner, agent1, agent2, lender1, lender2;

    const USDC = (n) => ethers.parseUnits(n.toString(), 6);

    beforeEach(async function () {
        [owner, agent1, agent2, lender1, lender2] = await ethers.getSigners();

        // Deploy AgentRegistryV2
        const AgentRegistry = await ethers.getContractFactory("AgentRegistryV2");
        agentRegistry = await AgentRegistry.deploy();
        await agentRegistry.waitForDeployment();

        // Deploy ReputationManagerV3
        const ReputationManager = await ethers.getContractFactory("ReputationManagerV3");
        reputationManager = await ReputationManager.deploy(await agentRegistry.getAddress());
        await reputationManager.waitForDeployment();

        // Deploy MockUSDC
        const MockUSDC = await ethers.getContractFactory("MockUSDC");
        usdc = await MockUSDC.deploy();
        await usdc.waitForDeployment();

        // Deploy Marketplace
        const Marketplace = await ethers.getContractFactory("AgentLiquidityMarketplace");
        marketplace = await Marketplace.deploy(
            await agentRegistry.getAddress(),
            await reputationManager.getAddress(),
            await usdc.getAddress()
        );
        await marketplace.waitForDeployment();

        // Authorize marketplace in reputation manager
        await reputationManager.authorizePool(await marketplace.getAddress());

        // Register agents
        await agentRegistry.connect(agent1).register("ipfs://agent1", []);
        await agentRegistry.connect(agent2).register("ipfs://agent2", []);

        // Initialize reputations (scores start at 100, need >=500 for 0% collateral)
        await reputationManager.connect(agent1).initializeReputation();
        await reputationManager.connect(agent2).initializeReputation();

        // Mint USDC to all parties
        await usdc.mint(lender1.address, USDC(100000));
        await usdc.mint(lender2.address, USDC(100000));
        await usdc.mint(agent1.address, USDC(50000));
        await usdc.mint(agent2.address, USDC(50000));
    });

    // Helper: create pool for agent1 and supply liquidity
    async function setupPool(agent = agent1, liquidity = 10000) {
        await marketplace.connect(agent).createAgentPool();
        await usdc.connect(lender1).approve(await marketplace.getAddress(), USDC(liquidity));
        const agentId = await agentRegistry.addressToAgentId(agent.address);
        await marketplace.connect(lender1).supplyLiquidity(agentId, USDC(liquidity));
        return agentId;
    }

    // Helper: boost reputation to skip collateral
    async function boostReputation(agent, times = 40) {
        // Repeatedly call setScoringParameters to set onTimeBonus to 50, run loans off-chain
        // Instead, we manually boost via owner-controlled recordLoanCompletion calls
        // Since we can't do that easily, we'll just use the 100% collateral path for score=100
    }

    describe("Pool Creation", function () {
        it("Should allow a registered agent to create a pool", async function () {
            await marketplace.connect(agent1).createAgentPool();

            const agentId = await agentRegistry.addressToAgentId(agent1.address);
            const pool = await marketplace.agentPools(agentId);
            expect(pool.isActive).to.equal(true);
            expect(pool.agentAddress).to.equal(agent1.address);
        });

        it("Should emit PoolCreated event", async function () {
            const agentId = await agentRegistry.addressToAgentId(agent1.address);
            await expect(marketplace.connect(agent1).createAgentPool())
                .to.emit(marketplace, "PoolCreated")
                .withArgs(agentId, agent1.address);
        });

        it("Should not allow non-registered address to create pool", async function () {
            await expect(marketplace.connect(lender1).createAgentPool())
                .to.be.revertedWith("Not a registered agent");
        });

        it("Should not allow creating a second pool for the same agent", async function () {
            await marketplace.connect(agent1).createAgentPool();
            await expect(marketplace.connect(agent1).createAgentPool())
                .to.be.revertedWith("Pool already exists");
        });

        it("Should track pool IDs in agentPoolIds array", async function () {
            expect(await marketplace.totalPools()).to.equal(0);
            await marketplace.connect(agent1).createAgentPool();
            expect(await marketplace.totalPools()).to.equal(1);
            await marketplace.connect(agent2).createAgentPool();
            expect(await marketplace.totalPools()).to.equal(2);
        });

        it("Should store correct agentId in agentPoolIds", async function () {
            await marketplace.connect(agent1).createAgentPool();
            const agentId = await agentRegistry.addressToAgentId(agent1.address);
            expect(await marketplace.agentPoolIds(0)).to.equal(agentId);
        });
    });

    describe("Liquidity Supply & Withdrawal", function () {
        beforeEach(async function () {
            await marketplace.connect(agent1).createAgentPool();
        });

        it("Should allow lender to supply liquidity", async function () {
            const agentId = await agentRegistry.addressToAgentId(agent1.address);
            await usdc.connect(lender1).approve(await marketplace.getAddress(), USDC(5000));

            await expect(marketplace.connect(lender1).supplyLiquidity(agentId, USDC(5000)))
                .to.emit(marketplace, "LiquiditySupplied")
                .withArgs(agentId, lender1.address, USDC(5000));

            const pool = await marketplace.agentPools(agentId);
            expect(pool.totalLiquidity).to.equal(USDC(5000));
            expect(pool.availableLiquidity).to.equal(USDC(5000));
        });

        it("Should track lender positions", async function () {
            const agentId = await agentRegistry.addressToAgentId(agent1.address);
            await usdc.connect(lender1).approve(await marketplace.getAddress(), USDC(5000));
            await marketplace.connect(lender1).supplyLiquidity(agentId, USDC(5000));

            const position = await marketplace.positions(agentId, lender1.address);
            expect(position.amount).to.equal(USDC(5000));
        });

        it("Should accumulate multiple deposits from same lender", async function () {
            const agentId = await agentRegistry.addressToAgentId(agent1.address);
            await usdc.connect(lender1).approve(await marketplace.getAddress(), USDC(10000));
            await marketplace.connect(lender1).supplyLiquidity(agentId, USDC(3000));
            await marketplace.connect(lender1).supplyLiquidity(agentId, USDC(2000));

            const position = await marketplace.positions(agentId, lender1.address);
            expect(position.amount).to.equal(USDC(5000));
        });

        it("Should track multiple lenders", async function () {
            const agentId = await agentRegistry.addressToAgentId(agent1.address);
            await usdc.connect(lender1).approve(await marketplace.getAddress(), USDC(5000));
            await usdc.connect(lender2).approve(await marketplace.getAddress(), USDC(5000));

            await marketplace.connect(lender1).supplyLiquidity(agentId, USDC(5000));
            await marketplace.connect(lender2).supplyLiquidity(agentId, USDC(5000));

            const pool = await marketplace.agentPools(agentId);
            expect(pool.totalLiquidity).to.equal(USDC(10000));

            const [,,,,, , lenderCount] = await marketplace.getAgentPool(agentId);
            expect(lenderCount).to.equal(2);
        });

        it("Should allow lender to withdraw liquidity", async function () {
            const agentId = await agentRegistry.addressToAgentId(agent1.address);
            await usdc.connect(lender1).approve(await marketplace.getAddress(), USDC(5000));
            await marketplace.connect(lender1).supplyLiquidity(agentId, USDC(5000));

            const balanceBefore = await usdc.balanceOf(lender1.address);

            await expect(marketplace.connect(lender1).withdrawLiquidity(agentId, USDC(3000)))
                .to.emit(marketplace, "LiquidityWithdrawn")
                .withArgs(agentId, lender1.address, USDC(3000));

            const balanceAfter = await usdc.balanceOf(lender1.address);
            expect(balanceAfter - balanceBefore).to.equal(USDC(3000));

            const position = await marketplace.positions(agentId, lender1.address);
            expect(position.amount).to.equal(USDC(2000));
        });

        it("Should reject withdrawal exceeding position", async function () {
            const agentId = await agentRegistry.addressToAgentId(agent1.address);
            await usdc.connect(lender1).approve(await marketplace.getAddress(), USDC(1000));
            await marketplace.connect(lender1).supplyLiquidity(agentId, USDC(1000));

            await expect(marketplace.connect(lender1).withdrawLiquidity(agentId, USDC(2000)))
                .to.be.revertedWith("Insufficient balance");
        });

        it("Should reject supply of zero amount", async function () {
            const agentId = await agentRegistry.addressToAgentId(agent1.address);
            await expect(marketplace.connect(lender1).supplyLiquidity(agentId, 0))
                .to.be.revertedWith("Amount must be > 0");
        });
    });

    describe("Loan Lifecycle", function () {
        let agentId;

        beforeEach(async function () {
            agentId = await setupPool();
            // Approve collateral spending for agent1 (score=100, needs 100% collateral)
            await usdc.connect(agent1).approve(await marketplace.getAddress(), ethers.MaxUint256);
        });

        it("Should allow agent to request a loan", async function () {
            const tx = await marketplace.connect(agent1).requestLoan(USDC(500), 7);
            const receipt = await tx.wait();

            // Find LoanRequested event
            const event = receipt.logs.find(log => {
                try {
                    return marketplace.interface.parseLog(log)?.name === "LoanRequested";
                } catch { return false; }
            });
            expect(event).to.not.be.undefined;
        });

        it("Should auto-disburse with collateral for score 100 agent", async function () {
            const loanAmount = USDC(500);
            const agentBalBefore = await usdc.balanceOf(agent1.address);

            await marketplace.connect(agent1).requestLoan(loanAmount, 7);

            const agentBalAfter = await usdc.balanceOf(agent1.address);
            // Agent pays 100% collateral and receives loan: net zero
            expect(agentBalAfter).to.equal(agentBalBefore);

            const loan = await marketplace.loans(1);
            expect(loan.state).to.equal(1); // ACTIVE
        });

        it("Should reject loan exceeding available liquidity", async function () {
            await expect(marketplace.connect(agent1).requestLoan(USDC(50000), 7))
                .to.be.revertedWith("Insufficient pool liquidity");
        });

        it("Should reject loan with invalid duration", async function () {
            await expect(marketplace.connect(agent1).requestLoan(USDC(500), 6))
                .to.be.revertedWith("Invalid duration");
            await expect(marketplace.connect(agent1).requestLoan(USDC(500), 366))
                .to.be.revertedWith("Invalid duration");
        });

        it("Should reject loan from non-agent", async function () {
            await expect(marketplace.connect(lender1).requestLoan(USDC(500), 7))
                .to.be.revertedWith("Not a registered agent");
        });

        it("Should allow borrower to repay loan", async function () {
            await marketplace.connect(agent1).requestLoan(USDC(500), 7);

            const loan = await marketplace.loans(1);
            expect(loan.state).to.equal(1); // ACTIVE

            const interest = await marketplace.calculateInterest(
                loan.amount,
                loan.interestRate,
                loan.duration
            );
            const totalRepayment = loan.amount + interest;

            await usdc.connect(agent1).approve(await marketplace.getAddress(), totalRepayment);

            await expect(marketplace.connect(agent1).repayLoan(1))
                .to.emit(marketplace, "LoanRepaid");

            const repaidLoan = await marketplace.loans(1);
            expect(repaidLoan.state).to.equal(2); // REPAID
        });

        it("Should return collateral on repayment", async function () {
            const loanAmount = USDC(500);
            await marketplace.connect(agent1).requestLoan(loanAmount, 7);

            const loan = await marketplace.loans(1);
            const interest = await marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
            const totalRepayment = loan.amount + interest;

            await usdc.connect(agent1).approve(await marketplace.getAddress(), totalRepayment);

            const balBefore = await usdc.balanceOf(agent1.address);
            await marketplace.connect(agent1).repayLoan(1);
            const balAfter = await usdc.balanceOf(agent1.address);

            // Should get back collateral - totalRepayment  (net: +collateral - principal - interest)
            // collateral = principal (100%), so net = -interest
            const netChange = balAfter - balBefore;
            expect(netChange).to.equal(-interest);
        });

        it("Should distribute interest to lenders", async function () {
            const loanAmount = USDC(500);
            await marketplace.connect(agent1).requestLoan(loanAmount, 7);

            const loan = await marketplace.loans(1);
            const interest = await marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
            const totalRepayment = loan.amount + interest;

            await usdc.connect(agent1).approve(await marketplace.getAddress(), totalRepayment);
            await marketplace.connect(agent1).repayLoan(1);

            const position = await marketplace.getLenderPosition(agentId, lender1.address);
            expect(position.earnedInterest).to.be.gt(0);
        });

        it("Should allow lender to claim interest", async function () {
            const loanAmount = USDC(500);
            await marketplace.connect(agent1).requestLoan(loanAmount, 7);

            const loan = await marketplace.loans(1);
            const interest = await marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
            await usdc.connect(agent1).approve(await marketplace.getAddress(), loan.amount + interest);
            await marketplace.connect(agent1).repayLoan(1);

            const positionBefore = await marketplace.getLenderPosition(agentId, lender1.address);
            const earnedInterest = positionBefore.earnedInterest;
            expect(earnedInterest).to.be.gt(0);

            const balBefore = await usdc.balanceOf(lender1.address);
            await marketplace.connect(lender1).claimInterest(agentId);
            const balAfter = await usdc.balanceOf(lender1.address);

            expect(balAfter - balBefore).to.equal(earnedInterest);

            const positionAfter = await marketplace.getLenderPosition(agentId, lender1.address);
            expect(positionAfter.earnedInterest).to.equal(0);
        });

        it("Should reject repay from non-borrower", async function () {
            await marketplace.connect(agent1).requestLoan(USDC(500), 7);
            await expect(marketplace.connect(lender1).repayLoan(1))
                .to.be.revertedWith("Not the borrower");
        });
    });

    describe("Loan Liquidation", function () {
        let agentId;

        beforeEach(async function () {
            agentId = await setupPool();
            await usdc.connect(agent1).approve(await marketplace.getAddress(), ethers.MaxUint256);
        });

        it("Should allow owner to liquidate overdue loan", async function () {
            await marketplace.connect(agent1).requestLoan(USDC(500), 7);

            // Fast forward past end time
            await time.increase(8 * 24 * 60 * 60); // 8 days

            await expect(marketplace.connect(owner).liquidateLoan(1))
                .to.emit(marketplace, "LoanDefaulted")
                .withArgs(1);

            const loan = await marketplace.loans(1);
            expect(loan.state).to.equal(3); // DEFAULTED
        });

        it("Should not liquidate non-overdue loan", async function () {
            await marketplace.connect(agent1).requestLoan(USDC(500), 30);

            await expect(marketplace.connect(owner).liquidateLoan(1))
                .to.be.revertedWith("Loan not overdue");
        });

        it("Should not allow non-owner to liquidate", async function () {
            await marketplace.connect(agent1).requestLoan(USDC(500), 7);
            await time.increase(8 * 24 * 60 * 60);

            await expect(marketplace.connect(lender1).liquidateLoan(1))
                .to.be.revertedWithCustomError(marketplace, "OwnableUnauthorizedAccount");
        });
    });

    describe("Interest Calculation", function () {
        it("Should calculate interest correctly", async function () {
            const principal = USDC(1000);
            const rateBPS = 500; // 5%
            const duration = 30 * 24 * 60 * 60; // 30 days in seconds

            const interest = await marketplace.calculateInterest(principal, rateBPS, duration);
            // Expected: 1000 * 0.05 * (30/365) ≈ 4.109589 USDC
            const expected = (principal * BigInt(rateBPS) * BigInt(duration)) / (10000n * BigInt(365 * 24 * 60 * 60));
            expect(interest).to.equal(expected);
        });
    });

    describe("Platform Fees", function () {
        it("Should accumulate platform fees on repayment", async function () {
            const agentId = await setupPool();
            await usdc.connect(agent1).approve(await marketplace.getAddress(), ethers.MaxUint256);
            await marketplace.connect(agent1).requestLoan(USDC(500), 7);

            const loan = await marketplace.loans(1);
            const interest = await marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
            await usdc.connect(agent1).approve(await marketplace.getAddress(), loan.amount + interest);
            await marketplace.connect(agent1).repayLoan(1);

            const fees = await marketplace.accumulatedFees();
            expect(fees).to.be.gt(0);
        });

        it("Should allow owner to withdraw fees", async function () {
            const agentId = await setupPool();
            await usdc.connect(agent1).approve(await marketplace.getAddress(), ethers.MaxUint256);
            await marketplace.connect(agent1).requestLoan(USDC(500), 7);

            const loan = await marketplace.loans(1);
            const interest = await marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
            await usdc.connect(agent1).approve(await marketplace.getAddress(), loan.amount + interest);
            await marketplace.connect(agent1).repayLoan(1);

            const fees = await marketplace.accumulatedFees();
            const balBefore = await usdc.balanceOf(owner.address);

            await marketplace.connect(owner).withdrawFees(fees);

            const balAfter = await usdc.balanceOf(owner.address);
            expect(balAfter - balBefore).to.equal(fees);
            expect(await marketplace.accumulatedFees()).to.equal(0);
        });

        it("Should allow owner to update fee rate within limit", async function () {
            await expect(marketplace.connect(owner).setPlatformFeeRate(300))
                .to.not.be.reverted;
            expect(await marketplace.platformFeeRate()).to.equal(300);
        });

        it("Should reject fee rate above 5%", async function () {
            await expect(marketplace.connect(owner).setPlatformFeeRate(501))
                .to.be.revertedWith("Fee too high");
        });
    });

    describe("View Functions", function () {
        it("Should return correct pool details via getAgentPool", async function () {
            const agentId = await setupPool();

            const [agentAddr, totalLiq, availLiq, totalLoaned, , utilization, lenderCount] =
                await marketplace.getAgentPool(agentId);

            expect(agentAddr).to.equal(agent1.address);
            expect(totalLiq).to.equal(USDC(10000));
            expect(availLiq).to.equal(USDC(10000));
            expect(totalLoaned).to.equal(0);
            expect(utilization).to.equal(0);
            expect(lenderCount).to.equal(1);
        });

        it("Should return correct lender position via getLenderPosition", async function () {
            const agentId = await setupPool();

            const [amount, , , share] = await marketplace.getLenderPosition(agentId, lender1.address);
            expect(amount).to.equal(USDC(10000));
            expect(share).to.equal(10000); // 100% in basis points
        });

        it("Should calculate utilization rate correctly after loan", async function () {
            const agentId = await setupPool();
            await usdc.connect(agent1).approve(await marketplace.getAddress(), ethers.MaxUint256);
            await marketplace.connect(agent1).requestLoan(USDC(500), 7);

            const [, totalLiq, , totalLoaned, , utilization] = await marketplace.getAgentPool(agentId);
            // 500 / 10000 * 10000 = 500 bps = 5%
            expect(utilization).to.equal(500);
        });
    });

    describe("Pause Functionality", function () {
        it("Should allow owner to pause and unpause", async function () {
            await marketplace.connect(owner).pause();
            await expect(marketplace.connect(agent1).createAgentPool())
                .to.be.revertedWithCustomError(marketplace, "EnforcedPause");

            await marketplace.connect(owner).unpause();
            await expect(marketplace.connect(agent1).createAgentPool())
                .to.not.be.reverted;
        });
    });
});
