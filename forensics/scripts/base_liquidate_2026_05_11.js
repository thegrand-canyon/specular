// Base loan liquidation — fires on/after 2026-05-11 19:10 UTC.
// Idempotent: validates state before each broadcast, skips if already liquidated.
//
// Scope: liquidateLoan(2), liquidateLoan(3), liquidateLoan(4) on Base canonical.
// Owner-only call. Saves results to forensics/output/.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC = process.env.BASE_RPC_URL || 'https://base.publicnode.com';
const ADDR = JSON.parse(fs.readFileSync('./src/config/base-addresses.json'));
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;

const TARGET_LOANS = [2, 3, 4];
const LOAN_STATE = ['REQUESTED', 'ACTIVE', 'REPAID', 'DEFAULTED', 'LIQUIDATED'];
const fmt = v => Number(ethers.formatUnits(v, 6));

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const mp = new ethers.Contract(ADDR.agentLiquidityMarketplace, ABI, wallet);

    console.log('Wallet:', wallet.address);
    const owner = await mp.owner();
    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
        console.error('❌ Wallet is not contract owner. Cannot liquidate.');
        console.error('   wallet:', wallet.address, 'owner:', owner);
        process.exit(1);
    }
    const ethBal = await provider.getBalance(wallet.address);
    console.log('Base ETH:', ethers.formatEther(ethBal));
    if (ethBal < ethers.parseEther('0.001')) {
        console.error('❌ Insufficient Base ETH for gas (need ≥0.001 ETH)');
        process.exit(1);
    }

    const block = await provider.getBlock('latest');
    console.log('block.timestamp:', new Date(block.timestamp * 1000).toISOString());

    const results = [];
    for (const id of TARGET_LOANS) {
        console.log(`\n--- Loan #${id} ---`);
        const loan = await mp.loans(id);
        const state = Number(loan.state);
        const endTime = Number(loan.endTime);
        const stateName = LOAN_STATE[state] || `unknown(${state})`;
        console.log(`  state: ${stateName}, amount: ${fmt(loan.amount)}, endTime: ${new Date(endTime*1000).toISOString()}`);

        if (state !== 1) {
            console.log(`  ↪ skip (state is ${stateName}, not ACTIVE)`);
            results.push({ id, action: 'skip', reason: `state=${stateName}` });
            continue;
        }
        if (block.timestamp <= endTime) {
            const wait = endTime - block.timestamp;
            console.log(`  ↪ skip (loan not overdue, ${wait}s = ${(wait/3600).toFixed(2)}h to wait)`);
            results.push({ id, action: 'skip', reason: 'not_overdue', secondsRemaining: wait });
            continue;
        }

        console.log('  static-call liquidateLoan...');
        try {
            await mp.liquidateLoan.staticCall(id);
        } catch (e) {
            console.log(`  ❌ staticCall failed: ${e.shortMessage || e.message}`);
            results.push({ id, action: 'failed_simulation', error: (e.shortMessage || e.message).slice(0, 200) });
            continue;
        }
        console.log('  staticCall OK — broadcasting...');
        try {
            const tx = await mp.liquidateLoan(id);
            console.log(`  tx: ${tx.hash}`);
            const r = await tx.wait();
            console.log(`  mined block ${r.blockNumber}, gas ${r.gasUsed.toString()}`);
            // Verify
            const after = await mp.loans(id);
            const finalState = LOAN_STATE[Number(after.state)] || `unknown(${after.state})`;
            console.log(`  final state: ${finalState}`);
            results.push({ id, action: 'liquidated', tx: tx.hash, finalState, gas: r.gasUsed.toString() });
        } catch (e) {
            console.log(`  ❌ broadcast failed: ${e.shortMessage || e.message}`);
            results.push({ id, action: 'failed_broadcast', error: (e.shortMessage || e.message).slice(0, 200) });
        }
    }

    const outDir = './forensics/output/regression-2026-05-07';
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, '14-base-liquidation-result.json');
    fs.writeFileSync(outFile, JSON.stringify({ ranAt: new Date().toISOString(), results }, null, 2));
    console.log(`\nSaved: ${outFile}`);

    const allOK = results.every(r => r.action === 'liquidated' || r.action === 'skip' && r.reason?.startsWith('state=LIQUIDATED'));
    process.exit(allOK ? 0 : 1);
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
