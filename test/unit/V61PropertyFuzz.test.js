// V6.1 property fuzz (2026-09-20): random interleavings of top-up / withdraw / loan /
// repay / liquidate / claim / NFT-transfer / deactivate across 3 lenders × 2 agents,
// with time travel (late repayments beyond the 30d cap) and forced loss > Σ principal.
// Style follows test/unit/V6PropertyFuzz.test.js (seeded mulberry32, invariants after
// EVERY successful op). Op count: V61_FUZZ_OPS (default 2000).

const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const OPS = Number(process.env.V61_FUZZ_OPS || 2000);
const USDC = (n) => ethers.parseUnits(n.toString(), 6);
const DAY = 86400;
const CAP = 30 * DAY;

describe("V6.1 property fuzz — tranches / late repay / holder repay / interest-loss socialization", function () {
    this.timeout(1800000);
    let v6, registry, reputation, usdc, v6Address;
    let owner, agents, alts, lenders, stranger;

    let rngState;
    function mkRng(seed) { rngState = seed; }
    function rand() {
        rngState |= 0; rngState = (rngState + 0x6D2B79F5) | 0;
        let t = rngState;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    const randInt = (n) => Math.floor(rand() * n);
    const choice = (arr) => arr[randInt(arr.length)];

    async function deploy() {
        const signers = await ethers.getSigners();
        owner = signers[0];
        agents = [signers[1], signers[2]];
        alts = [signers[3], signers[4]];
        lenders = [signers[5], signers[6], signers[7]];
        stranger = signers[8];

        registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
        reputation = await (await ethers.getContractFactory("ReputationManagerV3")).deploy(await registry.getAddress());
        usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
        v6 = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV6")).deploy(
            await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
        v6Address = await v6.getAddress();
        await reputation.authorizePool(v6Address);
        await reputation.authorizePool(owner.address);

        for (const a of agents) {
            await registry.connect(a).register("ipfs://fuzz", []);
            await v6.connect(a).createAgentPool();
        }
        // agent 1 → 0% collateral tier (lossy defaults); agent 2 stays at score 0 (100% collateral)
        for (let i = 0; i < 65; i++) await reputation.recordLoanCompletion(agents[0].address, USDC(100), true);
        for (const w of [...agents, ...alts, ...lenders, stranger]) {
            await usdc.mint(w.address, USDC(10_000_000));
            await usdc.connect(w).approve(v6Address, ethers.MaxUint256);
        }
    }

    // ------------------------------------------------------------------ invariants
    const S = { open: [], loanMeta: new Map(), counters: {} };
    const bump = (k) => { S.counters[k] = (S.counters[k] || 0) + 1; };

    async function assertInvariants(label) {
        let sumAvail = 0n, sumLoaned = 0n, sumAmount = 0n, sumEarned = 0n;
        for (const aid of [1n, 2n]) {
            const pool = await v6.getAgentPool(aid);
            let a = 0n, e = 0n;
            const members = new Set();
            for (let i = 0n; i < pool.lenderCount; i++) {
                const l = (await v6.poolLenders(aid, i)).toLowerCase();
                expect(members.has(l), `${label}: duplicate lender`).to.equal(false);
                members.add(l);
                const p = await v6.positions(aid, l);
                a += p.amount; e += p.earnedInterest;
            }
            for (const L of lenders) {
                const p = await v6.positions(aid, L.address);
                const pt = await v6.pendingTranche(aid, L.address);
                expect(pt.amount, `${label}: (b) pending > amount`).to.be.lte(p.amount);
                if (pt.amount > 0n) expect(pt.timestamp, `${label}: (b) pending stamped before base`).to.be.gte(p.depositTimestamp);
                if (!members.has(L.address.toLowerCase())) {
                    expect(p.amount + p.earnedInterest + pt.amount, `${label}: non-member holds a position`).to.equal(0n);
                }
            }
            expect(pool.totalLiquidity, `${label}: totalLiquidity != Σ amount (pool ${aid})`).to.equal(a);
            expect(pool.availableLiquidity + pool.totalLoaned, `${label}: avail+loaned != Σ(amount+interest) (pool ${aid})`).to.equal(a + e);
            sumAvail += pool.availableLiquidity; sumLoaned += pool.totalLoaned; sumAmount += a; sumEarned += e;

            // (f) active set == tracked open loans of this agent; (h) outstanding principal
            const ids = (await v6.getActiveLoanIds(aid)).map(Number).sort((x, y) => x - y);
            const tracked = S.open.filter((o) => o.aid === aid).map((o) => Number(o.id)).sort((x, y) => x - y);
            expect(ids, `${label}: (f) activeLoanIds != tracked open loans (pool ${aid})`).to.deep.equal(tracked);
            expect(await v6.activeLoanCount(aid), `${label}: (f) count`).to.equal(BigInt(ids.length));
            let outstanding = 0n;
            for (const o of S.open) if (o.aid === aid) outstanding += S.loanMeta.get(o.id).amount;
            expect(await v6.outstandingPrincipal(aid), `${label}: (h) outstandingPrincipal`).to.equal(outstanding);
            // (g) the F-01 premise
            const holder = await registry.ownerOf(aid);
            expect(await registry.addressToAgentId(holder), `${label}: (g) holder maps back`).to.equal(aid);
        }
        let sumColl = 0n;
        for (const o of S.open) sumColl += S.loanMeta.get(o.id).coll;
        const fees = await v6.accumulatedFees();
        const bal = await usdc.balanceOf(v6Address);
        expect(bal, `${label}: (a) exact solvency`).to.equal(sumAvail + fees + sumColl);
        expect(bal + sumLoaned, `${label}: (a) balance identity`).to.equal(sumAmount + sumEarned + fees + sumColl);
    }

    // ------------------------------------------------------------------ ops
    async function holderOf(aid) { return registry.ownerOf(aid); }
    function signerFor(addr) {
        return [...agents, ...alts, ...lenders, stranger, owner].find((s) => s.address.toLowerCase() === addr.toLowerCase());
    }
    const revertMsg = (e) => String(e && (e.reason || e.shortMessage || e.message) || "");

    async function opSupply(aid) {
        const L = choice(lenders);
        const amt = USDC((0.5 + rand() * 50).toFixed(6));
        const can = await v6.canTopUp(aid, L.address);
        const before = await v6.pendingTranche(aid, L.address);
        try {
            await v6.connect(L).supplyLiquidity(aid, amt);
            expect(can, "(i) canTopUp said false but supply succeeded").to.equal(true);
            const after = await v6.pendingTranche(aid, L.address);
            if (after.amount === 0n) bump("supply.base");
            else if (before.amount === 0n) bump("supply.pendingCreate");
            else if (after.amount === amt) bump("supply.fold");
            else if (after.amount === before.amount + amt) bump("supply.merge");
            return `supply(${aid}, ${ethers.formatUnits(amt, 6)})`;
        } catch (e) {
            const m = revertMsg(e);
            if (m.includes("Top-up would forfeit")) {
                expect(can, "(i) canTopUp said true but supply was refused").to.equal(false);
                bump("supply.refused");
                return `supply refused (case e) for ${L.address.slice(0, 8)} on pool ${aid}`;
            }
            return null;
        }
    }

    async function opWithdraw(aid, all) {
        const L = choice(lenders);
        const p = await v6.positions(aid, L.address);
        if (p.amount === 0n) return null;
        const avail = (await v6.getAgentPool(aid)).availableLiquidity;
        let amt;
        if (all) {
            if (avail < p.amount) return null;
            amt = p.amount;
        } else {
            const max = p.amount < avail ? p.amount : avail;
            if (max === 0n) return null;
            amt = BigInt(Math.floor(rand() * Number(max))) + 1n;
            if (amt > max) amt = max;
        }
        try {
            await v6.connect(L).withdrawLiquidity(aid, amt);
        } catch (e) {
            if (all) expect.fail(`(d) full withdraw of ${amt} refused with avail ${avail}: ${revertMsg(e)}`);
            return null;
        }
        if (all) {
            const after = await v6.positions(aid, L.address);
            expect(after.amount, "(d) full withdraw left principal").to.equal(0n);
            expect((await v6.pendingTranche(aid, L.address)).amount, "(d) full withdraw left pending").to.equal(0n);
            bump("withdraw.all");
        } else bump("withdraw.partial");
        return `withdraw(${aid}, ${ethers.formatUnits(amt, 6)}${all ? ", ALL" : ""})`;
    }

    // Every lender pulls as much principal as availableLiquidity allows → the pool is
    // backed by unclaimed interest only; a later default then has loss > Σ principal.
    async function opDrain(aid) {
        let n = 0;
        for (const L of lenders) {
            const p = await v6.positions(aid, L.address);
            const avail = (await v6.getAgentPool(aid)).availableLiquidity;
            const w = p.amount < avail ? p.amount : avail;
            if (w === 0n) continue;
            await v6.connect(L).withdrawLiquidity(aid, w); // must never revert (d)
            n++;
        }
        if (n === 0) return null;
        bump("drain");
        return `drain(${aid}) ×${n}`;
    }

    async function opRequestLoan(aid) {
        const holder = await holderOf(aid);
        const signer = signerFor(holder);
        const avail = (await v6.getAgentPool(aid)).availableLiquidity;
        if (avail === 0n) return null;
        let amt = USDC((0.5 + rand() * 20).toFixed(6));
        if (amt > avail) amt = avail; // sub-USDC loans: lets a drained pool lend its unclaimed interest
        const durDays = 7 + randInt(60);
        const active = await registry.isAgentActive(holder);
        const id = await v6.nextLoanId();
        try {
            await v6.connect(signer).requestLoan(amt, durDays);
        } catch (e) {
            const m = revertMsg(e);
            if (m.includes("Agent deactivated")) { expect(active, "(l) active agent refused as deactivated").to.equal(false); bump("loan.blockedInactive"); return `loan blocked (deactivated) pool ${aid}`; }
            return null;
        }
        expect(active, "(l) deactivated agent opened a loan").to.equal(true);
        const l = await v6.loans(id);
        S.open.push({ id, aid });
        S.loanMeta.set(id, { amount: l.amount, coll: l.collateralAmount, rate: l.interestRate, start: l.startTime, end: l.endTime, dur: l.duration, borrower: l.borrower });
        bump("loan");
        return `requestLoan(${aid}, ${ethers.formatUnits(amt, 6)}, ${durDays}d) → #${id}`;
    }

    async function opRepay() {
        if (S.open.length === 0) return null;
        const idx = randInt(S.open.length);
        const { id, aid } = S.open[idx];
        const m = S.loanMeta.get(id);
        // time travel: 0 now / 1 inside term / 2 late ≤30d / 3 late 31..90d (beyond cap)
        const mode = randInt(4);
        const now = BigInt(await time.latest());
        let target = now;
        if (mode === 1) target = m.start + (m.dur * BigInt(randInt(256))) / 256n;
        else if (mode === 2) target = m.end + 1n + BigInt(randInt(30) * DAY);
        else if (mode === 3) target = m.end + BigInt(31 * DAY) + BigInt(randInt(60) * DAY);
        if (target > now) await time.increaseTo(target);

        const who = randInt(3);
        const holder = await holderOf(aid);
        const payer = who === 0 ? m.borrower : (who === 1 ? holder : stranger.address);
        const payerSigner = signerFor(payer);

        // expected interest at the block the repay will land in: pin the timestamp
        const ts = BigInt(await time.latest()) + 1n;
        await time.setNextBlockTimestamp(ts);
        const elapsed = ts - m.start;
        let chargeable = elapsed > m.dur ? elapsed : m.dur;
        if (chargeable > m.dur + BigInt(CAP)) chargeable = m.dur + BigInt(CAP);
        const expected = await v6.calculateInterest(m.amount, m.rate, chargeable);
        const lateSeconds = ts > m.end ? ts - m.end : 0n;
        const feeRate = await v6.platformFeeRate();
        const platformFee = (expected * feeRate) / 10000n;
        const lenderInterest = expected - platformFee;

        // qualified snapshot for (c)
        const pool = await v6.getAgentPool(aid);
        const ls = [], q = [], eBefore = [];
        let qTotal = 0n;
        for (let i = 0n; i < pool.lenderCount; i++) {
            const l = await v6.poolLenders(aid, i);
            ls.push(l);
            const qi = await v6.qualifiedAmountAt(aid, l, m.start);
            q.push(qi); qTotal += qi;
            eBefore.push((await v6.positions(aid, l)).earnedInterest);
        }
        const feesBefore = await v6.accumulatedFees();
        const borrowerBal = await usdc.balanceOf(m.borrower);
        const payerBal = await usdc.balanceOf(payer);

        try {
            await v6.connect(payerSigner).repayLoan(id);
        } catch (e) {
            const msg = revertMsg(e);
            if (payer === stranger.address) { expect(msg, "(j) stranger refused with the wrong reason").to.include("Not the borrower"); bump("repay.strangerRefused"); return `repay #${id} by stranger refused`; }
            expect.fail(`(j) ${who === 0 ? "borrower" : "holder"} repay of #${id} reverted: ${msg}`);
        }
        expect(payer, "(j) stranger repaid a loan").to.not.equal(stranger.address);
        S.open.splice(idx, 1);
        bump("repay");
        if (lateSeconds > 0n) bump("repay.late");
        if (elapsed > m.dur + BigInt(CAP)) bump("repay.beyondCap");
        if (payer.toLowerCase() !== m.borrower.toLowerCase()) bump("repay.byHolder");

        const rec = await v6.repayments(id);
        expect(rec.interestPaid, "(e) interestPaid").to.equal(expected);
        expect(rec.lateSeconds, "(e) lateSeconds").to.equal(lateSeconds);
        expect(rec.repaidAt).to.equal(ts);
        // (j) collateral → loan.borrower; principal + interest ← payer
        if (payer.toLowerCase() === m.borrower.toLowerCase()) {
            expect(await usdc.balanceOf(m.borrower), "(j) borrower net").to.equal(borrowerBal - (m.amount + expected) + m.coll);
        } else {
            expect(await usdc.balanceOf(m.borrower), "(j) collateral to borrower").to.equal(borrowerBal + m.coll);
            expect(await usdc.balanceOf(payer), "(j) holder paid").to.equal(payerBal - (m.amount + expected));
        }
        // (c) exact per-lender distribution by qualifiedAmountAt(loan.start)
        let distributed = 0n;
        for (let i = 0; i < ls.length; i++) {
            const share = qTotal === 0n ? 0n : (lenderInterest * q[i]) / qTotal;
            const eAfter = (await v6.positions(aid, ls[i])).earnedInterest;
            expect(eAfter, `(c) share for lender ${i}`).to.equal(eBefore[i] + share);
            distributed += share;
        }
        expect(await v6.accumulatedFees(), "(c) fees = platform fee + dust").to.equal(feesBefore + platformFee + (lenderInterest - distributed));
        return `repay #${id} mode ${mode} by ${who === 0 ? "borrower" : "holder"} (late ${lateSeconds}s)`;
    }

    async function opLiquidate() {
        if (S.open.length === 0) return null;
        const idx = randInt(S.open.length);
        const { id, aid } = S.open[idx];
        const m = S.loanMeta.get(id);
        const now = BigInt(await time.latest());
        if (now <= m.end) await time.increaseTo(m.end + 1n);
        const loss = m.amount > m.coll ? m.amount - m.coll : 0n;
        const { p: pBefore, e: eBefore } = await sums(aid);
        try {
            await v6.liquidateLoan(id);
        } catch (e) {
            expect.fail(`(k) liquidation of overdue #${id} reverted: ${revertMsg(e)}`);
        }
        S.open.splice(idx, 1);
        const { p: pAfter, e: eAfter } = await sums(aid);
        const expP = loss > pBefore ? pBefore : loss;
        const rest = loss - expP;
        const expE = rest > eBefore ? eBefore : rest;
        expect(pBefore - pAfter, "(k) principal reduction").to.equal(expP);
        expect(eBefore - eAfter, "(k) interest reduction").to.equal(expE);
        bump("liquidate");
        if (loss > 0n) bump("liquidate.lossy");
        if (loss > pBefore) bump("liquidate.lossOverPrincipal");
        if (expE > 0n) bump("liquidate.interestSocialized");
        return `liquidate #${id} loss ${ethers.formatUnits(loss, 6)} (Σp ${ethers.formatUnits(pBefore, 6)}, Σi ${ethers.formatUnits(eBefore, 6)})`;
    }

    // Compound op: drain every lender's principal from pool 1 (0%-collateral agent), lend
    // out whatever is left (unclaimed interest only), let it go overdue and liquidate —
    // the F-05 scenario where loss > Σ principal and earnedInterest must absorb the rest.
    async function opForceLossOverPrincipal() {
        const aid = 1n;
        if (S.open.some((o) => o.aid === aid)) return null;         // needs a quiet pool
        await opDrain(aid);
        const pool = await v6.getAgentPool(aid);
        if (pool.availableLiquidity === 0n) return null;
        const { p } = await sums(aid);
        if (p >= pool.availableLiquidity) return null;                // still principal-backed
        const holder = await holderOf(aid);
        if (!(await registry.isAgentActive(holder))) await registry.reactivateAgent(aid);
        const id = await v6.nextLoanId();
        await v6.connect(signerFor(await holderOf(aid))).requestLoan(pool.availableLiquidity, 7);
        const l = await v6.loans(id);
        S.open.push({ id, aid });
        S.loanMeta.set(id, { amount: l.amount, coll: l.collateralAmount, rate: l.interestRate, start: l.startTime, end: l.endTime, dur: l.duration, borrower: l.borrower });
        await assertInvariants(`forced-loss loan #${id}`);
        await time.increaseTo(l.endTime + 1n);
        const idx = S.open.findIndex((o) => o.id === id);
        S.open.splice(idx, 1); S.open.push({ id, aid });              // make it the last entry
        // reuse opLiquidate's exact-reduction checks by pinning the choice
        const m = S.loanMeta.get(id);
        const loss = m.amount > m.coll ? m.amount - m.coll : 0n;
        const { p: pBefore, e: eBefore } = await sums(aid);
        await v6.liquidateLoan(id);
        S.open.splice(S.open.findIndex((o) => o.id === id), 1);
        const { p: pAfter, e: eAfter } = await sums(aid);
        const expP = loss > pBefore ? pBefore : loss;
        const expE = (loss - expP) > eBefore ? eBefore : (loss - expP);
        expect(pBefore - pAfter, "(k) forced: principal reduction").to.equal(expP);
        expect(eBefore - eAfter, "(k) forced: interest reduction").to.equal(expE);
        bump("liquidate"); bump("liquidate.lossy");
        if (loss > pBefore) bump("liquidate.lossOverPrincipal");
        if (expE > 0n) bump("liquidate.interestSocialized");
        return `forced loss>principal: loss ${ethers.formatUnits(loss, 6)} vs Σp ${ethers.formatUnits(pBefore, 6)} Σi ${ethers.formatUnits(eBefore, 6)}`;
    }

    async function sums(aid) {
        const pool = await v6.getAgentPool(aid);
        let p = 0n, e = 0n;
        for (let i = 0n; i < pool.lenderCount; i++) {
            const pos = await v6.positions(aid, await v6.poolLenders(aid, i));
            p += pos.amount; e += pos.earnedInterest;
        }
        return { p, e };
    }

    async function opClaim(aid) {
        const L = choice(lenders);
        const earned = (await v6.positions(aid, L.address)).earnedInterest;
        if (earned === 0n) return null;
        const avail = (await v6.getAgentPool(aid)).availableLiquidity;
        if (avail < earned) {
            // Unclaimed interest is lendable (by design); while it is out on loan the claim
            // must wait for repayment — and must fail with exactly this reason, nothing else.
            await expect(v6.connect(L).claimInterest(aid)).to.be.revertedWith("Drain underflow");
            bump("claim.deferredWhileLent");
            return `claim(${aid}) deferred (interest lent out)`;
        }
        await v6.connect(L).claimInterest(aid);
        bump("claim");
        return `claim(${aid}) by ${L.address.slice(0, 8)}`;
    }

    async function opTransfer(aid) {
        const holder = await holderOf(aid);
        const i = Number(aid) - 1;
        const to = holder.toLowerCase() === agents[i].address.toLowerCase() ? alts[i] : agents[i];
        await registry.connect(signerFor(holder)).transferFrom(holder, to.address, aid);
        bump("nft.transfer");
        return `transfer agent ${aid} → ${to.address.slice(0, 8)}`;
    }

    async function opToggleActive(aid) {
        const holder = await holderOf(aid);
        if (await registry.isAgentActive(holder)) { await registry.deactivateAgent(aid); bump("agent.deactivate"); return `deactivate ${aid}`; }
        await registry.reactivateAgent(aid); bump("agent.reactivate"); return `reactivate ${aid}`;
    }

    async function opTime() {
        const secs = 1 + randInt(20 * DAY);
        await time.increase(secs);
        return `time +${(secs / DAY).toFixed(1)}d`;
    }

    // weighted op table
    const OPTABLE = [
        ["supply", 18], ["withdraw", 10], ["withdrawAll", 5], ["drain", 3], ["loan", 18],
        ["repay", 16], ["liquidate", 8], ["claim", 6], ["transfer", 4], ["toggle", 2], ["time", 6],
        ["forceLoss", 2],
    ];
    const TOTALW = OPTABLE.reduce((s, [, w]) => s + w, 0);
    function pickOp() {
        let r = rand() * TOTALW;
        for (const [name, w] of OPTABLE) { if (r < w) return name; r -= w; }
        return "time";
    }

    async function step() {
        const op = pickOp();
        const aid = choice([1n, 2n]);
        switch (op) {
            case "supply": return opSupply(aid);
            case "withdraw": return opWithdraw(aid, false);
            case "withdrawAll": return opWithdraw(aid, true);
            case "drain": return opDrain(aid);
            case "loan": return opRequestLoan(aid);
            case "repay": return opRepay();
            case "liquidate": return opLiquidate();
            case "claim": return opClaim(aid);
            case "transfer": return opTransfer(aid);
            case "toggle": return opToggleActive(aid);
            case "forceLoss": return opForceLossOverPrincipal();
            default: return opTime();
        }
    }

    async function run(seed, ops, label) {
        mkRng(seed);
        S.open = []; S.loanMeta = new Map(); S.counters = {};
        let executed = 0;
        for (let i = 0; i < ops; i++) {
            const r = await step();
            if (r) { executed++; await assertInvariants(`${label} op ${i}: ${r}`); }
        }
        // reactivate so the final drain/repay sweep is unconstrained
        for (const aid of [1n, 2n]) if (!(await registry.isAgentActive(await holderOf(aid)))) await registry.reactivateAgent(aid);
        console.log(`      → ${label}: ${executed}/${ops} ops executed; ${S.open.length} loans left open`);
        console.log(`      → profile: ${JSON.stringify(S.counters)}`);
        return executed;
    }

    it(`${OPS} random ops (seed 20260920): all V6.1 invariants hold after every op`, async () => {
        await deploy();
        const executed = await run(20260920, OPS, "seed-20260920");
        expect(executed).to.be.at.least(Math.floor(OPS * 0.6));
        // the walk must have exercised the V6.1-specific paths, not just the happy path
        const c = S.counters;
        for (const k of ["supply.pendingCreate", "supply.fold", "supply.merge", "supply.refused", "withdraw.all",
                         "repay.late", "repay.beyondCap", "repay.byHolder", "repay.strangerRefused",
                         "liquidate.lossy", "liquidate.lossOverPrincipal", "liquidate.interestSocialized",
                         "nft.transfer", "loan.blockedInactive"]) {
            expect(c[k] || 0, `path ${k} never exercised`).to.be.gt(0);
        }
    });

    it("different seed (137), 400 ops: invariants still hold", async () => {
        await deploy();
        const executed = await run(137, 400, "seed-137");
        expect(executed).to.be.at.least(200);
    });
});
