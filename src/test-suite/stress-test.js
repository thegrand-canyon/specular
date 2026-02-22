'use strict';
/**
 * Specular Stress Test
 *
 * Runs extended agent cycles to test:
 * - Reputation progression through multiple tiers
 * - Pool liquidity management under load
 * - Transaction reliability over many operations
 * - x402 credit checks at scale
 * - XMTP notification reliability
 *
 * Usage:
 *   CYCLES=20 LOAN_AMOUNT=25 node src/test-suite/stress-test.js
 */

require('dotenv').config();

const { spawn } = require('child_process');

const CYCLES = parseInt(process.env.CYCLES || '15');
const LOAN_AMOUNT = parseInt(process.env.LOAN_AMOUNT || '20');
const WORK_MS = parseInt(process.env.WORK_MS || '500');
const REST_MS = parseInt(process.env.REST_MS || '5000');

console.log('\n' + '═'.repeat(70));
console.log('  Specular Stress Test');
console.log('═'.repeat(70));
console.log(`\n  Cycles:      ${CYCLES}`);
console.log(`  Loan Amount: ${LOAN_AMOUNT} USDC`);
console.log(`  Work Time:   ${WORK_MS}ms`);
console.log(`  Rest Time:   ${REST_MS}ms`);
console.log(`  Est. Duration: ~${Math.ceil((CYCLES * (WORK_MS + REST_MS + 30000)) / 60000)} minutes`);
console.log('\n' + '─'.repeat(70) + '\n');

const proc = spawn('/opt/homebrew/opt/node@22/bin/node', ['src/agents/run-agent.js'], {
    env: {
        ...process.env,
        AGENT_CYCLES: CYCLES,
        AGENT_LOAN_USDC: LOAN_AMOUNT,
        AGENT_WORK_MS: WORK_MS,
        AGENT_REST_MS: REST_MS,
    },
    cwd: '/Users/peterschroeder/Specular',
    stdio: 'inherit',
});

proc.on('close', (code) => {
    console.log('\n' + '═'.repeat(70));
    if (code === 0) {
        console.log('  ✓ Stress Test PASSED');
    } else {
        console.log(`  ✗ Stress Test FAILED (exit code ${code})`);
    }
    console.log('═'.repeat(70) + '\n');
    process.exit(code);
});
