/**
 * x402-stub-server — minimal x402 "seller" server for testing the agent flow.
 *
 * Returns HTTP 402 Payment Required with mock payment instructions. Suitable
 * for local demos of the SpecularX402Client.
 *
 * NOTE: This is a STUB. The PAYMENT-REQUIRED header points to a fake settlement
 * facilitator. To actually exchange USDC, you'd need to use Coinbase's hosted
 * x402 facilitator (docs.cdp.coinbase.com/x402) or a real one. This stub
 * demonstrates the HTTP protocol shape only.
 *
 * Run:
 *   node src/sdk/templates/x402-stub-server.js
 */

const http = require('http');

const PORT = process.env.PORT || 4040;

const server = http.createServer((req, res) => {
    if (req.method !== 'POST') {
        res.writeHead(405); res.end('Method not allowed');
        return;
    }

    const hasPayment = req.headers['payment-signature'] || req.headers['x-payment'];

    if (!hasPayment) {
        // Demand payment
        const paymentRequired = {
            x402Version: 1,
            error: 'X-PAYMENT header is required',
            accepts: [{
                scheme: 'exact',
                network: 'base',
                maxAmountRequired: '500000', // 0.5 USDC in 6-dec units
                resource: `http://${req.headers.host}${req.url}`,
                description: 'Stub API call payment',
                mimeType: 'application/json',
                payTo: '0x0000000000000000000000000000000000000000',
                maxTimeoutSeconds: 60,
                asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' // Base USDC
            }]
        };
        res.writeHead(402, {
            'Content-Type': 'application/json',
            'PAYMENT-REQUIRED': JSON.stringify(paymentRequired)
        });
        res.end(JSON.stringify(paymentRequired));
        return;
    }

    // Payment present — accept (in a real server you'd verify w/ facilitator)
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        ok: true,
        result: 'transcription: "the quick brown fox"',
        paid: hasPayment.slice(0, 40) + '...'
    }));
});

server.listen(PORT, () => {
    console.log(`x402 stub server listening on http://localhost:${PORT}`);
    console.log(`Test with: node src/sdk/templates/x402-agent.js http://localhost:${PORT}/transcribe`);
});
