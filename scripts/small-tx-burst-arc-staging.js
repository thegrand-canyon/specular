/**
 * On-chain small-transaction BURST test on the FIXED V6 staging stack (Arc
 * testnet). K fresh agents each fire N sequential 1-USDC supplies to their own
 * pools, all agents in PARALLEL — K×N real on-chain txs. Measures sustained
 * real-chain throughput (tx/s) and verifies exact per-pool accounting after the
 * burst (no lost/double-counted txs under concurrent load).
 *
 * Env: AGENTS (default 5), TXS (default 10), PRIVATE_KEY, ARC_TESTNET_RPC_URL.
 * Testnet-only cost: native gas + fresh MockUSDC mints.
 */
require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const K = parseInt(process.env.AGENTS || "5", 10);
const N = parseInt(process.env.TXS || "10", 10);
const RPC = process.env.ARC_TESTNET_RPC_URL || "https://arc-testnet.drpc.org";
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "config", "arc-testnet-v6-addresses.json"), "utf8"));
const abi = (rel) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", rel), "utf8")).abi;
const USDC = (n) => ethers.parseUnits(String(n), 6);

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC, 5042002, { batchMaxCount: 1 });
    const deployer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const usdcD = new ethers.Contract(cfg.usdc, abi("tokens/MockUSDC.sol/MockUSDC.json"), deployer);

    console.log(`Setup: funding ${K} fresh agents (${N} small txs each = ${K * N} burst txs)…`);
    const agents = [];
    for (let i = 0; i < K; i++) {
        const w = ethers.Wallet.createRandom().connect(provider);
        await (await deployer.sendTransaction({ to: w.address, value: ethers.parseEther("2") })).wait();
        await (await usdcD.mint(w.address, USDC(100))).wait();
        agents.push(w);
    }
    // Onboard each agent (register + pool + approve) — setup, not timed.
    const setup = await Promise.all(agents.map(async (w, i) => {
        const reg = new ethers.Contract(cfg.agentRegistryV2, abi("core/AgentRegistryV2.sol/AgentRegistryV2.json"), w);
        const usdc = new ethers.Contract(cfg.usdc, abi("tokens/MockUSDC.sol/MockUSDC.json"), w);
        const mp = new ethers.Contract(cfg.agentLiquidityMarketplace_v6, abi("core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json"), w);
        await (await usdc.approve(cfg.agentLiquidityMarketplace_v6, ethers.MaxUint256)).wait();
        await (await reg.register(`ipfs://burst-${i}-${Math.floor(Math.random() * 1e9)}`, [])).wait();
        const aid = await reg.addressToAgentId(w.address);
        await (await mp.createAgentPool()).wait();
        return { w, aid, mp };
    }));
    console.log(`Onboarded agentIds: ${setup.map((s) => s.aid).join(", ")}`);

    // ── THE BURST: each agent fires N sequential supplies; agents in parallel ──
    console.log(`\nBURST: ${K} agents × ${N} × supplyLiquidity(1 USDC) in parallel…`);
    const t0 = Date.now();
    const perAgent = await Promise.all(setup.map(async ({ w, aid, mp }) => {
        let confirmed = 0, retried = 0;
        const errors = [];
        for (let i = 0; i < N; i++) {
            let done = false;
            for (let attempt = 0; attempt < 2 && !done; attempt++) { // 1 retry per tx
                try {
                    const tx = await mp.supplyLiquidity(aid, USDC(1));
                    await tx.wait();
                    confirmed++;
                    if (attempt > 0) retried++;
                    done = true;
                } catch (e) {
                    errors.push((e.shortMessage || e.message || "").slice(0, 90));
                    await new Promise((r) => setTimeout(r, 1500)); // brief backoff before retry
                }
            }
        }
        return { aid, confirmed, retried, errors };
    }));
    const secs = (Date.now() - t0) / 1000;
    const confirmed = perAgent.reduce((a, r) => a + r.confirmed, 0);
    const retried = perAgent.reduce((a, r) => a + r.retried, 0);
    console.log(`Confirmed ${confirmed}/${K * N} txs in ${secs.toFixed(1)}s → ${(confirmed / secs).toFixed(2)} tx/s sustained on-chain (${retried} needed a retry)`);
    const allErrors = perAgent.flatMap((r) => r.errors);
    if (allErrors.length) {
        const counts = {};
        for (const e of allErrors) counts[e] = (counts[e] || 0) + 1;
        console.log("Transient errors seen (before retry):");
        for (const [msg, c] of Object.entries(counts)) console.log(`  ${c}× ${msg}`);
    }

    // ── Verify exact accounting per pool ────────────────────────────────────
    let exact = true;
    for (const { aid, confirmed: c } of perAgent) {
        const mpR = new ethers.Contract(cfg.agentLiquidityMarketplace_v6, abi("core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json"), provider);
        const pool = await mpR.getAgentPool(aid);
        const expected = USDC(c);
        if (pool.totalLiquidity !== expected) {
            exact = false;
            console.log(`  ❌ pool ${aid}: totalLiquidity ${ethers.formatUnits(pool.totalLiquidity, 6)} != confirmed ${c} USDC`);
        }
    }
    console.log(exact ? "  ✅ every pool's totalLiquidity EXACTLY matches its confirmed txs" : "  ❌ accounting mismatch");

    const pass = confirmed === K * N && exact;
    console.log(pass
        ? `\n=== ✅ ON-CHAIN BURST PASS: ${K * N}/${K * N} small txs confirmed at ${(confirmed / secs).toFixed(2)} tx/s, exact accounting ===`
        : `\n=== ${confirmed === K * N ? "⚠️ accounting" : `⚠️ ${K * N - confirmed} txs failed`} — see above ===`);
    process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
