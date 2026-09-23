/**
 * x402 concurrent load — N parallel buyers paying one SpecularX402Server.
 *
 * Verifies:
 *   - All N HTTP requests succeed (no payment-header race)
 *   - Stats reflect exactly N requests + N × price USDC
 *   - Auto-flush triggers without double-supplying the pool
 *   - Final on-chain pool delta = N × price (one or more flush txs total)
 *   - No "Pool lender capacity reached" or other contract errors
 *
 * Run:
 *   PARALLEL=50 node forensics/scripts/tmp_x402_concurrent_load.js
 */

require('dotenv').config();
const http = require('http');
const path = require('path');
const fs = require('fs');
const { ethers } = require('ethers');

const { SpecularX402Server } = require('../x402');

const PORT = 4500;
const POOL_AGENT_ID = 49;
const PRICE = 0.05;
const PARALLEL = parseInt(process.env.PARALLEL || '50', 10);
const AUTO_FLUSH = 1.0;  // flushes after every 20 requests at 0.05 USDC each
const NETWORK = 'arc';

(async () => {
    const addrPath = path.resolve(__dirname, '../../config/arc-testnet-addresses.json');
    const addr = JSON.parse(fs.readFileSync(addrPath, 'utf8'));
    const mpAbiPath = path.resolve(__dirname, '../../../artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json');
    const mpAbi = JSON.parse(fs.readFileSync(mpAbiPath, 'utf8')).abi;
    const provider = new ethers.JsonRpcProvider('https://arc-testnet.drpc.org');
    const mp = new ethers.Contract(addr.agentLiquidityMarketplace_v6, mpAbi, provider);

    const seller = new SpecularX402Server({
        network: NETWORK,
        privateKey: process.env.PRIVATE_KEY,
        poolAgentId: POOL_AGENT_ID,
        pricing: { '/transcribe': PRICE, default: PRICE },
        autoFlushThresholdUsdc: AUTO_FLUSH,
        mode: 'stub',
        allowStub: true,  // test harness: stub does no payment verification
    });

    const poolBefore = await mp.agentPools(POOL_AGENT_ID);
    const totalLiquidityBefore = poolBefore.totalLiquidity;
    console.log(`\n=== x402 concurrent load test ===`);
    console.log(`Parallel buyers:   ${PARALLEL}`);
    console.log(`Price per call:    ${PRICE} USDC`);
    console.log(`Expected revenue:  ${PARALLEL * PRICE} USDC`);
    console.log(`Auto-flush at:     ${AUTO_FLUSH} USDC`);
    console.log(`Pool ${POOL_AGENT_ID} totalLiquidity (before): ${ethers.formatUnits(totalLiquidityBefore, 6)} USDC`);

    const server = http.createServer(seller.handle(async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, n: Math.floor(Math.random() * 1e6) }));
    }));
    await new Promise(r => server.listen(PORT, r));
    console.log(`\nServer listening on :${PORT}`);

    // Fire PARALLEL requests simultaneously (Promise.all → all start within ms)
    console.log(`\n[FIRE] Launching ${PARALLEL} concurrent x402-paying buyers...`);
    const t0 = Date.now();
    const results = await Promise.allSettled(
        Array.from({ length: PARALLEL }, async (_, i) => {
            const r = await fetch(`http://localhost:${PORT}/transcribe`, {
                method: 'POST',
                headers: {
                    'X-PAYMENT': Buffer.from(JSON.stringify({ stub: true, n: i })).toString('base64'),
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ buyer: i }),
            });
            return { i, status: r.status, body: await r.text() };
        })
    );
    const totalElapsedMs = Date.now() - t0;
    const ok = results.filter(x => x.status === 'fulfilled' && x.value.status === 200).length;
    const fail = results.filter(x => x.status === 'rejected' || (x.status === 'fulfilled' && x.value.status !== 200)).length;
    console.log(`\n[RESULT] ${ok}/${PARALLEL} succeeded, ${fail} failed in ${totalElapsedMs}ms`);
    console.log(`         Throughput: ${(PARALLEL / (totalElapsedMs / 1000)).toFixed(2)} req/sec`);

    // Wait for any in-flight auto-flush txs to confirm
    console.log('\nWaiting 15s for auto-flush tx(s) to settle on Arc...');
    await new Promise(r => setTimeout(r, 15_000));

    const finalStats = seller.stats();
    console.log('\n[STATS]', JSON.stringify(finalStats, null, 2));

    const poolAfter = await mp.agentPools(POOL_AGENT_ID);
    const delta = poolAfter.totalLiquidity - totalLiquidityBefore;
    console.log(`\nPool ${POOL_AGENT_ID} totalLiquidity (after):  ${ethers.formatUnits(poolAfter.totalLiquidity, 6)} USDC`);
    console.log(`Delta:               ${ethers.formatUnits(delta, 6)} USDC`);

    const expectedTotal = ethers.parseUnits(String(PARALLEL * PRICE), 6);
    const supplied = delta;
    const stillPending = ethers.parseUnits(finalStats.pendingUsdc, 6);
    const accounted = supplied + stillPending;
    console.log(`\nExpected revenue:   ${ethers.formatUnits(expectedTotal, 6)} USDC`);
    console.log(`Supplied on-chain:  ${ethers.formatUnits(supplied, 6)} USDC`);
    console.log(`Still pending:      ${ethers.formatUnits(stillPending, 6)} USDC`);
    console.log(`Accounted:          ${ethers.formatUnits(accounted, 6)} USDC`);

    let pass = true;
    if (ok !== PARALLEL) {
        console.log(`\n❌ Not all requests succeeded: ${ok}/${PARALLEL}`);
        pass = false;
    }
    if (finalStats.requestCount !== PARALLEL) {
        console.log(`\n❌ Stats requestCount mismatch: ${finalStats.requestCount} vs expected ${PARALLEL}`);
        pass = false;
    }
    if (accounted !== expectedTotal) {
        console.log(`\n❌ Revenue accounting drift: ${ethers.formatUnits(accounted, 6)} accounted vs ${ethers.formatUnits(expectedTotal, 6)} expected`);
        pass = false;
    }
    if (pass) {
        console.log(`\n✅ x402 concurrent load PASS`);
        console.log(`   ${PARALLEL} parallel buyers, all settled exact, no race conditions`);
    } else {
        console.log(`\n⚠️  Concurrent load surfaced issues — see above`);
    }

    server.close();
    process.exit(pass ? 0 : 1);
})().catch(e => { console.error('LOAD TEST ERROR:', e); process.exit(1); });
