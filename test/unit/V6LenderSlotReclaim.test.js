// Regression test for audit finding H-2 (2026-07): permanent lender-slot
// squatting. withdrawLiquidity never removed a fully-withdrawn lender from
// poolLenders and never cleared the §B1 isInPoolLenders flag, so an attacker
// could supply→withdraw from MAX_LENDERS_PER_POOL addresses to permanently
// occupy the cap and lock every future lender out ("Pool lender capacity
// reached"). Fix: swap-remove zero-balance lenders on withdraw.

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("V6 — lender slot reclaim (H-2)", function () {
    let v6, registry, reputation, usdc;
    let owner, agent, l1, l2, l3;
    const USDC = (n) => ethers.parseUnits(n.toString(), 6);

    beforeEach(async () => {
        [owner, agent, l1, l2, l3] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        reputation = await (await ethers.getContractFactory("ReputationManagerV3")).deploy(await registry.getAddress());
        usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
        v6 = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV6")).deploy(
            await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress()
        );
        await reputation.authorizePool(await v6.getAddress());
        await registry.connect(agent).register("ipfs://agent", []);
        await v6.connect(agent).createAgentPool();
        for (const w of [l1, l2, l3]) {
            await usdc.mint(w.address, USDC(10_000));
            await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256);
        }
    });

    const lenderCount = async () => (await v6.getAgentPool(1)).lenderCount;

    it("frees the slot when a lender fully withdraws", async () => {
        await v6.connect(l1).supplyLiquidity(1, USDC(100));
        await v6.connect(l2).supplyLiquidity(1, USDC(100));
        expect(await lenderCount()).to.equal(2n);

        await v6.connect(l1).withdrawLiquidity(1, USDC(100)); // full withdrawal
        expect(await lenderCount()).to.equal(1n);
        expect(await v6.isInPoolLenders(1, l1.address)).to.equal(false);
    });

    it("keeps the slot on a partial withdrawal", async () => {
        await v6.connect(l1).supplyLiquidity(1, USDC(100));
        await v6.connect(l1).withdrawLiquidity(1, USDC(40)); // partial
        expect(await lenderCount()).to.equal(1n);
        expect(await v6.isInPoolLenders(1, l1.address)).to.equal(true);
    });

    it("re-supply after full withdrawal adds exactly one entry (no duplicate, §B1 preserved)", async () => {
        await v6.connect(l1).supplyLiquidity(1, USDC(100));
        await v6.connect(l1).withdrawLiquidity(1, USDC(100));
        expect(await lenderCount()).to.equal(0n);
        await v6.connect(l1).supplyLiquidity(1, USDC(50));
        expect(await lenderCount()).to.equal(1n); // not 2
    });

    it("a squatter who supplies then fully withdraws does not consume a slot", async () => {
        await v6.connect(l1).supplyLiquidity(1, USDC(1));
        await v6.connect(l1).withdrawLiquidity(1, USDC(1)); // squat attempt
        expect(await lenderCount()).to.equal(0n);
        // A real lender can still join.
        await v6.connect(l2).supplyLiquidity(1, USDC(500));
        expect(await lenderCount()).to.equal(1n);
    });
});
