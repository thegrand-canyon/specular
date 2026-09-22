// End-to-end proof that a real violation reaches a human.
//
// Engineers an ACTUAL violation on the local chain (owner pauses the marketplace),
// runs the production launchd entry point (run-with-alert.sh) against it, and then
// asserts that every alert channel fired: latch file, ~/SPECULAR-ALERT.txt equivalent,
// history log, webhook POST (received by a throwaway local HTTP server), and a
// non-zero exit propagated out of the wrapper.
//
// Usage: npx hardhat run --network localhost scripts/op-resilience/verify-alert-path.js

const { ethers } = require('hardhat');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'forensics/output/testing-2026-09-20');
const SANDBOX = path.join(OUT, 'alert-e2e');

async function main() {
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    fs.mkdirSync(SANDBOX, { recursive: true });

    // 1. throwaway webhook receiver — proves the opt-in webhook path without any
    //    real service and without a URL committed anywhere.
    const received = [];
    const server = http.createServer((req, res) => {
        let b = ''; req.on('data', c => b += c);
        req.on('end', () => { received.push({ headers: req.headers, body: b }); res.writeHead(200).end('ok'); });
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const webhookUrl = `http://127.0.0.1:${server.address().port}/hook`;

    const addr = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/config/local-addresses.json')));
    const v6 = await ethers.getContractAt('AgentLiquidityMarketplaceV6', addr.agentLiquidityMarketplace_v6);

    const snap = await ethers.provider.send('evm_snapshot', []);
    const results = {};
    try {
        // 2. a genuine violation: the marketplace is paused, the operator did not expect it
        await v6.pause();
        console.log('engineered violation: marketplace paused =', await v6.paused());

        // 3. run the REAL launchd entry point
        const env = {
            ...process.env,
            SPECULAR_REPO: ROOT,
            SPECULAR_ALERT_DIR: SANDBOX,
            SPECULAR_ALERT_WEBHOOK: webhookUrl,
            SPECULAR_ALERT_QUIET: process.env.ALERT_E2E_LOUD === '1' ? '0' : '1',
            V6_MAX_BLOCK_AGE_SEC: '0',
            LOCAL_RPC_URL: 'http://127.0.0.1:8545',
        };
        let exitCode = 0;
        try {
            execFileSync('/bin/bash', [path.join(ROOT, 'forensics/monitor/run-with-alert.sh'), 'local'],
                { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (e) { exitCode = e.status; }
        results.wrapperExitCode = exitCode;

        await new Promise(r => setTimeout(r, 1500)); // let the webhook POST land

        // 4. assert every channel
        const latchPath = path.join(SANDBOX, 'ALERT-ACTIVE.json');
        const histPath = path.join(SANDBOX, 'alerts.log');
        const homeFlag = path.join(os.homedir(), 'SPECULAR-ALERT.txt');
        results.latchExists = fs.existsSync(latchPath);
        results.latch = results.latchExists ? JSON.parse(fs.readFileSync(latchPath, 'utf8')) : null;
        results.historyLines = fs.existsSync(histPath) ? fs.readFileSync(histPath, 'utf8').trim().split('\n').length : 0;
        results.homeFlagExists = fs.existsSync(homeFlag);
        results.homeFlagTail = results.homeFlagExists ? fs.readFileSync(homeFlag, 'utf8').trim().split('\n').slice(-6).join('\n') : null;
        results.webhookDeliveries = received.length;
        results.webhookBodySample = received[0] ? JSON.parse(received[0].body).text : null;
        results.heartbeatExists = fs.existsSync(path.join(SANDBOX, 'heartbeat-local.json'));
        results.heartbeat = results.heartbeatExists ? JSON.parse(fs.readFileSync(path.join(SANDBOX, 'heartbeat-local.json'), 'utf8')) : null;

        const src = results.latch && (results.latch.first || results.latch.latest);
        results.findingCodes = ((src && src.details && src.details.findings) || []).map(f => f.code);
        results.alertsRaised = results.latch ? results.latch.count : 0;

        // 5. acknowledgement clears the latch and the home flag
        execFileSync('node', [path.join(ROOT, 'forensics/monitor/alert.js'), '--ack'],
            { env: { ...env }, encoding: 'utf8' });
        results.latchClearedAfterAck = !fs.existsSync(latchPath);
        results.homeFlagClearedAfterAck = !fs.existsSync(homeFlag);
    } finally {
        await ethers.provider.send('evm_revert', [snap]);
        server.close();
    }

    const pass =
        results.wrapperExitCode !== 0 &&
        results.latchExists &&
        results.historyLines > 0 &&
        results.homeFlagExists &&
        results.webhookDeliveries > 0 &&
        results.heartbeatExists &&
        results.findingCodes.includes('PAUS') &&
        results.latchClearedAfterAck &&
        results.homeFlagClearedAfterAck;

    results.VERDICT = pass ? 'ALERT PATH VERIFIED END-TO-END' : 'ALERT PATH INCOMPLETE';
    fs.writeFileSync(path.join(OUT, 'alert-e2e-result.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
    if (!pass) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
