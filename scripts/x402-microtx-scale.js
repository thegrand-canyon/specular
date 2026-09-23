/**
 * x402 micropayment SCALE test: N concurrent 0.01-USDC buyers against a stub
 * seller wired to the FIXED V6 staging pool on Arc testnet. 5× the standard
 * concurrent-load test (50 → 250) at 1/5 the price — the agent-swarm
 * micropayment profile. Verifies: every request served, revenue accounting
 * EXACT under concurrency (the flush-race fix at scale), and the auto-flush
 * lands on-chain in the staging pool.
 *
 * Env: PARALLEL (default 250), PRICE (default 0.01), PRIVATE_KEY, ARC_TESTNET_RPC_URL.
 */
require("dotenv").config();
const http = require("http");
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");
const { SpecularX402Server } = require("../src/sdk/x402/SpecularX402Server.js");

const PARALLEL = parseInt(process.env.PARALLEL || "250", 10);
const PRICE = parseFloat(process.env.PRICE || "0.01");
const RPC = process.env.ARC_TESTNET_RPC_URL || "https://arc-testnet.drpc.org";
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "src", "config", "arc-testnet-v6-addresses.json"), "utf8"));
const mpAbi = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "artifacts", "contracts", "core", "AgentLiquidityMarketplaceV6.sol", "AgentLiquidityMarketplaceV6.json"), "utf8")).abi;

async function main() {
    const provider = new ethers.JsonRpcProvider(RPC, 5042002, { batchMaxCount: 1 });
    const mp = new ethers.Contract(cfg.agentLiquidityMarketplace_v6, mpAbi, provider);
    const before = (await mp.getAgentPool(1)).totalLiquidity;

    const seller = new SpecularX402Server({
        network: "arc-staging",
        privateKey: process.env.PRIVATE_KEY,
        rpcUrl: RPC,
        pricing: { default: PRICE },
        mode: "stub",
        allowStub: true, // scale-test harness; stub does no payment verification
        poolAgentId: 1,
        autoFlushThresholdUsdc: PARALLEL * PRICE, // single flush at the end of the burst
    });

    const server = http.createServer(seller.handle(async (req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
    }));
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;

    console.log(`Burst: ${PARALLEL} concurrent buyers × ${PRICE} USDC (expected ${(PARALLEL * PRICE).toFixed(2)} USDC)`);
    const t0 = Date.now();
    const results = await Promise.all(Array.from({ length: PARALLEL }, (_, i) =>
        fetch(`http://127.0.0.1:${port}/api/call-${i}`, { headers: { "x-payment": `stub-${i}` } })
            .then((r) => r.status).catch(() => 0)
    ));
    const secs = (Date.now() - t0) / 1000;
    const ok = results.filter((s) => s === 200).length;
    console.log(`Served ${ok}/${PARALLEL} in ${secs.toFixed(2)}s (${(ok / secs).toFixed(0)} req/s)`);

    // Wait for the auto-flush to settle on-chain.
    for (let i = 0; i < 60 && seller._earned > 0n; i++) await new Promise((r) => setTimeout(r, 1000));
    const stats = seller.stats();
    console.log(`Stats: requests=${stats.requestCount} pending=${stats.pendingUsdc} flushed=${stats.totalFlushedUsdc}`);
    const after = (await mp.getAgentPool(1)).totalLiquidity;
    const delta = after - before;
    console.log(`Staging pool totalLiquidity: ${ethers.formatUnits(before, 6)} → ${ethers.formatUnits(after, 6)} (Δ ${ethers.formatUnits(delta, 6)})`);

    server.close();
    const expected = ethers.parseUnits(String(PARALLEL * PRICE), 6);
    const pass = ok === PARALLEL
        && stats.requestCount === PARALLEL
        && stats.pendingUsdc === "0.0"
        && delta === expected;
    console.log(pass
        ? `\n=== ✅ x402 MICRO-TX SCALE PASS: ${PARALLEL} concurrent micro-payments, EXACT accounting, single on-chain flush ===`
        : `\n=== ❌ FAIL: served=${ok} requests=${stats.requestCount} pending=${stats.pendingUsdc} delta=${ethers.formatUnits(delta, 6)} expected=${PARALLEL * PRICE} ===`);
    process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
