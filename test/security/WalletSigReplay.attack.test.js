// SECURITY TEST — D9: setAgentWallet EIP-712 signature must not be replayable.
// Before the fix the typehash had no nonce, so a still-in-deadline signature
// could be replayed to force the wallet back to a prior value. Now a per-agent
// nonce is consumed on each use.

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("SECURITY: setAgentWallet signature replay (D9)", function () {
    let registry, owner, agentOwner, walletA, walletB;

    beforeEach(async () => {
        [owner, agentOwner, walletA, walletB] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        await registry.connect(agentOwner).register("ipfs://a", []);
    });

    async function signSetWallet(signer, agentId, newWallet, deadline, nonce) {
        const domain = {
            name: "SpecularAgentRegistry",
            version: "1",
            chainId: (await ethers.provider.getNetwork()).chainId,
            verifyingContract: await registry.getAddress(),
        };
        const types = { SetWallet: [
            { name: "agentId", type: "uint256" },
            { name: "newWallet", type: "address" },
            { name: "deadline", type: "uint256" },
            { name: "nonce", type: "uint256" },
        ] };
        return signer.signTypedData(domain, types, { agentId, newWallet, deadline, nonce });
    }

    it("a used signature cannot be replayed; a fresh-nonce signature works", async () => {
        const agentId = 1n;
        const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;

        // Nonce 0 → set wallet to A.
        const sigA = await signSetWallet(agentOwner, agentId, walletA.address, deadline, 0);
        await registry.setAgentWallet(agentId, walletA.address, deadline, sigA);
        expect((await registry.agents(agentId)).agentWallet).to.equal(walletA.address);
        expect(await registry.walletNonce(agentId)).to.equal(1n);

        // Nonce 1 → set wallet to B.
        const sigB = await signSetWallet(agentOwner, agentId, walletB.address, deadline, 1);
        await registry.setAgentWallet(agentId, walletB.address, deadline, sigB);
        expect((await registry.agents(agentId)).agentWallet).to.equal(walletB.address);

        // Replay the nonce-0 A-signature (still within deadline) → must REVERT now.
        await expect(registry.setAgentWallet(agentId, walletA.address, deadline, sigA))
            .to.be.revertedWith("Invalid signature");
        // Wallet stays B — no rollback.
        expect((await registry.agents(agentId)).agentWallet).to.equal(walletB.address);
    });

    it("domain-check: the correct EIP-712 domain name is used", async () => {
        // If this reverts with a domain mismatch, the test above's domain is wrong.
        const deadline = (await ethers.provider.getBlock("latest")).timestamp + 3600;
        const sig = await signSetWallet(agentOwner, 1n, walletA.address, deadline, 0);
        await expect(registry.setAgentWallet(1n, walletA.address, deadline, sig)).to.not.be.reverted;
    });
});
