// Coverage for AgentRegistryV2's under-tested NFT/admin surface: setAgentURI,
// setMetadata/getMetadata, deactivate/reactivate, pause/unpause, and the
// registration/active views. (register, transfer/_update, and setAgentWallet
// nonce are covered by other suites.)

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("AgentRegistryV2 — NFT / admin functions", function () {
    let registry, owner, agent, other;

    beforeEach(async () => {
        [owner, agent, other] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        await registry.connect(agent).register("ipfs://agent", []);
    });

    describe("setAgentURI", () => {
        it("owner of the agent can update its URI", async () => {
            await registry.connect(agent).setAgentURI(1, "ipfs://updated");
            expect((await registry.agents(1)).agentURI).to.equal("ipfs://updated");
        });
        it("non-owner cannot", async () => {
            await expect(registry.connect(other).setAgentURI(1, "ipfs://evil")).to.be.revertedWith("Not agent owner");
        });
        it("empty URI rejected", async () => {
            await expect(registry.connect(agent).setAgentURI(1, "")).to.be.revertedWith("URI cannot be empty");
        });
    });

    describe("setMetadata / getMetadata", () => {
        it("owner sets and reads metadata", async () => {
            const val = ethers.toUtf8Bytes("gpt-5");
            await registry.connect(agent).setMetadata(1, "model", val);
            expect(await registry.getMetadata(1, "model")).to.equal(ethers.hexlify(val));
        });
        it("non-owner cannot set; empty key rejected", async () => {
            await expect(registry.connect(other).setMetadata(1, "k", "0x")).to.be.revertedWith("Not agent owner");
            await expect(registry.connect(agent).setMetadata(1, "", "0x")).to.be.revertedWith("Key cannot be empty");
        });
        it("getMetadata on a non-existent agent reverts", async () => {
            await expect(registry.getMetadata(999, "k")).to.be.revertedWith("Agent does not exist");
        });
    });

    describe("deactivate / reactivate (owner-only)", () => {
        it("owner can deactivate then reactivate; flags flip", async () => {
            expect(await registry.isAgentActive(agent.address)).to.equal(true);
            await registry.connect(owner).deactivateAgent(1);
            expect((await registry.agents(1)).isActive).to.equal(false);
            expect(await registry.isAgentActive(agent.address)).to.equal(false);
            await registry.connect(owner).reactivateAgent(1);
            expect(await registry.isAgentActive(agent.address)).to.equal(true);
        });
        it("double-deactivate reverts; non-owner cannot", async () => {
            await registry.connect(owner).deactivateAgent(1);
            await expect(registry.connect(owner).deactivateAgent(1)).to.be.revertedWith("Agent already deactivated");
            await expect(registry.connect(other).deactivateAgent(1)).to.be.reverted; // onlyOwner
        });
        it("acting on a non-existent agent reverts", async () => {
            await expect(registry.connect(owner).deactivateAgent(999)).to.be.revertedWith("Agent does not exist");
        });
    });

    describe("pause / unpause", () => {
        it("owner-only; paused blocks registration; unpause restores", async () => {
            await expect(registry.connect(other).pause()).to.be.reverted;
            await registry.connect(owner).pause();
            await expect(registry.connect(other).register("ipfs://x", [])).to.be.reverted; // whenNotPaused
            await registry.connect(owner).unpause();
            await registry.connect(other).register("ipfs://x", []);
            expect(await registry.isRegistered(other.address)).to.equal(true);
        });
    });

    describe("views", () => {
        it("isRegistered / totalAgents reflect state", async () => {
            expect(await registry.isRegistered(agent.address)).to.equal(true);
            expect(await registry.isRegistered(other.address)).to.equal(false);
            expect(await registry.totalAgents()).to.equal(1n);
        });
    });
});
