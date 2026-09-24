#!/usr/bin/env node
//
// LENDER-HARM detector. READ-ONLY. Sends no transactions.
//
// Why this exists, and why it is separate from v6-invariants.js:
//
//   The 2026-09-25 red team ran a full bust-out — a borrower reaching the 0%-collateral
//   tier and walking away — and the accounting stayed PERFECT. Per-pool conservation
//   delta 0, global solvency exact, every invariant green, exit 0. Lenders lost real
//   money and NOTHING alerted.
//
//   That is not a bug in the invariant monitor; it is the difference between two
//   questions. The invariant monitor asks "do the books balance?". Nobody was asking
//   "did somebody get hurt?". A default is a legitimate state transition that keeps the
//   books balanced by design — the loss is socialised, so the sums still agree.
//
// This watches for the events that mean a lender lost money, and pages on them:
//   LoanDefaulted(loanId)                              a loan was written off
//   SelfStakeAbsorbedLoss(agentId, agent, amount)      M2 first-loss stake was seized
//   InterestLossSocialized(agentId, interestReduced)   loss exceeded principal and ate interest
//
// Exit: 0 nothing new · 1 lender harm detected in the window · 2 could not complete.
//
// Usage:
//   V6_MONITOR_NETWORK=arc-mainnet node forensics/monitor/check-lender-harm.js
//   V6_MONITOR_LOOKBACK_BLOCKS=50000 ... (default: since the last run, else 20k blocks)
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const NETS = {
    'arc-mainnet': { file: 'src/config/arc-mainnet-addresses.json', env: 'ARC_MAINNET_RPC_URL', rpc: 'https://rpc.mainnet.arc.io' },
    'arc-staging': { file: 'src/config/arc-testnet-v6-addresses.json', env: 'ARC_TESTNET_RPC_URL', rpc: 'https://rpc.testnet.arc.io' },
    'base': { file: 'src/config/base-addresses.json', env: 'SPECULAR_RPC_BASE', rpc: 'https://mainnet.base.org', mpKey: 'agentLiquidityMarketplace' },
    'local': { file: 'src/config/local-addresses.json', env: 'LOCAL_RPC_URL', rpc: 'http://127.0.0.1:8545' },
};
const NET = process.env.V6_MONITOR_NETWORK || 'arc-mainnet';
const cfg = NETS[NET];
if (!cfg) { console.error(`unknown network "${NET}"; expected one of ${Object.keys(NETS).join(', ')}`); process.exit(2); }

const A = JSON.parse(fs.readFileSync(path.join(ROOT, cfg.file), 'utf8'));
const RPC = process.env[cfg.env] || A.rpcUrl || cfg.rpc;
const MP = process.env.V6_MONITOR_MARKETPLACE || A[cfg.mpKey || 'agentLiquidityMarketplace_v6'];
if (!MP) { console.error(`no marketplace address in ${cfg.file}`); process.exit(2); }

const STATE = path.join(__dirname, `lender-harm-${NET}.state.json`);
const DEFAULT_LOOKBACK = Number(process.env.V6_MONITOR_LOOKBACK_BLOCKS || 20000);

// Only the three events matter; declare them directly so this works against any generation
// (older deployments simply never emit the V6.2-only ones).
const ABI = [
    'event LoanDefaulted(uint256 loanId)',
    'event SelfStakeAbsorbedLoss(uint256 agentId, address agentAddress, uint256 amount)',
    'event InterestLossSocialized(uint256 agentId, uint256 interestReduced)',
];
const usdc = (v) => ethers.formatUnits(v, 6);

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1, staticNetwork: true });
    const head = await provider.getBlockNumber();
    let from;
    try { from = JSON.parse(fs.readFileSync(STATE, 'utf8')).lastScannedBlock + 1; } catch { from = Math.max(0, head - DEFAULT_LOOKBACK); }
    if (from > head) from = head;       // chain reorg / fresh node

    const mp = new ethers.Contract(MP, ABI, provider);
    const findings = [];
    for (const name of ['LoanDefaulted', 'SelfStakeAbsorbedLoss', 'InterestLossSocialized']) {
        let logs = [];
        try { logs = await mp.queryFilter(mp.filters[name](), from, head); } catch { /* event absent on this generation */ }
        for (const l of logs) {
            const a = l.args || {};
            findings.push({
                event: name, block: l.blockNumber, tx: l.transactionHash,
                ...(a.loanId !== undefined ? { loanId: Number(a.loanId) } : {}),
                ...(a.agentId !== undefined ? { agentId: Number(a.agentId) } : {}),
                ...(a.amount !== undefined ? { seizedUsdc: usdc(a.amount) } : {}),
                ...(a.interestReduced !== undefined ? { interestLostUsdc: usdc(a.interestReduced) } : {}),
            });
        }
    }

    const out = {
        network: NET, marketplace: MP, scannedFrom: from, scannedTo: head,
        lenderHarmEvents: findings.length, findings,
        action: findings.length
            ? 'Lenders lost money. The books will still balance - a default keeps conservation exact by design. Identify the agent, check whether more loans are open to it, and consider registry.deactivateAgent on that agent (NOT pause, which freezes every lender exit).'
            : 'nothing to do',
    };
    console.log(JSON.stringify(out, null, 2));
    try { fs.writeFileSync(STATE, JSON.stringify({ lastScannedBlock: head, ts: new Date().toISOString() }, null, 2)); } catch {}
    process.exit(findings.length ? 1 : 0);
})().catch((e) => { console.error('READ FAILED:', e.shortMessage || e.message); process.exit(2); });
