// Regression tests for the 2026-08 pre-mainnet self-audit fixes:
//   - H-2 × resetPoolAccounting: don't remove a lender with unclaimed interest.
//   - F-C: minSupplyAmount lever raises lender-slot squat cost.
//   - F1/F-G: reputation can't be re-initialized after defaulting to 0.
//   - F3: NFT transfer to an address that already owns an agent is rejected.

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("V6 self-audit fixes (2026-08)", function () {
    let v6, registry, reputation, usdc, owner, agent, agent2, lender, other;
    const USDC = (n) => ethers.parseUnits(n.toString(), 6);

    beforeEach(async () => {
        [owner, agent, agent2, lender, other] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        reputation = await (await ethers.getContractFactory("ReputationManagerV3")).deploy(await registry.getAddress());
        usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
        v6 = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV6")).deploy(
            await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
        await reputation.authorizePool(await v6.getAddress());
        await registry.connect(agent).register("ipfs://agent", []);
        await v6.connect(agent).createAgentPool();
        for (const w of [agent, lender, other]) {
            await usdc.mint(w.address, USDC(100_000));
            await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256);
        }
    });

    describe("H-2 × resetPoolAccounting — unclaimed interest not frozen", () => {
        it("a lender who withdraws all principal keeps their slot until interest is claimed", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(1000));
            await v6.connect(agent).requestLoan(USDC(100), 30);
            await v6.connect(agent).repayLoan(1); // lender now has earnedInterest
            const pos = await v6.positions(1, lender.address);
            expect(pos.earnedInterest).to.be.gt(0n);

            // Withdraw ALL principal (available includes the interest; leave the interest).
            const pool = await v6.getAgentPool(1);
            const principal = pos.amount < pool.availableLiquidity ? pos.amount : pool.availableLiquidity;
            await v6.connect(lender).withdrawLiquidity(1, principal);

            // Lender still in poolLenders (has unclaimed interest) → resetPoolAccounting stays consistent.
            expect((await v6.getAgentPool(1)).lenderCount).to.equal(1n);
            await expect(v6.resetPoolAccounting(1)).to.not.be.reverted;
            // And they can still claim their interest (not frozen).
            await expect(v6.connect(lender).claimInterest(1)).to.not.be.reverted;
            // After claiming with zero principal, the slot is now freed.
            expect((await v6.getAgentPool(1)).lenderCount).to.equal(0n);
        });
    });

    describe("F-C — minSupplyAmount squat lever", () => {
        it("defaults off; when set, gates only NEW slots (top-ups exempt)", async () => {
            expect(await v6.minSupplyAmount()).to.equal(0n);
            await v6.setMinSupplyAmount(USDC(1));
            // A new tiny slot is rejected.
            await expect(v6.connect(other).supplyLiquidity(1, USDC("0.000001"))).to.be.revertedWith("Below minimum supply");
            // A compliant supply works, and a later top-up of any size is allowed.
            await v6.connect(lender).supplyLiquidity(1, USDC(5));
            await expect(v6.connect(lender).supplyLiquidity(1, USDC("0.000001"))).to.not.be.reverted;
        });
        it("only owner can set it", async () => {
            await expect(v6.connect(agent).setMinSupplyAmount(USDC(1))).to.be.reverted;
        });
    });

    describe("F1/F-G — no reputation reset after default-to-0", () => {
        it("cannot re-initialize once initialized, even after score hits 0", async () => {
            await reputation.connect(agent)["initializeReputation(uint256)"](1);
            expect(await reputation.initialized(1)).to.equal(true);
            // Drive the score to 0 via a large default (authorize owner as a pool to call directly).
            await reputation.authorizePool(owner.address);
            await reputation.recordDefault(agent.address, USDC(100000)); // large default → floors to 0
            expect(await reputation["getReputationScore(address)"](agent.address)).to.equal(0n);
            // Re-initialization must be blocked (was allowed when gated on score==0).
            await expect(reputation.connect(agent)["initializeReputation(uint256)"](1)).to.be.revertedWith("Already initialized");
        });
    });

    describe("F3 — NFT transfer to an address that already owns an agent is rejected", () => {
        it("blocks the transfer that would orphan the recipient's agentId", async () => {
            await registry.connect(agent2).register("ipfs://agent2", []); // agent2 owns agentId 2
            // Transferring agent 1 to agent2 would overwrite addressToAgentId[agent2]=1, orphaning agent 2.
            await expect(
                registry.connect(agent).transferFrom(agent.address, agent2.address, 1)
            ).to.be.revertedWith("Recipient already owns an agent");
            // Transfer to a fresh address still works.
            await expect(registry.connect(agent).transferFrom(agent.address, other.address, 1)).to.not.be.reverted;
            expect(await registry.addressToAgentId(other.address)).to.equal(1n);
        });
    });
});
