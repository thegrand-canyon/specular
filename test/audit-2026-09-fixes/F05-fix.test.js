// Regression tests for the F-05 fix (V6.1): a default loss larger than Σ principal
// is socialized across unclaimed earnedInterest (exact, no dust), so booked interest
// is always backed and claim ordering never matters.

const { expect } = require("chai");
const { deployLaunchStack, USDC, DAY, pumpScore, poolState, expectConserved } = require("./_helpers");

describe("F-05 fix — loss beyond principal is socialized across earnedInterest", function () {
    this.timeout(300000);

    describe("loan funded purely from unclaimed interest (the audit PoC)", () => {
        let f, borrower, lender, agentId, lEarned0, bEarned0, idle, loss;
        before(async () => {
            f = await deployLaunchStack({ rateLimit: 0, minHold: 0 });
            [, borrower, lender] = f.signers;
            await f.fund(borrower); await f.fund(lender);
            agentId = await f.onboardAgent(borrower);
            await pumpScore(f, borrower, 500); // 25% collateral tier
            await f.v6.connect(borrower).supplyLiquidity(agentId, USDC(100));
            await f.v6.connect(lender).supplyLiquidity(agentId, USDC(1000));
            const id = await f.v6.nextLoanId();
            await f.v6.connect(borrower).requestLoan(USDC(1000), 7);
            await f.v6.connect(borrower).repayLoan(id);
            lEarned0 = (await f.v6.getLenderPosition(agentId, lender.address)).earnedInterest;
            bEarned0 = (await f.v6.getLenderPosition(agentId, borrower.address)).earnedInterest;
            await f.v6.connect(lender).withdrawLiquidity(agentId, USDC(1000));
            await f.v6.connect(borrower).withdrawLiquidity(agentId, USDC(100));
            idle = (await f.v6.getAgentPool(agentId)).availableLiquidity;
            expect(idle).to.equal(lEarned0 + bEarned0);
            const id2 = await f.v6.nextLoanId();
            await f.v6.connect(borrower).requestLoan(idle, 7);
            const coll = (await f.v6.loans(id2)).collateralAmount;
            expect(coll).to.equal((idle * 25n) / 100n);
            loss = idle - coll;
            await f.time.increase(8 * DAY);
            await expect(f.v6.liquidateLoan(id2)).to.emit(f.v6, "InterestLossSocialized").withArgs(agentId, loss);
        });

        it("earnedInterest reduced pro-rata and exactly (remainder assigned, no dust); Σ earned == availableLiquidity", async () => {
            const total = lEarned0 + bEarned0;
            const lShare = (loss * lEarned0) / total;
            const bShare = (loss * bEarned0) / total;
            const remainder = loss - lShare - bShare; // < 2 base units, assigned to the first lender(s)
            const lNow = (await f.v6.getLenderPosition(agentId, lender.address)).earnedInterest;
            const bNow = (await f.v6.getLenderPosition(agentId, borrower.address)).earnedInterest;
            expect(lNow + bNow).to.equal(total - loss);
            expect(lNow).to.be.gte(lEarned0 - lShare - remainder);
            expect(lNow).to.be.lte(lEarned0 - lShare);
            expect(bNow).to.be.gte(bEarned0 - bShare - remainder);
            expect(bNow).to.be.lte(bEarned0 - bShare);
            const { pool } = await poolState(f, agentId);
            expect(pool.availableLiquidity).to.equal(lNow + bNow);
            expect(pool.totalLiquidity).to.equal(0n);
            await expectConserved(f, agentId);
        });

        it("claims succeed in any order; the last claimant does not revert; pool drains to exactly zero", async () => {
            await expect(f.v6.connect(lender).claimInterest(agentId)).to.not.be.reverted;   // honest lender LAST-ish
            await expect(f.v6.connect(borrower).claimInterest(agentId)).to.not.be.reverted;
            expect((await f.v6.getAgentPool(agentId)).availableLiquidity).to.equal(0n);
            expect((await f.v6.getAgentPool(agentId)).lenderCount).to.equal(0n); // slots freed on claim
            await expectConserved(f, agentId);
        });
    });

    describe("mixed loss: principal absorbs part, interest absorbs the rest", () => {
        it("keeps the pool conserved and every claim backed", async () => {
            const f = await deployLaunchStack({ rateLimit: 0, minHold: 0 });
            const [, borrower, lender] = f.signers;
            await f.fund(borrower); await f.fund(lender);
            const agentId = await f.onboardAgent(borrower);
            await pumpScore(f, borrower, 500); // 25% collateral
            await f.v6.connect(borrower).supplyLiquidity(agentId, USDC(100));
            await f.v6.connect(lender).supplyLiquidity(agentId, USDC(1000));
            const id = await f.v6.nextLoanId();
            await f.v6.connect(borrower).requestLoan(USDC(1000), 7);
            await f.v6.connect(borrower).repayLoan(id);
            // leave 1 + 1 USDC of principal; at 25% collateral the loss is 75% of (P + E),
            // which exceeds P whenever E > P/3 — here E ≈ 1.9 USDC vs P = 2 USDC.
            await f.v6.connect(lender).withdrawLiquidity(agentId, USDC(999));
            await f.v6.connect(borrower).withdrawLiquidity(agentId, USDC(99));
            const P = USDC(2);
            const { sumEarned: earnedBefore } = await poolState(f, agentId);
            const avail = (await f.v6.getAgentPool(agentId)).availableLiquidity;
            expect(avail).to.equal(P + earnedBefore);
            const id2 = await f.v6.nextLoanId();
            await f.v6.connect(borrower).requestLoan(avail, 7);
            const loss = avail - (await f.v6.loans(id2)).collateralAmount;
            expect(loss).to.be.gt(P); // exceeds Σ principal
            await f.time.increase(8 * DAY);
            await expect(f.v6.liquidateLoan(id2)).to.emit(f.v6, "InterestLossSocialized").withArgs(agentId, loss - P);
            const { pool, sumAmount, sumEarned } = await poolState(f, agentId);
            expect(sumAmount).to.equal(0n);
            expect(sumEarned).to.equal(earnedBefore - (loss - P));
            expect(pool.availableLiquidity).to.equal(sumEarned);
            await expectConserved(f, agentId);
            await expect(f.v6.connect(borrower).claimInterest(agentId)).to.not.be.reverted;
            await expect(f.v6.connect(lender).claimInterest(agentId)).to.not.be.reverted;
            expect((await f.v6.getAgentPool(agentId)).availableLiquidity).to.equal(0n);
        });
    });

    describe("total wipe-out frees lender slots", () => {
        it("a lender left with 0 principal and 0 interest is pruned from poolLenders and can re-supply once", async () => {
            const f = await deployLaunchStack({ rateLimit: 0 });
            const [, borrower, lender] = f.signers;
            await f.fund(borrower); await f.fund(lender);
            const agentId = await f.onboardAgent(borrower);
            await pumpScore(f, borrower, 600); // 0% collateral
            await f.v6.connect(lender).supplyLiquidity(agentId, USDC(1000));
            const id = await f.v6.nextLoanId();
            await f.v6.connect(borrower).requestLoan(USDC(1000), 7);
            await f.time.increase(8 * DAY);
            await f.v6.liquidateLoan(id);
            expect((await f.v6.getLenderPosition(agentId, lender.address)).amount).to.equal(0n);
            expect((await f.v6.getAgentPool(agentId)).lenderCount).to.equal(0n);
            expect(await f.v6.isInPoolLenders(agentId, lender.address)).to.equal(false);
            await expectConserved(f, agentId);
            await f.v6.connect(lender).supplyLiquidity(agentId, USDC(10));
            expect((await f.v6.getAgentPool(agentId)).lenderCount).to.equal(1n);
        });
    });
});
