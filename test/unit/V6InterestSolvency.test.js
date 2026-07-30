// Regression test for audit finding H-1 (2026-07): interest routed to
// accumulatedFees (rounding dust, and the qualifiedTotal==0 fallback) was
// double-counted — line 362 adds the full lenderInterest to
// pool.availableLiquidity, but _distributeInterest then also adds the
// dust/whole-interest to accumulatedFees WITHOUT decrementing availableLiquidity.
// claimInterest decrements availableLiquidity (§S1) but withdrawFees does not,
// so the contract's USDC can no longer honor availableLiquidity + fees together
// — the exact §S1-class phantom-liquidity drift.
//
// Solvency invariant: the contract's USDC balance must always cover everything
// it owes on-demand: Σ pool.availableLiquidity + accumulatedFees + collateral held.

const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("V6 — interest/fee solvency (H-1)", function () {
    let v6, registry, reputation, usdc;
    let owner, agent, lenderA, lenderB, lenderC;
    const USDC = (n) => ethers.parseUnits(n.toString(), 6);

    beforeEach(async () => {
        [owner, agent, lenderA, lenderB, lenderC] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        reputation = await (await ethers.getContractFactory("ReputationManagerV3")).deploy(await registry.getAddress());
        usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
        v6 = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV6")).deploy(
            await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress()
        );
        await reputation.authorizePool(await v6.getAddress());
        await registry.connect(agent).register("ipfs://agent", []);
        await v6.connect(agent).createAgentPool();
        for (const w of [agent, lenderA, lenderB, lenderC]) {
            await usdc.mint(w.address, USDC(100_000));
            await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256);
        }
    });

    // Contract USDC must cover all on-demand claims against it.
    async function assertSolvent(agentId) {
        const bal = await usdc.balanceOf(await v6.getAddress());
        const pool = await v6.getAgentPool(agentId);
        const fees = await v6.accumulatedFees();
        // Collateral for any still-outstanding loans is also held in-contract;
        // in these scenarios all loans are repaid so collateral held is 0.
        const owed = pool.availableLiquidity + fees;
        expect(bal, `USDC balance ${bal} must cover availableLiquidity+fees ${owed}`).to.be.gte(owed);
    }

    it("stays solvent after a repay that produces rounding dust across lenders", async () => {
        // Three unequal, coprime-ish deposits so proportional interest shares
        // round with a nonzero remainder (dust) → the leak path.
        await v6.connect(lenderA).supplyLiquidity(1, USDC(731));
        await v6.connect(lenderB).supplyLiquidity(1, USDC(519));
        await v6.connect(lenderC).supplyLiquidity(1, USDC(457));

        // Fresh agent (score 0) → 100% collateral, 15% APR. Borrow, then repay.
        await v6.connect(agent).requestLoan(USDC(1000), 30);
        await v6.connect(agent).repayLoan(1);

        await assertSolvent(1);
    });

    it("stays solvent across many repay cycles (dust accumulates)", async () => {
        await v6.connect(lenderA).supplyLiquidity(1, USDC(731));
        await v6.connect(lenderB).supplyLiquidity(1, USDC(519));
        await v6.connect(lenderC).supplyLiquidity(1, USDC(457));

        for (let i = 0; i < 8; i++) {
            await v6.connect(agent).requestLoan(USDC(997), 30);
            const loanId = i + 1;
            await v6.connect(agent).repayLoan(loanId);
            await assertSolvent(1);
        }

        // Owner withdrawing all fees must not push the pool underwater.
        const fees = await v6.accumulatedFees();
        if (fees > 0n) await v6.withdrawFees(fees);
        await assertSolvent(1);
    });
});
