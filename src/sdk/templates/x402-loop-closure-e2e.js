/**
 * End-to-end test: SpecularX402Client → SpecularX402Server → auto-supply.
 *
 * 1. Starts server (stub mode) in background with poolAgentId=49, autoFlushThresholdUsdc=0.4
 * 2. Client makes 4 paid requests → 4 × 0.1 USDC = 0.4 USDC accumulated
 * 3. Auto-flush should fire after the 4th call → supplies into pool 49
 * 4. Verify on-chain: pool.totalSupplied increased
 */

require('dotenv').config();
const http = require('http');
const path = require('path');
const { ethers } = require('ethers');
const fs = require('fs');

const { SpecularX402Server } = require('../x402');

const PORT = 4141;
const POOL_AGENT_ID = 49;
const THRESHOLD = 0.4;
const PRICE_PER_CALL = 0.1;
const CALL_COUNT = 4;
const NETWORK = 'arc';

(async () => {
    const addr = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../config/arc-testnet-addresses.json'), 'utf8'));
    const provider = new ethers.JsonRpcProvider('https://arc-testnet.drpc.org');
    const sellerWallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    const seller = new SpecularX402Server({
        network: NETWORK,
        privateKey: process.env.PRIVATE_KEY,
        poolAgentId: POOL_AGENT_ID,
        pricing: { '/transcribe': PRICE_PER_CALL, default: PRICE_PER_CALL },
        autoFlushThresholdUsdc: THRESHOLD,
        mode: 'stub',
        allowStub: true,  // test harness: stub does no payment verification
    });

    // Read pool state BEFORE
    const mpAbi = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json'))).abi;
    const mp = new ethers.Contract(addr.agentLiquidityMarketplace_v6, mpAbi, provider);
    const poolBefore = await mp.agentPools(POOL_AGENT_ID);
    console.log('\n=== BEFORE ===');
    console.log('Pool totalLiquidity:', ethers.formatUnits(poolBefore.totalLiquidity, 6), 'USDC');
    console.log('Pool available:     ', ethers.formatUnits(poolBefore.availableLiquidity, 6), 'USDC');
    console.log('Seller stats:        ', seller.stats());

    const server = http.createServer(seller.handle(async (req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: 'transcription' }));
    }));

    await new Promise(r => server.listen(PORT, r));
    console.log(`\nServer listening on http://localhost:${PORT}`);

    // Client makes 4 paid requests (stub mode, so just include a fake header)
    // The real auto-supply trigger logic doesn't depend on payment validity in stub mode
    console.log(`\n=== Sending ${CALL_COUNT} paid requests (${PRICE_PER_CALL} USDC each, threshold=${THRESHOLD}) ===`);
    for (let i = 1; i <= CALL_COUNT; i++) {
        const res = await fetch(`http://localhost:${PORT}/transcribe`, {
            method: 'POST',
            headers: { 'X-PAYMENT': Buffer.from(JSON.stringify({ stub: true, n: i })).toString('base64') },
            body: 'audio-blob',
        });
        console.log(`  Call ${i}: HTTP ${res.status}, pending=${seller.stats().pendingUsdc} USDC, flushed=${seller.stats().totalFlushedUsdc} USDC`);
    }

    // Allow auto-flush tx to settle
    console.log('\nWaiting 10s for auto-flush tx to confirm on Arc...');
    await new Promise(r => setTimeout(r, 10_000));

    // Final stats + pool state
    console.log('\n=== AFTER ===');
    console.log('Seller stats:        ', seller.stats());
    const poolAfter = await mp.agentPools(POOL_AGENT_ID);
    console.log('Pool totalLiquidity:', ethers.formatUnits(poolAfter.totalLiquidity, 6), 'USDC');
    console.log('Pool available:     ', ethers.formatUnits(poolAfter.availableLiquidity, 6), 'USDC');

    const delta = poolAfter.totalLiquidity - poolBefore.totalLiquidity;
    console.log(`\nDelta totalLiquidity: ${ethers.formatUnits(delta, 6)} USDC`);
    if (delta > 0n) {
        console.log('✅ Auto-supply LOOP CLOSED — revenue flowed into Specular pool');
    } else {
        console.log('⚠️  No supply detected. Check seller stats.totalFlushedUsdc above.');
    }

    server.close();
    process.exit(delta > 0n ? 0 : 1);
})().catch(e => { console.error('TEST ERROR:', e); process.exit(1); });
