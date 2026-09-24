/**
 * RACE 7 — nonce and mempool reality on Arc STAGING (chainId 5042002).
 *
 * Everything else in this round was driven on a hardhat chain where the harness owns
 * the block producer. This script drives the same races against a REAL chain with a
 * REAL mempool: transactions are broadcast concurrently and the sequencer decides the
 * order. It answers the questions a synthetic block cannot:
 *
 *   * what does a client actually observe when it fires several transactions at once
 *     from ONE wallet (nonce allocation, "replacement underpriced", "nonce too low");
 *   * do independent wallets contending for the same pool actually land in one block,
 *     and does the accounting stay exact when they do;
 *   * which refusals are transient (the same call succeeds a block later) and which
 *     are terminal — i.e. what an SDK must retry and what it must surface.
 *
 * SAFETY
 *   * chainId is asserted to be 5042002 (Arc STAGING) before anything is broadcast;
 *     Arc mainnet (5042) and Base (8453) are never touched.
 *   * every actor is a throwaway wallet funded from the deployer, with a hard cap on
 *     total native spend (SPEND_CAP, default 25).
 *   * keys are written to `staging-wallets.json`, which .gitignore already covers
 *     (`forensics/output/STAR-STAR/*wallets*.json`).
 *
 * Usage:  node forensics/output/testing-2026-09-25/staging-concurrency.js [--phases=1,2,3]
 */
require("dotenv").config({ path: "/Users/peterschroeder/Specular/.env" });
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const HERE = __dirname;
const ROOT = path.join(HERE, "..", "..", "..");
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "src/config/arc-testnet-v6-addresses.json"), "utf8"));
const abi = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, "artifacts/contracts", rel), "utf8")).abi;

const CHAIN_ID = 5042002;
const MARKETPLACE = "0x7E4D144AbEB3C695Ec2DdF00Fc710aABC04bDd18";
const SPEND_CAP = ethers.parseEther(process.env.SPEND_CAP || "25");
const N_LENDERS = Number(process.env.N_LENDERS || 10);
const FUND_EACH = ethers.parseEther(process.env.FUND_EACH || "0.35");
const USDC = (n) => ethers.parseUnits(String(n), 6);
const RPCS = (process.env.ARC_CONC_RPCS ? process.env.ARC_CONC_RPCS.split(",") : [
    process.env.ARC_STAGING_RPC_URL, "https://arc-testnet-rpc.publicnode.com", "https://rpc.testnet.arc.io",
]).filter(Boolean);

const out = { startedAt: new Date().toISOString(), chainId: CHAIN_ID, marketplace: MARKETPLACE, phases: [], spend: {}, violations: [], notes: [] };
const log = (...a) => console.log(...a);
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() : v), 1);

