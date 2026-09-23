// Shared helpers for the 2026-09-23 incident-response drill against the V7 stack
// (AgentRegistryV2 + ReputationManagerV4 + AgentLiquidityMarketplaceV62).
//
// EVERYTHING here targets a LOCAL hardhat node. Nothing in this directory holds a
// private key or an Arc/Base RPC with a signer.

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'forensics/output/testing-2026-09-23/incident-drill');
const ALERT_SANDBOX = path.join(OUT, 'alert-sandbox');
const DAY = 24 * 60 * 60;

const USDC = n => ethers.parseUnits(n.toString(), 6);
const u = v => Number(ethers.formatUnits(v, 6));

function ensureOut() {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(ALERT_SANDBOX, { recursive: true });
}

function writeResult(name, obj) {
    ensureOut();
    fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj, null, 2));
    return path.join(OUT, name);
}

function addr() {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'src/config/local-addresses.json')));
}

// ---------------------------------------------------------------- monitor runner

// Run forensics/monitor/v6-invariants.js against the local chain and return its
// exit code plus the finding codes it emitted. `rpcUrl` lets scenario 6 point the
// monitor at a fault-injecting proxy instead of the node.
function runMonitor(opts = {}) {
    ensureOut();
    const a = addr();
    const stateFile = path.join(ROOT, 'forensics/monitor', `state-local.json`);
    if (opts.freshState !== false) { try { fs.unlinkSync(stateFile); } catch {} }
    if (opts.priorState) fs.writeFileSync(stateFile, JSON.stringify(opts.priorState, null, 2));

    const env = {
        ...process.env,
        V6_MONITOR_NETWORK: 'local',
        // Chain time is driven by evm_increaseTime, so wall-clock freshness is
        // meaningless here. Scenario 6 re-enables it deliberately.
        V6_MAX_BLOCK_AGE_SEC: opts.maxBlockAge !== undefined ? String(opts.maxBlockAge) : '0',
        V6_EXPECTED_OWNER: opts.expectedOwner || a.deployer,
        V6_EXPECT_PAUSED: opts.expectPaused ? '1' : '0',
        SPECULAR_ALERT_QUIET: '1',
        SPECULAR_ALERT_DIR: opts.alertDir || ALERT_SANDBOX,
        LOCAL_RPC_URL: opts.rpcUrl || 'http://127.0.0.1:8545',
        V6_HEARTBEAT_MAX_AGE_SEC: '99999999',   // no sibling-network noise in the drill
        ...(opts.env || {}),
    };
    const args = [path.join(ROOT, 'forensics/monitor/v6-invariants.js')];
    if (!opts.noAlert === false) { /* alerts on by default so we can prove the path */ }
    if (opts.noAlert) args.push('--no-alert');

    const t0 = Date.now();
    let exitCode = 0, out = '';
    try {
        out = execFileSync('node', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: opts.timeoutMs || 180000 });
    } catch (e) {
        exitCode = e.status === undefined || e.status === null ? -1 : e.status;
        out = (e.stdout || '') + (e.stderr || '');
    }
    const ms = Date.now() - t0;
    return { exitCode, ms, ...parseFindings(out), raw: out };
}

function parseFindings(out) {
    const findings = [];
    for (const line of out.split('\n')) {
        if (!line.startsWith('{')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.alert) continue;
        const m = /^\[([A-Z0-9-]+)\]/.exec(j.msg || '');
        if (m) findings.push({ code: m[1], severity: j.severity || (j.level === 'ERROR' ? 'CRITICAL' : 'WARN'), msg: j.msg });
    }
    const seen = new Set();
    const dedup = findings.filter(f => { const k = `${f.code}:${f.severity}`; if (seen.has(k)) return false; seen.add(k); return true; });
    return {
        codes: dedup.map(f => `${f.code}(${f.severity})`),
        criticals: dedup.filter(f => f.severity === 'CRITICAL').map(f => f.code),
        warns: dedup.filter(f => f.severity === 'WARN').map(f => f.code),
        findings: dedup,
    };
}

// Did the alert fan-out actually fire? Reads the sandboxed latch + history.
function alertState(dir = ALERT_SANDBOX) {
    const latchPath = path.join(dir, 'ALERT-ACTIVE.json');
    const histPath = path.join(dir, 'alerts.log');
    let latch = null, history = [];
    try { latch = JSON.parse(fs.readFileSync(latchPath, 'utf8')); } catch {}
    try {
        history = fs.readFileSync(histPath, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch {}
    return { latchExists: latch !== null, latch, historyCount: history.length, lastHistory: history.at(-1) || null };
}

function clearAlerts(dir = ALERT_SANDBOX) {
    for (const f of ['ALERT-ACTIVE.json', 'alerts.log']) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
    try {
        for (const f of fs.readdirSync(dir)) if (f.startsWith('heartbeat-')) fs.unlinkSync(path.join(dir, f));
    } catch {}
}

// ---------------------------------------------------------------- chain helpers

const snap = () => ethers.provider.send('evm_snapshot', []);
const revert = id => ethers.provider.send('evm_revert', [id]);
async function advance(sec) {
    await ethers.provider.send('evm_increaseTime', [Math.floor(sec)]);
    await ethers.provider.send('evm_mine', []);
}
async function now() { return (await ethers.provider.getBlock('latest')).timestamp; }

// Attempt a call; classify the revert reason. Used by the pause blast-radius table.
async function attempt(label, fn) {
    try { const tx = await fn(); if (tx && tx.wait) await tx.wait(); return { label, ok: true, revert: null }; }
    catch (e) {
        const m = e.shortMessage || e.message || '';
        const r = /reverted with custom error '([^']+)'/.exec(m)
            || /reverted with reason string '([^']+)'/.exec(m)
            || /reverted with the following reason:\s*(.+)/.exec(m)
            || /reason="([^"]+)"/.exec(m);
        return { label, ok: false, revert: r ? r[1].trim() : m.slice(0, 110) };
    }
}

