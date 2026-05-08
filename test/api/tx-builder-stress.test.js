// API tx-builder stress test:
//   - Concurrent requests (no race conditions, no crashes)
//   - Malformed inputs (negative, huge, missing fields, wrong types, injection)
//   - Verify API doesn't crash and returns coherent errors

const { spawn } = require('child_process');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const ABI_DIR = path.join(__dirname, '..', '..', 'abis');
const mpAbi = JSON.parse(fs.readFileSync(path.join(ABI_DIR, 'AgentLiquidityMarketplace.json'), 'utf8'));
const mpIface = new ethers.Interface(Array.isArray(mpAbi) ? mpAbi : (mpAbi.abi || mpAbi));

const PORT = 3097;
const BASE_URL = `http://127.0.0.1:${PORT}`;

let serverProc;

async function waitForServer(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await fetch(`${BASE_URL}/health?network=arc`);
            if (r.status < 500) return;
        } catch {}
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('API never started');
}

async function post(endpoint, body, network = 'arc') {
    return await fetch(`${BASE_URL}/tx/${endpoint}?network=${network}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

describe('TX Builder stress', function () {
    this.timeout(60000);

    before(async () => {
        serverProc = spawn('node', [path.join(__dirname, '..', '..', 'src', 'api', 'MultiNetworkAPI.js')], {
            env: { ...process.env, PORT: String(PORT), ENABLE_CACHE: 'false' },
            stdio: ['ignore', 'ignore', 'ignore'],
        });
        await waitForServer();
    });

    after(() => {
        if (serverProc && !serverProc.killed) serverProc.kill('SIGTERM');
    });

    describe('Concurrent requests', () => {
        it('handles 20 parallel requests without crashing', async () => {
            const reqs = [];
            for (let i = 0; i < 20; i++) {
                reqs.push(post('request-loan', { amount: String(1000000 + i), durationDays: 7 + (i % 30) }));
            }
            const results = await Promise.all(reqs);
            expect(results.every(r => r.status === 200)).to.equal(true);
            const bodies = await Promise.all(results.map(r => r.json()));
            // Each should have valid calldata
            for (const b of bodies) {
                expect(b.method).to.equal('requestLoan');
                expect(b.data).to.match(/^0x[0-9a-fA-F]+$/);
            }
        });

        it('mixed-endpoint concurrent storm', async () => {
            const reqs = [];
            for (let i = 0; i < 30; i++) {
                const endpoints = [
                    () => post('request-loan', { amount: '5000000', durationDays: 7 }),
                    () => post('repay-loan', { loanId: i }),
                    () => post('supply-liquidity', { agentId: 1, amount: '1000000' }),
                    () => post('withdraw-liquidity', { agentId: 1, amount: '500000' }),
                    () => post('claim-interest', { agentId: 1 }),
                    () => post('create-agent-pool', {}),
                    () => post('register', { agentURI: `ipfs://test${i}` }),
                ];
                reqs.push(endpoints[i % endpoints.length]());
            }
            const results = await Promise.all(reqs);
            expect(results.every(r => r.status === 200)).to.equal(true);
        });
    });

    describe('Malformed inputs', () => {
        const cases = [
            { name: 'negative amount', endpoint: 'request-loan', body: { amount: -100, durationDays: 7 }, expectStatus: 400 },
            { name: 'string amount that is not numeric', endpoint: 'request-loan', body: { amount: 'foo', durationDays: 7 }, expectStatus: 400 },
            { name: 'missing amount', endpoint: 'request-loan', body: { durationDays: 7 }, expectStatus: 400 },
            { name: 'missing durationDays', endpoint: 'request-loan', body: { amount: 100 }, expectStatus: 400 },
            { name: 'duration NaN', endpoint: 'request-loan', body: { amount: 100, durationDays: NaN }, expectStatus: 400 },
            { name: 'duration Infinity', endpoint: 'request-loan', body: { amount: 100, durationDays: Infinity }, expectStatus: 400 },
            { name: 'duration float', endpoint: 'request-loan', body: { amount: 100, durationDays: 7.5 }, expectStatus: 400 },
            { name: 'empty body', endpoint: 'request-loan', body: {}, expectStatus: 400 },
            { name: 'null body', endpoint: 'request-loan', body: 'null', expectStatus: 400 },
            { name: 'invalid JSON', endpoint: 'request-loan', body: '{not json}', expectStatus: 400 },
            { name: 'amount as huge bigint string', endpoint: 'request-loan', body: { amount: '99999999999999999999999999999999999999999', durationDays: 7 }, expectStatus: 200, /* big numbers are valid base units */ },
            { name: 'register with empty URI', endpoint: 'register', body: { agentURI: '' }, expectStatus: 400 },
            { name: 'register with non-string URI', endpoint: 'register', body: { agentURI: 12345 }, expectStatus: 400 },
            { name: 'register with very long URI', endpoint: 'register', body: { agentURI: 'a'.repeat(10000) }, expectStatus: 200 },
            { name: 'register with unicode URI', endpoint: 'register', body: { agentURI: 'ipfs://测试🚀' }, expectStatus: 200 },
            { name: 'register with SQL-like injection', endpoint: 'register', body: { agentURI: "ipfs://'; DROP TABLE agents;--" }, expectStatus: 200 /* string passthrough is fine, contract handles */ },
            { name: 'agentId as float', endpoint: 'supply-liquidity', body: { agentId: 1.5, amount: 100 }, expectStatus: 400 },
            { name: 'agentId negative', endpoint: 'supply-liquidity', body: { agentId: -1, amount: 100 }, expectStatus: 400 },
            { name: 'amount = 0 supply', endpoint: 'supply-liquidity', body: { agentId: 1, amount: 0 }, expectStatus: 400 },
            { name: 'amount = 0 withdraw', endpoint: 'withdraw-liquidity', body: { agentId: 1, amount: 0 }, expectStatus: 400 },
            { name: 'invalid network', endpoint: 'request-loan', body: { amount: 100, durationDays: 7 }, network: 'mars', expectStatus: 400 },
        ];

        for (const c of cases) {
            it(c.name, async () => {
                const r = await post(c.endpoint, c.body, c.network || 'arc');
                expect(r.status, `endpoint=${c.endpoint} body=${JSON.stringify(c.body)}`).to.equal(c.expectStatus);
                // Body should always be valid JSON
                const txt = await r.text();
                expect(() => JSON.parse(txt)).to.not.throw();
            });
        }
    });

    describe('Output integrity', () => {
        it('decoded calldata always matches input', async () => {
            // 10 random valid requests, verify each
            for (let i = 0; i < 10; i++) {
                const amount = Math.floor(Math.random() * 1e10) + 1;
                const dur = 7 + Math.floor(Math.random() * 30);
                const r = await post('request-loan', { amount: String(amount), durationDays: dur });
                expect(r.status).to.equal(200);
                const body = await r.json();
                const decoded = mpIface.decodeFunctionData('requestLoan', body.data);
                expect(decoded[0]).to.equal(BigInt(amount));
                expect(decoded[1]).to.equal(BigInt(dur));
            }
        });

        it('calldata is deterministic for same input', async () => {
            const body1 = await (await post('supply-liquidity', { agentId: 5, amount: '12345678' })).json();
            const body2 = await (await post('supply-liquidity', { agentId: 5, amount: '12345678' })).json();
            expect(body1.data).to.equal(body2.data);
            expect(body1.to).to.equal(body2.to);
        });

        it('every successful response has the required fields', async () => {
            const r = await post('request-loan', { amount: 100, durationDays: 7 });
            const body = await r.json();
            expect(body).to.have.property('to');
            expect(body).to.have.property('data');
            expect(body).to.have.property('chainId');
            expect(body).to.have.property('method');
            expect(body).to.have.property('network');
            expect(body.to).to.match(/^0x[0-9a-fA-F]{40}$/);
            expect(body.data).to.match(/^0x[0-9a-fA-F]+$/);
            expect(body.chainId).to.be.a('number');
        });
    });
});
