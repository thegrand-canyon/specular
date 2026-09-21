// V6.1 testing round (2026-09-20): branch-coverage gaps and mutant-killers for the
// V6.1 diff (F-01/02/03/05/07). Each test names the contract line/branch it pins.
// Uses the Arc-mainnet launch fixture (test/audit-2026-09/_fixture.js) with the D1
// levers relaxed only where a reputation tier must be reached quickly.

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { deployLaunchStack, USDC, DAY, pumpScore, poolState, expectConserved } = require("../audit-2026-09-fixes/_helpers");

const fee = (i) => (i * 100n) / 10000n;

describe("V6.1 tranche / socialization edge cases (coverage gaps + mutant killers)", function () {
    this.timeout(300000);
    let f, borrower, l1, l2, l3, agentId;

    beforeEach(async () => {
        f = await deployLaunchStack({ rateLimit: 0, minHold: 0 });
        [, borrower, l1, l2, l3] = f.signers;
        for (const w of [borrower, l1, l2, l3]) await f.fund(w);
        agentId = await f.onboardAgent(borrower);
    });

    async function loan(amount, days = 7) {
        const id = await f.v6.nextLoanId();
        await f.v6.connect(borrower).requestLoan(amount, days);
        return { id, start: (await f.v6.loans(id)).startTime, end: (await f.v6.loans(id)).endTime };
    }
    const pos = async (w) => f.v6.positions(agentId, w.address);
    const pending = async (w) => f.v6.pendingTranche(agentId, w.address);
    const v6addr = async () => f.v6.getAddress();

    // ------------------------------------------------------------------ F-02 boundaries
    it("same-block top-up + loan: the pending tranche (ts == loan.start) qualifies (<=), and the next top-up folds (loan at s == pending.ts is NOT in [base.ts, pending.ts))", async () => {
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(1000));   // base t0
        await f.v6.connect(l2).supplyLiquidity(agentId, USDC(1500));
        await f.time.increase(60);
        const A = await loan(USDC(100), 7);                             // active during the top-up
        await f.time.increase(60);
        // bundle: L1 tops up 500 AND loan B starts in the SAME block
        await ethers.provider.send("evm_setAutomine", [false]);
        const supplyTx = await f.v6.connect(l1).supplyLiquidity(agentId, USDC(500));
        const bId = await f.v6.nextLoanId();
        const loanTx = await f.v6.connect(borrower).requestLoan(USDC(100), 7);
        await ethers.provider.send("evm_mine", []);
        await ethers.provider.send("evm_setAutomine", [true]);
        await supplyTx.wait(); await loanTx.wait();

        const B = await f.v6.loans(bId);
        const pt = await pending(l1);
        expect(pt.amount).to.equal(USDC(500));
        expect(pt.timestamp).to.equal(B.startTime);                     // same block
        // pending.timestamp <= B.start  → the 500 qualifies for B (boundary of qualifiedAmountAt)
        expect(await f.v6.qualifiedAmountAt(agentId, l1.address, B.startTime)).to.equal(USDC(1500));
        expect(await f.v6.qualifiedAmountAt(agentId, l1.address, A.start)).to.equal(USDC(1000));

        // Close A. Now the only ACTIVE loan is B, started exactly AT pending.ts — which is
        // outside [base.ts, pending.ts), so the pending tranche is qualified for exactly
        // what the base is → a further top-up must FOLD (not revert). Boundary of
        // _activeLoanStartedIn's `s < hi`.
        await f.v6.connect(borrower).repayLoan(A.id);
        expect(await f.v6.getActiveLoanIds(agentId)).to.deep.equal([bId]);
        expect(await f.v6.canTopUp(agentId, l1.address)).to.equal(true);
        await f.time.increase(60);
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(300));   // fold
        const pt2 = await pending(l1);
        expect(pt2.amount).to.equal(USDC(300));                        // new money only
        expect((await pos(l1)).amount).to.equal(USDC(1800));
        expect((await pos(l1)).depositTimestamp).to.be.lt(B.startTime); // base stamp untouched

        // B's interest: L1 qualified 1500 vs L2 1500 → exact 50/50
        await f.time.increase(DAY);
        const e1 = (await pos(l1)).earnedInterest, e2 = (await pos(l2)).earnedInterest;
        await f.v6.connect(borrower).repayLoan(bId);
        const li = (await f.v6.repayments(bId)).interestPaid;
        const lenderInterest = li - fee(li);
        expect((await pos(l1)).earnedInterest - e1).to.equal(lenderInterest / 2n);
        expect((await pos(l2)).earnedInterest - e2).to.equal(lenderInterest / 2n);
        await expectConserved(f, agentId);
    });

    it("activeLoanIds is maintained by liquidateLoan too: after a default the id is gone and a fold top-up is accepted", async () => {
        await pumpScore(f, borrower, 600);                              // 0% collateral → lossy default
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(1000));   // base t0
        await f.time.increase(60);
        const A = await loan(USDC(100), 7);                             // t1
        await f.time.increase(60);
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(100));    // pending t2 (A in flight)
        await f.time.increase(60);
        const B = await loan(USDC(100), 30);                            // t3
        await f.time.increase(8 * DAY);                                 // A overdue, B not
        await f.v6.liquidateLoan(A.id);
        expect(await f.v6.getActiveLoanIds(agentId)).to.deep.equal([B.id]);
        expect(await f.v6.activeLoanCount(agentId)).to.equal(1n);
        // loss 100 over Σprincipal 1100 → L1 amount 1000, pending cut floor(100e6·100e6/1100e6) = 9,090,909
        expect((await pos(l1)).amount).to.equal(USDC(1000));
        expect((await pending(l1)).amount).to.equal(USDC(100) - (USDC(100) * USDC(100)) / USDC(1100));
        // no ACTIVE loan in [base.ts, pending.ts) any more (A is DEFAULTED) → fold, not refuse
        expect(await f.v6.canTopUp(agentId, l1.address)).to.equal(true);
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(50));
        expect((await pending(l1)).amount).to.equal(USDC(50));
        await expectConserved(f, agentId);
    });

    it("_shrinkPendingProRata deletes the pending tranche when a loss consumes the whole position (L508-509), then the empty slot is pruned", async () => {
        await pumpScore(f, borrower, 600);
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(100));
        await f.time.increase(60);
        const A = await loan(USDC(100), 7);                             // avail → 0
        await f.time.increase(60);
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(50));     // pending 50
        await f.time.increase(60);
        const B = await loan(USDC(50), 7);                              // avail → 0
        await f.time.increase(8 * DAY);

        await f.v6.liquidateLoan(A.id);                                 // loss 100 / Σ 150
        expect((await pos(l1)).amount).to.equal(USDC(50));
        const cut = (USDC(100) * USDC(50)) / USDC(150);                 // 33.333333 → floor
        expect((await pending(l1)).amount).to.equal(USDC(50) - cut);
        await expectConserved(f, agentId, "after A");

        await expect(f.v6.liquidateLoan(B.id))                          // loss 50 == Σ 50 → wipe
            .to.emit(f.v6, "PendingTrancheUpdated").withArgs(agentId, l1.address, 0, 0);
        expect((await pos(l1)).amount).to.equal(0n);
        expect((await pending(l1)).amount).to.equal(0n);
        expect(await f.v6.isInPoolLenders(agentId, l1.address)).to.equal(false); // pruned
        expect((await f.v6.getAgentPool(agentId)).lenderCount).to.equal(0n);
        await expectConserved(f, agentId, "after B");
    });

    it("canTopUp short-circuits: never-supplied lender, no active loans, and no pending tranche all return true", async () => {
        expect(await f.v6.canTopUp(agentId, l1.address)).to.equal(true);           // p.amount == 0
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(100));
        expect(await f.v6.canTopUp(agentId, l1.address)).to.equal(true);           // activeLoanCount == 0
        await f.time.increase(60);
        await loan(USDC(10), 7);
        expect(await f.v6.canTopUp(agentId, l1.address)).to.equal(true);           // pt.amount == 0
        expect(await f.v6.canTopUp(agentId, l2.address)).to.equal(true);           // new lender never refused
    });

    it("[BUG 2026-09-20] canTopUp must see a loan that started in the LATEST block (view at T vs tx at T' > T)", async () => {
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(1000));   // base
        await f.time.increase(60);
        await loan(USDC(10), 7);                                        // A in flight
        await f.time.increase(60);
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(100));    // pending @ t2
        await f.time.increase(60);
        await loan(USDC(10), 7);                                        // B starts in the latest block (t3)
        // Every ACTIVE loan that started >= pending.ts makes the next top-up a case-(e)
        // revert, no matter when the tx lands. The view must say so NOW — the SDK
        // calls it against the latest block, which is exactly the block B started in.
        expect(await f.v6.canTopUp(agentId, l1.address)).to.equal(false);
        await expect(f.v6.connect(l1).supplyLiquidity(agentId, USDC(1)))
            .to.be.revertedWith("Top-up would forfeit in-flight interest");
    });

    it("_toU128 guard: a mid-loan top-up above uint128 reverts 'Amount overflow' (L370)", async () => {
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(100));
        await f.time.increase(60);
        await loan(USDC(10), 7);
        const huge = 1n << 128n;
        await f.usdc.mint(l1.address, huge);
        await expect(f.v6.connect(l1).supplyLiquidity(agentId, huge)).to.be.revertedWith("Amount overflow");
    });

    // ------------------------------------------------------------------ F-05 branches
    it("_socializeInterestLoss: remainder loop takes less than the remainder from a 1-unit lender (L544), exact to the base unit", async () => {
        // Seed a pool whose lendable liquidity is ONLY unclaimed interest: [1, 1, 8] base units.
        await pumpScore(f, borrower, 600);
        const ts = await f.time.latest();
        await f.v6.seedPool(agentId, borrower.address, 0, 10n, 0);
        await f.v6.seedPosition(agentId, l1.address, 0, 1n, ts);
        await f.v6.seedPosition(agentId, l2.address, 0, 1n, ts);
        await f.v6.seedPosition(agentId, l3.address, 0, 8n, ts);
        await f.usdc.mint(await v6addr(), 10n);
        const A = await loan(7n, 7);                                    // funded from interest
        await f.time.increase(8 * DAY);
        // T=10, loss 7: shares floor(0.7)=0, 0, floor(5.6)=5 → remainder 2 → take 1 (< remainder), then 1
        await expect(f.v6.liquidateLoan(A.id)).to.emit(f.v6, "InterestLossSocialized").withArgs(agentId, 7n);
        expect((await pos(l1)).earnedInterest).to.equal(0n);
        expect((await pos(l2)).earnedInterest).to.equal(0n);
        expect((await pos(l3)).earnedInterest).to.equal(3n);
        expect((await f.v6.getAgentPool(agentId)).lenderCount).to.equal(1n); // l1/l2 pruned
        await expectConserved(f, agentId);
    });

    it("_socializeInterestLoss: pool with NO lenders → returns 0, no event, liquidation completes (L531/L961)", async () => {
        await pumpScore(f, borrower, 600);
        await f.v6.seedPool(agentId, borrower.address, 0, USDC(5), 0);
        await f.usdc.mint(await v6addr(), USDC(5));
        const A = await loan(USDC(5), 7);
        await f.time.increase(8 * DAY);
        await expect(f.v6.liquidateLoan(A.id)).to.not.emit(f.v6, "InterestLossSocialized");
        const p = await f.v6.getAgentPool(agentId);
        expect(p.availableLiquidity).to.equal(0n);
        expect(p.totalLoaned).to.equal(0n);
        expect(await f.usdc.balanceOf(await v6addr())).to.equal(0n);
    });

    it("_socializeInterestLoss caps at Σ interest when a migration seed over-states liquidity (defensive L533)", async () => {
        await pumpScore(f, borrower, 600);
        const ts = await f.time.latest();
        await f.v6.seedPool(agentId, borrower.address, 0, 10n, 0);      // avail 10, but only 2 booked
        await f.v6.seedPosition(agentId, l1.address, 0, 1n, ts);
        await f.v6.seedPosition(agentId, l2.address, 0, 1n, ts);
        await f.usdc.mint(await v6addr(), 10n);
        const A = await loan(10n, 7);
        await f.time.increase(8 * DAY);
        await expect(f.v6.liquidateLoan(A.id)).to.emit(f.v6, "InterestLossSocialized").withArgs(agentId, 2n);
        expect((await pos(l1)).earnedInterest).to.equal(0n);
        expect((await pos(l2)).earnedInterest).to.equal(0n);
        expect((await f.v6.getAgentPool(agentId)).lenderCount).to.equal(0n);
    });

    it("_socializeInterestLoss skips a lender with principal but no interest (L536); organic loss > Σ principal", async () => {
        await pumpScore(f, borrower, 600);
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(100));
        await f.v6.connect(l2).supplyLiquidity(agentId, USDC(100));
        await f.time.increase(60);
        const A = await loan(USDC(200), 30);
        await f.time.increase(30 * DAY);
        await f.v6.connect(borrower).repayLoan(A.id);                   // both earn interest
        await f.v6.connect(l1).claimInterest(agentId);                  // l1: principal only
        const i2 = (await pos(l2)).earnedInterest;
        expect(i2).to.be.gt(0n);
        await f.v6.connect(l1).withdrawLiquidity(agentId, USDC(100));   // l1 exits fully
        await f.v6.connect(l2).withdrawLiquidity(agentId, USDC(100));   // l2: interest only
        await f.v6.connect(l3).supplyLiquidity(agentId, USDC(10));      // l3: principal only, no interest
        const avail = (await f.v6.getAgentPool(agentId)).availableLiquidity;
        expect(avail).to.equal(USDC(10) + i2);
        await f.time.increase(60);
        const B = await loan(avail, 7);                                 // everything, incl. l2's interest
        await f.time.increase(8 * DAY);
        await expect(f.v6.liquidateLoan(B.id)).to.emit(f.v6, "InterestLossSocialized").withArgs(agentId, i2);
        expect((await pos(l3)).amount).to.equal(0n);                    // principal wiped first
        expect((await pos(l2)).earnedInterest).to.equal(0n);            // then interest
        expect((await f.v6.getAgentPool(agentId)).lenderCount).to.equal(0n);
        await expectConserved(f, agentId);
    });

    it("_socializeLoss skips interest-only lenders in both passes (L586/L599/L600) and the remainder lands on a principal holder", async () => {
        await pumpScore(f, borrower, 600);
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(1000));
        await f.time.increase(60);
        const A = await loan(USDC(500), 30);
        await f.time.increase(30 * DAY);
        await f.v6.connect(borrower).repayLoan(A.id);
        const i1 = (await pos(l1)).earnedInterest;
        expect(i1).to.be.gt(0n);
        await f.v6.connect(l1).withdrawLiquidity(agentId, USDC(1000));  // l1 stays: interest only
        const a2 = USDC(300) + 1n, a3 = USDC(700);                       // coprime-ish → rounding remainder
        await f.v6.connect(l2).supplyLiquidity(agentId, a2);
        await f.v6.connect(l3).supplyLiquidity(agentId, a3);
        await f.time.increase(60);
        const B = await loan(USDC(999), 7);
        await f.time.increase(8 * DAY);
        const T = a2 + a3, L = USDC(999);
        const s2 = (L * a2) / T, s3 = (L * a3) / T;
        const remainder = L - s2 - s3;
        expect(remainder).to.be.gt(0n);                                  // the remainder loop runs
        await f.v6.liquidateLoan(B.id);
        expect((await pos(l1)).amount).to.equal(0n);                    // skipped (no principal)
        expect((await pos(l1)).earnedInterest).to.equal(i1);            // untouched: loss ≤ Σ principal
        // remainder is taken from the first lender WITH principal (l2), never from l1
        const r2 = (await pos(l2)).amount, r3 = (await pos(l3)).amount;
        expect(r3).to.equal(a3 - s3);
        expect(r2).to.equal(a2 - s2 - remainder);
        expect(r2 + r3).to.equal(T - L);
        await expectConserved(f, agentId);
    });

    // ------------------------------------------------------------------ F-03 boundaries
    it("repay exactly at endTime is on time (lateSeconds 0) and exactly at endTime + 30d is charged the cap (no more after)", async () => {
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(1000));
        await f.time.increase(60);
        const A = await loan(USDC(1000), 7);
        await f.time.setNextBlockTimestamp(A.end);
        await f.v6.connect(borrower).repayLoan(A.id);
        let rec = await f.v6.repayments(A.id);
        expect(rec.lateSeconds).to.equal(0n);
        expect(rec.interestPaid).to.equal(f.interestFor(USDC(1000), 1500, 7));
        expect(await f.v6.lateRepayCount(agentId)).to.equal(0n);

        await f.time.increase(60);
        const B = await loan(USDC(1000), 7);
        await f.time.increaseTo(B.end + BigInt(30 * DAY));
        const pvAtCap = await f.v6.previewRepayment(B.id);
        expect(pvAtCap.chargeableSeconds).to.equal(BigInt(37 * DAY));
        await f.time.increase(200 * DAY);                               // far beyond the cap
        const pvBeyond = await f.v6.previewRepayment(B.id);
        expect(pvBeyond.interest).to.equal(pvAtCap.interest);           // cap binds
        expect(pvBeyond.lateSeconds).to.be.gt(pvAtCap.lateSeconds);     // lateness still recorded
        await f.v6.connect(borrower).repayLoan(B.id);
        rec = await f.v6.repayments(B.id);
        expect(rec.interestPaid).to.equal(f.interestFor(USDC(1000), 1500, 37));
        expect(await f.v6.lateRepayCount(agentId)).to.equal(1n);
        expect(await f.v6.lateSecondsTotal(agentId)).to.equal(rec.lateSeconds);
    });

    it("previewRepayment reverts for a loan that is not ACTIVE", async () => {
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(100));
        await f.time.increase(60);
        const A = await loan(USDC(10), 7);
        await f.v6.connect(borrower).repayLoan(A.id);
        await expect(f.v6.previewRepayment(A.id)).to.be.revertedWith("Loan not active");
        await expect(f.v6.previewRepayment(999)).to.be.revertedWith("Loan not active");
    });

    // ------------------------------------------------------------------ F-02 LIFO withdraw
    it("withdraw larger than the pending tranche: pending deleted, base reduced, base timestamp untouched", async () => {
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(1000));
        const ts0 = (await pos(l1)).depositTimestamp;
        await f.time.increase(60);
        await loan(USDC(10), 7);
        await f.time.increase(60);
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(200));    // pending 200
        await expect(f.v6.connect(l1).withdrawLiquidity(agentId, USDC(500)))
            .to.emit(f.v6, "PendingTrancheUpdated").withArgs(agentId, l1.address, 0, 0);
        expect((await pos(l1)).amount).to.equal(USDC(700));
        expect((await pending(l1)).amount).to.equal(0n);
        expect((await pos(l1)).depositTimestamp).to.equal(ts0);
        const { sumPending } = await poolState(f, agentId);
        expect(sumPending).to.equal(0n);
    });
});
