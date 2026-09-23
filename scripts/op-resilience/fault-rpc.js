// Fault-injecting JSON-RPC proxy, used to answer "does the monitor report a
// false OK when the RPC is down, slow, or serving stale data?".
//
// Modes:
//   stale   — forwards everything but rewrites the latest block's timestamp to
//             `--age` seconds ago (chain head looks old; state reads still work)
//   frozen  — always replays the FIRST block number/timestamp it ever saw
//             (an RPC pinned to an old snapshot — the nastiest case, because every
//              state read still succeeds and looks self-consistent)
//   slow    — delays every response by `--delay` ms
//   error   — returns a JSON-RPC error for every call
//
// Usage: node scripts/op-resilience/fault-rpc.js --mode stale --port 8555 [--age 7200] [--delay 30000]

const http = require('http');

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const MODE = arg('mode', 'stale');
const PORT = Number(arg('port', 8555));
const UPSTREAM = arg('upstream', 'http://127.0.0.1:8545');
const AGE = Number(arg('age', 7200));
const DELAY = Number(arg('delay', 30000));

let frozenBlock = null;

async function forward(body) {
    const r = await fetch(UPSTREAM, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return await r.json();
}

const server = http.createServer(async (req, res) => {
    let raw = '';
    req.on('data', c => raw += c);
    req.on('end', async () => {
        if (MODE === 'slow') await new Promise(r => setTimeout(r, DELAY));
        let body;
        try { body = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }

        if (MODE === 'error') {
            const err = m => ({ jsonrpc: '2.0', id: m.id, error: { code: -32000, message: 'upstream unavailable' } });
            const out = Array.isArray(body) ? body.map(err) : err(body);
            res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
            return;
        }

        let out;
        try { out = await forward(body); }
        catch (e) {
            res.writeHead(200, { 'Content-Type': 'application/json' })
               .end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32000, message: e.message } }));
            return;
        }

        const patch = (req1, resp) => {
            if (!resp || !resp.result) return resp;
            if (req1.method === 'eth_getBlockByNumber' || req1.method === 'eth_getBlockByHash') {
                if (MODE === 'stale') {
                    resp.result.timestamp = '0x' + Math.floor(Date.now() / 1000 - AGE).toString(16);
                } else if (MODE === 'frozen') {
                    if (!frozenBlock) frozenBlock = { number: resp.result.number, timestamp: resp.result.timestamp };
                    resp.result.number = frozenBlock.number;
                    resp.result.timestamp = frozenBlock.timestamp;
                }
            }
            if (req1.method === 'eth_blockNumber' && MODE === 'frozen' && frozenBlock) resp.result = frozenBlock.number;
            return resp;
        };
        out = Array.isArray(body) ? body.map((m, i) => patch(m, out[i])) : patch(body, out);
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
    });
});

server.listen(PORT, '127.0.0.1', () => console.error(`fault-rpc mode=${MODE} on :${PORT} -> ${UPSTREAM}`));
