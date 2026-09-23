/**
 * Template: Compute-Renter Agent
 *
 * An agent that rents GPU compute on-demand. When a job arrives, borrows
 * enough USDC to fund the compute window, runs the workload, charges the
 * client (off-template), repays the loan.
 *
 * Substitute rentCompute() and runJob() for your provider integration
 * (Akash, vast.ai, RunPod, etc.).
 *
 * Run:
 *   AGENT_KEY=0x... node src/sdk/templates/compute-renter-agent.js
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { SpecularQuickstart } = require('../SpecularQuickstart');

const NETWORK = 'arc';
const COMPUTE_COST_PER_HOUR_USDC = 1.5;
const JOB_DURATION_HOURS = 0.001; // demo: very short
const JOB_PAYS_USDC = 5.0;

async function rentCompute(usdc) {
    console.log(`  [Provider] Rented compute for ${usdc} USDC`);
    await new Promise(r => setTimeout(r, 300));
    return { instanceId: 'gpu-' + Math.floor(Math.random() * 1e6) };
}

async function runJob(instanceId, hours) {
    console.log(`  [Job] Running on ${instanceId} for ${hours} hour(s)`);
    await new Promise(r => setTimeout(r, 500));
    return { resultCID: 'ipfs://Qm' + Math.random().toString(36).slice(2, 8) };
}

(async () => {
    const provider = new ethers.JsonRpcProvider(process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org');
    const wallet = new ethers.Wallet(process.env.AGENT_KEY || process.env.PRIVATE_KEY, provider);
    const sdk = new SpecularQuickstart(wallet, NETWORK);

    const onb = await sdk.onboard();
    const info = await sdk.creditInfo();
    console.log('Agent reputation:', info.score, '/ Credit:', info.creditLimit, 'USDC');

    // Calculate the credit needed for the upcoming job
    const computeNeed = COMPUTE_COST_PER_HOUR_USDC * JOB_DURATION_HOURS;
    if (computeNeed > parseFloat(info.creditLimit)) {
        console.log(`Job needs ${computeNeed} USDC but credit limit is only ${info.creditLimit}. Aborting.`);
        return;
    }

    // Demo: self-supply liquidity if pool is empty. Remove in production.
    const pool = await sdk.marketplace.getAgentPool(onb.agentId);
    if (pool.availableLiquidity < ethers.parseUnits(String(computeNeed * 2), 6)) {
        console.log(`Pool empty — self-supplying ${computeNeed * 2} USDC for demo`);
        await sdk.supply(onb.agentId, computeNeed * 2);
    }

    console.log(`\nBorrowing ${computeNeed} USDC for compute…`);
    const loan = await sdk.borrow(computeNeed, 7);
    console.log('Loan id:', loan.loanId);

    const inst = await rentCompute(computeNeed);
    const result = await runJob(inst.instanceId, JOB_DURATION_HOURS);
    console.log('Job done. Result:', result.resultCID);

    // Client pays (simulated)
    console.log(`\n[Client] Paid agent ${JOB_PAYS_USDC} USDC for completed work`);

    console.log('\nRepaying loan…');
    const repayTx = await sdk.repay(loan.loanId);
    console.log('Repaid:', sdk.explorerUrl(repayTx));

    const after = await sdk.creditInfo();
    console.log(`\nNet margin: ${JOB_PAYS_USDC - computeNeed} USDC. Reputation ${info.score} → ${after.score}`);
})().catch(e => { console.error(e); process.exit(1); });
