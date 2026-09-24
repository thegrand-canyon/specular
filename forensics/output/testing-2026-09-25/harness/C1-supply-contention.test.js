// RACE 1 — same-block supply contention.
//
// N lenders call supplyLiquidity on ONE pool inside a SINGLE block, including at the
// 50-slot cap and at the reserved-last-slot boundary (the creator's M2 self-stake slot).
//
// Questions asked:
//   Q1  does `MAX_LENDERS_PER_POOL` hold EXACTLY when the contenders are in one block?
//   Q2  can two transactions both believe they took the last slot (i.e. can
//       poolLenders.length exceed 50, or can two pushes happen at len == 49)?
//   Q3  does `minSupplyAmount` hold for every one of them, or can a sub-minimum supply
//       slip through because an earlier transaction in the same block made the sender
//       "already a lender"?
//   Q4  is the WINNER order-dependent (R1), and if so does the loser get an
//       explainable refusal or a confusing one?
//
// Ordering: the harness pins hardhat's mempool to FIFO and then ENUMERATES the
// orderings itself (all k! for k <= 4, rotations + reverse above that). That is
// strictly stronger than testing one priority-fee auction, because it covers every
// choice a block producer could make, not just the fee-ordered one.

const {
    USDC, ethers, expect, sameBlockBatch, deployConc, assertInvariants,
    withSnapshot, orderings, record, violation, note, dumpResults, gasRow,
} = require("./_conc");

