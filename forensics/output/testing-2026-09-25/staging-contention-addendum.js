/**
 * RACE 7, addendum 2 — borrow-vs-withdraw and the double-settlement double-fire, on a
 * FRESH Arc-staging pool whose liquidity this script controls exactly.
 *
 * Why a second script:
 *   * the main harness's phase 7.3 skipped every run — its drain loop had already emptied
 *     lender 0's position, so there was nothing left to contend with. Rather than drain a
 *     shared pool, this creates a new agent and sizes the pool directly;
 *   * its phase 7.4 fired two IDENTICAL `repayLoan(id)` calls, which is one signed
 *     transaction sent twice (same nonce, same payload ⇒ same hash), so the harness read
 *     one receipt twice and scored it as "settled 2×". On-chain there was exactly one
 *     `LoanRepaid` event per loan and zero invariant violations. Here the two calls are
 *     made DISTINCT (different gas limit ⇒ different payload ⇒ different hash) so the
 *     race is real, and the harness deduplicates by hash regardless.
 *
 * Safety: Arc STAGING only (chainId asserted), throwaway wallets, tiny spend.
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
const USDC = (n) => ethers.parseUnits(String(n), 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (e) => String(e?.shortMessage || e?.info?.error?.message || e?.message || e).replace(/\s+/g, " ").slice(0, 160);
function reasonOf(e) {
    if (typeof e?.reason === "string" && e.reason) return e.reason;
    const d = typeof e?.data === "string" ? e.data : e?.info?.error?.data;
    if (typeof d === "string" && d.startsWith("0x08c379a0")) {
        try { return ethers.AbiCoder.defaultAbiCoder().decode(["string"], `0x${d.slice(10)}`)[0]; } catch { /* malformed */ }
    }
    return short(e);
}

/** Broadcast concurrently, wait for all receipts against one deadline, DEDUPE BY HASH. */
async function storm(provider, items, timeoutMs = 120_000) {
    const sent = await Promise.all(items.map(async (it) => {
        try { const tx = await it.send(); return { label: it.label, hash: tx.hash, nonce: tx.nonce, tx, err: null }; }
        catch (e) { return { label: it.label, hash: null, nonce: null, tx: null, err: short(e) }; }
    }));
    const seen = new Set();
    const duplicates = [];
    for (const s of sent) {
        if (!s.hash) continue;
        if (seen.has(s.hash)) duplicates.push(s.label); else seen.add(s.hash);
    }
    const deadline = Date.now() + timeoutMs;
    const rcs = await Promise.all(sent.map(async (s) => {
        if (!s.hash) return null;
        while (Date.now() < deadline) {
            const rc = await provider.getTransactionReceipt(s.hash).catch(() => null);
            if (rc) return rc;
            await sleep(1200);
        }
        return null;
    }));
    const rows = [];
    for (let i = 0; i < sent.length; i++) {
        const s = sent[i], rc = rcs[i];
        if (!s.hash) { rows.push({ label: s.label, broadcast: false, ok: false, reason: s.err }); continue; }
        if (!rc) { rows.push({ label: s.label, broadcast: true, hash: s.hash, ok: false, reason: "no receipt", stuck: true }); continue; }
        let reason = null;
        if (rc.status !== 1) {
            try { await provider.call({ from: s.tx.from, to: s.tx.to, data: s.tx.data, blockTag: rc.blockNumber }); reason = "(succeeds at end-of-block — positional)"; }
            catch (e) { reason = reasonOf(e); }
        }
        rows.push({
            label: s.label, broadcast: true, hash: s.hash, nonce: s.nonce, ok: rc.status === 1,
            reason, block: rc.blockNumber, index: rc.index, gasUsed: rc.gasUsed.toString(),
            duplicateOfEarlierCall: duplicates.includes(s.label),
        });
    }
    const blocks = [...new Set(rows.filter((r) => r.block !== undefined).map((r) => r.block))];
    // "distinct successes" counts UNIQUE transaction hashes, so two calls that collapsed
    // into one signed transaction cannot be mistaken for two settlements.
    const distinctSuccesses = new Set(rows.filter((r) => r.ok).map((r) => r.hash)).size;
    return { rows, blocks, sameBlock: blocks.length === 1, distinctSuccesses, duplicates };
}

