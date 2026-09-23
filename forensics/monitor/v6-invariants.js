#!/usr/bin/env node
//
// V6 invariant snapshot — single-run check of the marketplace's accounting,
// identity and control-plane invariants.
//
// 2026-09-20 REWRITE (operational-resilience round). The V6.0 version checked
// three things (§B1/§S1/§S5) and, as proven on a local hardhat rig with
// engineered violations, MISSED most real failure modes:
//   * §S5 read `activeLoanCount(agentWallet)` — V6.1 keys that mapping by
//     **agentId**, so the call always returned 0 and the check was a no-op.
//   * §S1 only compared Σ availableLiquidity against the contract's USDC balance,
//     so phantom liquidity smaller than the escrowed collateral was invisible.
//   * Nothing checked solvency, per-pool conservation, totalLoaned vs ACTIVE
//     loans, ownership, pause state, or accumulatedFees vs balance.
//   * Nothing checked the V6.1 state at all (pendingTranche, activeLoanIds,
//     qualified amounts, lateness records).
//   * A dead or stalled RPC produced a clean exit-0 "OK" on the previous run's
//     assumptions; block staleness is now an alertable condition.
//
// Checks (each reports OK / VIOLATION with a severity):
//   B1   duplicate addresses in poolLenders[]              CRITICAL
//   S1   Σ availableLiquidity ≤ USDC balance               CRITICAL
//   S5   activeLoanCount ≤ MAX_ACTIVE_LOANS_PER_AGENT      CRITICAL
//        + counter == |ACTIVE loans| == |activeLoanIds|
//   SOLV USDC balance ≥ Σ avail + fees + Σ active collateral   CRITICAL
//        (surplus beyond a threshold → WARN; forced native donations on Arc make
//         strict equality unusable — see audit I-3)
//   POOL per-pool conservation:
//        Σ positions.amount + Σ earnedInterest == availableLiquidity + totalLoaned  CRITICAL
//   LOAN pool.totalLoaned == Σ ACTIVE loan principal == outstandingPrincipal        CRITICAL
//   OWN  owner == expected secure wallet, pendingOwner == 0                          CRITICAL/WARN
//   PAUS paused == expected                                                          CRITICAL
//   FEE  accumulatedFees ≤ USDC balance                                              CRITICAL
//   PT   pendingTranche.amount ≤ position.amount [V6.1]                              CRITICAL
//   QUAL Σ qualifiedAmountAt(loan.startTime) ≤ Σ positions.amount [V6.1]             CRITICAL
//   LATE lateRepayCount/lateSecondsTotal monotonic + consistent with records [V6.1]  WARN/CRITICAL
//   FRESH latest block is recent and strictly newer than the previous run            CRITICAL
//   NFT  agent NFT moved while that agent had an ACTIVE loan (F-01 detector)         WARN
//
// Exit code: 0 all clear · 1 invariant violation · 2 the monitor could not
// complete (RPC failure, stale chain, config error). BOTH non-zero codes are
// incidents: 2 means "we are blind", which is not better than 1.
//
// Alerting: every violation is fanned out through ./alert.js (latch file, home-dir
// flag, macOS banner, append-only history, opt-in SPECULAR_ALERT_WEBHOOK). The
// launchd job should invoke ./run-with-alert.sh, which also alerts on a crash.
//
// Usage:
//   V6_MONITOR_NETWORK=arc-mainnet node forensics/monitor/v6-invariants.js
//   node forensics/monitor/v6-invariants.js --quiet      # only logs to file
//   node forensics/monitor/v6-invariants.js --verbose    # extra debug detail
//   node forensics/monitor/v6-invariants.js --no-alert   # suppress fan-out (tests)
//
// Env:
//   V6_MONITOR_NETWORK      arc-testnet (default) | arc-staging | arc-mainnet | local
//   ARC_MAINNET_RPC_URL / ARC_TESTNET_RPC_URL / LOCAL_RPC_URL
//   V6_EXPECTED_OWNER       expected owner address (default: addresses.json `deployer`)
//   V6_EXPECT_PAUSED        "1" if the contract is intentionally paused (default 0)
//   V6_MAX_BLOCK_AGE_SEC    staleness threshold, 0 disables (default 1800)
//   V6_SURPLUS_WARN_USDC    unexplained-surplus warn threshold (default 1.0)
//   V6_RPC_TIMEOUT_MS       per-request timeout (default 20000)
//   V6_LOG_MAX_BYTES        rotate the JSONL log past this size (default 5 MiB)

const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
// Network selector. Each maps to an addresses file + default RPC + its own log
// file so histories don't mix.
const NETWORKS = {
    'arc-testnet': { addresses: 'src/config/arc-testnet-addresses.json',    rpcEnv: 'ARC_TESTNET_RPC_URL', rpc: 'https://rpc.testnet.arc.io',   log: 'v6-invariants.log' },
    'arc-staging': { addresses: 'src/config/arc-testnet-v6-addresses.json', rpcEnv: 'ARC_TESTNET_RPC_URL', rpc: 'https://rpc.testnet.arc.io',   log: 'v6-invariants-arc-staging.log' },
    'arc-mainnet': { addresses: 'src/config/arc-mainnet-addresses.json',    rpcEnv: 'ARC_MAINNET_RPC_URL', rpc: 'https://rpc.mainnet.arc.io',     log: 'v6-invariants-arc-mainnet.log' },
    // [2026-09-20] Local hardhat target — lets the monitor be exercised against
    // engineered violation states before it is trusted on mainnet. Same code path.
    'local':       { addresses: 'src/config/local-addresses.json',          rpcEnv: 'LOCAL_RPC_URL',       rpc: 'http://127.0.0.1:8545',          log: 'v6-invariants-local.log' },
};
const NETNAME = process.env.V6_MONITOR_NETWORK || 'arc-testnet';
const NET = NETWORKS[NETNAME];
if (!NET) { console.error(`Unknown V6_MONITOR_NETWORK; expected one of ${Object.keys(NETWORKS).join(', ')}`); process.exit(2); }
const ADDR = JSON.parse(fs.readFileSync(path.join(ROOT, NET.addresses)));
// Merge the V6.1 and V6.2 ABIs (dedup by selector-ish key) so one monitor can read
// either generation. V6.2-only calls are still probed defensively — a V6.1 deployment
// simply has no code at those selectors.
const _abiV61 = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json'))).abi;
let _abiV62 = [];
try {
    _abiV62 = JSON.parse(fs.readFileSync(
        path.join(ROOT, 'artifacts/contracts/core/AgentLiquidityMarketplaceV62.sol/AgentLiquidityMarketplaceV62.json'))).abi;
} catch { /* V6.2 not compiled in this checkout — V6.1-only monitoring still works */ }
const _sig = f => `${f.type}:${f.name}:${(f.inputs || []).map(i => i.type).join(',')}`;
const _seen = new Set();
const ABI = [..._abiV61, ..._abiV62].filter(f => { const k = _sig(f); if (_seen.has(k)) return false; _seen.add(k); return true; });
const REG_ABI = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json'))).abi;

