// V6 stranded USDC recovery.
//
// Phase A: withdraw positions we have keys for (12k USDC, 26 positions).
// Phase B: seedPosition migration of orphan positions in UNDER-CAP pools to master wallet,
//          then master withdraws.
// Skips pool 124 (50/50 orphan lenders, at MAX_LENDERS cap — unrecoverable on this V6).
//
// Procedure per orphan pool:
//   For each orphan position:
//     1. seedPosition(aid, orphan, 0, 0, 0) — zero orphan (sum decreases, sum check holds)
//     2. seedPosition(aid, master, running_master_amount, 0, ts) — credit master (sum back to original)
//   After all orphans zeroed:
//     3. withdrawLiquidity(aid, master_amount) — drain to master wallet
//
// SAFETY: each step is invariant-safe (sum ≤ totalLiquidity holds after every seedPosition).
//         If script aborts mid-way, pool is in a recoverable state — re-run picks up where we left off.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const USDC_ABI = ['function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function approve(address,uint256) returns (bool)'];
const fmt = v => Number(ethers.formatUnits(v, 6));
const sleep = ms => new Promise(r => setTimeout(r, ms));

const SKIP_POOLS = new Set([124]); // at-cap, unrecoverable

async function withRetry(fn, attempts = 20) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const m = (e.shortMessage || e.message || '').toLowerCase();
            const isRate = m.includes('rate') || m.includes('408') || m.includes('429') || m.includes('-32016') || m.includes('timeout') || m.includes('server response') || m.includes('econnreset');
            if (i === attempts - 1 || !isRate) throw e;
            await sleep(Math.min(2000 * Math.pow(1.5, i), 30000));
        }
    }
}
const log = (...a) => console.log(...a);

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const v6 = new ethers.Contract(V6, ABI, owner);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, provider);

    const startMaster = await usdc.balanceOf(owner.address);
    log('===========================================================');
    log('  V6 STRANDED USDC RECOVERY');
    log('===========================================================');
    log('Master wallet:', owner.address);
    log('Master USDC before:', fmt(startMaster));

    // Load probe results
    const probe = JSON.parse(fs.readFileSync('./forensics/output/regression-2026-05-07/61-v6-orphan-probe.json'));
    log(`Probe: ${probe.recoverablePositions.length} recoverable positions (${fmt(BigInt(probe.recoverableTotal))} USDC), ${probe.orphanPositions.length} orphan (${fmt(BigInt(probe.orphanTotal))} USDC)`);

    // Group orphans by pool
    const orphansByPool = {};
    for (const orph of probe.orphanPositions) {
        if (SKIP_POOLS.has(orph.aid)) continue;
        if (!orphansByPool[orph.aid]) orphansByPool[orph.aid] = [];
        orphansByPool[orph.aid].push(orph);
    }
    const orphanPoolIds = Object.keys(orphansByPool).map(Number).sort((a, b) => a - b);
    let plannedRecovery = 0n;
    for (const aid of orphanPoolIds) for (const o of orphansByPool[aid]) plannedRecovery += BigInt(o.amount);
    log(`Plan: migrate orphans in ${orphanPoolIds.length} pools → master, then withdraw`);
    log(`  Planned recovery: ${fmt(plannedRecovery)} USDC (skipping pool 124 = ${fmt(probe.pools.find(p => p.aid === 124)?.poolOrphan || '0')} USDC at cap)`);

    // =========== PHASE B: orphan migration ===========
    log('\n=== PHASE B: Orphan position migration ===');
    const ts = Math.floor(Date.now() / 1000);
    for (const aid of orphanPoolIds) {
        log(`\nPool ${aid} (${orphansByPool[aid].length} orphans)`);
        let masterAmount = 0n;
        // Check if master is already in poolLenders for this pool (positions[aid][owner] may have value)
        const masterPos = await withRetry(() => v6.positions(aid, owner.address));
        if (masterPos.amount > 0n) {
            masterAmount = masterPos.amount;
            log(`  master already has ${fmt(masterAmount)} position`);
        }
        for (const o of orphansByPool[aid]) {
            const orphanAmt = BigInt(o.amount);
            try {
                // Step 1: zero orphan
                await withRetry(() => v6.seedPosition(aid, o.lender, 0, 0, 0).then(t => t.wait()));
                masterAmount += orphanAmt;
                // Step 2: credit master with new running total
                await withRetry(() => v6.seedPosition(aid, owner.address, masterAmount, 0, ts).then(t => t.wait()));
                log(`  zeroed ${o.lender.slice(0, 10)}... (${fmt(orphanAmt)} USDC) → master now ${fmt(masterAmount)} USDC`);
            } catch (e) {
                log(`  ✗ migration failed for ${o.lender.slice(0, 10)}...: ${(e.shortMessage || e.message).slice(0, 80)}`);
                break;
            }
            await sleep(200);
        }
    }

    // =========== PHASE C: withdraw master's positions ===========
    log('\n=== PHASE C: Master withdraws from migrated pools ===');
    let withdrawnTotal = 0n;
    for (const aid of orphanPoolIds) {
        try {
            const pos = await withRetry(() => v6.positions(aid, owner.address));
            const pool = await withRetry(() => v6.getAgentPool(aid));
            const withdrawable = pos.amount < pool[2] ? pos.amount : pool[2]; // limited by availableLiquidity
            if (withdrawable === 0n) {
                log(`  pool ${aid}: master position=${fmt(pos.amount)}, avail=${fmt(pool[2])} — skip`);
                continue;
            }
            await withRetry(() => v6.withdrawLiquidity(aid, withdrawable).then(t => t.wait()));
            withdrawnTotal += withdrawable;
            log(`  pool ${aid}: withdrew ${fmt(withdrawable)} USDC ${withdrawable < pos.amount ? '(partial — ' + fmt(pos.amount - withdrawable) + ' locked in active loans)' : ''}`);
            await sleep(200);
        } catch (e) {
            log(`  pool ${aid}: withdraw failed: ${(e.shortMessage || e.message).slice(0, 80)}`);
        }
    }

    // =========== PHASE A: recover from persisted-keys positions ===========
    // (12k USDC already withdrawn in earlier recovery_mega_stress_wallets.js run; verify whether any remain)
    log('\n=== PHASE A: Verify persisted-key positions are drained ===');
    // The recoverable positions per probe — most should already be drained. Re-check.
    const recoverablePos = probe.recoverablePositions;
    let leftover = 0n;
    for (const r of recoverablePos) {
        try {
            const pos = await withRetry(() => v6.positions(r.aid, r.lender));
            if (pos.amount > 0n) leftover += pos.amount;
        } catch (e) {}
    }
    log(`  leftover in persisted-key positions: ${fmt(leftover)} USDC (likely partial-withdraw residuals; can re-run recover_mega_stress_wallets if needed)`);

    const endMaster = await usdc.balanceOf(owner.address);
    log('\n===========================================================');
    log(`  Recovery complete`);
    log(`  Master USDC delta: +${fmt(endMaster - startMaster)} USDC`);
    log(`  Master final balance: ${fmt(endMaster)} USDC`);
    log(`  Withdrawn from migrated pools: ${fmt(withdrawnTotal)} USDC`);
    log(`  Stranded (pool 124 at cap): ${fmt(BigInt(probe.pools.find(p => p.aid === 124)?.poolOrphan || '0'))} USDC`);
    log('===========================================================');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