async function poolInvariants(mp, agentId, label) {
    const v = [];
    const p = await mp.getAgentPool(agentId);
    const listed = [];
    for (let i = 0n; i < p.lenderCount; i++) listed.push(await mp.poolLenders(agentId, i));
    if (new Set(listed).size !== listed.length) v.push(`I-c1 ${label}: duplicate in poolLenders`);
    if (listed.length > 50) v.push(`I-c3 ${label}: lender cap exceeded`);
    let sumAmt = 0n, sumEarn = 0n;
    for (const l of listed) {
        const pos = await mp.positions(agentId, l);
        sumAmt += pos.amount; sumEarn += pos.earnedInterest;
        const pt = await mp.pendingTranche(agentId, l);
        if (BigInt(pt.amount) > pos.amount) v.push(`I-b ${label} ${l}: pending > amount`);
        if (!(await mp.isInPoolLenders(agentId, l))) v.push(`I-c2 ${label} ${l}: listed but flag false`);
    }
    if (p.totalLiquidity !== sumAmt) v.push(`I-a1 ${label}: totalLiquidity != Σ amount`);
    if (p.availableLiquidity + p.totalLoaned !== sumAmt + sumEarn) v.push(`I-a2 ${label}: avail+loaned != Σ(amount+interest)`);
    const ids = await mp.getActiveLoanIds(agentId);
    if (ids.length !== Number(await mp.activeLoanCount(agentId))) v.push(`I-d1 ${label}: activeLoanIds/activeLoanCount mismatch`);
    let op = 0n;
    for (const id of ids) op += (await mp.loans(id)).amount;
    if ((await mp.outstandingPrincipal(agentId)) !== op) v.push(`I-h ${label}: outstandingPrincipal mismatch`);
    return { violations: v, pool: p };
}

