// Expanded E2E — beyond the basic loan cycle.
// All read-only on Base, minimal writes on Arc.
//
// 1. Duration edge cases on Arc (verify bubbly-discovering-aurora plan premise)
// 2. liquidateLoan staticCall on Base — pre-flight verification of Day-11 plan
// 3. Cross-network state comparison after this session's writes

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const ARC_RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const BASE_RPC = process.env.BASE_RPC_URL || 'https://base.publicnode.com';
const ARC_ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const BASE_ADDR = JSON.parse(fs.readFileSync('./src/config/base-addresses.json'));
const MP_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;
const USDC_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)'];

const OUT = './forensics/output/regression-2026-05-07';
const fmt = v => Number(ethers.formatUnits(v, 6));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, label, attempts = 5) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const msg = (e.shortMessage || e.message || '');
            const isRate = msg.includes('rate') || msg.includes('408') || msg.includes('410') || msg.includes('429') || msg.includes('-32016') || msg.includes('timeout');
            if (i === attempts - 1 || !isRate) throw e;
            await sleep(2000 * Math.pow(2, i));
        }
    }
}

const out = { generatedAt: new Date().toISOString() };

(async () => {
    const arcProv = new ethers.JsonRpcProvider(ARC_RPC, undefined, { batchMaxCount: 1 });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, arcProv);
    const arcMp = new ethers.Contract(ARC_ADDR.agentLiquidityMarketplace, MP_ABI, wallet);
    const arcUsdc = new ethers.Contract(ARC_ADDR.usdc, USDC_ABI, wallet);

    // ===== 1. Duration edge cases (Arc) =====
    console.log('\n===== 1. DURATION EDGE CASES (Arc) =====');
    // First need pool 49 to have some liquidity for the duration check to be reached
    const pool49 = await withRetry(() => arcMp.getAgentPool(49), 'pool49');
    console.log(`pool 49 avail: ${fmt(pool49[2])} USDC`);
    if (pool49[2] < ethers.parseUnits('0.5', 6)) {
        console.log('Supplying 1 USDC to pool 49 for duration testing...');
        const allowance = await withRetry(() => arcUsdc.allowance(wallet.address, ARC_ADDR.agentLiquidityMarketplace), 'allowance');
        if (allowance < ethers.parseUnits('1', 6)) {
            const a = await withRetry(() => arcUsdc.approve(ARC_ADDR.agentLiquidityMarketplace, ethers.parseUnits('1', 6)), 'approve');
            await withRetry(() => a.wait(), 'approve.wait');
        }
        const tx = await withRetry(() => arcMp.supplyLiquidity(49, ethers.parseUnits('1', 6)), 'supply');
        console.log(`  tx: ${tx.hash}`);
        await withRetry(() => tx.wait(), 'supply.wait');
    }

    out.duration_tests = [];
    const TEST_AMT = ethers.parseUnits('0.1', 6); // small, well within pool
    // Test each duration via staticCall
    const cases = [0, 1, 6, 7, 8, 30, 100, 365, 366, 1000, 86400, 604800];
    for (const dur of cases) {
        try {
            await withRetry(() => arcMp.requestLoan.staticCall(TEST_AMT, dur, { from: wallet.address }), `dur=${dur}`);
            out.duration_tests.push({ durationDays: dur, result: 'would_succeed' });
            console.log(`  durationDays=${dur}: ✅ would succeed`);
        } catch (e) {
            const msg = (e.shortMessage || e.message).slice(0, 80);
            out.duration_tests.push({ durationDays: dur, result: 'revert', msg });
            console.log(`  durationDays=${dur}: ❌ ${msg}`);
        }
    }

    // Withdraw the supplied 1 USDC
    console.log('Cleanup: withdrawing supplied USDC from pool 49...');
    const myPos49 = await withRetry(() => arcMp.positions(49, wallet.address), 'pos49');
    if (myPos49[0] > 0n) {
        const wTx = await withRetry(() => arcMp.withdrawLiquidity(49, myPos49[0]), 'withdraw');
        await withRetry(() => wTx.wait(), 'withdraw.wait');
        console.log(`  withdrew ${fmt(myPos49[0])} USDC, tx: ${wTx.hash}`);
    }

    // ===== 2. liquidateLoan pre-flight (Base) =====
    console.log('\n===== 2. LIQUIDATE PRE-FLIGHT (Base, static-call) =====');
    const baseProv = new ethers.JsonRpcProvider(BASE_RPC);
    const baseMp = new ethers.Contract(BASE_ADDR.agentLiquidityMarketplace, MP_ABI, baseProv);
    out.liquidate_preflight = [];
    const block = await baseProv.getBlock('latest');
    for (const id of [2, 3, 4]) {
        const loan = await withRetry(() => baseMp.loans(id), `base.loan${id}`);
        const endTime = Number(loan.endTime);
        const remaining = endTime - block.timestamp;
        let action = 'eligible';
        let reason = null;
        if (Number(loan.state) !== 1) { action = 'skip'; reason = `state ${loan.state}`; }
        else if (remaining > 0) { action = 'wait'; reason = `${(remaining/3600).toFixed(2)}h remaining`; }
        // Static-call regardless to capture would-be result
        let staticCallResult = null;
        try {
            await baseMp.liquidateLoan.staticCall(id, { from: '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C' });
            staticCallResult = 'would_succeed';
        } catch (e) {
            staticCallResult = (e.shortMessage || e.message).slice(0, 100);
        }
        out.liquidate_preflight.push({ id, state: Number(loan.state), endTime, remaining, action, reason, staticCallResult });
        console.log(`  loan ${id}: ${action} (${reason || 'eligible'}) — staticCall: ${staticCallResult.slice(0,80)}`);
    }

    // ===== 3. Cross-network state comparison =====
    console.log('\n===== 3. CROSS-NETWORK STATE SNAPSHOT =====');
    const arcPool49 = await withRetry(() => arcMp.getAgentPool(49), 'arc.pool49.final');
    const arcPool49Lenders = [];
    for (let j = 0; j < Number(arcPool49[6]); j++) {
        arcPool49Lenders.push((await withRetry(() => arcMp.poolLenders(49, j), `lender${j}`)).toLowerCase());
    }
    const arcPool49Pos = await withRetry(() => arcMp.positions(49, wallet.address), 'arc.pos49');
    const basePool1 = await withRetry(() => baseMp.getAgentPool(1), 'base.pool1');
    const basePool1Lenders = [];
    for (let j = 0; j < Number(basePool1[6]); j++) {
        basePool1Lenders.push((await withRetry(() => baseMp.poolLenders(1, j), `bl${j}`)).toLowerCase());
    }
    const basePool1Pos = await withRetry(() => baseMp.positions(1, wallet.address), 'base.pos1');

    out.state_snapshot = {
        arc_pool_49: {
            totalLiq: fmt(arcPool49[1]), avail: fmt(arcPool49[2]),
            totalEarned: fmt(arcPool49[4]), lenderCount: Number(arcPool49[6]),
            poolLenders: arcPool49Lenders,
            myPosition: { supplied: fmt(arcPool49Pos[0]), earnedInt: fmt(arcPool49Pos[1]) },
            sigma_phantom: fmt(arcPool49[2]) - fmt(arcPool49Pos[0]),
        },
        base_pool_1: {
            totalLiq: fmt(basePool1[1]), avail: fmt(basePool1[2]),
            totalEarned: fmt(basePool1[4]), lenderCount: Number(basePool1[6]),
            poolLenders: basePool1Lenders,
            myPosition: { supplied: fmt(basePool1Pos[0]), earnedInt: fmt(basePool1Pos[1]) },
            duplicate_count: basePool1Lenders.length - new Set(basePool1Lenders).size,
        },
    };
    console.log('Arc pool 49:', JSON.stringify(out.state_snapshot.arc_pool_49, null, 2));
    console.log('Base pool 1:', JSON.stringify(out.state_snapshot.base_pool_1, null, 2));

    fs.writeFileSync(path.join(OUT, '15-expanded-e2e.json'), JSON.stringify(out, null, 2));
    console.log(`\nSaved: ${OUT}/15-expanded-e2e.json`);
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
