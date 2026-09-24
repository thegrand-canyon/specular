// RACE 3 — the M2 self-stake lock under racing.
//
// M2-a locks the pool creator's own position for as long as `outstandingPrincipal > 0`;
// M2-c refuses a loan unless the creator already holds `unsecured / k` of first-loss
// capital. Those are two DIFFERENT storage reads in two DIFFERENT transactions, so the
// obvious attack is to get them out of step: withdraw the stake in the same block as
// the borrow and keep both.
//
// What must hold, and is asserted after every permutation:
//   P1  there is NO state in which `outstandingPrincipal > 0` AND the creator can
//       withdraw (checked as a staticCall probe at every block of the sweep);
//   P2  after any successful `requestLoan`, `selfStake >= requiredSelfStake` — the
//       coverage is computed against the principal the loan itself creates, so a
//       withdrawal that precedes it in the same block is already visible to it;
//   P3  no permutation of {withdraw, requestLoan, repayLoan} leaves principal
//       outstanding against a stake below the requirement.

const {
    USDC, DAY, expect, sameBlockBatch, deployConc, assertInvariants,
    withSnapshot, orderings, increaseTime, mineOne, record, violation, note, dumpResults,
} = require("./_conc");

describe("RACE 3 — self-stake lock (M2) races", function () {
    let f, agent, aid, L;

    before(async () => {
        f = await deployConc({ minSupply: USDC(10), minHold: 0 });
        const s = f.signers;
        agent = s[1];
        await f.fund(agent);
        aid = await f.onboardAgent(agent, "r3");
        await f.pumpScore(agent, 600);            // 0 % collateral → M2-c gate active
        await f.pumpCapacity(agent, USDC(1000));  // ladder 2100
        L = s.slice(10, 20);
        for (const l of L) await f.fund(l, USDC(500_000));
    });

    after(() => dumpResults("concurrency-results.json"));

    async function setup(stake, lenderSupply) {
        await f.mp.connect(agent).supplyLiquidity(aid, stake);
        await f.mp.connect(L[0]).supplyLiquidity(aid, lenderSupply);
    }
    const required = (exposure) => exposure / 2n; // k = 2, collateralPercent = 0

    // ─────────────────────── 3.1 creator withdraw vs own borrow, in the same block
    it("3.1 creator withdraw + own requestLoan in ONE block, both orders × 8 stake/withdraw/borrow combinations", async () => {
        const cases = [
            // stake, withdraw, borrow  → after a withdraw-first the stake must still cover borrow/2
            [USDC(600), USDC(200), USDC(1000)],  // 400 < 500 → loan must fail if withdraw lands first
            [USDC(600), USDC(100), USDC(1000)],  // 500 == 500 → exactly covered
            [USDC(600), USDC(101), USDC(1000)],  // 499 < 500 → one base unit short
            [USDC(1200), USDC(200), USDC(1000)], // amply covered either way
            [USDC(600), USDC(600), USDC(1000)],  // full exit
            [USDC(600), USDC(599), USDC(200)],   // tiny loan, stake almost gone
            [USDC(500), USDC(1), USDC(1000)],    // 499 < 500
            [USDC(1000), USDC(500), USDC(1000)], // 500 == 500
        ];
        for (const [stake, wd, borrow] of cases) {
            for (const borrowFirst of [true, false]) {
                await withSnapshot(async () => {
                    await setup(stake, USDC(3000));
                    const wItem = { label: "WITHDRAW", send: (ov) => f.mp.connect(agent).withdrawLiquidity(aid, wd, ov) };
                    const bItem = { label: "BORROW", send: (ov) => f.mp.connect(agent).requestLoan(borrow, 7, ov) };
                    const batch = await sameBlockBatch(borrowFirst ? [bItem, wItem] : [wItem, bItem], { gasLimit: 1_500_000 });
                    const by = Object.fromEntries(batch.rows.map((r) => [r.label, r]));

                    const ss = await f.mp.selfStake(aid);
                    const op = await f.mp.outstandingPrincipal(aid);

                    if (borrowFirst) {
                        expect(by.BORROW.ok, `borrow failed: ${by.BORROW.reason}`).to.equal(true);
                        if (by.WITHDRAW.ok) {
                            violation("CRITICAL", "3.1", `creator withdrew ${wd} in the same block as a ${borrow} borrow — stake and loan both went through`,
                                "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C3-selfstake-lock-race.test.js -g '3.1'");
                        }
                        expect(by.WITHDRAW.ok, "creator withdrew while borrowing").to.equal(false);
                        expect(by.WITHDRAW.reason).to.match(/Self-stake locked while borrowing/);
                        expect(ss.amount).to.equal(stake);
                        expect(ss.locked).to.equal(true);
                    } else {
                        expect(by.WITHDRAW.ok, `withdraw failed: ${by.WITHDRAW.reason}`).to.equal(true);
                        const remaining = stake - wd;
                        const canCover = remaining >= required(borrow);
                        expect(by.BORROW.ok, `borrow outcome wrong (stake left ${remaining}, needs ${required(borrow)}): ${by.BORROW.reason}`).to.equal(canCover);
                        if (!canCover) expect(by.BORROW.reason).to.match(/Insufficient self-stake/);
                    }
                    if (op > 0n) {
                        expect(ss.amount >= required(op), `P2 broken: stake ${ss.amount} < required ${required(op)}`).to.equal(true);
                    }
                    const v = await assertInvariants(f, [aid], `3.1 ${stake}/${wd}/${borrow} bf=${borrowFirst}`);
                    record("3.1 creator withdraw vs own borrow, same block", {
                        stake: stake.toString(), withdraw: wd.toString(), borrow: borrow.toString(), borrowFirst,
                        withdrawOk: by.WITHDRAW.ok, borrowOk: by.BORROW.ok,
                        withdrawReason: by.WITHDRAW.reason, borrowReason: by.BORROW.reason,
                        finalStake: ss.amount.toString(), outstanding: op.toString(), violations: v.length,
                    });
                });
            }
        }
        note("3.1: the lock and the coverage gate read the SAME two storage slots the two calls write, so they cannot get out of step — withdraw-first simply makes the borrow fail the M2-c check, borrow-first makes the withdraw fail the M2-a lock. There is no ordering in which both land while coverage is short.");
    });

    // ───────────────────── 3.2 the block immediately before and immediately after
    it("3.2 withdraw one block BEFORE / one block AFTER the borrow — and a per-block probe proving no window exists (12 runs)", async () => {
        for (let run = 0; run < 6; run++) {
            for (const before of [true, false]) {
                await withSnapshot(async () => {
                    await setup(USDC(600), USDC(3000));
                    const probes = [];
                    const probe = async (tag) => {
                        const op = await f.mp.outstandingPrincipal(aid);
                        let can = false;
                        try { await f.mp.connect(agent).withdrawLiquidity.staticCall(aid, 1n); can = true; } catch { /* locked */ }
                        probes.push({ tag, outstanding: op.toString(), creatorCanWithdraw: can });
                        if (op > 0n && can) {
                            violation("CRITICAL", "3.2", `window found at ${tag}: outstandingPrincipal=${op} and the creator's withdraw is permitted`,
                                "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C3-selfstake-lock-race.test.js -g '3.2'");
                        }
                        expect(op === 0n || !can, `P1 broken at ${tag}`).to.equal(true);
                    };

                    await probe("t0 (no loan)");
                    if (before) {
                        await f.mp.connect(agent).withdrawLiquidity(aid, USDC(100)); // stake 500
                        await probe("after withdraw, before borrow");
                        const r = await f.mp.connect(agent).requestLoan(USDC(1000), 7).then(() => true).catch(() => false);
                        expect(r, "borrow at exactly the covered boundary should succeed").to.equal(true);
                        await probe("after borrow");
                    } else {
                        await f.mp.connect(agent).requestLoan(USDC(1000), 7);
                        await probe("immediately after borrow");
                        await mineOne(); await probe("+1 block");
                        await increaseTime(3 * DAY); await mineOne(); await probe("+3 days");
                        const w = await f.mp.connect(agent).withdrawLiquidity(aid, 1n).then(() => true).catch(() => false);
                        expect(w, "creator withdrew while a loan was outstanding").to.equal(false);
                        await f.mp.connect(agent).repayLoan(1);
                        await probe("after repay");
                        const w2 = await f.mp.connect(agent).withdrawLiquidity(aid, USDC(100)).then(() => true).catch(() => false);
                        expect(w2, "creator could not withdraw after the loan closed").to.equal(true);
                    }
                    const v = await assertInvariants(f, [aid], `3.2 run=${run} before=${before}`);
                    record("3.2 lock window sweep", { run, withdrawBeforeBorrow: before, probes, violations: v.length });
                });
            }
        }
    });

    // ─────────────────── 3.3 repay / withdraw / re-borrow, every ordering in a block
    it("3.3 repay + creator withdraw + new borrow in ONE block, every ordering (6) × 3 stake levels", async () => {
        for (const stake of [USDC(600), USDC(1000), USDC(1500)]) {
            for (const ord of orderings(["REPAY", "WITHDRAW", "BORROW2"])) {
                await withSnapshot(async () => {
                    await setup(stake, USDC(4000));
                    await f.mp.connect(agent).requestLoan(USDC(1000), 7);
                    await increaseTime(2 * DAY); await mineOne();

                    const mk = (lab) => ({
                        REPAY: { label: "REPAY", send: (ov) => f.mp.connect(agent).repayLoan(1, ov) },
                        WITHDRAW: { label: "WITHDRAW", send: (ov) => f.mp.connect(agent).withdrawLiquidity(aid, USDC(500), ov) },
                        BORROW2: { label: "BORROW2", send: (ov) => f.mp.connect(agent).requestLoan(USDC(800), 7, ov) },
                    }[lab]);
                    const batch = await sameBlockBatch(ord.map(mk), { gasLimit: 2_000_000 });
                    const by = Object.fromEntries(batch.rows.map((r) => [r.label, r]));

                    const op = await f.mp.outstandingPrincipal(aid);
                    const ss = await f.mp.selfStake(aid);
                    if (op > 0n && ss.amount < required(op)) {
                        violation("CRITICAL", "3.3", `ordering ${ord.join(">")} (stake ${stake}) left outstanding ${op} against stake ${ss.amount} < required ${required(op)}`,
                            "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C3-selfstake-lock-race.test.js -g '3.3'");
                    }
                    expect(op === 0n || ss.amount >= required(op), "P3 broken").to.equal(true);
                    // the withdraw can only have landed while nothing was outstanding at that instant
                    if (by.WITHDRAW.ok) {
                        const repayIdx = by.REPAY.ok ? by.REPAY.index : 1e9;
                        expect(by.WITHDRAW.index > repayIdx || !by.REPAY.ok === false,
                            "a creator withdrawal landed without the repayment that unlocked it").to.equal(true);
                    }
                    const v = await assertInvariants(f, [aid], `3.3 ${stake} ${ord.join(">")}`);
                    record("3.3 repay/withdraw/re-borrow permutations", {
                        stake: stake.toString(), order: ord.join(">"),
                        outcomes: Object.fromEntries(batch.rows.map((r) => [r.label, r.ok ? "ok" : r.reason])),
                        finalOutstanding: op.toString(), finalStake: ss.amount.toString(), violations: v.length,
                    });
                });
            }
        }
    });

    // ───────────── 3.4 two active loans: repaying one must not unlock the stake
    it("3.4 two active loans, repay one and withdraw the stake in the same block, both orders (6 runs)", async () => {
        for (let run = 0; run < 3; run++) {
            for (const repayFirst of [true, false]) {
                await withSnapshot(async () => {
                    await setup(USDC(1500), USDC(5000));
                    await f.mp.connect(agent).requestLoan(USDC(800), 7);
                    await f.mp.connect(agent).requestLoan(USDC(700), 7);
                    expect(await f.mp.outstandingPrincipal(aid)).to.equal(USDC(1500));
                    await increaseTime(2 * DAY); await mineOne();

                    const rItem = { label: "REPAY1", send: (ov) => f.mp.connect(agent).repayLoan(1, ov) };
                    const wItem = { label: "WITHDRAW", send: (ov) => f.mp.connect(agent).withdrawLiquidity(aid, USDC(100), ov) };
                    const batch = await sameBlockBatch(repayFirst ? [rItem, wItem] : [wItem, rItem], { gasLimit: 2_000_000 });
                    const by = Object.fromEntries(batch.rows.map((r) => [r.label, r]));

                    expect(by.REPAY1.ok, `repay failed: ${by.REPAY1.reason}`).to.equal(true);
                    if (by.WITHDRAW.ok) {
                        violation("CRITICAL", "3.4", "creator withdrew stake while a second loan was still outstanding",
                            "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C3-selfstake-lock-race.test.js -g '3.4'");
                    }
                    expect(by.WITHDRAW.ok, "stake unlocked by closing only ONE of two loans").to.equal(false);
                    expect(by.WITHDRAW.reason).to.match(/Self-stake locked while borrowing/);
                    expect(await f.mp.outstandingPrincipal(aid)).to.equal(USDC(700));
                    const v = await assertInvariants(f, [aid], `3.4 run=${run} rf=${repayFirst}`);
                    record("3.4 partial repay must not unlock the stake", {
                        run, repayFirst, withdrawOk: by.WITHDRAW.ok, reason: by.WITHDRAW.reason,
                        remainingOutstanding: (await f.mp.outstandingPrincipal(aid)).toString(), violations: v.length,
                    });
                });
            }
        }
    });

    // ─────────── 3.5 randomised sweep: probe the lock after every single transaction
    it("3.5 randomised operation sweep (40 runs × 12 ops) probing the lock after EVERY transaction", async () => {
        let probes = 0;
        for (let run = 0; run < 40; run++) {
            await withSnapshot(async () => {
                await setup(USDC(2000), USDC(6000));
                let seed = 1013904223 + run * 1664525;
                const rnd = (n) => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % n; };
                const openIds = [];
                let nextId = Number(await f.mp.nextLoanId());
                for (let step = 0; step < 12; step++) {
                    const op = rnd(4);
                    try {
                        if (op === 0) { await f.mp.connect(agent).requestLoan(USDC(100 + rnd(500)), 7); openIds.push(nextId++); }
                        else if (op === 1 && openIds.length) { const id = openIds.splice(rnd(openIds.length), 1)[0]; await f.mp.connect(agent).repayLoan(id); }
                        else if (op === 2) { await f.mp.connect(agent).withdrawLiquidity(aid, USDC(1 + rnd(200))); }
                        else { await f.mp.connect(agent).supplyLiquidity(aid, USDC(1 + rnd(200))); }
                    } catch { /* refusals are the expected outcome half the time */ }
                    if (rnd(3) === 0) { await increaseTime(DAY); await mineOne(); }

                    const outstanding = await f.mp.outstandingPrincipal(aid);
                    let can = false;
                    try { await f.mp.connect(agent).withdrawLiquidity.staticCall(aid, 1n); can = true; } catch { /* locked */ }
                    probes++;
                    if (outstanding > 0n && can) {
                        violation("CRITICAL", "3.5", `run ${run} step ${step}: outstanding ${outstanding} with the creator's withdraw permitted`,
                            "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C3-selfstake-lock-race.test.js -g '3.5'");
                    }
                    expect(outstanding === 0n || !can, `P1 broken run=${run} step=${step}`).to.equal(true);
                    if (outstanding > 0n) {
                        const ss = await f.mp.selfStake(aid);
                        expect(ss.amount >= required(outstanding), `P2 broken run=${run} step=${step}: ${ss.amount} < ${required(outstanding)}`).to.equal(true);
                    }
                }
                await assertInvariants(f, [aid], `3.5 run=${run}`);
            });
        }
        record("3.5 randomised lock sweep", { runs: 40, opsPerRun: 12, probes, violations: 0 });
        note(`3.5: ${probes} lock probes across 40 randomised runs, every one after a real transaction. The creator's withdraw was permitted only while outstandingPrincipal was exactly 0.`);
    });
});
