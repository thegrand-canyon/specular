// RACE 5 — interest distribution under contention, verified to the base unit.
//
// `_distributeInterest` reads `positions` and `pendingTranche` for every lender AT THE
// MOMENT THE REPAYMENT EXECUTES. Under contention that moment sits in the middle of a
// block whose other transactions are also moving those same slots. Asserting only that
// the shares sum to the interest would hide a mis-attribution between lenders, so this
// suite re-implements the V6.1/V6.2 tranche rules in JavaScript and compares EVERY
// lender's earnedInterest delta exactly.
//
// The model (`applyOp` below) is written from the contract's SPECIFICATION — the (a)…(e)
// top-up cases, LIFO withdrawal, per-tranche qualification, floor division and
// dust-to-fees — not by calling the contract's own views, so agreement is evidence and
// not a tautology.

const {
    USDC, DAY, expect, ethers, sameBlockBatch, deployConc, assertInvariants,
    withSnapshot, orderings, increaseTime, mineOne, record, violation, note, dumpResults,
} = require("./_conc");

const YEAR = 365n * 24n * 3600n;

// ───────────────────────────────────────── independent model of the tranche rules

function startedIn(activeStarts, lo, hi) {
    return activeStarts.some((s) => s >= lo && s < hi);
}
function qualifiedAt(st, loanStart) {
    let q = 0n;
    if (st.depositTs <= loanStart) q = st.amount - st.pend;
    if (st.pend > 0n && st.pendTs <= loanStart) q += st.pend;
    return q;
}
/**
 * Apply one operation to the model. `m` is
 *   { lenders: Map<addr, {amount, depositTs, pend, pendTs, earned}>, order: addr[],
 *     avail, loaned, fees, activeStarts: bigint[], minSupply, feeBps, creator }
 * Returns { ok, reason }.
 */