function short(e) {
    const m = e?.shortMessage || e?.info?.error?.message || e?.message || String(e);
    return String(m).replace(/\s+/g, " ").slice(0, 170);
}
/** Decode a revert reason out of whatever shape the RPC/ethers gave us. */
function reasonOf(e) {
    if (typeof e?.reason === "string" && e.reason) return e.reason;
    const d = typeof e?.data === "string" ? e.data : e?.info?.error?.data;
    if (typeof d === "string" && d.startsWith("0x08c379a0")) {
        try { return ethers.AbiCoder.defaultAbiCoder().decode(["string"], `0x${d.slice(10)}`)[0]; } catch { /* malformed */ }
    }
    return short(e);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The public Arc testnet RPCs rate-limit this host hard (documented in CLAUDE.md), and a
 * concurrency harness is by construction the worst possible client for them. Wrap
 * `send` with a token bucket plus a bounded retry on 429 so the RATE LIMIT never gets
 * mistaken for a protocol result. Broadcasts are exempted from the bucket's ordering —
 * they still go out back to back, which is what keeps the contention real.
 */
function throttle(provider, perSecond) {
    const orig = provider.send.bind(provider);
    let tokens = perSecond, last = Date.now();
    const take = async () => {
        for (;;) {
            const now = Date.now();
            tokens = Math.min(perSecond, tokens + ((now - last) / 1000) * perSecond);
            last = now;
            if (tokens >= 1) { tokens -= 1; return; }
            await sleep(Math.ceil(((1 - tokens) / perSecond) * 1000));
        }
    };
    provider.send = async (method, params) => {
        for (let attempt = 0; attempt < 14; attempt++) {
            await take();
            try { return await orig(method, params); }
            catch (e) {
                // The rate-limit signal hides in several places depending on whether the
                // 429 came back as an HTTP status, a batch-level body, or a per-payload
                // JSON-RPC error (-32005) that ethers has already re-wrapped as a
                // CALL_EXCEPTION with "missing revert data". Search the whole object:
                // mistaking a rate limit for a protocol answer is the one failure mode
                // that would silently corrupt every conclusion in this report.
                let blob = String(e?.message || "");
                try { blob += ` ${JSON.stringify(e?.info || {})}`; } catch { /* circular */ }
                const limited = /rate limit|429|exceeded maximum retry|-32005|too many requests/i.test(blob);
                if (!limited || attempt === 13) throw e;
                await sleep(Math.min(8000, 600 * (attempt + 1)));
            }
        }
    };
    return provider;
}

async function pickProvider() {
    for (const url of RPCS) {
        try {
            const p = throttle(new ethers.JsonRpcProvider(url, CHAIN_ID, { batchMaxCount: 25, batchStallTime: 20 }),
                Number(process.env.RPC_PER_SEC || 3));
            const n = await p.getNetwork();
            if (Number(n.chainId) !== CHAIN_ID) throw new Error(`chainId ${n.chainId}`);
            await p.getBlockNumber();
            log(`RPC: ${url}`);
            return { provider: p, url };
        } catch (e) { log(`  RPC ${url} unusable: ${short(e)}`); }
    }
    throw new Error("no usable Arc-staging RPC");
}

/**
 * Replay a failed transaction as an eth_call at its own block (end-of-block state) and
 * at the block before it. Same classifier as the local harness: a revert that would
 * SUCCEED at a different point in the block is positional, i.e. the client should retry.
 */
async function classifyFailure(provider, tx, receipt) {
    const req = { from: tx.from, to: tx.to, data: tx.data, value: tx.value ?? 0n };
    const at = async (tag) => {
        try { await provider.call({ ...req, blockTag: tag }); return { ok: true, reason: null }; }
        catch (e) { return { ok: false, reason: reasonOf(e) }; }
    };
    const before = await at(receipt.blockNumber - 1);
    const after = await at(receipt.blockNumber);
    if (!before.ok && after.ok) return { reason: before.reason, transient: true, note: "would-succeed-if-placed-later" };
    if (before.ok && !after.ok) return { reason: after.reason, transient: true, note: "front-run: would-succeed-if-placed-earlier" };
    if (before.ok && after.ok) return { reason: "(succeeds before and after the block)", transient: true, note: "positional" };
    return { reason: after.reason, transient: false, note: "unconditional-in-this-block" };
}

const RECEIPT_TIMEOUT_MS = Number(process.env.RECEIPT_TIMEOUT_MS || 90_000);

/**
 * Broadcast every item at once, then wait for ALL receipts CONCURRENTLY against one
 * shared deadline, and classify the failures.
 *
 * The concurrency matters and was learned the hard way: an earlier version awaited the
 * receipts one at a time, so a batch that left a nonce GAP (six transactions, one of
 * which the RPC never accepted) burned `6 × timeout` in series and looked like a hang.
 * That is itself worth knowing — a gapped nonce makes every LATER transaction from the
 * same wallet unminable until the gap is filled — but it must not stall the harness.
 */
async function stormBatch(provider, items) {
    const sent = await Promise.all(items.map(async (it) => {
        try { const tx = await it.send(); return { label: it.label, tx, sendError: null }; }
        catch (e) { return { label: it.label, tx: null, sendError: short(e) }; }
    }));
    const deadline = Date.now() + RECEIPT_TIMEOUT_MS;
    const receipts = await Promise.all(sent.map(async (s) => {
        if (!s.tx) return null;
        while (Date.now() < deadline) {
            try {
                const rc = await provider.getTransactionReceipt(s.tx.hash);
                if (rc) return rc;
            } catch (e) { /* transport hiccup — keep polling until the deadline */ }
            await sleep(1500);
        }
        return null;
    }));
    const rows = [];
    for (let i = 0; i < sent.length; i++) {
        const s = sent[i], rc = receipts[i];
        if (!s.tx) { rows.push({ label: s.label, broadcast: false, ok: false, reason: s.sendError }); continue; }
        if (!rc) {
            rows.push({
                label: s.label, broadcast: true, hash: s.tx.hash, nonce: s.tx.nonce, ok: false,
                reason: `no receipt within ${RECEIPT_TIMEOUT_MS / 1000} s (dropped, replaced, or stuck behind a nonce gap)`,
                stuck: true,
            });
            continue;
        }
        if (rc.status === 1) {
            rows.push({ label: s.label, broadcast: true, hash: s.tx.hash, ok: true, block: rc.blockNumber, index: rc.index, gasUsed: rc.gasUsed.toString(), nonce: s.tx.nonce });
        } else {
            const c = await classifyFailure(provider, s.tx, rc);
            rows.push({ label: s.label, broadcast: true, hash: s.tx.hash, ok: false, block: rc.blockNumber, index: rc.index, gasUsed: rc.gasUsed.toString(), nonce: s.tx.nonce, ...c });
        }
    }
    const blocks = [...new Set(rows.filter((r) => r.block !== undefined).map((r) => r.block))];
    return {
        rows, blocks, sameBlock: blocks.length === 1,
        landedTogether: blocks.length ? Math.max(...blocks.map((b) => rows.filter((r) => r.block === b).length)) : 0,
        stuck: rows.filter((r) => r.stuck).length,
    };
}

/**
 * Fill a nonce GAP so a wallet is usable again.
 *
 * A gap is the one genuinely dangerous client-side outcome of firing transactions
 * concurrently from one wallet: if nonce n never reaches the mempool but n+1…n+k do,
 * NONE of them can be mined, for ever, until something occupies n. The wallet looks
 * simply broken, and no amount of retrying the application call helps.
 */
async function healNonce(provider, wallet) {
    const healed = [];
    for (let i = 0; i < 6; i++) {
        const latest = await provider.getTransactionCount(wallet.address, "latest");
        const pending = await provider.getTransactionCount(wallet.address, "pending");
        if (pending <= latest) break;
        const fee = await provider.getFeeData();
        try {
            const tx = await wallet.sendTransaction({
                to: wallet.address, value: 0, nonce: latest, gasLimit: 21000,
                maxFeePerGas: (fee.maxFeePerGas ?? 45_000_000_000n) * 3n,
                maxPriorityFeePerGas: (fee.maxPriorityFeePerGas ?? 5_000_000_000n) * 3n,
            });
            await provider.waitForTransaction(tx.hash, 1, 60_000);
            healed.push({ filledNonce: latest, hash: tx.hash });
        } catch (e) { healed.push({ filledNonce: latest, error: short(e) }); break; }
    }
    return healed;
}

/** Pool + global accounting checks on the live contract. */
async function poolInvariants(mp, usdc, agentId, label) {
    const v = [];
    const p = await mp.getAgentPool(agentId);
    let sumAmt = 0n, sumEarn = 0n;
    const listed = [];
    for (let i = 0n; i < p.lenderCount; i++) listed.push(await mp.poolLenders(agentId, i));
    if (new Set(listed).size !== listed.length) v.push(`I-c1 ${label}: duplicate entry in poolLenders`);
    if (listed.length > 50) v.push(`I-c3 ${label}: ${listed.length} lenders > cap 50`);
    for (const l of listed) {
        const pos = await mp.positions(agentId, l);
        const pt = await mp.pendingTranche(agentId, l);
        sumAmt += pos.amount; sumEarn += pos.earnedInterest;
        if (BigInt(pt.amount) > pos.amount) v.push(`I-b ${label} ${l}: pending > amount`);
        if (pos.amount === 0n && pos.earnedInterest === 0n) v.push(`I-c4 ${label} ${l}: empty slot listed`);
        if (!(await mp.isInPoolLenders(agentId, l))) v.push(`I-c2 ${label} ${l}: listed but flag false`);
    }
    if (p.totalLiquidity !== sumAmt) v.push(`I-a1 ${label}: totalLiquidity ${p.totalLiquidity} != Σamount ${sumAmt}`);
    if (p.availableLiquidity + p.totalLoaned !== sumAmt + sumEarn) v.push(`I-a2 ${label}: avail+loaned != Σ(amount+interest)`);
    const ids = await mp.getActiveLoanIds(agentId);
    const cnt = await mp.activeLoanCount(agentId);
    if (ids.length !== Number(cnt)) v.push(`I-d1 ${label}: |activeLoanIds| ${ids.length} != activeLoanCount ${cnt}`);
    let op = 0n;
    for (const id of ids) op += (await mp.loans(id)).amount;
    if ((await mp.outstandingPrincipal(agentId)) !== op) v.push(`I-h ${label}: outstandingPrincipal mismatch`);
    return { violations: v, pool: { totalLiquidity: p.totalLiquidity, availableLiquidity: p.availableLiquidity, totalLoaned: p.totalLoaned, lenderCount: Number(p.lenderCount) }, sumAmt, sumEarn };
}

/** Whole-marketplace solvency: balance == Σ availableLiquidity + fees + Σ ACTIVE collateral. */
async function globalSolvency(mp, usdc, label) {
    const total = Number(await mp.totalPools());
    let sumAvail = 0n;
    for (let i = 0; i < total; i++) {
        const aid = await mp.agentPoolIds(i);
        sumAvail += (await mp.getAgentPool(aid)).availableLiquidity;
    }
    const n = Number(await mp.nextLoanId());
    let sumColl = 0n;
    for (let id = 1; id < n; id++) {
        const l = await mp.loans(id);
        if (Number(l.state) === 1) sumColl += l.collateralAmount;
    }
    const bal = await usdc.balanceOf(await mp.getAddress());
    const rhs = sumAvail + (await mp.accumulatedFees()) + sumColl;
    return { label, pools: total, loans: n - 1, balance: bal.toString(), rhs: rhs.toString(), delta: (bal - rhs).toString(), ok: bal === rhs };
}

(async () => {
    const { provider, url } = await pickProvider();
    const deployer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const startNative = await provider.getBalance(deployer.address);
    out.rpc = url; out.deployer = deployer.address; out.deployerNativeStart = ethers.formatEther(startNative);

    const MP_ABI = abi("core/AgentLiquidityMarketplaceV62.sol/AgentLiquidityMarketplaceV62.json");
    const REG_ABI = abi("core/AgentRegistryV2.sol/AgentRegistryV2.json");
    const USDC_ABI = abi("tokens/MockUSDC.sol/MockUSDC.json");
    const mpD = new ethers.Contract(MARKETPLACE, MP_ABI, deployer);
    const usdcD = new ethers.Contract(cfg.usdc, USDC_ABI, deployer);

    if ((await mpD.VERSION()) !== "V6.2") throw new Error("not the V6.2 staging marketplace");
    if (await mpD.paused()) throw new Error("marketplace is paused");

    out.solvencyBefore = await globalSolvency(mpD, usdcD, "before");
    log("global solvency before:", J(out.solvencyBefore));

    // ── wallets ────────────────────────────────────────────────────────────────
    const walletFile = path.join(HERE, "staging-wallets.json");
    let saved = fs.existsSync(walletFile) ? JSON.parse(fs.readFileSync(walletFile, "utf8")) : null;
    if (!saved || saved.lenders.length < N_LENDERS) {
        saved = {
            createdAt: new Date().toISOString(),
            note: "THROWAWAY testnet keys for the 2026-09-25 concurrency round. Gitignored.",
            agent: ethers.Wallet.createRandom().privateKey,
            lenders: [...Array(N_LENDERS).keys()].map(() => ethers.Wallet.createRandom().privateKey),
        };
        fs.writeFileSync(walletFile, JSON.stringify(saved, null, 2));
        log(`generated ${N_LENDERS + 1} throwaway wallets → ${walletFile}`);
    }
    const agent = new ethers.Wallet(saved.agent, provider);
    const lenders = saved.lenders.slice(0, N_LENDERS).map((k) => new ethers.Wallet(k, provider));
    const actors = [agent, ...lenders];
    out.agent = agent.address;
    out.lenders = lenders.map((w) => w.address);

    // ── funding (sequential from the deployer so nonces are trivially correct) ──
    let spent = 0n;
    for (const w of actors) {
        const bal = await provider.getBalance(w.address);
        if (bal < FUND_EACH / 2n) {
            const need = FUND_EACH - bal;
            if (spent + need > SPEND_CAP) throw new Error("SPEND CAP reached during funding");
            const tx = await deployer.sendTransaction({ to: w.address, value: need });
            await tx.wait();
            spent += need;
        }
        const ub = await usdcD.balanceOf(w.address);
        if (ub < USDC(300)) await (await usdcD.mint(w.address, USDC(1000))).wait();
    }
    log(`funded ${actors.length} wallets (${ethers.formatEther(spent)} native moved)`);

    // approvals, in parallel (each from its own wallet, one tx each → no nonce race)
    await Promise.all(actors.map(async (w) => {
        const u = new ethers.Contract(cfg.usdc, USDC_ABI, w);
        if ((await u.allowance(w.address, MARKETPLACE)) < USDC(100000)) {
            await (await u.approve(MARKETPLACE, ethers.MaxUint256)).wait();
        }
    }));

    // ── agent onboarding ───────────────────────────────────────────────────────
    const regA = new ethers.Contract(cfg.agentRegistryV2, REG_ABI, agent);
    const mpA = new ethers.Contract(MARKETPLACE, MP_ABI, agent);
    let agentId = await regA.addressToAgentId(agent.address);
    if (agentId === 0n) {
        await (await regA.register(`ipfs://conc-2026-09-25-${Date.now()}`, [])).wait();
        agentId = await regA.addressToAgentId(agent.address);
    }
    if (!(await mpA.getAgentPool(agentId)).agentAddress || (await mpA.getAgentPool(agentId)).agentAddress === ethers.ZeroAddress) {
        await (await mpA.createAgentPool()).wait();
    }
    out.agentId = agentId.toString();
    log(`agent #${agentId} @ ${agent.address}`);

    const mpFor = (w) => new ethers.Contract(MARKETPLACE, MP_ABI, w);
    const GAS = { gasLimit: 900_000 };
    const BIGGAS = { gasLimit: 1_500_000 };

    // ═══════════════════════ PHASE 1 — nonce reality, one wallet ═══════════════
    {
        const w = lenders[0];
        const mp = mpFor(w);
        const phase = { phase: "7.1 nonce storm from ONE wallet", runs: [] };

        // (a) naive: several concurrent sends, letting ethers allocate the nonce
        for (let run = 0; run < 3; run++) {
            const before = (await mp.positions(agentId, w.address)).amount;
            const K = 6;
            const r = await stormBatch(provider, [...Array(K).keys()].map((i) => ({
                label: `naive${i}`, send: () => mp.supplyLiquidity(agentId, USDC(10), GAS),
            })));
            const after = (await mp.positions(agentId, w.address)).amount;
            const landed = r.rows.filter((x) => x.ok).length;
            const nonces = r.rows.filter((x) => x.nonce !== undefined).map((x) => x.nonce);
            phase.runs.push({
                mode: "ethers default nonce allocation", attempted: K, broadcast: r.rows.filter((x) => x.broadcast).length,
                mined: landed, distinctNonces: new Set(nonces).size, blocks: r.blocks, maxInOneBlock: r.landedTogether,
                positionDelta: (after - before).toString(), expectedIfAllLanded: USDC(10 * K).toString(),
                sendErrors: [...new Set(r.rows.filter((x) => !x.broadcast).map((x) => x.reason))],
                revertReasons: [...new Set(r.rows.filter((x) => x.broadcast && !x.ok).map((x) => x.reason))],
                stuckWithoutReceipt: r.stuck,
                nonceGapHealed: r.stuck ? await healNonce(provider, w) : [],
            });
            log(`  7.1a run ${run}: ${landed}/${K} landed, ${new Set(nonces).size} distinct nonces, ${r.stuck} stuck, blocks ${r.blocks.join(",")}`);
        }

        // (b) explicit nonce cursor (the repo already ships src/sdk/nonce.js for this)
        const { NonceCounter } = require(path.join(ROOT, "src/sdk/nonce.js"));
        for (let run = 0; run < 2; run++) {
            const nc = new NonceCounter(w);
            await nc.init();
            const before = (await mp.positions(agentId, w.address)).amount;
            const K = 6;
            const r = await stormBatch(provider, [...Array(K).keys()].map((i) => ({
                label: `nc${i}`, send: () => mp.supplyLiquidity(agentId, USDC(10), { ...GAS, nonce: nc.next() }),
            })));
            const after = (await mp.positions(agentId, w.address)).amount;
            phase.runs.push({
                mode: "explicit NonceCounter (src/sdk/nonce.js)", attempted: K,
                broadcast: r.rows.filter((x) => x.broadcast).length, mined: r.rows.filter((x) => x.ok).length,
                blocks: r.blocks, maxInOneBlock: r.landedTogether,
                positionDelta: (after - before).toString(), expectedIfAllLanded: USDC(10 * K).toString(),
                sendErrors: [...new Set(r.rows.filter((x) => !x.broadcast).map((x) => x.reason))],
                stuckWithoutReceipt: r.stuck,
                nonceGapHealed: r.stuck ? await healNonce(provider, w) : [],
            });
            log(`  7.1b run ${run}: ${r.rows.filter((x) => x.ok).length}/${K} landed, ${r.stuck} stuck, blocks ${r.blocks.join(",")}, max ${r.landedTogether} together`);
        }

        // (c) deliberate same-nonce replacement
        {
            const n = await w.getNonce("pending");
            const fee = await provider.getFeeData();
            const r = await stormBatch(provider, [
                { label: "orig", send: () => mp.supplyLiquidity(agentId, USDC(10), { ...GAS, nonce: n, maxFeePerGas: fee.maxFeePerGas, maxPriorityFeePerGas: fee.maxPriorityFeePerGas }) },
                { label: "replacement+50%", send: () => mp.supplyLiquidity(agentId, USDC(11), { ...GAS, nonce: n, maxFeePerGas: (fee.maxFeePerGas * 150n) / 100n, maxPriorityFeePerGas: (fee.maxPriorityFeePerGas * 150n) / 100n }) },
            ]);
            phase.runs.push({ mode: "same nonce, 50 % fee bump", rows: r.rows, nonceGapHealed: r.stuck ? await healNonce(provider, w) : [] });
            log(`  7.1c replacement: ${J(r.rows.map((x) => ({ l: x.label, ok: x.ok, reason: x.reason })))}`);
        }

        const inv = await poolInvariants(mpD, usdcD, agentId, "after 7.1");
        phase.invariants = inv.violations;
        out.violations.push(...inv.violations);
        out.phases.push(phase);
    }

    // ══════════════ PHASE 2 — N independent wallets contending for one pool ═════
    {
        const phase = { phase: "7.2 N wallets supplying one pool simultaneously", runs: [] };
        // Any wallet left with a nonce gap by phase 1 would silently contribute nothing
        // here and read as "the contract refused it". Heal first, and record it.
        phase.preHeal = [];
        for (const w of actors) {
            const h = await healNonce(provider, w);
            if (h.length) phase.preHeal.push({ wallet: w.address, filled: h });
        }
        for (let run = 0; run < 3; run++) {
            const before = await mpD.getAgentPool(agentId);
            const amounts = lenders.map((_, i) => USDC(10 + ((i * 7 + run * 3) % 40)));
            const r = await stormBatch(provider, lenders.map((w, i) => ({
                label: `L${i}`, send: () => mpFor(w).supplyLiquidity(agentId, amounts[i], GAS),
            })));
            const after = await mpD.getAgentPool(agentId);
            const expected = r.rows.reduce((a, x, i) => (x.ok ? a + amounts[i] : a), 0n);
            const actual = after.totalLiquidity - before.totalLiquidity;
            const inv = await poolInvariants(mpD, usdcD, agentId, `7.2 run ${run}`);
            if (actual !== expected) out.violations.push(`7.2 run ${run}: totalLiquidity moved ${actual}, successful supplies summed ${expected}`);
            out.violations.push(...inv.violations);
            phase.runs.push({
                run, wallets: lenders.length, landed: r.rows.filter((x) => x.ok).length,
                blocks: r.blocks, maxInOneBlock: r.landedTogether,
                totalLiquidityDelta: actual.toString(), sumOfSuccessfulSupplies: expected.toString(), exact: actual === expected,
                lenderCount: inv.pool.lenderCount, invariantViolations: inv.violations.length,
                failures: r.rows.filter((x) => !x.ok).map((x) => ({ label: x.label, reason: x.reason, transient: x.transient, note: x.note })),
                gas: r.rows.filter((x) => x.ok).map((x) => x.gasUsed),
            });
            log(`  7.2 run ${run}: ${r.rows.filter((x) => x.ok).length}/${lenders.length} landed, max ${r.landedTogether} in one block, exact=${actual === expected}`);
        }
        out.phases.push(phase);
    }

    // ═════════════ PHASE 3 — borrow vs withdraw on a real mempool ═══════════════
    {
        const phase = { phase: "7.3 borrow vs withdraw, real ordering", runs: [] };
        const limit = await new ethers.Contract(cfg.reputationManagerV4, abi("core/ReputationManagerV4.sol/ReputationManagerV4.json"), provider).creditLimitOf(agentId);
        const collateralPct = await new ethers.Contract(cfg.reputationManagerV4, abi("core/ReputationManagerV4.sol/ReputationManagerV4.json"), provider).collateralRequirementOf(agentId);
        const borrow = limit < USDC(100) ? limit : USDC(100);
        phase.creditLimit = limit.toString();
        phase.collateralPercent = collateralPct.toString();

        for (let run = 0; run < 4 && borrow > 0n; run++) {
            // size the pool so exactly one of {borrow, withdraw} fits
            let pool = await mpD.getAgentPool(agentId);
            const target = borrow + borrow / 2n;
            if (pool.availableLiquidity > target) {
                // pull the excess out sequentially (setup, not a race)
                for (const w of lenders) {
                    pool = await mpD.getAgentPool(agentId);
                    if (pool.availableLiquidity <= target) break;
                    const pos = await mpD.positions(agentId, w.address);
                    if (pos.amount === 0n) continue;
                    const excess = pool.availableLiquidity - target;
                    const take = pos.amount < excess ? pos.amount : excess;
                    // never leave a dust position below minSupply
                    const amt = pos.amount - take < USDC(10) ? pos.amount : take;
                    try { await (await mpFor(w).withdrawLiquidity(agentId, amt, GAS)).wait(); } catch (e) { /* fine */ }
                }
            }
            pool = await mpD.getAgentPool(agentId);
            const wLender = lenders.find(async () => true) || lenders[0];
            const pos = await mpD.positions(agentId, lenders[0].address);
            const wd = pos.amount > 0n ? (pos.amount < borrow ? pos.amount : borrow) : 0n;
            if (wd === 0n) { phase.runs.push({ run, skipped: "lender 0 has no position" }); continue; }

            const availBefore = pool.availableLiquidity;
            const balBefore = await usdcD.balanceOf(MARKETPLACE);
            const items = run % 2
                ? [{ label: "BORROW", send: () => mpA.requestLoan(borrow, 7, BIGGAS) }, { label: "WITHDRAW", send: () => mpFor(lenders[0]).withdrawLiquidity(agentId, wd, GAS) }]
                : [{ label: "WITHDRAW", send: () => mpFor(lenders[0]).withdrawLiquidity(agentId, wd, GAS) }, { label: "BORROW", send: () => mpA.requestLoan(borrow, 7, BIGGAS) }];
            const r = await stormBatch(provider, items);
            const after = await mpD.getAgentPool(agentId);
            const balAfter = await usdcD.balanceOf(MARKETPLACE);
            const winners = r.rows.filter((x) => x.ok).map((x) => x.label);
            const moved = balBefore - balAfter;
            const claimed = r.rows.reduce((a, x) => (x.ok ? a + (x.label === "BORROW" ? borrow : wd) : a), 0n);
            // a borrow ALSO pulls collateral in (100 % tier), so net movement differs — check the
            // pool's own ledger instead, which is the solvency-critical number.
            const availDelta = availBefore - after.availableLiquidity;
            if (availDelta !== claimed) out.violations.push(`7.3 run ${run}: availableLiquidity fell ${availDelta} but successful calls claimed ${claimed}`);
            const inv = await poolInvariants(mpD, usdcD, agentId, `7.3 run ${run}`);
            out.violations.push(...inv.violations);
            phase.runs.push({
                run, borrowFirst: run % 2 === 1, borrow: borrow.toString(), withdraw: wd.toString(),
                availBefore: availBefore.toString(), availAfter: after.availableLiquidity.toString(),
                winners, contended: (borrow + wd) > availBefore,
                usdcNetMovement: moved.toString(), availDelta: availDelta.toString(), claimedByWinners: claimed.toString(),
                exact: availDelta === claimed, blocks: r.blocks, sameBlock: r.sameBlock,
                failures: r.rows.filter((x) => !x.ok).map((x) => ({ label: x.label, reason: x.reason, transient: x.transient, note: x.note })),
                invariantViolations: inv.violations.length,
            });
            log(`  7.3 run ${run}: winners=${winners.join(",")} sameBlock=${r.sameBlock} exact=${availDelta === claimed}`);

            // close any loan we opened so the next round starts clean
            const ids = await mpD.getActiveLoanIds(agentId);
            for (const id of ids) { try { await (await mpA.repayLoan(id, BIGGAS)).wait(); } catch (e) { log(`    repay ${id}: ${short(e)}`); } }
        }
        out.phases.push(phase);
    }

    // ════════════ PHASE 4 — double-fire of the same settling call ══════════════
    {
        const phase = { phase: "7.4 concurrent double-fire of the same settlement", runs: [] };
        for (let run = 0; run < 2; run++) {
            // make sure there is liquidity, then open one loan
            const pool = await mpD.getAgentPool(agentId);
            const rm = new ethers.Contract(cfg.reputationManagerV4, abi("core/ReputationManagerV4.sol/ReputationManagerV4.json"), provider);
            const limit = await rm.creditLimitOf(agentId);
            let borrow = limit < USDC(50) ? limit : USDC(50);
            if (pool.availableLiquidity < borrow) {
                await (await mpFor(lenders[1]).supplyLiquidity(agentId, USDC(100), GAS)).wait();
                borrow = limit < USDC(50) ? limit : USDC(50);
            }
            if (borrow === 0n) { phase.runs.push({ run, skipped: "no credit line" }); continue; }
            const rc = await (await mpA.requestLoan(borrow, 7, BIGGAS)).wait();
            const id = (await mpD.nextLoanId()) - 1n;

            const r = await stormBatch(provider, [
                { label: "repayA", send: () => mpA.repayLoan(id, BIGGAS) },
                { label: "repayB", send: () => mpA.repayLoan(id, BIGGAS) },
            ]);
            const loan = await mpD.loans(id);
            const settled = r.rows.filter((x) => x.ok).length;
            if (settled > 1) out.violations.push(`7.4 run ${run}: loan ${id} settled ${settled} times`);
            const inv = await poolInvariants(mpD, usdcD, agentId, `7.4 run ${run}`);
            out.violations.push(...inv.violations);
            phase.runs.push({
                run, loanId: id.toString(), settledTimes: settled, finalState: Number(loan.state),
                blocks: r.blocks, sameBlock: r.sameBlock,
                failures: r.rows.filter((x) => !x.ok).map((x) => ({ label: x.label, reason: x.reason, transient: x.transient, note: x.note })),
                invariantViolations: inv.violations.length,
            });
            log(`  7.4 run ${run}: loan ${id} settled ${settled}× (state ${loan.state}), sameBlock=${r.sameBlock}`);
        }
        out.phases.push(phase);
    }

    // ═════════════ PHASE 5 — throughput: concurrent vs sequential ══════════════
    {
        const phase = { phase: "7.5 throughput, concurrent vs sequential" };
        const K = 8;
        const w = lenders[2];
        const mp = mpFor(w);

        const nc = new (require(path.join(ROOT, "src/sdk/nonce.js")).NonceCounter)(w);
        await nc.init();
        let t0 = Date.now();
        const rc = await stormBatch(provider, [...Array(K).keys()].map((i) => ({
            label: `c${i}`, send: () => mp.supplyLiquidity(agentId, USDC(10), { ...GAS, nonce: nc.next() }),
        })));
        const concurrentSecs = (Date.now() - t0) / 1000;

        t0 = Date.now();
        let seqOk = 0; const seqGas = [];
        for (let i = 0; i < K; i++) {
            try { const r = await (await mp.supplyLiquidity(agentId, USDC(10), GAS)).wait(); seqOk++; seqGas.push(r.gasUsed.toString()); }
            catch (e) { /* recorded below */ }
        }
        const sequentialSecs = (Date.now() - t0) / 1000;

        const conGas = rc.rows.filter((x) => x.ok).map((x) => Number(x.gasUsed));
        phase.concurrent = {
            attempted: K, landed: rc.rows.filter((x) => x.ok).length, seconds: concurrentSecs,
            txPerSec: +(rc.rows.filter((x) => x.ok).length / concurrentSecs).toFixed(3),
            blocks: rc.blocks, maxInOneBlock: rc.landedTogether,
            avgGas: conGas.length ? Math.round(conGas.reduce((a, b) => a + b, 0) / conGas.length) : 0,
        };
        phase.sequential = {
            attempted: K, landed: seqOk, seconds: sequentialSecs, txPerSec: +(seqOk / sequentialSecs).toFixed(3),
            avgGas: seqGas.length ? Math.round(seqGas.map(Number).reduce((a, b) => a + b, 0) / seqGas.length) : 0,
        };
        phase.speedup = phase.sequential.txPerSec > 0 ? +(phase.concurrent.txPerSec / phase.sequential.txPerSec).toFixed(2) : null;
        log(`  7.5 concurrent ${phase.concurrent.txPerSec} tx/s vs sequential ${phase.sequential.txPerSec} tx/s (×${phase.speedup}); gas ${phase.concurrent.avgGas} vs ${phase.sequential.avgGas}`);
        out.phases.push(phase);
    }

    // ── wrap up ────────────────────────────────────────────────────────────────
    out.solvencyAfter = await globalSolvency(mpD, usdcD, "after");
    if (!out.solvencyAfter.ok) out.violations.push(`GLOBAL solvency broken after the round: delta ${out.solvencyAfter.delta}`);
    const endNative = await provider.getBalance(deployer.address);
    out.spend = {
        deployerNativeStart: ethers.formatEther(startNative),
        deployerNativeEnd: ethers.formatEther(endNative),
        deployerNativeSpent: ethers.formatEther(startNative - endNative),
        capNative: ethers.formatEther(SPEND_CAP),
    };
    out.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(HERE, "staging-concurrency-result.json"), JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    log("\nviolations:", out.violations.length);
    for (const v of out.violations) log("  !", v);
    log("solvency after:", J(out.solvencyAfter));
    log("spend:", J(out.spend));
})().catch((e) => {
    // Write whatever was gathered before the failure — a half-finished run is still
    // evidence, and losing it to an RPC hiccup would mean re-spending testnet gas.
    out.fatal = short(e);
    out.finishedAt = new Date().toISOString();
    try { fs.writeFileSync(path.join(HERE, "staging-concurrency-result.json"), JSON.stringify(out, (k, v) => (typeof v === "bigint" ? v.toString() : v), 2)); } catch (_) { /* nothing left to do */ }
    console.error("FATAL", e);
    process.exit(1);
});
