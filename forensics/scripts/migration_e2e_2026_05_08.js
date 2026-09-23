// End-to-end v4→V6 migration simulation on Arc.
// Practice run for the Base mainnet migration.
//
// Sequence:
//   1. Fresh lender (test wallet) supplies USDC to v4
//   2. Owner snapshots v4 state for the lender's pool
//   3. Lender withdraws from v4
//   4. Owner: seedPool + seedPosition on V6 with snapshot data
//   5. Lender supplies the same USDC to V6
//   6. Verify state matches v4 snapshot
//   7. Owner: setMigrationFinalized() — locks seed* permanently
//   8. Verify post-finalization state
//
// We use a NEW agent (not pool 49 which has migrationFinalized=false but lots of state)
// so the migration is clean. Use seedPool to set up an arbitrary fresh pool.

require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC = process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org';
const ADDR = JSON.parse(fs.readFileSync('./src/config/arc-testnet-addresses.json'));
const V4 = ADDR.agentLiquidityMarketplace;
const V6 = ADDR.agentLiquidityMarketplace_v6;
const ABI4 = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json')).abi;
const ABI6 = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json')).abi;
const REG_ABI = JSON.parse(fs.readFileSync('./artifacts/contracts/core/AgentRegistryV2.sol/AgentRegistryV2.json')).abi;
const USDC_ABI = ['function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)', 'function transfer(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'];
const fmt = v => Number(ethers.formatUnits(v, 6));
const OUT = './forensics/output/regression-2026-05-07';

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function withRetry(fn, label, attempts = 8) {
    for (let i = 0; i < attempts; i++) {
        try { return await fn(); }
        catch (e) {
            const m = e.shortMessage || e.message || '';
            const isRate = m.includes('rate') || m.includes('408') || m.includes('410') || m.includes('429') || m.includes('-32016') || m.includes('timeout');
            if (i === attempts - 1 || !isRate) throw e;
            await sleep(2000 * Math.pow(2, i));
        }
    }
}

const log = (...a) => console.log(...a);

