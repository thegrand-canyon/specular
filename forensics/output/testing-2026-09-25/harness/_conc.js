// Shared harness for the 2026-09-25 CONCURRENCY round.
//
// WHAT "CONCURRENT" MEANS HERE
// ----------------------------
// The EVM executes the transactions of a block strictly one after another, each one
// atomic. There is therefore no such thing as two contract calls interleaving mid-body:
// a "race" in this protocol can only show up as one of three things.
//
//   (R1) ORDER DEPENDENCE — the same set of transactions in one block produces a
//        different end state, or a different winner, depending on the order the block
//        producer chose. Detected by running a batch in both orders and diffing.
//   (R2) TOCTOU BETWEEN AN OFF-CHAIN READ AND THE TRANSACTION — the client decided
//        with a view/estimate taken against block n and the transaction executes at
//        block n+1 against state somebody else moved. Detected by capturing the view
//        BEFORE the batch and comparing to the receipt.
//   (R3) MID-BLOCK INVARIANT BREAK — an invariant that holds at the end of a block but
//        not between two transactions of it. Only observable from inside the EVM, so
//        the batches below are interleaved at the transaction level and every invariant
//        is re-checked after EVERY transaction, not only after the batch.
//
// So this harness does three things the previous rounds did not: it builds blocks by
// hand (automine off, N transactions submitted, then exactly one `evm_mine`), it
// replays each reverted transaction against end-of-block state to prove whether the
// revert was ordering-dependent, and it checks the FULL invariant set after every
// single transaction of a contended batch.

const { ethers, network } = require("hardhat");
const { expect } = require("chai");

const USDC = (n) => ethers.parseUnits(n.toString(), 6);
const DAY = 24 * 60 * 60;

// ───────────────────────────────────────────────────────────── block control

async function setAutomine(on) {
    await network.provider.send("evm_setAutomine", [on]);
}
// Hardhat 2.29 runs on the EDR provider, which does NOT implement
// `hardhat_setMempoolOrder`. The config pins `mempool.order = "fifo"` instead, so
// submission order IS block order and the harness controls the producer's choice
// directly by enumerating orderings. Kept best-effort in case a future provider
// re-adds it; a missing method must not fail a race.
let _mempoolOrderSupported = true;
async function setMempoolOrder(order) {
    if (!_mempoolOrderSupported) return false;
    try {
        await network.provider.send("hardhat_setMempoolOrder", [order]);
        return true;
    } catch {
        _mempoolOrderSupported = false;
        return false;
    }
}
async function mineOne() {
    await network.provider.send("evm_mine", []);
}
async function increaseTime(secs) {
    await network.provider.send("evm_increaseTime", [Number(secs)]);
}
async function pendingCount() {
    const p = await network.provider.send("eth_getBlockByNumber", ["pending", false]);
    return p.transactions.length;
}
async function snapshot() {
    return network.provider.send("evm_snapshot", []);
}
async function revertTo(id) {
    return network.provider.send("evm_revert", [id]);
}
/** Run `fn` and always restore the chain to the state it started from. */
async function withSnapshot(fn) {
    const id = await snapshot();
    try { return await fn(); } finally { await revertTo(id); await setAutomine(true); }
}
/** All orderings of `arr` when |arr| <= 4, otherwise its |arr| rotations plus the reverse. */
function orderings(arr) {
    if (arr.length <= 1) return [arr];
    if (arr.length <= 4) {
        const out = [];
        const perm = (pre, rest) => {
            if (!rest.length) return out.push(pre);
            rest.forEach((x, i) => perm([...pre, x], [...rest.slice(0, i), ...rest.slice(i + 1)]));
        };
        perm([], arr);
        return out;
    }
    const out = arr.map((_, i) => [...arr.slice(i), ...arr.slice(0, i)]);
    out.push([...arr].reverse());
    return out;
}

/**
 * Submit every item in `items` while the miner is stopped, then mine EXACTLY ONE block.
 *
 * `items[i]` is `{ label, send(overrides) -> Promise<TransactionResponse> }`. `send` must
 * forward `overrides` (it carries the explicit gasLimit — without it ethers runs
 * eth_estimateGas against pending state, which both reverts client-side before the
 * transaction can race and mutates nothing, i.e. it would hide the very race we want).
 *
 * Returns one row per item: ok / reason / gasUsed / blockNumber / replayed-revert
 * classification, plus `sameBlock` for the batch.
 */
