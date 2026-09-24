// RACE 6 — credit ladder and reputation rate-limit under racing (the F-04 control).
//
// F-04 is the finding the whole V7 credit model exists to answer: an agent must not be
// able to manufacture credit faster than the levers permit. The levers are
//   * `maxReputationGainPerWindow` / `reputationGainWindow` (5 points per 86,400 s live),
//   * the ladder `min(tierLimit, k·maxRepaidPrincipal + growthStep)`,
//   * `MAX_ACTIVE_LOANS_PER_AGENT` and the AGGREGATE `outstandingPrincipal` check,
//   * the post-default lockout.
//
// All four are per-agent counters read and written by separate transactions, so the
// question is whether firing many of those transactions into ONE block beats them. A
// race that does would matter a great deal, because the whole residual-EV argument for
// launching is priced off these limits.

const {
    USDC, DAY, expect, ethers, sameBlockBatch, deployConc, assertInvariants,
    withSnapshot, increaseTime, mineOne, record, violation, note, dumpResults,
} = require("./_conc");

describe("RACE 6 — credit ladder and rate-limit races", function () {
    let f, agent, aid, L;
    const RATE = 5n; // maxReputationGainPerWindow, as live on Arc mainnet/staging

    before(async () => {
        f = await deployConc({ minSupply: USDC(10), rateLimit: Number(RATE), rateWindow: DAY, minHold: DAY });
        const s = f.signers;
        agent = s[1];
        await f.fund(agent);
        aid = await f.onboardAgent(agent, "r6");
        await f.pumpScore(agent, 600);
        await f.pumpCapacity(agent, USDC(1200)); // ladder = 2*1200 + 100 = 2500 == tier-4 cap
        L = s.slice(10, 20);
        for (const l of L) await f.fund(l, USDC(500_000));
        await f.mp.connect(agent).supplyLiquidity(aid, USDC(1500));  // M2-c stake for 2500 exposure
        await f.mp.connect(L[0]).supplyLiquidity(aid, USDC(20_000));
    });

    after(() => dumpResults("concurrency-results.json"));

    const score = () => f.reputation["getReputationScore(uint256)"](aid);

    // ────────── 6.1 N repayments of the same agent in ONE block vs the rate limit
    it("6.1 up to 10 loans repaid in a SINGLE block — total reputation gain never exceeds the window limit (N = 2,5,10 × 3 runs)", async () => {
        for (const N of [2, 5, 10]) {
            for (let run = 0; run < 3; run++) {
                await withSnapshot(async () => {
                    const ids = [];
                    for (let i = 0; i < N; i++) {
                        ids.push(await f.mp.nextLoanId());
                        await f.mp.connect(agent).requestLoan(USDC(150), 7);
                    }
                    await increaseTime(7 * DAY - 60); await mineOne();
                    const before = await score();
                    const gainedBefore = await f.reputation.gainedInWindow(aid);
                    const windowStartBefore = await f.reputation.windowStart(aid);

                    const batch = await sameBlockBatch(ids.map((id, i) => ({
                        label: `REPAY${i}`, send: (ov) => f.mp.connect(agent).repayLoan(id, ov),
                    })), { gasLimit: 2_500_000 });
                    for (const r of batch.rows) expect(r.ok, `${r.label}: ${r.reason}`).to.equal(true);

                    const after = await score();
                    const gain = after - before;
                    // every repayment in the batch shares one block.timestamp, so the
                    // rolling window can roll at most ONCE for the whole batch.
                    const blockTs = BigInt((await ethers.provider.getBlock(batch.block)).timestamp);
                    const rolled = blockTs >= windowStartBefore + BigInt(DAY);
                    const room = rolled ? RATE : (RATE > gainedBefore ? RATE - gainedBefore : 0n);
                    if (gain > room) {
                        violation("HIGH", "6.1", `${N} same-block repayments gained ${gain} reputation with only ${room} of window head-room left — the D1 rate limit is beatable by batching`,
                            "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C6-ladder-ratelimit-race.test.js -g '6.1'");
                    }
                    expect(gain <= room, `rate limit beaten: gained ${gain}, head-room ${room}`).to.equal(true);
                    expect(await f.reputation.gainedInWindow(aid) <= RATE).to.equal(true);
                    const v = await assertInvariants(f, [aid], `6.1 N=${N} run=${run}`);
                    record("6.1 N same-block repayments vs rate limit", {
                        N, run, scoreBefore: before.toString(), scoreAfter: after.toString(),
                        gain: gain.toString(), windowHeadroom: room.toString(), windowRolled: rolled, violations: v.length,
                    });
                });
            }
        }
    });

    // ───────────── 6.2 the rolling window boundary — how big is the burst, exactly?
    it("6.2 repayments straddling the rate-limit window boundary — the maximum instantaneous burst is bounded at 2× the window limit (6 runs)", async () => {
        for (let run = 0; run < 6; run++) {
            await withSnapshot(async () => {
                // The window is compressed to 1 hour for this test ONLY: loans have a
                // 7-day minimum term, so a 1-day window boundary cannot be straddled
                // without also making the loans late. The LIMIT (5 points) is unchanged
                // and the structural question — can the boundary be raced — is identical.
                const WINDOW = 3600;
                await f.reputation.setReputationRateLimit(Number(RATE), WINDOW);

                const warm = [];
                for (let i = 0; i < 2; i++) { warm.push(await f.mp.nextLoanId()); await f.mp.connect(agent).requestLoan(USDC(150), 7); }
                const a = await f.mp.nextLoanId(); await f.mp.connect(agent).requestLoan(USDC(150), 7);
                const b = await f.mp.nextLoanId(); await f.mp.connect(agent).requestLoan(USDC(150), 7);
                await increaseTime(7 * DAY - 2 * WINDOW); await mineOne();
                for (const id of warm) await f.mp.connect(agent).repayLoan(id);
                const wStart = await f.reputation.windowStart(aid);
                const saturated = await f.reputation.gainedInWindow(aid);
                expect(saturated).to.equal(RATE);

                const now = BigInt((await ethers.provider.getBlock("latest")).timestamp);
                const boundary = wStart + BigInt(WINDOW);
                // land the first repayment one second BEFORE the boundary
                await increaseTime(Number(boundary - now) - 2); await mineOne();
                const s0 = await score();
                await f.mp.connect(agent).repayLoan(a);
                const s1 = await score();
                // and the second one AT the boundary
                await increaseTime(2); await mineOne();
                await f.mp.connect(agent).repayLoan(b);
                const s2 = await score();

                const burst = s2 - s0;
                expect(s1 - s0, "a repayment inside a saturated window still gained").to.equal(0n);
                expect(burst <= 2n * RATE, `burst ${burst} exceeded 2× the window limit`).to.equal(true);
                const v = await assertInvariants(f, [aid], `6.2 run=${run}`);
                record("6.2 window-boundary burst", {
                    run, gainInsideSaturatedWindow: (s1 - s0).toString(), gainAtBoundary: (s2 - s1).toString(),
                    burstAcrossBoundary: burst.toString(), limitPerWindow: RATE.toString(), violations: v.length,
                });
            });
        }
        note("6.2: the window is a RESET-ON-FIRST-GAIN rolling window, so the worst instantaneous burst is `maxGain` at the end of one window plus `maxGain` at the start of the next — bounded at 2× and not improvable by racing, because both gains are still charged to their own window. Sustained rate stays at the configured 5 points/day.");
    });

    // ─────────────── 6.3 the ladder cannot be advanced by the SUM of a batch
    it("6.3 10 differently-sized loans repaid in one block — maxRepaidPrincipal becomes the MAXIMUM, never the sum (4 runs)", async () => {
        for (let run = 0; run < 4; run++) {
            await withSnapshot(async () => {
                const sizes = [USDC(120), USDC(90), USDC(240), USDC(60), USDC(310), USDC(75), USDC(180), USDC(45), USDC(200), USDC(150)];
                const ids = [];
                for (const sz of sizes) { ids.push(await f.mp.nextLoanId()); await f.mp.connect(agent).requestLoan(sz, 7); }
                await increaseTime(7 * DAY - 60); await mineOne();
                const capBefore = await f.reputation.maxRepaidPrincipal(aid);

                const order = run % 2 ? [...ids].reverse() : ids;
                const batch = await sameBlockBatch(order.map((id, i) => ({
                    label: `R${i}`, send: (ov) => f.mp.connect(agent).repayLoan(id, ov),
                })), { gasLimit: 2_500_000 });
                for (const r of batch.rows) expect(r.ok, `${r.label}: ${r.reason}`).to.equal(true);

                const capAfter = await f.reputation.maxRepaidPrincipal(aid);
                const maxSize = sizes.reduce((a, b) => (a > b ? a : b));
                const sumSizes = sizes.reduce((a, b) => a + b, 0n);
                const expected = capBefore > maxSize ? capBefore : maxSize;
                if (capAfter !== expected) {
                    violation("HIGH", "6.3", `maxRepaidPrincipal became ${capAfter} after a same-block batch (expected max(${capBefore}, ${maxSize}); sum was ${sumSizes})`,
                        "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C6-ladder-ratelimit-race.test.js -g '6.3'");
                }
                expect(capAfter, "the ladder advanced by more than the largest single repayment").to.equal(expected);
                expect(capAfter < sumSizes || capBefore >= sumSizes).to.equal(true);
                const v = await assertInvariants(f, [aid], `6.3 run=${run}`);
                record("6.3 ladder advance from a same-block batch", {
                    run, reversed: run % 2 === 1, capBefore: capBefore.toString(), capAfter: capAfter.toString(),
                    largestRepayment: maxSize.toString(), sumOfRepayments: sumSizes.toString(), violations: v.length,
                });
            });
        }
    });

    // ───────── 6.4 concurrent borrows vs the aggregate credit limit and loan cap
    it("6.4 12 requestLoan in ONE block — aggregate outstanding never exceeds the credit limit and never more than 10 land (5 runs)", async () => {
        for (let run = 0; run < 5; run++) {
            await withSnapshot(async () => {
                const limit = await f.reputation.creditLimitOf(aid);
                const each = USDC(240 + run * 5);
                const batch = await sameBlockBatch([...Array(12).keys()].map((i) => ({
                    label: `B${i}`, send: (ov) => f.mp.connect(agent).requestLoan(each, 7, ov),
                })), { gasLimit: 1_000_000 });
                const landed = batch.rows.filter((r) => r.ok).length;
                const op = await f.mp.outstandingPrincipal(aid);
                const cnt = await f.mp.activeLoanCount(aid);

                if (op > limit) {
                    violation("CRITICAL", "6.4", `${landed} same-block borrows left ${op} outstanding against a credit limit of ${limit}`,
                        "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C6-ladder-ratelimit-race.test.js -g '6.4'");
                }
                expect(op <= limit, `aggregate ${op} exceeded credit limit ${limit}`).to.equal(true);
                expect(Number(cnt) <= 10, `active loan cap exceeded: ${cnt}`).to.equal(true);
                expect(landed).to.equal(Number(cnt));
                for (const r of batch.rows.filter((x) => !x.ok)) {
                    expect(r.reason).to.match(/Exceeds credit limit|Too many active loans|Insufficient self-stake|Insufficient pool liquidity/);
                }
                const v = await assertInvariants(f, [aid], `6.4 run=${run}`);
                record("6.4 12 concurrent borrows", {
                    run, each: each.toString(), landed, creditLimit: limit.toString(),
                    outstanding: op.toString(), activeLoanCount: Number(cnt),
                    refusals: [...new Set(batch.rows.filter((x) => !x.ok).map((x) => x.reason))], violations: v.length,
                });
            });
        }
    });

    // ──────── 6.5 repay-to-advance-the-ladder then borrow bigger, in the same block
    it("6.5 repay (advancing the ladder) + a larger borrow in the SAME block, both orders — the borrow is bounded by the ladder as of its own position (6 runs)", async () => {
        for (let run = 0; run < 3; run++) {
            for (const repayFirst of [true, false]) {
                await withSnapshot(async () => {
                    // knock the ladder down, then demonstrate a big repayment
                    const id = await f.mp.nextLoanId();
                    await f.mp.connect(agent).requestLoan(USDC(2000), 7);
                    await increaseTime(7 * DAY - 60); await mineOne();
                    const capBefore = await f.reputation.maxRepaidPrincipal(aid);
                    const limitBefore = await f.reputation.creditLimitOf(aid);

                    const rItem = { label: "REPAY", send: (ov) => f.mp.connect(agent).repayLoan(id, ov) };
                    const bItem = { label: "BORROW", send: (ov) => f.mp.connect(agent).requestLoan(USDC(2500), 7, ov) };
                    const batch = await sameBlockBatch(repayFirst ? [rItem, bItem] : [bItem, rItem], { gasLimit: 2_500_000 });
                    const by = Object.fromEntries(batch.rows.map((r) => [r.label, r]));

                    const op = await f.mp.outstandingPrincipal(aid);
                    const limitAfter = await f.reputation.creditLimitOf(aid);
                    const capAfter = await f.reputation.maxRepaidPrincipal(aid);
                    // the ladder never exceeds the tier cap, and outstanding never exceeds the line
                    expect(limitAfter <= (await f.reputation.MAX_TIER_LIMIT())).to.equal(true);
                    if (op > limitAfter) {
                        violation("HIGH", "6.5", `same-block repay+borrow left ${op} outstanding against a ${limitAfter} line (repayFirst=${repayFirst})`,
                            "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C6-ladder-ratelimit-race.test.js -g '6.5'");
                    }
                    expect(op <= limitAfter, `outstanding ${op} > limit ${limitAfter}`).to.equal(true);
                    const v = await assertInvariants(f, [aid], `6.5 run=${run} rf=${repayFirst}`);
                    record("6.5 ladder advance + larger borrow, same block", {
                        run, repayFirst, capBefore: capBefore.toString(), capAfter: capAfter.toString(),
                        limitBefore: limitBefore.toString(), limitAfter: limitAfter.toString(),
                        borrowOk: by.BORROW.ok, borrowReason: by.BORROW.reason, outstanding: op.toString(), violations: v.length,
                    });
                });
            }
        }
    });

    // ───────────────── 6.6 the post-default lockout racing a fresh borrow
    it("6.6 liquidation (which starts the lockout) + requestLoan in the SAME block, both orders — a locked-out agent never borrows (6 runs)", async () => {
        for (let run = 0; run < 3; run++) {
            for (const liqFirst of [true, false]) {
                await withSnapshot(async () => {
                    const id = await f.mp.nextLoanId();
                    await f.mp.connect(agent).requestLoan(USDC(600), 7);
                    await increaseTime(9 * DAY); await mineOne();

                    const qItem = { label: "LIQUIDATE", send: (ov) => f.mp.connect(f.owner).liquidateLoan(id, ov) };
                    const bItem = { label: "BORROW", send: (ov) => f.mp.connect(agent).requestLoan(USDC(300), 7, ov) };
                    const batch = await sameBlockBatch(liqFirst ? [qItem, bItem] : [bItem, qItem], { gasLimit: 2_500_000 });
                    const by = Object.fromEntries(batch.rows.map((r) => [r.label, r]));
                    expect(by.LIQUIDATE.ok, `liquidation failed: ${by.LIQUIDATE.reason}`).to.equal(true);

                    const lockedOut = await f.reputation.isLockedOut(aid);
                    expect(lockedOut, "a default did not start the lockout").to.equal(true);
                    expect(await f.reputation.creditLimitOf(aid)).to.equal(0n);
                    if (liqFirst && by.BORROW.ok) {
                        violation("HIGH", "6.6", "a borrow landed AFTER the liquidation that locked the agent out, in the same block",
                            "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C6-ladder-ratelimit-race.test.js -g '6.6'");
                    }
                    if (liqFirst) expect(by.BORROW.ok, "borrow succeeded behind the lockout").to.equal(false);
                    // and no borrow is possible in any later block either
                    const later = await f.mp.connect(agent).requestLoan(USDC(10), 7).then(() => true).catch(() => false);
                    expect(later, "a locked-out agent borrowed in a later block").to.equal(false);
                    const v = await assertInvariants(f, [aid], `6.6 run=${run} lf=${liqFirst}`);
                    record("6.6 lockout vs borrow, same block", {
                        run, liquidateFirst: liqFirst, borrowOk: by.BORROW.ok, borrowReason: by.BORROW.reason,
                        lockedOut, creditLimitAfter: "0", laterBorrowBlocked: !later, violations: v.length,
                    });
                });
            }
        }
    });

    // ─────── 6.7 the F-04 control, end to end: racing vs sequential capacity growth
    it("6.7 F-04 control — 12 rounds of ladder growth, batched (racing) vs one-at-a-time, repaid ON TIME, must not favour racing", async () => {
        // Both strategies repay strictly BEFORE endTime. An earlier version warped the
        // full 7 days and every repayment landed LATE, so the comparison was dominated
        // by M1-5 late penalties (4× as many of them on the batched side) rather than by
        // the ladder — a real difference, but not the one this control is asking about.
        const HOLD = 7 * DAY - 600;
        async function grow(batched) {
            await f.reputation.setReputationRateLimit(0, DAY); // isolate the LADDER from the reputation limiter
            let rounds = 0;
            let lateRepayments = 0;
            while (rounds < 12) {
                const limit = await f.reputation.creditLimitOf(aid);
                const avail = (await f.mp.getAgentPool(aid)).availableLiquidity;
                const stake = (await f.mp.selfStake(aid)).amount;
                let draw = limit < avail ? limit : avail;
                if (draw > stake * 2n) draw = stake * 2n;   // M2-c: exposure <= 2 * stake
                if (draw === 0n) break;
                if (batched) {
                    // four loans at once, repaid all at once — the racing strategy
                    const per = draw / 4n;
                    if (per === 0n) break;
                    const ids = [];
                    const b1 = await sameBlockBatch([...Array(4).keys()].map((i) => ({
                        label: `B${i}`, send: (ov) => f.mp.connect(agent).requestLoan(per, 7, ov),
                    })), { gasLimit: 1_000_000 });
                    for (const r of b1.rows) if (r.ok) ids.push(null);
                    const first = Number(await f.mp.nextLoanId()) - b1.rows.filter((r) => r.ok).length;
                    const realIds = [...Array(b1.rows.filter((r) => r.ok).length).keys()].map((i) => first + i);
                    await increaseTime(HOLD); await mineOne();
                    for (const id of realIds) if ((await f.mp.repayments(id)).repaidAt === 0n) { /* not yet repaid */ }
                    const rb = await sameBlockBatch(realIds.map((id, i) => ({
                        label: `R${i}`, send: (ov) => f.mp.connect(agent).repayLoan(id, ov),
                    })), { gasLimit: 2_500_000 });
                    for (const id of realIds) if ((await f.mp.repayments(id)).lateSeconds > 0n) lateRepayments++;
                    void rb;
                } else {
                    const id = await f.mp.nextLoanId();
                    await f.mp.connect(agent).requestLoan(draw, 7);
                    await increaseTime(HOLD); await mineOne();
                    await f.mp.connect(agent).repayLoan(id);
                    if ((await f.mp.repayments(id)).lateSeconds > 0n) lateRepayments++;
                }
                rounds++;
            }
            return {
                rounds, lateRepayments,
                score: await f.reputation["getReputationScore(uint256)"](aid),
                cap: await f.reputation.maxRepaidPrincipal(aid),
                limit: await f.reputation.creditLimitOf(aid),
            };
        }

        let batched, sequential;
        await withSnapshot(async () => { batched = await grow(true); });
        await withSnapshot(async () => { sequential = await grow(false); });

        if (batched.limit > sequential.limit) {
            violation("HIGH", "6.7", `batching beat sequential growth: credit limit ${batched.limit} vs ${sequential.limit} after the same number of rounds and the same elapsed time`,
                "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C6-ladder-ratelimit-race.test.js -g '6.7'");
        }
        expect(batched.limit <= sequential.limit, "racing produced MORE credit capacity than sequential").to.equal(true);
        expect(batched.lateRepayments, "the batched arm must repay on time for this comparison to isolate the ladder").to.equal(0);
        expect(sequential.lateRepayments, "the sequential arm must repay on time too").to.equal(0);
        record("6.7 F-04 control: batched vs sequential ladder growth", {
            batched: { rounds: batched.rounds, late: batched.lateRepayments, score: batched.score.toString(), maxRepaid: batched.cap.toString(), creditLimit: batched.limit.toString() },
            sequential: { rounds: sequential.rounds, late: sequential.lateRepayments, score: sequential.score.toString(), maxRepaid: sequential.cap.toString(), creditLimit: sequential.limit.toString() },
            racingAdvantage: (batched.limit - sequential.limit).toString(), violations: 0,
        });
        note(`6.7: with every repayment ON TIME, splitting each round into four concurrent loans reached maxRepaidPrincipal ${batched.cap} / credit limit ${batched.limit}, where one-at-a-time reached ${sequential.cap} / ${sequential.limit}. Batching is never better and is usually WORSE, because the ladder keys on the largest SINGLE on-time repayment and splitting shrinks it. (Racing late is worse again: the M1-5 penalty is charged per repayment, so four concurrent late loans cost four penalties.)`);
    });
});
