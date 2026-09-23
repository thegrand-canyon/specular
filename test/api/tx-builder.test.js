// Integration test for the tx-builder endpoints in MultiNetworkAPI.
// Spawns the API on a random port, posts to each endpoint, decodes returned
// calldata, and verifies it matches the function + args.

const { spawn } = require('child_process');
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');
const { expect } = require('chai');

const ABI_DIR = path.join(__dirname, '..', '..', 'abis');
const mpAbi = JSON.parse(fs.readFileSync(path.join(ABI_DIR, 'AgentLiquidityMarketplace.json'), 'utf8'));
const registryAbi = JSON.parse(fs.readFileSync(path.join(ABI_DIR, 'AgentRegistryV2.json'), 'utf8'));
const mpIface = new ethers.Interface(Array.isArray(mpAbi) ? mpAbi : (mpAbi.abi || mpAbi));
const regIface = new ethers.Interface(Array.isArray(registryAbi) ? registryAbi : (registryAbi.abi || registryAbi));

const PORT = 3099;
const BASE = `http://127.0.0.1:${PORT}`;

let serverProc;

async function waitForServer(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await fetch(`${BASE}/health?network=arc`);
            if (r.status < 500) return;
        } catch {}
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('API server did not start within ' + timeoutMs + 'ms');
}

describe('TX Builder endpoints', function () {
    this.timeout(30000);

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

    describe('POST /tx/request-loan', () => {
        it('returns valid calldata for valid input', async () => {
            const r = await fetch(`${BASE}/tx/request-loan?network=arc`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount: '5000000', durationDays: 7 }),
            });
            expect(r.status).to.equal(200);
            const body = await r.json();
            expect(body.to).to.match(/^0x[0-9a-fA-F]{40}$/);
            expect(body.method).to.equal('requestLoan');
            expect(body.network).to.equal('arc');

            const decoded = mpIface.decodeFunctionData('requestLoan', body.data);
            expect(decoded[0]).to.equal(5000000n);
            expect(decoded[1]).to.equal(7n);
        });

        it('rejects durationDays out of range (404 = below MIN)', async () => {
            const r = await fetch(`${BASE}/tx/request-loan?network=arc`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount: 100, durationDays: 6 }),
            });
            expect(r.status).to.equal(400);
            const body = await r.json();
            expect(body.error).to.match(/durationDays must be 7-365/);
        });

        it('rejects seconds-shaped duration with hint', async () => {
            const r = await fetch(`${BASE}/tx/request-loan?network=arc`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount: 100, durationDays: 604800 }),
            });
            expect(r.status).to.equal(400);
            const body = await r.json();
            expect(body.error).to.match(/seconds/);
        });

        it('rejects invalid network', async () => {
            const r = await fetch(`${BASE}/tx/request-loan?network=mars`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount: 100, durationDays: 7 }),
            });
            expect(r.status).to.equal(400);
        });
    });

    describe('POST /tx/repay-loan', () => {
        it('encodes loanId correctly', async () => {
            const r = await fetch(`${BASE}/tx/repay-loan?network=arc`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ loanId: 42 }),
            });
            expect(r.status).to.equal(200);
            const body = await r.json();
            const decoded = mpIface.decodeFunctionData('repayLoan', body.data);
            expect(decoded[0]).to.equal(42n);
        });
    });

    describe('POST /tx/supply-liquidity', () => {
        it('encodes agentId + amount', async () => {
            const r = await fetch(`${BASE}/tx/supply-liquidity?network=base`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId: 1, amount: 1000000 }),
            });
            expect(r.status).to.equal(200);
            const body = await r.json();
            expect(body.network).to.equal('base');
            expect(body.chainId).to.equal(8453);
            const decoded = mpIface.decodeFunctionData('supplyLiquidity', body.data);
            expect(decoded[0]).to.equal(1n);
            expect(decoded[1]).to.equal(1000000n);
        });

        it('rejects amount=0', async () => {
            const r = await fetch(`${BASE}/tx/supply-liquidity?network=arc`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId: 1, amount: 0 }),
            });
            expect(r.status).to.equal(400);
        });
    });

    describe('POST /tx/withdraw-liquidity', () => {
        it('encodes agentId + amount', async () => {
            const r = await fetch(`${BASE}/tx/withdraw-liquidity?network=arc`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId: 49, amount: 5000000 }),
            });
            expect(r.status).to.equal(200);
            const body = await r.json();
            const decoded = mpIface.decodeFunctionData('withdrawLiquidity', body.data);
            expect(decoded[0]).to.equal(49n);
            expect(decoded[1]).to.equal(5000000n);
        });
    });

    describe('POST /tx/claim-interest', () => {
        it('encodes agentId', async () => {
            const r = await fetch(`${BASE}/tx/claim-interest?network=arc`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentId: 49 }),
            });
            expect(r.status).to.equal(200);
            const body = await r.json();
            const decoded = mpIface.decodeFunctionData('claimInterest', body.data);
            expect(decoded[0]).to.equal(49n);
        });
    });

    describe('POST /tx/create-agent-pool', () => {
        it('returns calldata with no args', async () => {
            const r = await fetch(`${BASE}/tx/create-agent-pool?network=arc`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: '{}',
            });
            expect(r.status).to.equal(200);
            const body = await r.json();
            expect(body.method).to.equal('createAgentPool');
            // 4-byte selector only
            expect(body.data).to.match(/^0x[0-9a-fA-F]{8}$/);
        });
    });

    describe('POST /tx/register', () => {
        it('encodes agentURI + empty metadata', async () => {
            const r = await fetch(`${BASE}/tx/register?network=arc`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentURI: 'ipfs://QmTest123' }),
            });
            expect(r.status).to.equal(200);
            const body = await r.json();
            const decoded = regIface.decodeFunctionData('register', body.data);
            expect(decoded[0]).to.equal('ipfs://QmTest123');
            expect(decoded[1]).to.deep.equal([]);
        });

        it('rejects empty agentURI', async () => {
            const r = await fetch(`${BASE}/tx/register?network=arc`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ agentURI: '' }),
            });
            expect(r.status).to.equal(400);
        });
    });

    describe('Cross-network consistency', () => {
        it('same input produces same calldata regardless of network', async () => {
            const body1 = await (await fetch(`${BASE}/tx/request-loan?network=arc`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount: 1000, durationDays: 30 }),
            })).json();
            const body2 = await (await fetch(`${BASE}/tx/request-loan?network=base`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount: 1000, durationDays: 30 }),
            })).json();
            expect(body1.data).to.equal(body2.data);
            // But different `to` and chainId
            expect(body1.to).to.not.equal(body2.to);
            expect(body1.chainId).to.equal(5042002);
            expect(body2.chainId).to.equal(8453);
        });
    });
});
