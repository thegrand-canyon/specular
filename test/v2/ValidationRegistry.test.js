const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("ValidationRegistry - ERC-8004 Validation Registry", function () {
    let agentRegistry, validationRegistry;
    let owner, agent1, agent2, validator1, validator2, requester;

    beforeEach(async function () {
        [owner, agent1, agent2, validator1, validator2, requester] = await ethers.getSigners();

        // Deploy AgentRegistry
        const AgentRegistryV2 = await ethers.getContractFactory("AgentRegistryV2");
        agentRegistry = await AgentRegistryV2.deploy();
        await agentRegistry.waitForDeployment();

        // Deploy ValidationRegistry
        const ValidationRegistry = await ethers.getContractFactory("ValidationRegistry");
        validationRegistry = await ValidationRegistry.deploy(await agentRegistry.getAddress());
        await validationRegistry.waitForDeployment();

        // Register agents
        await agentRegistry.connect(agent1).register("ipfs://agent1", []);
        await agentRegistry.connect(agent2).register("ipfs://agent2", []);

        // Approve validators
        await validationRegistry.connect(owner).approveValidator(validator1.address, "ipfs://validator1");
        await validationRegistry.connect(owner).approveValidator(validator2.address, "ipfs://validator2");
    });

    describe("Validator Management", function () {
        it("Should approve validator successfully", async function () {
            const validator = await validationRegistry.validators(validator1.address);

            expect(validator.isApproved).to.be.true;
            expect(validator.validatorURI).to.equal("ipfs://validator1");
            expect(validator.validationsCompleted).to.equal(0);
        });

        it("Should list approved validators", async function () {
            const validators = await validationRegistry.getApprovedValidators();

            expect(validators).to.include(validator1.address);
            expect(validators).to.include(validator2.address);
            expect(validators.length).to.equal(2);
        });

        it("Should prevent duplicate approval", async function () {
            await expect(
                validationRegistry.connect(owner).approveValidator(validator1.address, "ipfs://duplicate")
            ).to.be.revertedWith("Validator already approved");
        });

        it("Should allow removing validator", async function () {
            await validationRegistry.connect(owner).removeValidator(validator1.address);

            const validator = await validationRegistry.validators(validator1.address);
            expect(validator.isApproved).to.be.false;
        });

        it("Should reject validator operations from non-owner", async function () {
            await expect(
                validationRegistry.connect(agent1).approveValidator(agent2.address, "ipfs://test")
            ).to.be.revertedWithCustomError(validationRegistry, "OwnableUnauthorizedAccount");

            await expect(
                validationRegistry.connect(agent1).removeValidator(validator1.address)
            ).to.be.revertedWithCustomError(validationRegistry, "OwnableUnauthorizedAccount");
        });
    });

    describe("Validation Request", function () {
        it("Should create validation request successfully", async function () {
            const tx = await validationRegistry.connect(requester).validationRequest(
                validator1.address,
                1, // agentId
                "ipfs://request123",
                ethers.ZeroHash
            );

            const receipt = await tx.wait();

            // Check event
            const event = receipt.logs.find(log => {
                try {
                    const parsed = validationRegistry.interface.parseLog(log);
                    return parsed.name === "ValidationRequested";
                } catch (e) {
                    return false;
                }
            });

            expect(event).to.not.be.undefined;
            const parsedEvent = validationRegistry.interface.parseLog(event);
            expect(parsedEvent.args.agentId).to.equal(1);
            expect(parsedEvent.args.validator).to.equal(validator1.address);
        });

        it("Should store validation request data correctly", async function () {
            const tx = await validationRegistry.connect(requester).validationRequest(
                validator1.address,
                1,
                "ipfs://request",
                ethers.ZeroHash
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = validationRegistry.interface.parseLog(log);
                    return parsed.name === "ValidationRequested";
                } catch (e) {
                    return false;
                }
            });

            const requestHash = validationRegistry.interface.parseLog(event).args.requestHash;
            const validation = await validationRegistry.getValidationStatus(requestHash);

            expect(validation.agentId).to.equal(1);
            expect(validation.requester).to.equal(requester.address);
            expect(validation.validatorAddress).to.equal(validator1.address);
            expect(validation.requestURI).to.equal("ipfs://request");
            expect(validation.status).to.equal(0); // PENDING
        });

        it("Should reject request for non-approved validator", async function () {
            await expect(
                validationRegistry.connect(requester).validationRequest(
                    agent2.address, // not a validator
                    1,
                    "ipfs://test",
                    ethers.ZeroHash
                )
            ).to.be.revertedWith("Validator not approved");
        });

        it("Should reject request for non-existent agent", async function () {
            await expect(
                validationRegistry.connect(requester).validationRequest(
                    validator1.address,
                    999, // non-existent agentId
                    "ipfs://test",
                    ethers.ZeroHash
                )
            ).to.be.revertedWithCustomError(agentRegistry, "ERC721NonexistentToken");
        });
    });

    describe("Validation Response", function () {
        let requestHash;

        beforeEach(async function () {
            const tx = await validationRegistry.connect(requester).validationRequest(
                validator1.address,
                1,
                "ipfs://request",
                ethers.ZeroHash
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = validationRegistry.interface.parseLog(log);
                    return parsed.name === "ValidationRequested";
                } catch (e) {
                    return false;
                }
            });

            requestHash = validationRegistry.interface.parseLog(event).args.requestHash;
        });

        it("Should allow validator to submit response", async function () {
            await validationRegistry.connect(validator1).validationResponse(
                requestHash,
                85, // score 85/100
                "ipfs://response",
                ethers.ZeroHash,
                "performance-check"
            );

            const validation = await validationRegistry.getValidationStatus(requestHash);
            expect(validation.responseScore).to.equal(85);
            expect(validation.status).to.equal(1); // APPROVED (score > 50)
            expect(validation.tag).to.equal("performance-check");
        });

        it("Should mark as REJECTED for low scores", async function () {
            await validationRegistry.connect(validator1).validationResponse(
                requestHash,
                30, // score 30/100
                "ipfs://response",
                ethers.ZeroHash,
                "failed-check"
            );

            const validation = await validationRegistry.getValidationStatus(requestHash);
            expect(validation.responseScore).to.equal(30);
            expect(validation.status).to.equal(2); // REJECTED (score <= 50)
        });

        it("Should increment validator completion count", async function () {
            const beforeCount = (await validationRegistry.validators(validator1.address)).validationsCompleted;

            await validationRegistry.connect(validator1).validationResponse(
                requestHash,
                75,
                "",
                ethers.ZeroHash,
                ""
            );

            const afterCount = (await validationRegistry.validators(validator1.address)).validationsCompleted;
            expect(afterCount).to.equal(beforeCount + BigInt(1));
        });

        it("Should reject response from wrong validator", async function () {
            await expect(
                validationRegistry.connect(validator2).validationResponse(
                    requestHash,
                    75,
                    "",
                    ethers.ZeroHash,
                    ""
                )
            ).to.be.revertedWith("Not the assigned validator");
        });

        it("Should reject score > 100", async function () {
            await expect(
                validationRegistry.connect(validator1).validationResponse(
                    requestHash,
                    150,
                    "",
                    ethers.ZeroHash,
                    ""
                )
            ).to.be.revertedWith("Response must be 0-100");
        });

        it("Should prevent duplicate response", async function () {
            await validationRegistry.connect(validator1).validationResponse(
                requestHash,
                75,
                "",
                ethers.ZeroHash,
                ""
            );

            await expect(
                validationRegistry.connect(validator1).validationResponse(
                    requestHash,
                    80,
                    "",
                    ethers.ZeroHash,
                    ""
                )
            ).to.be.revertedWith("Validation already completed");
        });
    });

    describe("Validation Dispute", function () {
        let requestHash;

        beforeEach(async function () {
            const tx = await validationRegistry.connect(requester).validationRequest(
                validator1.address,
                1,
                "ipfs://request",
                ethers.ZeroHash
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = validationRegistry.interface.parseLog(log);
                    return parsed.name === "ValidationRequested";
                } catch (e) {
                    return false;
                }
            });

            requestHash = validationRegistry.interface.parseLog(event).args.requestHash;

            // Submit response
            await validationRegistry.connect(validator1).validationResponse(
                requestHash,
                85,
                "",
                ethers.ZeroHash,
                ""
            );
        });

        it("Should allow requester to dispute", async function () {
            await validationRegistry.connect(requester).disputeValidation(requestHash);

            const validation = await validationRegistry.getValidationStatus(requestHash);
            expect(validation.status).to.equal(3); // DISPUTED
        });

        it("Should allow agent owner to dispute", async function () {
            await validationRegistry.connect(agent1).disputeValidation(requestHash);

            const validation = await validationRegistry.getValidationStatus(requestHash);
            expect(validation.status).to.equal(3); // DISPUTED
        });

        it("Should increment validator dispute count", async function () {
            const beforeCount = (await validationRegistry.validators(validator1.address)).validationsDisputed;

            await validationRegistry.connect(requester).disputeValidation(requestHash);

            const afterCount = (await validationRegistry.validators(validator1.address)).validationsDisputed;
            expect(afterCount).to.equal(beforeCount + BigInt(1));
        });

        it("Should reject dispute from unauthorized user", async function () {
            await expect(
                validationRegistry.connect(agent2).disputeValidation(requestHash)
            ).to.be.revertedWith("Not authorized to dispute");
        });

        it("Should reject dispute for pending validation", async function () {
            const tx = await validationRegistry.connect(requester).validationRequest(
                validator1.address,
                1,
                "ipfs://request2",
                ethers.ZeroHash
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = validationRegistry.interface.parseLog(log);
                    return parsed.name === "ValidationRequested";
                } catch (e) {
                    return false;
                }
            });

            const pendingHash = validationRegistry.interface.parseLog(event).args.requestHash;

            await expect(
                validationRegistry.connect(requester).disputeValidation(pendingHash)
            ).to.be.revertedWith("Can only dispute completed validations");
        });
    });

    describe("Validation Summary", function () {
        it("Should calculate summary for single validation", async function () {
            const tx = await validationRegistry.connect(requester).validationRequest(
                validator1.address,
                1,
                "ipfs://request",
                ethers.ZeroHash
            );

            const receipt = await tx.wait();
            const event = receipt.logs.find(log => {
                try {
                    const parsed = validationRegistry.interface.parseLog(log);
                    return parsed.name === "ValidationRequested";
                } catch (e) {
                    return false;
                }
            });

            const requestHash = validationRegistry.interface.parseLog(event).args.requestHash;

            await validationRegistry.connect(validator1).validationResponse(
                requestHash,
                90,
                "",
                ethers.ZeroHash,
                "performance"
            );

            const summary = await validationRegistry.getSummary(1, [], "");

            expect(summary.totalCount).to.equal(1);
            expect(summary.approvedCount).to.equal(1);
            expect(summary.rejectedCount).to.equal(0);
            expect(summary.averageScore).to.equal(90);
        });

        it("Should calculate summary for multiple validations", async function () {
            // Request 1
            let tx = await validationRegistry.connect(requester).validationRequest(validator1.address, 1, "ipfs://1", ethers.ZeroHash);
            let receipt = await tx.wait();
            let event = receipt.logs.find(log => {
                try {
                    return validationRegistry.interface.parseLog(log).name === "ValidationRequested";
                } catch (e) {
                    return false;
                }
            });
            let hash1 = validationRegistry.interface.parseLog(event).args.requestHash;

            // Request 2
            tx = await validationRegistry.connect(requester).validationRequest(validator2.address, 1, "ipfs://2", ethers.ZeroHash);
            receipt = await tx.wait();
            event = receipt.logs.find(log => {
                try {
                    return validationRegistry.interface.parseLog(log).name === "ValidationRequested";
                } catch (e) {
                    return false;
                }
            });
            let hash2 = validationRegistry.interface.parseLog(event).args.requestHash;

            // Request 3
            tx = await validationRegistry.connect(requester).validationRequest(validator1.address, 1, "ipfs://3", ethers.ZeroHash);
            receipt = await tx.wait();
            event = receipt.logs.find(log => {
                try {
                    return validationRegistry.interface.parseLog(log).name === "ValidationRequested";
                } catch (e) {
                    return false;
                }
            });
            let hash3 = validationRegistry.interface.parseLog(event).args.requestHash;

            // Responses
            await validationRegistry.connect(validator1).validationResponse(hash1, 80, "", ethers.ZeroHash, "test");
            await validationRegistry.connect(validator2).validationResponse(hash2, 30, "", ethers.ZeroHash, "test"); // Rejected
            await validationRegistry.connect(validator1).validationResponse(hash3, 90, "", ethers.ZeroHash, "test");

            const summary = await validationRegistry.getSummary(1, [], "");

            expect(summary.totalCount).to.equal(3);
            expect(summary.approvedCount).to.equal(2);
            expect(summary.rejectedCount).to.equal(1);
            expect(summary.averageScore).to.equal(66); // (80 + 30 + 90) / 3
        });

        it("Should filter summary by validator", async function () {
            // Create validations from both validators
            let tx1 = await validationRegistry.connect(requester).validationRequest(validator1.address, 1, "ipfs://1", ethers.ZeroHash);
            let receipt1 = await tx1.wait();
            let event1 = receipt1.logs.find(log => {
                try {
                    return validationRegistry.interface.parseLog(log).name === "ValidationRequested";
                } catch (e) {
                    return false;
                }
            });
            let hash1 = validationRegistry.interface.parseLog(event1).args.requestHash;

            let tx2 = await validationRegistry.connect(requester).validationRequest(validator2.address, 1, "ipfs://2", ethers.ZeroHash);
            let receipt2 = await tx2.wait();
            let event2 = receipt2.logs.find(log => {
                try {
                    return validationRegistry.interface.parseLog(log).name === "ValidationRequested";
                } catch (e) {
                    return false;
                }
            });
            let hash2 = validationRegistry.interface.parseLog(event2).args.requestHash;

            await validationRegistry.connect(validator1).validationResponse(hash1, 80, "", ethers.ZeroHash, "");
            await validationRegistry.connect(validator2).validationResponse(hash2, 90, "", ethers.ZeroHash, "");

            // Filter by validator1
            const summary = await validationRegistry.getSummary(1, [validator1.address], "");
            expect(summary.totalCount).to.equal(1);
            expect(summary.averageScore).to.equal(80);
        });

        it("Should filter summary by tag", async function () {
            let tx1 = await validationRegistry.connect(requester).validationRequest(validator1.address, 1, "ipfs://1", ethers.ZeroHash);
            let receipt1 = await tx1.wait();
            let event1 = receipt1.logs.find(log => {
                try {
                    return validationRegistry.interface.parseLog(log).name === "ValidationRequested";
                } catch (e) {
                    return false;
                }
            });
            let hash1 = validationRegistry.interface.parseLog(event1).args.requestHash;

            let tx2 = await validationRegistry.connect(requester).validationRequest(validator1.address, 1, "ipfs://2", ethers.ZeroHash);
            let receipt2 = await tx2.wait();
            let event2 = receipt2.logs.find(log => {
                try {
                    return validationRegistry.interface.parseLog(log).name === "ValidationRequested";
                } catch (e) {
                    return false;
                }
            });
            let hash2 = validationRegistry.interface.parseLog(event2).args.requestHash;

            await validationRegistry.connect(validator1).validationResponse(hash1, 80, "", ethers.ZeroHash, "performance");
            await validationRegistry.connect(validator1).validationResponse(hash2, 90, "", ethers.ZeroHash, "security");

            // Filter by tag
            const summary = await validationRegistry.getSummary(1, [], "performance");
            expect(summary.totalCount).to.equal(1);
            expect(summary.averageScore).to.equal(80);
        });

        it("Should exclude disputed validations from summary", async function () {
            let tx = await validationRegistry.connect(requester).validationRequest(validator1.address, 1, "ipfs://1", ethers.ZeroHash);
            let receipt = await tx.wait();
            let event = receipt.logs.find(log => {
                try {
                    return validationRegistry.interface.parseLog(log).name === "ValidationRequested";
                } catch (e) {
                    return false;
                }
            });
            let hash = validationRegistry.interface.parseLog(event).args.requestHash;

            await validationRegistry.connect(validator1).validationResponse(hash, 80, "", ethers.ZeroHash, "");
            await validationRegistry.connect(requester).disputeValidation(hash);

            const summary = await validationRegistry.getSummary(1, [], "");
            expect(summary.totalCount).to.equal(0);
        });
    });

    describe("Query Functions", function () {
        it("Should get agent validations", async function () {
            await validationRegistry.connect(requester).validationRequest(validator1.address, 1, "ipfs://1", ethers.ZeroHash);
            await validationRegistry.connect(requester).validationRequest(validator2.address, 1, "ipfs://2", ethers.ZeroHash);

            const validations = await validationRegistry.getAgentValidations(1);
            expect(validations.length).to.equal(2);
        });

        it("Should get validator validations", async function () {
            await validationRegistry.connect(requester).validationRequest(validator1.address, 1, "ipfs://1", ethers.ZeroHash);
            await validationRegistry.connect(requester).validationRequest(validator1.address, 2, "ipfs://2", ethers.ZeroHash);

            const validations = await validationRegistry.getValidatorValidations(validator1.address);
            expect(validations.length).to.equal(2);
        });
    });
});