async function sameBlockBatch(items, opts = {}) {
    const gasLimit = opts.gasLimit ?? 3_000_000;
    const order = opts.order ?? "fifo";
    await setMempoolOrder(order);
    await setAutomine(false);

    const sent = [];
    for (const it of items) {
        const ov = { gasLimit };
        if (it.priorityFee !== undefined) {
            ov.maxPriorityFeePerGas = it.priorityFee;
            ov.maxFeePerGas = it.priorityFee + (opts.baseFeeCeiling ?? 50_000_000_000n);
        }
        try {
            const tx = await it.send(ov);
            sent.push({ label: it.label, hash: tx.hash, req: txRequestOf(tx), sendError: null });
        } catch (e) {
            // A send-time failure is NOT an on-chain race outcome; record it as such.
            sent.push({ label: it.label, hash: null, req: null, sendError: shortErr(e) });
        }
    }

    const nPending = await pendingCount();
    await mineOne();
    await setAutomine(true);
    await setMempoolOrder("fifo");

    const provider = ethers.provider;
    const rows = [];
    for (const s of sent) {
        if (!s.hash) {
            rows.push({ label: s.label, ok: false, mined: false, reason: s.sendError, gasUsed: 0n, blockNumber: null });
            continue;
        }
        const rc = await provider.getTransactionReceipt(s.hash);
        if (!rc) {
            rows.push({ label: s.label, ok: false, mined: false, reason: "not included in the mined block", gasUsed: 0n, blockNumber: null });
            continue;
        }
        const ok = rc.status === 1;
        let reason = null;
        let orderingDependent = null;
        let orderingNote = null;
        if (!ok) {
            const r = await replayRevert(s.req, rc.blockNumber);
            // Ground truth for WHY it reverted comes from the trace of the real
            // execution (mid-block state); the replays only classify whether a
            // different position in the block would have changed the outcome.
            reason = (await traceRevertReason(s.hash)) ?? r.reason;
            orderingDependent = r.orderingDependent;
            orderingNote = r.orderingNote;
        }
        rows.push({
            label: s.label, ok, mined: true, reason, orderingDependent, orderingNote,
            gasUsed: rc.gasUsed, blockNumber: rc.blockNumber, index: rc.index,
        });
    }
    const blocks = [...new Set(rows.filter((r) => r.blockNumber !== null).map((r) => r.blockNumber))];
    return {
        rows,
        sameBlock: blocks.length === 1,
        block: blocks[0] ?? null,
        pendingAtMine: nPending,
        order: rows.filter((r) => r.mined).sort((a, b) => a.index - b.index).map((r) => r.label),
    };
}

function txRequestOf(tx) {
    return { from: tx.from, to: tx.to, data: tx.data, value: tx.value ?? 0n };
}

/**
 * Re-execute a reverted transaction as an `eth_call` against END-OF-BLOCK state.
 *   * if it reverts the same way, the failure was unconditional given the block's state
 *     and we recover the require() string;
 *   * if the replay SUCCEEDS, the transaction only failed because of where the producer
 *     put it in the block — i.e. the outcome is ORDER DEPENDENT (R1), which is exactly
 *     what a race looks like from the outside.
 */
/**
 * The revert reason of the ACTUAL execution, read out of the transaction trace, so it
 * reflects mid-block state rather than a replay against the block's start or end. This
 * matters: a transaction at index 0 that fails "Remaining below minimum supply" replays
 * at END-of-block state as "Insufficient pool liquidity" because a later transaction in
 * the same block drained the pool — the replay reason would be a fiction.
 */
