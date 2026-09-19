// F-02 [MEDIUM] — Any top-up resets depositTimestamp and forfeits the ENTIRE
// position's interest on every in-flight loan (up to 10 concurrent, up to 365 days).
// The forfeited interest goes to (a) other qualified lenders — including the
// BORROWER if it self-lent the 1 USDC minimum at pool creation, making its own
// loan effectively fee-only — or (b) protocol fees if nobody else qualifies
// (the mainnet smoke-test observation).
//
// Third-party forcing: NOT possible on-chain (only msg.sender can touch its own
// position; owner seedPosition is gated by migration — but see F-08). The trap is
// a normal user action ("add liquidity") with no on-chain warning, and the loss is
// unbounded relative to the top-up (a 1-base-unit top-up forfeits a year of
// interest on a 10k position).
//
// CONVENTION: primary tests assert the SECURE property -> FAILING = CONFIRMED.

const { expect } = require("chai");
const { deployLaunchStack, USDC, DAY } = require("./_fixture");

describe("F-02 [MEDIUM] lender top-up forfeits in-flight interest", function () {
    this.timeout(120000);

    describe("variant A — borrower self-lends 1 USDC and captures a topping-up lender's interest", () => {
        let f, borrower, lender, agentId, loanId, lenderInterest;
        before(async () => {
            f = await deployLaunchStack();
            [, borrower, lender] = f.signers;
            await f.fund(borrower); await f.fund(lender);
            agentId = await f.onboardAgent(borrower);
            await f.v6.connect(borrower).supplyLiquidity(agentId, USDC(1));      // min slot, permanently "qualified"
            await f.v6.connect(lender).supplyLiquidity(agentId, USDC(10_000));
            loanId = await f.v6.nextLoanId();
            await f.v6.connect(borrower).requestLoan(USDC(1000), 365);          // 15% APR, 1y -> 150 USDC interest
            const interest = f.interestFor(USDC(1000), 1500, 365);
            lenderInterest = interest - (interest * 100n) / 10000n;
            await f.time.increase(DAY);
            await f.v6.connect(lender).supplyLiquidity(agentId, USDC(1));        // innocent 1 USDC top-up
            await f.time.increase(365 * DAY);
            await f.v6.connect(borrower).repayLoan(loanId);
        });

        it("SECURE PROPERTY: a lender who tops up still earns interest on its pre-existing 10,000 USDC", async () => {
            const pos = await f.v6.getLenderPosition(agentId, lender.address);
            // fair share would be ~ 10000/10001 of lenderInterest; anything > 0 passes this check
            expect(pos.earnedInterest).to.be.gt(0n);
        });

        it("[demonstration, passes — flipped by the V6.1 fix] shares are exact: lender 10,000/10,001, borrower 1/10,001, the 1-USDC top-up is a pending tranche", async () => {
            // Pre-fix: the borrower (lone qualified lender) received 100% of the interest it
            // paid. Post-fix: the lender's original 10,000 stays qualified; only its 1-USDC
            // top-up is unqualified (pending). NB: the repay is ~1 day late (1 + 365 days on
            // a 365-day term) so interest is charged on the elapsed time (F-03) — use the record.
            const rec = await f.v6.repayments(loanId);
            const interest = rec.interestPaid;
            const elapsed = rec.repaidAt - (await f.v6.loans(loanId)).startTime;
            expect(interest).to.equal((((USDC(1000) * 1500n) / 10000n) * elapsed) / BigInt(365 * DAY));
            expect(interest).to.be.gt(f.interestFor(USDC(1000), 1500, 365));
            const fee = (interest * 100n) / 10000n;
            const li = interest - fee;
            const qualifiedTotal = USDC(10_000) + USDC(1);
            const lenderShare = (li * USDC(10_000)) / qualifiedTotal;
            const borrowerShare = (li * USDC(1)) / qualifiedTotal;
            expect((await f.v6.getLenderPosition(agentId, lender.address)).earnedInterest).to.equal(lenderShare);
            expect((await f.v6.getLenderPosition(agentId, borrower.address)).earnedInterest).to.equal(borrowerShare);
            expect((await f.v6.pendingTranche(agentId, lender.address)).amount).to.equal(USDC(1));
            // fees = platform fee + floor-division dust only
            expect(await f.v6.accumulatedFees()).to.equal(fee + (li - lenderShare - borrowerShare));
            expect(lenderInterest).to.be.lt(li); // sanity: the audit's nominal figure was for 365 days
            const { bal, rhs } = await f.solvent([agentId]);
            expect(bal).to.equal(rhs);
        });
    });

    describe("variant B — sole lender tops up; interest goes to protocol fees (mainnet smoke-test observation)", () => {
        let f, borrower, lender, agentId, loanId;
        before(async () => {
            f = await deployLaunchStack();
            [, borrower, lender] = f.signers;
            await f.fund(borrower); await f.fund(lender);
            agentId = await f.onboardAgent(borrower);
            await f.v6.connect(lender).supplyLiquidity(agentId, USDC(10_000));
            loanId = await f.v6.nextLoanId();
            await f.v6.connect(borrower).requestLoan(USDC(1000), 30);
            await f.time.increase(DAY);
            await f.v6.connect(lender).supplyLiquidity(agentId, 1n);               // ONE base unit top-up
            await f.time.increase(30 * DAY);
            await f.v6.connect(borrower).repayLoan(loanId);
        });

        it("SECURE PROPERTY: a 1-base-unit top-up does not forfeit the whole position's interest", async () => {
            const pos = await f.v6.getLenderPosition(agentId, lender.address);
            expect(pos.earnedInterest).to.be.gt(0n);
        });

        it("[demonstration, passes — flipped by the V6.1 fix] only the 1% platform fee is booked as fees; the lender keeps the rest; solvency intact", async () => {
            // Pre-fix: 100% of the loan's interest went to protocol fees (the mainnet
            // smoke-test observation). The repay here is ~1 day late (31 days on a 30-day
            // term) so interest is charged on the elapsed time (F-03).
            const rec = await f.v6.repayments(loanId);
            const interest = rec.interestPaid;
            const elapsed = rec.repaidAt - (await f.v6.loans(loanId)).startTime;
            expect(interest).to.equal((((USDC(1000) * 1500n) / 10000n) * elapsed) / BigInt(365 * DAY));
            expect(interest).to.be.gt(f.interestFor(USDC(1000), 1500, 30));
            const fee = (interest * 100n) / 10000n;
            expect(await f.v6.accumulatedFees()).to.equal(fee);
            expect((await f.v6.getLenderPosition(agentId, lender.address)).earnedInterest).to.equal(interest - fee);
            expect((await f.v6.pendingTranche(agentId, lender.address)).amount).to.equal(1n);
            const { bal, rhs } = await f.solvent([agentId]);
            expect(bal).to.equal(rhs);
        });
    });

    describe("variant C — partial withdraw does NOT reset the timestamp (asymmetry)", () => {
        it("[demonstration, passes] a lender may shrink a position mid-loan and stay qualified, but may not grow it", async () => {
            const f = await deployLaunchStack();
            const [, borrower, lender] = f.signers;
            await f.fund(borrower); await f.fund(lender);
            const agentId = await f.onboardAgent(borrower);
            await f.v6.connect(lender).supplyLiquidity(agentId, USDC(10_000));
            const loanId = await f.v6.nextLoanId();
            await f.v6.connect(borrower).requestLoan(USDC(1000), 7);
            const tsBefore = (await f.v6.getLenderPosition(agentId, lender.address)).depositTimestamp;
            await f.v6.connect(lender).withdrawLiquidity(agentId, USDC(5_000));
            expect((await f.v6.getLenderPosition(agentId, lender.address)).depositTimestamp).to.equal(tsBefore);
            await f.time.increase(7 * DAY);
            await f.v6.connect(borrower).repayLoan(loanId);
            expect((await f.v6.getLenderPosition(agentId, lender.address)).earnedInterest).to.be.gt(0n);
        });
    });
});
