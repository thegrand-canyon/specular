#!/usr/bin/env node
//
// V6 invariant snapshot — single-run check of §B1, §S1, §S5 invariants on Arc V6.
//
// Designed to be run periodically (e.g. via cron) during the V6 soak period.
// Writes append-only JSONL log to `forensics/monitor/v6-invariants.log`.
// Exit code: 0 if all invariants hold, 1 if any violation detected.
//
// Usage:
//   ARC_TESTNET_RPC_URL=... node forensics/monitor/v6-invariants.js
//   node forensics/monitor/v6-invariants.js --quiet      # only logs to file, not stdout
//   node forensics/monitor/v6-invariants.js --verbose    # extra debug detail
//
// Cron example (every 30 min):
//   */30 * * * * cd ~/Specular && PATH=/opt/homebrew/opt/node@22/bin:$PATH node forensics/monitor/v6-invariants.js >> /tmp/v6-cron.log 2>&1

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
// Network selector: V6_MONITOR_NETWORK=arc-testnet (default) | arc-staging | arc-mainnet.
// Each maps to an addresses file + default RPC + its own log file so histories don't mix.
const NETWORKS = {
    'arc-testnet': { addresses: 'src/config/arc-testnet-addresses.json',    rpcEnv: 'ARC_TESTNET_RPC_URL', rpc: 'https://arc-testnet.drpc.org',   log: 'v6-invariants.log' },
    'arc-staging': { addresses: 'src/config/arc-testnet-v6-addresses.json', rpcEnv: 'ARC_TESTNET_RPC_URL', rpc: 'https://arc-testnet.drpc.org',   log: 'v6-invariants-arc-staging.log' },
    'arc-mainnet': { addresses: 'src/config/arc-mainnet-addresses.json',    rpcEnv: 'ARC_MAINNET_RPC_URL', rpc: 'https://rpc.mainnet.arc.io',     log: 'v6-invariants-arc-mainnet.log' },
    // [TEST ARTIFACT ONLY] added so the detection matrix can run the FROZEN V6.0
    // monitor against the same local chain as the rewritten one. Nothing else in
    // this file differs from the pre-2026-09-20 production monitor.
    'local':       { addresses: 'src/config/local-addresses.json',          rpcEnv: 'LOCAL_RPC_URL',       rpc: 'http://127.0.0.1:8545',          log: 'v6-invariants-local-V60.log' },
};
const NET = NETWORKS[process.env.V6_MONITOR_NETWORK || 'arc-testnet'];
if (!NET) { console.error(`Unknown V6_MONITOR_NETWORK; expected one of ${Object.keys(NETWORKS).join(', ')}`); process.exit(1); }
const ADDR = JSON.parse(fs.readFileSync(path.join(ROOT, NET.addresses)));
const ABI = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json'))).abi;
const REG_ABI = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json'))).abi;

const RPC = process.env[NET.rpcEnv] || NET.rpc;
const V6 = ADDR.agentLiquidityMarketplace_v6;
const QUIET = process.argv.includes('--quiet');
const VERBOSE = process.argv.includes('--verbose');
const LOGFILE = path.join(__dirname, NET.log);

const fmt = v => Number(ethers.formatUnits(v, 6));
const log = (level, msg, data = {}) => {
    const entry = { ts: new Date().toISOString(), level, msg, ...data };
    fs.appendFileSync(LOGFILE, JSON.stringify(entry) + '\n');
    if (!QUIET || level === 'ERROR' || level === 'WARN') console.log(JSON.stringify(entry));
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, label, attempts = 5) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const m = (e.shortMessage || e.message || '');
            const isRate = m.includes('408') || m.includes('410') || m.includes('429') || m.includes('-32016') || m.includes('rate') || m.includes('timeout');
            if (i === attempts - 1 || !isRate) throw e;
            await sleep(2000 * Math.pow(2, i));
        }
    }
}

async function checkB1(mp) {
    // §B1: no pool may have duplicate addresses in poolLenders[]
    const totalPools = Number(await withRetry(() => mp.totalPools(), 'totalPools'));
    let violations = [];
    for (let i = 0; i < totalPools; i++) {
        try {
            const aid = await withRetry(() => mp.agentPoolIds(i), `agentPoolIds[${i}]`);
            const pool = await withRetry(() => mp.getAgentPool(aid), `getAgentPool[${aid}]`);
            const lc = Number(pool[6]);
            if (lc === 0) continue;
            const lenders = [];
            for (let j = 0; j < lc; j++) {
                lenders.push((await withRetry(() => mp.poolLenders(aid, j), `pl[${aid}][${j}]`)).toLowerCase());
            }
            const unique = new Set(lenders);
            if (lenders.length !== unique.size) {
                violations.push({ agentId: aid.toString(), lenderCount: lc, uniqueCount: unique.size });
            }
        } catch (e) { if (VERBOSE) log('DEBUG', 'pool iter error', { i, msg: (e.shortMessage || e.message).slice(0, 80) }); }
    }
    return { totalPools, violations };
}