let _traceSupported = true;
async function traceRevertReason(hash) {
    if (!_traceSupported) return null;
    try {
        // Hardhat/EDR only implements the DEFAULT struct tracer (no callTracer); the
        // revert data comes back as `returnValue`. Structlogs are disabled so the
        // trace of a 2 M-gas call does not cost megabytes.
        const t = await network.provider.send("debug_traceTransaction",
            [hash, { disableStorage: true, disableMemory: true, disableStack: true }]);
        const out = t?.returnValue ?? t?.output;
        return decodeRevertData(out) ?? (t?.failed ? "(reverted with no reason string)" : null);
    } catch {
        _traceSupported = false;
        return null;
    }
}
function decodeRevertData(hex) {
    if (!hex || typeof hex !== "string") return null;
    const h = hex.startsWith("0x") ? hex : `0x${hex}`;
    if (h.length < 10) return null;
    if (h.slice(0, 10) === "0x08c379a0") {
        try { return ethers.AbiCoder.defaultAbiCoder().decode(["string"], `0x${h.slice(10)}`)[0]; } catch { return null; }
    }
    if (h.slice(0, 10) === "0x4e487b71") {
        try { return `Panic(0x${ethers.AbiCoder.defaultAbiCoder().decode(["uint256"], `0x${h.slice(10)}`)[0].toString(16)})`; } catch { return null; }
    }
    return null;
}

async function replayRevert(req, blockNumber) {
    const at = async (tag) => {
        try { await ethers.provider.call({ ...req, blockTag: tag }); return { ok: true, reason: null }; }
        catch (e) { return { ok: false, reason: decodeRevert(e) }; }
    };
    const start = await at(blockNumber - 1); // state BEFORE any transaction of this block
    const end = await at(blockNumber);       // state AFTER all of them
    if (start.ok && end.ok) {
        return { reason: "(would succeed both before and after the block — failed only where it sat)", orderingDependent: true, orderingNote: "positional" };
    }
    if (!start.ok && end.ok) {
        return { reason: start.reason, orderingDependent: true, orderingNote: "would-succeed-if-placed-later" };
    }
    if (start.ok && !end.ok) {
        return { reason: end.reason, orderingDependent: true, orderingNote: "front-run: would-succeed-if-placed-earlier" };
    }
    return { reason: end.reason, orderingDependent: false, orderingNote: "unconditional-in-this-block" };
}

function decodeRevert(e) {
    const m = e?.shortMessage || e?.message || String(e);
    const q = /reverted with reason string '([^']*)'/.exec(m) || /reverted: (.*)$/.exec(m);
    if (q) return q[1];
    if (/Panic/.test(m)) return m.slice(0, 120);
    return m.slice(0, 160);
}
function shortErr(e) {
    return (e?.shortMessage || e?.message || String(e)).slice(0, 180);
}

// ─────────────────────────────────────────────────────── stack under test

/**
 * Deploy the shipped V7 stack. Defaults mirror the LIVE Arc mainnet / Arc staging
 * levers read 2026-09-24 (M-1 on, minHold 86400, minSupply 10 USDC, fee 100 bps,
 * rate limit 5 points / 86400 s, ladder k=2 step=100 bootstrap=100).
 */
