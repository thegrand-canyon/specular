// SECURITY TEST — replay the historical/audited exploits against the FIXED code
// and confirm each now FAILS to break anything. §B1, §S1, §S5, H-1, A1, F1/F-G.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("SECURITY: historical-bug non-recurrence", function () {
    let v6, registry, reputation, usdc, owner, agent, l1, l2, l3;
    const USDC = (n) => ethers.parseUnits(String(n), 6);

    beforeEach(async () => {
        [owner, agent, l1, l2, l3] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        reputation = await (await ethers.getContractFactory("ReputationManagerV3")).deploy(await registry.getAddress());
        usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
        v6 = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV6")).deploy(
            await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
        await reputation.authorizePool(await v6.getAddress());
        await registry.connect(agent).register("ipfs://a", []);
        await v6.connect(agent).createAgentPool();
        for (const w of [agent, l1, l2, l3]) { await usdc.mint(w.address, USDC(1_000_000)); await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256); }
    });
    async function pump(addr, score) { await reputation.authorizePool(owner.address); for (let i = 0; i < Math.ceil(score / 10) + 1; i++) await reputation.recordLoanCompletion(addr, USDC(100), true); }
    async function borrow(amount, dur = 30) {
        const r = await (await v6.connect(agent).requestLoan(amount, dur)).wait();
        for (const lg of r.logs) { try { const p = v6.interface.parseLog(lg); if (p?.name === "LoanRequested") return p.args.loanId; } catch {} }
    }
    async function solvent() {
        const p = await v6.getAgentPool(1);
        return (await usdc.balanceOf(await v6.getAddress())) >= p.availableLiquidity + (await v6.accumulatedFees());
    }

    it("§B1 — supply→withdraw→supply never duplicates a lender or double-counts interest", async () => {
        await pump(agent.address, 600);
        for (let i = 0; i < 10; i++) {
            await v6.connect(l1).supplyLiquidity(1, USDC(100));
            await v6.connect(l1).withdrawLiquidity(1, USDC(100));
        }
        await v6.connect(l1).supplyLiquidity(1, USDC(1000));
        const pool = await v6.getAgentPool(1);
        expect(pool.lenderCount).to.equal(1n); // exactly one entry, no duplicates
        // interest distributes without Panic
        const id = await borrow(USDC(100));
        await expect(v6.connect(agent).repayLoan(id)).to.not.be.reverted;
        expect(await solvent()).to.equal(true);
    });

    it("§S1 — claimInterest cannot create phantom liquidity", async () => {
        await v6.connect(l1).supplyLiquidity(1, USDC(1000));
        const id = await borrow(USDC(100));
        await v6.connect(agent).repayLoan(id);
        const availBefore = (await v6.getAgentPool(1)).availableLiquidity;
        const earned = (await v6.positions(1, l1.address)).earnedInterest;
        await v6.connect(l1).claimInterest(1);
        const availAfter = (await v6.getAgentPool(1)).availableLiquidity;
        expect(availBefore - availAfter).to.equal(earned); // decremented exactly by claimed
        expect(await solvent()).to.equal(true);
    });

    it("§S5 — activeLoanCount stays O(1)-accurate over many loans", async () => {
        await pump(agent.address, 600);
        await v6.connect(l1).supplyLiquidity(1, USDC(10000));
        for (let i = 0; i < 20; i++) { const id = await borrow(USDC(5), 7); await v6.connect(agent).repayLoan(id); }
        expect(await v6.activeLoanCount(1)).to.equal(0n);
        const id = await borrow(USDC(5), 7);
        expect(await v6.activeLoanCount(1)).to.equal(1n);
        await v6.connect(agent).repayLoan(id);
        expect(await v6.activeLoanCount(1)).to.equal(0n);
    });

    it("H-1 — interest routed to fees never double-counts (dust + no-qualified-lender)", async () => {
        // 3 pre-loan lenders (dust remainder on distribution) + rounding.
        await v6.connect(l1).supplyLiquidity(1, USDC(731));
        await v6.connect(l2).supplyLiquidity(1, USDC(519));
        await v6.connect(l3).supplyLiquidity(1, USDC(457));
        for (let i = 0; i < 8; i++) { const id = await borrow(USDC(997), 30); await v6.connect(agent).repayLoan(id); expect(await solvent()).to.equal(true); }
        const fees = await v6.accumulatedFees();
        if (fees > 0n) await v6.withdrawFees(fees);
        expect(await solvent()).to.equal(true);
    });

    it("A1 — lossy liquidation after interest-withdrawn-as-principal does NOT brick (no underflow)", async () => {
        await pump(agent.address, 600); // 0% collateral
        await v6.connect(l1).supplyLiquidity(1, USDC(2000));
        const id1 = await borrow(USDC(1000), 365);
        const id2 = await borrow(USDC(1000), 365);
        await v6.connect(agent).repayLoan(id1); // interest → availableLiquidity
        const pool = await v6.getAgentPool(1);
        await v6.connect(l1).withdrawLiquidity(1, pool.availableLiquidity - USDC(1)); // withdraw interest as principal → totalLiquidity drift
        const loan2 = await v6.loans(id2);
        await time.increaseTo(Number(loan2.endTime) + 1);
        // Pre-fix this underflow-reverted (Panic 0x11), bricking liquidation.
        await expect(v6.connect(owner).liquidateLoan(id2)).to.not.be.reverted;
        expect(Number((await v6.loans(id2)).state)).to.equal(3); // DEFAULTED — penalty applied
        expect(await solvent()).to.equal(true);
    });

    it("F1/F-G — a defaulter cannot re-initialize reputation to erase the penalty", async () => {
        await reputation.connect(agent)["initializeReputation(uint256)"](1);
        await reputation.authorizePool(owner.address);
        await reputation.recordDefault(agent.address, USDC(100000)); // → score 0
        expect(await reputation["getReputationScore(address)"](agent.address)).to.equal(0n);
        await expect(reputation.connect(agent)["initializeReputation(uint256)"](1)).to.be.revertedWith("Already initialized");
    });
});