// ---------------------------------------------------------------- V7 state views

async function poolSnapshot(v6, agentId) {
    const p = await v6.getAgentPool(agentId);
    const lenderCount = Number(p[6]);
    const lenders = [];
    for (let i = 0; i < lenderCount; i++) {
        const l = await v6.poolLenders(agentId, i);
        const pos = await v6.positions(agentId, l);
        const pt = await v6.pendingTranche(agentId, l);
        lenders.push({ address: l, amount: pos.amount, earnedInterest: pos.earnedInterest, depositTimestamp: pos.depositTimestamp, pending: pt.amount });
    }
    const ss = await v6.selfStake(agentId);
    return {
        agentId: agentId.toString(), agentAddress: p[0],
        totalLiquidity: p[1], availableLiquidity: p[2], totalLoaned: p[3], totalEarned: p[4], lenderCount,
        lenders, selfStake: ss[0], selfStakeLocked: ss[1],
        activeLoanCount: await v6.activeLoanCount(agentId),
        outstandingPrincipal: await v6.outstandingPrincipal(agentId),
    };
}

function prettyPool(s) {
    return {
        agentId: s.agentId, agentAddress: s.agentAddress,
        totalLiquidity: u(s.totalLiquidity), availableLiquidity: u(s.availableLiquidity),
        totalLoaned: u(s.totalLoaned), lenderCount: s.lenderCount,
        selfStake: u(s.selfStake), selfStakeLocked: s.selfStakeLocked,
        outstandingPrincipal: u(s.outstandingPrincipal),
        lenders: s.lenders.map(l => ({ address: l.address, principal: u(l.amount), unclaimedInterest: u(l.earnedInterest) })),
    };
}

// ---------------------------------------------------------- reputation climbing

// Drive `agent` up the V7 credit ladder with real on-time loan cycles, at the LIVE
// Arc-mainnet levers (5 reputation points per day, 1-day minimum hold, 100 USDC
// bonus reference, 7-day reference duration). No storage pokes: every point is
// earned by a real loan, so the resulting state is one the chain could actually
// reach.
async function climbTo(ctx, targetScore, opts = {}) {
    const { v6, rep, usdc, agent, agentId } = ctx;
    const maxCycles = opts.maxCycles || 400;
    const size = opts.loanSize || USDC(100);
    let cycles = 0;
    while (Number(await rep['getReputationScore(uint256)'](agentId)) < targetScore && cycles < maxCycles) {
        const limit = await rep.calculateCreditLimit(agent.address);
        const pool = await v6.getAgentPool(agentId);
        let amount = size < limit ? size : limit;
        if (amount > pool[2]) amount = pool[2];
        if (amount === 0n) throw new Error('climbTo: no headroom (credit limit or pool liquidity is zero)');
        const pct = await rep.calculateCollateralRequirement(agent.address);
        if (pct < 100n) {
            const need = await v6.requiredSelfStake(agentId, amount);
            const have = (await v6.positions(agentId, agent.address)).amount;
            if (have < need) { await usdc.mint(agent.address, need - have); await (await v6.connect(agent).supplyLiquidity(agentId, need - have)).wait(); }
        }
        await usdc.mint(agent.address, amount * 3n);
        await (await v6.connect(agent).requestLoan(amount, 7)).wait();
        const loanId = (await v6.nextLoanId()) - 1n;
        // Hold ~7 days but land strictly before endTime so the repayment is ON TIME.
        await advance(7 * DAY - 900);
        await (await v6.connect(agent).repayLoan(loanId)).wait();
        cycles++;
    }
    return { cycles, score: Number(await rep['getReputationScore(uint256)'](agentId)) };
}

// Raise `maxRepaidPrincipal` with on-time loans until the ladder head-room reaches
// `target`. Each rung needs the agent's own M2-c self-stake in place first.
async function climbLadderTo(ctx, target, opts = {}) {
    const { v6, rep, usdc, agent, agentId } = ctx;
    const rungs = [];
    for (let i = 0; i < (opts.maxRungs || 12); i++) {
        const limit = await rep.calculateCreditLimit(agent.address);
        if (limit >= target) break;
        const pool = await v6.getAgentPool(agentId);
        let amount = limit;
        if (amount > pool[2]) amount = pool[2];
        if (amount === 0n) throw new Error('climbLadderTo: no headroom');
        const pct = await rep.calculateCollateralRequirement(agent.address);
        if (pct < 100n) {
            const need = await v6.requiredSelfStake(agentId, amount);
            const have = (await v6.positions(agentId, agent.address)).amount;
            if (have < need) { await usdc.mint(agent.address, need - have); await (await v6.connect(agent).supplyLiquidity(agentId, need - have)).wait(); }
        }
        await usdc.mint(agent.address, amount * 3n);
        await (await v6.connect(agent).requestLoan(amount, 7)).wait();
        const loanId = (await v6.nextLoanId()) - 1n;
        await advance(7 * DAY - 900);
        await (await v6.connect(agent).repayLoan(loanId)).wait();
        rungs.push({ amount: u(amount), maxRepaidPrincipal: u(await rep.maxRepaidPrincipal(agentId)), newLimit: u(await rep.calculateCreditLimit(agent.address)) });
    }
    return rungs;
}

module.exports = {
    ROOT, OUT, ALERT_SANDBOX, DAY, USDC, u,
    ensureOut, writeResult, addr,
    runMonitor, parseFindings, alertState, clearAlerts,
    snap, revert, advance, now, attempt,
    poolSnapshot, prettyPool, climbTo, climbLadderTo,
};