async function deployConc(opts = {}) {
    const signers = await ethers.getSigners();
    const owner = signers[0];
    const registry = await (await ethers.getContractFactory("AgentRegistryV2")).deploy();
    const reputation = await (await ethers.getContractFactory("ReputationManagerV4")).deploy(await registry.getAddress());
    const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
    const mp = await (await ethers.getContractFactory("AgentLiquidityMarketplaceV62")).deploy(
        await registry.getAddress(), await reputation.getAddress(), await usdc.getAddress());
    const mpAddr = await mp.getAddress();
    await reputation.authorizePool(mpAddr);

    await reputation.setReputationRateLimit(opts.rateLimit ?? 5, opts.rateWindow ?? DAY);
    await mp.setMinHoldForReputationReward(opts.minHold ?? DAY);
    await mp.setPlatformFeeRate(opts.feeBps ?? 100);
    await mp.setBindBorrowToPoolCreator(opts.bindM1 ?? true);
    await mp.setMinSupplyAmount(opts.minSupply ?? USDC(10));
    await reputation.setLadderParameters(
        opts.creditMultiple ?? 2, opts.growthStep ?? USDC(100),
        opts.bootstrapLimit ?? USDC(100), opts.refDuration ?? 7 * DAY);
    await reputation.setDefaultLockout(opts.lockout ?? 180 * DAY);
    if (opts.finalizeMigration !== false) await mp.setMigrationFinalized();

    const known = new Set();
    async function fund(w, amount = USDC(5_000_000)) {
        await usdc.mint(w.address, amount);
        await usdc.connect(w).approve(mpAddr, ethers.MaxUint256);
        known.add(w.address);
    }
    async function onboardAgent(w, tag = "c") {
        await registry.connect(w).register(`ipfs://${tag}-${w.address}`, []);
        const id = await registry.addressToAgentId(w.address);
        await reputation.connect(w)["initializeReputation()"]();
        await mp.connect(w).createAgentPool();
        known.add(w.address);
        return id;
    }
    /** Raise score through the authorized-pool path (owner is authorized on demand). */
    async function pumpScore(w, target) {
        if (!(await reputation.authorizedPools(owner.address))) await reputation.authorizePool(owner.address);
        const aid = await registry.addressToAgentId(w.address);
        const savedLimit = await reputation.maxReputationGainPerWindow();
        const savedWindow = await reputation.reputationGainWindow();
        await reputation.setReputationRateLimit(0, savedWindow); // pump is setup, not a measurement
        let synth = 1_000_000 + Math.floor(Math.random() * 1e6);
        while ((await reputation["getReputationScore(uint256)"](aid)) < BigInt(target)) {
            const id = synth++;
            await reputation.recordBorrow(w.address, id, USDC(100));
            await increaseTime(7 * DAY); await mineOne();
            await reputation.recordLoanCompletion(w.address, id, USDC(100), true, 0);
        }
        await reputation.setReputationRateLimit(savedLimit, savedWindow);
    }
    /** Raise ladder capacity (maxRepaidPrincipal) directly. */
    async function pumpCapacity(w, amount) {
        if (!(await reputation.authorizedPools(owner.address))) await reputation.authorizePool(owner.address);
        const aid = await registry.addressToAgentId(w.address);
        const id = 2_000_000 + Number(await reputation.loanCount(aid)) + Math.floor(Math.random() * 1e5);
        await reputation.recordBorrow(w.address, id, amount);
        await increaseTime(7 * DAY); await mineOne();
        await reputation.recordLoanCompletion(w.address, id, amount, true, 0);
    }

    return {
        signers, owner, registry, reputation, usdc, mp, mpAddr,
        fund, onboardAgent, pumpScore, pumpCapacity, known, USDC, DAY,
    };
}

// ─────────────────────────────────────────────────────────── invariant set

/**
 * The full invariant set, evaluated at the CURRENT head. Every id below is asserted
 * after every contended batch, and (in the interleave tests) after every transaction.
 *
 *  I-a1 per pool: totalLiquidity == Σ position.amount
 *  I-a2 per pool: availableLiquidity + totalLoaned == Σ (amount + earnedInterest)
 *  I-a3 global : usdc.balanceOf(mp) == Σ availableLiquidity + accumulatedFees
 *                                       + Σ collateral of ACTIVE loans
 *  I-b  pendingTranche.amount <= position.amount, for every (pool, lender)
 *  I-c1 poolLenders[] has no duplicate entry
 *  I-c2 isInPoolLenders[l] <=> l appears in poolLenders[]  (over every address the
 *       harness has ever touched, not just the ones currently listed)
 *  I-c3 poolLenders.length <= MAX_LENDERS_PER_POOL
 *  I-c4 every listed lender has amount > 0 or earnedInterest > 0 (no dust slot leak)
 *  I-d1 activeLoanCount[a] == |activeLoanIds[a]| == #ACTIVE loans of a
 *  I-d2 activeLoanIds has no duplicates and every entry is ACTIVE
 *  I-h  outstandingPrincipal[a] == Σ ACTIVE principal of a
 *  I-m2a creator position is non-withdrawable while outstandingPrincipal > 0
 *        (checked as a staticCall probe, so it costs no state)
 *  I-m2c selfStake >= requiredSelfStake(agentId, 0) whenever principal is outstanding
 *        and the tier is below 100 % collateral
 *  I-q  creditLimitOf <= MAX_TIER_LIMIT
 *  I-r  a locked-out agent's credit limit is exactly 0
 *  I-s  ladderLimit == max(bootstrap, k*maxRepaid + step); creditLimit == min(tier, ladder)
 */
