// R-00 — Hypotheses tested and REFUTED (these all PASS, i.e. the contracts hold).
// Kept so the next auditor does not re-derive them.

const { expect } = require("chai");
const { deployLaunchStack, USDC, DAY } = require("./_fixture");

describe("R-00 refuted hypotheses (all pass)", function () {
    this.timeout(300000);

    it("R-1 [D2] NFT transfer does NOT reset aggregate credit (agentId-keyed) even with M-1 OFF", async () => {
        const f = await deployLaunchStack();
        const [, a, lender, b] = f.signers;
        await f.fund(a); await f.fund(lender); await f.fund(b);
        await f.v6.setBindBorrowToPoolCreator(false);
        const id = await f.onboardAgent(a);
        await f.v6.connect(lender).supplyLiquidity(id, USDC(5000));
        await f.v6.connect(a).requestLoan(USDC(1000), 7); // limit at score 100 = 1000
        await f.registry.connect(a).transferFrom(a.address, b.address, id);
        await expect(f.v6.connect(b).requestLoan(USDC(1), 7)).to.be.revertedWith("Exceeds credit limit");
    });

    it("R-2 [D1 rate limit] 10 concurrent 100-USDC loans repaid in one day still yield only +20", async () => {
        const f = await deployLaunchStack();
        const [, a] = f.signers;
        await f.fund(a, USDC(3000));
        const id = await f.onboardAgent(a);
        await f.v6.connect(a).supplyLiquidity(id, USDC(1000));
        const first = await f.v6.nextLoanId();
        for (let i = 0; i < 10; i++) await f.v6.connect(a).requestLoan(USDC(100), 7);
        await f.time.increase(DAY);
        for (let i = 0; i < 10; i++) await f.v6.connect(a).repayLoan(first + BigInt(i));
        expect(await f.reputation["getReputationScore(uint256)"](id)).to.equal(120n);
    });

    it("R-3 [§B1/H-2] supply→withdraw→supply never duplicates a lender; slot is reclaimed", async () => {
        const f = await deployLaunchStack();
        const [, a, l] = f.signers;
        await f.fund(a); await f.fund(l);
        const id = await f.onboardAgent(a);
        for (let i = 0; i < 3; i++) {
            await f.v6.connect(l).supplyLiquidity(id, USDC(10));
            await f.v6.connect(l).withdrawLiquidity(id, USDC(10));
            expect((await f.v6.getAgentPool(id)).lenderCount).to.equal(0n);
        }
        await f.v6.connect(l).supplyLiquidity(id, USDC(10));
        expect((await f.v6.getAgentPool(id)).lenderCount).to.equal(1n);
    });

    it("R-4 [M-3] faucet register→claim→transfer→re-register loop is blocked", async () => {
        const f = await deployLaunchStack();
        const [, a, park] = f.signers;
        await f.usdc.mint(await f.faucet.getAddress(), USDC(100));
        await f.registry.connect(a).register("ipfs://a", []);
        await f.faucet.connect(a).claim();
        await f.registry.connect(a).transferFrom(a.address, park.address, 1);
        await f.registry.connect(a).register("ipfs://a2", []);
        await expect(f.faucet.connect(a).claim()).to.be.revertedWith("Address already claimed");
    });

    it("R-5 [H-3] aggregate outstanding principal is enforced across concurrent loans", async () => {
        const f = await deployLaunchStack();
        const [, a, l] = f.signers;
        await f.fund(a); await f.fund(l);
        const id = await f.onboardAgent(a);
        await f.v6.connect(l).supplyLiquidity(id, USDC(5000));
        await f.v6.connect(a).requestLoan(USDC(600), 7);
        await expect(f.v6.connect(a).requestLoan(USDC(500), 7)).to.be.revertedWith("Exceeds credit limit");
    });

    it("R-6 [D1 interest gate] a dust loan (interest rounds to 0) earns no reputation", async () => {
        const f = await deployLaunchStack({ minHold: 0 });
        const [, a] = f.signers;
        await f.fund(a);
        const id = await f.onboardAgent(a);
        await f.v6.connect(a).supplyLiquidity(id, USDC(1));
        const lid = await f.v6.nextLoanId();
        await f.v6.connect(a).requestLoan(300n, 7); // < 348 base-unit threshold at 15%/7d
        await f.v6.connect(a).repayLoan(lid);
        expect(await f.reputation["getReputationScore(uint256)"](id)).to.equal(100n);
    });

    it("R-7 [M-1] a transferred agent NFT cannot borrow from the original pool, and the buyer cannot create a second pool", async () => {
        const f = await deployLaunchStack();
        const [, a, l, b] = f.signers;
        await f.fund(a); await f.fund(l); await f.fund(b);
        const id = await f.onboardAgent(a);
        await f.v6.connect(l).supplyLiquidity(id, USDC(5000));
        await f.registry.connect(a).transferFrom(a.address, b.address, id);
        await expect(f.v6.connect(b).requestLoan(USDC(100), 7)).to.be.revertedWith("Borrow restricted to pool creator");
        await expect(f.v6.connect(b).createAgentPool()).to.be.revertedWith("Pool already exists");
        await expect(f.v6.connect(a).requestLoan(USDC(100), 7)).to.be.revertedWith("Not a registered agent");
    });

    it("R-8 [H-1/§S1] fee-routed interest (no qualified lender) keeps exact solvency", async () => {
        // [updated with the F-02 fix, 2026-09] A 1-base-unit top-up no longer
        // disqualifies the sole lender, so the no-qualified-lender branch is reached
        // the only way it still can be: a loan funded from UNCLAIMED INTEREST after
        // every lender has withdrawn all principal (Σ position.amount == 0).
        const f = await deployLaunchStack();
        const [, a, l] = f.signers;
        await f.fund(a); await f.fund(l);
        const id = await f.onboardAgent(a);
        await f.v6.connect(l).supplyLiquidity(id, USDC(1000));
        const lid = await f.v6.nextLoanId();
        await f.v6.connect(a).requestLoan(USDC(500), 7);
        await f.time.increase(7 * DAY);
        await f.v6.connect(a).repayLoan(lid);
        const earned = (await f.v6.getLenderPosition(id, l.address)).earnedInterest;
        expect(earned).to.be.gt(0n);
        await f.v6.connect(l).withdrawLiquidity(id, USDC(1000));            // principal out; interest stays lendable
        expect((await f.v6.getAgentPool(id)).availableLiquidity).to.equal(earned);
        const lid2 = await f.v6.nextLoanId();
        await f.v6.connect(a).requestLoan(earned, 7);                       // funded purely from unclaimed interest
        await f.time.increase(7 * DAY);
        const feesBefore = await f.v6.accumulatedFees();
        await f.v6.connect(a).repayLoan(lid2);                              // no qualified lender → interest to fees
        const paid = (await f.v6.repayments(lid2)).interestPaid;
        expect((await f.v6.accumulatedFees()) - feesBefore).to.equal(paid); // 100% of it, fee + routed remainder
        expect((await f.v6.getLenderPosition(id, l.address)).earnedInterest).to.equal(earned); // untouched
        await f.v6.withdrawFees(await f.v6.accumulatedFees());
        await f.v6.connect(l).claimInterest(id);
        const { bal, rhs } = await f.solvent([id]);
        expect(bal).to.equal(rhs);
        expect(bal).to.equal(0n);
    });

    it("R-9 [native USDC] no payable entrypoints — msg.value to any marketplace function reverts", async () => {
        const f = await deployLaunchStack();
        const [, a] = f.signers;
        await f.fund(a);
        const id = await f.onboardAgent(a);
        const data = f.v6.interface.encodeFunctionData("supplyLiquidity", [id, USDC(1)]);
        await expect(a.sendTransaction({ to: await f.v6.getAddress(), data, value: 1n })).to.be.reverted;
        await expect(a.sendTransaction({ to: await f.v6.getAddress(), value: 1n })).to.be.reverted;
    });
});
