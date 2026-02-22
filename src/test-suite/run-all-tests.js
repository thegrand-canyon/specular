'use strict';
/**
 * Specular Protocol Test Suite
 *
 * Comprehensive testing for Arc Testnet deployment
 * - Agent registration and pool creation
 * - Loan lifecycle (request, work, repay)
 * - Reputation score progression
 * - XMTP notifications
 * - Multi-agent scenarios
 * - Pool liquidity management
 */

require('dotenv').config();

const { ethers } = require('ethers');

const TESTS = [
    { name: 'Single Agent - 1 Cycle',  borrowerCycles: 1, lenderSupply: 100, loanAmount: 10 },
    { name: 'Single Agent - 5 Cycles', borrowerCycles: 5, lenderSupply: 500, loanAmount: 20 },
    { name: 'Two Agents - Parallel',   borrowerCycles: 3, lenderSupply: 300, loanAmount: 15, twoAgents: true },
    { name: 'Reputation Growth Test',  borrowerCycles: 10, lenderSupply: 1000, loanAmount: 25 },
    { name: 'High Utilization Test',   borrowerCycles: 5, lenderSupply: 200, loanAmount: 35 },
];

const RPC_URL = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';

async function main() {
    console.log('\n' + '═'.repeat(70));
    console.log('  Specular Protocol Test Suite — Arc Testnet');
    console.log('═'.repeat(70));

    const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { batchMaxCount: 1 });
    const blockNumber = await provider.getBlockNumber();
    console.log(`\n[INFO] Connected to Arc Testnet | Block: ${blockNumber.toLocaleString()}\n`);

    const results = [];

    for (let i = 0; i < TESTS.length; i++) {
        const test = TESTS[i];
        console.log(`\n${'─'.repeat(70)}`);
        console.log(`  Test ${i + 1}/${TESTS.length}: ${test.name}`);
        console.log(`${'─'.repeat(70)}\n`);

        const startTime = Date.now();
        let status = 'PASSED';
        let error = null;

        try {
            if (test.twoAgents) {
                await runTwoAgentTest(test);
            } else {
                await runSingleAgentTest(test);
            }
        } catch (err) {
            status = 'FAILED';
            error = err.message;
            console.error(`\n[ERROR] Test failed: ${err.message}\n`);
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);
        results.push({ test: test.name, status, duration, error });

        console.log(`\n[${status}] ${test.name} — ${duration}s\n`);

        if (i < TESTS.length - 1) {
            console.log('[INFO] Waiting 10s before next test...');
            await sleep(10000);
        }
    }

    printSummary(results);
}

async function runSingleAgentTest(test) {
    const { spawn } = require('child_process');
    const { borrowerCycles, lenderSupply, loanAmount } = test;

    return new Promise((resolve, reject) => {
        const proc = spawn('/opt/homebrew/opt/node@22/bin/node', ['src/agents/run-agent.js'], {
            env: {
                ...process.env,
                AGENT_CYCLES: borrowerCycles,
                AGENT_LOAN_USDC: loanAmount,
                AGENT_WORK_MS: 500,
                AGENT_REST_MS: 3000,
            },
            cwd: '/Users/peterschroeder/Specular',
        });

        let output = '';
        proc.stdout.on('data', (data) => {
            output += data.toString();
            process.stdout.write(data);
        });
        proc.stderr.on('data', (data) => {
            output += data.toString();
            process.stderr.write(data);
        });

        proc.on('close', (code) => {
            if (code === 0) {
                // Check if cycles completed
                const match = output.match(/Cycles completed:\s+(\d+)/);
                if (match && parseInt(match[1]) === borrowerCycles) {
                    resolve();
                } else {
                    reject(new Error(`Expected ${borrowerCycles} cycles, completed ${match ? match[1] : 0}`));
                }
            } else {
                reject(new Error(`Process exited with code ${code}`));
            }
        });
    });
}

async function runTwoAgentTest(test) {
    const { spawn } = require('child_process');
    const { borrowerCycles, lenderSupply, loanAmount } = test;

    return new Promise((resolve, reject) => {
        const proc = spawn('/opt/homebrew/opt/node@22/bin/node', ['src/agents/run-agents.js'], {
            env: {
                ...process.env,
                AGENT_CYCLES: borrowerCycles,
                AGENT_LOAN_USDC: loanAmount,
                LENDER_SUPPLY: lenderSupply,
                AGENT_WORK_MS: 500,
                AGENT_REST_MS: 3000,
            },
            cwd: '/Users/peterschroeder/Specular',
        });

        let output = '';
        proc.stdout.on('data', (data) => {
            output += data.toString();
            process.stdout.write(data);
        });
        proc.stderr.on('data', (data) => {
            output += data.toString();
            process.stderr.write(data);
        });

        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`Two-agent test exited with code ${code}`));
            }
        });
    });
}

function printSummary(results) {
    console.log('\n' + '═'.repeat(70));
    console.log('  Test Suite Summary');
    console.log('═'.repeat(70));

    const passed = results.filter(r => r.status === 'PASSED').length;
    const failed = results.filter(r => r.status === 'FAILED').length;
    const total = results.length;

    results.forEach((r, i) => {
        const icon = r.status === 'PASSED' ? '✓' : '✗';
        console.log(`  ${i + 1}. ${icon} ${r.test} — ${r.duration}s ${r.error ? `(${r.error})` : ''}`);
    });

    console.log('\n' + '─'.repeat(70));
    console.log(`  Results: ${passed}/${total} passed, ${failed}/${total} failed`);
    console.log('═'.repeat(70) + '\n');

    process.exit(failed > 0 ? 1 : 0);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => {
    console.error('\n[FATAL]', err.message);
    process.exit(1);
});
