// SECURITY TEST — R13: reentrancy into register() via a malicious onERC721Received
// during the agent's own _safeMint. The register() CEI fix (state written before
// _safeMint) must make the reentrant register() a no-op ("Agent already
// registered") — no second orphaned agentId minted.

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SECURITY: register() reentrancy via NFT receiver (R13)", function () {
    let registry, attacker;

    beforeEach(async () => {
        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        attacker = await (await ethers.getContractFactory("MaliciousAgentReceiver")).deploy(await registry.getAddress());
    });

    it("reentrant register() during _safeMint is blocked; exactly one agentId minted", async () => {
        await attacker.attackRegister();
        // The reentrant register() attempt happened but was rejected by the guard.
        expect(await attacker.reentrantAttempted()).to.equal(true);
        expect(await attacker.reentrantMinted(), "reentrant register must NOT mint a 2nd id").to.equal(false);
        // The attacker holds exactly one agent, and total supply advanced by 1.
        const aid = await registry.addressToAgentId(await attacker.getAddress());
        expect(aid).to.equal(1n);
        // nextAgentId is 2 (one mint), not 3 (which a double-mint would produce).
        // Register a fresh EOA and confirm it gets id 2 (proving only one was consumed).
        const [, eoa] = await ethers.getSigners();
        await registry.connect(eoa).register("ipfs://eoa", []);
        expect(await registry.addressToAgentId(eoa.address)).to.equal(2n);
    });
});
