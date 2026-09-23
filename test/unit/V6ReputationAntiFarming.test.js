// Regression test for D1 (2026-08): reputation must reflect economic stake, not
// loan count. Before: a flat +10 per on-time repayment regardless of size, with
// zero-interest dust loans free → build-then-bust-out farm. After:
//   (a) the on-time bonus is scaled by principal against bonusReferenceAmount, and
//   (b) the marketplace only rewards loans that actually paid interest (>0).

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("D1 — stake-weighted reputation (anti-farming)", function () {
    let v6, registry, reputation, usdc, owner, agent, lender;
    const USDC = (n) => ethers.parseUnits(n.toString(), 6);

    beforeEach(async () => {
        [owner, agent, lender] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        reputation = await (await ethers.getContractFactory("ReputationManagerV3")).deploy(await registry.getAddress());
        usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
        v6 = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV6")).deploy(
            await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
        await reputation.authorizePool(await v6.getAddress());
        await registry.connect(agent).register("ipfs://agent", []);
        await v6.connect(agent).createAgentPool();
        for (const w of [agent, lender]) {
            await usdc.mint(w.address, USDC(1_000_000));
            await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256);
        }
    });

    describe("principal-scaled bonus (ReputationManagerV3)", () => {
        it("defaults: 100 USDC reference", async () => {
            expect(await reputation.bonusReferenceAmount()).to.equal(USDC(100));
        });

        it("a full-size loan earns the full +10; a dust loan earns ~0", async () => {
            await reputation.authorizePool(owner.address);
            // Full-size (>= reference): +10.
            await reputation.recordLoanCompletion(agent.address, USDC(100), true);
            expect(await reputation["getReputationScore(address)"](agent.address)).to.equal(10n);
            // Dust loan (1e-6 USDC): (10 * 1) / 100e6 == 0 → no change.
            await reputation.recordLoanCompletion(agent.address, USDC("0.000001"), true);
            expect(await reputation["getReputationScore(address)"](agent.address)).to.equal(10n);
        });

        it("a 10 USDC loan earns proportional +1 (10 * 10/100)", async () => {
            await reputation.authorizePool(owner.address);
            await reputation.recordLoanCompletion(agent.address, USDC(10), true);
            expect(await reputation["getReputationScore(address)"](agent.address)).to.equal(1n);
        });

        it("setBonusReferenceAmount is owner-only and rejects 0", async () => {
            await expect(reputation.connect(agent).setBonusReferenceAmount(USDC(50))).to.be.reverted;
            await expect(reputation.setBonusReferenceAmount(0)).to.be.revertedWith("Reference must be > 0");
            await reputation.setBonusReferenceAmount(USDC(50));
            expect(await reputation.bonusReferenceAmount()).to.equal(USDC(50));
        });
    });

    describe("interest>0 reward gate (marketplace)", () => {
        it("a real interest-bearing loan earns reputation via the marketplace", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(5000));
            // 200 USDC / 30d at the base tier accrues non-zero interest.
            await v6.connect(agent).requestLoan(USDC(200), 30);
            const before = await reputation["getReputationScore(address)"](agent.address);
            await v6.connect(agent).repayLoan(1);
            expect(await reputation["getReputationScore(address)"](agent.address)).to.be.gt(before);
        });

        it("a zero-interest dust loan earns NO reputation through the marketplace", async () => {
            await v6.connect(lender).supplyLiquidity(1, USDC(5000));
            // Fresh agent → 100% collateral. A 1e-6 USDC loan rounds interest to 0.
            const before = await reputation["getReputationScore(address)"](agent.address);
            const tx = await v6.connect(agent).requestLoan(USDC("0.000001"), 7);
            const r = await tx.wait();
            let loanId;
            for (const lg of r.logs) {
                try {
                    const p = v6.interface.parseLog(lg);
                    if (p && p.name === "LoanRequested") { loanId = p.args.loanId; break; }
                } catch {}
            }
            await v6.connect(agent).repayLoan(loanId);
            // No interest paid → no reputation gain (kills the free farm).
            expect(await reputation["getReputationScore(address)"](agent.address)).to.equal(before);
        });
    });

    describe("D1 residual — reputation-gain rate limit", () => {
        it("defaults off (unlimited)", async () => {
            expect(await reputation.maxReputationGainPerWindow()).to.equal(0n);
        });

        it("caps reputation gain per window, defeating the concurrency farm", async () => {
            await reputation.authorizePool(owner.address);
            // 20 points/day cap.
            await reputation.setReputationRateLimit(20, 24 * 60 * 60);
            // Simulate 10 concurrent full-size loans repaid in the same window:
            // without the cap that is +100; with the cap it is +20.
            for (let i = 0; i < 10; i++) {
                await reputation.recordLoanCompletion(agent.address, USDC(100), true);
            }
            expect(await reputation["getReputationScore(address)"](agent.address)).to.equal(20n);

            // Same window: further completions add nothing.
            await reputation.recordLoanCompletion(agent.address, USDC(100), true);
            expect(await reputation["getReputationScore(address)"](agent.address)).to.equal(20n);

            // Next window: budget resets, up to +20 more.
            await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
            await ethers.provider.send("evm_mine", []);
            await reputation.recordLoanCompletion(agent.address, USDC(100), true); // +10
            await reputation.recordLoanCompletion(agent.address, USDC(100), true); // +10 (fills the new window)
            await reputation.recordLoanCompletion(agent.address, USDC(100), true); // capped → +0
            expect(await reputation["getReputationScore(address)"](agent.address)).to.equal(40n);
        });

        it("setReputationRateLimit is owner-only and rejects zero window", async () => {
            await expect(reputation.connect(agent).setReputationRateLimit(20, 3600)).to.be.reverted;
            await expect(reputation.setReputationRateLimit(20, 0)).to.be.revertedWith("Window must be > 0");
        });
    });

});
