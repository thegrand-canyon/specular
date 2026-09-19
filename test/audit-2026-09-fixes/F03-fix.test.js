// Regression tests for the F-03 fix (V6.1): interest is charged on
// max(duration, elapsed) capped at duration + LATE_INTEREST_CAP (30 days); lateness
// is recorded on-chain (repayments/lateRepayCount/lateSecondsTotal) and emitted.

const { expect } = require("chai");
const { deployLaunchStack, USDC, DAY, expectConserved, interestSec } = require("./_helpers");

describe("F-03 fix — late repayment costs elapsed-time interest and is recorded", function () {
    this.timeout(180000);
    let f, borrower, lender, agentId;

    beforeEach(async () => {
        f = await deployLaunchStack();
        [, borrower, lender] = f.signers;
        await f.fund(borrower); await f.fund(lender);
        agentId = await f.onboardAgent(borrower);
        await f.v6.connect(lender).supplyLiquidity(agentId, USDC(10_000));
    });

    async function openLoan(days = 7) {
        const id = await f.v6.nextLoanId();
        await f.v6.connect(borrower).requestLoan(USDC(1000), days);
        return id;
    }

    it("LATE_INTEREST_CAP is 30 days", async () => {
        expect(await f.v6.LATE_INTEREST_CAP()).to.equal(BigInt(30 * DAY));
    });

    it("10 days late on a 7-day term: charged exactly 17 days; preview matches; event + counters recorded", async () => {
        const id = await openLoan(7);
        const start = (await f.v6.loans(id)).startTime;
        await f.time.increase(17 * DAY - 30); // land just short of the target, then pin the repay block exactly
        const nominal = f.interestFor(USDC(1000), 1500, 7);
        const expected = f.interestFor(USDC(1000), 1500, 17);
        // the view runs at the latest block (+ a few seconds of tx clock drift) — check it
        // is self-consistent and within the drift window, then pin the repay block exactly.
        const pv = await f.v6.previewRepayment(id);
        expect(pv.chargeableSeconds).to.be.gte(BigInt(17 * DAY - 30)).and.lt(BigInt(17 * DAY + 60));
        expect(pv.lateSeconds).to.equal(pv.chargeableSeconds - BigInt(7 * DAY));
        expect(pv.interest).to.equal(interestSec(USDC(1000), 1500, pv.chargeableSeconds));
        expect(pv.total).to.equal(USDC(1000) + pv.interest);

        await f.time.setNextBlockTimestamp(start + BigInt(17 * DAY));
        const b0 = await f.usdc.balanceOf(borrower.address);
        await expect(f.v6.connect(borrower).repayLoan(id))
            .to.emit(f.v6, "LoanRepaidLate").withArgs(id, agentId, BigInt(10 * DAY), expected - nominal);
        // paid P + I, got 1000 collateral back → net outflow is the interest
        expect(b0 - (await f.usdc.balanceOf(borrower.address))).to.equal(expected);

        const rec = await f.v6.repayments(id);
        expect(rec.interestPaid).to.equal(expected);
        expect(rec.lateSeconds).to.equal(BigInt(10 * DAY));
        expect(rec.repaidAt).to.be.gt(0n);
        expect(await f.v6.lateRepayCount(agentId)).to.equal(1n);
        expect(await f.v6.lateSecondsTotal(agentId)).to.equal(BigInt(10 * DAY));
        // the extra interest reaches the lender (99%) and fees (1%)
        const fee = (expected * 100n) / 10000n;
        expect((await f.v6.getLenderPosition(agentId, lender.address)).earnedInterest).to.equal(expected - fee);
        expect(await f.v6.accumulatedFees()).to.equal(fee);
        await expectConserved(f, agentId);
    });

    it("300 days late on a 7-day term: interest capped at 37 days (duration + 30d)", async () => {
        const id = await openLoan(7);
        const start = (await f.v6.loans(id)).startTime;
        await f.time.increase(307 * DAY - 30);
        const capped = f.interestFor(USDC(1000), 1500, 37);
        const pv = await f.v6.previewRepayment(id);
        expect(pv.interest).to.equal(capped);
        expect(pv.chargeableSeconds).to.equal(BigInt(37 * DAY));
        await f.time.setNextBlockTimestamp(start + BigInt(307 * DAY));
        await f.v6.connect(borrower).repayLoan(id);
        expect((await f.v6.repayments(id)).interestPaid).to.equal(capped);
        expect((await f.v6.repayments(id)).lateSeconds).to.equal(BigInt(300 * DAY));
    });

    it("on-time and early repayments are unchanged (nominal-duration interest, no late record)", async () => {
        const early = await openLoan(30);
        await f.time.increase(2 * DAY);
        const nominal30 = f.interestFor(USDC(1000), 1500, 30);
        expect((await f.v6.previewRepayment(early)).interest).to.equal(nominal30);
        await expect(f.v6.connect(borrower).repayLoan(early)).to.not.emit(f.v6, "LoanRepaidLate");
        expect((await f.v6.repayments(early)).lateSeconds).to.equal(0n);

        const exact = await openLoan(7);
        const loan = await f.v6.loans(exact);
        await f.time.setNextBlockTimestamp(loan.endTime); // block.timestamp == endTime → still on time
        await expect(f.v6.connect(borrower).repayLoan(exact)).to.not.emit(f.v6, "LoanRepaidLate");
        expect((await f.v6.repayments(exact)).interestPaid).to.equal(f.interestFor(USDC(1000), 1500, 7));
        expect(await f.v6.lateRepayCount(agentId)).to.equal(0n);
    });

    it("a late repayment earns no reputation bonus; an on-time one still does", async () => {
        const late = await openLoan(7);
        await f.time.increase(8 * DAY);
        const s0 = await f.reputation["getReputationScore(uint256)"](agentId);
        await f.v6.connect(borrower).repayLoan(late);
        expect(await f.reputation["getReputationScore(uint256)"](agentId)).to.equal(s0);
        const onTime = await openLoan(7);
        await f.time.increase(2 * DAY);
        await f.v6.connect(borrower).repayLoan(onTime);
        expect(await f.reputation["getReputationScore(uint256)"](agentId)).to.equal(s0 + 10n);
    });

    it("previewRepayment reverts for a non-active loan", async () => {
        const id = await openLoan(7);
        await f.time.increase(DAY);
        await f.v6.connect(borrower).repayLoan(id);
        await expect(f.v6.previewRepayment(id)).to.be.revertedWith("Loan not active");
    });
});
