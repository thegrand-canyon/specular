/**
 * Orchestrator for the V7 end-to-end staging suite.
 *
 *   export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
 *   node scripts/e2e-v7/run-all.js            # every on-chain scenario, in order
 *   node scripts/e2e-v7/run-all.js --local    # also run the local time-travel suite
 *
 * Order matters: 00-setup compresses the clock levers, the V1..V8 scenarios run
 * against that, 99-restore puts them back, and v7-migration-control-plane then
 * asserts the restored live configuration.
 */
const { execFileSync } = require('child_process');
const path = require('path');

const ORDER = [
    '00-setup.js',
    'v1-self-stake-lock.js',
    'v2-self-stake-gate.js',
    'v3-credit-ladder.js',
    'v4-tier-cap.js',
    'v5-loanid-passthrough.js',
    'v6-minsupply-creator-exempt.js',
    'v8-prior-fixes-regression.js',
    '99-restore-levers.js',
    'v7-migration-control-plane.js',   // asserts the RESTORED live configuration
    'v9-minhold-ladder-coupling.js'    // observation, runs at the live levers
];

const failures = [];
for (const s of ORDER) {
    console.log(`\n\n######## ${s} ########`);
    try {
        execFileSync(process.execPath, [path.join(__dirname, s)], { stdio: 'inherit' });
    } catch (e) {
        failures.push(s);
        console.error(`!! ${s} exited non-zero`);
        if (s === '00-setup.js') break; // nothing downstream can work
    }
}
if (process.argv.includes('--local')) {
    console.log('\n\n######## local-time-travel.js (hardhat, chainId 31337) ########');
    try {
        execFileSync('npx', ['hardhat', 'run', path.join(__dirname, 'local-time-travel.js')], { stdio: 'inherit', cwd: path.join(__dirname, '..', '..') });
    } catch (e) { failures.push('local-time-travel.js'); }
}
console.log(failures.length ? `\nFAILED: ${failures.join(', ')}` : '\nall scenarios completed');
process.exitCode = failures.length ? 1 : 0;
