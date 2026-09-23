// Drill control: the monitor must be SILENT on the healthy V7 baseline, or every
// later "it detected it" result is worthless.
//
// Usage: npx hardhat run --network localhost scripts/incident-drill/s0-baseline.js

const { ethers } = require('hardhat');
const L = require('./lib');

async function main() {
    L.clearAlerts();
    const a = L.addr();
    const v6 = await ethers.getContractAt('AgentLiquidityMarketplaceV62', a.agentLiquidityMarketplace_v6);
    const before = L.alertState();
    const run = L.runMonitor();
    const after = L.alertState();

    const result = {
        scenario: 'S0 — control: healthy V7 baseline',
        marketplaceVersion: await v6.VERSION(),
        monitor: { exitCode: run.exitCode, ms: run.ms, codes: run.codes },
        cleanRun: run.exitCode === 0 && run.criticals.length === 0,
        alertLatchBefore: before.latchExists,
        alertLatchAfter: after.latchExists,
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.cleanRun) { console.log('--- monitor output ---\n' + run.raw); }
    L.writeResult('s0-baseline.json', result);
}

main().catch(e => { console.error(e); process.exit(1); });
