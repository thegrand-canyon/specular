// F-03 [MEDIUM] — Late repayment carries NO cost: interest is fixed at the nominal
// duration (calculateInterest(amount, rate, loan.duration)) and a late repay calls
// recordLoanCompletion(onTime=false), which applies no penalty. The only deterrent
// is owner-initiated liquidateLoan(), which the borrower can front-run with repayLoan.
//
// Economic effect: once past endTime, every extra day of holding a 0%-collateral
// loan (score >= 600, up to 25k/50k USDC) is free credit. Combined with F-01 the
// borrower can even make liquidation impossible during that period.
//
// The prior THREAT_MODEL.md claimed "Default penalty is enforced via
// recordLoanCompletion(onTime=false)" — that claim is FALSE for V3 (no penalty branch).
//
// CONVENTION: primary test asserts the SECURE property -> FAILING = CONFIRMED.

const { expect } = require("chai");
const { deployLaunchStack, USDC, DAY } = require("./_fixture");

describe("F-03 [MEDIUM] late repayment has no interest or reputation cost", function () {
    this.timeout(120000);
    let f, borrower, lender, agentId, loanId, nominalInterest, scoreBefore;

    before(async () => {
        f = await deployLaunchStack();
        [, borrower, lender] = f.signers;
        await f.fund(borrower); await f.fund(lender);
        agentId = await f.onboardAgent(borrower);
        await f.v6.connect(lender).supplyLiquidity(agentId, USDC(10_000));
        loanId = await f.v6.nextLoanId();
        await f.v6.connect(borrower).requestLoan(USDC(1000), 7);
        nominalInterest = f.interestFor(USDC(1000), 1500, 7);
        scoreBefore = await f.reputation["getReputationScore(uint256)"](agentId);
        await f.time.increase(300 * DAY); // 293 days overdue; owner never liquidated
    });

    it("SECURE PROPERTY: a loan repaid 293 days late costs more than an on-time repayment (interest or reputation)", async () => {
        const balBefore = await f.usdc.balanceOf(borrower.address);
        await f.v6.connect(borrower).repayLoan(loanId);
        const paid = balBefore - (await f.usdc.balanceOf(borrower.address)) + USDC(1000); // + collateral returned
        const scoreAfter = await f.reputation["getReputationScore(uint256)"](agentId);
        const extraInterest = paid - USDC(1000) - nominalInterest;
        const penalised = scoreAfter < scoreBefore;
        expect(extraInterest > 0n || penalised,
            `paid ${paid} (nominal interest ${nominalInterest}), score ${scoreBefore} -> ${scoreAfter}`).to.equal(true);
    });

    it("[demonstration, passes] borrower can front-run a pending liquidation with repayLoan and keep a clean score", async () => {
        // fresh loan, make it overdue, then repay in the same block the owner would liquidate
        const id2 = await f.v6.nextLoanId();
        await f.v6.connect(borrower).requestLoan(USDC(1000), 7);
        await f.time.increase(60 * DAY);
        const s0 = await f.reputation["getReputationScore(uint256)"](agentId);
        await f.v6.connect(borrower).repayLoan(id2);
        await expect(f.v6.liquidateLoan(id2)).to.be.revertedWith("Loan not active");
        expect(await f.reputation["getReputationScore(uint256)"](agentId)).to.equal(s0);
        expect(await f.reputation.defaultCount(agentId)).to.equal(0n);
    });
});
