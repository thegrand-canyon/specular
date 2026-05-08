// Full-stack integration test: SDK pattern → API tx-builder → Arc V6 broadcast.
//
// Spawns local API, hits the new POST /tx/* endpoints, then signs + broadcasts
// the returned calldata against V6 (overriding the `to` field since V6 has the
// same function selectors as v4 — proves end-to-end stack works).

require('dotenv').config();
const { ethers } = require('ethers');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const API_PORT = 3098;
const API_URL = `http://127.0.0.1:${API_PORT}`;
const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6_ADDR = ADDR.agentLiquidityMarketplace_v6;
const V6_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const USDC_ABI = ['function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)', 'function balanceOf(address) view returns (uint256)'];

const OUT = './forensics/output/regression-2026-05-07';
const fmt = v => Number(ethers.formatUnits(v, 6));

async function waitForApi() {
    for (let i = 0; i < 60; i++) {
        try {
            const r = await fetch(`${API_URL}/health?network=arc`);
            if (r.status < 500) return;
        } catch {}
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('API never started');
}

const events = [];
const log = (...a) => { console.log(...a); events.push(a.map(String).join(' ')); };

async function txBuilderRequest(method, body) {
    const r = await fetch(`${API_URL}/tx/${method}?network=arc`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    const data = await r.json();
    if (r.status !== 200) throw new Error(`API ${method} failed: ${data.error}`);
    return data;
}

async function signSendV6(wallet, txData) {
    // Override `to` from v4 to V6 (calldata is compatible)
    const tx = await wallet.sendTransaction({ to: V6_ADDR, data: txData.data });
    log('  tx:', tx.hash, '(via API method:', txData.method + ')');
    const receipt = await tx.wait();
    log('  mined block', receipt.blockNumber, 'gas', receipt.gasUsed.toString());
    return receipt;
}

(async () => {
    log('Spawning API on port', API_PORT);
    const apiProc = spawn('node', ['src/api/MultiNetworkAPI.js'], {
        env: { ...process.env, PORT: String(API_PORT), ENABLE_CACHE: 'false' },
        stdio: ['ignore', 'ignore', 'ignore'],
    });

    try {
        await waitForApi();
        log('API ready.');

        const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
        const v6 = new ethers.Contract(V6_ADDR, V6_ABI, wallet);
        const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, wallet);

        log('Wallet:', wallet.address);
        log('V6:', V6_ADDR);

        const SELF_AGENT = 49n;
        const SUPPLY = ethers.parseUnits('2', 6);
        const LOAN = ethers.parseUnits('1', 6);

        // Pre-state
        const preBal = await usdc.balanceOf(wallet.address);
        const prePool = await v6.getAgentPool(SELF_AGENT);
        log(`PRE: wallet ${fmt(preBal)} USDC, pool avail ${fmt(prePool[2])}`);

        // Approve USDC
        const allowance = await usdc.allowance(wallet.address, V6_ADDR);
        if (allowance < ethers.parseUnits('5', 6)) {
            log('\n[setup] approve V6 for 5 USDC');
            const tx = await usdc.approve(V6_ADDR, ethers.parseUnits('5', 6));
            await tx.wait();
            log('  approved');
        }

        // ---- 1. Supply via API ----
        log('\n[1] SDK→API: /tx/supply-liquidity { agentId:49, amount:2 USDC }');
        const supplyTx = await txBuilderRequest('supply-liquidity', { agentId: 49, amount: SUPPLY.toString() });
        log('  to:', supplyTx.to, '(v4) — overriding to V6:', V6_ADDR);
        log('  calldata length:', (supplyTx.data.length - 2) / 2, 'bytes');
        await signSendV6(wallet, supplyTx);

        // ---- 2. Request loan via API ----
        log('\n[2] SDK→API: /tx/request-loan { amount:1 USDC, durationDays:7 }');
        const loanReq = await txBuilderRequest('request-loan', { amount: LOAN.toString(), durationDays: 7 });
        const receipt = await signSendV6(wallet, loanReq);
        // Find loanId from events
        const iface = new ethers.Interface(V6_ABI);
        let loanId;
        for (const lg of receipt.logs) {
            try {
                const parsed = iface.parseLog(lg);
                if (parsed && parsed.name === 'LoanRequested') { loanId = parsed.args.loanId; break; }
            } catch {}
        }
        log('  loanId:', loanId.toString());

        // ---- 3. Repay via API ----
        log('\n[3] SDK→API: /tx/repay-loan { loanId }');
        const repayReq = await txBuilderRequest('repay-loan', { loanId: loanId.toString() });
        await signSendV6(wallet, repayReq);

        // ---- 4. Claim interest via API ----
        const pos = await v6.positions(SELF_AGENT, wallet.address);
        if (pos[1] > 0n) {
            log('\n[4] SDK→API: /tx/claim-interest { agentId:49 }');
            const claimReq = await txBuilderRequest('claim-interest', { agentId: 49 });
            await signSendV6(wallet, claimReq);
        }

        // ---- 5. Withdraw via API ----
        const myPos = await v6.positions(SELF_AGENT, wallet.address);
        if (myPos[0] > 0n) {
            log('\n[5] SDK→API: /tx/withdraw-liquidity { agentId:49, amount }');
            const wReq = await txBuilderRequest('withdraw-liquidity', { agentId: 49, amount: myPos[0].toString() });
            await signSendV6(wallet, wReq);
        }

        // Post-state
        const postBal = await usdc.balanceOf(wallet.address);
        const postPool = await v6.getAgentPool(SELF_AGENT);
        log(`\nPOST: wallet ${fmt(postBal)} USDC, pool avail ${fmt(postPool[2])}`);
        log(`net wallet change: ${(fmt(postBal) - fmt(preBal)).toFixed(6)} USDC`);

        // §B1 invariant check
        const lc = Number(postPool[6]);
        const lenders = [];
        for (let j = 0; j < lc; j++) lenders.push((await v6.poolLenders(SELF_AGENT, j)).toLowerCase());
        const unique = new Set(lenders);
        log(`\nfinal lenderCount: ${lc}, unique: ${unique.size} ${lc === unique.size ? '✅ no duplicates' : '❌ duplicate detected'}`);

        fs.writeFileSync(path.join(OUT, '22-sdk-api-v6-integration.json'),
            JSON.stringify({
                walletPre: fmt(preBal), walletPost: fmt(postBal),
                poolPre: fmt(prePool[2]), poolPost: fmt(postPool[2]),
                lenderCount: lc, uniqueLenders: unique.size,
                events,
            }, null, 2));
        log('\nSaved.');
    } finally {
        apiProc.kill('SIGTERM');
        log('API stopped.');
    }
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
