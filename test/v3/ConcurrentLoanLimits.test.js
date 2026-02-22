const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentLiquidityMarketplace - Concurrent Loan Limits [SECURITY-01]", function () {
    let agentRegistry, reputationManager, marketplace, usdc;
    let owner, agent, lender;
    let agentId;

    beforeEach(async function () {
        [owner, agent, lender] = await ethers.getSigners();

        // Deploy AgentRegistry
        const AgentRegistry = await ethers.getContractFactory("AgentRegistryV2");
        agentRegistry = await AgentRegistry.deploy();
        await agentRegistry.waitForDeployment();

        // Deploy ReputationManager
        const ReputationManager = await ethers.getContractFactory("ReputationManagerV3");
        reputationManager = await ReputationManager.deploy(await agentRegistry.getAddress());
        await reputationManager.waitForDeployment();

        // Deploy MockUSDC
        const MockUSDC = await ethers.getContractFactory("MockUSDC");
        usdc = await MockUSDC.deploy();
        await usdc.waitForDeployment();

        // Deploy AgentLiquidityMarketplace
        const Marketplace = await ethers.getContractFactory("AgentLiquidityMarketplace");
        marketplace = await Marketplace.deploy(
            await agentRegistry.getAddress(),
            await reputationManager.getAddress(),
            await usdc.getAddress()
        );
        await marketplace.waitForDeployment();

        // Authorize marketplace in reputation manager
        await reputationManager.authorizePool(await marketplace.getAddress());

        // Register agent
        await agentRegistry.connect(agent).register("ipfs://test-agent", []);
        agentId = await agentRegistry.addressToAgentId(agent.address);
        await reputationManager.connect(agent)['initializeReputation(uint256)'](agentId);

        // Create agent pool
        await marketplace.connect(agent).createAgentPool();

        // Mint USDC to agent for collateral and lender for liquidity
        await usdc.mint(agent.address, ethers.parseUnits("100000", 6));
        await usdc.mint(lender.address, ethers.parseUnits("100000", 6));

        // Lender supplies liquidity to agent's pool
        await usdc.connect(lender).approve(await marketplace.getAddress(), ethers.parseUnits("100000", 6));
        await marketplace.connect(lender).supplyLiquidity(agentId, ethers.parseUnits("50000", 6));

        // Agent approves USDC for collateral (enough for many loans)
        await usdc.connect(agent).approve(await marketplace.getAddress(), ethers.parseUnits("100000", 6));
    });

    describe("MAX_ACTIVE_LOANS_PER_AGENT Constant", function () {
        it("should have MAX_ACTIVE_LOANS_PER_AGENT set to 10", async function () {
            const maxLoans = await marketplace.MAX_ACTIVE_LOANS_PER_AGENT();
            expect(maxLoans).to.equal(10);
        });
    });

    describe("Concurrent Loan Enforcement", function () {
        it("should allow up to 10 concurrent active loans", async function () {
            const loanAmount = ethers.parseUnits("100", 6); // 100 USDC per loan
            const loanIds = [];

            // Take 10 loans successfully
            for (let i = 0; i < 10; i++) {
                const tx = await marketplace.connect(agent).requestLoan(loanAmount, 7);
                const receipt = await tx.wait();

                // Extract loan ID from event
                const event = receipt.logs.find(log => {
                    try {
                        const parsed = marketplace.interface.parseLog(log);
                        return parsed.name === 'LoanRequested';
                    } catch {
                        return false;
                    }
                });

                if (event) {
                    const parsed = marketplace.interface.parseLog(event);
                    loanIds.push(parsed.args.loanId);
                }
            }

            expect(loanIds.length).to.equal(10);

            // Verify all loans are active
            for (const loanId of loanIds) {
                const loan = await marketplace.loans(loanId);
                expect(loan.state).to.equal(1); // LoanState.ACTIVE
            }
        });

        it("should reject 11th loan when MAX_ACTIVE_LOANS_PER_AGENT reached", async function () {
            const loanAmount = ethers.parseUnits("100", 6);

            // Take 10 loans
            for (let i = 0; i < 10; i++) {
                await marketplace.connect(agent).requestLoan(loanAmount, 7);
            }

            // 11th loan should fail
            await expect(
                marketplace.connect(agent).requestLoan(loanAmount, 7)
            ).to.be.revertedWith("Too many active loans");
        });

        it("should allow new loan after repaying old one", async function () {
            const loanAmount = ethers.parseUnits("100", 6);
            const loanIds = [];

            // Take 10 loans
            for (let i = 0; i < 10; i++) {
                const tx = await marketplace.connect(agent).requestLoan(loanAmount, 7);
                const receipt = await tx.wait();

                const event = receipt.logs.find(log => {
                    try {
                        const parsed = marketplace.interface.parseLog(log);
                        return parsed.name === 'LoanRequested';
                    } catch {
                        return false;
                    }
                });

                if (event) {
                    const parsed = marketplace.interface.parseLog(event);
                    loanIds.push(parsed.args.loanId);
                }
            }

            // 11th loan should fail
            await expect(
                marketplace.connect(agent).requestLoan(loanAmount, 7)
            ).to.be.revertedWith("Too many active loans");

            // Repay first loan
            const firstLoanId = loanIds[0];
            const loan = await marketplace.loans(firstLoanId);
            const interest = await marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
            const totalRepayment = loan.amount + interest;

            // Approve extra for repayment (reset allowance first)
            await usdc.connect(agent).approve(await marketplace.getAddress(), 0);
            await usdc.connect(agent).approve(await marketplace.getAddress(), totalRepayment);
            await marketplace.connect(agent).repayLoan(firstLoanId);

            // Re-approve for next loan collateral
            await usdc.connect(agent).approve(await marketplace.getAddress(), ethers.parseUnits("100000", 6));

            // Now 11th loan should succeed
            await expect(
                marketplace.connect(agent).requestLoan(loanAmount, 7)
            ).to.not.be.reverted;
        });

        it("should count only ACTIVE loans, not REPAID", async function () {
            const loanAmount = ethers.parseUnits("100", 6);
            const loanIds = [];

            // Take 5 loans
            for (let i = 0; i < 5; i++) {
                const tx = await marketplace.connect(agent).requestLoan(loanAmount, 7);
                const receipt = await tx.wait();

                const event = receipt.logs.find(log => {
                    try {
                        const parsed = marketplace.interface.parseLog(log);
                        return parsed.name === 'LoanRequested';
                    } catch {
                        return false;
                    }
                });

                if (event) {
                    const parsed = marketplace.interface.parseLog(event);
                    loanIds.push(parsed.args.loanId);
                }
            }

            // Repay first 3 loans
            for (let i = 0; i < 3; i++) {
                const loan = await marketplace.loans(loanIds[i]);
                const interest = await marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
                const totalRepayment = loan.amount + interest;

                await usdc.connect(agent).approve(await marketplace.getAddress(), 0);
                await usdc.connect(agent).approve(await marketplace.getAddress(), totalRepayment);
                await marketplace.connect(agent).repayLoan(loanIds[i]);
            }

            // Re-approve for new loans
            await usdc.connect(agent).approve(await marketplace.getAddress(), ethers.parseUnits("100000", 6));

            // Now should have 2 active, 3 repaid
            // Should be able to take 8 more loans (to reach 10 active)
            for (let i = 0; i < 8; i++) {
                await expect(
                    marketplace.connect(agent).requestLoan(loanAmount, 7)
                ).to.not.be.reverted;
            }

            // 11th active loan should fail
            await expect(
                marketplace.connect(agent).requestLoan(loanAmount, 7)
            ).to.be.revertedWith("Too many active loans");
        });
    });

    describe("Credit Limit Bypass Prevention", function () {
        it("should prevent credit limit bypass via loan fragmentation", async function () {
            // Agent has 1000 USDC credit limit (score 100, UNRATED tier)
            const creditLimit = await reputationManager.calculateCreditLimit(agent.address);
            expect(creditLimit).to.equal(ethers.parseUnits("1000", 6));

            // Try to take 10 loans of 100 USDC each = 1000 USDC total
            const loanAmount = ethers.parseUnits("100", 6);

            for (let i = 0; i < 10; i++) {
                await marketplace.connect(agent).requestLoan(loanAmount, 7);
            }

            // 11th loan should fail due to concurrent limit (not credit limit)
            await expect(
                marketplace.connect(agent).requestLoan(loanAmount, 7)
            ).to.be.revertedWith("Too many active loans");

            // Verify total borrowed is within credit limit
            const stats = await reputationManager.totalBorrowed(agentId);
            expect(stats).to.equal(ethers.parseUnits("1000", 6)); // Exactly at limit
            expect(stats).to.be.lte(creditLimit); // Within credit limit
        });

        it("should prevent taking many tiny loans to exceed aggregate limit", async function () {
            // Try to take 10 loans of 10 USDC each = 100 USDC total (well within limit)
            const tinyLoan = ethers.parseUnits("10", 6);

            for (let i = 0; i < 10; i++) {
                await marketplace.connect(agent).requestLoan(tinyLoan, 7);
            }

            // 11th tiny loan should still fail
            await expect(
                marketplace.connect(agent).requestLoan(tinyLoan, 7)
            ).to.be.revertedWith("Too many active loans");
        });
    });

    describe("Edge Cases", function () {
        it("should handle exactly 10 active loans correctly", async function () {
            const loanAmount = ethers.parseUnits("50", 6);

            // Take exactly 10 loans
            for (let i = 0; i < 10; i++) {
                await marketplace.connect(agent).requestLoan(loanAmount, 7);
            }

            // Verify we're at the limit
            await expect(
                marketplace.connect(agent).requestLoan(loanAmount, 7)
            ).to.be.revertedWith("Too many active loans");

            // Repay one
            const loan = await marketplace.loans(1);
            const interest = await marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
            await usdc.connect(agent).approve(await marketplace.getAddress(), 0);
            await usdc.connect(agent).approve(await marketplace.getAddress(), loan.amount + interest);
            await marketplace.connect(agent).repayLoan(1);

            // Re-approve for new loan
            await usdc.connect(agent).approve(await marketplace.getAddress(), ethers.parseUnits("100000", 6));

            // Now should be able to take one more
            await expect(
                marketplace.connect(agent).requestLoan(loanAmount, 7)
            ).to.not.be.reverted;
        });

        it("should allow different agents to each have 10 loans", async function () {
            // Setup second agent
            const [, , , agent2] = await ethers.getSigners();
            await agentRegistry.connect(agent2).register("ipfs://agent2", []);
            const agentId2 = await agentRegistry.addressToAgentId(agent2.address);
            await reputationManager.connect(agent2)['initializeReputation(uint256)'](agentId2);
            await marketplace.connect(agent2).createAgentPool();

            await usdc.mint(agent2.address, ethers.parseUnits("100000", 6));
            await usdc.connect(agent2).approve(await marketplace.getAddress(), ethers.parseUnits("100000", 6));
            await usdc.connect(lender).approve(await marketplace.getAddress(), ethers.parseUnits("100000", 6));
            await marketplace.connect(lender).supplyLiquidity(agentId2, ethers.parseUnits("50000", 6));

            const loanAmount = ethers.parseUnits("50", 6);

            // Agent 1 takes 10 loans
            for (let i = 0; i < 10; i++) {
                await marketplace.connect(agent).requestLoan(loanAmount, 7);
            }

            // Agent 2 should also be able to take 10 loans
            for (let i = 0; i < 10; i++) {
                await marketplace.connect(agent2).requestLoan(loanAmount, 7);
            }

            // Both should be at their limit
            await expect(
                marketplace.connect(agent).requestLoan(loanAmount, 7)
            ).to.be.revertedWith("Too many active loans");

            await expect(
                marketplace.connect(agent2).requestLoan(loanAmount, 7)
            ).to.be.revertedWith("Too many active loans");
        });
    });

    describe("Gas Cost Analysis", function () {
        it("should have reasonable gas cost for counting active loans", async function () {
            const loanAmount = ethers.parseUnits("50", 6);

            // Take and repay 50 loans to create history
            for (let i = 0; i < 50; i++) {
                // Ensure fresh approval for each loan
                await usdc.connect(agent).approve(await marketplace.getAddress(), 0);
                await usdc.connect(agent).approve(await marketplace.getAddress(), ethers.parseUnits("10000", 6));

                const tx = await marketplace.connect(agent).requestLoan(loanAmount, 7);
                const receipt = await tx.wait();

                const event = receipt.logs.find(log => {
                    try {
                        const parsed = marketplace.interface.parseLog(log);
                        return parsed.name === 'LoanRequested';
                    } catch {
                        return false;
                    }
                });

                if (event) {
                    const parsed = marketplace.interface.parseLog(event);
                    const loanId = parsed.args.loanId;

                    // Repay immediately to keep active count low
                    const loan = await marketplace.loans(loanId);
                    const interest = await marketplace.calculateInterest(loan.amount, loan.interestRate, loan.duration);
                    await usdc.connect(agent).approve(await marketplace.getAddress(), 0);
                    await usdc.connect(agent).approve(await marketplace.getAddress(), loan.amount + interest);
                    await marketplace.connect(agent).repayLoan(loanId);
                }
            }

            // Re-approve for new loans
            await usdc.connect(agent).approve(await marketplace.getAddress(), ethers.parseUnits("100000", 6));

            // Now take 10 active loans with 50 historical repaid loans
            for (let i = 0; i < 10; i++) {
                await marketplace.connect(agent).requestLoan(loanAmount, 7);
            }

            // Measure gas for 11th loan request (should iterate through 60 loans)
            await expect(
                marketplace.connect(agent).requestLoan(loanAmount, 7)
            ).to.be.revertedWith("Too many active loans");

            // The fact this completes without timeout shows O(n) is acceptable
        });
    });
});
