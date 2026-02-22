const { expect } = require("chai");
const { ethers } = require("hardhat");
const helpers = require("@nomicfoundation/hardhat-network-helpers");

describe("ERC-8004 Integration Tests", function () {
    let agentRegistry, reputationManager, validationRegistry, lendingPool, mockUSDC;
    let owner, agent1, agent2, client1, validator1, lendingPoolOwner;

    beforeEach(async function () {
        [owner, agent1, agent2, client1, validator1, lendingPoolOwner] = await ethers.getSigners();

        // Deploy AgentRegistry
        const AgentRegistryV2 = await ethers.getContractFactory("AgentRegistryV2");
        agentRegistry = await AgentRegistryV2.deploy();
        await agentRegistry.waitForDeployment();

        // Deploy ReputationManager
        const ReputationManagerV2 = await ethers.getContractFactory("ReputationManagerV2");
        reputationManager = await ReputationManagerV2.deploy(await agentRegistry.getAddress());
        await reputationManager.waitForDeployment();

        // Deploy ValidationRegistry
        const ValidationRegistry = await ethers.getContractFactory("ValidationRegistry");
        validationRegistry = await ValidationRegistry.deploy(await agentRegistry.getAddress());
        await validationRegistry.waitForDeployment();

        // Deploy MockUSDC
        const MockUSDC = await ethers.getContractFactory("MockUSDC");
        mockUSDC = await MockUSDC.deploy();
        await mockUSDC.waitForDeployment();

        // Deploy LendingPoolV2
        const LendingPoolV2 = await ethers.getContractFactory("LendingPoolV2");
        lendingPool = await LendingPoolV2.deploy(
            await agentRegistry.getAddress(),
            await reputationManager.getAddress(),
            await mockUSDC.getAddress()
        );
        await lendingPool.waitForDeployment();

        // Set lending pool in reputation manager
        await reputationManager.connect(owner).setLendingPool(await lendingPool.getAddress());

        // Add validator to whitelist
        await validationRegistry.connect(owner).approveValidator(validator1.address, "ipfs://validator1");

        // Fund lending pool with liquidity
        await mockUSDC.mint(lendingPoolOwner.address, ethers.parseUnits("100000", 6));
        await mockUSDC.connect(lendingPoolOwner).approve(
            await lendingPool.getAddress(),
            ethers.parseUnits("100000", 6)
        );
        await lendingPool.connect(lendingPoolOwner).depositLiquidity(ethers.parseUnits("100000", 6));

        // Fund agents with USDC for collateral
        await mockUSDC.mint(agent1.address, ethers.parseUnits("10000", 6));
        await mockUSDC.mint(agent2.address, ethers.parseUnits("10000", 6));
    });

    describe("Full Agent Lifecycle", function () {
        it("Should complete full lifecycle: register → loan → feedback → validation", async function () {
            // 1. Agent registration
            const agentURI = "ipfs://QmAgent1";
            const metadata = [
                { key: "name", value: ethers.toUtf8Bytes("TradingBot") },
                { key: "version", value: ethers.toUtf8Bytes("1.0.0") }
            ];

            await agentRegistry.connect(agent1).register(agentURI, metadata);
            expect(await agentRegistry.isRegistered(agent1.address)).to.be.true;

            const agentId = await agentRegistry.addressToAgentId(agent1.address);
            expect(agentId).to.equal(1);

            // 2. Initialize reputation
            await reputationManager.connect(agent1)['initializeReputation(address)'](agent1.address);
            const initialScore = await reputationManager['getReputationScore(address)'](agent1.address);
            expect(initialScore).to.equal(100);

            // 3. Request loan
            const loanAmount = ethers.parseUnits("1000", 6);
            const durationDays = 30;

            // Approve collateral
            const collateralReq = await reputationManager['calculateCollateralRequirement(address)'](agent1.address);
            const collateralAmount = (loanAmount * BigInt(collateralReq)) / 100n;
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), collateralAmount);

            // Request loan
            const loanTx = await lendingPool.connect(agent1).requestLoan(loanAmount, durationDays);
            const loanReceipt = await loanTx.wait();

            // Get loan ID from event
            const loanEvent = loanReceipt.logs.find(log => {
                try {
                    const parsed = lendingPool.interface.parseLog(log);
                    return parsed.name === "LoanRequested";
                } catch (e) {
                    return false;
                }
            });

            const loanId = lendingPool.interface.parseLog(loanEvent).args.loanId;

            // 4. Approve and activate loan
            await lendingPool.connect(owner).approveLoan(loanId);

            // 5. Repay loan (simulate on-time repayment)
            const loan = await lendingPool.getLoan(loanId);
            // Calculate total: principal + interest
            const interest = (loan.amount * BigInt(loan.interestRate)) / 10000n;
            const totalRepayment = loan.amount + interest;

            await mockUSDC.mint(agent1.address, totalRepayment);
            await mockUSDC.connect(agent1).approve(await lendingPool.getAddress(), totalRepayment);
            await lendingPool.connect(agent1).repayLoan(loanId);

            // Check reputation increased
            const newScore = await reputationManager['getReputationScore(address)'](agent1.address);
            expect(newScore).to.be.greaterThan(initialScore);

            // 6. Client gives feedback
            await reputationManager.connect(client1).giveFeedback(
                agentId,
                90,
                0,
                "loan-repayment",
                "on-time",
                "",
                "ipfs://feedback",
                ethers.ZeroHash
            );

            const feedbackSummary = await reputationManager.getSummary(agentId, [], []);
            expect(feedbackSummary.count).to.equal(1);
            expect(feedbackSummary.averageValue).to.equal(90);

            // 7. Request validation
            const validationTx = await validationRegistry.connect(agent1).validationRequest(
                validator1.address,
                agentId,
                "ipfs://validationRequest",
                ethers.ZeroHash
            );

            const validationReceipt = await validationTx.wait();
            const validationEvent = validationReceipt.logs.find(log => {
                try {
                    const parsed = validationRegistry.interface.parseLog(log);
                    return parsed.name === "ValidationRequested";
                } catch (e) {
                    return false;
                }
            });

            const requestHash = validationRegistry.interface.parseLog(validationEvent).args.requestHash;

            // 8. Validator responds
            await validationRegistry.connect(validator1).validationResponse(
                requestHash,
                95,
                "ipfs://validationProof",
                ethers.ZeroHash,
                "loan-performance"
            );

            const validation = await validationRegistry.validations(requestHash);
            expect(validation.status).to.equal(1); // APPROVED
            expect(validation.responseScore).to.equal(95);

            // 9. Verify final state
            const finalAgentInfo = await agentRegistry.getAgentInfo(agent1.address);
            expect(finalAgentInfo.isActive).to.be.true;

            const finalScore = await reputationManager['getReputationScore(address)'](agent1.address);
            expect(finalScore).to.be.greaterThan(initialScore);

            const validationSummary = await validationRegistry.getSummary(agentId, [], "");
            expect(validationSummary.totalCount).to.equal(1);
            expect(validationSummary.approvedCount).to.equal(1);
        });
    });

    describe("Multi-Agent Interactions", function () {
        beforeEach(async function () {
            // Register both agents
            await agentRegistry.connect(agent1).register("ipfs://agent1", []);
            await agentRegistry.connect(agent2).register("ipfs://agent2", []);

            // Initialize reputations
            await reputationManager.connect(agent1)['initializeReputation(address)'](agent1.address);
            await reputationManager.connect(agent2)['initializeReputation(address)'](agent2.address);
        });

        it("Should allow agents to give feedback to each other", async function () {
            const agent1Id = await agentRegistry.addressToAgentId(agent1.address);
            const agent2Id = await agentRegistry.addressToAgentId(agent2.address);

            // Agent 2 gives feedback to Agent 1
            await reputationManager.connect(agent2).giveFeedback(
                agent1Id,
                85,
                0,
                "collaboration",
                "excellent",
                "",
                "",
                ethers.ZeroHash
            );

            // Agent 1 gives feedback to Agent 2
            await reputationManager.connect(agent1).giveFeedback(
                agent2Id,
                80,
                0,
                "collaboration",
                "good",
                "",
                "",
                ethers.ZeroHash
            );

            // Check feedback received
            const agent1Feedback = await reputationManager.readAllFeedback(agent1Id, [], []);
            const agent2Feedback = await reputationManager.readAllFeedback(agent2Id, [], []);

            expect(agent1Feedback.length).to.equal(1);
            expect(agent2Feedback.length).to.equal(1);

            expect(agent1Feedback[0].clientAddress).to.equal(agent2.address);
            expect(agent2Feedback[0].clientAddress).to.equal(agent1.address);
        });

        it("Should aggregate feedback across multiple sources", async function () {
            const agent1Id = await agentRegistry.addressToAgentId(agent1.address);

            // Multiple entities give feedback
            await reputationManager.connect(agent2).giveFeedback(agent1Id, 90, 0, "test", "", "", "", ethers.ZeroHash);
            await reputationManager.connect(client1).giveFeedback(agent1Id, 85, 0, "test", "", "", "", ethers.ZeroHash);
            await reputationManager.connect(validator1).giveFeedback(agent1Id, 95, 0, "test", "", "", "", ethers.ZeroHash);

            const summary = await reputationManager.getSummary(agent1Id, [], []);

            expect(summary.count).to.equal(3);
            expect(summary.averageValue).to.equal(90); // (90 + 85 + 95) / 3
            expect(summary.minValue).to.equal(85);
            expect(summary.maxValue).to.equal(95);
        });

        it("Should handle validation requests from multiple agents", async function () {
            const agent1Id = await agentRegistry.addressToAgentId(agent1.address);
            const agent2Id = await agentRegistry.addressToAgentId(agent2.address);

            // Both agents request validation
            const tx1 = await validationRegistry.connect(agent1).validationRequest(
                validator1.address,
                agent1Id,
                "ipfs://req1",
                ethers.ZeroHash
            );

            const tx2 = await validationRegistry.connect(agent2).validationRequest(
                validator1.address,
                agent2Id,
                "ipfs://req2",
                ethers.ZeroHash
            );

            // Both should succeed
            const receipt1 = await tx1.wait();
            const receipt2 = await tx2.wait();

            expect(receipt1.status).to.equal(1);
            expect(receipt2.status).to.equal(1);
        });
    });

    describe("Cross-Protocol Scenarios", function () {
        it("Should support agent NFT transfer and maintain reputation", async function () {
            // Register agent
            await agentRegistry.connect(agent1).register("ipfs://agent", []);
            await reputationManager.connect(agent1)['initializeReputation(address)'](agent1.address);

            const agentId = await agentRegistry.addressToAgentId(agent1.address);
            const initialScore = await reputationManager['getReputationScore(address)'](agent1.address);

            // Give feedback
            await reputationManager.connect(client1).giveFeedback(agentId, 85, 0, "test", "", "", "", ethers.ZeroHash);

            // Transfer NFT to agent2
            await agentRegistry.connect(agent1).transferFrom(agent1.address, agent2.address, agentId);

            // New owner should have access to reputation (by ID)
            const scoreById = await reputationManager['getReputationScore(uint256)'](agentId);
            expect(scoreById).to.equal(initialScore);

            // Feedback should still be accessible by ID
            const feedback = await reputationManager.readAllFeedback(agentId, [], []);
            expect(feedback.length).to.equal(1);

            // Address mapping should update
            expect(await agentRegistry.addressToAgentId(agent1.address)).to.equal(0);
            expect(await agentRegistry.addressToAgentId(agent2.address)).to.equal(agentId);
        });

        it("Should allow querying reputation by both address and ID", async function () {
            await agentRegistry.connect(agent1).register("ipfs://agent", []);
            await reputationManager.connect(agent1)['initializeReputation(address)'](agent1.address);

            const agentId = await agentRegistry.addressToAgentId(agent1.address);

            // Boost reputation (impersonate lending pool)
            const lendingPoolAddress = await lendingPool.getAddress();

            // Fund the lending pool address with ETH for gas
            await helpers.setBalance(lendingPoolAddress, ethers.parseEther("1.0"));

            const lendingPoolSigner = await ethers.getImpersonatedSigner(lendingPoolAddress);

            await reputationManager.connect(lendingPoolSigner)['recordLoanCompletion(address,uint256,bool)'](
                agent1.address,
                ethers.parseUnits("1000", 6),
                true
            );

            // Query by address
            const scoreByAddress = await reputationManager['getReputationScore(address)'](agent1.address);

            // Query by ID
            const scoreById = await reputationManager['getReputationScore(uint256)'](agentId);

            // Should be equal
            expect(scoreByAddress).to.equal(scoreById);
        });

        it("Should support external protocol querying agent data", async function () {
            // Register agent with rich metadata
            const metadata = [
                { key: "name", value: ethers.toUtf8Bytes("ExternalAgent") },
                { key: "protocol", value: ethers.toUtf8Bytes("Specular") },
                { key: "version", value: ethers.toUtf8Bytes("2.0.0") },
                { key: "capabilities", value: ethers.toUtf8Bytes(JSON.stringify(["trading", "lending"])) }
            ];

            await agentRegistry.connect(agent1).register("ipfs://external", metadata);
            await reputationManager.connect(agent1)['initializeReputation(address)'](agent1.address);

            const agentId = await agentRegistry.addressToAgentId(agent1.address);

            // External protocol queries all data
            const agentInfo = await agentRegistry.getAgentInfoById(agentId);
            const name = await agentRegistry.getMetadata(agentId, "name");
            const capabilities = await agentRegistry.getMetadata(agentId, "capabilities");
            const reputation = await reputationManager['getReputationScore(uint256)'](agentId);

            // Verify external protocol can access all data
            expect(agentInfo.isActive).to.be.true;
            expect(ethers.toUtf8String(name)).to.equal("ExternalAgent");
            expect(reputation).to.equal(100);

            const parsedCapabilities = JSON.parse(ethers.toUtf8String(capabilities));
            expect(parsedCapabilities).to.deep.equal(["trading", "lending"]);
        });
    });

    describe("Loan Integration with ERC-8004", function () {
        beforeEach(async function () {
            await agentRegistry.connect(agent1).register("ipfs://agent", []);
            await reputationManager.connect(agent1)['initializeReputation(address)'](agent1.address);
        });

        it("Should track loan history in reputation", async function () {
            const initialScore = await reputationManager['getReputationScore(address)'](agent1.address);

            // Multiple loans (impersonate lending pool)
            const lendingPoolAddress = await lendingPool.getAddress();

            // Fund the lending pool address with ETH for gas
            await helpers.setBalance(lendingPoolAddress, ethers.parseEther("1.0"));

            const lendingPoolSigner = await ethers.getImpersonatedSigner(lendingPoolAddress);

            for (let i = 0; i < 5; i++) {
                await reputationManager.connect(lendingPoolSigner)['recordLoanCompletion(address,uint256,bool)'](
                    agent1.address,
                    ethers.parseUnits("1000", 6),
                    true
                );
            }

            const finalScore = await reputationManager['getReputationScore(address)'](agent1.address);
            expect(finalScore).to.be.greaterThan(initialScore);

            // Verify reputation maxed out (large loan amounts quickly max the score)
            expect(finalScore).to.equal(1000n); // MAX_SCORE
        });

        it("Should prevent loans for inactive agents", async function () {
            // Deactivate agent
            const agentId = await agentRegistry.addressToAgentId(agent1.address);
            await agentRegistry.connect(owner).deactivateAgent(agentId);

            // Try to request loan
            const loanAmount = ethers.parseUnits("1000", 6);
            await expect(
                lendingPool.connect(agent1).requestLoan(loanAmount, 30)
            ).to.be.revertedWith("Agent not active");
        });

        it("Should reflect reputation in loan terms", async function () {
            // Low reputation agent
            const creditLimit1 = await reputationManager['calculateCreditLimit(address)'](agent1.address);
            const collateralReq1 = await reputationManager['calculateCollateralRequirement(address)'](agent1.address);

            // Boost reputation (impersonate lending pool)
            const lendingPoolAddress = await lendingPool.getAddress();

            // Fund the lending pool address with ETH for gas
            await helpers.setBalance(lendingPoolAddress, ethers.parseEther("1.0"));

            const lendingPoolSigner = await ethers.getImpersonatedSigner(lendingPoolAddress);

            for (let i = 0; i < 70; i++) {
                await reputationManager.connect(lendingPoolSigner)['recordLoanCompletion(address,uint256,bool)'](
                    agent1.address,
                    ethers.parseUnits("10000", 6),
                    true
                );
            }

            // High reputation agent
            const creditLimit2 = await reputationManager['calculateCreditLimit(address)'](agent1.address);
            const collateralReq2 = await reputationManager['calculateCollateralRequirement(address)'](agent1.address);

            // Better terms for high reputation
            expect(creditLimit2).to.be.greaterThan(creditLimit1);
            expect(collateralReq2).to.be.lessThan(collateralReq1);
        });
    });

    describe("Edge Cases and Security", function () {
        it("Should prevent unregistered agents from initializing reputation", async function () {
            await expect(
                reputationManager.connect(agent1)['initializeReputation(address)'](agent1.address)
            ).to.be.revertedWith("Agent not registered");
        });

        it("Should prevent feedback for non-existent agents", async function () {
            await expect(
                reputationManager.connect(client1).giveFeedback(999, 85, 0, "test", "", "", "", ethers.ZeroHash)
            ).to.be.revertedWithCustomError(agentRegistry, "ERC721NonexistentToken");
        });

        it("Should prevent validation requests for non-existent agents", async function () {
            await expect(
                validationRegistry.connect(agent1).validationRequest(validator1.address, 999, "ipfs://req", ethers.ZeroHash)
            ).to.be.revertedWithCustomError(agentRegistry, "ERC721NonexistentToken");
        });

        it("Should handle agent with zero feedback gracefully", async function () {
            await agentRegistry.connect(agent1).register("ipfs://agent", []);
            await reputationManager.connect(agent1)['initializeReputation(address)'](agent1.address);

            const agentId = await agentRegistry.addressToAgentId(agent1.address);
            const summary = await reputationManager.getSummary(agentId, [], []);

            expect(summary.count).to.equal(0);
            expect(summary.averageValue).to.equal(0);
        });

        it("Should handle agent with zero validations gracefully", async function () {
            await agentRegistry.connect(agent1).register("ipfs://agent", []);

            const agentId = await agentRegistry.addressToAgentId(agent1.address);
            const summary = await validationRegistry.getSummary(agentId, [], "");

            expect(summary.totalCount).to.equal(0);
            expect(summary.approvedCount).to.equal(0);
        });
    });
});
