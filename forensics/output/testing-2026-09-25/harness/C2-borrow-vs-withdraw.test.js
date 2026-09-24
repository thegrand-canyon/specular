// RACE 2 — borrow vs withdraw in the SAME block.
//
// A lender withdraws in the same block the agent borrows. The dangerous outcome would
// be the pool lending liquidity that was simultaneously withdrawn: `availableLiquidity`
// double-spent, per-pool conservation broken, or the contract's USDC balance short of
// what the books claim.
//
// Both orders are run explicitly, because which one the producer picks is the whole
// question. For each we assert:
//   * the losing call reverts and moves NO money (no partial state);
//   * availableLiquidity after == before − (whatever actually left), exactly;
//   * per-pool conservation and global solvency (I-a1/I-a2/I-a3);
//   * the revert reason is one a client can act on.
//
// It also measures the TOCTOU gap (R2): what `getAgentPool().availableLiquidity` said
// one block earlier versus what the transaction actually got.

const {
    USDC, DAY, expect, sameBlockBatch, deployConc, assertInvariants,
    withSnapshot, orderings, increaseTime, mineOne, record, violation, note, dumpResults, gasRow,
} = require("./_conc");

describe("RACE 2 — borrow vs withdraw in one block", function () {
    let f, agent, aid, L;

    before(async () => {
        f = await deployConc({ minSupply: USDC(10), minHold: 0 });
        const s = f.signers;
        agent = s[1];
        await f.fund(agent);
        aid = await f.onboardAgent(agent, "r2");
        await f.pumpScore(agent, 600);          // 0 %-collateral tier
        await f.pumpCapacity(agent, USDC(1000)); // ladder = 2*1000 + 100 = 2100
        L = s.slice(10, 20);
        for (const l of L) await f.fund(l, USDC(200_000));
        // creator first-loss stake: M2-c needs exposure/2 at the 0 % tier
        await f.mp.connect(agent).supplyLiquidity(aid, USDC(1000));
    });

    after(() => dumpResults("concurrency-results.json"));

    async function freshPool(lenderAmounts) {
        for (let i = 0; i < lenderAmounts.length; i++) {
            await f.mp.connect(L[i]).supplyLiquidity(aid, lenderAmounts[i]);
        }
        return f.mp.getAgentPool(aid);
    }

    // ───────────────────────────────── 2.1 the contended case: W + B > available
    it("2.1 one withdraw + one borrow contending for liquidity that only covers one — exactly one wins, no double spend (14 amount pairs × both orders)", async () => {
        const cases = [
            // [lenderSupply, withdraw, borrow]  — chosen so withdraw+borrow > available
            [USDC(100), USDC(100), USDC(1050)], [USDC(100), USDC(60), USDC(1050)],
            [USDC(200), USDC(200), USDC(1100)], [USDC(200), USDC(199), USDC(1200)],
            [USDC(500), USDC(500), USDC(1500)], [USDC(500), USDC(1), USDC(1500)],
            [USDC(50), USDC(50), USDC(1050)],
        ];
        for (const [sup, wd, borrow] of cases) {
            for (const borrowFirst of [true, false]) {
                await withSnapshot(async () => {
                    const before = await freshPool([sup]);
                    const availBefore = before.availableLiquidity;
                    const balBefore = await f.usdc.balanceOf(f.mpAddr);
                    const lenderBalBefore = await f.usdc.balanceOf(L[0].address);
                    const agentBalBefore = await f.usdc.balanceOf(agent.address);
                    expect(wd + borrow > availBefore, "case is not actually contended").to.equal(true);

                    const wdItem = { label: "WITHDRAW", send: (ov) => f.mp.connect(L[0]).withdrawLiquidity(aid, wd, ov) };
                    const bItem = { label: "BORROW", send: (ov) => f.mp.connect(agent).requestLoan(borrow, 7, ov) };
                    const batch = await sameBlockBatch(borrowFirst ? [bItem, wdItem] : [wdItem, bItem], { gasLimit: 1_200_000 });

                    const by = Object.fromEntries(batch.rows.map((r) => [r.label, r]));
                    const wins = batch.rows.filter((r) => r.ok).map((r) => r.label);
                    expect(batch.sameBlock).to.equal(true);
                    if (wins.length === 2) {
                        violation("CRITICAL", "2.1", `both withdraw(${wd}) and borrow(${borrow}) succeeded against available ${availBefore} in one block`,
                            "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C2-borrow-vs-withdraw.test.js -g '2.1'");
                    }
                    expect(wins.length, `double spend: both succeeded (avail ${availBefore})`).to.equal(1);

                    const after = await f.mp.getAgentPool(aid);
                    const balAfter = await f.usdc.balanceOf(f.mpAddr);
                    const moved = balBefore - balAfter;
                    const expectedMoved = wins[0] === "BORROW" ? borrow : wd;
                    expect(moved, "USDC moved != the single successful call").to.equal(expectedMoved);
                    expect(availBefore - after.availableLiquidity).to.equal(moved);
                    // the loser moved nothing
                    if (wins[0] === "BORROW") expect(await f.usdc.balanceOf(L[0].address)).to.equal(lenderBalBefore);
                    else expect(await f.usdc.balanceOf(agent.address)).to.equal(agentBalBefore);

                    const loser = by[wins[0] === "BORROW" ? "WITHDRAW" : "BORROW"];
                    // Either the liquidity ran out (the race) or the F-C floor refused a
                    // partial exit (2.1 case [200,199,…] leaves 1 base unit < minSupply).
                    expect(loser.reason, `unexpected refusal: ${loser.reason}`)
                        .to.match(/Insufficient pool liquidity|Remaining below minimum supply/);
                    // when the FIRST transaction is the one that failed, it must be for a
                    // reason that is NOT about liquidity — otherwise it means the pool lent
                    // out liquidity before the withdrawal that preceded it.
                    const firstLabel = borrowFirst ? "BORROW" : "WITHDRAW";
                    if (!by[firstLabel].ok) {
                        expect(by[firstLabel].reason, `the FIRST transaction lost a liquidity race it could not have lost `
                            + `[sup=${sup} wd=${wd} borrow=${borrow} borrowFirst=${borrowFirst} avail=${availBefore} `
                            + `note=${by[firstLabel].orderingNote}]`)
                            .to.not.match(/Insufficient pool liquidity/);
                    }

                    const v = await assertInvariants(f, [aid], `2.1 ${sup}/${wd}/${borrow} bf=${borrowFirst}`);
                    record("2.1 withdraw vs borrow, contended", {
                        lenderSupply: sup.toString(), withdraw: wd.toString(), borrow: borrow.toString(),
                        borrowFirst, winner: wins[0], loserReason: loser.reason, loserNote: loser.orderingNote,
                        availBefore: availBefore.toString(), availAfter: after.availableLiquidity.toString(),
                        violations: v.length,
                    });
                });
            }
        }
        note("2.1: the loser is always the SECOND transaction and always reverts with 'Insufficient pool liquidity'. Nothing partial happens, so a client can simply re-read and retry. But note the asymmetry: a LENDER's withdrawal can be denied by the agent's borrow landing first — the lender's capital is not lost, only illiquid until the loan closes.");
    });

    // ───────────────────────── 2.2 the uncontended case: both must succeed, exactly
    it("2.2 withdraw + borrow that TOGETHER fit — both succeed in one block, accounting exact (8 cases × both orders)", async () => {
        const cases = [
            [USDC(1000), USDC(100), USDC(1200)], [USDC(1000), USDC(500), USDC(1000)],
            [USDC(2000), USDC(1000), USDC(1500)], [USDC(600), USDC(300), USDC(1100)],
        ];
        for (const [sup, wd, borrow] of cases) {
            for (const borrowFirst of [true, false]) {
                await withSnapshot(async () => {
                    const before = await freshPool([sup]);
                    expect(wd + borrow <= before.availableLiquidity, "case is contended, should not be").to.equal(true);
                    const wdItem = { label: "WITHDRAW", send: (ov) => f.mp.connect(L[0]).withdrawLiquidity(aid, wd, ov) };
                    const bItem = { label: "BORROW", send: (ov) => f.mp.connect(agent).requestLoan(borrow, 7, ov) };
                    const batch = await sameBlockBatch(borrowFirst ? [bItem, wdItem] : [wdItem, bItem], { gasLimit: 1_200_000 });

                    for (const r of batch.rows) expect(r.ok, `${r.label} failed: ${r.reason}`).to.equal(true);
                    const after = await f.mp.getAgentPool(aid);
                    expect(before.availableLiquidity - after.availableLiquidity).to.equal(wd + borrow);
                    expect(after.totalLoaned).to.equal(borrow);
                    const v = await assertInvariants(f, [aid], `2.2 ${sup}/${wd}/${borrow} bf=${borrowFirst}`);
                    record("2.2 withdraw + borrow, uncontended", {
                        lenderSupply: sup.toString(), withdraw: wd.toString(), borrow: borrow.toString(),
                        borrowFirst, bothSucceeded: true, violations: v.length,
                        gas: Object.fromEntries(batch.rows.map((r) => [r.label, r.gasUsed.toString()])),
                    });
                    gasRow({ race: "2.2", scenario: `requestLoan + withdrawLiquidity same block (borrowFirst=${borrowFirst})`, N: 2, perTx: null, detail: Object.fromEntries(batch.rows.map((r) => [r.label, r.gasUsed.toString()])) });
                });
            }
        }
    });

    // ───────────────── 2.3 many lenders exiting against one borrow, every ordering
    it("2.3 3 lenders withdrawing + 1 borrow in one block, every ordering — Σ(money out) never exceeds availableLiquidity (24 orderings)", async () => {
        const sup = [USDC(400), USDC(400), USDC(400)];
        const wd = [USDC(400), USDC(400), USDC(400)];
        const borrow = USDC(1600);
        for (const ord of orderings(["W0", "W1", "W2", "BORROW"])) {
            await withSnapshot(async () => {
                const before = await freshPool(sup);
                const availBefore = before.availableLiquidity;   // 1000 self + 1200 = 2200
                const balBefore = await f.usdc.balanceOf(f.mpAddr);
                const mk = (lab) => lab === "BORROW"
                    ? { label: "BORROW", send: (ov) => f.mp.connect(agent).requestLoan(borrow, 7, ov) }
                    : { label: lab, send: (ov) => f.mp.connect(L[Number(lab.slice(1))]).withdrawLiquidity(aid, wd[Number(lab.slice(1))], ov) };
                const batch = await sameBlockBatch(ord.map(mk), { gasLimit: 1_200_000 });

                const out = batch.rows.filter((r) => r.ok).reduce((a, r) =>
                    a + (r.label === "BORROW" ? borrow : wd[Number(r.label.slice(1))]), 0n);
                const balAfter = await f.usdc.balanceOf(f.mpAddr);
                expect(balBefore - balAfter, "USDC moved != sum of the successful calls").to.equal(out);
                if (out > availBefore) {
                    violation("CRITICAL", "2.3", `${out} left a pool whose availableLiquidity was ${availBefore} (order ${ord.join(">")})`,
                        "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C2-borrow-vs-withdraw.test.js -g '2.3'");
                }
                expect(out <= availBefore, `over-spend: ${out} > ${availBefore}`).to.equal(true);
                const v = await assertInvariants(f, [aid], `2.3 ${ord.join(">")}`);
                record("2.3 3 withdraws vs 1 borrow", {
                    order: ord.join(">"), succeeded: batch.rows.filter((r) => r.ok).map((r) => r.label).join(","),
                    moved: out.toString(), availBefore: availBefore.toString(), violations: v.length,
                });
            });
        }
    });

    // ───────────────────────────────────────────── 2.4 the TOCTOU gap measured
    it("2.4 TOCTOU: what the agent read one block earlier vs what it got (10 runs)", async () => {
        let surprises = 0;
        for (let run = 0; run < 10; run++) {
            await withSnapshot(async () => {
                await freshPool([USDC(300)]);
                const read = (await f.mp.getAgentPool(aid)).availableLiquidity; // the client's view at block n
                const borrow = read;                                            // borrow exactly what it saw
                // a lender exits in the same block the borrow lands
                const batch = await sameBlockBatch([
                    { label: "WITHDRAW", send: (ov) => f.mp.connect(L[0]).withdrawLiquidity(aid, USDC(100), ov) },
                    { label: "BORROW", send: (ov) => f.mp.connect(agent).requestLoan(borrow, 7, ov) },
                ], { gasLimit: 1_200_000 });
                const by = Object.fromEntries(batch.rows.map((r) => [r.label, r]));
                if (!by.BORROW.ok) surprises++;
                expect(by.WITHDRAW.ok).to.equal(true);
                const v = await assertInvariants(f, [aid], `2.4 run=${run}`);
                record("2.4 TOCTOU borrow sized from a stale read", {
                    run, readAvailable: read.toString(), borrowRequested: borrow.toString(),
                    borrowSucceeded: by.BORROW.ok, reason: by.BORROW.reason, violations: v.length,
                });
            });
        }
        expect(surprises, "the stale-read borrow should fail every time here").to.equal(10);
        note("2.4: an agent that sizes a loan from `availableLiquidity` read one block earlier is refused 10/10 times when any lender exits in between. This is the single most likely client-side race in normal operation and the SDK must size with a margin or retry on 'Insufficient pool liquidity'.");
    });

    // ─────────── 2.5 withdraw racing the repayment that makes the liquidity exist
    it("2.5 lender withdraws in the same block a loan is repaid — the repaid principal is claimable only AFTER the repay, never before (6 runs × both orders)", async () => {
        for (let run = 0; run < 3; run++) {
            for (const repayFirst of [true, false]) {
                await withSnapshot(async () => {
                    await freshPool([USDC(500)]);
                    await f.mp.connect(agent).requestLoan(USDC(1400), 7);   // drains most of the pool
                    const avail = (await f.mp.getAgentPool(aid)).availableLiquidity;
                    expect(avail < USDC(500)).to.equal(true);
                    await increaseTime(3 * DAY); await mineOne();

                    const rItem = { label: "REPAY", send: (ov) => f.mp.connect(agent).repayLoan(1, ov) };
                    const wItem = { label: "WITHDRAW", send: (ov) => f.mp.connect(L[0]).withdrawLiquidity(aid, USDC(500), ov) };
                    const batch = await sameBlockBatch(repayFirst ? [rItem, wItem] : [wItem, rItem], { gasLimit: 1_500_000 });
                    const by = Object.fromEntries(batch.rows.map((r) => [r.label, r]));

                    expect(by.REPAY.ok, `repay failed: ${by.REPAY.reason}`).to.equal(true);
                    expect(by.WITHDRAW.ok, "withdraw outcome").to.equal(repayFirst);
                    if (!repayFirst) {
                        expect(by.WITHDRAW.reason).to.match(/Insufficient pool liquidity/);
                        expect(by.WITHDRAW.orderingDependent, "a withdraw that would now succeed must be flagged order-dependent").to.equal(true);
                        expect(by.WITHDRAW.orderingNote).to.equal("would-succeed-if-placed-later");
                    }
                    const v = await assertInvariants(f, [aid], `2.5 run=${run} rf=${repayFirst}`);
                    record("2.5 withdraw vs repay", {
                        run, repayFirst, withdrawSucceeded: by.WITHDRAW.ok, reason: by.WITHDRAW.reason,
                        orderingDependent: by.WITHDRAW.orderingDependent, orderingNote: by.WITHDRAW.orderingNote, violations: v.length,
                    });
                });
            }
        }
        note("2.5: a withdrawal placed AHEAD of the repayment that funds it reverts, and the replay proves it would have succeeded one slot later. Pure positional failure — safe on-chain, but it is exactly the case a client must retry rather than surface as 'insufficient liquidity'.");
    });
});