const RPC = process.env[NET.rpcEnv] || NET.rpc;
// Which address in the config to watch. Defaults to the canonical pointer, but a
// superseded deployment must not silently stop being monitored just because the
// pointer moved on — it can still hold lender funds and open loans. Example:
//   V6_MONITOR_MARKETPLACE_KEY=agentLiquidityMarketplace_v61_legacy
// or an explicit address via V6_MONITOR_MARKETPLACE.
const MP_KEY = process.env.V6_MONITOR_MARKETPLACE_KEY || 'agentLiquidityMarketplace_v6';
const V6 = process.env.V6_MONITOR_MARKETPLACE || ADDR[MP_KEY];
if (!V6) { console.error(`No marketplace address: key "${MP_KEY}" absent from ${NET.addresses}`); process.exit(2); }
const QUIET = process.argv.includes('--quiet');
const VERBOSE = process.argv.includes('--verbose');
const NO_ALERT = process.argv.includes('--no-alert');
const LOGFILE = path.join(__dirname, NET.log);
const STATEFILE = path.join(__dirname, `state-${NETNAME}.json`);

const EXPECTED_OWNER = (process.env.V6_EXPECTED_OWNER || ADDR.deployer || '').toLowerCase();
const EXPECT_PAUSED = process.env.V6_EXPECT_PAUSED === '1';
const MAX_BLOCK_AGE_SEC = process.env.V6_MAX_BLOCK_AGE_SEC !== undefined ? Number(process.env.V6_MAX_BLOCK_AGE_SEC) : 1800;
const SURPLUS_WARN = BigInt(Math.round(Number(process.env.V6_SURPLUS_WARN_USDC || '1') * 1e6));
const RPC_TIMEOUT_MS = Number(process.env.V6_RPC_TIMEOUT_MS || 20000);
const LOG_MAX_BYTES = Number(process.env.V6_LOG_MAX_BYTES || 5 * 1024 * 1024);
const LOG_KEEP = 5;
// Hard wall-clock budget. launchd will not start the next scheduled run while the
// previous one is alive, so a monitor that blocks on a slow endpoint silently turns
// "checked every 30 minutes" into "checked once, hours ago". Give up loudly instead.
const MAX_RUNTIME_SEC = Number(process.env.V6_MAX_RUNTIME_SEC || 300);

const alerts = NO_ALERT ? null : require('./alert.js');

const fmt = v => Number(ethers.formatUnits(v, 6));

// --- log rotation ------------------------------------------------------------------
// The V6.0 monitor appended for ever: the arc-testnet log reached 1.4 MB over 137
// days with no rotation configured anywhere on the box. Rotate in-process so the
// fix travels with the script instead of depending on newsyslog/logrotate setup.
function rotateIfNeeded() {
    try {
        if (!fs.existsSync(LOGFILE)) return;
        if (fs.statSync(LOGFILE).size < LOG_MAX_BYTES) return;
        for (let i = LOG_KEEP - 1; i >= 1; i--) {
            const from = `${LOGFILE}.${i}`, to = `${LOGFILE}.${i + 1}`;
            if (fs.existsSync(from)) fs.renameSync(from, to);
        }
        fs.renameSync(LOGFILE, `${LOGFILE}.1`);
    } catch { /* rotation must never block a check */ }
}