describe("RACE 1 — same-block supply contention", function () {
    let f, agent, aid, lenders;

    before(async () => {
        f = await deployConc({ minSupply: USDC(10) });
        const s = f.signers;
        agent = s[1];
        await f.fund(agent);
        aid = await f.onboardAgent(agent, "r1");
        lenders = s.slice(10, 130);
        for (const l of lenders) await f.fund(l, USDC(200_000));
    });

    after(() => dumpResults("concurrency-results.json"));

    // ───────────────────────────────────────────── 1.1 plain N-way contention
    it("1.1 N lenders supplying in one block: every one lands, accounting exact (N = 2,5,10,25,49) × 4 runs", async () => {
        for (const N of [2, 5, 10, 25, 49]) {
            for (let run = 0; run < 4; run++) {
                await withSnapshot(async () => {
                    const contenders = lenders.slice(0, N);
                    const amounts = contenders.map((_, i) => USDC(10 + ((i * 7 + run * 3) % 90)));
                    const before = await f.mp.getAgentPool(aid);

                    const items = contenders.map((w, i) => ({
                        label: `L${i}`,
                        send: (ov) => f.mp.connect(w).supplyLiquidity(aid, amounts[i], ov),
                    }));
                    const batch = await sameBlockBatch(run % 2 ? [...items].reverse() : items, { gasLimit: 400_000 });

                    expect(batch.sameBlock, `N=${N} run=${run}: batch split across blocks`).to.equal(true);
                    const wins = batch.rows.filter((r) => r.ok).length;
                    expect(wins, `N=${N} run=${run}: not every supply landed`).to.equal(N);

                    const after = await f.mp.getAgentPool(aid);
                    const expSum = amounts.reduce((a, b) => a + b, 0n);
                    expect(after.totalLiquidity - before.totalLiquidity).to.equal(expSum);
                    expect(after.availableLiquidity - before.availableLiquidity).to.equal(expSum);
                    expect(after.lenderCount - before.lenderCount).to.equal(BigInt(N));
                    for (let i = 0; i < N; i++) {
                        const pos = await f.mp.positions(aid, contenders[i].address);
                        expect(pos.amount, `lender ${i} principal`).to.equal(amounts[i]);
                    }
                    const v = await assertInvariants(f, [aid], `1.1 N=${N} run=${run}`);
                    const total = batch.rows.reduce((a, r) => a + r.gasUsed, 0n);
                    record("1.1 N-way same-block supply", {
                        N, run, sameBlock: batch.sameBlock, landed: wins, violations: v.length, totalGas: total.toString(),
                    });
                    gasRow({ race: "1.1", scenario: "supplyLiquidity, fresh slot, all in one block", N, totalGas: total.toString(), perTx: (total / BigInt(N)).toString() });
                });
            }
        }
    });

    // ──────────────────────────────── 1.2 the reserved-last-slot boundary, creator OUT
    it("1.2 creator holds NO position: 49 slots full, k third parties race the last slot in one block — all refused, cap exact (k = 2,3,5,10, every ordering)", async () => {
        for (const k of [2, 3, 5, 10]) {
            const racerIdx = [...Array(k).keys()];
            for (const ord of orderings(racerIdx)) {
                await withSnapshot(async () => {
                    for (let i = 0; i < 49; i++) await f.mp.connect(lenders[i]).supplyLiquidity(aid, USDC(10));
                    let p = await f.mp.getAgentPool(aid);
                    expect(p.lenderCount).to.equal(49n);
                    expect(await f.mp.isInPoolLenders(aid, agent.address)).to.equal(false);

                    const batch = await sameBlockBatch(ord.map((i) => ({
                        label: `X${i}`,
                        send: (ov) => f.mp.connect(lenders[49 + i]).supplyLiquidity(aid, USDC(25), ov),
                    })), { gasLimit: 400_000 });

                    const winners = batch.rows.filter((r) => r.ok);
                    p = await f.mp.getAgentPool(aid);
                    expect(p.lenderCount, `k=${k}: lenderCount moved past 49`).to.equal(49n);
                    if (winners.length !== 0) {
                        violation("CRITICAL", "1.2", `${winners.length} third parties took the reserved creator slot in one block (k=${k}, order ${ord})`,
                            "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C1-supply-contention.test.js -g '1.2'");
                    }
                    expect(winners.length, `k=${k}: a third party took the reserved slot`).to.equal(0);
                    for (const r of batch.rows) {
                        expect(r.reason, "refusal must be the explainable one").to.match(/Last slot reserved for agent self-stake/);
                        expect(r.orderingDependent, "refusal must NOT be ordering-dependent").to.equal(false);
                    }
                    const v = await assertInvariants(f, [aid], `1.2 k=${k}`);
                    record("1.2 reserved-slot race, creator out", { k, order: ord.join(">"), winners: 0, lenderCount: 49, violations: v.length });
                });
            }
        }
    });

    // ─────────────────── 1.3 creator races third parties for the same last free slot
    it("1.3 creator and k third parties race the SAME last slot in one block — creator always gets in, cap exact (k = 1,2,3 every ordering; k = 9 rotations)", async () => {
        for (const k of [1, 2, 3, 9]) {
            const labels = [...Array(k).keys()].map((i) => `X${i}`);
            for (const ord of orderings([...labels, "CREATOR"])) {
                await withSnapshot(async () => {
                    for (let i = 0; i < 48; i++) await f.mp.connect(lenders[i]).supplyLiquidity(aid, USDC(10));
                    expect((await f.mp.getAgentPool(aid)).lenderCount).to.equal(48n);

                    const mk = (lab) => lab === "CREATOR"
                        // 5 USDC is BELOW minSupply on purpose — the M2-a creator exemption
                        ? { label: "CREATOR", send: (ov) => f.mp.connect(agent).supplyLiquidity(aid, USDC(5), ov) }
                        : { label: lab, send: (ov) => f.mp.connect(lenders[48 + Number(lab.slice(1))]).supplyLiquidity(aid, USDC(25), ov) };
                    const batch = await sameBlockBatch(ord.map(mk), { gasLimit: 400_000 });

                    const p = await f.mp.getAgentPool(aid);
                    const creatorRow = batch.rows.find((r) => r.label === "CREATOR");
                    if (!creatorRow.ok) {
                        violation("HIGH", "1.3", `creator LOST the reserved slot race (k=${k}, order ${ord.join(">")}): ${creatorRow.reason}`,
                            "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C1-supply-contention.test.js -g '1.3'");
                    }
                    expect(creatorRow.ok, `creator refused: ${creatorRow.reason}`).to.equal(true);
                    expect(await f.mp.isInPoolLenders(aid, agent.address)).to.equal(true);

                    const tpWins = batch.rows.filter((r) => r.label !== "CREATOR" && r.ok).length;
                    expect(48 + tpWins + 1).to.equal(Number(p.lenderCount));
                    expect(Number(p.lenderCount), "cap exceeded").to.be.lte(50);

                    const v = await assertInvariants(f, [aid], `1.3 k=${k}`);
                    record("1.3 creator vs third parties, last slot", {
                        k, order: ord.join(">"), creatorWon: creatorRow.ok, thirdPartyWinners: tpWins,
                        finalLenderCount: Number(p.lenderCount), violations: v.length,
                        losersReason: [...new Set(batch.rows.filter((r) => !r.ok).map((r) => r.reason))],
                    });
                });
            }
        }
        note("1.3: WHICH third party gets slot 50 is order-dependent (R1) — but the creator's slot is never at risk, and the cap never exceeds 50 in any ordering tested.");
    });

    // ────────────────────────────── 1.4 the hard 50 cap with the creator already in
    it("1.4 creator already staked, 50 slots full, k racers in one block — every one refused with 'Pool lender capacity reached' (k = 2,3,6 × orderings)", async () => {
        for (const k of [2, 3, 6]) {
            for (const ord of orderings([...Array(k).keys()])) {
                await withSnapshot(async () => {
                    await f.mp.connect(agent).supplyLiquidity(aid, USDC(5));
                    for (let i = 0; i < 49; i++) await f.mp.connect(lenders[i]).supplyLiquidity(aid, USDC(10));
                    expect((await f.mp.getAgentPool(aid)).lenderCount).to.equal(50n);

                    const batch = await sameBlockBatch(ord.map((i) => ({
                        label: `X${i}`, send: (ov) => f.mp.connect(lenders[49 + i]).supplyLiquidity(aid, USDC(25), ov),
                    })), { gasLimit: 400_000 });

                    expect(batch.rows.every((r) => !r.ok), "somebody got a 51st slot").to.equal(true);
                    for (const r of batch.rows) expect(r.reason).to.match(/Pool lender capacity reached/);
                    expect((await f.mp.getAgentPool(aid)).lenderCount).to.equal(50n);
                    const v = await assertInvariants(f, [aid], `1.4 k=${k}`);
                    record("1.4 hard 50 cap under contention", { k, order: ord.join(">"), winners: 0, finalLenderCount: 50, violations: v.length });
                });
            }
        }
    });

    // ────────────── 1.5 a freed slot contested in the same block it is freed (churn)
    it("1.5 full pool: one lender exits and k newcomers race the freed slot in the SAME block — exactly one wins, no over-subscription (k = 2,3 × orderings × exit position)", async () => {
        for (const k of [2, 3]) {
            for (const exitFirst of [true, false]) {
                for (const ord of orderings([...Array(k).keys()])) {
                    await withSnapshot(async () => {
                        await f.mp.connect(agent).supplyLiquidity(aid, USDC(5));
                        for (let i = 0; i < 49; i++) await f.mp.connect(lenders[i]).supplyLiquidity(aid, USDC(10));
                        expect((await f.mp.getAgentPool(aid)).lenderCount).to.equal(50n);

                        const exiting = lenders[0];
                        const exitItem = { label: "EXIT", send: (ov) => f.mp.connect(exiting).withdrawLiquidity(aid, USDC(10), ov) };
                        const joinItems = ord.map((i) => ({
                            label: `J${i}`, send: (ov) => f.mp.connect(lenders[49 + i]).supplyLiquidity(aid, USDC(25), ov),
                        }));
                        const batch = await sameBlockBatch(exitFirst ? [exitItem, ...joinItems] : [...joinItems, exitItem], { gasLimit: 500_000 });

                        const joinWins = batch.rows.filter((r) => r.label.startsWith("J") && r.ok).length;
                        const p = await f.mp.getAgentPool(aid);
                        expect(Number(p.lenderCount), "cap exceeded after churn").to.be.lte(50);
                        // exit-first frees a slot that exactly one newcomer can take; exit-last frees nothing in time
                        expect(joinWins, `k=${k} exitFirst=${exitFirst}: wrong number of newcomers admitted`).to.equal(exitFirst ? 1 : 0);
                        const losers = batch.rows.filter((r) => r.label.startsWith("J") && !r.ok);
                        for (const l of losers) expect(l.reason).to.match(/Pool lender capacity reached|reverted in-block, replay at end-of-block state SUCCEEDS/);
                        const v = await assertInvariants(f, [aid], `1.5 k=${k} exitFirst=${exitFirst}`);
                        record("1.5 freed-slot churn race", {
                            k, exitFirst, order: ord.join(">"), admitted: joinWins, finalLenderCount: Number(p.lenderCount),
                            loserOrderingDependent: losers.some((l) => l.orderingDependent), violations: v.length,
                        });
                    });
                }
            }
        }
        note("1.5: with exit-last, the newcomers' refusals REPLAY SUCCESSFULLY at end-of-block state — proof the revert was purely positional (R1). A client that retries on 'Pool lender capacity reached' recovers; one that treats it as terminal gives up on a slot that is now free.");
    });

    // ───────────────────────────────── 1.6 minSupplyAmount under same-block contention
    it("1.6 minSupplyAmount holds for every contender in a block, including a sub-minimum chaser behind the same sender's own qualifying supply (12 runs)", async () => {
        for (let run = 0; run < 12; run++) {
            await withSnapshot(async () => {
                const min = await f.mp.minSupplyAmount();
                const a = lenders[60], b = lenders[61], c = lenders[62];

                // a: qualifying, then sub-minimum top-up (legal — top-ups are not gated)
                // b: two sub-minimum supplies — the FIRST must be refused; if it landed,
                //    the second would become a legal top-up, i.e. a same-block bypass of
                //    the whole F-C anti-squat lever.
                // c: exactly at the minimum.
                const items = [
                    { label: "a-qualify", send: (ov) => f.mp.connect(a).supplyLiquidity(aid, min, ov) },
                    { label: "b-sub1", send: (ov) => f.mp.connect(b).supplyLiquidity(aid, min - 1n, ov) },
                    { label: "a-topup-sub", send: (ov) => f.mp.connect(a).supplyLiquidity(aid, 1n, ov) },
                    { label: "b-sub2", send: (ov) => f.mp.connect(b).supplyLiquidity(aid, 1n, ov) },
                    { label: "c-exact", send: (ov) => f.mp.connect(c).supplyLiquidity(aid, min, ov) },
                ];
                if (run % 2 === 1) items.reverse();

                const batch = await sameBlockBatch(items, { gasLimit: 400_000 });
                const by = Object.fromEntries(batch.rows.map((r) => [r.label, r]));

                if (by["b-sub1"].ok || by["b-sub2"].ok) {
                    violation("HIGH", "1.6", "a sub-minSupplyAmount NEW position landed under same-block contention — F-C squat cost bypassed",
                        "npx hardhat --config hardhat.concurrency.config.js test test/concurrency/C1-supply-contention.test.js -g '1.6'");
                }
                expect(by["b-sub1"].ok, "sub-minimum NEW position landed").to.equal(false);
                expect(by["b-sub2"].ok, "sub-minimum NEW position landed (second try)").to.equal(false);
                expect(await f.mp.isInPoolLenders(aid, b.address), "b acquired a slot with < minSupply").to.equal(false);
                expect((await f.mp.positions(aid, b.address)).amount).to.equal(0n);
                expect(by["c-exact"].ok, `exact-minimum supply refused: ${by["c-exact"].reason}`).to.equal(true);

                const aPos = await f.mp.positions(aid, a.address);
                if (run % 2 === 0) expect(aPos.amount).to.equal(min + 1n); // top-up behind the qualifying supply
                else expect(aPos.amount).to.equal(min);                    // top-up in front of it: refused

                const v = await assertInvariants(f, [aid], `1.6 run=${run}`);
                record("1.6 minSupplyAmount under contention", {
                    run, reversed: run % 2 === 1, subMinimumLanded: by["b-sub1"].ok || by["b-sub2"].ok,
                    aFinalPrincipal: aPos.amount.toString(), violations: v.length,
                });
            });
        }
        note("1.6: a sender's OWN sub-minimum top-up is order-dependent — legal behind their qualifying supply, refused in front of it. Correct per F-C, but a client that fires both in one batch gets a different result per ordering and must not assume both land.");
    });
});
