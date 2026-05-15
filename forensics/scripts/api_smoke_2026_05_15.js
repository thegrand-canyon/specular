// API tx-builder integration smoke test.
// Starts API server in background, hits every /tx/* + read endpoint, validates responses.
// Then: takes a /tx/supply-liquidity response, signs it, broadcasts on Arc, verifies execution.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const { spawn } = require('child_process');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const API_PORT = process.env.API_PORT || 3001;
const API_BASE = `http://localhost:${API_PORT}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const fetchJson = async (path, opts = {}) => {
    const r = await fetch(API_BASE + path, opts);
    const text = await r.text();
    try { return { status: r.status, json: JSON.parse(text) }; }
    catch (e) { return { status: r.status, raw: text.slice(0, 200) }; }
};

const log = (...a) => console.log(...a);

(async () => {
    log('=== API tx-builder smoke test ===');

    // Start the API server in background
    log('\n[1] Starting API server (src/api/MultiNetworkAPI.js)');
    const api = spawn('node', ['src/api/MultiNetworkAPI.js'], {
        env: { ...process.env, PORT: String(API_PORT) },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    let apiReady = false;
    api.stdout.on('data', d => { const s = d.toString(); if (s.includes('listening') || s.includes('PORT')) apiReady = true; });
    api.stderr.on('data', d => process.stderr.write('[api] ' + d.toString()));
    // Wait for server to be ready
    for (let i = 0; i < 30; i++) {
        await sleep(500);
        try {
            const r = await fetch(API_BASE + '/health');
            if (r.status === 200) { apiReady = true; break; }
        } catch (e) {}
    }
    if (!apiReady) {
        log('  ✗ API did not start within 15s — aborting');
        api.kill('SIGTERM');
        process.exit(1);
    }
    log('  ✓ API ready at', API_BASE);

    const results = [];
    const test = async (name, path, opts = {}) => {
        try {
            const r = await fetchJson(path, opts);
            const ok = r.status >= 200 && r.status < 300;
            results.push({ name, path, status: r.status, ok, body: r.json || r.raw });
            log(`  ${ok ? '✓' : '✗'} ${name}: HTTP ${r.status}${ok ? '' : ' — ' + JSON.stringify(r.json || r.raw).slice(0, 100)}`);
            return r;
        } catch (e) {
            results.push({ name, path, error: e.message, ok: false });
            log(`  ✗ ${name}: ERROR ${e.message}`);
        }
    };

    log('\n[2] Read endpoints');
    await test('GET /health', '/health');
    await test('GET /status', '/status');
    await test('GET /networks', '/networks');
    await test('GET /pools', '/pools?network=arc-testnet');
    await test('GET /agents', '/agents?network=arc-testnet');

    log('\n[3] Tx-builder endpoints (return unsigned tx data, do not sign or broadcast)');
    const txBody = { network: 'arc-testnet' };
    const post = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    await test('POST /tx/register', '/tx/register', post({ ...txBody, ipfsHash: 'ipfs://test', categories: [] }));
    await test('POST /tx/create-agent-pool', '/tx/create-agent-pool', post(txBody));
    await test('POST /tx/supply-liquidity', '/tx/supply-liquidity', post({ ...txBody, agentId: '1', amount: '1000000' }));
    await test('POST /tx/withdraw-liquidity', '/tx/withdraw-liquidity', post({ ...txBody, agentId: '1', amount: '1000000' }));
    await test('POST /tx/request-loan', '/tx/request-loan', post({ ...txBody, amount: '5000000', durationDays: '7' }));
    await test('POST /tx/repay-loan', '/tx/repay-loan', post({ ...txBody, loanId: '1' }));
    await test('POST /tx/claim-interest', '/tx/claim-interest', post({ ...txBody, agentId: '1' }));

    log('\n[4] Validation edge cases (expect 4xx)');
    await test('POST /tx/request-loan with invalid duration', '/tx/request-loan', post({ ...txBody, amount: '5000000', durationDays: '5' })); // <7
    await test('POST /tx/request-loan with duration too big', '/tx/request-loan', post({ ...txBody, amount: '5000000', durationDays: '500' })); // >365
    await test('POST /tx/request-loan with no body', '/tx/request-loan', post({}));

    log('\n[5] End-to-end: take /tx/supply-liquidity response, sign + broadcast');
    // First create a real test agent
    const provider = new ethers.JsonRpcProvider(RPC);
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const testWallet = ethers.Wallet.createRandom().connect(provider);
    fs.writeFileSync('./forensics/output/regression-2026-05-07/72-api-wallet.json', JSON.stringify({ addr: testWallet.address, key: testWallet.privateKey }, null, 2));
    await owner.sendTransaction({ to: testWallet.address, value: ethers.parseEther('0.1') }).then(t => t.wait());
    const usdc = new ethers.Contract(ADDR.usdc, ['function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)'], owner);
    await usdc.transfer(testWallet.address, ethers.parseUnits('100', 6)).then(t => t.wait());

    // Test wallet approves marketplace
    const usdcW = new ethers.Contract(ADDR.usdc, ['function approve(address,uint256) returns (bool)'], testWallet);
    await usdcW.approve(ADDR.agentLiquidityMarketplace, ethers.MaxUint256).then(t => t.wait());

    // Now use the tx-builder
    const supplyR = await fetchJson('/tx/supply-liquidity', post({ ...txBody, agentId: '1', amount: '1000000' }));
    log(`  /tx/supply-liquidity response: to=${supplyR.json?.to}, data=${supplyR.json?.data?.slice(0, 18)}...`);
    if (supplyR.json && supplyR.json.to && supplyR.json.data) {
        try {
            // Sign and broadcast
            const tx = await testWallet.sendTransaction({ to: supplyR.json.to, data: supplyR.json.data, value: supplyR.json.value || 0n });
            log(`  ✓ tx sent: ${tx.hash}`);
            const r = await tx.wait();
            log(`  ✓ tx confirmed in block ${r.blockNumber}, gas ${r.gasUsed}, status=${r.status}`);
            results.push({ name: 'E2E sign+broadcast', txHash: tx.hash, blockNumber: r.blockNumber, gasUsed: r.gasUsed.toString(), ok: r.status === 1 });
        } catch (e) {
            log(`  ✗ tx submission/exec failed: ${(e.shortMessage || e.message).slice(0, 150)}`);
            results.push({ name: 'E2E sign+broadcast', error: (e.shortMessage || e.message).slice(0, 150), ok: false });
        }
    }

    // Cleanup
    try { const usdcT = new ethers.Contract(ADDR.usdc, ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)'], testWallet); const bal = await usdcT.balanceOf(testWallet.address); if (bal > 0n) await (await usdcT.transfer(owner.address, bal)).wait(); } catch (e) {}

    api.kill('SIGTERM');
    const passed = results.filter(r => r.ok).length;
    log(`\n=== ${passed}/${results.length} endpoint checks passed ===`);
    fs.writeFileSync('./forensics/output/regression-2026-05-07/72-api-smoke.json', JSON.stringify({
        timestamp: new Date().toISOString(), apiPort: API_PORT, results, passed, total: results.length
    }, null, 2));
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
