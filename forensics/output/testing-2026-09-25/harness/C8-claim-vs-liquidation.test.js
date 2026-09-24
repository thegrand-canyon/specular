// RACE 8 — `claimInterest` racing a LOSSY liquidation in the same block.
//
// This one is not in the original six but falls straight out of them. D4 fixed
// first-come-first-served withdrawal for PRINCIPAL: a lossy liquidation now socialises
// the shortfall pro-rata across `position.amount`, so an alert lender can no longer exit
// whole and dump the loss on the last one out. F-05 then extended the waterfall to
// UNCLAIMED INTEREST when the loss exceeds all principal (`_socializeInterestLoss`).
//
// But unclaimed interest is still a claimable balance, and `claimInterest` is a separate
// transaction. So the question D4 asked about principal has to be asked again about
// interest: if a lender claims in the SAME BLOCK as the liquidation, does the ordering
// decide who bears the loss?
//
// What is asserted regardless of the answer: solvency, per-pool conservation, and that
// every remaining claim stays backed (the F-05 invariant). What is MEASURED is the
// distributional difference between the two orderings.

const {
    USDC, DAY, expect, sameBlockBatch, deployConc, assertInvariants,
    withSnapshot, increaseTime, mineOne, record, violation, note, dumpResults,
} = require("./_conc");

