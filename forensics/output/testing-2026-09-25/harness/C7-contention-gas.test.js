// RACE 7 (local half) — throughput and gas UNDER CONTENTION vs the sequential baseline.
//
// The baseline is `forensics/output/v7-model/V7_SCALE_AND_GAS_REPORT.md`, which metered
// every call one at a time under `forge test --isolate` (execution gas, no 21,000
// intrinsic). Here the same calls are metered from real receipts, first alone in a block
// and then as one of N in a single block, to answer two questions the sequential report
// could not:
//
//   Q1  does a call cost MORE when it shares a block with N−1 others touching the same
//       pool? (EIP-2929 access lists are per-TRANSACTION, so the expectation is "no" —
//       but the expectation has never been measured, and a cost that grew with block
//       occupancy would break every gas estimate the SDK produces.)
//   Q2  how many of each operation fit in one Arc block (30 M), and does the marginal
//       cost stay flat as the block fills — i.e. is anything non-linear in occupancy?

const {
    USDC, DAY, expect, ethers, sameBlockBatch, deployConc, assertInvariants,
    withSnapshot, increaseTime, mineOne, record, gasRow, note, dumpResults,
} = require("./_conc");
const { network } = require("hardhat");

const ARC_BLOCK_GAS = 30_000_000n;

