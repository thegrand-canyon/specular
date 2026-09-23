// Regression tests for the F-02 fix (V6.1): a lender top-up while loans are in
// flight becomes a PENDING tranche; the pre-existing principal keeps its
// depositTimestamp and its share of every in-flight loan. Cases (see supplyLiquidity):
//   (a) nothing to protect → single base tranche stamped now
//   (b) first top-up mid-loan → pending tranche
//   (c) pending qualified for every active loan the base is → fold, new pending
//   (d) no active loan since the pending tranche → merge + re-stamp
//   (e) otherwise → revert "Top-up would forfeit in-flight interest"
// Withdraw draws pending first (LIFO). Socialized loss shrinks pending pro-rata.

const { expect } = require("chai");
const { deployLaunchStack, USDC, DAY, pumpScore, poolState, expectConserved } = require("./_helpers");

const fee = (i) => (i * 100n) / 10000n;

describe("F-02 fix — pending tranche keeps in-flight interest", function () {
    this.timeout(600000);
    let f, borrower, l1, l2, attacker, agentId;

    beforeEach(async () => {
        f = await deployLaunchStack();
        [, borrower, l1, l2, attacker] = f.signers;
        for (const w of [borrower, l1, l2, attacker]) await f.fund(w);
        agentId = await f.onboardAgent(borrower);
    });

    async function loan(amount, days = 7) {
        const id = await f.v6.nextLoanId();
        await f.v6.connect(borrower).requestLoan(amount, days);
        return { id, start: (await f.v6.loans(id)).startTime };
    }
    async function repay(id) {
        await f.v6.connect(borrower).repayLoan(id);
        const i = (await f.v6.repayments(id)).interestPaid;
        return i - fee(i); // lender interest
    }
    const earned = async (w) => (await f.v6.getLenderPosition(agentId, w.address)).earnedInterest;
    const pending = async (w) => f.v6.pendingTranche(agentId, w.address);

    it("(a) top-up BEFORE a loan starts is fully qualified: exact 50/50 with an equal lender", async () => {
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(1000));
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(500));   // no loan in flight → merged base
        expect((await pending(l1)).amount).to.equal(0n);
        await f.v6.connect(l2).supplyLiquidity(agentId, USDC(1500));
        const { id } = await loan(USDC(1000));
        await f.time.increase(DAY);
        const li = await repay(id);
        expect(await earned(l1)).to.equal(li / 2n);
        expect(await earned(l2)).to.equal(li / 2n);
        await expectConserved(f, agentId);
    });

    it("(b) top-up AFTER a loan starts: base keeps its share of that loan; the top-up counts for the next loan", async () => {
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(1000));
        await f.v6.connect(l2).supplyLiquidity(agentId, USDC(1000));
        const A = await loan(USDC(500));
        await f.time.increase(DAY);
        await expect(f.v6.connect(l1).supplyLiquidity(agentId, USDC(1000)))
            .to.emit(f.v6, "PendingTrancheUpdated");
        expect((await pending(l1)).amount).to.equal(USDC(1000));
        expect(await f.v6.qualifiedAmountAt(agentId, l1.address, A.start)).to.equal(USDC(1000));
        expect(await f.v6.qualifiedAmountAt(agentId, l2.address, A.start)).to.equal(USDC(1000));
        const B = await loan(USDC(500));      // starts after the top-up
        expect(await f.v6.qualifiedAmountAt(agentId, l1.address, B.start)).to.equal(USDC(2000));
        await f.time.increase(DAY);
        const liA = await repay(A.id);
        expect(await earned(l1)).to.equal(liA / 2n);                     // 1000 : 1000
        expect(await earned(l2)).to.equal(liA / 2n);
        const liB = await repay(B.id);
        expect(await earned(l1)).to.equal(liA / 2n + (liB * 2n) / 3n);   // 2000 : 1000
        expect(await earned(l2)).to.equal(liA / 2n + liB / 3n);
        await expectConserved(f, agentId);
    });

    it("a 1-base-unit top-up does not change the base's share by more than the unit itself", async () => {
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(10_000));
        await f.v6.connect(l2).supplyLiquidity(agentId, USDC(10_000));
        const A = await loan(USDC(1000), 30);
        await f.time.increase(DAY);
        await f.v6.connect(l1).supplyLiquidity(agentId, 1n);
        await f.time.increase(28 * DAY);
        const li = await repay(A.id);
        expect(await earned(l1)).to.equal(li / 2n);
        expect(await earned(l2)).to.equal(li / 2n);
    });

    it("(c) second top-up folds a pending tranche that already qualifies for every active loan", async () => {
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(1000));
        await f.v6.connect(l2).supplyLiquidity(agentId, USDC(1000));
        const ts0 = (await f.v6.positions(agentId, l1.address)).depositTimestamp;
        const A = await loan(USDC(500));
        await f.time.increase(DAY);
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(500));      // pending (ts1)
        await f.time.increase(DAY);
        await repay(A.id);                                                // no active loan in [ts0, ts1) any more
        const B = await loan(USDC(500));                                  // starts after ts1
        await f.time.increase(DAY);
        expect(await f.v6.canTopUp(agentId, l1.address)).to.equal(true);
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(300));      // (c): fold 500 into base, 300 pending
        expect((await pending(l1)).amount).to.equal(USDC(300));
        expect((await f.v6.positions(agentId, l1.address)).depositTimestamp).to.equal(ts0);
        expect((await f.v6.positions(agentId, l1.address)).amount).to.equal(USDC(1800));
        expect(await f.v6.qualifiedAmountAt(agentId, l1.address, B.start)).to.equal(USDC(1500));
        const liB = await repay(B.id);
        const e1 = await earned(l1), e2 = await earned(l2);
        // for B: l1 1500 : l2 1000 (plus the equal A split already booked)
        expect(e1 - e2).to.equal((liB * 1500n) / 2500n - (liB * 1000n) / 2500n);
        await expectConserved(f, agentId);
    });

    it("(d) second top-up merges into the pending tranche when no loan started since it", async () => {
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(1000));
        await f.v6.connect(l2).supplyLiquidity(agentId, USDC(1000));
        const A = await loan(USDC(500));
        await f.time.increase(DAY);
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(500));      // pending 500
        await f.time.increase(DAY);
        expect(await f.v6.canTopUp(agentId, l1.address)).to.equal(true);
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(200));      // (d): pending 700, re-stamped
        const pt = await pending(l1);
        expect(pt.amount).to.equal(USDC(700));
        expect(await f.v6.qualifiedAmountAt(agentId, l1.address, A.start)).to.equal(USDC(1000));
        await f.time.increase(DAY);
        const liA = await repay(A.id);
        expect(await earned(l1)).to.equal(liA / 2n);
        expect(await earned(l2)).to.equal(liA / 2n);
        await expectConserved(f, agentId);
    });

    it("(e) a top-up that would need a third tranche is refused, and allowed again once the older loan closes", async () => {
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(1000));
        await f.v6.connect(l2).supplyLiquidity(agentId, USDC(1000));
        const A = await loan(USDC(300));
        await f.time.increase(DAY);
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(500));      // pending (ts1); A ∈ [ts0, ts1)
        await f.time.increase(DAY);
        const B = await loan(USDC(300));                                  // B ∈ [ts1, now)
        await f.time.increase(DAY);
        expect(await f.v6.canTopUp(agentId, l1.address)).to.equal(false);
        await expect(f.v6.connect(l1).supplyLiquidity(agentId, USDC(200)))
            .to.be.revertedWith("Top-up would forfeit in-flight interest");
        // a NEW lender is never blocked
        await expect(f.v6.connect(attacker).supplyLiquidity(agentId, USDC(200))).to.not.be.reverted;
        // shares are untouched by the refused attempt
        await f.time.increase(5 * DAY);
        const liA = await repay(A.id);
        expect(await earned(l1)).to.equal(liA / 2n);
        expect(await earned(l2)).to.equal(liA / 2n);
        expect(await earned(attacker)).to.equal(0n);
        // A closed → (c) applies: fold 500 into base, 200 pending
        expect(await f.v6.canTopUp(agentId, l1.address)).to.equal(true);
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(200));
        expect((await pending(l1)).amount).to.equal(USDC(200));
        expect(await f.v6.qualifiedAmountAt(agentId, l1.address, B.start)).to.equal(USDC(1500));
        const liB = await repay(B.id);
        expect((await earned(l1)) - liA / 2n).to.equal((liB * 1500n) / 2500n);
        expect((await earned(l2)) - liA / 2n).to.equal((liB * 1000n) / 2500n);
        await expectConserved(f, agentId);
    });

    it("withdraw draws the pending tranche first (LIFO) and never grants qualification", async () => {
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(1000));
        const A = await loan(USDC(400));
        await f.time.increase(DAY);
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(500));      // pending 500
        await f.v6.connect(l1).withdrawLiquidity(agentId, USDC(300));
        expect((await pending(l1)).amount).to.equal(USDC(200));
        expect((await f.v6.positions(agentId, l1.address)).amount).to.equal(USDC(1200));
        await expect(f.v6.connect(l1).withdrawLiquidity(agentId, USDC(200)))
            .to.emit(f.v6, "PendingTrancheUpdated").withArgs(agentId, l1.address, 0n, 0n);
        expect((await pending(l1)).timestamp).to.equal(0n);
        await f.v6.connect(l1).withdrawLiquidity(agentId, USDC(100));   // now from base
        expect(await f.v6.qualifiedAmountAt(agentId, l1.address, A.start)).to.equal(USDC(900));
        await expectConserved(f, agentId);
    });

    it("(a) with no loan in flight a top-up folds everything into one base tranche stamped now", async () => {
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(1000));
        const A = await loan(USDC(400));
        await f.time.increase(DAY);
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(500));      // pending
        await repay(A.id);
        await f.time.increase(DAY);
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(100));      // no active loans → fold
        expect((await pending(l1)).amount).to.equal(0n);
        const p = await f.v6.positions(agentId, l1.address);
        expect(p.amount).to.equal(USDC(1600));
        expect(p.depositTimestamp).to.equal(await f.time.latest());
    });

    it("sandwich defence intact: a fresh position opened after loan start earns nothing on that loan", async () => {
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(1000));
        const A = await loan(USDC(500));
        await f.time.increase(60);
        await f.v6.connect(attacker).supplyLiquidity(agentId, USDC(100_000));
        await f.time.increase(DAY);
        const li = await repay(A.id);
        expect(await earned(l1)).to.equal(li);
        expect(await earned(attacker)).to.equal(0n);
        // and a lender that fully exits and re-enters mid-loan is a fresh position (no qualification)
        await f.v6.connect(l1).claimInterest(agentId);
        const B = await loan(USDC(500));
        await f.time.increase(60);
        await f.v6.connect(l1).withdrawLiquidity(agentId, USDC(1000));
        await f.v6.connect(l1).supplyLiquidity(agentId, USDC(1000));
        expect(await f.v6.qualifiedAmountAt(agentId, l1.address, B.start)).to.equal(0n);
        expect(await f.v6.qualifiedAmountAt(agentId, attacker.address, B.start)).to.equal(USDC(100_000));
    });

    it("socialized loss shrinks the pending tranche pro-rata and keeps pending ⊆ amount", async () => {
        const g = await deployLaunchStack({ rateLimit: 0 });
        const [, b, L] = g.signers;
        await g.fund(b); await g.fund(L);
        const aid = await g.onboardAgent(b);
        await pumpScore(g, b, 600); // 0% collateral → real losses
        await g.v6.connect(L).supplyLiquidity(aid, USDC(1000));
        const idA = await g.v6.nextLoanId();
        await g.v6.connect(b).requestLoan(USDC(400), 7);
        await g.time.increase(DAY);
        await g.v6.connect(L).supplyLiquidity(aid, USDC(1000));          // pending 1000 of 2000
        const idB = await g.v6.nextLoanId();
        await g.v6.connect(b).requestLoan(USDC(1000), 7);
        await g.time.increase(8 * DAY);
        await g.v6.liquidateLoan(idB);                                    // loss 1000 on 2000 principal
        const p = await g.v6.positions(aid, L.address);
        const pt = await g.v6.pendingTranche(aid, L.address);
        expect(p.amount).to.equal(USDC(1000));
        expect(pt.amount).to.equal(USDC(500));
        await expectConserved(g, aid);
        await g.v6.connect(b).repayLoan(idA);                             // late: 9 days on a 7-day term
        const i = (await g.v6.repayments(idA)).interestPaid;
        expect((await g.v6.getLenderPosition(aid, L.address)).earnedInterest).to.equal(i - fee(i));
        await expectConserved(g, aid);
    });

    it("seeded random ops (supply/top-up/withdraw/loan/repay/liquidate/claim) keep per-pool conservation exact", async () => {
        const g = await deployLaunchStack({ rateLimit: 0, minHold: 0 });
        g.time = f.time;
        const [, b, L1, L2, L3] = g.signers;
        for (const w of [b, L1, L2, L3]) await g.fund(w);
        const aid = await g.onboardAgent(b);
        await pumpScore(g, b, 600);
        const lenders = [L1, L2, L3];
        let seed = 20260919;
        const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
        const open = [];
        let blocked = 0, ops = 0;
        for (let step = 0; step < 120; step++) {
            const op = rnd(7);
            const L = lenders[rnd(3)];
            try {
                if (op === 0 || op === 1) {
                    await g.v6.connect(L).supplyLiquidity(aid, USDC(1 + rnd(2000)));
                } else if (op === 2) {
                    const amt = (await g.v6.positions(aid, L.address)).amount;
                    if (amt > 0n) await g.v6.connect(L).withdrawLiquidity(aid, 1n + BigInt(rnd(Number(amt / 1_000_000n) || 1)) * 1_000_000n);
                } else if (op === 3) {
                    const avail = (await g.v6.getAgentPool(aid)).availableLiquidity;
                    if (avail > USDC(1) && open.length < 10) {
                        const id = await g.v6.nextLoanId();
                        await g.v6.connect(b).requestLoan(USDC(1 + rnd(Number(avail / 1_000_000n))), 7 + rnd(20));
                        open.push(id);
                    }
                } else if (op === 4 && open.length) {
                    const id = open.splice(rnd(open.length), 1)[0];
                    await g.v6.connect(b).repayLoan(id);
                } else if (op === 5 && open.length) {
                    const idx = rnd(open.length);
                    const l = await g.v6.loans(open[idx]);
                    if (BigInt(await g.time.latest()) > l.endTime) { await g.v6.liquidateLoan(open[idx]); open.splice(idx, 1); }
                } else if (op === 6) {
                    if ((await g.v6.getLenderPosition(aid, L.address)).earnedInterest > 0n) await g.v6.connect(L).claimInterest(aid);
                }
                ops++;
            } catch (e) {
                const msg = String(e.message);
                if (msg.includes("Top-up would forfeit")) blocked++;
                else if (!/Insufficient pool liquidity|Exceeds credit limit|Drain underflow|Insufficient balance/.test(msg)) throw e;
            }
            await g.time.increase(1 + rnd(5) * DAY);
            await expectConserved(g, aid, `step ${step}`);
        }
        expect(ops).to.be.gt(60);
        // eslint-disable-next-line no-console
        console.log(`      random run: ${ops} ops applied, ${blocked} top-ups refused (case e)`);
    });
});
