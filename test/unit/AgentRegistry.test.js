const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentRegistry", function() {
    let agentRegistry;
    let owner, agent1, agent2, agent3;

    beforeEach(async function() {
        [owner, agent1, agent2, agent3] = await ethers.getSigners();

        const AgentRegistry = await ethers.getContractFactory("AgentRegistry");
        agentRegistry = await AgentRegistry.deploy();
        await agentRegistry.waitForDeployment();
    });

    describe("Registration", function() {
        it("Should register a new agent successfully", async function() {
            const metadata = JSON.stringify({ name: "Agent1", version: "1.0" });

            const tx = await agentRegistry.connect(agent1).registerAgent(metadata);
            await expect(tx)
                .to.emit(agentRegistry, "AgentRegistered");

            expect(await agentRegistry.isRegistered(agent1.address)).to.be.true;
            expect(await agentRegistry.totalAgents()).to.equal(1);
        });

        it("Should store agent information correctly", async function() {
            const metadata = JSON.stringify({ name: "Agent1", capabilities: ["trading"] });
            await agentRegistry.connect(agent1).registerAgent(metadata);

            const agentInfo = await agentRegistry.getAgentInfo(agent1.address);

            expect(agentInfo.agentAddress).to.equal(agent1.address);
            expect(agentInfo.metadata).to.equal(metadata);
            expect(agentInfo.isActive).to.be.true;
            expect(agentInfo.registrationTime).to.be.gt(0);
        });

        it("Should fail to register duplicate agent", async function() {
            const metadata = JSON.stringify({ name: "Agent1" });

            await agentRegistry.connect(agent1).registerAgent(metadata);

            await expect(
                agentRegistry.connect(agent1).registerAgent(metadata)
            ).to.be.revertedWith("Agent already registered");
        });

        it("Should fail with empty metadata", async function() {
            await expect(
                agentRegistry.connect(agent1).registerAgent("")
            ).to.be.revertedWith("Metadata cannot be empty");
        });

        it("Should fail with metadata too long", async function() {
            const longMetadata = "a".repeat(1001);
            await expect(
                agentRegistry.connect(agent1).registerAgent(longMetadata)
            ).to.be.revertedWith("Metadata too long");
        });

        it("Should allow multiple agents to register", async function() {
            await agentRegistry.connect(agent1).registerAgent("metadata1");
            await agentRegistry.connect(agent2).registerAgent("metadata2");
            await agentRegistry.connect(agent3).registerAgent("metadata3");

            expect(await agentRegistry.totalAgents()).to.equal(3);
            expect(await agentRegistry.isRegistered(agent1.address)).to.be.true;
            expect(await agentRegistry.isRegistered(agent2.address)).to.be.true;
            expect(await agentRegistry.isRegistered(agent3.address)).to.be.true;
        });
    });

    describe("Metadata Updates", function() {
        beforeEach(async function() {
            await agentRegistry.connect(agent1).registerAgent("initial metadata");
        });

        it("Should update metadata for registered agent", async function() {
            const newMetadata = JSON.stringify({ name: "Agent1", version: "2.0" });

            await expect(agentRegistry.connect(agent1).updateMetadata(newMetadata))
                .to.emit(agentRegistry, "MetadataUpdated")
                .withArgs(agent1.address, newMetadata);

            const agentInfo = await agentRegistry.getAgentInfo(agent1.address);
            expect(agentInfo.metadata).to.equal(newMetadata);
        });

        it("Should fail to update metadata for unregistered agent", async function() {
            await expect(
                agentRegistry.connect(agent2).updateMetadata("new metadata")
            ).to.be.revertedWith("Agent not registered");
        });

        it("Should fail to update with empty metadata", async function() {
            await expect(
                agentRegistry.connect(agent1).updateMetadata("")
            ).to.be.revertedWith("Metadata cannot be empty");
        });
    });

    describe("Agent Activation/Deactivation", function() {
        beforeEach(async function() {
            await agentRegistry.connect(agent1).registerAgent("metadata");
        });

        it("Should deactivate agent (owner only)", async function() {
            await expect(agentRegistry.connect(owner).deactivateAgent(agent1.address))
                .to.emit(agentRegistry, "AgentDeactivated")
                .withArgs(agent1.address);

            expect(await agentRegistry.isAgentActive(agent1.address)).to.be.false;
            const agentInfo = await agentRegistry.getAgentInfo(agent1.address);
            expect(agentInfo.isActive).to.be.false;
        });

        it("Should reactivate agent (owner only)", async function() {
            await agentRegistry.connect(owner).deactivateAgent(agent1.address);

            await expect(agentRegistry.connect(owner).reactivateAgent(agent1.address))
                .to.emit(agentRegistry, "AgentReactivated")
                .withArgs(agent1.address);

            expect(await agentRegistry.isAgentActive(agent1.address)).to.be.true;
        });

        it("Should fail to deactivate if not owner", async function() {
            await expect(
                agentRegistry.connect(agent2).deactivateAgent(agent1.address)
            ).to.be.revertedWithCustomError(agentRegistry, "OwnableUnauthorizedAccount");
        });

        it("Should fail to deactivate unregistered agent", async function() {
            await expect(
                agentRegistry.connect(owner).deactivateAgent(agent2.address)
            ).to.be.revertedWith("Agent not registered");
        });

        it("Should fail to deactivate already deactivated agent", async function() {
            await agentRegistry.connect(owner).deactivateAgent(agent1.address);
            await expect(
                agentRegistry.connect(owner).deactivateAgent(agent1.address)
            ).to.be.revertedWith("Agent already deactivated");
        });
    });

    describe("View Functions", function() {
        it("Should return correct agent active status", async function() {
            expect(await agentRegistry.isAgentActive(agent1.address)).to.be.false;

            await agentRegistry.connect(agent1).registerAgent("metadata");
            expect(await agentRegistry.isAgentActive(agent1.address)).to.be.true;

            await agentRegistry.connect(owner).deactivateAgent(agent1.address);
            expect(await agentRegistry.isAgentActive(agent1.address)).to.be.false;
        });

        it("Should fail to get info for unregistered agent", async function() {
            await expect(
                agentRegistry.getAgentInfo(agent1.address)
            ).to.be.revertedWith("Agent not registered");
        });
    });

    describe("Pause Functionality", function() {
        it("Should allow owner to pause", async function() {
            await agentRegistry.connect(owner).pause();
            expect(await agentRegistry.paused()).to.be.true;
        });

        it("Should allow owner to unpause", async function() {
            await agentRegistry.connect(owner).pause();
            await agentRegistry.connect(owner).unpause();
            expect(await agentRegistry.paused()).to.be.false;
        });

        it("Should prevent registration when paused", async function() {
            await agentRegistry.connect(owner).pause();
            await expect(
                agentRegistry.connect(agent1).registerAgent("metadata")
            ).to.be.revertedWithCustomError(agentRegistry, "EnforcedPause");
        });

        it("Should fail to pause if not owner", async function() {
            await expect(
                agentRegistry.connect(agent1).pause()
            ).to.be.revertedWithCustomError(agentRegistry, "OwnableUnauthorizedAccount");
        });
    });
});
