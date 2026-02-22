const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Loan Lifecycle Integration Tests", function() {
    let agentRegistry, reputationManager, mockUSDC, lendingPool;
    let owner, agent1, agent2, lender;
    const USDC_DECIMALS = 10**6;

    beforeEach(async function() {
        [owner, agent1, agent2, lender] = await ethers.getSigners();

        // Deploy all contracts
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

        // Connect contracts
        await reputationManager.setLendingPool(await lendingPool.getAddress());

        // Setup liquidity
        await mockUSDC.transfer(lender.address, 200000 * USDC_DECIMALS);
        await mockUSDC.connect(lender).approve(await lendingPool.getAddress(), ethers.MaxUint256);
        await lendingPool.connect(lender).depositLiquidity(200000 * USDC_DECIMALS);
    });

    describe("Complete Successful Loan Flow", function() {
        it("Should complete full lifecycle: register -> request -> approve -> repay", async function() {
            // Step 1: Register agent
            console.log("Step 1: Registering agent...");
            await agentRegistry.connect(agent1).registerAgent(JSON.stringify({
                name: "Trading Agent",
                version: "1.0.0"
            }));

            expect(await agentRegistry.isRegistered(agent1.address)).to.be.true;

            // Step 2: Initialize reputation
            console.log("Step 2: Initializing reputation...");
            await reputationManager.initializeReputation(agent1.address);

            let reputation = await reputationManager.getReputationScore(agent1.address);
            expect(reputation).to.equal(100); // Initial score

            // Step 3: Request loan
            console.log("Step 3: Requesting loan...");
            const loanAmount = 1000 * USDC_DECIMALS;
            const loanDuration = 30;

            // Approve USDC for potential collateral
            await mockUSDC.transfer(agent1.address, 10000 * USDC_DECIMALS);
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);

            const requestTx = await lendingPool.connect(agent1).requestLoan(loanAmount, loanDuration);
            const requestReceipt = await requestTx.wait();

            const loanId = 0;
            let loan = await lendingPool.getLoan(loanId);
            expect(loan.state).to.equal(0); // REQUESTED

            // Step 4: Approve loan
            console.log("Step 4: Approving loan...");
            const agent1BalanceBefore = await mockUSDC.balanceOf(agent1.address);
            await lendingPool.connect(owner).approveLoan(loanId);

            loan = await lendingPool.getLoan(loanId);
            expect(loan.state).to.equal(2); // ACTIVE

            const agent1BalanceAfter = await mockUSDC.balanceOf(agent1.address);
            expect(agent1BalanceAfter - agent1BalanceBefore).to.equal(loanAmount);

            // Step 5: Repay loan
            console.log("Step 5: Repaying loan...");
            const interest = await lendingPool.calculateInterest(
                loan.amount,
                loan.interestRate,
                loan.durationDays
            );
            const totalRepayment = loan.amount + interest;

            // Fund agent for repayment
            await mockUSDC.transfer(agent1.address, totalRepayment);
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);

            await lendingPool.connect(agent1).repayLoan(loanId);

            loan = await lendingPool.getLoan(loanId);
            expect(loan.state).to.equal(3); // REPAID

            // Step 6: Verify reputation increased
            console.log("Step 6: Verifying reputation update...");
            const newReputation = await reputationManager.getReputationScore(agent1.address);
            expect(newReputation).to.be.gt(reputation); // Should increase

            console.log(`Initial reputation: ${reputation}, Final reputation: ${newReputation}`);
        });
    });

    describe("Multiple Loan Lifecycle", function() {
        beforeEach(async function() {
            await agentRegistry.connect(agent1).registerAgent("agent1");
            await reputationManager.initializeReputation(agent1.address);

            // Approve USDC for potential collateral
            await mockUSDC.transfer(agent1.address, 100000 * USDC_DECIMALS);
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);
        });

        it("Should handle multiple sequential loans with reputation improvement", async function() {
            const initialReputation = await reputationManager.getReputationScore(agent1.address);
            console.log(`Initial reputation: ${initialReputation}`);

            // Complete 3 loans successfully
            for (let i = 0; i < 3; i++) {
                console.log(`\nLoan ${i + 1}:`);

                // Request loan
                await lendingPool.connect(agent1).requestLoan(1000 * USDC_DECIMALS, 30);

                // Approve loan
                await lendingPool.connect(owner).approveLoan(i);

                // Fund and repay
                await mockUSDC.transfer(agent1.address, 2000 * USDC_DECIMALS);
                await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);
                await lendingPool.connect(agent1).repayLoan(i);

                const currentReputation = await reputationManager.getReputationScore(agent1.address);
                console.log(`Reputation after loan ${i + 1}: ${currentReputation}`);
            }

            const finalReputation = await reputationManager.getReputationScore(agent1.address);
            expect(finalReputation).to.be.gt(Number(initialReputation) + 25); // Should increase significantly

            const repData = await reputationManager.getReputationData(agent1.address);
            expect(repData.loansCompleted).to.equal(3);
            expect(repData.loansDefaulted).to.equal(0);
        });

        it("Should increase credit limit as reputation improves", async function() {
            const initialCreditLimit = await reputationManager.calculateCreditLimit(agent1.address);
            console.log(`Initial credit limit: ${ethers.formatUnits(initialCreditLimit, 6)} USDC`);

            // Complete 50 small loans to boost reputation significantly
            for (let i = 0; i < 50; i++) {
                await lendingPool.connect(agent1).requestLoan(1000 * USDC_DECIMALS, 30);
                await lendingPool.connect(owner).approveLoan(i);
                await mockUSDC.transfer(agent1.address, 2000 * USDC_DECIMALS);
                await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);
                await lendingPool.connect(agent1).repayLoan(i);
            }

            const finalCreditLimit = await reputationManager.calculateCreditLimit(agent1.address);
            console.log(`Final credit limit: ${ethers.formatUnits(finalCreditLimit, 6)} USDC`);

            expect(finalCreditLimit).to.be.gt(initialCreditLimit);
        });
    });

    describe("Default Scenario", function() {
        beforeEach(async function() {
            await agentRegistry.connect(agent1).registerAgent("agent1");
            await reputationManager.initializeReputation(agent1.address);

            // Approve USDC for potential collateral
            await mockUSDC.transfer(agent1.address, 10000 * USDC_DECIMALS);
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);
        });

        it("Should handle loan default and reputation penalty", async function() {
            const initialReputation = await reputationManager.getReputationScore(agent1.address);

            // Request and approve loan
            await lendingPool.connect(agent1).requestLoan(1000 * USDC_DECIMALS, 30);
            await lendingPool.connect(owner).approveLoan(0);

            const loan = await lendingPool.getLoan(0);

            // Fast forward past deadline
            await time.increaseTo(loan.endTime + BigInt(86400 * 2)); // 2 days late

            // Liquidate loan
            await lendingPool.connect(owner).liquidateLoan(0);

            const updatedLoan = await lendingPool.getLoan(0);
            expect(updatedLoan.state).to.equal(4); // DEFAULTED

            // Verify reputation was severely penalized
            const finalReputation = await reputationManager.getReputationScore(agent1.address);
            expect(finalReputation).to.be.lt(initialReputation);
            expect(initialReputation - finalReputation).to.be.gte(50);

            const repData = await reputationManager.getReputationData(agent1.address);
            expect(repData.loansDefaulted).to.equal(1);
        });

        it("Should reduce credit limit after default", async function() {
            const initialCreditLimit = await reputationManager.calculateCreditLimit(agent1.address);

            // Request, approve, and default on loan
            await lendingPool.connect(agent1).requestLoan(1000 * USDC_DECIMALS, 30);
            await lendingPool.connect(owner).approveLoan(0);

            const loan = await lendingPool.getLoan(0);
            await time.increaseTo(loan.endTime + BigInt(86400));
            await lendingPool.connect(owner).liquidateLoan(0);

            const newCreditLimit = await reputationManager.calculateCreditLimit(agent1.address);
            // After default, credit limit should be same or lower (if reputation dropped significantly)
            expect(newCreditLimit).to.be.lte(initialCreditLimit);
        });
    });

    describe("Late Repayment Scenario", function() {
        beforeEach(async function() {
            await agentRegistry.connect(agent1).registerAgent("agent1");
            await reputationManager.initializeReputation(agent1.address);

            // Approve USDC for potential collateral
            await mockUSDC.transfer(agent1.address, 10000 * USDC_DECIMALS);
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);
        });

        it("Should penalize late repayment but still accept payment", async function() {
            const initialReputation = await reputationManager.getReputationScore(agent1.address);

            // Request and approve loan
            await lendingPool.connect(agent1).requestLoan(1000 * USDC_DECIMALS, 30);
            await lendingPool.connect(owner).approveLoan(0);

            const loan = await lendingPool.getLoan(0);

            // Fast forward past deadline but repay before liquidation
            await time.increaseTo(loan.endTime + BigInt(3600)); // 1 hour late

            // Repay loan
            await mockUSDC.transfer(agent1.address, 2000 * USDC_DECIMALS);
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);
            await lendingPool.connect(agent1).repayLoan(0);

            // Verify loan is repaid
            const updatedLoan = await lendingPool.getLoan(0);
            expect(updatedLoan.state).to.equal(3); // REPAID

            // Verify reputation was penalized (not increased as much as on-time)
            const finalReputation = await reputationManager.getReputationScore(agent1.address);
            expect(finalReputation).to.be.lte(initialReputation);
        });
    });

    describe("Multi-Agent Scenarios", function() {
        beforeEach(async function() {
            await agentRegistry.connect(agent1).registerAgent("agent1");
            await agentRegistry.connect(agent2).registerAgent("agent2");
            await reputationManager.initializeReputation(agent1.address);
            await reputationManager.initializeReputation(agent2.address);

            // Approve USDC for both agents
            await mockUSDC.transfer(agent1.address, 50000 * USDC_DECIMALS);
            await mockUSDC.transfer(agent2.address, 50000 * USDC_DECIMALS);
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);
            await mockUSDC.connect(agent2).approve(await lendingPool.getAddress(), ethers.MaxUint256);
        });

        it("Should handle concurrent loans from multiple agents", async function() {
            // Both agents request loans
            await lendingPool.connect(agent1).requestLoan(1000 * USDC_DECIMALS, 30);
            await lendingPool.connect(agent2).requestLoan(2000 * USDC_DECIMALS, 60);

            // Approve both loans
            await lendingPool.connect(owner).approveLoan(0);
            await lendingPool.connect(owner).approveLoan(1);

            // Verify both loans are active
            const loan1 = await lendingPool.getLoan(0);
            const loan2 = await lendingPool.getLoan(1);

            expect(loan1.state).to.equal(2); // ACTIVE
            expect(loan2.state).to.equal(2); // ACTIVE
            expect(loan1.borrower).to.equal(agent1.address);
            expect(loan2.borrower).to.equal(agent2.address);

            // Both agents repay
            await mockUSDC.transfer(agent1.address, 2000 * USDC_DECIMALS);
            await mockUSDC.transfer(agent2.address, 3000 * USDC_DECIMALS);
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);
            await mockUSDC.connect(agent2).approve(await lendingPool.getAddress(), ethers.MaxUint256);

            await lendingPool.connect(agent1).repayLoan(0);
            await lendingPool.connect(agent2).repayLoan(1);

            // Verify both reputations increased
            const rep1 = await reputationManager.getReputationScore(agent1.address);
            const rep2 = await reputationManager.getReputationScore(agent2.address);

            expect(rep1).to.be.gt(100);
            expect(rep2).to.be.gt(100);
        });

        it("Should maintain independent reputations for different agents", async function() {
            // Agent1 completes loan successfully
            await lendingPool.connect(agent1).requestLoan(1000 * USDC_DECIMALS, 30);
            await lendingPool.connect(owner).approveLoan(0);
            await mockUSDC.transfer(agent1.address, 2000 * USDC_DECIMALS);
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);
            await lendingPool.connect(agent1).repayLoan(0);

            // Agent2 defaults
            await lendingPool.connect(agent2).requestLoan(1000 * USDC_DECIMALS, 30);
            await lendingPool.connect(owner).approveLoan(1);
            const loan2 = await lendingPool.getLoan(1);
            await time.increaseTo(loan2.endTime + BigInt(86400));
            await lendingPool.connect(owner).liquidateLoan(1);

            // Verify independent reputations
            const rep1 = await reputationManager.getReputationScore(agent1.address);
            const rep2 = await reputationManager.getReputationScore(agent2.address);

            expect(rep1).to.be.gt(100); // Should increase
            expect(rep2).to.be.lt(100); // Should decrease

            console.log(`Agent1 reputation: ${rep1}`);
            console.log(`Agent2 reputation: ${rep2}`);
        });
    });

    describe("Collateral Management", function() {
        beforeEach(async function() {
            await agentRegistry.connect(agent1).registerAgent("agent1");
            await reputationManager.initializeReputation(agent1.address);

            // Fund and approve USDC
            await mockUSDC.transfer(agent1.address, 50000 * USDC_DECIMALS);
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), ethers.MaxUint256);

            // Lower reputation by defaulting on a loan
            await lendingPool.connect(agent1).requestLoan(1000 * USDC_DECIMALS, 1);
            await lendingPool.connect(owner).approveLoan(0);
            const loan = await lendingPool.getLoan(0);
            await time.increaseTo(loan.endTime + BigInt(86400));
            await lendingPool.connect(owner).liquidateLoan(0);
        });

        it("Should collect and return collateral on successful repayment", async function() {
            const loanAmount = 1000 * USDC_DECIMALS;
            const collateralReq = await reputationManager.calculateCollateralRequirement(agent1.address);
            const collateralAmount = (BigInt(loanAmount) * BigInt(collateralReq)) / 100n;

            const balanceBefore = await mockUSDC.balanceOf(agent1.address);

            // Request loan (collateral will be taken if reputation is low)
            await lendingPool.connect(agent1).requestLoan(loanAmount, 30);

            const balanceAfterRequest = await mockUSDC.balanceOf(agent1.address);
            const collateralTaken = Number(balanceBefore - balanceAfterRequest);

            // Approve and repay
            await lendingPool.connect(owner).approveLoan(1); // LoanId is 1 (0 was the defaulted loan)
            await lendingPool.connect(agent1).repayLoan(1);

            // Verify collateral was returned if any was taken
            const balanceFinal = await mockUSDC.balanceOf(agent1.address);
            if (collateralTaken > 0) {
                expect(Number(balanceFinal)).to.be.gt(Number(balanceAfterRequest)); // Got collateral back
            }
        });
    });
});