(async () => {
    const provider = new ethers.JsonRpcProvider(RPC, undefined, { batchMaxCount: 1 });
    const owner = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const v4 = new ethers.Contract(V4, ABI4, owner);
    const v6 = new ethers.Contract(V6, ABI6, owner);
    const reg = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, owner);
    const usdc = new ethers.Contract(ADDR.usdc, USDC_ABI, owner);

    log('=== v4→V6 MIGRATION SIMULATION ===');
    log(`Owner: ${owner.address}`);

    // Generate fresh test agent (the borrower side)
    const testAgent = ethers.Wallet.createRandom().connect(provider);
    log(`\n[setup] fresh test agent: ${testAgent.address}`);
    const testLender = ethers.Wallet.createRandom().connect(provider);
    log(`[setup] fresh test lender: ${testLender.address}`);

    // Fund both wallets
    log(`\n[1] funding wallets`);
    const FUND_ETH = ethers.parseEther('0.05');
    const SUPPLY = ethers.parseUnits('200', 6);
    const COLLATERAL = ethers.parseUnits('110', 6);  // for test agent

    for (const [w, amt] of [[testAgent, COLLATERAL], [testLender, ethers.parseUnits('200', 6)]]) {
        const e = await withRetry(() => owner.sendTransaction({ to: w.address, value: FUND_ETH }), 'fundETH');
        await withRetry(() => e.wait(), 'fundETH.wait');
        const u = await withRetry(() => usdc.transfer(w.address, amt), 'fundUSDC');
        await withRetry(() => u.wait(), 'fundUSDC.wait');
    }

    // Register test agent
    log(`\n[2] register test agent in AgentRegistryV2`);
    const agentReg = new ethers.Contract(ADDR.agentRegistryV2, REG_ABI, testAgent);
    const regTx = await withRetry(() => agentReg.register('ipfs://migration-test-agent', []), 'reg');
    await withRetry(() => regTx.wait(), 'reg.wait');
    const testAgentId = await withRetry(() => reg.addressToAgentId(testAgent.address), 'aid');
    log(`  test agent registered as agentId=${testAgentId}`);

    // === STEP A: lender supplies to v4 ===
    log(`\n=== STEP A: agent creates pool + lender supplies to v4 ===`);
    const v4Agent = new ethers.Contract(V4, ABI4, testAgent);
    const cpTx = await withRetry(() => v4Agent.createAgentPool(), 'v4.cp');
    await withRetry(() => cpTx.wait(), 'v4.cp.wait');
    log(`  v4 pool created for agentId=${testAgentId}`);

    const v4Lender = new ethers.Contract(V4, ABI4, testLender);
    const usdcLender = new ethers.Contract(ADDR.usdc, USDC_ABI, testLender);
    await withRetry(() => usdcLender.approve(V4, SUPPLY).then(t => t.wait()), 'v4.approve');
    await withRetry(() => v4Lender.supplyLiquidity(testAgentId, SUPPLY).then(t => t.wait()), 'v4.supply');
    log(`  lender supplied ${fmt(SUPPLY)} USDC to v4`);

    // === STEP B: owner snapshots v4 state ===
    log(`\n=== STEP B: owner snapshots v4 state ===`);
    const v4Pool = await withRetry(() => v4.getAgentPool(testAgentId), 'v4.pool');
    const v4Pos = await withRetry(() => v4.positions(testAgentId, testLender.address), 'v4.pos');
    const snapshot = {
        agentId: Number(testAgentId), agentAddress: testAgent.address,
        totalLiquidity: v4Pool.totalLiquidity.toString(),
        availableLiquidity: v4Pool.availableLiquidity.toString(),
        totalEarned: v4Pool.totalEarned.toString(),
        lender: testLender.address,
        amount: v4Pos.amount.toString(),
        earnedInterest: v4Pos.earnedInterest.toString(),
        depositTimestamp: v4Pos.depositTimestamp.toString(),
    };
    log('  snapshot:', JSON.stringify(snapshot, null, 2));

    // === STEP C: lender withdraws from v4 ===
    log(`\n=== STEP C: lender withdraws from v4 ===`);
    const wdTx = await withRetry(() => v4Lender.withdrawLiquidity(testAgentId, SUPPLY), 'v4.wd');
    await withRetry(() => wdTx.wait(), 'v4.wd.wait');
    log(`  withdrawn`);
    const lenderBalAfterWd = await withRetry(() => usdc.balanceOf(testLender.address), 'lenderBal');
    log(`  lender USDC balance: ${fmt(lenderBalAfterWd)}`);

    // === STEP D: owner seeds V6 from snapshot ===
    log(`\n=== STEP D: owner seeds V6 ===`);
    const sp1 = await withRetry(() => v6.seedPool(
        snapshot.agentId, snapshot.agentAddress,
        snapshot.totalLiquidity, snapshot.availableLiquidity, snapshot.totalEarned
    ), 'seedPool');
    await withRetry(() => sp1.wait(), 'seedPool.wait');
    log(`  seedPool tx: ${sp1.hash}`);
    const sp2 = await withRetry(() => v6.seedPosition(
        snapshot.agentId, snapshot.lender,
        snapshot.amount, snapshot.earnedInterest, snapshot.depositTimestamp
    ), 'seedPos');
    await withRetry(() => sp2.wait(), 'seedPos.wait');
    log(`  seedPosition tx: ${sp2.hash}`);

    // Verify V6 matches snapshot
    const v6Pool = await withRetry(() => v6.getAgentPool(snapshot.agentId), 'v6.pool');
    const v6Pos = await withRetry(() => v6.positions(snapshot.agentId, testLender.address), 'v6.pos');
    log(`  V6 pool: totalLiq=${v6Pool.totalLiquidity.toString()}, avail=${v6Pool.availableLiquidity.toString()}, lenders=${v6Pool.lenderCount}`);
    log(`  V6 pos:  amount=${v6Pos.amount.toString()}, earnedInt=${v6Pos.earnedInterest.toString()}`);
    const stateMatch =
        v6Pool.totalLiquidity.toString() === snapshot.totalLiquidity &&
        v6Pool.availableLiquidity.toString() === snapshot.availableLiquidity &&
        v6Pos.amount.toString() === snapshot.amount;
    log(`  ${stateMatch ? '✅' : '❌'} V6 state matches v4 snapshot`);

    // === STEP E: lender supplies USDC to V6 (NOTE: in seed-mode, V6 has no actual USDC backing) ===
    // For real migration, the seeded position represents USDC the lender will supply.
    // Lender now needs to physically move USDC from their wallet to V6.
    log(`\n=== STEP E: lender supplies USDC to V6 ===`);
    // Lender's V6 position is already at SUPPLY thanks to seedPosition. To make USDC custody match,
    // they need to either: (a) mint or (b) the protocol owner transfers USDC into V6 to back the seed.
    // In a real migration, lenders would withdraw from v4 (gets USDC) and supply to V6 (deposits USDC).
    //
    // Since we already did withdraw, we now need lender to supply matching USDC. But we already
    // seeded their position as if they had supplied. So if we supply again, position would double.
    //
    // Correct migration model: ONE of these two paths:
    //   (a) Owner uses seed* AND lender does NOT re-supply. Owner transfers USDC into V6 separately.
    //   (b) Owner does NOT use seed*. Lender just supplies fresh.
    //
    // (b) is cleaner and avoids state desync. Demonstrating (b):
    log(`  decision: choosing path (b) — fresh supply, NO seed (cleaner)`);
    log(`  but we already seeded, so reset by overwriting seedPosition with zero values`);
    const reset = await withRetry(() => v6.seedPosition(snapshot.agentId, testLender.address, 0, 0, 0), 'reset');
    await withRetry(() => reset.wait(), 'reset.wait');
    log(`  position reset to 0 via seedPosition with zeros`);
    // Also reset pool liquidity since we already seeded it
    const resetPool = await withRetry(() => v6.seedPool(snapshot.agentId, snapshot.agentAddress, 0, 0, 0), 'resetPool');
    await withRetry(() => resetPool.wait(), 'resetPool.wait');
    log(`  pool liquidity reset to 0`);

    // Now lender supplies fresh USDC to V6
    const v6Lender = new ethers.Contract(V6, ABI6, testLender);
    await withRetry(() => usdcLender.approve(V6, SUPPLY).then(t => t.wait()), 'v6.approve');
    const sTx = await withRetry(() => v6Lender.supplyLiquidity(snapshot.agentId, SUPPLY), 'v6.supply');
    await withRetry(() => sTx.wait(), 'v6.supply.wait');
    log(`  lender supplied ${fmt(SUPPLY)} USDC to V6`);

    // Verify V6 state matches expected
    const v6PoolFinal = await withRetry(() => v6.getAgentPool(snapshot.agentId), 'v6.poolFinal');
    const v6PosFinal = await withRetry(() => v6.positions(snapshot.agentId, testLender.address), 'v6.posFinal');
    log(`  V6 final: totalLiq=${fmt(v6PoolFinal.totalLiquidity)}, avail=${fmt(v6PoolFinal.availableLiquidity)}, lenderCount=${v6PoolFinal.lenderCount}, lender supplied=${fmt(v6PosFinal.amount)}`);
    const finalMatch =
        v6PoolFinal.totalLiquidity === SUPPLY &&
        v6PoolFinal.availableLiquidity === SUPPLY &&
        v6PoolFinal.lenderCount === 1n &&
        v6PosFinal.amount === SUPPLY;
    log(`  ${finalMatch ? '✅' : '❌'} V6 state matches expected after fresh supply`);

    // === STEP F: cleanup — return funds to owner, withdraw from V6 ===
    log(`\n=== STEP F: cleanup ===`);
    const wdV6 = await withRetry(() => v6Lender.withdrawLiquidity(snapshot.agentId, SUPPLY), 'cleanup.wd');
    await withRetry(() => wdV6.wait(), 'cleanup.wd.wait');
    const lenderBalFinal = await withRetry(() => usdc.balanceOf(testLender.address), 'lenderBalFinal');
    if (lenderBalFinal > 0n) {
        const ret = await withRetry(() => usdcLender.transfer(owner.address, lenderBalFinal), 'cleanup.return');
        await withRetry(() => ret.wait(), 'cleanup.return.wait');
        log(`  lender returned ${fmt(lenderBalFinal)} USDC`);
    }
    const agentBal = await withRetry(() => usdc.balanceOf(testAgent.address), 'agentBalFinal');
    if (agentBal > 0n) {
        const usdcAgent = new ethers.Contract(ADDR.usdc, USDC_ABI, testAgent);
        const ret = await withRetry(() => usdcAgent.transfer(owner.address, agentBal), 'cleanup.agent');
        await withRetry(() => ret.wait(), 'cleanup.agent.wait');
        log(`  agent returned ${fmt(agentBal)} USDC`);
    }

    fs.writeFileSync(path.join(OUT, '34-migration-e2e.json'), JSON.stringify({
        snapshot, stateMatchAfterSeed: stateMatch, finalMatchAfterFreshSupply: finalMatch,
    }, null, 2));
    log('\nSaved.');
})().catch(e => { console.error('FATAL:', e); process.exit(2); });
