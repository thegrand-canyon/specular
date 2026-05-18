/**
 * Base v4 → V6 migration. The Base v4 pool 1 has only ONE lender (the secure
 * wallet itself, also the agent owner) supplying 1.5 USDC. Migration: withdraw
 * from v4, create V6 pool, re-supply to V6, finalize, pause v4.
 *
 * Run: npx hardhat run scripts/migrate-base-v4-to-v6.js --network base
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
    const [deployer] = await ethers.getSigners();
    const network = await ethers.provider.getNetwork();
    if (network.chainId !== 8453n) { console.error('Not Base mainnet'); process.exit(1); }

    const cfgPath = path.join(__dirname, '..', 'src', 'config', 'base-addresses.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const V4 = cfg.agentLiquidityMarketplace;
    const V6 = cfg.agentLiquidityMarketplace_v6;
    const USDC = cfg.usdc;

    if (!V6) { console.error('V6 not deployed'); process.exit(1); }
    if (deployer.address.toLowerCase() !== '0x800e305a0cadde6289dfdfedf38218f45c06f72c') {
        console.error('Wrong deployer'); process.exit(1);
    }

    console.log('\n🔄 BASE v4 → V6 MIGRATION');
    console.log('═══════════════════════════════════════════════════════');
    console.log('Deployer:', deployer.address);
    console.log('v4:', V4);
    console.log('V6:', V6);

    const v4Abi = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts/contracts/core/AgentLiquidityMarketplace.sol/AgentLiquidityMarketplace.json'))).abi;
    const v6Abi = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts/contracts/core/AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json'))).abi;
    const usdcAbi = ['function balanceOf(address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function allowance(address,address) view returns (uint256)'];

    const v4 = new ethers.Contract(V4, v4Abi, deployer);
    const v6 = new ethers.Contract(V6, v6Abi, deployer);
    const usdc = new ethers.Contract(USDC, usdcAbi, deployer);

    const ethBal = await ethers.provider.getBalance(deployer.address);
    const usdcBal = await usdc.balanceOf(deployer.address);
    console.log(`Pre: ETH=${ethers.formatEther(ethBal)}, USDC=${ethers.formatUnits(usdcBal, 6)}`);

    // ====== STEP 1: v4 withdraw ======
    console.log('\n[1] v4.withdrawLiquidity(1, 1.5 USDC)');
    await sleep(2000);
    const pos = await v4.positions(1, deployer.address);
    console.log(`    secure wallet position on v4 pool 1: ${ethers.formatUnits(pos.amount, 6)} USDC`);
    if (pos.amount > 0n) {
        const tx = await v4.withdrawLiquidity(1, pos.amount);
        console.log(`    tx: ${tx.hash}`);
        await tx.wait();
        console.log(`    ✓ withdrew ${ethers.formatUnits(pos.amount, 6)} USDC`);
    } else {
        console.log(`    ✓ already 0, skipping`);
    }
    await sleep(2000);

    // ====== STEP 2: V6 createAgentPool ======
    console.log('\n[2] V6.createAgentPool() (as agent 1 owner)');
    const v6Pool = await v6.agentPools(1);
    if (v6Pool.isActive) {
        console.log('    ✓ pool 1 already exists on V6, skipping');
    } else {
        const tx = await v6.createAgentPool();
        console.log(`    tx: ${tx.hash}`);
        await tx.wait();
        console.log('    ✓ created V6 pool 1');
    }
    await sleep(2000);

    // ====== STEP 3: approve V6 ======
    console.log('\n[3] usdc.approve(V6, MaxUint256)');
    const allow = await usdc.allowance(deployer.address, V6);
    if (allow < ethers.MaxUint256 / 2n) {
        const tx = await usdc.approve(V6, ethers.MaxUint256);
        console.log(`    tx: ${tx.hash}`);
        await tx.wait();
        console.log('    ✓ approved');
    } else {
        console.log('    ✓ already approved');
    }
    await sleep(2000);

    // ====== STEP 4: V6 supplyLiquidity ======
    console.log('\n[4] V6.supplyLiquidity(1, available USDC)');
    const finalUsdcBal = await usdc.balanceOf(deployer.address);
    const supplyAmt = ethers.parseUnits('1.5', 6) < finalUsdcBal ? ethers.parseUnits('1.5', 6) : finalUsdcBal;
    console.log(`    supplying ${ethers.formatUnits(supplyAmt, 6)} USDC`);
    if (supplyAmt > 0n) {
        const tx = await v6.supplyLiquidity(1, supplyAmt);
        console.log(`    tx: ${tx.hash}`);
        await tx.wait();
        console.log('    ✓ supplied to V6 pool 1');
    }
    await sleep(2000);

    // ====== STEP 5: V6 setMigrationFinalized ======
    console.log('\n[5] V6.setMigrationFinalized() (locks seedPool/seedPosition irreversibly)');
    const finalized = await v6.migrationFinalized();
    if (finalized) {
        console.log('    ✓ already finalized');
    } else {
        const tx = await v6.setMigrationFinalized();
        console.log(`    tx: ${tx.hash}`);
        await tx.wait();
        console.log('    ✓ migration finalized — seedPool/seedPosition locked');
    }
    await sleep(2000);

    // ====== STEP 6: v4 pause ======
    console.log('\n[6] v4.pause() (prevents new v4 activity)');
    const paused = await v4.paused();
    if (paused) {
        console.log('    ✓ already paused');
    } else {
        const tx = await v4.pause();
        console.log(`    tx: ${tx.hash}`);
        await tx.wait();
        console.log('    ✓ v4 paused');
    }

    // Final state
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('   FINAL STATE');
    console.log('═══════════════════════════════════════════════════════');
    const v6PoolFinal = await v6.getAgentPool(1);
    console.log('V6 pool 1: totalLiq=' + ethers.formatUnits(v6PoolFinal.totalLiquidity, 6) + ', avail=' + ethers.formatUnits(v6PoolFinal.availableLiquidity, 6));
    console.log('v4 paused:', await v4.paused());
    console.log('V6 migrationFinalized:', await v6.migrationFinalized());
    const endEthBal = await ethers.provider.getBalance(deployer.address);
    const endUsdcBal = await usdc.balanceOf(deployer.address);
    console.log('Master: ETH=' + ethers.formatEther(endEthBal) + ' (Δ ' + ethers.formatEther(endEthBal - ethBal) + ')');
    console.log('Master: USDC=' + ethers.formatUnits(endUsdcBal, 6) + ' (Δ ' + ethers.formatUnits(endUsdcBal - usdcBal, 6) + ')');
    console.log('\n✅ MIGRATION COMPLETE');
    console.log('\nNext: update src/config/base-addresses.json + frontend/js/config.js to point at V6 as canonical.');
}

main().catch(e => { console.error(e); process.exit(1); });