function applyOp(m, op, ts) {
    const st = m.lenders.get(op.who) || { amount: 0n, depositTs: 0n, pend: 0n, pendTs: 0n, earned: 0n };
    if (op.kind === "supply") {
        if (m.minSupply > 0n && !m.order.includes(op.who) && op.who !== m.creator && op.amount < m.minSupply) {
            return { ok: false, reason: "Below minimum supply" };
        }
        if (!m.order.includes(op.who)) {
            if (m.order.length >= 50) return { ok: false, reason: "Pool lender capacity reached" };
            if (m.order.length === 49 && op.who !== m.creator && !m.order.includes(m.creator)) {
                return { ok: false, reason: "Last slot reserved for agent self-stake" };
            }
            m.order.push(op.who);
        }
        if (st.amount === 0n || m.activeStarts.length === 0) {
            st.pend = 0n; st.pendTs = 0n; st.depositTs = ts;                                   // (a)
        } else if (st.pend === 0n) {
            st.pend = op.amount; st.pendTs = ts;                                                // (b)
        } else if (!startedIn(m.activeStarts, st.depositTs, st.pendTs)) {
            st.pend = op.amount; st.pendTs = ts;                                                // (c) fold
        } else if (!startedIn(m.activeStarts, st.pendTs, ts)) {
            st.pend += op.amount; st.pendTs = ts;                                               // (d) merge
        } else {
            m.order = m.order.filter((a) => a !== op.who || st.amount > 0n);                    // (e) refused
            return { ok: false, reason: "Top-up would forfeit in-flight interest" };
        }
        st.amount += op.amount;
        m.avail += op.amount;
        m.lenders.set(op.who, st);
        return { ok: true };
    }
    if (op.kind === "withdraw") {
        if (st.amount < op.amount) return { ok: false, reason: "Insufficient balance" };
        if (op.who === m.creator && m.loaned > 0n) return { ok: false, reason: "Self-stake locked while borrowing" };
        if (m.avail < op.amount) return { ok: false, reason: "Insufficient pool liquidity" };
        if (st.amount > op.amount && op.who !== m.creator && m.minSupply > 0n && st.amount - op.amount < m.minSupply) {
            return { ok: false, reason: "Remaining below minimum supply" };
        }
        if (st.pend > 0n) {
            const fromP = op.amount < st.pend ? op.amount : st.pend;
            st.pend -= fromP;
            if (st.pend === 0n) st.pendTs = 0n;
        }
        st.amount -= op.amount;
        m.avail -= op.amount;
        if (st.amount === 0n && st.earned === 0n) m.order = m.order.filter((a) => a !== op.who);
        m.lenders.set(op.who, st);
        return { ok: true };
    }
    if (op.kind === "claim") {
        if (st.earned === 0n) return { ok: false, reason: "No interest to claim" };
        if (m.avail < st.earned) return { ok: false, reason: "Drain underflow" };
        m.avail -= st.earned;
        st.earned = 0n;
        if (st.amount === 0n) m.order = m.order.filter((a) => a !== op.who);
        m.lenders.set(op.who, st);
        return { ok: true };
    }
    if (op.kind === "repay") {
        const loan = op.loan; // {principal, rateBps, duration, start}
        const elapsed = ts - loan.start;
        let chargeable = elapsed > loan.duration ? elapsed : loan.duration;
        const cap = loan.duration + 30n * 24n * 3600n;
        if (chargeable > cap) chargeable = cap;
        const interest = ((loan.principal * loan.rateBps) / 10000n) * chargeable / YEAR;
        const fee = (interest * m.feeBps) / 10000n;
        const lenderInterest = interest - fee;

        m.avail += loan.principal + lenderInterest;
        m.loaned -= loan.principal;
        m.fees += fee;
        m.activeStarts = m.activeStarts.filter((s) => s !== loan.start || false);
        // remove exactly one occurrence
        const idx = m.activeStarts.indexOf(loan.start);
        if (idx >= 0) m.activeStarts.splice(idx, 1);

        const qs = m.order.map((a) => qualifiedAt(m.lenders.get(a), loan.start));
        const qTotal = qs.reduce((a, b) => a + b, 0n);
        const shares = new Map();
        if (qTotal === 0n) {
            m.avail -= lenderInterest; m.fees += lenderInterest;
        } else {
            let distributed = 0n;
            m.order.forEach((a, i) => {
                if (qs[i] === 0n) return;
                const sh = (lenderInterest * qs[i]) / qTotal;
                const s = m.lenders.get(a); s.earned += sh; m.lenders.set(a, s);
                shares.set(a, sh); distributed += sh;
            });
            const dust = lenderInterest - distributed;
            if (dust > 0n) { m.avail -= dust; m.fees += dust; }
        }
        return { ok: true, interest, fee, lenderInterest, qs, qTotal, shares };
    }
    throw new Error(`unknown op ${op.kind}`);
}

