/**
 * Template: x402 seller running SpecularX402Server.
 *
 * Spins up an HTTP server that demands USDC payment for /transcribe and
 * automatically supplies the accumulated revenue into a Specular pool.
 *
 * Modes:
 *   - PORT=4040 MODE=stub             — for local x402 e2e (no on-chain settle)
 *   - PORT=4040 MODE=facilitator NETWORK=base
 *     SELLER_KEY=0x... PAY_TO=0x...
 *     POOL_AGENT_ID=49                — production wiring on Base
 *
 * Run:
 *   PORT=4040 MODE=stub node src/sdk/templates/x402-specular-seller.js
 *
 *   PORT=4040 MODE=facilitator NETWORK=base \
 *     SELLER_KEY=0x... PAY_TO=0x... POOL_AGENT_ID=49 \
 *     node src/sdk/templates/x402-specular-seller.js
 */

require('dotenv').config();
const http = require('http');
const { SpecularX402Server } = require('../x402/SpecularX402Server');

const PORT = process.env.PORT || 4040;
const MODE = process.env.MODE || 'stub';
const NETWORK = process.env.NETWORK || 'arc';

const seller = new SpecularX402Server({
    network: NETWORK,
    privateKey: process.env.SELLER_KEY || process.env.PRIVATE_KEY,
    payTo: process.env.PAY_TO,                            // optional: defaults to wallet addr
    poolAgentId: process.env.POOL_AGENT_ID ? parseInt(process.env.POOL_AGENT_ID, 10) : null,
    pricing: { '/transcribe': 0.5, default: 0.1 },
    autoFlushThresholdUsdc: parseFloat(process.env.AUTO_FLUSH_THRESHOLD_USDC || '5'),
    mode: MODE,
    facilitatorUrl: process.env.FACILITATOR_URL,
});

const server = http.createServer(seller.handle(async (req, res) => {
    // Payment verified — run the actual API work
    let body = '';
    req.on('data', chunk => body += chunk);
    await new Promise(resolve => req.on('end', resolve));

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        ok: true,
        result: 'transcription: "the quick brown fox"',
        bytesReceived: body.length,
    }));
}));

server.listen(PORT, () => {
    const s = seller.stats();
    console.log(`\n=== SpecularX402Server (${MODE} mode, ${NETWORK}) ===`);
    console.log(`Listening on http://localhost:${PORT}`);
    console.log(`Seller wallet: ${s.sellerWallet}`);
    console.log(`Pay-to:        ${s.payTo}`);
    console.log(`Pool agent:    ${s.poolAgentId || '(no auto-supply)'}`);
    console.log(`Auto-flush at: ${s.autoFlushThresholdUsdc} USDC`);
    console.log(`Stats:         http://localhost:${PORT}/__specular_x402/stats`);
});

// Periodic flush (every 5 min)
if (seller.poolAgentId) {
    seller.startAutoFlush(5 * 60_000);
}

process.on('SIGINT', async () => {
    console.log('\nShutting down — final flush…');
    try { await seller.flushToPool(); } catch (e) { console.error('flush:', e.message); }
    process.exit(0);
});
