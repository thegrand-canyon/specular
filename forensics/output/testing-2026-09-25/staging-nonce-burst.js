/**
 * RACE 7, addendum — the NAIVE nonce burst, with no client-side rate limiting.
 *
 * WHY THIS IS A SEPARATE SCRIPT. The main staging harness throttles its RPC calls
 * (the public Arc testnet endpoints rate-limit this host hard). That throttle
 * SERIALISES `eth_getTransactionCount`, which accidentally repairs the very race the
 * "naive nonce" case is meant to expose: with ~300 ms between sends, each nonce read
 * already sees the previous transaction in the pending pool, so ethers hands out
 * n, n+1, n+2… and everything lands. An agent SDK doing `Promise.all([...])` against
 * an unthrottled provider is the realistic client, and that is what this measures.
 *
 * Safety: Arc STAGING only (chainId asserted), throwaway wallet, tiny spend.
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
const K = Number(process.env.BURST || 6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (e) => String(e?.shortMessage || e?.info?.error?.message || e?.message || e).replace(/\s+/g, " ").slice(0, 160);

(async () => {
    const url = process.env.ARC_STAGING_RPC_URL || "https://arc-testnet-rpc.publicnode.com";
    const provider = new ethers.JsonRpcProvider(url, CHAIN_ID, { batchMaxCount: 1 });
    if (Number((await provider.getNetwork()).chainId) !== CHAIN_ID) throw new Error("WRONG CHAIN");
    const deployer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const saved = JSON.parse(fs.readFileSync(path.join(HERE, "staging-wallets.json"), "utf8"));
    const w = new ethers.Wallet(saved.lenders[saved.lenders.length - 1], provider);

    const MP_ABI = abi("core/AgentLiquidityMarketplaceV62.sol/AgentLiquidityMarketplaceV62.json");
    const USDC_ABI = abi("tokens/MockUSDC.sol/MockUSDC.json");
    const regAbi = abi("core/AgentRegistryV2.sol/AgentRegistryV2.json");
    const reg = new ethers.Contract(cfg.agentRegistryV2, regAbi, provider);
    const agentAddr = new ethers.Wallet(saved.agent).address;
    const agentId = await reg.addressToAgentId(agentAddr);
    if (agentId === 0n) throw new Error("run staging-concurrency.js first — no agent/pool yet");

    if ((await provider.getBalance(w.address)) < ethers.parseEther("0.1")) {
        await (await deployer.sendTransaction({ to: w.address, value: ethers.parseEther("0.3") })).wait();
    }
    const usdcD = new ethers.Contract(cfg.usdc, USDC_ABI, deployer);
    if ((await usdcD.balanceOf(w.address)) < USDC(200)) await (await usdcD.mint(w.address, USDC(1000))).wait();
    const usdcW = new ethers.Contract(cfg.usdc, USDC_ABI, w);
    if ((await usdcW.allowance(w.address, MARKETPLACE)) < USDC(100000)) {
        await (await usdcW.approve(MARKETPLACE, ethers.MaxUint256)).wait();
    }
    const mp = new ethers.Contract(MARKETPLACE, MP_ABI, w);

    const out = { chainId: CHAIN_ID, rpc: url, wallet: w.address, agentId: agentId.toString(), burst: K, phases: [] };

    // ── (a) the naive burst: Promise.all, no explicit nonces, no throttle ──────
    const posBefore = (await mp.positions(agentId, w.address)).amount;
    const nonceBefore = await provider.getTransactionCount(w.address, "pending");
    const sent = await Promise.all([...Array(K).keys()].map(async (i) => {
        try { const tx = await mp.supplyLiquidity(agentId, USDC(10), { gasLimit: 900_000 }); return { i, hash: tx.hash, nonce: tx.nonce, err: null }; }
        catch (e) { return { i, hash: null, nonce: null, err: short(e) }; }
    }));
    const deadline = Date.now() + 90_000;
    const mined = await Promise.all(sent.map(async (s) => {
        if (!s.hash) return null;
        while (Date.now() < deadline) {
            const rc = await provider.getTransactionReceipt(s.hash).catch(() => null);
            if (rc) return rc;
            await sleep(1500);
        }
        return null;
    }));
    const posAfter = (await mp.positions(agentId, w.address)).amount;
    const rows = sent.map((s, i) => ({
        i, broadcast: !!s.hash, nonce: s.nonce, sendError: s.err,
        mined: !!mined[i], status: mined[i]?.status ?? null, block: mined[i]?.blockNumber ?? null,
    }));
    out.phases.push({
        phase: "7.1d naive Promise.all burst, unthrottled provider",
        attempted: K,
        broadcast: rows.filter((r) => r.broadcast).length,
        mined: rows.filter((r) => r.mined && r.status === 1).length,
        distinctNoncesAllocated: new Set(rows.filter((r) => r.nonce !== null).map((r) => r.nonce)).size,
        noncesAllocated: rows.filter((r) => r.nonce !== null).map((r) => r.nonce),
        nonceBefore, nonceAfter: await provider.getTransactionCount(w.address, "pending"),
        positionDelta: (posAfter - posBefore).toString(),
        expectedIfAllLanded: USDC(10 * K).toString(),
        sendErrors: [...new Set(rows.filter((r) => r.sendError).map((r) => r.sendError))],
        blocks: [...new Set(rows.filter((r) => r.block).map((r) => r.block))],
        maxInOneBlock: (() => {
            const bs = rows.filter((r) => r.block).map((r) => r.block);
            return bs.length ? Math.max(...[...new Set(bs)].map((b) => bs.filter((x) => x === b).length)) : 0;
        })(),
        rows,
    });
    console.log(JSON.stringify(out.phases[0], null, 2));

    // ── (b) heal any nonce gap the naive burst left, and prove it was a gap ────
    const healed = [];
    for (let i = 0; i < 6; i++) {
        const latest = await provider.getTransactionCount(w.address, "latest");
        const pending = await provider.getTransactionCount(w.address, "pending");
        if (pending <= latest) break;
        const fee = await provider.getFeeData();
        try {
            const tx = await w.sendTransaction({
                to: w.address, value: 0, nonce: latest, gasLimit: 21000,
                maxFeePerGas: (fee.maxFeePerGas ?? 45_000_000_000n) * 3n,
                maxPriorityFeePerGas: (fee.maxPriorityFeePerGas ?? 5_000_000_000n) * 3n,
            });
            await provider.waitForTransaction(tx.hash, 1, 60_000);
            healed.push({ filledNonce: latest, hash: tx.hash });
        } catch (e) { healed.push({ filledNonce: latest, error: short(e) }); break; }
    }
    out.phases.push({ phase: "7.1e nonce-gap heal", gapFound: healed.length > 0, healed });
    console.log(JSON.stringify(out.phases[1], null, 2));

    // ── (c) the same burst with an explicit nonce cursor ───────────────────────
    const { NonceCounter } = require(path.join(ROOT, "src/sdk/nonce.js"));
    const nc = new NonceCounter(w);
    await nc.init();
    const p0 = (await mp.positions(agentId, w.address)).amount;
    const sent2 = await Promise.all([...Array(K).keys()].map(async (i) => {
        try { const tx = await mp.supplyLiquidity(agentId, USDC(10), { gasLimit: 900_000, nonce: nc.next() }); return { i, hash: tx.hash, nonce: tx.nonce, err: null }; }
        catch (e) { return { i, hash: null, nonce: null, err: short(e) }; }
    }));
    const dl2 = Date.now() + 90_000;
    const mined2 = await Promise.all(sent2.map(async (s) => {
        if (!s.hash) return null;
        while (Date.now() < dl2) {
            const rc = await provider.getTransactionReceipt(s.hash).catch(() => null);
            if (rc) return rc;
            await sleep(1500);
        }
        return null;
    }));
    const p1 = (await mp.positions(agentId, w.address)).amount;
    const blocks2 = [...new Set(mined2.filter(Boolean).map((r) => r.blockNumber))];
    out.phases.push({
        phase: "7.1f same burst with an explicit NonceCounter",
        attempted: K, broadcast: sent2.filter((s) => s.hash).length,
        mined: mined2.filter((r) => r && r.status === 1).length,
        distinctNoncesAllocated: new Set(sent2.filter((s) => s.nonce !== null).map((s) => s.nonce)).size,
        positionDelta: (p1 - p0).toString(), expectedIfAllLanded: USDC(10 * K).toString(),
        blocks: blocks2,
        maxInOneBlock: blocks2.length ? Math.max(...blocks2.map((b) => mined2.filter((r) => r && r.blockNumber === b).length)) : 0,
        sendErrors: [...new Set(sent2.filter((s) => s.err).map((s) => s.err))],
    });
    console.log(JSON.stringify(out.phases[2], null, 2));

    // ── (d) UNTHROTTLED multi-wallet contention for the same pool ─────────────
    // The main harness's rate limiter also serialises `eth_sendRawTransaction`, which
    // caps how many of its transactions can share a block and understates real
    // co-location. Here N distinct wallets fire at the same pool with no throttle at
    // all, which is what a swarm of independent agents actually looks like.
    {
        const wallets = saved.lenders.slice(0, Number(process.env.N_BURST || 10)).map((k) => new ethers.Wallet(k, provider));
        const before = await mp.getAgentPool(agentId);
        const amounts = wallets.map((_, i) => USDC(10 + i));
        const t0 = Date.now();
        const s3 = await Promise.all(wallets.map(async (ww, i) => {
            const c = new ethers.Contract(MARKETPLACE, MP_ABI, ww);
            try { const tx = await c.supplyLiquidity(agentId, amounts[i], { gasLimit: 900_000 }); return { i, hash: tx.hash, err: null }; }
            catch (e) { return { i, hash: null, err: short(e) }; }
        }));
        const dl3 = Date.now() + 120_000;
        const m3 = await Promise.all(s3.map(async (x) => {
            if (!x.hash) return null;
            while (Date.now() < dl3) {
                const rc = await provider.getTransactionReceipt(x.hash).catch(() => null);
                if (rc) return rc;
                await sleep(1200);
            }
            return null;
        }));
        const secs = (Date.now() - t0) / 1000;
        const after = await mp.getAgentPool(agentId);
        const okIdx = m3.map((r, i) => (r && r.status === 1 ? i : -1)).filter((i) => i >= 0);
        const expected = okIdx.reduce((a, i) => a + amounts[i], 0n);
        const blocks3 = [...new Set(m3.filter(Boolean).map((r) => r.blockNumber))];
        out.phases.push({
            phase: "7.2b UNTHROTTLED multi-wallet contention on one pool",
            wallets: wallets.length,
            landed: okIdx.length,
            seconds: secs,
            txPerSec: +(okIdx.length / secs).toFixed(3),
            blocks: blocks3,
            maxInOneBlock: blocks3.length ? Math.max(...blocks3.map((b) => m3.filter((r) => r && r.blockNumber === b).length)) : 0,
            totalLiquidityDelta: (after.totalLiquidity - before.totalLiquidity).toString(),
            sumOfSuccessfulSupplies: expected.toString(),
            exact: (after.totalLiquidity - before.totalLiquidity) === expected,
            lenderCount: Number(after.lenderCount),
            gasUsed: m3.filter(Boolean).map((r) => r.gasUsed.toString()),
            sendErrors: [...new Set(s3.filter((x) => x.err).map((x) => x.err))],
        });
        console.log(JSON.stringify(out.phases[out.phases.length - 1], null, 2));
    }

    fs.writeFileSync(path.join(HERE, "staging-nonce-burst-result.json"), JSON.stringify(out, null, 2));
})().catch((e) => { console.error("FATAL", e); process.exit(1); });