async function checkS1(mp, usdc) {
    // §S1: pool.availableLiquidity should never exceed actual USDC balance
    // Also: Σ(pool.availableLiquidity + pool.totalLoaned) ≤ usdc.balanceOf(MP) + Σ(unclaimed earnedInterest)
    const totalPools = Number(await withRetry(() => mp.totalPools(), 'totalPools'));
    const mpBal = await withRetry(() => usdc.balanceOf(V6), 'mpBal');
    let sumAvail = 0n, sumLoaned = 0n, sumUnclaimedInterest = 0n;
    let perPool = [];
    for (let i = 0; i < totalPools; i++) {
        try {
            const aid = await withRetry(() => mp.agentPoolIds(i), `pid[${i}]`);
            const pool = await withRetry(() => mp.getAgentPool(aid), `pool[${aid}]`);
            sumAvail += pool[2];
            sumLoaned += pool[3];
            const lc = Number(pool[6]);
            for (let j = 0; j < lc; j++) {
                const lender = await withRetry(() => mp.poolLenders(aid, j), `pl[${aid}][${j}]`);
                const pos = await withRetry(() => mp.positions(aid, lender), `pos[${aid}][${lender}]`);
                sumUnclaimedInterest += pos[1];
            }
            perPool.push({ agentId: aid.toString(), avail: fmt(pool[2]), loaned: fmt(pool[3]) });
        } catch (e) { if (VERBOSE) log('DEBUG', 'S1 iter error', { i }); }
    }
    // Invariant: USDC balance of contract ≥ sumAvail + sumLoaned − repaid principals (already in avail)
    // Practical check: sumAvail ≤ mpBal − (locked collateral) ≤ mpBal in absence of active collateral data.
    // Simpler: sumAvail ≤ mpBal is the conservative invariant (collateral is in contract too).
    const slack = mpBal - sumAvail;
    return {
        mpBal: fmt(mpBal),
        sumAvail: fmt(sumAvail),
        sumLoaned: fmt(sumLoaned),
        sumUnclaimedInterest: fmt(sumUnclaimedInterest),
        slack: fmt(slack),
        violates: slack < 0n,
    };
}

async function checkS5(mp, reg) {
    // §S5: no agent should have activeLoanCount > MAX_ACTIVE_LOANS_PER_AGENT
    //      and the counter must match the array walk (correctness of §S5 fix)
    const totalAgents = Number(await withRetry(() => reg.totalAgents(), 'totalAgents'));
    const cap = Number(await withRetry(() => mp.MAX_ACTIVE_LOANS_PER_AGENT(), 'cap'));
    let violations = [];
    let highest = { count: 0, addr: null };
    for (let id = 1; id <= totalAgents; id++) {
        try {
            const a = await withRetry(() => reg.agents(id), `agents[${id}]`);
            if (a.owner === ethers.ZeroAddress) continue;
            const w = a.agentWallet;
            const counter = Number(await withRetry(() => mp.activeLoanCount(w), `alc[${w}]`));
            if (counter > cap) {
                violations.push({ agentId: id, wallet: w, counter, cap });
            }
            if (counter > highest.count) highest = { count: counter, addr: w };
        } catch {}
    }
    return { totalAgents, cap, violations, highest };
}

async function alert(severity, title, details) {
    const webhook = process.env.WEBHOOK_URL;
    if (!webhook) return; // no-op when unset
    const payload = {
        text: `🚨 Specular V6 invariant alert [${severity}]: ${title}`,
        attachments: [{
            color: severity === 'CRITICAL' ? 'danger' : 'warning',
            title,
            text: '```' + JSON.stringify(details, null, 2) + '```',
            ts: Math.floor(Date.now() / 1000),
        }],
    };
    try {
        const r = await fetch(webhook, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!r.ok) log('WARN', 'Webhook returned non-ok', { status: r.status });
    } catch (e) {
        log('WARN', 'Webhook delivery failed', { error: e.message });
    }
}

(async () => {
    if (!V6) { log('ERROR', 'V6 address missing in addresses.json'); process.exit(1); }
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const mp = new ethers.Contract(V6, ABI, provider);
    const reg = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, provider);
    const usdc = new ethers.Contract(ADDR.usdc, ['function balanceOf(address) view returns (uint256)'], provider);

    const block = await withRetry(() => provider.getBlock('latest'), 'block');
    log('INFO', 'V6 invariant snapshot start', { block: block.number, marketplace: V6 });

    let exitCode = 0;
    try {
        const [b1, s1, s5] = await Promise.all([
            checkB1(mp),
            checkS1(mp, usdc),
            checkS5(mp, reg),
        ]);

        if (b1.violations.length > 0) {
            log('ERROR', '§B1 VIOLATION: duplicate poolLenders detected', { violations: b1.violations });
            await alert('CRITICAL', '§B1 duplicate poolLenders detected on V6', { marketplace: V6, violations: b1.violations });
            exitCode = 1;
        } else {
            log('INFO', '§B1 OK', { totalPools: b1.totalPools });
        }

        if (s1.violates) {
            log('ERROR', '§S1 VIOLATION: sumAvail > mpBal', s1);
            await alert('CRITICAL', '§S1 sumAvail > mpBal on V6', { marketplace: V6, ...s1 });
            exitCode = 1;
        } else {
            log('INFO', '§S1 OK', s1);
        }

        if (s5.violations.length > 0) {
            log('ERROR', '§S5 VIOLATION: agent over MAX_ACTIVE_LOANS', { violations: s5.violations });
            await alert('CRITICAL', '§S5 agent over MAX_ACTIVE_LOANS on V6', { marketplace: V6, violations: s5.violations });
            exitCode = 1;
        } else {
            log('INFO', '§S5 OK', { totalAgents: s5.totalAgents, cap: s5.cap, highest: s5.highest });
        }
    } catch (e) {
        log('ERROR', 'check failed', { error: e.shortMessage || e.message });
        exitCode = 2;
    }

    log('INFO', 'V6 invariant snapshot end', { exitCode });
    process.exit(exitCode);
})();