async function checkInvariants(f, agentIds, label = "") {
    const v = [];
    const mp = f.mp;
    const MAXL = await mp.MAX_LENDERS_PER_POOL();
    const n = await mp.nextLoanId();

    // loan-derived aggregates
    const activeByAgent = new Map();
    let sumCollateral = 0n;
    for (let id = 1n; id < n; id++) {
        const l = await mp.loans(id);
        if (Number(l.state) === 1) {
            sumCollateral += l.collateralAmount;
            const k = l.agentId.toString();
            const e = activeByAgent.get(k) || { count: 0, principal: 0n, ids: [] };
            e.count++; e.principal += l.amount; e.ids.push(id.toString());
            activeByAgent.set(k, e);
        }
    }

    let sumAvail = 0n;
    for (const aid of agentIds) {
        const p = await mp.getAgentPool(aid);
        sumAvail += p.availableLiquidity;

        const listed = [];
        for (let i = 0n; i < p.lenderCount; i++) listed.push(await mp.poolLenders(aid, i));

        if (listed.length > Number(MAXL)) v.push(`I-c3 ${label} pool ${aid}: ${listed.length} lenders > cap ${MAXL}`);
        if (new Set(listed).size !== listed.length) v.push(`I-c1 ${label} pool ${aid}: duplicate entry in poolLenders`);

        let sumAmt = 0n, sumEarn = 0n;
        for (const l of listed) {
            const pos = await mp.positions(aid, l);
            const pt = await mp.pendingTranche(aid, l);
            sumAmt += pos.amount; sumEarn += pos.earnedInterest;
            if (pt.amount > pos.amount) v.push(`I-b ${label} pool ${aid} lender ${l}: pending ${pt.amount} > amount ${pos.amount}`);
            if (pos.amount === 0n && pos.earnedInterest === 0n) v.push(`I-c4 ${label} pool ${aid} lender ${l}: empty slot still listed`);
            if (!(await mp.isInPoolLenders(aid, l))) v.push(`I-c2 ${label} pool ${aid} lender ${l}: listed but flag false`);
        }
        // flag must be false for every address we know about that is not listed
        for (const addr of f.known) {
            if (listed.includes(addr)) continue;
            if (await mp.isInPoolLenders(aid, addr)) v.push(`I-c2 ${label} pool ${aid} ${addr}: flag true but not listed`);
        }

        if (p.totalLiquidity !== sumAmt) v.push(`I-a1 ${label} pool ${aid}: totalLiquidity ${p.totalLiquidity} != Σamount ${sumAmt}`);
        if (p.availableLiquidity + p.totalLoaned !== sumAmt + sumEarn) {
            v.push(`I-a2 ${label} pool ${aid}: avail+loaned ${p.availableLiquidity + p.totalLoaned} != Σ(amount+interest) ${sumAmt + sumEarn}`);
        }

        const act = activeByAgent.get(aid.toString()) || { count: 0, principal: 0n, ids: [] };
        const cnt = await mp.activeLoanCount(aid);
        const ids = await mp.getActiveLoanIds(aid);
        if (Number(cnt) !== act.count) v.push(`I-d1 ${label} agent ${aid}: activeLoanCount ${cnt} != ${act.count} ACTIVE loans`);
        if (ids.length !== act.count) v.push(`I-d1 ${label} agent ${aid}: |activeLoanIds| ${ids.length} != ${act.count}`);
        if (new Set(ids.map(String)).size !== ids.length) v.push(`I-d2 ${label} agent ${aid}: duplicate in activeLoanIds`);
        for (const i of ids) if (!act.ids.includes(i.toString())) v.push(`I-d2 ${label} agent ${aid}: activeLoanIds holds non-ACTIVE ${i}`);
        const op = await mp.outstandingPrincipal(aid);
        if (op !== act.principal) v.push(`I-h ${label} agent ${aid}: outstandingPrincipal ${op} != Σ ACTIVE ${act.principal}`);

        // M2 lock + coverage
        const creator = p.agentAddress;
        const ss = await mp.selfStake(aid);
        if (op > 0n && ss.amount > 0n) {
            const signer = await signerFor(f, creator);
            if (signer) {
                let withdrawable = false;
                try { await mp.connect(signer).withdrawLiquidity.staticCall(aid, 1n); withdrawable = true; } catch { /* locked */ }
                if (withdrawable) v.push(`I-m2a ${label} agent ${aid}: creator CAN withdraw while ${op} principal outstanding`);
            }
        }
        if (op > 0n) {
            const pct = await f.reputation.collateralRequirementOf(aid);
            if (pct < 100n) {
                const need = await mp.requiredSelfStake(aid, 0);
                if (ss.amount < need) v.push(`I-m2c ${label} agent ${aid}: selfStake ${ss.amount} < required ${need}`);
            }
        }

        // reputation-side
        const cap = await f.reputation.MAX_TIER_LIMIT();
        const cl = await f.reputation.creditLimitOf(aid);
        if (cl > cap) v.push(`I-q ${label} agent ${aid}: creditLimit ${cl} > MAX_TIER_LIMIT ${cap}`);
        if (await f.reputation.isLockedOut(aid)) {
            if (cl !== 0n) v.push(`I-r ${label} agent ${aid}: locked out but credit limit ${cl}`);
        } else {
            const k = await f.reputation.creditMultiple();
            const step = await f.reputation.growthStep();
            const boot = await f.reputation.bootstrapLimit();
            let ladder = k * (await f.reputation.maxRepaidPrincipal(aid)) + step;
            if (ladder < boot) ladder = boot;
            if ((await f.reputation.ladderLimit(aid)) !== ladder) v.push(`I-s ${label} agent ${aid}: ladderLimit drift`);
            const tl = await f.reputation.tierLimit(await f.reputation["getReputationScore(uint256)"](aid));
            const expect_ = ladder < tl ? ladder : tl;
            if (cl !== expect_) v.push(`I-s ${label} agent ${aid}: creditLimitOf ${cl} != min(tier ${tl}, ladder ${ladder})`);
        }
    }

    const bal = await f.usdc.balanceOf(f.mpAddr);
    const rhs = sumAvail + (await mp.accumulatedFees()) + sumCollateral;
    if (bal !== rhs) v.push(`I-a3 ${label} GLOBAL solvency: balance ${bal} != Σavail+fees+collateral ${rhs} (delta ${bal - rhs})`);

    return v;
}