describe("RACE 5 — interest distribution under contention (exact shares)", function () {
    let f, agent, aid, LA, LB, LC, LD, creator;

    before(async () => {
        f = await deployConc({ minSupply: USDC(10), minHold: 0, feeBps: 100 });
        const s = f.signers;
        agent = s[1]; creator = agent.address;
        await f.fund(agent);
        aid = await f.onboardAgent(agent, "r5");
        await f.pumpScore(agent, 600);
        await f.pumpCapacity(agent, USDC(1200));
        [LA, LB, LC, LD] = [s[10], s[11], s[12], s[13]];
        for (const l of [LA, LB, LC, LD]) await f.fund(l, USDC(500_000));
    });

    after(() => dumpResults("concurrency-results.json"));

    /** Read the on-chain state into a fresh model at the CURRENT head. */
    async function readModel() {
        const p = await f.mp.getAgentPool(aid);
        const order = [];
        const lenders = new Map();
        for (let i = 0n; i < p.lenderCount; i++) {
            const a = await f.mp.poolLenders(aid, i);
            const pos = await f.mp.positions(aid, a);
            const pt = await f.mp.pendingTranche(aid, a);
            order.push(a);
            lenders.set(a, { amount: pos.amount, depositTs: pos.depositTimestamp, pend: BigInt(pt.amount), pendTs: BigInt(pt.timestamp), earned: pos.earnedInterest });
        }
        const ids = await f.mp.getActiveLoanIds(aid);
        const activeStarts = [];
        for (const id of ids) activeStarts.push((await f.mp.loans(id)).startTime);
        return {
            lenders, order, avail: p.availableLiquidity, loaned: p.totalLoaned,
            fees: await f.mp.accumulatedFees(), activeStarts,
            minSupply: await f.mp.minSupplyAmount(), feeBps: await f.mp.platformFeeRate(), creator,
        };
    }

    async function loanRec(id) {
        const l = await f.mp.loans(id);
        return { principal: l.amount, rateBps: l.interestRate, duration: l.duration, start: l.startTime, id };
    }

    /** Compare the model's per-lender earnedInterest and principal against the chain. */
    async function compare(m, label) {
        const diffs = [];
        const p = await f.mp.getAgentPool(aid);
        for (const [a, st] of m.lenders) {
            const pos = await f.mp.positions(aid, a);
            if (pos.amount !== st.amount) diffs.push(`${a} principal chain=${pos.amount} model=${st.amount}`);
            if (pos.earnedInterest !== st.earned) diffs.push(`${a} earnedInterest chain=${pos.earnedInterest} model=${st.earned} (Δ ${pos.earnedInterest - st.earned})`);
            const pt = await f.mp.pendingTranche(aid, a);
            if (BigInt(pt.amount) !== st.pend) diffs.push(`${a} pending chain=${pt.amount} model=${st.pend}`);
        }
        if (p.availableLiquidity !== m.avail) diffs.push(`availableLiquidity chain=${p.availableLiquidity} model=${m.avail}`);
        if ((await f.mp.accumulatedFees()) !== m.fees) diffs.push(`accumulatedFees chain=${await f.mp.accumulatedFees()} model=${m.fees}`);
        if (diffs.length) {
            violation("HIGH", "5", `independent model disagrees with the chain at ${label}:\n    ${diffs.join("\n    ")}`,
                "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C5-interest-exact-shares.test.js");
        }
        expect(diffs, `EXACT-SHARE MISMATCH @ ${label}:\n  ${diffs.join("\n  ")}`).to.deep.equal([]);
        return diffs;
    }

    // ──────────────────────────── 5.1 baseline: repay alone, shares exact per lender
    it("5.1 uncontended repay with mixed tranche histories — every lender's share exact to the base unit (6 shapes)", async () => {
        const shapes = [
            [USDC(100), USDC(300), USDC(600)], [USDC(1), USDC(1), USDC(1)],
            [USDC(333), USDC(333), USDC(334)], [USDC(7), USDC(11), USDC(13)],
            [USDC(1000), USDC(1), USDC(1)], [USDC(17), USDC(101), USDC(5000)],
        ];
        for (const [a, b, c] of shapes) {
            await withSnapshot(async () => {
                await f.mp.connect(agent).supplyLiquidity(aid, USDC(1200));
                await f.mp.connect(LA).supplyLiquidity(aid, a < USDC(10) ? USDC(10) : a);
                await f.mp.connect(LB).supplyLiquidity(aid, b < USDC(10) ? USDC(10) : b);
                const id = await f.mp.nextLoanId();
                await f.mp.connect(agent).requestLoan(USDC(500), 7);
                // C joins AFTER the loan started → base tranche disqualified for this loan
                await f.mp.connect(LC).supplyLiquidity(aid, c < USDC(10) ? USDC(10) : c);
                await increaseTime(4 * DAY); await mineOne();

                const m = await readModel();
                const loan = await loanRec(id);
                const batch = await sameBlockBatch([{ label: "REPAY", send: (ov) => f.mp.connect(agent).repayLoan(id, ov) }], { gasLimit: 2_000_000 });
                expect(batch.rows[0].ok, batch.rows[0].reason).to.equal(true);
                const ts = BigInt((await ethers.provider.getBlock(batch.block)).timestamp);
                const res = applyOp(m, { kind: "repay", loan }, ts);
                await compare(m, `5.1 ${a}/${b}/${c}`);
                const v = await assertInvariants(f, [aid], `5.1 ${a}/${b}/${c}`);
                record("5.1 exact shares, uncontended", {
                    shape: [a, b, c].map(String), interest: res.interest.toString(), fee: res.fee.toString(),
                    qualifiedTotal: res.qTotal.toString(),
                    shares: Object.fromEntries([...res.shares].map(([k2, v2]) => [k2.slice(0, 8), v2.toString()])),
                    exact: true, violations: v.length,
                });
            });
        }
    });

    // ───────────── 5.2 the repay contended with supplies / withdrawals / claims
    it("5.2 repay contended with top-ups, withdrawals and a claim in the SAME block — every ordering, shares still exact (24 orderings × 2 shapes)", async () => {
        for (const seed of [0, 1]) {
            for (const ord of orderings(["TOPUP_C", "WITHDRAW_A", "REPAY", "CLAIM_B"])) {
                await withSnapshot(async () => {
                    await f.mp.connect(agent).supplyLiquidity(aid, USDC(1200));
                    await f.mp.connect(LA).supplyLiquidity(aid, USDC(400 + seed * 37));
                    await f.mp.connect(LB).supplyLiquidity(aid, USDC(600 + seed * 13));
                    await f.mp.connect(LC).supplyLiquidity(aid, USDC(250));
                    // an earlier loan so LB has interest to claim in the contended block
                    const id0 = await f.mp.nextLoanId();
                    await f.mp.connect(agent).requestLoan(USDC(300), 7);
                    await increaseTime(8 * DAY); await mineOne();
                    await f.mp.connect(agent).repayLoan(id0);
                    // the loan whose repayment is contended
                    const id = await f.mp.nextLoanId();
                    await f.mp.connect(agent).requestLoan(USDC(700), 7);
                    await increaseTime(5 * DAY); await mineOne();

                    const m = await readModel();
                    const loan = await loanRec(id);
                    const ops = {
                        TOPUP_C: { kind: "supply", who: LC.address, amount: USDC(90) },
                        WITHDRAW_A: { kind: "withdraw", who: LA.address, amount: USDC(100) },
                        REPAY: { kind: "repay", loan },
                        CLAIM_B: { kind: "claim", who: LB.address },
                    };
                    const mk = (lab) => ({
                        TOPUP_C: { label: lab, send: (ov) => f.mp.connect(LC).supplyLiquidity(aid, USDC(90), ov) },
                        WITHDRAW_A: { label: lab, send: (ov) => f.mp.connect(LA).withdrawLiquidity(aid, USDC(100), ov) },
                        REPAY: { label: lab, send: (ov) => f.mp.connect(agent).repayLoan(id, ov) },
                        CLAIM_B: { label: lab, send: (ov) => f.mp.connect(LB).claimInterest(aid, ov) },
                    }[lab]);

                    const batch = await sameBlockBatch(ord.map(mk), { gasLimit: 2_500_000 });
                    const ts = BigInt((await ethers.provider.getBlock(batch.block)).timestamp);
                    const predicted = {};
                    for (const lab of ord) {
                        const r = applyOp(m, ops[lab], ts);
                        predicted[lab] = r.ok;
                    }
                    for (const row of batch.rows) {
                        expect(row.ok, `model/chain disagree on whether ${row.label} succeeds (chain=${row.ok} model=${predicted[row.label]} reason=${row.reason})`)
                            .to.equal(predicted[row.label]);
                    }
                    await compare(m, `5.2 seed=${seed} ${ord.join(">")}`);
                    const v = await assertInvariants(f, [aid], `5.2 ${ord.join(">")}`);
                    record("5.2 exact shares under same-block contention", {
                        seed, order: ord.join(">"), allOpsPredicted: true, exact: true, violations: v.length,
                    });
                });
            }
        }
        note("5.2: across all 48 contended orderings the independent model predicted BOTH which calls succeed and every lender's resulting principal, pending tranche and earnedInterest to the base unit. A top-up that lands before the repayment in the same block does NOT dilute the qualified set, because its pending tranche is stamped with the block timestamp and the loan started strictly earlier.");
    });

    // ──────── 5.3 same-block back-run of requestLoan: does new money qualify?
    it("5.3 a supply BEHIND requestLoan in the same block qualifies for that loan's interest (the equal-timestamp case) — quantified, 4 sizes", async () => {
        for (const chase of [USDC(500), USDC(1000), USDC(2000), USDC(5000)]) {
            await withSnapshot(async () => {
                await f.mp.connect(agent).supplyLiquidity(aid, USDC(1200));
                await f.mp.connect(LA).supplyLiquidity(aid, USDC(1000)); // the honest lender
                const id = await f.mp.nextLoanId();

                // one block: requestLoan, then the back-runner's supply
                const batch = await sameBlockBatch([
                    { label: "BORROW", send: (ov) => f.mp.connect(agent).requestLoan(USDC(1000), 7, ov) },
                    { label: "BACKRUN", send: (ov) => f.mp.connect(LB).supplyLiquidity(aid, chase, ov) },
                ], { gasLimit: 1_500_000 });
                for (const r of batch.rows) expect(r.ok, `${r.label}: ${r.reason}`).to.equal(true);

                const loan = await loanRec(id);
                const posB = await f.mp.positions(aid, LB.address);
                const qB = await f.mp.qualifiedAmountAt(aid, LB.address, loan.start);
                const backrunQualifies = qB > 0n;

                // the honest comparison: the SAME supply one block later
                await increaseTime(60); await mineOne();
                await f.mp.connect(LC).supplyLiquidity(aid, chase);
                const qC = await f.mp.qualifiedAmountAt(aid, LC.address, loan.start);

                await increaseTime(4 * DAY); await mineOne();
                const m = await readModel();
                const rb = await sameBlockBatch([{ label: "REPAY", send: (ov) => f.mp.connect(agent).repayLoan(id, ov) }], { gasLimit: 2_000_000 });
                expect(rb.rows[0].ok, rb.rows[0].reason).to.equal(true);
                const ts = BigInt((await ethers.provider.getBlock(rb.block)).timestamp);
                const res = applyOp(m, { kind: "repay", loan }, ts);
                await compare(m, `5.3 chase=${chase}`);

                const shareB = res.shares.get(LB.address) ?? 0n;
                const shareA = res.shares.get(LA.address) ?? 0n;
                const shareC = res.shares.get(LC.address) ?? 0n;
                expect(backrunQualifies, "the equal-timestamp back-run should qualify (documented behaviour of qualifiedAmountAt)").to.equal(true);
                expect(qC, "a supply one block later must NOT qualify").to.equal(0n);
                expect(shareC).to.equal(0n);
                if (shareB > 0n) {
                    violation("MEDIUM", "5.3",
                        `a supply placed BEHIND requestLoan in the SAME block earns interest on that loan: back-runner staked ${chase} and took ${shareB} of the interest, diluting the pre-existing lender from its uncontested share down to ${shareA}. The same supply one block later earns 0. Cause: qualification is \`depositTimestamp <= loan.startTime\` and both are block.timestamp, so a same-block back-run compares EQUAL and qualifies.`,
                        "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C5-interest-exact-shares.test.js -g '5.3'");
                }
                const v = await assertInvariants(f, [aid], `5.3 chase=${chase}`);
                record("5.3 same-block back-run of requestLoan", {
                    chase: chase.toString(), backrunQualifiedAmount: qB.toString(),
                    nextBlockQualifiedAmount: qC.toString(),
                    shareBackrunner: shareB.toString(), shareHonestPreLoan: shareA.toString(), shareNextBlock: shareC.toString(),
                    dilutionPct: shareA + shareB > 0n ? Number((shareB * 10000n) / (shareA + shareB)) / 100 : 0,
                    violations: v.length,
                });
            });
        }
    });

    // ──────── 5.3b how far the back-run goes: can the capital leave before repayment?
    it("5.3b the same-block back-runner must keep the capital in the pool until repayment — withdrawing first forfeits the share (3 runs)", async () => {
        for (const chase of [USDC(500), USDC(2000), USDC(5000)]) {
            await withSnapshot(async () => {
                await f.mp.connect(agent).supplyLiquidity(aid, USDC(1200));
                await f.mp.connect(LA).supplyLiquidity(aid, USDC(1000));
                const id = await f.mp.nextLoanId();
                const batch = await sameBlockBatch([
                    { label: "BORROW", send: (ov) => f.mp.connect(agent).requestLoan(USDC(1000), 7, ov) },
                    { label: "BACKRUN", send: (ov) => f.mp.connect(LB).supplyLiquidity(aid, chase, ov) },
                ], { gasLimit: 1_500_000 });
                for (const r of batch.rows) expect(r.ok, `${r.label}: ${r.reason}`).to.equal(true);
                const loan = await loanRec(id);

                // the back-runner pulls the capital back out before the loan is repaid
                await increaseTime(2 * DAY); await mineOne();
                const w = await f.mp.connect(LB).withdrawLiquidity(aid, chase).then(() => true).catch((e) => e.shortMessage);
                expect(w, `back-runner could not exit: ${w}`).to.equal(true);

                await increaseTime(5 * DAY); await mineOne();
                const m = await readModel();
                const rb = await sameBlockBatch([{ label: "REPAY", send: (ov) => f.mp.connect(agent).repayLoan(id, ov) }], { gasLimit: 2_000_000 });
                expect(rb.rows[0].ok, rb.rows[0].reason).to.equal(true);
                const ts = BigInt((await ethers.provider.getBlock(rb.block)).timestamp);
                const res = applyOp(m, { kind: "repay", loan }, ts);
                await compare(m, `5.3b chase=${chase}`);
                const shareB = res.shares.get(LB.address) ?? 0n;
                expect(shareB, "a back-runner who exited before repayment still earned interest").to.equal(0n);
                const v = await assertInvariants(f, [aid], `5.3b chase=${chase}`);
                record("5.3b back-run capital must stay until repayment", {
                    chase: chase.toString(), exitedBeforeRepay: true, shareEarned: shareB.toString(), violations: v.length,
                });
            });
        }
        note("5.3b: the same-block back-run is NOT a free ride — the capital has to sit in the pool, exposed to socialised default loss, until the loan is repaid. Exiting first forfeits the whole share. That bounds 5.3 to 'jumping the queue by one block', not theft.");
    });

    // ──────── 5.4 two loans, overlapping lender sets, both repaid in one block
    it("5.4 two loans with overlapping lender sets repaid in the SAME block, top-ups interleaved — exact per lender (both orders × 3 shapes)", async () => {
        for (const seed of [0, 1, 2]) {
            for (const firstIsOlder of [true, false]) {
                await withSnapshot(async () => {
                    await f.mp.connect(agent).supplyLiquidity(aid, USDC(1200));
                    await f.mp.connect(LA).supplyLiquidity(aid, USDC(500 + seed * 31));
                    const id1 = await f.mp.nextLoanId();
                    await f.mp.connect(agent).requestLoan(USDC(400), 7);
                    await increaseTime(DAY); await mineOne();
                    await f.mp.connect(LB).supplyLiquidity(aid, USDC(700 + seed * 17));  // qualifies for loan 2 only
                    const id2 = await f.mp.nextLoanId();
                    await f.mp.connect(agent).requestLoan(USDC(300), 7);
                    await increaseTime(DAY); await mineOne();
                    await f.mp.connect(LC).supplyLiquidity(aid, USDC(300));              // qualifies for neither
                    await increaseTime(7 * DAY); await mineOne();

                    const m = await readModel();
                    const l1 = await loanRec(id1), l2 = await loanRec(id2);
                    const items = [
                        { label: "REPAY1", send: (ov) => f.mp.connect(agent).repayLoan(id1, ov) },
                        { label: "REPAY2", send: (ov) => f.mp.connect(agent).repayLoan(id2, ov) },
                    ];
                    const ops = firstIsOlder ? [{ kind: "repay", loan: l1 }, { kind: "repay", loan: l2 }]
                        : [{ kind: "repay", loan: l2 }, { kind: "repay", loan: l1 }];
                    const batch = await sameBlockBatch(firstIsOlder ? items : [...items].reverse(), { gasLimit: 3_000_000 });
                    for (const r of batch.rows) expect(r.ok, `${r.label}: ${r.reason}`).to.equal(true);
                    const ts = BigInt((await ethers.provider.getBlock(batch.block)).timestamp);
                    const results = ops.map((o) => applyOp(m, o, ts));
                    await compare(m, `5.4 seed=${seed} olderFirst=${firstIsOlder}`);

                    // LC supplied after both loans started and must earn nothing from either
                    expect((await f.mp.positions(aid, LC.address)).earnedInterest, "a post-loan lender earned interest").to.equal(0n);
                    const v = await assertInvariants(f, [aid], `5.4 seed=${seed}`);
                    record("5.4 two loans, overlapping lenders, one block", {
                        seed, olderFirst: firstIsOlder, exact: true,
                        qualifiedTotals: results.map((r) => r.qTotal.toString()),
                        lcEarned: "0", violations: v.length,
                    });
                });
            }
        }
    });

    // ──────────── 5.5 sum + dust discipline under a 49-lender contended repay
    it("5.5 49 lenders, contended repay — Σ shares + dust == lenderInterest, dust lands in fees, exact (4 runs)", async () => {
        const s = f.signers;
        const many = s.slice(20, 68); // 48 third parties + creator = 49 slots
        for (const l of many) await f.fund(l, USDC(200_000));
        for (let run = 0; run < 4; run++) {
            await withSnapshot(async () => {
                await f.mp.connect(agent).supplyLiquidity(aid, USDC(1200));
                for (let i = 0; i < many.length; i++) {
                    await f.mp.connect(many[i]).supplyLiquidity(aid, USDC(10 + ((i * 13 + run * 7) % 91)));
                }
                const id = await f.mp.nextLoanId();
                await f.mp.connect(agent).requestLoan(USDC(1000 + run), 7);
                await increaseTime((4 + run) * DAY); await mineOne();

                const m = await readModel();
                const loan = await loanRec(id);
                const feesBefore = await f.mp.accumulatedFees();
                const batch = await sameBlockBatch([
                    { label: "TOPUP", send: (ov) => f.mp.connect(many[0]).supplyLiquidity(aid, USDC(25), ov) },
                    { label: "REPAY", send: (ov) => f.mp.connect(agent).repayLoan(id, ov) },
                    { label: "WITHDRAW", send: (ov) => f.mp.connect(many[1]).withdrawLiquidity(aid, USDC(5), ov) },
                ], { gasLimit: 4_000_000 });
                const ts = BigInt((await ethers.provider.getBlock(batch.block)).timestamp);
                const predicted = [
                    applyOp(m, { kind: "supply", who: many[0].address, amount: USDC(25) }, ts),
                    applyOp(m, { kind: "repay", loan }, ts),
                    applyOp(m, { kind: "withdraw", who: many[1].address, amount: USDC(5) }, ts),
                ];
                batch.rows.forEach((r, i) => expect(r.ok, `${r.label}: ${r.reason}`).to.equal(predicted[i].ok));
                await compare(m, `5.5 run=${run}`);

                const res = predicted[1];
                const distributed = [...res.shares.values()].reduce((a, b) => a + b, 0n);
                const dust = res.lenderInterest - distributed;
                expect((await f.mp.accumulatedFees()) - feesBefore, "fee + dust accounting drifted").to.equal(res.fee + dust);
                const v = await assertInvariants(f, [aid], `5.5 run=${run}`);
                record("5.5 49-lender contended repay", {
                    run, lenders: 49, interest: res.interest.toString(), lenderInterest: res.lenderInterest.toString(),
                    distributed: distributed.toString(), dust: dust.toString(), fee: res.fee.toString(),
                    repayGas: batch.rows.find((r) => r.label === "REPAY").gasUsed.toString(), exact: true, violations: v.length,
                });
            });
        }
    });
});
