// Regression test for D4 (2026-08): socialized-loss ordering. Before, an
// under-collateralized default left individual positions untouched while
// availableLiquidity fell short, so first-come-first-served withdrawal let an
// alert/colluding lender exit whole and dump the entire shortfall on the last
// lender. Fix: liquidateLoan reduces every lender's position.amount PRO-RATA by
// the loss, so all lenders bear it in proportion regardless of withdrawal order.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("V6 — socialized loss on default (D4)", function () {
    let v6, registry, reputation, usdc, owner, agent, lenderA, lenderB;
    const USDC = (n) => ethers.parseUnits(n.toString(), 6);

    beforeEach(async () => {
        [owner, agent, lenderA, lenderB] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        reputation = await (await ethers.getContractFactory("ReputationManagerV3")).deploy(await registry.getAddress());
        usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
        v6 = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV6")).deploy(
            await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
        await reputation.authorizePool(await v6.getAddress());
        await registry.connect(agent).register("ipfs://agent", []);
        await v6.connect(agent).createAgentPool();
        for (const w of [agent, lenderA, lenderB]) {
            await usdc.mint(w.address, USDC(1_000_000));
            await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256);
        }
        // Pump agent to the 0%-collateral tier so a default is a full principal loss.
        await reputation.authorizePool(owner.address);
        for (let i = 0; i < 65; i++) {
            await reputation.recordLoanCompletion(agent.address, USDC(100), true);
        }
        expect(await reputation.calculateCollateralRequirement(agent.address)).to.equal(0n);
    });

    it("distributes the loss EXACTLY (no rounding dust) even with unequal, coprime stakes", async () => {
        // Coprime-ish unequal stakes force floor-division remainders; the fix
        // assigns the remainder so totalLiquidity == Σ position.amount stays exact.
        await v6.connect(lenderA).supplyLiquidity(1, USDC(733));
        await v6.connect(lenderB).supplyLiquidity(1, USDC(457));
        const r = await (await v6.connect(agent).requestLoan(USDC(1000), 30)).wait();
        let id; for (const lg of r.logs) { try { const p = v6.interface.parseLog(lg); if (p?.name === "LoanRequested") { id = p.args.loanId; break; } } catch {} }
        await time.increaseTo(Number((await v6.loans(id)).endTime) + 1);
        await v6.connect(owner).liquidateLoan(id);
        // After a full-loss (0-collateral) default of 1000 over principal 1190,
        // positions must sum to exactly 190 and equal totalLiquidity (no dust).
        const pA = (await v6.positions(1, lenderA.address)).amount;
        const pB = (await v6.positions(1, lenderB.address)).amount;
        const pool = await v6.getAgentPool(1);
        expect(pA + pB).to.equal(pool.totalLiquidity);
        expect(pA + pB).to.equal(USDC(1190) - USDC(1000)); // exactly 190 remains, no dust
    });

    it("splits an under-collateralized default pro-rata; last withdrawer is not dumped on", async () => {
        await v6.connect(lenderA).supplyLiquidity(1, USDC(100));
        await v6.connect(lenderB).supplyLiquidity(1, USDC(100));
        // Agent borrows 150 (0 collateral) → availableLiquidity 50, loaned 150.
        await v6.connect(agent).requestLoan(USDC(150), 30);

        // Default the loan.
        const loan = await v6.loans(1);
        await time.increaseTo(Number(loan.endTime) + 1);
        await v6.connect(owner).liquidateLoan(1);

        // Loss 150 split pro-rata (100/200 each) → each position reduced by 75 → 25 left.
        const posA = await v6.positions(1, lenderA.address);
        const posB = await v6.positions(1, lenderB.address);
        expect(posA.amount).to.equal(USDC(25));
        expect(posB.amount).to.equal(USDC(25));

        // availableLiquidity is 50; both lenders can withdraw their reduced 25 —
        // the SECOND withdrawer is NOT blocked (the old FCFS-dump bug).
        const balABefore = await usdc.balanceOf(lenderA.address);
        const balBBefore = await usdc.balanceOf(lenderB.address);
        await v6.connect(lenderA).withdrawLiquidity(1, USDC(25));
        await v6.connect(lenderB).withdrawLiquidity(1, USDC(25)); // must succeed
        expect(await usdc.balanceOf(lenderA.address) - balABefore).to.equal(USDC(25));
        expect(await usdc.balanceOf(lenderB.address) - balBBefore).to.equal(USDC(25));

        // Pool fully drained of principal, solvent throughout.
        const pool = await v6.getAgentPool(1);
        expect(pool.availableLiquidity).to.equal(0n);
        expect(await usdc.balanceOf(await v6.getAddress())).to.be.gte(pool.availableLiquidity);
    });

    it("bounds a front-runner to the idle-liquidity portion; remaining position is still socialized", async () => {
        // Honest scope: the pro-rata fix makes post-liquidation withdrawal fair,
        // but a lender can still withdraw IDLE liquidity before liquidation (a
        // normal feature — bounded by availableLiquidity). It does NOT let them
        // escape their share of the ALREADY-LENT principal.
        await v6.connect(lenderA).supplyLiquidity(1, USDC(100));
        await v6.connect(lenderB).supplyLiquidity(1, USDC(100));
        await v6.connect(agent).requestLoan(USDC(150), 30); // availableLiquidity now 50
        const loan = await v6.loans(1);
        await time.increaseTo(Number(loan.endTime) + 1);

        // A front-runs: withdraws the 50 idle liquidity (all that is withdrawable).
        await v6.connect(lenderA).withdrawLiquidity(1, USDC(50)); // A position 100 → 50
        // Liquidation socializes the 150 loss over the REMAINING principal (A:50, B:100).
        await v6.connect(owner).liquidateLoan(1);
        const posA = await v6.positions(1, lenderA.address);
        const posB = await v6.positions(1, lenderB.address);
        expect(posA.amount).to.equal(0n); // A's remaining 50 wiped (still bears its share)
        expect(posB.amount).to.equal(0n); // B's 100 wiped
        // Net: A escaped 50 of idle liquidity (bounded), NOT the whole shortfall.
        // Pre-fix, A could exit 100% and dump the ENTIRE loss on B.
    });
});
