// F-05 [LOW] — D4 socialisation only scales position.amount; earnedInterest is never
// reduced. Unclaimed interest sits in availableLiquidity and is lendable, so a loan
// funded from (mostly) unclaimed interest that defaults leaves earnedInterest
// unbacked. _socializeLoss caps at totalPrincipal and silently drops the rest;
// claimInterest then becomes FCFS and the last claimant reverts "Drain underflow"
// — the exact D4 last-withdrawer dump, reintroduced on the interest side.
//
// Setup needs the 25%-collateral tier (score 500). The D1 levers are relaxed ONLY
// to reach that tier quickly; the finding does not depend on them.
//
// CONVENTION: primary test asserts the SECURE property -> FAILING = CONFIRMED.

const { expect } = require("chai");
const { deployLaunchStack, USDC, DAY } = require("./_fixture");

describe("F-05 [LOW] loss > principal strands unclaimed interest (FCFS on interest)", function () {
    this.timeout(300000);
    let f, borrower, lender, agentId, lenderInterest;

    before(async () => {
        f = await deployLaunchStack({ rateLimit: 0, minHold: 0 });
        [, borrower, lender] = f.signers;
        await f.fund(borrower); await f.fund(lender);
        agentId = await f.onboardAgent(borrower);
        await f.v6.connect(borrower).supplyLiquidity(agentId, USDC(100));
        // reach score 500 (25% collateral): 40 x (+10)
        for (let i = 0; i < 40; i++) {
            const id = await f.v6.nextLoanId();
            await f.v6.connect(borrower).requestLoan(USDC(100), 7);
            await f.v6.connect(borrower).repayLoan(id);
        }
        expect(await f.reputation.calculateCollateralRequirement(borrower.address)).to.equal(25n);
        await f.v6.connect(borrower).claimInterest(agentId);

        // real lender joins; one normal loan cycle books interest to both lenders
        await f.v6.connect(lender).supplyLiquidity(agentId, USDC(1000));
        const id = await f.v6.nextLoanId();
        await f.v6.connect(borrower).requestLoan(USDC(1000), 7);
        await f.v6.connect(borrower).repayLoan(id);
        lenderInterest = (await f.v6.getLenderPosition(agentId, lender.address)).earnedInterest;
        expect(lenderInterest).to.be.gt(0n);

        // both withdraw ALL principal (allowed: availableLiquidity covers it); only unclaimed interest remains
        await f.v6.connect(lender).withdrawLiquidity(agentId, USDC(1000));
        await f.v6.connect(borrower).withdrawLiquidity(agentId, USDC(100));
        const pool = await f.v6.getAgentPool(agentId);
        expect(pool.totalLiquidity).to.equal(0n);
        const idle = pool.availableLiquidity; // == Σ earnedInterest

        // borrower borrows the idle interest at 25% collateral and defaults
        const id2 = await f.v6.nextLoanId();
        await f.v6.connect(borrower).requestLoan(idle, 7);
        await f.time.increase(8 * DAY);
        await f.v6.liquidateLoan(id2); // _socializeLoss: totalPrincipal == 0 -> returns 0, loss dropped
    });

    it("[demonstration, passes — flipped by the V6.1 fix] the loss beyond principal is socialized across earnedInterest exactly; booked interest == availableLiquidity", async () => {
        // Pre-fix: the honest lender's earnedInterest stayed booked while the USDC was gone.
        // Post-fix: loss (75% of the borrowed idle interest) reduced both lenders'
        // earnedInterest pro-rata, so Σ earnedInterest is exactly backed.
        const lpos = await f.v6.getLenderPosition(agentId, lender.address);
        const bpos = await f.v6.getLenderPosition(agentId, borrower.address);
        expect(lpos.earnedInterest).to.be.lt(lenderInterest);
        expect(lpos.earnedInterest).to.be.gt(0n);
        const pool = await f.v6.getAgentPool(agentId);
        expect(lpos.earnedInterest + bpos.earnedInterest).to.equal(pool.availableLiquidity);
        expect(pool.totalLiquidity).to.equal(0n);
        const { bal, rhs } = await f.solvent([agentId]);
        expect(bal).to.equal(rhs);
    });

    it("SECURE PROPERTY: after liquidation every lender can still claim its booked earnedInterest", async () => {
        // the defaulting borrower (also a lender) claims first — pre-fix this was FCFS
        // and the second claim reverted "Drain underflow"
        await expect(f.v6.connect(borrower).claimInterest(agentId)).to.not.be.reverted;
        await expect(f.v6.connect(lender).claimInterest(agentId)).to.not.be.reverted;
        expect((await f.v6.getAgentPool(agentId)).availableLiquidity).to.equal(0n);
        const { bal, rhs } = await f.solvent([agentId]);
        expect(bal).to.equal(rhs);
    });
});
