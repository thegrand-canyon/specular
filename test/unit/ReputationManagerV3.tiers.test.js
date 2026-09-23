// Coverage for ReputationManagerV3 credit-tier boundaries + rate-limit edges.
// Exercises every branch of calculateCreditLimit / calculateCollateralRequirement
// / calculateInterestRate at each score threshold, and the rate-limit window.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("ReputationManagerV3 — tiers + rate-limit", function () {
    let registry, reputation, owner, agent;
    const USDC = (n) => ethers.parseUnits(String(n), 6);

    beforeEach(async () => {
        [owner, agent] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        reputation = await (await ethers.getContractFactory("ReputationManagerV3")).deploy(await registry.getAddress());
        await registry.connect(agent).register("ipfs://a", []);
        await reputation.authorizePool(owner.address); // let us set scores directly
    });

    // Set the agent's score to exactly `target` via completions (+10 each, rate-limit off).
    async function setScore(target) {
        const cur = Number(await reputation["getReputationScore(address)"](agent.address));
        for (let s = cur; s < target; s += 10) await reputation.recordLoanCompletion(agent.address, USDC(100), true);
    }

    const A = () => agent.address;

    it("credit limit tiers", async () => {
        await setScore(0);   expect(await reputation.calculateCreditLimit(A())).to.equal(USDC(1000));
        await setScore(200); expect(await reputation.calculateCreditLimit(A())).to.equal(USDC(5000));
        await setScore(400); expect(await reputation.calculateCreditLimit(A())).to.equal(USDC(10000));
        await setScore(600); expect(await reputation.calculateCreditLimit(A())).to.equal(USDC(25000));
        await setScore(800); expect(await reputation.calculateCreditLimit(A())).to.equal(USDC(50000));
    });

    it("collateral requirement tiers", async () => {
        await setScore(0);   expect(await reputation.calculateCollateralRequirement(A())).to.equal(100n);
        await setScore(500); expect(await reputation.calculateCollateralRequirement(A())).to.equal(25n);
        await setScore(600); expect(await reputation.calculateCollateralRequirement(A())).to.equal(0n);
        await setScore(800); expect(await reputation.calculateCollateralRequirement(A())).to.equal(0n);
    });

    it("interest rate tiers (bps)", async () => {
        await setScore(0);   expect(await reputation.calculateInterestRate(A())).to.equal(1500n);
        await setScore(400); expect(await reputation.calculateInterestRate(A())).to.equal(1000n);
        await setScore(600); expect(await reputation.calculateInterestRate(A())).to.equal(700n);
        await setScore(800); expect(await reputation.calculateInterestRate(A())).to.equal(500n);
    });

    it("score is capped at 1000", async () => {
        for (let i = 0; i < 110; i++) await reputation.recordLoanCompletion(agent.address, USDC(100), true);
        expect(await reputation["getReputationScore(address)"](agent.address)).to.equal(1000n);
    });

    it("default penalty: small (50) vs large (100), and floors at 0", async () => {
        await setScore(200);
        await reputation.recordDefault(agent.address, USDC(100)); // < 10k threshold → penalty 50
        expect(await reputation["getReputationScore(address)"](agent.address)).to.equal(150n);
        await reputation.recordDefault(agent.address, USDC(1000000)); // large → penalty 100 → 50
        expect(await reputation["getReputationScore(address)"](agent.address)).to.equal(50n);
        await reputation.recordDefault(agent.address, USDC(1000000)); // penalty 100 > 50 → floor 0
        expect(await reputation["getReputationScore(address)"](agent.address)).to.equal(0n);
    });

    it("rate-limit: within-window gains clamp; window resets after elapse", async () => {
        await reputation.setReputationRateLimit(15, 24 * 60 * 60);
        // First window: 3 full loans (+30) clamp to 15.
        for (let i = 0; i < 3; i++) await reputation.recordLoanCompletion(agent.address, USDC(100), true);
        expect(await reputation["getReputationScore(address)"](agent.address)).to.equal(15n);
        // Advance one window → budget resets, +10 more.
        await time.increase(24 * 60 * 60 + 1);
        await reputation.recordLoanCompletion(agent.address, USDC(100), true);
        expect(await reputation["getReputationScore(address)"](agent.address)).to.equal(25n);
    });
});
