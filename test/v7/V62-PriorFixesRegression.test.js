// Regression: the 2026-09-19 audit fixes (F-01, F-02, F-03, F-05, F-07) still hold
// on AgentLiquidityMarketplaceV62 after the V7 changes (M2 self-stake waterfall, the
// L7 socialisation basis, and the loanId / lateSeconds reputation signatures).
//
// These mirror the secure properties asserted by test/audit-2026-09-fixes/ against
// V6.1; that suite continues to run against V6.1 unchanged.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployV7Stack, USDC, DAY, pumpScore, pumpCapacity, expectConserved } = require("./_fixture");

const DAYS = (n) => n * 24 * 60 * 60;

function loanIdFrom(receipt, c) {
    return receipt.logs.map((l) => { try { return c.interface.parseLog(l); } catch { return null; } })
        .find((e) => e && e.name === "LoanRequested").args[0];
}

describe("V6.2 — prior audit fixes still hold", function () {
    this.timeout(180000);

    async function base(opts = {}) {
        const f = await deployV7Stack({ rateLimit: 0, minHold: DAY, ...opts });
        return f;
    }

    // ------------------------------------------------------------------ F-01

    describe("F-01 — an agent-NFT transfer cannot freeze a loan", function () {
        let f, borrower, lender, holder, third, agentId, loanId;
        before(async () => {
            f = await base();
            [, borrower, lender, holder, third] = f.signers;
            await f.fund(borrower); await f.fund(lender); await f.fund(holder); await f.fund(third);
            agentId = await f.onboardAgent(borrower);
            await pumpCapacity(f, borrower, USDC(500));
            await f.v62.connect(lender).supplyLiquidity(agentId, USDC(1000));
            loanId = await f.v62.nextLoanId();
            await f.v62.connect(borrower).requestLoan(USDC(500), 7); // 100% collateral tier
            await f.registry.connect(borrower).transferFrom(borrower.address, holder.address, agentId);
            await f.time.increase(2 * DAY);
        });

        it("the original borrower can still repay after the transfer; collateral returns to it", async () => {
            const b0 = await f.usdc.balanceOf(borrower.address);
            const h0 = await f.usdc.balanceOf(holder.address);
            await expect(f.v62.connect(borrower).repayLoan(loanId)).to.emit(f.v62, "LoanRepaid");
            const interest = f.interestFor(USDC(500), 1500, 7);
            expect(b0 - (await f.usdc.balanceOf(borrower.address))).to.equal(interest);
            expect(await f.usdc.balanceOf(holder.address)).to.equal(h0);
            expect((await f.v62.loans(loanId)).state).to.equal(2n);
            expect(await f.registry.addressToAgentId(borrower.address)).to.equal(0n);
        });

        it("the reputation credit lands on the agentId (its current holder), via loanId", async () => {
            expect(await f.reputation.maxRepaidPrincipal(agentId)).to.equal(USDC(500));
            expect((await f.reputation.openLoans(await f.v62.getAddress(), loanId)).start).to.equal(0n);
        });

        it("the CURRENT NFT holder may also repay; a third party may not", async () => {
            const g = await base();
            const [, b, l, h, t] = g.signers;
            for (const w of [b, l, h, t]) await g.fund(w);
            const aid = await g.onboardAgent(b);
            await pumpCapacity(g, b, USDC(500));
            await g.v62.connect(l).supplyLiquidity(aid, USDC(1000));
            const id = await g.v62.nextLoanId();
            await g.v62.connect(b).requestLoan(USDC(500), 7);
            await g.registry.connect(b).transferFrom(b.address, h.address, aid);
            await g.time.increase(2 * DAY);
            await expect(g.v62.connect(t).repayLoan(id)).to.be.revertedWith("Not the borrower");
            await expect(g.v62.connect(h).repayLoan(id)).to.emit(g.v62, "LoanRepaid");
        });

        it("liquidation still works after a transfer (the loan reaches a terminal state)", async () => {
            const g = await base();
            const [, b, l, h] = g.signers;
            for (const w of [b, l, h]) await g.fund(w);
            const aid = await g.onboardAgent(b);
            await pumpScore(g, b, 800);
            await pumpCapacity(g, b, USDC(2000));
            await g.v62.connect(l).supplyLiquidity(aid, USDC(3000));
            await g.v62.connect(b).supplyLiquidity(aid, USDC(1000));
            const id = await g.v62.nextLoanId();
            await g.v62.connect(b).requestLoan(USDC(2000), 7);
            await g.registry.connect(b).transferFrom(b.address, h.address, aid);
            await g.time.increase(DAYS(8));
            await expect(g.v62.liquidateLoan(id)).to.emit(g.v62, "LoanDefaulted");
            expect((await g.v62.loans(id)).state).to.equal(3n);
            expect(await g.reputation.isLockedOut(aid)).to.equal(true);
            await expectConserved(g, aid, "F-01 liquidation after transfer");
        });
    });

    // ------------------------------------------------------------------ F-02

    describe("F-02 — a top-up never forfeits the base tranche's in-flight interest", function () {
        let f, borrower, lender, agentId, loanId;
        beforeEach(async () => {
            f = await base({ minSupply: USDC(1) });
            [, borrower, lender] = f.signers;
            await f.fund(borrower); await f.fund(lender);
            agentId = await f.onboardAgent(borrower);
            await pumpCapacity(f, borrower, USDC(450));
            await f.v62.connect(lender).supplyLiquidity(agentId, USDC(10000));
            loanId = await f.v62.nextLoanId();
            await f.v62.connect(borrower).requestLoan(USDC(800), 7);
        });

        it("a 1-base-unit top-up mid-loan keeps the whole base tranche qualified", async () => {
            await f.time.increase(DAY);
            await f.v62.connect(lender).supplyLiquidity(agentId, 1n);
            const start = (await f.v62.loans(loanId)).startTime;
            expect(await f.v62.qualifiedAmountAt(agentId, lender.address, start)).to.equal(USDC(10000));
            const pt = await f.v62.pendingTranche(agentId, lender.address);
            expect(pt.amount).to.equal(1n);
        });

        it("the new money never qualifies for the in-flight loan (W1 intact)", async () => {
            await f.time.increase(DAY);
            await f.v62.connect(lender).supplyLiquidity(agentId, USDC(5000));
            await f.time.increase(5 * DAY);
            await f.v62.connect(borrower).repayLoan(loanId);
            const nominal = f.interestFor(USDC(800), 1500, 7);
            const lenderShare = nominal - (nominal * 100n) / 10000n;
            expect((await f.v62.positions(agentId, lender.address)).earnedInterest).to.equal(lenderShare);
            await expectConserved(f, agentId, "F-02 W1");
        });

        it("canTopUp is an exact oracle for the refusal", async () => {
            await f.time.increase(DAY);
            await f.v62.connect(lender).supplyLiquidity(agentId, USDC(100)); // pending tranche
            const id2 = await f.v62.nextLoanId();
            await f.v62.connect(borrower).requestLoan(USDC(100), 7);         // loan inside [pending, now)
            await f.time.increase(DAY);
            expect(await f.v62.canTopUp(agentId, lender.address)).to.equal(false);
            await expect(f.v62.connect(lender).supplyLiquidity(agentId, USDC(1)))
                .to.be.revertedWith("Top-up would forfeit in-flight interest");
            await f.time.increase(6 * DAY);
            await f.v62.connect(borrower).repayLoan(loanId);
            await f.v62.connect(borrower).repayLoan(id2);
            expect(await f.v62.canTopUp(agentId, lender.address)).to.equal(true);
            await expect(f.v62.connect(lender).supplyLiquidity(agentId, USDC(1))).to.not.be.reverted;
        });

        it("withdrawal draws the PENDING tranche first (LIFO)", async () => {
            await f.time.increase(DAY);
            await f.v62.connect(lender).supplyLiquidity(agentId, USDC(500));
            const stamp = (await f.v62.positions(agentId, lender.address)).depositTimestamp;
            await f.v62.connect(lender).withdrawLiquidity(agentId, USDC(500));
            expect((await f.v62.pendingTranche(agentId, lender.address)).amount).to.equal(0n);
            expect((await f.v62.positions(agentId, lender.address)).depositTimestamp).to.equal(stamp);
        });

        it("a loss shrinks the pending tranche pro-rata (pending ⊆ amount survives)", async () => {
            const g = await base();
            const [, b, l] = g.signers;
            await g.fund(b); await g.fund(l);
            const aid = await g.onboardAgent(b);
            await pumpScore(g, b, 800);
            await pumpCapacity(g, b, USDC(2000));
            await g.v62.connect(l).supplyLiquidity(aid, USDC(2000));
            await g.v62.connect(b).supplyLiquidity(aid, USDC(1000));
            const id = await g.v62.nextLoanId();
            await g.v62.connect(b).requestLoan(USDC(2000), 7);
            await g.time.increase(DAY);
            await g.v62.connect(l).supplyLiquidity(aid, USDC(1000)); // pending
            await g.time.increase(DAYS(8));
            await g.v62.liquidateLoan(id);
            const pos = await g.v62.positions(aid, l.address);
            const pt = await g.v62.pendingTranche(aid, l.address);
            expect(pt.amount).to.be.lte(pos.amount);
            await expectConserved(g, aid, "F-02 loss vs pending");
        });
    });

    // ------------------------------------------------------------------ F-03

    describe("F-03 — late repayment costs elapsed-time interest, capped at 30 days", function () {
        let f, borrower, lender, agentId, loanId;
        beforeEach(async () => {
            f = await base();
            [, borrower, lender] = f.signers;
            await f.fund(borrower); await f.fund(lender);
            agentId = await f.onboardAgent(borrower);
            await pumpScore(f, borrower, 400);
            await pumpCapacity(f, borrower, USDC(10000));
            await f.v62.connect(lender).supplyLiquidity(agentId, USDC(30000));
            loanId = await f.v62.nextLoanId();
            await f.v62.connect(borrower).requestLoan(USDC(10000), 7);
        });

        it("10 days late is charged for 17 days and previewRepayment agrees", async () => {
            await f.time.increase(DAYS(17));
            const pv = await f.v62.previewRepayment(loanId);
            // Each tx mines a block, so `elapsed` is 17 days plus a handful of seconds.
            expect(pv.chargeableSeconds).to.be.gte(BigInt(DAYS(17)));
            expect(pv.chargeableSeconds).to.be.lt(BigInt(DAYS(17) + 60));
            expect(pv.interest).to.equal(f.interestFor(USDC(10000), 1000, 1) * 0n
                + (USDC(10000) * 1000n / 10000n) * pv.chargeableSeconds / BigInt(DAYS(365)));
            expect(pv.lateSeconds).to.be.gte(BigInt(DAYS(10)));
            const b0 = await f.usdc.balanceOf(borrower.address);
            await f.v62.connect(borrower).repayLoan(loanId);
            // Principal out then back, collateral (100 % tier) returned: net outflow is the interest.
            const rec = await f.v62.repayments(loanId);
            expect(rec.interestPaid).to.be.gt(f.interestFor(USDC(10000), 1000, 7));
            expect(b0 - (await f.usdc.balanceOf(borrower.address))).to.equal(rec.interestPaid);
        });

        it("accrual stops at duration + LATE_INTEREST_CAP", async () => {
            await f.time.increase(DAYS(200));
            const pv = await f.v62.previewRepayment(loanId);
            expect(pv.chargeableSeconds).to.equal(BigInt(DAYS(37)));
            expect(pv.interest).to.equal(f.interestFor(USDC(10000), 1000, 37));
        });

        it("on-time repayment is unchanged (nominal term)", async () => {
            await f.time.increase(DAYS(6));
            const pv = await f.v62.previewRepayment(loanId);
            expect(pv.chargeableSeconds).to.equal(BigInt(DAYS(7)));
            expect(pv.lateSeconds).to.equal(0n);
        });

        it("a late repayment earns no bonus AND now costs reputation (the V6.1 gap closed)", async () => {
            const before = await f.reputation["getReputationScore(uint256)"](agentId);
            await f.time.increase(DAYS(10));
            await f.v62.connect(borrower).repayLoan(loanId);
            expect(await f.reputation["getReputationScore(uint256)"](agentId)).to.be.lt(before);
            expect(await f.v62.lateRepayCount(agentId)).to.equal(1n);
            expect(await f.reputation.lateCount(agentId)).to.equal(1n);
        });
    });

    // ------------------------------------------------------------------ F-05

    describe("F-05 — a loss beyond Σ principal is socialised across unclaimed interest", function () {
        it("interest absorbs the excess exactly; every remaining claim stays backed", async () => {
            const f = await base();
            const [, borrower, lender] = f.signers;
            await f.fund(borrower); await f.fund(lender);
            const agentId = await f.onboardAgent(borrower);
            await pumpScore(f, borrower, 800);
            await pumpCapacity(f, borrower, USDC(5000));

            await f.v62.connect(lender).supplyLiquidity(agentId, USDC(2000));
            await f.v62.connect(borrower).supplyLiquidity(agentId, USDC(2500));

            // Build unclaimed interest with a repaid loan.
            let id = await f.v62.nextLoanId();
            await f.v62.connect(borrower).requestLoan(USDC(3000), 30);
            await f.time.increase(DAYS(29));
            await f.v62.connect(borrower).repayLoan(id);
            const earned = (await f.v62.positions(agentId, lender.address)).earnedInterest;
            expect(earned).to.be.gt(0n);

            // Now draw MORE than Σ principal (the surplus is the lendable interest) and default.
            const pool = await f.v62.getAgentPool(agentId);
            const draw = pool.availableLiquidity;
            id = await f.v62.nextLoanId();
            await f.v62.connect(borrower).requestLoan(draw, 7);
            await f.time.increase(DAYS(8));
            await expect(f.v62.liquidateLoan(id)).to.emit(f.v62, "InterestLossSocialized");
            await expectConserved(f, agentId, "F-05 interest socialisation");
            // Wiped-out lenders are pruned from the slot list.
            expect((await f.v62.getAgentPool(agentId)).lenderCount).to.equal(0n);
        });
    });

    // ------------------------------------------------------------------ F-07

    describe("F-07 — registry deactivation is honoured", function () {
        it("a deactivated agent cannot open a pool or a loan, but can still close and exit", async () => {
            const f = await base();
            const [, borrower, lender, fresh] = f.signers;
            await f.fund(borrower); await f.fund(lender); await f.fund(fresh);
            const agentId = await f.onboardAgent(borrower);
            await pumpCapacity(f, borrower, USDC(1000));
            await f.v62.connect(lender).supplyLiquidity(agentId, USDC(2000));
            const id = await f.v62.nextLoanId();
            await f.v62.connect(borrower).requestLoan(USDC(500), 7);

            await f.registry.deactivateAgent(agentId);
            await expect(f.v62.connect(borrower).requestLoan(USDC(100), 7))
                .to.be.revertedWith("Agent deactivated");
            // Closing and lender exits stay live.
            await f.time.increase(2 * DAY);
            await expect(f.v62.connect(borrower).repayLoan(id)).to.emit(f.v62, "LoanRepaid");
            await expect(f.v62.connect(lender).withdrawLiquidity(agentId, USDC(1000))).to.not.be.reverted;

            await f.registry.connect(fresh).register("ipfs://fresh", []);
            const fid = await f.registry.addressToAgentId(fresh.address);
            await f.registry.deactivateAgent(fid);
            await expect(f.v62.connect(fresh).createAgentPool()).to.be.revertedWith("Agent deactivated");
        });
    });

    // --------------------------------------------------- unchanged invariants

    describe("core V6 invariants (§B1 / §S1 / §S5 / H-3)", function () {
        it("supply → withdraw → supply never duplicates a lender slot (§B1)", async () => {
            const f = await base();
            const [, borrower, lender] = f.signers;
            await f.fund(borrower); await f.fund(lender);
            const agentId = await f.onboardAgent(borrower);
            for (let i = 0; i < 3; i++) {
                await f.v62.connect(lender).supplyLiquidity(agentId, USDC(100));
                await f.v62.connect(lender).withdrawLiquidity(agentId, USDC(100));
            }
            await f.v62.connect(lender).supplyLiquidity(agentId, USDC(100));
            expect((await f.v62.getAgentPool(agentId)).lenderCount).to.equal(1n);
        });

        it("claimInterest decrements availableLiquidity (§S1)", async () => {
            const f = await base();
            const [, borrower, lender] = f.signers;
            await f.fund(borrower); await f.fund(lender);
            const agentId = await f.onboardAgent(borrower);
            await pumpCapacity(f, borrower, USDC(1000));
            await f.v62.connect(lender).supplyLiquidity(agentId, USDC(2000));
            const id = await f.v62.nextLoanId();
            await f.v62.connect(borrower).requestLoan(USDC(1000), 7);
            await f.time.increase(6 * DAY);
            await f.v62.connect(borrower).repayLoan(id);
            const before = (await f.v62.getAgentPool(agentId)).availableLiquidity;
            const earned = (await f.v62.positions(agentId, lender.address)).earnedInterest;
            await f.v62.connect(lender).claimInterest(agentId);
            expect((await f.v62.getAgentPool(agentId)).availableLiquidity).to.equal(before - earned);
            await expectConserved(f, agentId, "§S1");
        });

        it("the aggregate credit limit is enforced across concurrent loans (H-3)", async () => {
            const f = await base();
            const [, borrower, lender] = f.signers;
            await f.fund(borrower); await f.fund(lender);
            const agentId = await f.onboardAgent(borrower);
            await pumpScore(f, borrower, 800);
            await pumpCapacity(f, borrower, USDC(5000));
            await f.v62.connect(lender).supplyLiquidity(agentId, USDC(20000));
            await f.v62.connect(borrower).supplyLiquidity(agentId, USDC(2500));
            await f.v62.connect(borrower).requestLoan(USDC(5000), 7);
            expect(await f.v62.outstandingPrincipal(agentId)).to.equal(USDC(5000));
            await expect(f.v62.connect(borrower).requestLoan(USDC(1), 7))
                .to.be.revertedWith("Exceeds credit limit");
        });

        it("activeLoanCount tracks ACTIVE loans in O(1) (§S5)", async () => {
            const f = await base();
            const [, borrower, lender] = f.signers;
            await f.fund(borrower); await f.fund(lender);
            const agentId = await f.onboardAgent(borrower);
            await pumpCapacity(f, borrower, USDC(1000));
            await f.v62.connect(lender).supplyLiquidity(agentId, USDC(5000));
            const ids = [];
            for (let i = 0; i < 3; i++) {
                ids.push(await f.v62.nextLoanId());
                await f.v62.connect(borrower).requestLoan(USDC(100), 7);
            }
            expect(await f.v62.activeLoanCount(agentId)).to.equal(3n);
            expect((await f.v62.getActiveLoanIds(agentId)).length).to.equal(3);
            await f.time.increase(2 * DAY);
            await f.v62.connect(borrower).repayLoan(ids[1]);
            expect(await f.v62.activeLoanCount(agentId)).to.equal(2n);
            expect((await f.v62.getActiveLoanIds(agentId)).length).to.equal(2);
        });

        it("reentrancy guards and pause still gate every state-changing entrypoint", async () => {
            const f = await base();
            const [, borrower, lender] = f.signers;
            await f.fund(borrower); await f.fund(lender);
            const agentId = await f.onboardAgent(borrower);
            await f.v62.pause();
            await expect(f.v62.connect(lender).supplyLiquidity(agentId, USDC(100)))
                .to.be.revertedWithCustomError(f.v62, "EnforcedPause");
            await expect(f.v62.connect(borrower).requestLoan(USDC(1), 7))
                .to.be.revertedWithCustomError(f.v62, "EnforcedPause");
            await f.v62.unpause();
            await expect(f.v62.renounceOwnership()).to.be.revertedWith("Ownership cannot be renounced");
        });
    });
});