describe("RACE 8 — claimInterest vs a lossy liquidation", function () {
    let f, agent, aid, LA, LB;

    before(async () => {
        f = await deployConc({ minSupply: USDC(10), minHold: 0 });
        const s = f.signers;
        agent = s[1];
        await f.fund(agent);
        aid = await f.onboardAgent(agent, "r8");
        await f.pumpScore(agent, 600);
        await f.pumpCapacity(agent, USDC(1000));
        [LA, LB] = [s[10], s[11]];
        for (const l of [LA, LB]) await f.fund(l, USDC(500_000));
    });

    after(() => dumpResults("concurrency-results.json"));

    /**
     * Build a pool whose only remaining principal is the creator's self-stake and whose
     * unclaimed-interest pile is large enough that a default eats into it:
     *   1. creator stakes 500, LA and LB supply 1,000 each;
     *   2. a 365-day loan is taken and repaid on time, minting a real interest pile;
     *   3. LA and LB withdraw ALL principal but do NOT claim — they keep their slots
     *      (the H-2 carve-out) and their earnedInterest;
     *   4. the agent borrows more than its own stake, so the default's loss overruns the
     *      self-stake and the remaining principal, and reaches interest.
     */
    async function lossyPoolWithInterest(delta) {
        await f.mp.connect(agent).supplyLiquidity(aid, USDC(500));
        await f.mp.connect(LA).supplyLiquidity(aid, USDC(1000));
        await f.mp.connect(LB).supplyLiquidity(aid, USDC(1000));
        const id1 = await f.mp.nextLoanId();
        await f.mp.connect(agent).requestLoan(USDC(1000), 365);
        await increaseTime(364 * DAY); await mineOne();
        await f.mp.connect(agent).repayLoan(id1);

        await f.mp.connect(LA).withdrawLiquidity(aid, USDC(1000));
        await f.mp.connect(LB).withdrawLiquidity(aid, USDC(1000));

        const pool = await f.mp.getAgentPool(aid);
        const stake = (await f.mp.selfStake(aid)).amount;
        const earnedA = (await f.mp.positions(aid, LA.address)).earnedInterest;
        const earnedB = (await f.mp.positions(aid, LB.address)).earnedInterest;
        expect(earnedA > 0n && earnedB > 0n, "the interest pile did not build").to.equal(true);
        // Borrow `Σ principal + delta`, so the default's loss overruns all principal by
        // exactly `delta` and that much must come out of unclaimed interest.
        //   * delta == null  → draw the pool to the floor (the "fully drawn" regime);
        //   * delta small    → leave enough availableLiquidity that a claim is still
        //                      payable, which is the regime where the ordering can matter.
        const principal = pool.totalLiquidity;
        const borrow = delta === null ? pool.availableLiquidity - 1n : principal + delta;
        expect(borrow > stake, "the loan must exceed the self-stake for this race to bite").to.equal(true);
        expect(borrow <= pool.availableLiquidity, "not enough liquidity for the chosen delta").to.equal(true);
        const id2 = await f.mp.nextLoanId();
        await f.mp.connect(agent).requestLoan(borrow, 7);
        await increaseTime(9 * DAY); await mineOne();
        const availAfterDraw = (await f.mp.getAgentPool(aid)).availableLiquidity;
        return { id: id2, borrow, stake, earnedA, earnedB, principal, availAfterDraw };
    }

    it("8.1 lossy liquidation + claimInterest in ONE block, both orders, two draw-down regimes — solvency and F-05 hold; the ordering decides who bears the interest loss", async () => {
        const outcomes = [];
        // delta = how far the loss overruns ALL principal, i.e. how much must come out
        // of unclaimed interest. `null` = draw the pool to the floor.
        const REGIMES = [
            { label: "partially drawn (claim still payable)", delta: USDC(20) },
            { label: "partially drawn, larger overrun", delta: USDC(35) },
            { label: "fully drawn to the floor", delta: null },
        ];
        for (const regime of REGIMES) {
            for (const claimFirst of [true, false]) {
                const run = regime.label;
                await withSnapshot(async () => {
                    const setup = await lossyPoolWithInterest(regime.delta);
                    const balA0 = await f.usdc.balanceOf(LA.address);
                    const earnedB0 = (await f.mp.positions(aid, LB.address)).earnedInterest;

                    const cItem = { label: "CLAIM_A", send: (ov) => f.mp.connect(LA).claimInterest(aid, ov) };
                    const qItem = { label: "LIQUIDATE", send: (ov) => f.mp.connect(f.owner).liquidateLoan(setup.id, ov) };
                    const batch = await sameBlockBatch(claimFirst ? [cItem, qItem] : [qItem, cItem], { gasLimit: 2_500_000 });
                    const by = Object.fromEntries(batch.rows.map((r) => [r.label, r]));
                    expect(by.LIQUIDATE.ok, `liquidation failed: ${by.LIQUIDATE.reason}`).to.equal(true);

                    const receivedA = (await f.usdc.balanceOf(LA.address)) - balA0;
                    const leftA = (await f.mp.positions(aid, LA.address)).earnedInterest;
                    const leftB = (await f.mp.positions(aid, LB.address)).earnedInterest;

                    // the invariants that must hold either way
                    const v = await assertInvariants(f, [aid], `8.1 run=${run} claimFirst=${claimFirst}`);
                    // F-05: every remaining claim is still backed
                    const p = await f.mp.getAgentPool(aid);
                    expect(p.availableLiquidity >= leftA + leftB, "a remaining interest claim is unbacked").to.equal(true);

                    outcomes.push({
                        run, claimFirst, claimOk: by.CLAIM_A.ok, claimReason: by.CLAIM_A.reason,
                        principalBeforeLoss: setup.principal.toString(),
                        loanAmount: setup.borrow.toString(),
                        availableAfterDraw: setup.availAfterDraw.toString(),
                        interestBefore: setup.earnedA.toString(),
                        receivedByA: receivedA.toString(), leftToA: leftA.toString(),
                        bEarnedBefore: earnedB0.toString(), bEarnedAfter: leftB.toString(),
                        bLostToSocialisation: (earnedB0 - leftB).toString(), violations: v.length,
                    });
                    record("8.1 claimInterest vs lossy liquidation", outcomes[outcomes.length - 1]);
                });
            }
        }

        // compare the two orderings of the SAME regime
        for (const regime of REGIMES) {
            const run = regime.label;
            const first = outcomes.find((o) => o.run === run && o.claimFirst);
            const after = outcomes.find((o) => o.run === run && !o.claimFirst);
            const gain = BigInt(first.receivedByA) - BigInt(after.receivedByA);
            if (gain > 0n) {
                violation("LOW", "8.1",
                    `claiming AHEAD of a lossy liquidation in the same block let the lender keep ${gain} more base units of interest than claiming behind it `
                    + `(${first.receivedByA} vs ${after.receivedByA}); the difference is borne by the lenders who had not claimed. `
                    + `D4 removed this first-come-first-served asymmetry for PRINCIPAL; it survives for UNCLAIMED INTEREST because a claim is a separate transaction.`,
                    "npx hardhat --config hardhat.concurrency.config.js test forensics/output/testing-2026-09-25/harness/C8-claim-vs-liquidation.test.js");
            }
            record("8.1 ordering comparison", {
                regime: run, claimPayableBeforeLiquidation: first.claimOk,
                claimedFirstReceived: first.receivedByA, claimedAfterReceived: after.receivedByA,
                advantageOfClaimingFirst: gain.toString(),
                otherLenderLossWhenClaimFirst: first.bLostToSocialisation,
                otherLenderLossWhenLiquidateFirst: after.bLostToSocialisation,
            });
        }
        note("8.1: solvency, per-pool conservation and the F-05 'every remaining claim stays backed' property hold in BOTH orderings and BOTH regimes — the protocol is never left short. The distributional answer depends on how far the pool was drawn down: when it is drawn to the floor, `claimInterest` reverts 'Drain underflow' whichever way the block is ordered, so no lender can get out ahead of the loss; when the pool is only partially drawn, a lender who claims AHEAD of the liquidation keeps its whole balance and the shortfall falls on the lenders who did not. That is the first-come-first-served shape D4 removed for principal, surviving for unclaimed interest because a claim is a separate transaction.");
    });
});