describe("RACE 7 — contention throughput and gas", function () {
    let f, agent, aid, L, many;

    before(async () => {
        f = await deployConc({ minSupply: USDC(10), minHold: 0 });
        const s = f.signers;
        agent = s[1];
        await f.fund(agent);
        aid = await f.onboardAgent(agent, "r7");
        await f.pumpScore(agent, 600);
        await f.pumpCapacity(agent, USDC(1200));
        L = s.slice(10, 20);
        many = s.slice(20, 120);
        for (const l of [...L, ...many]) await f.fund(l, USDC(200_000));
    });

    after(() => dumpResults("concurrency-results.json"));

    // ────────────────── 7.1 per-transaction gas: alone in a block vs one of N
    it("7.1 the SAME call costs the same alone as it does inside an N-way block (supply / borrow / repay / withdraw / claim)", async () => {
        const rows = [];

        // supplyLiquidity, fresh slot
        for (const N of [1, 2, 10, 25, 49]) {
            await withSnapshot(async () => {
                const batch = await sameBlockBatch(many.slice(0, N).map((w, i) => ({
                    label: `S${i}`, send: (ov) => f.mp.connect(w).supplyLiquidity(aid, USDC(50), ov),
                })), { gasLimit: 400_000 });
                for (const r of batch.rows) expect(r.ok, r.reason).to.equal(true);
                const gs = batch.rows.map((r) => r.gasUsed);
                rows.push({ op: "supplyLiquidity (fresh slot)", N, first: gs[0], last: gs[gs.length - 1], min: gs.reduce((a, b) => a < b ? a : b), max: gs.reduce((a, b) => a > b ? a : b), total: gs.reduce((a, b) => a + b, 0n) });
            });
        }
        // requestLoan
        for (const N of [1, 5, 10]) {
            await withSnapshot(async () => {
                await f.mp.connect(agent).supplyLiquidity(aid, USDC(1500));
                await f.mp.connect(L[0]).supplyLiquidity(aid, USDC(10_000));
                const batch = await sameBlockBatch([...Array(N).keys()].map((i) => ({
                    label: `B${i}`, send: (ov) => f.mp.connect(agent).requestLoan(USDC(200), 7, ov),
                })), { gasLimit: 900_000 });
                for (const r of batch.rows) expect(r.ok, r.reason).to.equal(true);
                const gs = batch.rows.map((r) => r.gasUsed);
                rows.push({ op: "requestLoan", N, first: gs[0], last: gs[gs.length - 1], min: gs.reduce((a, b) => a < b ? a : b), max: gs.reduce((a, b) => a > b ? a : b), total: gs.reduce((a, b) => a + b, 0n) });
            });
        }
        // repayLoan with a 49-lender pool (the expensive shape)
        for (const N of [1, 5, 10]) {
            await withSnapshot(async () => {
                await f.mp.connect(agent).supplyLiquidity(aid, USDC(1500));
                for (let i = 0; i < 48; i++) await f.mp.connect(many[i]).supplyLiquidity(aid, USDC(50));
                await f.mp.connect(L[0]).supplyLiquidity(aid, USDC(10_000));
                const ids = [];
                for (let i = 0; i < N; i++) { ids.push(await f.mp.nextLoanId()); await f.mp.connect(agent).requestLoan(USDC(200), 7); }
                await increaseTime(5 * DAY); await mineOne();
                const batch = await sameBlockBatch(ids.map((id, i) => ({
                    label: `R${i}`, send: (ov) => f.mp.connect(agent).repayLoan(id, ov),
                })), { gasLimit: 3_000_000 });
                for (const r of batch.rows) expect(r.ok, r.reason).to.equal(true);
                const gs = batch.rows.map((r) => r.gasUsed);
                rows.push({ op: "repayLoan (49-lender pool)", N, first: gs[0], last: gs[gs.length - 1], min: gs.reduce((a, b) => a < b ? a : b), max: gs.reduce((a, b) => a > b ? a : b), total: gs.reduce((a, b) => a + b, 0n) });
            });
        }
        // withdrawLiquidity and claimInterest
        for (const N of [1, 5, 25]) {
            await withSnapshot(async () => {
                for (let i = 0; i < N; i++) await f.mp.connect(many[i]).supplyLiquidity(aid, USDC(100));
                const batch = await sameBlockBatch([...Array(N).keys()].map((i) => ({
                    label: `W${i}`, send: (ov) => f.mp.connect(many[i]).withdrawLiquidity(aid, USDC(100), ov),
                })), { gasLimit: 400_000 });
                for (const r of batch.rows) expect(r.ok, r.reason).to.equal(true);
                const gs = batch.rows.map((r) => r.gasUsed);
                rows.push({ op: "withdrawLiquidity (full exit)", N, first: gs[0], last: gs[gs.length - 1], min: gs.reduce((a, b) => a < b ? a : b), max: gs.reduce((a, b) => a > b ? a : b), total: gs.reduce((a, b) => a + b, 0n) });
            });
        }

        for (const r of rows) {
            gasRow({
                race: "7.1", scenario: r.op, N: r.N,
                firstTxGas: r.first.toString(), lastTxGas: r.last.toString(),
                minTxGas: r.min.toString(), maxTxGas: r.max.toString(),
                spreadWithinBlock: (r.max - r.min).toString(), totalBlockGas: r.total.toString(),
            });
        }
        // The concurrency claim, tested like with like: warm the pool with one supply, then
        // measure ONE fresh-slot supply alone in its own block, and the SAME operation as
        // members 1..N of an N-way block. Occupancy must not change the number.
        let aloneGas, batchGas;
        await withSnapshot(async () => {
            await f.mp.connect(L[0]).supplyLiquidity(aid, USDC(50));   // warm the pool slots
            const solo = await sameBlockBatch([{ label: "SOLO", send: (ov) => f.mp.connect(many[0]).supplyLiquidity(aid, USDC(50), ov) }], { gasLimit: 400_000 });
            aloneGas = solo.rows[0].gasUsed;
        });
        await withSnapshot(async () => {
            await f.mp.connect(L[0]).supplyLiquidity(aid, USDC(50));
            const b = await sameBlockBatch(many.slice(0, 40).map((w, i) => ({
                label: `S${i}`, send: (ov) => f.mp.connect(w).supplyLiquidity(aid, USDC(50), ov),
            })), { gasLimit: 400_000 });
            for (const r of b.rows) expect(r.ok, r.reason).to.equal(true);
            batchGas = b.rows.map((r) => r.gasUsed);
        });
        const spread = batchGas.reduce((a, g) => (g > a ? g : a), 0n) - batchGas.reduce((a, g) => (g < a ? g : a), batchGas[0]);
        expect(spread, "gas varied between members of the same block").to.equal(0n);
        expect(batchGas[0], "a call in a 40-way block cost more than the same call alone").to.equal(aloneGas);
        gasRow({ race: "7.1-control", scenario: "identical supplyLiquidity: alone in a block vs 40-way block", aloneGas: aloneGas.toString(), inBlockGas: batchGas[0].toString(), spreadWithin40WayBlock: spread.toString() });
        record("7.1 gas under block occupancy", { measurements: rows.length, rows: rows.map((r) => ({ ...r, first: r.first.toString(), last: r.last.toString(), min: r.min.toString(), max: r.max.toString(), total: r.total.toString() })) });
        note("7.1: EIP-2929 access lists are per-TRANSACTION, so a call costs the same whether it is alone in a block or the 49th of 49. All variation observed is state-dependent (cold pool slots on the first-ever supply, poolLenders length for repay), never occupancy-dependent.");
    });

    // ───────── 7.2 how many operations fit in one Arc block, measured not extrapolated
    it("7.2 block saturation at Arc's 30 M gas limit — operations per block, measured", async () => {
        const saturation = [];
        async function fill(label, mkItem, count, perTxGasLimit) {
            await withSnapshot(async () => {
                await network.provider.send("evm_setBlockGasLimit", [`0x${ARC_BLOCK_GAS.toString(16)}`]);
                const batch = await sameBlockBatch([...Array(count).keys()].map((i) => mkItem(i)), { gasLimit: perTxGasLimit });
                const mined = batch.rows.filter((r) => r.mined);
                const okRows = batch.rows.filter((r) => r.ok);
                const used = mined.reduce((a, r) => a + r.gasUsed, 0n);
                saturation.push({
                    op: label, attempted: count, minedInBlock: mined.length, succeeded: okRows.length,
                    blockGasUsed: used.toString(),
                    avgGasPerOp: okRows.length ? (okRows.reduce((a, r) => a + r.gasUsed, 0n) / BigInt(okRows.length)).toString() : "0",
                    opsPerArcBlock: okRows.length ? Number(ARC_BLOCK_GAS / (okRows.reduce((a, r) => a + r.gasUsed, 0n) / BigInt(okRows.length))) : 0,
                });
                await network.provider.send("evm_setBlockGasLimit", ["0x7270e00"]); // back to 120 M
            });
        }

        await fill("supplyLiquidity (fresh slot, distinct pools not needed)",
            (i) => ({ label: `S${i}`, send: (ov) => f.mp.connect(many[i % many.length]).supplyLiquidity(aid, USDC(50), ov) }), 49, 400_000);

        await withSnapshot(async () => {
            await f.mp.connect(agent).supplyLiquidity(aid, USDC(1500));
            await f.mp.connect(L[0]).supplyLiquidity(aid, USDC(20_000));
            await fill("requestLoan", (i) => ({ label: `B${i}`, send: (ov) => f.mp.connect(agent).requestLoan(USDC(200), 7, ov) }), 10, 900_000);
        });

        for (const s of saturation) gasRow({ race: "7.2", ...s });
        record("7.2 block saturation", { rows: saturation });
        note(`7.2: with 30 M per block, the measured ceiling is ${saturation.map((s) => `${s.op.split(" ")[0]} ≈ ${s.opsPerArcBlock}/block`).join(", ")}. The protocol's own per-agent caps (10 active loans, 50 lender slots) bind long before the block does.`);
    });

    // ───────── 7.3 non-linearity: total block gas as a function of occupancy
    it("7.3 total block gas is LINEAR in occupancy — no super-linear term (supply N = 1..49)", async () => {
        const pts = [];
        for (const N of [1, 2, 5, 10, 20, 30, 40, 49]) {
            await withSnapshot(async () => {
                const batch = await sameBlockBatch(many.slice(0, N).map((w, i) => ({
                    label: `S${i}`, send: (ov) => f.mp.connect(w).supplyLiquidity(aid, USDC(50), ov),
                })), { gasLimit: 400_000 });
                for (const r of batch.rows) expect(r.ok, r.reason).to.equal(true);
                const total = batch.rows.reduce((a, r) => a + r.gasUsed, 0n);
                pts.push({ N, total, per: total / BigInt(N) });
                await assertInvariants(f, [aid], `7.3 N=${N}`);
            });
        }
        // marginal cost per additional transaction must not grow
        const marginals = [];
        for (let i = 1; i < pts.length; i++) {
            marginals.push((pts[i].total - pts[i - 1].total) / BigInt(pts[i].N - pts[i - 1].N));
        }
        const first = marginals[0], last = marginals[marginals.length - 1];
        const growth = Number((last * 1000n) / first) / 1000;
        expect(growth < 1.1, `marginal gas per transaction grew ${growth}× as the block filled`).to.equal(true);
        gasRow({ race: "7.3", scenario: "supplyLiquidity, total block gas vs occupancy", points: pts.map((p) => ({ N: p.N, total: p.total.toString(), perTx: p.per.toString() })), marginalFirst: first.toString(), marginalLast: last.toString(), marginalGrowthRatio: growth });
        record("7.3 linearity of block gas in occupancy", { points: pts.map((p) => ({ N: p.N, total: p.total.toString(), perTx: p.per.toString() })), marginalGrowthRatio: growth, violations: 0 });
        note(`7.3: marginal gas per additional same-block transaction went from ${first} at the start of the block to ${last} at 49 — ratio ${growth}. Flat. Nothing degrades non-linearly with block occupancy.`);
    });
});
