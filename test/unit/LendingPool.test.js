const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("LendingPool", function() {
    let agentRegistry, reputationManager, mockUSDC, lendingPool;
    let owner, agent1, agent2, lender;
    const USDC_DECIMALS = 10**6;

    beforeEach(async function() {
        [owner, agent1, agent2, lender] = await ethers.getSigners();

        // Deploy contracts
        const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
        agentRegistry = await AgentRegistry.deploy();
        await agentRegistry.waitForDeployment();

        const ReputationManager = await ethers.getContractFactory("ReputationManager");
        reputationManager = await ReputationManager.deploy(await agentRegistry.getAddress());
        await reputationManager.waitForDeployment();

        const MockUSDC = await ethers.getContractFactory("MockUSDC");
        mockUSDC = await MockUSDC.deploy();
        await mockUSDC.waitForDeployment();

        const LendingPool = await ethers.getContractFactory("LendingPool");
        lendingPool = await LendingPool.deploy(
            await agentRegistry.getAddress(),
            await reputationManager.getAddress(),
            await mockUSDC.getAddress()
        );
        await lendingPool.waitForDeployment();

        // Set lending pool in reputation manager
        await reputationManager.setLendingPool(await lendingPool.getAddress());

        // Register agents
        await agentRegistry.connect(agent1).registerAgent("agent1 metadata");
        await agentRegistry.connect(agent2).registerAgent("agent2 metadata");

        // Initialize reputations
        await reputationManager.initializeReputation(agent1.address);
        await reputationManager.initializeReputation(agent2.address);

        // Fund pool with liquidity
        await mockUSDC.transfer(lender.address, 100000 * USDC_DECIMALS);
        await mockUSDC.connect(lender).approve(await lendingPool.getAddress(), ethers.MaxUint256);
        await lendingPool.connect(lender).depositLiquidity(100000 * USDC_DECIMALS);
    });

    describe("Deployment", function() {
        it("Should set correct contract addresses", async function() {
            expect(await lendingPool.agentRegistry()).to.equal(await agentRegistry.getAddress());
            expect(await lendingPool.reputationManager()).to.equal(await reputationManager.getAddress());
            expect(await lendingPool.usdcToken()).to.equal(await mockUSDC.getAddress());
        });

        it("Should have correct initial liquidity", async function() {
            expect(await lendingPool.totalLiquidity()).to.equal(100000 * USDC_DECIMALS);
            expect(await lendingPool.availableLiquidity()).to.equal(100000 * USDC_DECIMALS);
            expect(await lendingPool.totalLoaned()).to.equal(0);
        });
    });

    describe("Loan Requests", function() {
        it("Should allow agent to request loan", async function() {
            const amount = 1000 * USDC_DECIMALS;
            const duration = 30;

            // Approve USDC for potential collateral
            await mockUSDC.transfer(agent1.address, 5000 * USDC_DECIMALS);
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);

            await expect(lendingPool.connect(agent1).requestLoan(amount, duration))
                .to.emit(lendingPool, "LoanRequested")
                .withArgs(0, agent1.address, amount, duration);
        });

        it("Should create loan with correct details", async function() {
            const amount = 1000 * USDC_DECIMALS;
            const duration = 30;

            // Approve USDC for potential collateral
            await mockUSDC.transfer(agent1.address, 5000 * USDC_DECIMALS);
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);

            await lendingPool.connect(agent1).requestLoan(amount, duration);

            const loan = await lendingPool.getLoan(0);
            expect(loan.borrower).to.equal(agent1.address);
            expect(loan.amount).to.equal(amount);
            expect(loan.durationDays).to.equal(duration);
            expect(loan.state).to.equal(0); // REQUESTED
        });

        it("Should fail if agent not active", async function() {
            await agentRegistry.deactivateAgent(agent1.address);

            await expect(
                lendingPool.connect(agent1).requestLoan(1000 * USDC_DECIMALS, 30)
            ).to.be.revertedWith("Agent not active");
        });

        it("Should fail with zero amount", async function() {
            await expect(
                lendingPool.connect(agent1).requestLoan(0, 30)
            ).to.be.revertedWith("Amount must be positive");
        });

        it("Should fail with invalid duration", async function() {
            await expect(
                lendingPool.connect(agent1).requestLoan(1000 * USDC_DECIMALS, 0)
            ).to.be.revertedWith("Invalid duration");

            await expect(
                lendingPool.connect(agent1).requestLoan(1000 * USDC_DECIMALS, 366)
            ).to.be.revertedWith("Invalid duration");
        });

        it("Should fail if amount exceeds credit limit", async function() {
            const creditLimit = await reputationManager.calculateCreditLimit(agent1.address);
            const tooMuch = creditLimit + BigInt(1000 * USDC_DECIMALS);

            await expect(
                lendingPool.connect(agent1).requestLoan(tooMuch, 30)
            ).to.be.revertedWith("Amount exceeds credit limit");
        });

        it("Should require collateral for low reputation", async function() {
            // Request, approve, and default on a loan to lower reputation
            await mockUSDC.transfer(agent1.address, 10000 * USDC_DECIMALS);
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);

            await lendingPool.connect(agent1).requestLoan(1000 * USDC_DECIMALS, 1);
            await lendingPool.connect(owner).approveLoan(0);

            const loan0 = await lendingPool.getLoan(0);
            await time.increaseTo(loan0.endTime + BigInt(86400));
            await lendingPool.connect(owner).liquidateLoan(0);

            // Now request a new loan - should require collateral
            const amount = 1000 * USDC_DECIMALS;
            await lendingPool.connect(agent1).requestLoan(amount, 30);

            const loan1 = await lendingPool.getLoan(1);
            expect(loan1.collateralAmount).to.be.gt(0);
        });

        it("Should track borrower loans", async function() {
            // Approve USDC for potential collateral
            await mockUSDC.transfer(agent1.address, 10000 * USDC_DECIMALS);
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);

            await lendingPool.connect(agent1).requestLoan(1000 * USDC_DECIMALS, 30);
            await lendingPool.connect(agent1).requestLoan(2000 * USDC_DECIMALS, 60);

            const loans = await lendingPool.getBorrowerLoans(agent1.address);
            expect(loans.length).to.equal(2);
            expect(loans[0]).to.equal(0);
            expect(loans[1]).to.equal(1);
        });
    });

    describe("Loan Approval", function() {
        let loanId;

        beforeEach(async function() {
            // Approve USDC for potential collateral
            await mockUSDC.transfer(agent1.address, 5000 * USDC_DECIMALS);
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);

            const tx = await lendingPool.connect(agent1).requestLoan(1000 * USDC_DECIMALS, 30);
            const receipt = await tx.wait();
            loanId = 0;
        });

        it("Should allow owner to approve loan", async function() {
            await expect(lendingPool.connect(owner).approveLoan(loanId))
                .to.emit(lendingPool, "LoanApproved");
        });

        it("Should transfer funds to borrower", async function() {
            const balanceBefore = await mockUSDC.balanceOf(agent1.address);
            await lendingPool.connect(owner).approveLoan(loanId);
            const balanceAfter = await mockUSDC.balanceOf(agent1.address);

            expect(balanceAfter - balanceBefore).to.equal(1000 * USDC_DECIMALS);
        });

        it("Should update liquidity correctly", async function() {
            await lendingPool.connect(owner).approveLoan(loanId);

            expect(await lendingPool.availableLiquidity()).to.equal(99000 * USDC_DECIMALS);
            expect(await lendingPool.totalLoaned()).to.equal(1000 * USDC_DECIMALS);
        });

        it("Should set correct interest rate based on reputation", async function() {
            await lendingPool.connect(owner).approveLoan(loanId);

            const loan = await lendingPool.getLoan(loanId);
            expect(loan.interestRate).to.be.gt(0);
            expect(loan.state).to.equal(2); // ACTIVE
        });

        it("Should fail if not owner", async function() {
            await expect(
                lendingPool.connect(agent2).approveLoan(loanId)
            ).to.be.revertedWithCustomError(lendingPool, "OwnableUnauthorizedAccount");
        });

        it("Should fail if insufficient liquidity", async function() {
            // Withdraw most liquidity first
            await lendingPool.connect(owner).withdrawLiquidity(98000 * USDC_DECIMALS);

            // Now request huge loan that exceeds available liquidity
            await mockUSDC.transfer(agent2.address, 10000 * USDC_DECIMALS);
            await mockUSDC.connect(agent2).approve(await lendingPool.getAddress(), ethers.MaxUint256);
            await lendingPool.connect(agent2).requestLoan(5000 * USDC_DECIMALS, 30);

            // Try to approve with insufficient liquidity (only 2000 left, need 5000)
            await expect(
                lendingPool.connect(owner).approveLoan(1)
            ).to.be.revertedWith("Insufficient liquidity");
        });
    });

    describe("Loan Repayment", function() {
        let loanId;
        const loanAmount = 1000 * USDC_DECIMALS;

        beforeEach(async function() {
            // Approve USDC for potential collateral first
            await mockUSDC.transfer(agent1.address, 10000 * USDC_DECIMALS);
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);

            await lendingPool.connect(agent1).requestLoan(loanAmount, 30);
            await lendingPool.connect(owner).approveLoan(0);
            loanId = 0;
        });

        it("Should allow borrower to repay loan", async function() {
            await expect(lendingPool.connect(agent1).repayLoan(loanId))
                .to.emit(lendingPool, "LoanRepaid");
        });

        it("Should calculate interest correctly", async function() {
            const loan = await lendingPool.getLoan(loanId);
            const interest = await lendingPool.calculateInterest(
                loan.amount,
                loan.interestRate,
                loan.durationDays
            );

            expect(interest).to.be.gt(0);
            expect(interest).to.be.lt(loan.amount); // Interest should be reasonable
        });

        it("Should update loan state to REPAID", async function() {
            await lendingPool.connect(agent1).repayLoan(loanId);

            const loan = await lendingPool.getLoan(loanId);
            expect(loan.state).to.equal(3); // REPAID
        });

        it("Should restore and increase liquidity with interest", async function() {
            const liquidityBefore = await lendingPool.availableLiquidity();
            await lendingPool.connect(agent1).repayLoan(loanId);
            const liquidityAfter = await lendingPool.availableLiquidity();

            expect(liquidityAfter).to.be.gt(liquidityBefore);
            expect(liquidityAfter).to.be.gt(100000 * USDC_DECIMALS); // More than initial
        });

        it("Should update reputation for on-time repayment", async function() {
            const scoreBefore = await reputationManager.getReputationScore(agent1.address);
            await lendingPool.connect(agent1).repayLoan(loanId);
            const scoreAfter = await reputationManager.getReputationScore(agent1.address);

            expect(scoreAfter).to.be.gt(scoreBefore);
        });

        it("Should penalize reputation for late repayment", async function() {
            // Fast forward past deadline
            const loan = await lendingPool.getLoan(loanId);
            await time.increaseTo(loan.endTime + BigInt(86400)); // 1 day late

            const scoreBefore = await reputationManager.getReputationScore(agent1.address);
            await lendingPool.connect(agent1).repayLoan(loanId);
            const scoreAfter = await reputationManager.getReputationScore(agent1.address);

            expect(scoreAfter).to.be.lt(scoreBefore);
        });

        it("Should fail if not borrower", async function() {
            await expect(
                lendingPool.connect(agent2).repayLoan(loanId)
            ).to.be.revertedWith("Not loan borrower");
        });

        it("Should fail if loan not active", async function() {
            await lendingPool.connect(agent1).repayLoan(loanId);

            await expect(
                lendingPool.connect(agent1).repayLoan(loanId)
            ).to.be.revertedWith("Loan not active");
        });
    });

    describe("Loan Liquidation", function() {
        let loanId;

        beforeEach(async function() {
            // Approve USDC for potential collateral
            await mockUSDC.transfer(agent1.address, 5000 * USDC_DECIMALS);
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);

            await lendingPool.connect(agent1).requestLoan(1000 * USDC_DECIMALS, 30);
            await lendingPool.connect(owner).approveLoan(0);
            loanId = 0;
        });

        it("Should allow owner to liquidate defaulted loan", async function() {
            // Fast forward past deadline
            const loan = await lendingPool.getLoan(loanId);
            await time.increaseTo(loan.endTime + BigInt(86400));

            await expect(lendingPool.connect(owner).liquidateLoan(loanId))
                .to.emit(lendingPool, "LoanDefaulted")
                .withArgs(loanId, agent1.address);
        });

        it("Should update loan state to DEFAULTED", async function() {
            const loan = await lendingPool.getLoan(loanId);
            await time.increaseTo(loan.endTime + BigInt(86400));

            await lendingPool.connect(owner).liquidateLoan(loanId);

            const updatedLoan = await lendingPool.getLoan(loanId);
            expect(updatedLoan.state).to.equal(4); // DEFAULTED
        });

        it("Should severely penalize reputation", async function() {
            const loan = await lendingPool.getLoan(loanId);
            await time.increaseTo(loan.endTime + BigInt(86400));

            const scoreBefore = await reputationManager.getReputationScore(agent1.address);
            await lendingPool.connect(owner).liquidateLoan(loanId);
            const scoreAfter = await reputationManager.getReputationScore(agent1.address);

            expect(scoreAfter).to.be.lt(scoreBefore);
            expect(scoreBefore - scoreAfter).to.be.gte(50); // At least 50 point penalty
        });

        it("Should fail if loan not past due", async function() {
            await expect(
                lendingPool.connect(owner).liquidateLoan(loanId)
            ).to.be.revertedWith("Loan not past due");
        });

        it("Should fail if not owner", async function() {
            const loan = await lendingPool.getLoan(loanId);
            await time.increaseTo(loan.endTime + BigInt(86400));

            await expect(
                lendingPool.connect(agent2).liquidateLoan(loanId)
            ).to.be.revertedWithCustomError(lendingPool, "OwnableUnauthorizedAccount");
        });
    });

    describe("Liquidity Management", function() {
        it("Should allow deposits", async function() {
            await mockUSDC.transfer(agent1.address, 5000 * USDC_DECIMALS);
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);

            await expect(lendingPool.connect(agent1).depositLiquidity(5000 * USDC_DECIMALS))
                .to.emit(lendingPool, "LiquidityDeposited")
                .withArgs(agent1.address, 5000 * USDC_DECIMALS);

            expect(await lendingPool.totalLiquidity()).to.equal(105000 * USDC_DECIMALS);
        });

        it("Should allow owner to withdraw", async function() {
            await expect(lendingPool.connect(owner).withdrawLiquidity(10000 * USDC_DECIMALS))
                .to.emit(lendingPool, "LiquidityWithdrawn")
                .withArgs(owner.address, 10000 * USDC_DECIMALS);

            expect(await lendingPool.totalLiquidity()).to.equal(90000 * USDC_DECIMALS);
        });

        it("Should fail to withdraw more than available", async function() {
            await expect(
                lendingPool.connect(owner).withdrawLiquidity(150000 * USDC_DECIMALS)
            ).to.be.revertedWith("Insufficient available liquidity");
        });
    });

    describe("Interest Rate Calculation", function() {
        it("Should calculate correct rate for high reputation", async function() {
            const rate = await lendingPool.calculateInterestRate(850);
            expect(rate).to.equal(500); // 5%
        });

        it("Should calculate correct rate for medium reputation", async function() {
            const rate = await lendingPool.calculateInterestRate(650);
            expect(rate).to.equal(700); // 7%
        });

        it("Should calculate correct rate for low reputation", async function() {
            const rate = await lendingPool.calculateInterestRate(250);
            expect(rate).to.equal(2000); // 20%
        });
    });

    describe("Pause Functionality", function() {
        it("Should prevent loan requests when paused", async function() {
            await lendingPool.connect(owner).pause();

            await expect(
                lendingPool.connect(agent1).requestLoan(1000 * USDC_DECIMALS, 30)
            ).to.be.revertedWithCustomError(lendingPool, "EnforcedPause");
        });

        it("Should allow unpause", async function() {
            await lendingPool.connect(owner).pause();
            await lendingPool.connect(owner).unpause();

            // Approve USDC for potential collateral
            await mockUSDC.transfer(agent1.address, 5000 * USDC_DECIMALS);
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);

            await lendingPool.connect(agent1).requestLoan(1000 * USDC_DECIMALS, 30);
            expect(await lendingPool.paused()).to.be.false;
        });
    });
});
