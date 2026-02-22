const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ReputationManagerV2 - ERC-8004 Reputation Registry", function () {
    let agentRegistry, reputationManager;
    let owner, agent1, agent2, client1, client2, lendingPool;

    beforeEach(async function () {
        [owner, agent1, agent2, client1, client2, lendingPool] = await ethers.getSigners();

        // Deploy AgentRegistry
        const AgentRegistryV2 = await ethers.getContractFactory("AgentRegistryV2");
        agentRegistry = await AgentRegistryV2.deploy();
        await agentRegistry.waitForDeployment();

        // Deploy ReputationManager
        const ReputationManagerV2 = await ethers.getContractFactory("ReputationManagerV2");
        reputationManager = await ReputationManagerV2.deploy(await agentRegistry.getAddress());
        await reputationManager.waitForDeployment();

        // Set lending pool
        await reputationManager.connect(owner).setLendingPool(lendingPool.address);

        // Register agents
        await agentRegistry.connect(agent1).register("ipfs://agent1", []);
        await agentRegistry.connect(agent2).register("ipfs://agent2", []);
    });

    describe("Initialization", function () {
        it("Should initialize reputation with correct initial score", async function () {
            await reputationManager.connect(agent1)['initializeReputation(address)'](agent1.address);

            const score = await reputationManager['getReputationScore(address)'](agent1.address);
            expect(score).to.equal(100); // INITIAL_SCORE
        });

        it("Should prevent double initialization", async function () {
            await reputationManager.connect(agent1)['initializeReputation(address)'](agent1.address);

            await expect(
                reputationManager.connect(agent1)['initializeReputation(address)'](agent1.address)
            ).to.be.revertedWith("Reputation already initialized");
        });

        it("Should reject initialization for unregistered agent", async function () {
            await expect(
                reputationManager.connect(client1)['initializeReputation(address)'](client1.address)
            ).to.be.revertedWith("Agent not registered");
        });
    });

    describe("ERC-8004 Feedback System", function () {
        beforeEach(async function () {
            await reputationManager.connect(agent1)['initializeReputation(address)'](agent1.address);
        });

        it("Should submit feedback successfully", async function () {
            const tx = await reputationManager.connect(client1).giveFeedback(
                1, // agentId
                85, // score
                0, // decimals
                "loan-repayment",
                "on-time",
                "https://api.example.com",
                "ipfs://feedback123",
                ethers.ZeroHash
            );

            const receipt = await tx.wait();

            // Check event
            const event = receipt.logs.find(log => {
                try {
                    const parsed = reputationManager.interface.parseLog(log);
                    return parsed.name === "FeedbackGiven";
                } catch (e) {
                    return false;
                }
            });

            expect(event).to.not.be.undefined;
            const parsedEvent = reputationManager.interface.parseLog(event);
            expect(parsedEvent.args.agentId).to.equal(1);
            expect(parsedEvent.args.value).to.equal(85);
        });

        it("Should store feedback with correct data", async function () {
            const tx = await reputationManager.connect(client1).giveFeedback(
                1,
                90,
                2, // 2 decimals
                "service-quality",
                "excellent",
                "endpoint1",
                "ipfs://feedback",
                ethers.ZeroHash
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = reputationManager.interface.parseLog(log);
                    return parsed.name === "FeedbackGiven";
                } catch (e) {
                    return false;
                }
            });

            const feedbackHash = reputationManager.interface.parseLog(event).args.feedbackHash;
            const feedback = await reputationManager.readFeedback(feedbackHash);

            expect(feedback.agentId).to.equal(1);
            expect(feedback.clientAddress).to.equal(client1.address);
            expect(feedback.value).to.equal(90);
            expect(feedback.valueDecimals).to.equal(2);
            expect(feedback.tag1).to.equal("service-quality");
            expect(feedback.tag2).to.equal("excellent");
            expect(feedback.revoked).to.be.false;
        });

        it("Should support negative feedback scores", async function () {
            const tx = await reputationManager.connect(client1).giveFeedback(
                1,
                -50, // Negative score
                0,
                "poor-service",
                "late",
                "",
                "",
                ethers.ZeroHash
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = reputationManager.interface.parseLog(log);
                    return parsed.name === "FeedbackGiven";
                } catch (e) {
                    return false;
                }
            });

            const feedbackHash = reputationManager.interface.parseLog(event).args.feedbackHash;
            const feedback = await reputationManager.readFeedback(feedbackHash);

            expect(feedback.value).to.equal(-50);
        });

        it("Should read all feedback with filters", async function () {
            // Submit multiple feedbacks
            await reputationManager.connect(client1).giveFeedback(1, 85, 0, "loan", "good", "", "", ethers.ZeroHash);
            await reputationManager.connect(client2).giveFeedback(1, 90, 0, "loan", "excellent", "", "", ethers.ZeroHash);
            await reputationManager.connect(client1).giveFeedback(1, 75, 0, "service", "ok", "", "", ethers.ZeroHash);

            // Filter by client
            const client1Feedback = await reputationManager.readAllFeedback(1, [client1.address], []);
            expect(client1Feedback.length).to.equal(2);

            // Filter by tag
            const loanFeedback = await reputationManager.readAllFeedback(1, [], ["loan"]);
            expect(loanFeedback.length).to.equal(2);

            // No filter
            const allFeedback = await reputationManager.readAllFeedback(1, [], []);
            expect(allFeedback.length).to.equal(3);
        });

        it("Should calculate feedback summary correctly", async function () {
            await reputationManager.connect(client1).giveFeedback(1, 100, 0, "test", "", "", "", ethers.ZeroHash);
            await reputationManager.connect(client2).giveFeedback(1, 80, 0, "test", "", "", "", ethers.ZeroHash);
            await reputationManager.connect(client1).giveFeedback(1, 90, 0, "test", "", "", "", ethers.ZeroHash);

            const summary = await reputationManager.getSummary(1, [], []);

            expect(summary.count).to.equal(3);
            expect(summary.averageValue).to.equal(90); // (100 + 80 + 90) / 3
            expect(summary.minValue).to.equal(80);
            expect(summary.maxValue).to.equal(100);
        });

        it("Should allow revoking feedback", async function () {
            const tx = await reputationManager.connect(client1).giveFeedback(1, 85, 0, "test", "", "", "", ethers.ZeroHash);
            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = reputationManager.interface.parseLog(log);
                    return parsed.name === "FeedbackGiven";
                } catch (e) {
                    return false;
                }
            });
            const feedbackHash = reputationManager.interface.parseLog(event).args.feedbackHash;

            await reputationManager.connect(client1).revokeFeedback(feedbackHash);

            const feedback = await reputationManager.readFeedback(feedbackHash);
            expect(feedback.revoked).to.be.true;

            // Revoked feedback should not appear in summary
            const summary = await reputationManager.getSummary(1, [], []);
            expect(summary.count).to.equal(0);
        });

        it("Should reject revoke from non-author", async function () {
            const tx = await reputationManager.connect(client1).giveFeedback(1, 85, 0, "test", "", "", "", ethers.ZeroHash);
            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = reputationManager.interface.parseLog(log);
                    return parsed.name === "FeedbackGiven";
                } catch (e) {
                    return false;
                }
            });
            const feedbackHash = reputationManager.interface.parseLog(event).args.feedbackHash;

            await expect(
                reputationManager.connect(client2).revokeFeedback(feedbackHash)
            ).to.be.revertedWith("Not feedback author");
        });

        it("Should allow agent to respond to feedback", async function () {
            const tx = await reputationManager.connect(client1).giveFeedback(1, 85, 0, "test", "", "", "", ethers.ZeroHash);
            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = reputationManager.interface.parseLog(log);
                    return parsed.name === "FeedbackGiven";
                } catch (e) {
                    return false;
                }
            });
            const feedbackHash = reputationManager.interface.parseLog(event).args.feedbackHash;

            const response = "Thank you for your feedback!";
            await reputationManager.connect(agent1).appendResponse(feedbackHash, response);

            const feedback = await reputationManager.readFeedback(feedbackHash);
            expect(feedback.response).to.equal(response);
        });
    });

    describe("Specular Credit Scoring", function () {
        beforeEach(async function () {
            await reputationManager.connect(agent1)['initializeReputation(address)'](agent1.address);
        });

        it("Should record loan completion with on-time bonus", async function () {
            const initialScore = await reputationManager['getReputationScore(address)'](agent1.address);

            await reputationManager.connect(lendingPool)['recordLoanCompletion(address,uint256,bool)'](
                agent1.address,
                ethers.parseUnits("1000", 6),
                true // on-time
            );

            const newScore = await reputationManager['getReputationScore(address)'](agent1.address);
            expect(newScore).to.be.greaterThan(initialScore);
        });

        it("Should not increase score for late repayment", async function () {
            const initialScore = await reputationManager['getReputationScore(address)'](agent1.address);

            await reputationManager.connect(lendingPool)['recordLoanCompletion(address,uint256,bool)'](
                agent1.address,
                ethers.parseUnits("1000", 6),
                false // late
            );

            const newScore = await reputationManager['getReputationScore(address)'](agent1.address);
            expect(newScore).to.equal(initialScore);
        });

        it("Should penalize defaults", async function () {
            const initialScore = await reputationManager['getReputationScore(address)'](agent1.address);

            await reputationManager.connect(lendingPool)['recordDefault(address,uint256)'](
                agent1.address,
                ethers.parseUnits("1000", 6)
            );

            const newScore = await reputationManager['getReputationScore(address)'](agent1.address);
            expect(newScore).to.be.lessThan(initialScore);
        });

        it("Should cap reputation at MAX_SCORE (1000)", async function () {
            // Boost reputation to near max
            for (let i = 0; i < 100; i++) {
                await reputationManager.connect(lendingPool)['recordLoanCompletion(address,uint256,bool)'](
                    agent1.address,
                    ethers.parseUnits("10000", 6),
                    true
                );
            }

            const score = await reputationManager['getReputationScore(address)'](agent1.address);
            expect(score).to.equal(1000);
        });

        it("Should not go below zero on default", async function () {
            // Multiple defaults
            for (let i = 0; i < 10; i++) {
                await reputationManager.connect(lendingPool)['recordDefault(address,uint256)'](
                    agent1.address,
                    ethers.parseUnits("10000", 6)
                );
            }

            const score = await reputationManager['getReputationScore(address)'](agent1.address);
            expect(score).to.equal(0);
        });

        it("Should calculate credit limits based on score", async function () {
            const score100 = await reputationManager['calculateCreditLimit(address)'](agent1.address);
            expect(score100).to.equal(ethers.parseUnits("1000", 6)); // Score 100 = 1k limit

            // Boost to max (1000) - large loan amounts quickly max out score
            for (let i = 0; i < 5; i++) {
                await reputationManager.connect(lendingPool)['recordLoanCompletion(address,uint256,bool)'](
                    agent1.address,
                    ethers.parseUnits("10000", 6),
                    true
                );
            }

            const maxScore = await reputationManager['getReputationScore(address)'](agent1.address);
            expect(maxScore).to.equal(1000); // Score capped at MAX_SCORE

            const creditLimitMax = await reputationManager['calculateCreditLimit(address)'](agent1.address);
            expect(creditLimitMax).to.equal(ethers.parseUnits("50000", 6)); // Score 800+ = 50k limit
        });

        it("Should calculate collateral requirements based on score", async function () {
            const collateral100 = await reputationManager['calculateCollateralRequirement(address)'](agent1.address);
            expect(collateral100).to.equal(100); // Score 100 = 100% collateral

            // Boost to 800
            for (let i = 0; i < 70; i++) {
                await reputationManager.connect(lendingPool)['recordLoanCompletion(address,uint256,bool)'](
                    agent1.address,
                    ethers.parseUnits("10000", 6),
                    true
                );
            }

            const collateral800 = await reputationManager['calculateCollateralRequirement(address)'](agent1.address);
            expect(collateral800).to.equal(0); // Score 800+ = 0% collateral
        });

        it("Should reject loan operations from non-lending pool", async function () {
            await expect(
                reputationManager.connect(client1)['recordLoanCompletion(address,uint256,bool)'](
                    agent1.address,
                    ethers.parseUnits("1000", 6),
                    true
                )
            ).to.be.revertedWith("Only lending pool");
        });
    });

    describe("Backwards Compatibility", function () {
        beforeEach(async function () {
            await reputationManager.connect(agent1)['initializeReputation(address)'](agent1.address);
        });

        it("Should support address-based score query", async function () {
            const score = await reputationManager['getReputationScore(address)'](agent1.address);
            expect(score).to.equal(100);
        });

        it("Should support ID-based score query", async function () {
            const score = await reputationManager['getReputationScore(uint256)'](1);
            expect(score).to.equal(100);
        });

        it("Should support address-based credit limit", async function () {
            const limit = await reputationManager['calculateCreditLimit(address)'](agent1.address);
            expect(limit).to.be.greaterThan(0);
        });

        it("Should support ID-based credit limit", async function () {
            const limit = await reputationManager['calculateCreditLimit(uint256)'](1);
            expect(limit).to.be.greaterThan(0);
        });
    });

    describe("Edge Cases", function () {
        it("Should handle agent with many feedback entries", async function () {
            await reputationManager.connect(agent1)['initializeReputation(address)'](agent1.address);

            for (let i = 0; i < 20; i++) {
                await reputationManager.connect(client1).giveFeedback(
                    1,
                    80 + i,
                    0,
                    "test",
                    "",
                    "",
                    "",
                    ethers.ZeroHash
                );
            }

            const allFeedback = await reputationManager.readAllFeedback(1, [], []);
            expect(allFeedback.length).to.equal(20);

            const summary = await reputationManager.getSummary(1, [], []);
            expect(summary.count).to.equal(20);
        });

        it("Should handle zero feedback correctly", async function () {
            await reputationManager.connect(agent1)['initializeReputation(address)'](agent1.address);

            const summary = await reputationManager.getSummary(1, [], []);
            expect(summary.count).to.equal(0);
            expect(summary.averageValue).to.equal(0);
            expect(summary.minValue).to.equal(0);
            expect(summary.maxValue).to.equal(0);
        });
    });
});