const log = (level, msg, data = {}) => {
    const entry = { ts: new Date().toISOString(), level, msg, net: NETNAME, ...data };
    try { fs.appendFileSync(LOGFILE, JSON.stringify(entry) + '\n'); } catch {}
    if (!QUIET || level === 'ERROR' || level === 'WARN') console.log(JSON.stringify(entry));
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, label, attempts = 5) {
    for (let i = 0; i < attempts; i++) {
        try {
            return await Promise.race([
                fn(),
                new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${RPC_TIMEOUT_MS}ms (${label})`)), RPC_TIMEOUT_MS)),
            ]);
        } catch (e) {
            const m = (e.shortMessage || e.message || '');
            const isRetryable = m.includes('408') || m.includes('410') || m.includes('429') || m.includes('-32016')
                || m.includes('rate') || m.includes('timeout') || m.includes('ECONNREFUSED') || m.includes('ENOTFOUND')
                || m.includes('SERVER_ERROR') || m.includes('network');
            if (i === attempts - 1 || !isRetryable) throw e;
            await sleep(1000 * Math.pow(2, i));
        }
    }
}

// Findings accumulator. A check that cannot be evaluated is itself a finding —
// silently skipping is how a monitor reports a false OK.
const findings = [];
const violate = (severity, code, msg, data) => { findings.push({ severity, code, msg, data }); };

// -----------------------------------------------------------------------------------
// Snapshot: read everything once, then evaluate invariants over the snapshot.
// -----------------------------------------------------------------------------------
async function snapshot(mp, reg, usdc) {
    const totalPools = Number(await withRetry(() => mp.totalPools(), 'totalPools'));
    const nextLoanId = Number(await withRetry(() => mp.nextLoanId(), 'nextLoanId'));
    const mpBal = await withRetry(() => usdc.balanceOf(V6), 'mpBal');
    const fees = await withRetry(() => mp.accumulatedFees(), 'accumulatedFees');
    const owner = await withRetry(() => mp.owner(), 'owner');
    let pendingOwner = ethers.ZeroAddress;
    try { pendingOwner = await withRetry(() => mp.pendingOwner(), 'pendingOwner'); } catch {}
    const paused = await withRetry(() => mp.paused(), 'paused');
    const cap = Number(await withRetry(() => mp.MAX_ACTIVE_LOANS_PER_AGENT(), 'cap'));

    // Loans (nextLoanId is monotonic and small on every live deployment; this is a
    // full walk on purpose — the totalLoaned/activeLoanIds checks need ground truth).
    const loans = [];
    for (let id = 1; id < nextLoanId; id++) {
        const l = await withRetry(() => mp.loans(id), `loans[${id}]`);
        // `repayments` is V6.1+. The oldest live deployment (Arc testnet v4/V6.0) has no
        // such selector, and an unguarded call aborted the WHOLE run with "missing revert
        // data" — turning a supported target into a monitor that cried CRITICAL every 30
        // minutes. A noisy monitor is a monitor people learn to ignore.
        let rec = null;
        try { rec = await withRetry(() => mp.repayments(id), `repayments[${id}]`); } catch {}
        loans.push({
            id, borrower: l.borrower, agentId: l.agentId, amount: l.amount,
            collateral: l.collateralAmount, startTime: l.startTime, endTime: l.endTime,
            duration: l.duration, state: Number(l.state),
            repaidAt: rec ? rec.repaidAt : 0n, interestPaid: rec ? rec.interestPaid : 0n,
            lateSeconds: rec ? rec.lateSeconds : 0n, hasRepaymentRecord: rec !== null,
        });
    }

    const pools = [];
    for (let i = 0; i < totalPools; i++) {
        const aid = await withRetry(() => mp.agentPoolIds(i), `agentPoolIds[${i}]`);
        const p = await withRetry(() => mp.getAgentPool(aid), `getAgentPool[${aid}]`);
        const lenderCount = Number(p[6]);
        const lenders = [];
        for (let j = 0; j < lenderCount; j++) {
            const addr = await withRetry(() => mp.poolLenders(aid, j), `poolLenders[${aid}][${j}]`);
            const pos = await withRetry(() => mp.positions(aid, addr), `positions[${aid}][${addr}]`);
            let pt = null;   // V6.1+
            try { pt = await withRetry(() => mp.pendingTranche(aid, addr), `pendingTranche[${aid}][${addr}]`); } catch {}
            lenders.push({
                index: j, address: addr,
                amount: pos.amount, earnedInterest: pos.earnedInterest, depositTimestamp: pos.depositTimestamp,
                pendingAmount: pt ? pt.amount : 0n, pendingTimestamp: pt ? pt.timestamp : 0n,
            });
        }
        pools.push({
            agentId: aid, agentAddress: p[0],
            totalLiquidity: p[1], availableLiquidity: p[2], totalLoaned: p[3], totalEarned: p[4],
            lenderCount, lenders,
            // All V6.1+. Guarded so the monitor degrades to the checks the deployment
            // actually supports instead of failing shut. `generation` records what it got.
            activeLoanCount: await withRetry(() => mp.activeLoanCount(aid), `activeLoanCount[${aid}]`).catch(() => null),
            outstandingPrincipal: await withRetry(() => mp.outstandingPrincipal(aid), `outstandingPrincipal[${aid}]`).catch(() => null),
            activeLoanIds: await withRetry(() => mp.getActiveLoanIds(aid), `activeLoanIds[${aid}]`).then(v => v.map(x => Number(x))).catch(() => null),
            lateRepayCount: await withRetry(() => mp.lateRepayCount(aid), `lateRepayCount[${aid}]`).catch(() => null),
            lateSecondsTotal: await withRetry(() => mp.lateSecondsTotal(aid), `lateSecondsTotal[${aid}]`).catch(() => null),
        });
        // [V6.2/M2] Self-stake. Absent on V6.1 — leave undefined and the check skips.
        const last = pools[pools.length - 1];
        try {
            const ss = await withRetry(() => mp.selfStake(aid), `selfStake[${aid}]`);
            last.selfStake = { amount: ss.amount ?? ss[0], locked: ss.locked ?? ss[1] };
            last.requiredSelfStake = await withRetry(() => mp.requiredSelfStake(aid, 0n), `requiredSelfStake[${aid}]`);
        } catch { /* V6.1 deployment */ }
    }

    let totalAgents = 0;
    try { totalAgents = Number(await withRetry(() => reg.totalAgents(), 'totalAgents')); } catch {}

    // [V7] Credit policy from the reputation manager. Absent on V3 — the checks skip.
    let creditPolicy;
    try {
        const repAddr = await withRetry(() => mp.reputationManager(), 'reputationManager');
        const rep = new ethers.Contract(repAddr, [
            'function tierLimits(uint256) view returns (uint256)',
            'function MAX_TIER_LIMIT() view returns (uint256)',
            'function creditMultiple() view returns (uint256)',
            'function growthStep() view returns (uint256)',
            'function bootstrapLimit() view returns (uint256)',
            'function defaultLockout() view returns (uint256)',
            'function calculateCreditLimit(address) view returns (uint256)',
        ], mp.runner);
        const maxTierLimit = (await withRetry(() => rep.MAX_TIER_LIMIT(), 'MAX_TIER_LIMIT')).toString();
        const tierLimits = [];
        for (let i = 0; i < 6; i++) tierLimits.push((await withRetry(() => rep.tierLimits(i), `tierLimits[${i}]`)).toString());
        const agentLimits = [];
        for (const p of pools) {
            try { agentLimits.push({ agentId: p.agentId.toString(), creditLimit: (await rep.calculateCreditLimit(p.agentAddress)).toString() }); } catch {}
        }
        creditPolicy = {
            reputationManager: repAddr, maxTierLimit, tierLimits,
            creditMultiple: (await withRetry(() => rep.creditMultiple(), 'creditMultiple')).toString(),
            growthStep: (await withRetry(() => rep.growthStep(), 'growthStep')).toString(),
            bootstrapLimit: (await withRetry(() => rep.bootstrapLimit(), 'bootstrapLimit')).toString(),
            defaultLockout: (await withRetry(() => rep.defaultLockout(), 'defaultLockout')).toString(),
            agentLimits,
        };
    } catch { /* ReputationManagerV3: no tier table on chain */ }

    return { totalPools, nextLoanId, mpBal, fees, owner, pendingOwner, paused, cap, loans, pools, totalAgents, creditPolicy };
}

// -----------------------------------------------------------------------------------
// Invariants
// -----------------------------------------------------------------------------------

function checkB1(s) {
    const v = [];
    for (const p of s.pools) {
        const addrs = p.lenders.map(l => l.address.toLowerCase());
        const uniq = new Set(addrs);
        if (addrs.length !== uniq.size) {
            const dupes = addrs.filter((a, i) => addrs.indexOf(a) !== i);
            v.push({ agentId: p.agentId.toString(), lenderCount: addrs.length, uniqueCount: uniq.size, duplicates: [...new Set(dupes)] });
        }
    }
    if (v.length) violate('CRITICAL', 'B1', '§B1 VIOLATION: duplicate poolLenders detected', { violations: v });
    return { totalPools: s.totalPools, violations: v };
}

function checkS1(s) {
    let sumAvail = 0n, sumLoaned = 0n, sumUnclaimed = 0n, sumPositions = 0n;
    for (const p of s.pools) {
        sumAvail += p.availableLiquidity; sumLoaned += p.totalLoaned;
        for (const l of p.lenders) { sumUnclaimed += l.earnedInterest; sumPositions += l.amount; }
    }
    const slack = s.mpBal - sumAvail;
    const r = {
        mpBal: fmt(s.mpBal), sumAvail: fmt(sumAvail), sumLoaned: fmt(sumLoaned),
        sumUnclaimedInterest: fmt(sumUnclaimed), sumPositions: fmt(sumPositions), slack: fmt(slack),
        violates: slack < 0n,
    };
    if (r.violates) violate('CRITICAL', 'S1', '§S1 VIOLATION: Σ availableLiquidity > USDC balance (phantom liquidity)', r);
    return { ...r, sumAvailRaw: sumAvail, sumLoanedRaw: sumLoaned };
}

// SOLVENCY — the check the V6.0 monitor never had. §S1 alone is masked by escrowed
// collateral: phantom liquidity smaller than Σ collateral keeps `sumAvail ≤ mpBal`
// true. The real identity is
//     balance == Σ availableLiquidity + accumulatedFees + Σ ACTIVE-loan collateral
// (loaned principal has left the contract; unclaimed interest lives inside
// availableLiquidity). `<` is insolvency. `>` is an unexplained surplus — on Arc a
// forced native donation can cause it (audit I-3), so it warns rather than pages.
function checkSolvency(s) {
    let sumAvail = 0n, sumCollateral = 0n;
    for (const p of s.pools) sumAvail += p.availableLiquidity;
    for (const l of s.loans) if (l.state === 1) sumCollateral += l.collateral;
    const expected = sumAvail + s.fees + sumCollateral;
    const delta = s.mpBal - expected;
    const r = {
        mpBal: fmt(s.mpBal), sumAvail: fmt(sumAvail), fees: fmt(s.fees),
        sumActiveCollateral: fmt(sumCollateral), expected: fmt(expected), delta: fmt(delta),
    };
    if (delta < 0n) violate('CRITICAL', 'SOLV', 'INSOLVENT: USDC balance < Σ availableLiquidity + fees + active collateral', r);
    else if (delta > SURPLUS_WARN) violate('WARN', 'SOLV-SURPLUS', 'Unexplained USDC surplus in marketplace (donation? untracked inflow?)', r);
    return r;
}

// Per-pool conservation. Every state transition moves the same value on both sides:
//     Σ positions.amount + Σ earnedInterest == availableLiquidity + totalLoaned
// LHS > RHS means lenders collectively claim more than the pool holds (the shape a
// real §S1/D4 accounting bug takes inside a single pool, even when global solvency
// still looks fine because of collateral).
function checkPoolConservation(s) {
    const rows = [];
    for (const p of s.pools) {
        let claims = 0n;
        for (const l of p.lenders) claims += l.amount + l.earnedInterest;
        const backing = p.availableLiquidity + p.totalLoaned;
        const delta = backing - claims;
        const row = { agentId: p.agentId.toString(), claims: fmt(claims), backing: fmt(backing), delta: fmt(delta) };
        rows.push(row);
        if (delta < 0n) violate('CRITICAL', 'POOL', 'Pool conservation VIOLATION: Σ lender claims > availableLiquidity + totalLoaned', row);
        else if (delta > 0n) violate('WARN', 'POOL-SLACK', 'Pool holds more than lenders claim (orphaned liquidity)', row);
    }
    return rows;
}

// totalLoaned / outstandingPrincipal vs the actual ACTIVE loans.
function checkLoanAccounting(s) {
    const byAgent = new Map();
    for (const l of s.loans) {
        if (l.state !== 1) continue;
        const k = l.agentId.toString();
        const cur = byAgent.get(k) || { sum: 0n, ids: [] };
        cur.sum += l.amount; cur.ids.push(l.id);
        byAgent.set(k, cur);
    }
    const rows = [];
    const skipped = [];
    for (const p of s.pools) {
        const k = p.agentId.toString();
        const actual = byAgent.get(k) || { sum: 0n, ids: [] };
        // `outstandingPrincipal` / `activeLoanCount` / `activeLoanIds` are V6.1+. On an
        // older deployment they read null. Record the pool as SKIPPED rather than
        // substituting a value derived from the same loan walk the check compares against
        // — that would make the assertion pass while proving nothing, which is worse than
        // an honest gap. The totalLoaned check below still runs for these pools.
        const preV61 = p.outstandingPrincipal === null || p.activeLoanCount === null || p.activeLoanIds === null;
        if (preV61) {
            skipped.push(k);
            if (p.totalLoaned !== actual.sum) {
                violate('CRITICAL', 'LOAN-TOTAL', 'pool.totalLoaned disagrees with Σ ACTIVE loan principal',
                    { agentId: k, poolTotalLoaned: fmt(p.totalLoaned), sumActiveLoans: fmt(actual.sum), generation: 'pre-V6.1' });
            }
            rows.push({ agentId: k, generation: 'pre-V6.1 — V6.1 loan-accounting checks skipped',
                poolTotalLoaned: fmt(p.totalLoaned), sumActiveLoans: fmt(actual.sum) });
            continue;
        }
        const row = {
            agentId: k,
            poolTotalLoaned: fmt(p.totalLoaned), sumActiveLoans: fmt(actual.sum),
            outstandingPrincipal: fmt(p.outstandingPrincipal),
            activeLoanCount: Number(p.activeLoanCount), actualActiveLoans: actual.ids.length,
            activeLoanIds: p.activeLoanIds, actualActiveLoanIds: actual.ids,
        };
        rows.push(row);
        if (p.totalLoaned !== actual.sum) violate('CRITICAL', 'LOAN-TOTAL', 'pool.totalLoaned disagrees with Σ ACTIVE loan principal', row);
        if (p.outstandingPrincipal !== actual.sum) violate('CRITICAL', 'LOAN-OUTSTANDING', 'outstandingPrincipal disagrees with Σ ACTIVE loan principal', row);
        // §S5: counter correctness AND the cap
        if (Number(p.activeLoanCount) !== actual.ids.length) violate('CRITICAL', 'S5-COUNTER', '§S5 VIOLATION: activeLoanCount disagrees with the actual ACTIVE loans', row);
        if (Number(p.activeLoanCount) > s.cap) violate('CRITICAL', 'S5-CAP', '§S5 VIOLATION: activeLoanCount above MAX_ACTIVE_LOANS_PER_AGENT', { ...row, cap: s.cap });
        // [V6.1] activeLoanIds must be exactly the ACTIVE set — no stale, no missing, no dupes
        const idSet = new Set(p.activeLoanIds);
        const missing = actual.ids.filter(i => !idSet.has(i));
        const stale = p.activeLoanIds.filter(i => !actual.ids.includes(i));
        if (idSet.size !== p.activeLoanIds.length || missing.length || stale.length) {
            violate('CRITICAL', 'ALI', '[V6.1] activeLoanIds inconsistent with the actual ACTIVE loan set', { ...row, missing, stale, hasDuplicates: idSet.size !== p.activeLoanIds.length });
        }
        if (p.activeLoanIds.length !== Number(p.activeLoanCount)) {
            violate('CRITICAL', 'ALI-LEN', '[V6.1] activeLoanIds length != activeLoanCount', row);
        }
    }
    // A loan whose agent has no pool at all
    const poolIds = new Set(s.pools.map(p => p.agentId.toString()));
    for (const [k, v] of byAgent) if (!poolIds.has(k)) violate('CRITICAL', 'LOAN-ORPHAN', 'ACTIVE loans against an agent with no pool', { agentId: k, loanIds: v.ids });
    return rows;
}

function checkControlPlane(s) {
    const r = { owner: s.owner, expectedOwner: EXPECTED_OWNER, pendingOwner: s.pendingOwner, paused: s.paused, expectPaused: EXPECT_PAUSED };
    if (!EXPECTED_OWNER) {
        violate('WARN', 'OWN-UNKNOWN', 'No expected owner configured (set V6_EXPECTED_OWNER) — ownership cannot be verified', r);
    } else if (s.owner.toLowerCase() !== EXPECTED_OWNER) {
        violate('CRITICAL', 'OWN', 'OWNERSHIP CHANGED: marketplace owner is not the expected secure wallet', r);
    }
    if (s.pendingOwner && s.pendingOwner !== ethers.ZeroAddress) {
        violate('CRITICAL', 'OWN-PENDING', 'Ownership transfer PENDING (Ownable2Step) — an acceptOwnership call would take control', r);
    }
    if (s.paused !== EXPECT_PAUSED) {
        violate('CRITICAL', 'PAUS', s.paused ? 'Contract is PAUSED and was not expected to be' : 'Contract is UNPAUSED and was expected to be paused', r);
    }
    return r;
}

function checkFees(s) {
    const r = { accumulatedFees: fmt(s.fees), mpBal: fmt(s.mpBal) };
    if (s.fees > s.mpBal) violate('CRITICAL', 'FEE', 'accumulatedFees exceeds the contract USDC balance', r);
    return r;
}

// [V6.1] pendingTranche is by construction a subset of the position principal;
// withdraw/socialise paths shrink it pro-rata. If it ever exceeds position.amount
// the qualification maths under-counts the base tranche (p.amount − pending
// underflows in qualifiedAmountAt) and interest distribution reverts or misprices.
function checkPendingTranche(s) {
    const rows = [];
    for (const p of s.pools) {
        for (const l of p.lenders) {
            if (l.pendingAmount === 0n && l.pendingTimestamp === 0n) continue;
            const row = {
                agentId: p.agentId.toString(), lender: l.address,
                amount: fmt(l.amount), pendingAmount: fmt(l.pendingAmount),
                depositTimestamp: Number(l.depositTimestamp), pendingTimestamp: Number(l.pendingTimestamp),
            };
            rows.push(row);
            if (l.pendingAmount > l.amount) violate('CRITICAL', 'PT', '[V6.1] pendingTranche.amount exceeds position.amount', row);
            if (l.pendingAmount > 0n && l.pendingTimestamp < l.depositTimestamp) {
                violate('CRITICAL', 'PT-TS', '[V6.1] pendingTranche timestamp is older than the base tranche timestamp', row);
            }
            if (l.pendingAmount === 0n && l.pendingTimestamp !== 0n) {
                violate('WARN', 'PT-GHOST', '[V6.1] pendingTranche has a timestamp but zero amount (stale slot)', row);
            }
        }
    }
    return rows;
}

// [V6.2 / M2] Self-stake is the whole basis of the V7 fix for F-04: the pool
// creator's own position must be LOCKED while it has outstanding principal, and it is
// the first-loss tranche on default. If the lock silently stops holding, the attacker
// can withdraw their seed again and the economics revert to the pre-V7 state — which
// is the 200,000:1 extraction the audit measured. Nothing else would notice.
function checkSelfStake(s) {
    const rows = [];
    for (const p of s.pools) {
        if (!p.selfStake) continue;                       // V6.1 deployment
        const creatorPos = p.lenders.find(l => l.address.toLowerCase() === p.agentAddress.toLowerCase());
        const row = {
            agentId: p.agentId.toString(), creator: p.agentAddress,
            selfStake: fmt(p.selfStake.amount), locked: p.selfStake.locked,
            outstandingPrincipal: fmt(p.outstandingPrincipal),
            required: p.requiredSelfStake !== undefined ? fmt(p.requiredSelfStake) : null,
            creatorPosition: creatorPos ? fmt(creatorPos.amount) : null,
        };
        rows.push(row);

        // The lock must be engaged exactly while the agent owes principal.
        if (p.outstandingPrincipal > 0n && !p.selfStake.locked) {
            violate('CRITICAL', 'SS-UNLOCKED', '[V6.2] self-stake is NOT locked while the agent has outstanding principal — the first-loss tranche can be withdrawn', row);
        }
        // selfStake must track the creator's actual lender position.
        if (creatorPos && p.selfStake.amount !== creatorPos.amount) {
            violate('CRITICAL', 'SS-MISMATCH', '[V6.2] selfStake disagrees with the creator position in poolLenders', row);
        }
        if (!creatorPos && p.selfStake.amount > 0n) {
            violate('CRITICAL', 'SS-ORPHAN', '[V6.2] selfStake is non-zero but the creator holds no lender slot', row);
        }
        // Cover: with principal outstanding, the stake must still meet the requirement
        // that admitted the loan. WARN, not CRITICAL — the requirement is tier-derived
        // and a tier change by the owner can legitimately move it under a live loan.
        if (p.outstandingPrincipal > 0n && p.requiredSelfStake !== undefined && p.selfStake.amount < p.requiredSelfStake) {
            violate('WARN', 'SS-SHORT', '[V6.2] self-stake is below the current requirement for the outstanding principal', row);
        }
    }
    return rows;
}

// [V6.1] Qualified-amount sanity: for every ACTIVE loan, the principal that
// qualifies for its interest must not exceed the principal that actually exists in
// the pool. `_distributeInterest` divides by this sum, so an inflated value silently
// misprices every lender's share (or reverts).
function checkQualified(s, mp) {
    const rows = [];
    const promises = [];
    for (const p of s.pools) {
        if (p.activeLoanIds === null) continue;   // pre-V6.1: no activeLoanIds to qualify against
        for (const loanId of p.activeLoanIds) {
            const loan = s.loans.find(l => l.id === loanId);
            if (!loan) continue;
            let sumPos = 0n;
            for (const l of p.lenders) sumPos += l.amount;
            promises.push((async () => {
                let sumQ = 0n;
                for (const l of p.lenders) {
                    let q;
                    try {
                        q = await withRetry(() => mp.qualifiedAmountAt(p.agentId, l.address, loan.startTime), `qual[${p.agentId}][${l.address}]`);
                    } catch (e) {
                        // A revert here is itself the finding: `qualifiedAmountAt`
                        // computes `amount − pending`, so it can only revert when the
                        // position is already corrupt — and `_distributeInterest`
                        // would revert the same way, freezing every repayment on this
                        // pool. Record and continue; never abort the whole run.
                        violate('CRITICAL', 'QUAL-REVERT', '[V6.1] qualifiedAmountAt REVERTS for a lender — interest distribution on this pool would revert too', {
                            agentId: p.agentId.toString(), lender: l.address, loanId,
                            amount: fmt(l.amount), pendingAmount: fmt(l.pendingAmount),
                            error: (e.shortMessage || e.message || '').slice(0, 120),
                        });
                        continue;
                    }
                    if (q > l.amount) violate('CRITICAL', 'QUAL-LENDER', '[V6.1] qualified amount exceeds the lender position', {
                        agentId: p.agentId.toString(), lender: l.address, loanId, qualified: fmt(q), amount: fmt(l.amount),
                    });
                    sumQ += q;
                }
                const row = { agentId: p.agentId.toString(), loanId, sumQualified: fmt(sumQ), sumPositions: fmt(sumPos) };
                rows.push(row);
                if (sumQ > sumPos) violate('CRITICAL', 'QUAL', '[V6.1] Σ qualified amounts exceed Σ lender positions for an ACTIVE loan', row);
            })());
        }
    }
    return Promise.all(promises).then(() => rows);
}

// [V6.1] Lateness bookkeeping. Counters are cumulative and must only ever grow;
// a decrease means storage was rewritten (upgrade, corruption, or a wrong-contract
// read). They must also agree with the per-loan RepaymentRecords.
function checkLateness(s, prevState) {
    const rows = [];
    for (const p of s.pools) {
        const k = p.agentId.toString();
        // Lateness tracking is V6.1+. On an older deployment `lateRepayCount` /
        // `lateSecondsTotal` read null AND `repayments` does not exist, so every per-loan
        // lateSeconds defaults to 0 — comparing the two produced 11 false CRITICALs on the
        // Arc testnet v4 stack. Skip the family rather than report a disagreement between
        // two values the contract never had.
        if (p.lateRepayCount === null || p.lateSecondsTotal === null) continue;
        const lateLoans = s.loans.filter(l => l.agentId.toString() === k && l.state === 2 && l.lateSeconds > 0n);
        const recSum = lateLoans.reduce((a, l) => a + l.lateSeconds, 0n);
        const closed = s.loans.filter(l => l.agentId.toString() === k && (l.state === 2 || l.state === 3)).length;
        const row = {
            agentId: k, lateRepayCount: Number(p.lateRepayCount), lateSecondsTotal: Number(p.lateSecondsTotal),
            lateLoansFromRecords: lateLoans.length, lateSecondsFromRecords: Number(recSum), closedLoans: closed,
        };
        rows.push(row);
        if (Number(p.lateRepayCount) !== lateLoans.length) {
            violate('CRITICAL', 'LATE-COUNT', '[V6.1] lateRepayCount disagrees with the per-loan repayment records', row);
        }
        if (p.lateSecondsTotal !== recSum) {
            violate('CRITICAL', 'LATE-SECONDS', '[V6.1] lateSecondsTotal disagrees with the per-loan repayment records', row);
        }
        if (Number(p.lateRepayCount) > closed) {
            violate('CRITICAL', 'LATE-EXCESS', '[V6.1] lateRepayCount exceeds the number of closed loans', row);
        }
        if (p.lateRepayCount > 0n && p.lateSecondsTotal < p.lateRepayCount) {
            violate('CRITICAL', 'LATE-ZERO', '[V6.1] lateSecondsTotal < lateRepayCount (a late repayment with 0 late seconds)', row);
        }
        const prev = prevState && prevState.lateness && prevState.lateness[k];
        if (prev) {
            if (Number(p.lateRepayCount) < prev.count) violate('CRITICAL', 'LATE-MONO', '[V6.1] lateRepayCount DECREASED since the previous run', { ...row, previous: prev });
            if (Number(p.lateSecondsTotal) < prev.seconds) violate('CRITICAL', 'LATE-MONO-S', '[V6.1] lateSecondsTotal DECREASED since the previous run', { ...row, previous: prev });
        }
    }
    return rows;
}

// [F-01 detector, audit 2026-09 recommendation 6] The V6.1 marketplace resolves the
// agent through ownerOf so a transfer no longer bricks a loan, but a transfer while
// a loan is open is still a material credit event: the reputation bonus and the
// repay right move to the buyer while the collateral stays with the seller.
async function checkNftMoves(s, reg) {
    const rows = [];
    for (const p of s.pools) {
        if (Number(p.activeLoanCount) === 0) continue;
        try {
            const holder = await withRetry(() => reg.ownerOf(p.agentId), `ownerOf[${p.agentId}]`);
            const activeBorrowers = s.loans.filter(l => l.state === 1 && l.agentId === p.agentId).map(l => l.borrower.toLowerCase());
            const row = { agentId: p.agentId.toString(), holder, poolAgentAddress: p.agentAddress, activeBorrowers };
            rows.push(row);
            if (activeBorrowers.length && !activeBorrowers.includes(holder.toLowerCase())) {
                violate('WARN', 'NFT-MOVED', 'Agent NFT is held by an address that is not the borrower of its ACTIVE loan(s)', row);
            }
        } catch (e) { if (VERBOSE) log('DEBUG', 'ownerOf failed', { agentId: p.agentId.toString() }); }
    }
    return rows;
}

// FRESHNESS — the answer to "what if the RPC is stale?". A monitor that happily
// re-reads a frozen chain reports OK for ever.
function checkFreshness(block, prevState) {
    const nowSec = Math.floor(Date.now() / 1000);
    const ageSec = nowSec - Number(block.timestamp);
    const r = { blockNumber: block.number, blockTimestamp: Number(block.timestamp), ageSec };
    if (MAX_BLOCK_AGE_SEC > 0) {
        if (ageSec > MAX_BLOCK_AGE_SEC) {
            violate('CRITICAL', 'FRESH', `RPC returned a STALE chain head (${ageSec}s old > ${MAX_BLOCK_AGE_SEC}s) — readings may not reflect current state`, r);
        } else if (ageSec < -300) {
            violate('WARN', 'FRESH-FUTURE', 'Chain head timestamp is in the future relative to this host (clock drift?)', r);
        }
    }
    if (prevState && prevState.blockNumber !== undefined) {
        if (block.number < prevState.blockNumber) {
            violate('CRITICAL', 'FRESH-REORG', 'Chain head went BACKWARDS since the previous run (reorg, or RPC pointing at a different chain)', { ...r, previousBlock: prevState.blockNumber });
        } else if (block.number === prevState.blockNumber) {
            // Independent of the age threshold on purpose: an RPC pinned to an old
            // snapshot answers every state read successfully and self-consistently,
            // so this is the only signal that the readings are not current.
            violate('WARN', 'FRESH-STUCK', 'Chain head unchanged since the previous run (frozen/pinned RPC, or a genuinely idle chain)', { ...r, previousBlock: prevState.blockNumber, previousRun: prevState.ts });
        }
    }
    return r;
}

function readState() {
    try { return JSON.parse(fs.readFileSync(STATEFILE, 'utf8')); } catch { return null; }
}
function writeState(s, block) {
    const lateness = {};
    for (const p of s.pools) lateness[p.agentId.toString()] = { count: Number(p.lateRepayCount), seconds: Number(p.lateSecondsTotal) };
    try {
        fs.writeFileSync(STATEFILE, JSON.stringify({
            ts: new Date().toISOString(), blockNumber: block.number, blockTimestamp: Number(block.timestamp),
            owner: s.owner, paused: s.paused, nextLoanId: s.nextLoanId, lateness,
            creditPolicy: s.creditPolicy || null,
        }, null, 2));
    } catch {}
}

// [V7 / ReputationManagerV4] The credit policy is the control that BOUNDS the F-04
// attack: the tier table caps the prize, and the ladder parameters price the path. Both
// are owner-settable, so a single compromised or careless owner tx can undo the entire
// mitigation silently — nothing on the marketplace side would change. Two checks:
//   (a) hard bound — no tier limit, and no agent's computed limit, may exceed the
//       immutable MAX_TIER_LIMIT. A breach means the contract is not what we think it is.
//   (b) change detection — any drift in the tier table or ladder parameters since the
//       previous run is surfaced. Intentional owner changes are expected to be rare, so a
//       WARN that a human acknowledges is the right severity.
function checkCreditPolicy(s, prevState) {
    if (!s.creditPolicy) return null;                    // V3 reputation manager
    const cp = s.creditPolicy;
    const row = {
        tierLimits: cp.tierLimits.map(v => fmt(BigInt(v))),
        maxTierLimit: fmt(BigInt(cp.maxTierLimit)),
        creditMultiple: cp.creditMultiple, growthStep: fmt(BigInt(cp.growthStep)),
        bootstrapLimit: fmt(BigInt(cp.bootstrapLimit)), defaultLockout: cp.defaultLockout,
    };

    for (let i = 0; i < cp.tierLimits.length; i++) {
        if (BigInt(cp.tierLimits[i]) > BigInt(cp.maxTierLimit)) {
            violate('CRITICAL', 'CP-CAP', `[V7] tier limit ${i} exceeds the immutable MAX_TIER_LIMIT`, { ...row, tier: i });
        }
    }
    for (const a of cp.agentLimits || []) {
        if (BigInt(a.creditLimit) > BigInt(cp.maxTierLimit)) {
            violate('CRITICAL', 'CP-AGENT', '[V7] an agent credit limit exceeds MAX_TIER_LIMIT', { agentId: a.agentId, creditLimit: fmt(BigInt(a.creditLimit)), maxTierLimit: row.maxTierLimit });
        }
    }

    const prev = prevState && prevState.creditPolicy;
    if (prev) {
        const cmp = (k, a, b) => { if (JSON.stringify(a) !== JSON.stringify(b)) violate('WARN', 'CP-CHANGED', `[V7] credit policy changed since the previous run: ${k}`, { field: k, previous: a, current: b }); };
        cmp('tierLimits', prev.tierLimits, cp.tierLimits);
        cmp('creditMultiple', prev.creditMultiple, cp.creditMultiple);
        cmp('growthStep', prev.growthStep, cp.growthStep);
        cmp('bootstrapLimit', prev.bootstrapLimit, cp.bootstrapLimit);
        cmp('defaultLockout', prev.defaultLockout, cp.defaultLockout);
    }
    return row;
}

// -----------------------------------------------------------------------------------

(async () => {
    rotateIfNeeded();
    let exitCode = 0;
    let block = null;
    const prevState = readState();

    // Watchdog: never outlive the scheduling interval. Alerts, then exits 2.
    if (MAX_RUNTIME_SEC > 0) {
        const wd = setTimeout(async () => {
            log('ERROR', '[WATCHDOG] monitor exceeded its runtime budget — aborting', { maxRuntimeSec: MAX_RUNTIME_SEC, rpc: RPC.replace(/\/\/.*@/, '//***@') });
            if (alerts) {
                try {
                    await alerts.raise('CRITICAL', `Invariant monitor timed out on ${NETNAME} — deployment is UNMONITORED`, { network: NETNAME, maxRuntimeSec: MAX_RUNTIME_SEC }, { silent: QUIET });
                    alerts.stamp(NETNAME, { lastExitCode: 2, watchdog: true });
                } catch {}
            }
            process.exit(2);
        }, MAX_RUNTIME_SEC * 1000);
        wd.unref();
    }

    if (!V6) { log('ERROR', 'V6 address missing in addresses.json', { file: NET.addresses }); process.exit(2); }

    try {
        const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1, staticNetwork: true });
        const mp = new ethers.Contract(V6, ABI, provider);
        const reg = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, provider);
        const usdc = new ethers.Contract(ADDR.usdc, ['function balanceOf(address) view returns (uint256)'], provider);

        block = await withRetry(() => provider.getBlock('latest'), 'block');
        if (!block) throw new Error('provider returned no block');
        log('INFO', 'V6 invariant snapshot start', { block: block.number, marketplace: V6, rpc: RPC.replace(/\/\/.*@/, '//***@') });

        checkFreshness(block, prevState);

        const s = await snapshot(mp, reg, usdc);

        const b1 = checkB1(s);
        const s1 = checkS1(s);
        const solv = checkSolvency(s);
        const pool = checkPoolConservation(s);
        const loanAcct = checkLoanAccounting(s);
        const ctl = checkControlPlane(s);
        const fee = checkFees(s);
        const pt = checkPendingTranche(s);
        const ss = checkSelfStake(s);
        const cp = checkCreditPolicy(s, prevState);
        const qual = await checkQualified(s, mp);
        const late = checkLateness(s, prevState);
        const nft = await checkNftMoves(s, reg);

        // Emit one OK line per check family so a clean run is still auditable.
        const has = code => findings.some(f => f.code.startsWith(code));
        const hasCritical = code => findings.some(f => f.code.startsWith(code) && f.severity === 'CRITICAL');
        // One summary line per check family. A family with only WARN findings logs
        // at WARN, not ERROR, so log level keeps meaning what it says.
        const emit = (code, ok, data, prefix) => {
            if (ok) return log('INFO', `${code} OK`, data);
            const crit = prefix ? hasCritical(prefix) : true;
            return log(crit ? 'ERROR' : 'WARN', `${code} ${crit ? 'VIOLATION' : 'WARNING'}`, data);
        };
        emit('§B1', !has('B1'), { totalPools: b1.totalPools }, 'B1');
        emit('§S1', !has('S1'), { mpBal: s1.mpBal, sumAvail: s1.sumAvail, slack: s1.slack }, 'S1');
        emit('§S5', !has('S5'), { cap: s.cap, pools: loanAcct.map(r => ({ agentId: r.agentId, activeLoanCount: r.activeLoanCount, actual: r.actualActiveLoans })) }, 'S5');
        emit('SOLVENCY', !has('SOLV'), solv, 'SOLV');
        emit('POOL', !has('POOL'), { pools: pool }, 'POOL');
        emit('LOAN', !(has('LOAN') || has('ALI')), { pools: loanAcct }, 'LOAN');
        emit('CONTROL', !(has('OWN') || has('PAUS')), ctl, 'OWN');
        emit('FEES', !has('FEE'), fee, 'FEE');
        emit('V6.1-PENDING', !has('PT'), { tranches: pt }, 'PT');
        if (ss.length || s.pools.some(p => p.selfStake)) emit('V6.2-SELFSTAKE', !has('SS'), { stakes: ss }, 'SS');
        if (cp) emit('V7-CREDIT-POLICY', !has('CP'), { policy: cp }, 'CP');
        emit('V6.1-QUALIFIED', !has('QUAL'), { loans: qual }, 'QUAL');
        emit('V6.1-LATENESS', !has('LATE'), { agents: late }, 'LATE');
        emit('F-01-NFT', !has('NFT'), { agents: nft }, 'NFT');

        writeState(s, block);
    } catch (e) {
        violate('CRITICAL', 'MONITOR-FAILED', 'The invariant monitor could not complete its checks — the deployment is UNMONITORED this cycle', {
            error: e.shortMessage || e.message, rpc: RPC.replace(/\/\/.*@/, '//***@'),
        });
        exitCode = 2;
    }

    const criticals = findings.filter(f => f.severity === 'CRITICAL');
    const warns = findings.filter(f => f.severity === 'WARN');
    if (findings.length) {
        for (const f of findings) log(f.severity === 'CRITICAL' ? 'ERROR' : 'WARN', `[${f.code}] ${f.msg}`, { severity: f.severity, ...f.data });
        if (exitCode === 0) exitCode = 1;
        if (alerts) {
            const worst = criticals.length ? 'CRITICAL' : 'WARN';
            const title = `${criticals.length} critical / ${warns.length} warning invariant finding(s) on ${NETNAME}`;
            await alerts.raise(worst, title, {
                network: NETNAME, marketplace: V6, block: block ? block.number : null,
                findings: findings.map(f => ({ severity: f.severity, code: f.code, msg: f.msg, data: f.data })),
            }, { silent: QUIET });
        }
    }

    if (alerts) {
        // `alerted` tells run-with-alert.sh that this run already fanned the
        // incident out, so the wrapper's catch-all does not double-page.
        alerts.stamp(NETNAME, { lastExitCode: exitCode, block: block ? block.number : null, findings: findings.length, alerted: findings.length > 0 });
        // Dead-man's switch: if a sibling network's job has stopped running, this run
        // says so. A monitor that is not running reports no violations, which is
        // indistinguishable from "all clear" — so it is itself an incident, and it
        // makes this run exit non-zero too.
        try {
            const stale = await alerts.checkHeartbeats(Number(process.env.V6_HEARTBEAT_MAX_AGE_SEC || 5400), NETNAME);
            if (stale.length) {
                log('ERROR', '[MONITOR-DOWN] a sibling invariant monitor has stopped running', { stale });
                if (exitCode === 0) exitCode = 1;
            }
        } catch {}
    }

    log('INFO', 'V6 invariant snapshot end', { exitCode, critical: criticals.length, warn: warns.length });
    process.exit(exitCode);
})();
