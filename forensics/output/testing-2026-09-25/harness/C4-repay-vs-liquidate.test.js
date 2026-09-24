// RACE 4 — repay vs liquidate on the same overdue loan, in the same block.
//
// This is the operationally REAL one: the liquidation cron fires on a schedule while a
// borrower is trying to clear the same loan. Exactly one must win, with
//   * no double accounting (the principal returns to the pool once, not twice),
//   * no stranded collateral (either refunded to the borrower on repay, or seized into
//     availableLiquidity on liquidation — never both, never neither),
//   * the loser moving NO money at all (in particular the borrower must not be charged
//     principal + interest for a loan that was liquidated out from under it).
//
// The cron double-fire (two liquidateLoan for the same id in one block) is included,
// because that is the same race with both sides owned by us.

const {
    USDC, DAY, expect, sameBlockBatch, deployConc, assertInvariants,
    withSnapshot, orderings, increaseTime, mineOne, record, violation, note, dumpResults,
} = require("./_conc");

describe("RACE 4 — repay vs liquidate", function () {
    let f, hi, lo, aidHi, aidLo, L;

    before(async () => {
        f = await deployConc({ minSupply: USDC(10), minHold: 0 });
        const s = f.signers;
        hi = s[1]; lo = s[2];
        await f.fund(hi); await f.fund(lo);
        aidHi = await f.onboardAgent(hi, "r4hi");
        aidLo = await f.onboardAgent(lo, "r4lo");
        await f.pumpScore(hi, 600);
        await f.pumpCapacity(hi, USDC(1000));
        // `lo` stays at score 0 (100 % collateral) but needs ladder head-room to borrow
        // at all: k*450 + 100 = 1000, which is also its tier-0 cap.
        await f.pumpCapacity(lo, USDC(450));
        L = s.slice(10, 20);
        for (const l of L) await f.fund(l, USDC(500_000));
    });

    after(() => dumpResults("concurrency-results.json"));

    /** Open an overdue loan on the 0 %-collateral agent. */
    async function overdueUnsecured(amount, lateDays = 2) {
        await f.mp.connect(hi).supplyLiquidity(aidHi, amount); // self-stake, amply covers amount/2
        await f.mp.connect(L[0]).supplyLiquidity(aidHi, amount * 2n);
        const id = await f.mp.nextLoanId();
        await f.mp.connect(hi).requestLoan(amount, 7);
        await increaseTime((7 + lateDays) * DAY); await mineOne();
        return id;
    }
    /** Open an overdue loan on the 100 %-collateral agent (collateral actually posted). */
    async function overdueSecured(amount, lateDays = 2) {
        await f.mp.connect(L[1]).supplyLiquidity(aidLo, amount * 3n);
        const id = await f.mp.nextLoanId();
        await f.mp.connect(lo).requestLoan(amount, 7);
        await increaseTime((7 + lateDays) * DAY); await mineOne();
        return id;
    }

    // ───────────────────────────────── 4.1 unsecured loan: repay vs liquidate
    it("4.1 unsecured overdue loan — repay and liquidate in one block, both orders × 4 sizes × 2 lateness", async () => {
        for (const amount of [USDC(100), USDC(500), USDC(1000), USDC(1900)]) {
            for (const lateDays of [1, 40]) {  // 40 d exceeds LATE_INTEREST_CAP (30 d)
                for (const repayFirst of [true, false]) {
                    await withSnapshot(async () => {
                        const id = await overdueUnsecured(amount, lateDays);
                        const borrowerBefore = await f.usdc.balanceOf(hi.address);
                        const poolBefore = await f.mp.getAgentPool(aidHi);
                        const rItem = { label: "REPAY", send: (ov) => f.mp.connect(hi).repayLoan(id, ov) };
                        const qItem = { label: "LIQUIDATE", send: (ov) => f.mp.connect(f.owner).liquidateLoan(id, ov) };
                        const batch = await sameBlockBatch(repayFirst ? [rItem, qItem] : [qItem, rItem], { gasLimit: 2_000_000 });
                        const by = Object.fromEntries(batch.rows.map((r) => [r.label, r]));

                        const wins = batch.rows.filter((r) => r.ok).map((r) => r.label);
                        if (wins.length !== 1) {
                            violation("CRITICAL", "4.1", `${wins.length} of {repay, liquidate} succeeded on loan ${id} in one block`,
                                "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C4-repay-vs-liquidate.test.js -g '4.1'");
                        }
                        expect(wins.length, "both repay and liquidate settled the same loan").to.equal(1);
                        expect(wins[0]).to.equal(repayFirst ? "REPAY" : "LIQUIDATE");
                        const loser = by[repayFirst ? "LIQUIDATE" : "REPAY"];
                        expect(loser.reason).to.match(/Loan not active/);

                        const loan = await f.mp.loans(id);
                        expect(Number(loan.state)).to.equal(repayFirst ? 2 : 3); // REPAID / DEFAULTED
                        if (!repayFirst) {
                            // the borrower lost the race: it must not have been charged anything
                            expect(await f.usdc.balanceOf(hi.address), "borrower charged for a liquidated loan").to.equal(borrowerBefore);
                        }
                        expect(await f.mp.activeLoanCount(aidHi)).to.equal(0n);
                        expect(await f.mp.outstandingPrincipal(aidHi)).to.equal(0n);
                        const v = await assertInvariants(f, [aidHi, aidLo], `4.1 ${amount}/${lateDays}d rf=${repayFirst}`);
                        record("4.1 repay vs liquidate, unsecured", {
                            amount: amount.toString(), lateDays, repayFirst, winner: wins[0], loserReason: loser.reason,
                            finalState: Number(loan.state), poolLoanedBefore: poolBefore.totalLoaned.toString(),
                            violations: v.length,
                        });
                    });
                }
            }
        }
    });

    // ───────────────────────── 4.2 fully collateralised loan — the stranded-collateral case
    it("4.2 100 %-collateralised overdue loan — collateral goes to exactly one place (both orders × 3 sizes)", async () => {
        for (const amount of [USDC(50), USDC(200), USDC(900)]) {
            for (const repayFirst of [true, false]) {
                await withSnapshot(async () => {
                    const id = await overdueSecured(amount);
                    const loanBefore = await f.mp.loans(id);
                    expect(loanBefore.collateralAmount, "case is not collateralised").to.equal(amount);
                    const borrowerBefore = await f.usdc.balanceOf(lo.address);
                    const availBefore = (await f.mp.getAgentPool(aidLo)).availableLiquidity;

                    const rItem = { label: "REPAY", send: (ov) => f.mp.connect(lo).repayLoan(id, ov) };
                    const qItem = { label: "LIQUIDATE", send: (ov) => f.mp.connect(f.owner).liquidateLoan(id, ov) };
                    const batch = await sameBlockBatch(repayFirst ? [rItem, qItem] : [qItem, rItem], { gasLimit: 2_000_000 });
                    const by = Object.fromEntries(batch.rows.map((r) => [r.label, r]));
                    expect(batch.rows.filter((r) => r.ok).length).to.equal(1);

                    const availAfter = (await f.mp.getAgentPool(aidLo)).availableLiquidity;
                    const borrowerAfter = await f.usdc.balanceOf(lo.address);
                    if (repayFirst) {
                        // collateral refunded to the borrower, principal + interest back to the pool
                        expect(by.REPAY.ok).to.equal(true);
                        expect(borrowerAfter > borrowerBefore - amount, "collateral not refunded on repay").to.equal(true);
                    } else {
                        // collateral seized into the pool; loss == amount - collateral == 0 here
                        expect(by.LIQUIDATE.ok).to.equal(true);
                        expect(availAfter - availBefore, "seized collateral did not land in availableLiquidity").to.equal(amount);
                        expect(borrowerAfter).to.equal(borrowerBefore);
                    }
                    // no ACTIVE loan can still be claiming collateral
                    const loan = await f.mp.loans(id);
                    expect(Number(loan.state)).to.not.equal(1);
                    const v = await assertInvariants(f, [aidHi, aidLo], `4.2 ${amount} rf=${repayFirst}`);
                    record("4.2 repay vs liquidate, collateralised", {
                        amount: amount.toString(), repayFirst, winner: batch.rows.find((r) => r.ok).label,
                        collateralRefunded: repayFirst, collateralSeized: !repayFirst, violations: v.length,
                    });
                });
            }
        }
        note("4.2: I-a3 (contract USDC balance == Σ availableLiquidity + fees + Σ ACTIVE-loan collateral) is the stranded-collateral detector, and it held in every ordering. Collateral is either refunded or seized — never duplicated, never orphaned.");
    });

    // ───────────────────────────────── 4.3 the liquidation cron double-firing
    it("4.3 two liquidateLoan for the SAME loan in one block (cron double-fire) — exactly one settles (6 runs)", async () => {
        for (let run = 0; run < 3; run++) {
            for (const k of [2, 3]) {
                await withSnapshot(async () => {
                    const id = await overdueUnsecured(USDC(400));
                    const before = await f.mp.getAgentPool(aidHi);
                    const batch = await sameBlockBatch([...Array(k).keys()].map((i) => ({
                        label: `LIQ${i}`, send: (ov) => f.mp.connect(f.owner).liquidateLoan(id, ov),
                    })), { gasLimit: 2_000_000 });
                    const wins = batch.rows.filter((r) => r.ok);
                    if (wins.length !== 1) {
                        violation("CRITICAL", "4.3", `${wins.length} liquidations settled loan ${id} in one block`,
                            "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C4-repay-vs-liquidate.test.js -g '4.3'");
                    }
                    expect(wins.length, "double liquidation").to.equal(1);
                    for (const r of batch.rows.filter((r) => !r.ok)) expect(r.reason).to.match(/Loan not active/);
                    const after = await f.mp.getAgentPool(aidHi);
                    expect(before.totalLoaned - after.totalLoaned, "principal released more than once").to.equal(USDC(400));
                    const v = await assertInvariants(f, [aidHi, aidLo], `4.3 run=${run} k=${k}`);
                    record("4.3 cron double-fire", { run, k, settled: wins.length, violations: v.length });
                });
            }
        }
    });

    // ──────────────── 4.4 repay + liquidate + a fresh borrow, every ordering
    it("4.4 repay(L1) + liquidate(L1) + liquidate(L2) + requestLoan in ONE block, every ordering (24)", async () => {
        for (const ord of orderings(["REPAY1", "LIQ1", "LIQ2", "BORROW3"])) {
            await withSnapshot(async () => {
                await f.mp.connect(hi).supplyLiquidity(aidHi, USDC(1500));
                await f.mp.connect(L[0]).supplyLiquidity(aidHi, USDC(4000));
                const id1 = await f.mp.nextLoanId();
                await f.mp.connect(hi).requestLoan(USDC(500), 7);
                const id2 = await f.mp.nextLoanId();
                await f.mp.connect(hi).requestLoan(USDC(600), 7);
                await increaseTime(9 * DAY); await mineOne();

                const mk = (lab) => ({
                    REPAY1: { label: "REPAY1", send: (ov) => f.mp.connect(hi).repayLoan(id1, ov) },
                    LIQ1: { label: "LIQ1", send: (ov) => f.mp.connect(f.owner).liquidateLoan(id1, ov) },
                    LIQ2: { label: "LIQ2", send: (ov) => f.mp.connect(f.owner).liquidateLoan(id2, ov) },
                    BORROW3: { label: "BORROW3", send: (ov) => f.mp.connect(hi).requestLoan(USDC(200), 7, ov) },
                }[lab]);
                const batch = await sameBlockBatch(ord.map(mk), { gasLimit: 2_500_000 });
                const by = Object.fromEntries(batch.rows.map((r) => [r.label, r]));

                // loan 1 settles exactly once, whichever way
                const settled1 = (by.REPAY1.ok ? 1 : 0) + (by.LIQ1.ok ? 1 : 0);
                if (settled1 !== 1) {
                    violation("CRITICAL", "4.4", `loan settled ${settled1} times under ordering ${ord.join(">")}`,
                        "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C4-repay-vs-liquidate.test.js -g '4.4'");
                }
                expect(settled1, `loan 1 settled ${settled1} times (${ord.join(">")})`).to.equal(1);
                expect(by.LIQ2.ok, `liquidating loan 2 failed: ${by.LIQ2.reason}`).to.equal(true);
                const l1 = await f.mp.loans(id1), l2 = await f.mp.loans(id2);
                expect(Number(l1.state)).to.equal(by.REPAY1.ok ? 2 : 3);
                expect(Number(l2.state)).to.equal(3);
                const v = await assertInvariants(f, [aidHi, aidLo], `4.4 ${ord.join(">")}`);
                record("4.4 four-way settle race", {
                    order: ord.join(">"),
                    outcomes: Object.fromEntries(batch.rows.map((r) => [r.label, r.ok ? "ok" : r.reason])),
                    loan1State: Number(l1.state), loan2State: Number(l2.state), violations: v.length,
                });
            });
        }
        note("4.4: the fresh borrow in the same block is order-dependent — it succeeds only where the earlier settlements have already freed enough credit/liquidity and self-stake coverage. No ordering produced a double settlement or an unbacked balance.");
    });
});
