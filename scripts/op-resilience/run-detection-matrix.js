// Detection-truth harness: for every engineered violation state, run BOTH the
// frozen V6.0 monitor and the rewritten one against the same local chain, and
// record whether each actually flagged it, at what severity, with what exit code.
//
// Each scenario runs inside an evm_snapshot/evm_revert pair, so scenarios do not
// contaminate each other.
//
// Usage: npx hardhat run --network localhost scripts/op-resilience/run-detection-matrix.js

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { scenarios } = require('./scenarios');
const S = require('./storage');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'forensics/output/testing-2026-09-20');
const ALERT_DIR = path.join(OUT, 'alert-sandbox');

function runMonitor(script, extraEnv = {}) {
    const env = {
        ...process.env,
        V6_MONITOR_NETWORK: 'local',
        V6_MAX_BLOCK_AGE_SEC: '0',        // local chain time is advanced by evm_increaseTime
        SPECULAR_ALERT_QUIET: '1',        // no banners/voice while batch-testing
        SPECULAR_ALERT_DIR: ALERT_DIR,
        ...extraEnv,
    };
    try {
        const out = execFileSync('node', [script], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { exitCode: 0, out };
    } catch (e) {
        return { exitCode: e.status === undefined ? -1 : e.status, out: (e.stdout || '') + (e.stderr || '') };
    }
}

function parseFindings(out) {
    const codes = [];
    let worst = null;
    for (const line of out.split('\n')) {
        if (!line.startsWith('{')) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.alert) continue;
        if (j.level === 'ERROR' || j.level === 'WARN') {
            const m = /^\[([A-Z0-9-]+)\]/.exec(j.msg || '');
            if (m) codes.push(`${m[1]}(${j.severity || j.level})`);
            else if (/VIOLATION|check failed/.test(j.msg || '')) codes.push(`${j.msg.split(':')[0]}(${j.level})`);
            if (j.level === 'ERROR') worst = 'CRITICAL';
            else if (!worst) worst = 'WARN';
        }
    }
    return { codes: [...new Set(codes)], worst };
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    fs.mkdirSync(ALERT_DIR, { recursive: true });

    const addr = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/config/local-addresses.json')));
    const v6 = await ethers.getContractAt('AgentLiquidityMarketplaceV6', addr.agentLiquidityMarketplace_v6);
    const registry = await ethers.getContractAt('AgentRegistryV2', addr.agentRegistryV2);
    const usdc = await ethers.getContractAt('MockUSDC', addr.usdc);
    const signers = await ethers.getSigners();

    const ctx = {
        v6, registry, usdc, addr, signers,
        v6Addr: addr.agentLiquidityMarketplace_v6,
        agentAId: BigInt(addr._testAccounts.agentAId),
        agentBId: BigInt(addr._testAccounts.agentBId),
    };

    // Fail fast if the slot map ever drifts from the compiled contract.
    await S.verifySlots(v6, ctx.agentAId, addr._testAccounts.lender1);

    const NEW = path.join(ROOT, 'forensics/monitor/v6-invariants.js');
    const OLD = path.join(ROOT, 'scripts/op-resilience/v6-invariants-V60-baseline.js');

    const results = [];
    for (const sc of scenarios) {
        const snap = await ethers.provider.send('evm_snapshot', []);
        let applyError = null;
        try { await sc.apply(ctx); } catch (e) { applyError = e.shortMessage || e.message; }

        // Fresh state file each scenario except the ones that need history
        // (lateness monotonicity). Those get a primed previous-run state.
        const stateFile = path.join(ROOT, 'forensics/monitor/state-local.json');
        try { fs.unlinkSync(stateFile); } catch {}
        if (sc.key.startsWith('v61_lateness')) {
            fs.writeFileSync(stateFile, JSON.stringify({
                ts: new Date(Date.now() - 1800e3).toISOString(), blockNumber: 1, blockTimestamp: 1,
                lateness: { [ctx.agentAId.toString()]: { count: 1, seconds: 86401 } },
            }));
        }

        const oldRun = runMonitor(OLD);
        const newRun = runMonitor(NEW);

        results.push({
            key: sc.key, title: sc.title, expectDetect: sc.expectDetect, applyError,
            v60: { exitCode: oldRun.exitCode, ...parseFindings(oldRun.out) },
            v61: { exitCode: newRun.exitCode, ...parseFindings(newRun.out) },
        });
        const r = results.at(-1);
        console.log(`${r.key.padEnd(26)} old=exit${r.v60.exitCode} ${(r.v60.codes.join(',') || '-').padEnd(24)} | new=exit${r.v61.exitCode} ${r.v61.codes.join(',') || '-'}${applyError ? '  APPLY_ERROR: ' + applyError : ''}`);

        await ethers.provider.send('evm_revert', [snap]);
    }

    fs.writeFileSync(path.join(OUT, 'detection-matrix.json'), JSON.stringify(results, null, 2));
    try { fs.unlinkSync(path.join(ROOT, 'forensics/monitor/state-local.json')); } catch {}

    const missedOld = results.filter(r => r.expectDetect && r.v60.exitCode === 0);
    const missedNew = results.filter(r => r.expectDetect && r.v61.exitCode === 0);
    const falsePos = results.filter(r => !r.expectDetect && r.v61.exitCode !== 0);
    console.log(`\nV6.0 monitor: detected ${results.filter(r => r.expectDetect).length - missedOld.length}/${results.filter(r => r.expectDetect).length}, MISSED ${missedOld.length}`);
    console.log(`V6.1 monitor: detected ${results.filter(r => r.expectDetect).length - missedNew.length}/${results.filter(r => r.expectDetect).length}, MISSED ${missedNew.length}`);
    console.log(`false positives on the clean control: ${falsePos.length}`);
    if (missedNew.length) console.log('STILL MISSED:', missedNew.map(r => r.key).join(', '));
}

main().catch(e => { console.error(e); process.exit(1); });