const _signerCache = new Map();
async function signerFor(f, addr) {
    if (_signerCache.size === 0) for (const s of f.signers) _signerCache.set(s.address.toLowerCase(), s);
    return _signerCache.get(addr.toLowerCase()) || null;
}

async function assertInvariants(f, agentIds, label) {
    const v = await checkInvariants(f, agentIds, label);
    expect(v, `INVARIANT VIOLATIONS @ ${label}:\n  ${v.join("\n  ")}`).to.deep.equal([]);
    return v;
}

// ──────────────────────────────────────────────────────────── bookkeeping

const RESULTS = { races: [], violations: [], gas: [], notes: [] };

function record(race, row) {
    let r = RESULTS.races.find((x) => x.race === race);
    if (!r) { r = { race, runs: 0, rows: [] }; RESULTS.races.push(r); }
    r.runs++; r.rows.push(row);
}
function violation(sev, race, text, repro) {
    RESULTS.violations.push({ severity: sev, race, text, repro });
}
function gasRow(row) { RESULTS.gas.push(row); }
function note(t) { RESULTS.notes.push(t); }

function dumpResults(file) {
    const fs = require("fs");
    const path = require("path");
    const out = path.join(__dirname, "..", file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const prev = fs.existsSync(out) ? JSON.parse(fs.readFileSync(out, "utf8")) : { races: [], violations: [], gas: [], notes: [] };
    const merged = {
        races: [...prev.races, ...RESULTS.races],
        violations: [...prev.violations, ...RESULTS.violations],
        gas: [...prev.gas, ...RESULTS.gas],
        notes: [...prev.notes, ...RESULTS.notes],
    };
    fs.writeFileSync(out, JSON.stringify(merged, bigintSafe, 2));
    RESULTS.races = []; RESULTS.violations = []; RESULTS.gas = []; RESULTS.notes = [];
}
function bigintSafe(_k, v) { return typeof v === "bigint" ? v.toString() : v; }

module.exports = {
    USDC, DAY, ethers, expect,
    setAutomine, setMempoolOrder, mineOne, increaseTime, pendingCount, snapshot, revertTo,
    withSnapshot, orderings,
    sameBlockBatch, decodeRevert,
    deployConc, checkInvariants, assertInvariants,
    record, violation, gasRow, note, dumpResults, RESULTS,
};
