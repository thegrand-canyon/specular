const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentRegistryV2 - ERC-8004 Identity Registry", function () {
    let agentRegistry;
    let owner, agent1, agent2, agent3;

    beforeEach(async function () {
        [owner, agent1, agent2, agent3] = await ethers.getSigners();

        const AgentRegistryV2 = await ethers.getContractFactory("AgentRegistryV2");
        agentRegistry = await AgentRegistryV2.deploy();
        await agentRegistry.waitForDeployment();
    });

    describe("ERC-721 Compliance", function () {
        it("Should support ERC721 interface", async function () {
            // ERC721 interface ID: 0x80ac58cd
            expect(await agentRegistry.supportsInterface("0x80ac58cd")).to.be.true;
        });

        it("Should have correct name and symbol", async function () {
            expect(await agentRegistry.name()).to.equal("Specular Agent");
            expect(await agentRegistry.symbol()).to.equal("SPAGENT");
        });
    });

    describe("Agent Registration (ERC-8004)", function () {
        it("Should register agent with NFT and metadata", async function () {
            const agentURI = "ipfs://QmTest123";
            const metadata = [
                { key: "name", value: ethers.toUtf8Bytes("TestAgent") },
                { key: "version", value: ethers.toUtf8Bytes("1.0.0") }
            ];

            const tx = await agentRegistry.connect(agent1).register(agentURI, metadata);
            const receipt = await tx.wait();

            // Check event
            const event = receipt.logs.find(log => {
                try {
                    const parsed = agentRegistry.interface.parseLog(log);
                    return parsed.name === "AgentRegistered";
                } catch (e) {
                    return false;
                }
            });

            expect(event).to.not.be.undefined;

            // Check NFT minted
            expect(await agentRegistry.balanceOf(agent1.address)).to.equal(1);
            expect(await agentRegistry.ownerOf(1)).to.equal(agent1.address);

            // Check URI
            expect(await agentRegistry.tokenURI(1)).to.equal(agentURI);

            // Check mapping
            expect(await agentRegistry.addressToAgentId(agent1.address)).to.equal(1);
        });

        it("Should store custom metadata correctly", async function () {
            const metadata = [
                { key: "license", value: ethers.toUtf8Bytes("MIT") },
                { key: "contact", value: ethers.toUtf8Bytes("agent@example.com") }
            ];

            await agentRegistry.connect(agent1).register("ipfs://test", metadata);

            const license = await agentRegistry.getMetadata(1, "license");
            const contact = await agentRegistry.getMetadata(1, "contact");

            expect(ethers.toUtf8String(license)).to.equal("MIT");
            expect(ethers.toUtf8String(contact)).to.equal("agent@example.com");
        });

        it("Should prevent duplicate registration", async function () {
            await agentRegistry.connect(agent1).register("ipfs://test", []);

            await expect(
                agentRegistry.connect(agent1).register("ipfs://test2", [])
            ).to.be.revertedWith("Agent already registered");
        });

        it("Should reject empty URI", async function () {
            await expect(
                agentRegistry.connect(agent1).register("", [])
            ).to.be.revertedWith("Agent URI cannot be empty");
        });

        it("Should increment agent IDs correctly", async function () {
            await agentRegistry.connect(agent1).register("ipfs://agent1", []);
            await agentRegistry.connect(agent2).register("ipfs://agent2", []);
            await agentRegistry.connect(agent3).register("ipfs://agent3", []);

            expect(await agentRegistry.addressToAgentId(agent1.address)).to.equal(1);
            expect(await agentRegistry.addressToAgentId(agent2.address)).to.equal(2);
            expect(await agentRegistry.addressToAgentId(agent3.address)).to.equal(3);

            expect(await agentRegistry.totalAgents()).to.equal(3);
        });
    });

    describe("URI Management", function () {
        beforeEach(async function () {
            await agentRegistry.connect(agent1).register("ipfs://original", []);
        });

        it("Should allow owner to update URI", async function () {
            const newURI = "ipfs://updated";
            await agentRegistry.connect(agent1).setAgentURI(1, newURI);

            expect(await agentRegistry.tokenURI(1)).to.equal(newURI);

            const agentInfo = await agentRegistry.getAgentInfoById(1);
            expect(agentInfo.agentURI).to.equal(newURI);
        });

        it("Should reject URI update from non-owner", async function () {
            await expect(
                agentRegistry.connect(agent2).setAgentURI(1, "ipfs://hacked")
            ).to.be.revertedWith("Not agent owner");
        });

        it("Should reject empty URI update", async function () {
            await expect(
                agentRegistry.connect(agent1).setAgentURI(1, "")
            ).to.be.revertedWith("URI cannot be empty");
        });
    });

    describe("Custom Metadata Management", function () {
        beforeEach(async function () {
            await agentRegistry.connect(agent1).register("ipfs://test", []);
        });

        it("Should allow owner to set metadata", async function () {
            await agentRegistry.connect(agent1).setMetadata(
                1,
                "license",
                ethers.toUtf8Bytes("Apache-2.0")
            );

            const metadata = await agentRegistry.getMetadata(1, "license");
            expect(ethers.toUtf8String(metadata)).to.equal("Apache-2.0");
        });

        it("Should allow updating existing metadata", async function () {
            await agentRegistry.connect(agent1).setMetadata(1, "version", ethers.toUtf8Bytes("1.0.0"));
            await agentRegistry.connect(agent1).setMetadata(1, "version", ethers.toUtf8Bytes("2.0.0"));

            const version = await agentRegistry.getMetadata(1, "version");
            expect(ethers.toUtf8String(version)).to.equal("2.0.0");
        });

        it("Should reject metadata update from non-owner", async function () {
            await expect(
                agentRegistry.connect(agent2).setMetadata(1, "test", ethers.toUtf8Bytes("hacked"))
            ).to.be.revertedWith("Not agent owner");
        });

        it("Should reject empty metadata key", async function () {
            await expect(
                agentRegistry.connect(agent1).setMetadata(1, "", ethers.toUtf8Bytes("value"))
            ).to.be.revertedWith("Key cannot be empty");
        });

        it("Should return empty bytes for non-existent metadata", async function () {
            const metadata = await agentRegistry.getMetadata(1, "nonexistent");
            expect(metadata).to.equal("0x");
        });
    });

    describe("NFT Transfer", function () {
        beforeEach(async function () {
            await agentRegistry.connect(agent1).register("ipfs://test", []);
        });

        it("Should update address mapping on transfer", async function () {
            await agentRegistry.connect(agent1).transferFrom(agent1.address, agent2.address, 1);

            expect(await agentRegistry.ownerOf(1)).to.equal(agent2.address);
            expect(await agentRegistry.addressToAgentId(agent1.address)).to.equal(0);
            expect(await agentRegistry.addressToAgentId(agent2.address)).to.equal(1);

            const agentInfo = await agentRegistry.getAgentInfoById(1);
            expect(agentInfo.owner).to.equal(agent2.address);
        });

        it("Should allow new owner to update metadata after transfer", async function () {
            await agentRegistry.connect(agent1).transferFrom(agent1.address, agent2.address, 1);

            await agentRegistry.connect(agent2).setMetadata(1, "newOwner", ethers.toUtf8Bytes("yes"));

            const metadata = await agentRegistry.getMetadata(1, "newOwner");
            expect(ethers.toUtf8String(metadata)).to.equal("yes");
        });

        it("Should prevent old owner from updating after transfer", async function () {
            await agentRegistry.connect(agent1).transferFrom(agent1.address, agent2.address, 1);

            await expect(
                agentRegistry.connect(agent1).setMetadata(1, "test", ethers.toUtf8Bytes("fail"))
            ).to.be.revertedWith("Not agent owner");
        });
    });

    describe("Agent Activation/Deactivation", function () {
        beforeEach(async function () {
            await agentRegistry.connect(agent1).register("ipfs://test", []);
        });

        it("Should start as active", async function () {
            const agentInfo = await agentRegistry.getAgentInfoById(1);
            expect(agentInfo.isActive).to.be.true;

            expect(await agentRegistry.isAgentActive(agent1.address)).to.be.true;
        });

        it("Should allow owner to deactivate agent", async function () {
            await agentRegistry.connect(owner).deactivateAgent(1);

            const agentInfo = await agentRegistry.getAgentInfoById(1);
            expect(agentInfo.isActive).to.be.false;

            expect(await agentRegistry.isAgentActive(agent1.address)).to.be.false;
        });

        it("Should allow owner to reactivate agent", async function () {
            await agentRegistry.connect(owner).deactivateAgent(1);
            await agentRegistry.connect(owner).reactivateAgent(1);

            const agentInfo = await agentRegistry.getAgentInfoById(1);
            expect(agentInfo.isActive).to.be.true;
        });

        it("Should reject deactivation from non-owner", async function () {
            await expect(
                agentRegistry.connect(agent2).deactivateAgent(1)
            ).to.be.revertedWithCustomError(agentRegistry, "OwnableUnauthorizedAccount");
        });
    });

    describe("Query Functions", function () {
        beforeEach(async function () {
            await agentRegistry.connect(agent1).register("ipfs://agent1", [
                { key: "name", value: ethers.toUtf8Bytes("Agent1") }
            ]);
            await agentRegistry.connect(agent2).register("ipfs://agent2", []);
        });

        it("Should check registration status by address", async function () {
            expect(await agentRegistry.isRegistered(agent1.address)).to.be.true;
            expect(await agentRegistry.isRegistered(agent3.address)).to.be.false;
        });

        it("Should get agent info by address", async function () {
            const info = await agentRegistry.getAgentInfo(agent1.address);

            expect(info.agentId).to.equal(1);
            expect(info.owner).to.equal(agent1.address);
            expect(info.agentURI).to.equal("ipfs://agent1");
            expect(info.isActive).to.be.true;
        });

        it("Should get agent info by ID", async function () {
            const info = await agentRegistry.getAgentInfoById(1);

            expect(info.agentId).to.equal(1);
            expect(info.owner).to.equal(agent1.address);
            expect(info.agentURI).to.equal("ipfs://agent1");
        });

        it("Should reject query for non-existent agent", async function () {
            await expect(
                agentRegistry.getAgentInfo(agent3.address)
            ).to.be.revertedWith("Agent not registered");

            await expect(
                agentRegistry.getAgentInfoById(999)
            ).to.be.revertedWith("Agent does not exist");
        });
    });

    describe("Pausability", function () {
        it("Should allow owner to pause", async function () {
            await agentRegistry.connect(owner).pause();
            expect(await agentRegistry.paused()).to.be.true;
        });

        it("Should prevent registration when paused", async function () {
            await agentRegistry.connect(owner).pause();

            await expect(
                agentRegistry.connect(agent1).register("ipfs://test", [])
            ).to.be.revertedWithCustomError(agentRegistry, "EnforcedPause");
        });

        it("Should allow unpause and resume registration", async function () {
            await agentRegistry.connect(owner).pause();
            await agentRegistry.connect(owner).unpause();

            await expect(
                agentRegistry.connect(agent1).register("ipfs://test", [])
            ).to.not.be.reverted;
        });
    });

    describe("Edge Cases", function () {
        it("Should handle very long URIs", async function () {
            const longURI = "ipfs://" + "a".repeat(500);
            await agentRegistry.connect(agent1).register(longURI, []);

            expect(await agentRegistry.tokenURI(1)).to.equal(longURI);
        });

        it("Should handle many metadata entries", async function () {
            const metadata = [];
            for (let i = 0; i < 10; i++) {
                metadata.push({
                    key: `key${i}`,
                    value: ethers.toUtf8Bytes(`value${i}`)
                });
            }

            await agentRegistry.connect(agent1).register("ipfs://test", metadata);

            for (let i = 0; i < 10; i++) {
                const value = await agentRegistry.getMetadata(1, `key${i}`);
                expect(ethers.toUtf8String(value)).to.equal(`value${i}`);
            }
        });

        it("Should handle JSON in metadata", async function () {
            const jsonData = JSON.stringify({ name: "Agent", version: "1.0.0" });
            await agentRegistry.connect(agent1).register("ipfs://test", [
                { key: "config", value: ethers.toUtf8Bytes(jsonData) }
            ]);

            const stored = await agentRegistry.getMetadata(1, "config");
            const parsed = JSON.parse(ethers.toUtf8String(stored));

            expect(parsed.name).to.equal("Agent");
            expect(parsed.version).to.equal("1.0.0");
        });
    });
});
