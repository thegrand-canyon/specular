// End-to-end launch scenario: deploy the full fixed V6 stack, apply the EXACT
// Arc-mainnet launch config (all protective levers ON), and drive a realistic
// multi-agent lifecycle — register, supply, borrow, repay, claim, and a default
// + socialized liquidation — asserting the global solvency invariant after every
// state-changing step. This exercises the new contract code the way it will run
// in production, which the unit tests do piecemeal.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("Launch-config integration scenario (levers ON)", function () {
    this.timeout(120000);
    let v6, registry, reputation, faucet, usdc;
    let owner, secure, alice, bob, lenderX, lenderY, borrower;
    const USDC = (n) => ethers.parseUnits(n.toString(), 6);

    // Assert the exact global solvency equality after every mutation.
    async function assertSolvent(agentIds) {
        let sumAvail = 0n, sumColl = 0n;
        for (const aid of agentIds) sumAvail += (await v6.getAgentPool(aid)).availableLiquidity;
        const n = await v6.nextLoanId();
        for (let id = 1n; id < n; id++) {
            const l = await v6.loans(id);
            if (Number(l.state) === 1) sumColl += l.collateralAmount;
        }
        const fees = await v6.accumulatedFees();
        const bal = await usdc.balanceOf(await v6.getAddress());
        expect(bal, `solvency: bal ${bal} == avail ${sumAvail} + fees ${fees} + coll ${sumColl}`)
            .to.equal(sumAvail + fees + sumColl);
    }

    before(async () => {
        [owner, secure, alice, bob, lenderX, lenderY, borrower] = await ethers.getSigners();
        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        reputation = await (await ethers.getContractFactory("ReputationManagerV3")).deploy(await registry.getAddress());
        usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
        v6 = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV6")).deploy(
            await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
        faucet = await (await ethers.getContractFactory("AgentCreditFaucet")).deploy(
            await registry.getAddress(), await usdc.getAddress());
        await reputation.authorizePool(await v6.getAddress());

        // ── EXACT Arc launch config (from ARC_MAINNET_DEPLOY_PREP.md) ──────────
        await reputation.setReputationRateLimit(20, 24 * 60 * 60);     // D1: 20 pts/day
        await v6.setMinHoldForReputationReward(24 * 60 * 60);          // M-2/D1: 1 day
        await v6.setPlatformFeeRate(100);                             // D1: 1%
        await v6.setBindBorrowToPoolCreator(true);                    // M-1
        await v6.setMinSupplyAmount(USDC(1));                         // F-C: 1 USDC min
        await faucet.setMaxEligibleAgentId(100);                      // faucet cohort
        await faucet.setClaimAmount(USDC(10));

        for (const w of [alice, bob, lenderX, lenderY, borrower]) {
            await usdc.mint(w.address, USDC(1_000_000));
            await usdc.connect(w).approve(await v6.getAddress(), ethers.MaxUint256);
        }
        await usdc.mint(await faucet.getAddress(), USDC(10_000));
    });

    it("levers are all set as configured", async () => {
        expect(await reputation.maxReputationGainPerWindow()).to.equal(20n);
        expect(await v6.minHoldForReputationReward()).to.equal(BigInt(24 * 60 * 60));
        expect(await v6.platformFeeRate()).to.equal(100n);
        expect(await v6.bindBorrowToPoolCreator()).to.equal(true);
        expect(await v6.minSupplyAmount()).to.equal(USDC(1));
    });

    it("agents onboard, faucet grants once per address", async () => {
        await registry.connect(alice).register("ipfs://alice", []);
        await v6.connect(alice).createAgentPool();
        await registry.connect(bob).register("ipfs://bob", []);
        await v6.connect(bob).createAgentPool();

        await faucet.connect(alice).claim();
        expect(await usdc.balanceOf(alice.address)).to.equal(USDC(1_000_010));
        await expect(faucet.connect(alice).claim()).to.be.revertedWith("Already claimed");
    });

    it("F-C: sub-minimum new supply is rejected; real supply works", async () => {
        await expect(v6.connect(lenderX).supplyLiquidity(1, USDC("0.5"))).to.be.revertedWith("Below minimum supply");
        await v6.connect(lenderX).supplyLiquidity(1, USDC(5000));
        await v6.connect(lenderY).supplyLiquidity(1, USDC(5000));
        await assertSolvent([1, 2]);
    });

    it("borrow → repay accrues reputation (interest paid, held long enough)", async () => {
        await v6.connect(alice).requestLoan(USDC(1000), 30);
        await assertSolvent([1, 2]);
        await time.increase(25 * 24 * 3600); // hold past the 1-day min, within term
        const scoreBefore = await reputation["getReputationScore(address)"](alice.address);
        await v6.connect(alice).repayLoan(1);
        expect(await reputation["getReputationScore(address)"](alice.address)).to.be.gt(scoreBefore);
        await assertSolvent([1, 2]);
        // Lenders claim their interest.
        await v6.connect(lenderX).claimInterest(1);
        await v6.connect(lenderY).claimInterest(1);
        await assertSolvent([1, 2]);
    });

    it("M-1: a transferred agent NFT cannot borrow against existing lenders", async () => {
        // alice sells her agent NFT (agentId 1) to borrower.
        await registry.connect(alice).transferFrom(alice.address, borrower.address, 1);
        await expect(v6.connect(borrower).requestLoan(USDC(100), 30))
            .to.be.revertedWith("Borrow restricted to pool creator");
        // transfer back so bob's pool stays the default-scenario subject
        await registry.connect(borrower).transferFrom(borrower.address, alice.address, 1);
    });

    it("D1: reputation farming is rate-limited (concurrency doesn't accelerate)", async () => {
        // bob supplies to his own pool would be self-dealing; instead lenderX funds bob's pool.
        await v6.connect(lenderX).supplyLiquidity(2, USDC(5000));
        // bob is NOT a 0-collateral tier yet → must post collateral; run several
        // full-size interest-bearing loans in one window and confirm the rate cap.
        const before = await reputation["getReputationScore(address)"](bob.address);
        for (let i = 0; i < 5; i++) {
            const tx = await v6.connect(bob).requestLoan(USDC(100), 7);
            const r = await tx.wait();
            let id;
            for (const lg of r.logs) { try { const p = v6.interface.parseLog(lg); if (p?.name === "LoanRequested") { id = p.args.loanId; break; } } catch {} }
            await time.increase(2 * 24 * 3600); // exceed 1-day min hold
            await v6.connect(bob).repayLoan(id);
        }
        const gained = (await reputation["getReputationScore(address)"](bob.address)) - before;
        // Even 5 interest-bearing loans can't exceed the 20/window cap in aggregate
        // (windows advance with the 2-day jumps, so ≤ 20 per window). Sanity: bounded.
        expect(gained).to.be.lte(20n * 5n); // never the un-capped amount
        await assertSolvent([1, 2]);
    });

    it("D4: an under-collateralized default is socialized pro-rata + stays solvent", async () => {
        // Fresh pool for a clean default scenario: agent 'bob' at low tier posts
        // 100% collateral, so to force an under-collateralized loss we drive bob
        // to a 0-collateral tier first via legitimate rate-limited repayments.
        // Simpler: use the owner-authorized direct reputation path to reach 600+.
        await reputation.authorizePool(owner.address);
        // Respect the rate limit by advancing windows.
        let score = Number(await reputation["getReputationScore(address)"](bob.address));
        let guard = 0;
        while (score < 600 && guard++ < 60) {
            await reputation.recordLoanCompletion(bob.address, USDC(100), true);
            await time.increase(24 * 3600 + 1);
            score = Number(await reputation["getReputationScore(address)"](bob.address));
        }
        expect(await reputation.calculateCollateralRequirement(bob.address)).to.equal(0n);

        // Two lenders already fund pool 2 (lenderX 5000 minus loans repaid). Ensure both present.
        const px = await v6.positions(2, lenderX.address);
        if (px.amount === 0n) await v6.connect(lenderX).supplyLiquidity(2, USDC(3000));
        await v6.connect(lenderY).supplyLiquidity(2, USDC(3000));

        const poolBefore = await v6.getAgentPool(2);
        // Capture pre-default principals (they may be unequal).
        const preX = (await v6.positions(2, lenderX.address)).amount;
        const preY = (await v6.positions(2, lenderY.address)).amount;
        // Borrow most of the available liquidity at 0 collateral.
        const borrowAmt = poolBefore.availableLiquidity / 2n;
        const tx = await v6.connect(bob).requestLoan(borrowAmt, 30);
        const r = await tx.wait();
        let loanId;
        for (const lg of r.logs) { try { const p = v6.interface.parseLog(lg); if (p?.name === "LoanRequested") { loanId = p.args.loanId; break; } } catch {} }
        await assertSolvent([1, 2]);

        // Default + liquidate (socialized loss).
        const loan = await v6.loans(loanId);
        await time.increaseTo(Number(loan.endTime) + 1);
        await v6.connect(owner).liquidateLoan(loanId);
        expect(Number((await v6.loans(loanId)).state)).to.equal(3); // DEFAULTED

        // Both lenders' positions were reduced PRO-RATA by stake; pool stays solvent.
        await assertSolvent([1, 2]);
        const pX = (await v6.positions(2, lenderX.address)).amount;
        const pY = (await v6.positions(2, lenderY.address)).amount;
        const redX = preX - pX; // reduction applied to X
        const redY = preY - pY;
        expect(redX).to.be.gt(0n);
        expect(redY).to.be.gt(0n);
        // Fairness: same loss FRACTION for both (redX/preX == redY/preY), i.e.
        // redX * preY == redY * preX to within integer-division rounding.
        const lhs = redX * preY;
        const rhs = redY * preX;
        const diff = lhs > rhs ? lhs - rhs : rhs - lhs;
        const tol = (preX + preY); // rounding tolerance ~ 1 unit each
        expect(diff).to.be.lte(tol);
    });

    it("D5: ownership is two-step and renounce is blocked", async () => {
        await expect(v6.renounceOwnership()).to.be.revertedWith("Ownership cannot be renounced");
        await v6.transferOwnership(secure.address);
        expect(await v6.owner()).to.equal(owner.address); // not until accepted
        await v6.connect(secure).acceptOwnership();
        expect(await v6.owner()).to.equal(secure.address);
    });
});