async function globalSolvency(mp, usdc, label) {
    const total = Number(await mp.totalPools());
    let sumAvail = 0n;
    for (let i = 0; i < total; i++) sumAvail += (await mp.getAgentPool(await mp.agentPoolIds(i))).availableLiquidity;
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
    const url = process.env.ARC_STAGING_RPC_URL || "https://arc-testnet-rpc.publicnode.com";
    const provider = new ethers.JsonRpcProvider(url, CHAIN_ID, { batchMaxCount: 1 });
    if (Number((await provider.getNetwork()).chainId) !== CHAIN_ID) throw new Error("WRONG CHAIN");
    const deployer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const startNative = await provider.getBalance(deployer.address);

    const MP_ABI = abi("core/AgentLiquidityMarketplaceV62.sol/AgentLiquidityMarketplaceV62.json");
    const REG_ABI = abi("core/AgentRegistryV2.sol/AgentRegistryV2.json");
    const USDC_ABI = abi("tokens/MockUSDC.sol/MockUSDC.json");
    const RM_ABI = abi("core/ReputationManagerV4.sol/ReputationManagerV4.json");
    const mpD = new ethers.Contract(MARKETPLACE, MP_ABI, deployer);
    const usdcD = new ethers.Contract(cfg.usdc, USDC_ABI, deployer);
    const rm = new ethers.Contract(cfg.reputationManagerV4, RM_ABI, provider);

    const out = { startedAt: new Date().toISOString(), chainId: CHAIN_ID, rpc: url, marketplace: MARKETPLACE, phases: [], violations: [] };
    out.solvencyBefore = await globalSolvency(mpD, usdcD, "before");

    // fresh agent + an existing throwaway lender
    const walletFile = path.join(HERE, "staging-wallets.json");
    const saved = JSON.parse(fs.readFileSync(walletFile, "utf8"));
    if (!saved.agent2) {
        saved.agent2 = ethers.Wallet.createRandom().privateKey;
        fs.writeFileSync(walletFile, JSON.stringify(saved, null, 2));
    }
    const A = new ethers.Wallet(saved.agent2, provider);
    const L = new ethers.Wallet(saved.lenders[0], provider);
    for (const w of [A, L]) {
        if ((await provider.getBalance(w.address)) < ethers.parseEther("0.15")) {
            await (await deployer.sendTransaction({ to: w.address, value: ethers.parseEther("0.4") })).wait();
        }
        if ((await usdcD.balanceOf(w.address)) < USDC(500)) await (await usdcD.mint(w.address, USDC(2000))).wait();
        const u = new ethers.Contract(cfg.usdc, USDC_ABI, w);
        if ((await u.allowance(w.address, MARKETPLACE)) < USDC(100000)) await (await u.approve(MARKETPLACE, ethers.MaxUint256)).wait();
    }
    const regA = new ethers.Contract(cfg.agentRegistryV2, REG_ABI, A);
    const mpA = new ethers.Contract(MARKETPLACE, MP_ABI, A);
    const mpL = new ethers.Contract(MARKETPLACE, MP_ABI, L);
    let agentId = await regA.addressToAgentId(A.address);
    if (agentId === 0n) {
        await (await regA.register(`ipfs://conc-addendum-${Date.now()}`, [])).wait();
        agentId = await regA.addressToAgentId(A.address);
    }
    if ((await mpA.getAgentPool(agentId)).agentAddress === ethers.ZeroAddress) await (await mpA.createAgentPool()).wait();
    out.agentId = agentId.toString();
    out.agent = A.address;
    out.lender = L.address;

    const limit = await rm.creditLimitOf(agentId);
    const collateralPct = await rm.collateralRequirementOf(agentId);
    const B = limit < USDC(100) ? limit : USDC(100);
    out.creditLimit = limit.toString();
    out.collateralPercent = collateralPct.toString();
    console.log(`agent #${agentId} limit ${ethers.formatUnits(limit, 6)} collateral ${collateralPct}% → borrow ${ethers.formatUnits(B, 6)}`);

    // ───────── phase A: borrow vs withdraw, sized so only one can fit ────────
    {
        const phase = { phase: "7.3' borrow vs withdraw on a pool sized so only one fits", runs: [] };
        for (let run = 0; run < 4; run++) {
            const borrowFirst = run % 2 === 1;
            // top the pool up to exactly 1.5 × B, all of it lender 0's
            let pool = await mpA.getAgentPool(agentId);
            const target = (B * 3n) / 2n;
            if (pool.availableLiquidity < target) {
                await (await mpL.supplyLiquidity(agentId, target - pool.availableLiquidity, { gasLimit: 900_000 })).wait();
            } else if (pool.availableLiquidity > target) {
                const excess = pool.availableLiquidity - target;
                const pos = await mpA.positions(agentId, L.address);
                const take = pos.amount < excess ? pos.amount : excess;
                if (take > 0n) await (await mpL.withdrawLiquidity(agentId, take, { gasLimit: 900_000 })).wait();
            }
            pool = await mpA.getAgentPool(agentId);
            const pos = await mpA.positions(agentId, L.address);
            const wd = pos.amount < B ? pos.amount : B;
            if (wd === 0n || pool.availableLiquidity < B) { phase.runs.push({ run, skipped: `avail ${pool.availableLiquidity} pos ${pos.amount}` }); continue; }

            const availBefore = pool.availableLiquidity;
            const contended = (B + wd) > availBefore;
            const lenderBal0 = await usdcD.balanceOf(L.address);
            const agentBal0 = await usdcD.balanceOf(A.address);
            const items = [
                { label: "WITHDRAW", send: () => mpL.withdrawLiquidity(agentId, wd, { gasLimit: 900_000 }) },
                { label: "BORROW", send: () => mpA.requestLoan(B, 7, { gasLimit: 1_500_000 }) },
            ];
            const r = await storm(provider, borrowFirst ? [items[1], items[0]] : items);
            const after = await mpA.getAgentPool(agentId);
            const winners = r.rows.filter((x) => x.ok).map((x) => x.label);
            const claimed = r.rows.reduce((a, x) => (x.ok ? a + (x.label === "BORROW" ? B : wd) : a), 0n);
            const availDelta = availBefore - after.availableLiquidity;
            if (availDelta !== claimed) out.violations.push(`7.3' run ${run}: availableLiquidity fell ${availDelta} but the winners claimed ${claimed}`);
            if (contended && winners.length === 2) out.violations.push(`7.3' run ${run}: BOTH succeeded against available ${availBefore}`);
            const inv = await poolInvariants(mpA, agentId, `7.3' run ${run}`);
            out.violations.push(...inv.violations);
            phase.runs.push({
                run, borrowFirst, contended, borrow: B.toString(), withdraw: wd.toString(),
                availBefore: availBefore.toString(), availAfter: after.availableLiquidity.toString(),
                winners, sameBlock: r.sameBlock, blocks: r.blocks,
                availDelta: availDelta.toString(), claimedByWinners: claimed.toString(), exact: availDelta === claimed,
                loserReason: r.rows.filter((x) => !x.ok).map((x) => `${x.label}: ${x.reason}`),
                lenderUnchangedWhenLost: winners.includes("BORROW") && !winners.includes("WITHDRAW")
                    ? (await usdcD.balanceOf(L.address)) === lenderBal0 : null,
                agentUnchangedWhenLost: winners.includes("WITHDRAW") && !winners.includes("BORROW")
                    ? (await usdcD.balanceOf(A.address)) === agentBal0 + 0n : null,
                invariantViolations: inv.violations.length,
            });
            console.log(`  7.3' run ${run} (borrowFirst=${borrowFirst}): winners=${winners.join(",")} sameBlock=${r.sameBlock} exact=${availDelta === claimed}`);
            // close whatever opened, so the next round starts clean
            for (const id of await mpA.getActiveLoanIds(agentId)) {
                try { await (await mpA.repayLoan(id, { gasLimit: 1_500_000 })).wait(); } catch (e) { console.log(`    repay ${id}: ${short(e)}`); }
            }
        }
        out.phases.push(phase);
    }

    // ───────── phase B: two DISTINCT concurrent repayments of one loan ────────
    {
        const phase = { phase: "7.4' double-fire of the same settlement, as two DISTINCT transactions", runs: [] };
        for (let run = 0; run < 2; run++) {
            let pool = await mpA.getAgentPool(agentId);
            if (pool.availableLiquidity < B) {
                await (await mpL.supplyLiquidity(agentId, B - pool.availableLiquidity + USDC(10), { gasLimit: 900_000 })).wait();
            }
            await (await mpA.requestLoan(B, 7, { gasLimit: 1_500_000 })).wait();
            const id = (await mpA.nextLoanId()) - 1n;
            const before = await mpA.getAgentPool(agentId);
            // different gas limits ⇒ different payloads ⇒ different hashes ⇒ genuinely
            // two transactions racing, not one transaction sent twice.
            const r = await storm(provider, [
                { label: "repayA", send: () => mpA.repayLoan(id, { gasLimit: 1_500_000 }) },
                { label: "repayB", send: () => mpA.repayLoan(id, { gasLimit: 1_500_001 }) },
            ]);
            const loan = await mpA.loans(id);
            if (r.distinctSuccesses > 1) out.violations.push(`7.4' run ${run}: loan ${id} settled ${r.distinctSuccesses} times`);
            const after = await mpA.getAgentPool(agentId);
            if (before.totalLoaned - after.totalLoaned !== B) out.violations.push(`7.4' run ${run}: totalLoaned moved ${before.totalLoaned - after.totalLoaned}, expected ${B}`);
            const inv = await poolInvariants(mpA, agentId, `7.4' run ${run}`);
            out.violations.push(...inv.violations);
            phase.runs.push({
                run, loanId: id.toString(), distinctTransactions: new Set(r.rows.filter((x) => x.hash).map((x) => x.hash)).size,
                distinctSuccesses: r.distinctSuccesses, finalState: Number(loan.state),
                sameBlock: r.sameBlock, blocks: r.blocks,
                loserReason: r.rows.filter((x) => !x.ok).map((x) => `${x.label}: ${x.reason}`),
                totalLoanedDelta: (before.totalLoaned - after.totalLoaned).toString(),
                invariantViolations: inv.violations.length,
            });
            console.log(`  7.4' run ${run}: ${new Set(r.rows.filter((x) => x.hash).map((x) => x.hash)).size} distinct txs, ${r.distinctSuccesses} settled, state ${loan.state}, sameBlock=${r.sameBlock}`);
        }
        out.phases.push(phase);
    }

    out.solvencyAfter = await globalSolvency(mpD, usdcD, "after");
    if (!out.solvencyAfter.ok) out.violations.push(`GLOBAL solvency broken: delta ${out.solvencyAfter.delta}`);
    const endNative = await provider.getBalance(deployer.address);
    out.spend = {
        deployerNativeStart: ethers.formatEther(startNative),
        deployerNativeEnd: ethers.formatEther(endNative),
        deployerNativeSpent: ethers.formatEther(startNative - endNative),
    };
    out.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(HERE, "staging-contention-addendum-result.json"), JSON.stringify(out, null, 2));
    console.log("\nviolations:", out.violations.length);
    for (const v of out.violations) console.log("  !", v);
    console.log("solvency after:", JSON.stringify(out.solvencyAfter));
    console.log("spend:", JSON.stringify(out.spend));
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
