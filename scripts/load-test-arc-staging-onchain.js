/**
 * On-chain load test of the FIXED V6 staging stack on Arc testnet.
 *   A) Sequential: 15 loans on one agent — real-chain gas + wall-clock, §S5 flatness.
 *   B) Concurrent: N fresh agents run onboard→supply→borrow→repay IN PARALLEL —
 *      tests RPC + nonce handling under concurrency, confirms no cross-agent
 *      interference, all loans REPAID.
 * Uses the deployer (native USDC gas + owner of staging MockUSDC) to fund fresh
 * test agents. Real testnet gas — bounded (~60 txs total).
 */
require("dotenv").config();
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

const RPC = process.env.ARC_TESTNET_RPC_URL || "https://arc-testnet.drpc.org";
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "config", "arc-testnet-v6-addresses.json"), "utf8"));
const abi = (rel) => JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", rel), "utf8")).abi;
const USDC = (n) => ethers.parseUnits(String(n), 6);
const fmt = (g) => Number(g).toLocaleString();
let failures = 0;
const ok = (label, cond, detail = "") => { console.log(`  ${cond ? "✅" : "❌"} ${label} ${detail}`); if (!cond) failures++; };

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC, 5042002, { batchMaxCount: 1 });
    const deployer = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const usdc = new ethers.Contract(cfg.usdc, abi("tokens/MockUSDC.sol/MockUSDC.json"), deployer);
    const regAbi = abi("core/AgentRegistryV2.sol/AgentRegistryV2.json");
    const mpAbi = abi("core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json");
    const mpRead = new ethers.Contract(cfg.agentLiquidityMarketplace_v6, mpAbi, provider);

    const loanIdFrom = async (rcpt, iface) => {
        for (const lg of rcpt.logs) { try { const p = iface.parseLog(lg); if (p?.name === "LoanRequested") return p.args.loanId; } catch {} }
        return null;
    };

    // Ensure deployer holds MockUSDC for the sequential part.
    if ((await usdc.balanceOf(deployer.address)) < USDC(200)) await (await usdc.mint(deployer.address, USDC(1000))).wait();

    // ── A) Sequential: 15 loans on the deployer's agent ────────────────────
    console.log("A — sequential 15 loans on-chain (real gas + wall-clock)");
    const mp = new ethers.Contract(cfg.agentLiquidityMarketplace_v6, mpAbi, deployer);
    const reg = new ethers.Contract(cfg.agentRegistryV2, regAbi, deployer);
    if ((await reg.addressToAgentId(deployer.address)) === 0n) { await (await reg.register("ipfs://load", [])).wait(); }
    const aid = await reg.addressToAgentId(deployer.address);
    if (!(await mp.agentPools(aid)).isActive) await (await mp.createAgentPool()).wait();
    // Fresh-tier agent → 100% collateral. Supply liquidity to own pool.
    await (await usdc.approve(cfg.agentLiquidityMarketplace_v6, ethers.MaxUint256)).wait();
    if ((await mp.getAgentPool(aid)).availableLiquidity < USDC(50)) await (await mp.supplyLiquidity(aid, USDC(100))).wait();

    const reqGas = [], t0 = Date.now();
    for (let i = 0; i < 15; i++) {
        const rc = await (await mp.requestLoan(USDC(2), 7)).wait();
        reqGas.push(Number(rc.gasUsed));
        const id = await loanIdFrom(rc, mp.interface);
        await (await mp.repayLoan(id)).wait();
    }
    const secs = (Date.now() - t0) / 1000;
    const ratio = (reqGas.slice(-3).reduce((a, b) => a + b) / 3) / (reqGas.slice(0, 3).reduce((a, b) => a + b) / 3);
    console.log(`     15 request+repay cycles in ${secs.toFixed(1)}s (${(secs / 15).toFixed(1)}s/cycle, real RPC)`);
    console.log(`     requestLoan gas: first ${fmt(reqGas[0])}, last ${fmt(reqGas[14])}, ratio ${ratio.toFixed(3)}`);
    ok("real-chain loan gas stays flat (§S5, ratio < 1.15)", ratio < 1.15, `(ratio ${ratio.toFixed(3)})`);

    // ── B) Concurrent: N fresh agents in parallel ──────────────────────────
    const K = 4;
    console.log(`\nB — ${K} fresh agents onboard→supply→borrow→repay CONCURRENTLY`);
    const agents = [];
    for (let i = 0; i < K; i++) {
        const w = ethers.Wallet.createRandom().connect(provider);
        await (await deployer.sendTransaction({ to: w.address, value: ethers.parseEther("3") })).wait(); // native USDC for gas
        await (await usdc.mint(w.address, USDC(200))).wait();
        agents.push(w);
    }
    console.log(`     funded ${K} agents (native gas + 200 MockUSDC each)`);

    const runAgent = async (w, idx) => {
        const r = new ethers.Contract(cfg.agentRegistryV2, regAbi, w);
        const m = new ethers.Contract(cfg.agentLiquidityMarketplace_v6, mpAbi, w);
        const u = new ethers.Contract(cfg.usdc, abi("tokens/MockUSDC.sol/MockUSDC.json"), w);
        await (await u.approve(cfg.agentLiquidityMarketplace_v6, ethers.MaxUint256)).wait();
        await (await r.register(`ipfs://load-${idx}`, [])).wait();
        const myId = await r.addressToAgentId(w.address);
        await (await m.createAgentPool()).wait();
        await (await m.supplyLiquidity(myId, USDC(50))).wait();
        const rc = await (await m.requestLoan(USDC(5), 7)).wait();
        const id = await loanIdFrom(rc, m.interface);
        await (await m.repayLoan(id)).wait();
        return { idx, agentId: Number(myId), loanId: Number(id) };
    };

    const tc0 = Date.now();
    const results = await Promise.all(agents.map((w, i) => runAgent(w, i)));
    const csecs = (Date.now() - tc0) / 1000;
    console.log(`     ${K} agents completed full cycles concurrently in ${csecs.toFixed(1)}s`);
    let allRepaid = true;
    for (const res of results) {
        const st = Number((await mpRead.loans(res.loanId)).state);
        if (st !== 2) { allRepaid = false; console.log(`     agent ${res.idx} loan ${res.loanId} state ${st} (not REPAID)`); }
    }
    ok(`all ${K} concurrent agents' loans REPAID (no races/nonce issues)`, allRepaid);
    ok("distinct agentIds assigned (no registry collision under concurrency)",
        new Set(results.map(r => r.agentId)).size === K, `(${results.map(r => r.agentId).join(",")})`);

    console.log(`\n=== ON-CHAIN LOAD TEST: ${failures === 0 ? "ALL PASS" : failures + " FAILURES"} ===`);
    if (failures) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
