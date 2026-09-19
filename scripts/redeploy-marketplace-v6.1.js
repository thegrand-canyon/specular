/**
 * Redeploy ONLY the marketplace (V6.1 — 2026-09-19 audit fixes F-01/02/03/05/07) on an
 * existing Specular stack, keeping AgentRegistryV2 / ReputationManagerV3 / Faucet as-is.
 *
 * Steps: deploy V6.1(registry, reputation, usdc) → reputation.authorizePool(new) →
 *        levers on new → new.setMigrationFinalized() [F-08: fresh deploy needs no migration]
 *        → retire old: withdrawFees, pause, reputation.revokePool(old)  [only if old has no ACTIVE loans]
 *        → rewrite the addresses JSON (old kept under agentLiquidityMarketplace_v6_0_retired).
 *
 * SAFETY: dry run by default. DEPLOY_CONFIRM=YES to broadcast. Network is REQUIRED.
 *
 * Usage:
 *   node scripts/redeploy-marketplace-v6.1.js --network arc-staging     # testnet rehearsal (dry)
 *   DEPLOY_CONFIRM=YES node scripts/redeploy-marketplace-v6.1.js --network arc-staging
 *   node scripts/redeploy-marketplace-v6.1.js --network arc-mainnet     # REAL MONEY (dry)
 *   DEPLOY_CONFIRM=YES node scripts/redeploy-marketplace-v6.1.js --network arc-mainnet
 * Lever env (same names as deploy-arc-mainnet.js): SPECULAR_BIND_BORROW=1,
 *   SPECULAR_MIN_HOLD_SECONDS, SPECULAR_MIN_SUPPLY, SPECULAR_PLATFORM_FEE_BPS.
 *   Defaults below mirror the 2026-09-19 mainnet launch config.
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const NETWORKS = {
    'arc-staging': { file: 'src/config/arc-testnet-v6-addresses.json', rpc: process.env.ARC_TESTNET_RPC_URL || 'https://arc-testnet.drpc.org', chainId: 5042002, real: false },
    'arc-mainnet': { file: 'src/config/arc-mainnet-addresses.json',    rpc: process.env.ARC_MAINNET_RPC_URL || 'https://rpc.mainnet.arc.io', chainId: 5042,    real: true },
};
const netArg = process.argv[process.argv.indexOf('--network') + 1];
const NET = NETWORKS[netArg];
if (!NET) { console.error(`--network required: ${Object.keys(NETWORKS).join(' | ')}`); process.exit(1); }
const DRY = process.env.DEPLOY_CONFIRM !== 'YES';
const LEVERS = {
    bind: (process.env.SPECULAR_BIND_BORROW ?? '1') === '1',
    minHold: BigInt(process.env.SPECULAR_MIN_HOLD_SECONDS ?? '86400'),
    minSupply: BigInt(process.env.SPECULAR_MIN_SUPPLY ?? '1000000'),
    feeBps: BigInt(process.env.SPECULAR_PLATFORM_FEE_BPS ?? '100'),
};
const art = (r) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', 'core', r), 'utf8'));

async function main() {
    const cfgPath = path.join(__dirname, '..', NET.file);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const provider = new ethers.JsonRpcProvider(NET.rpc, NET.chainId, { batchMaxCount: 1 });
    const live = await provider.getNetwork();
    if (Number(live.chainId) !== NET.chainId) { console.error(`chainId mismatch ${live.chainId} != ${NET.chainId}`); process.exit(1); }
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    const M = art('AgentLiquidityMarketplaceV6.sol/AgentLiquidityMarketplaceV6.json');
    const R = art('ReputationManagerV3.sol/ReputationManagerV3.json');
    const oldAddr = cfg.agentLiquidityMarketplace_v6;
    const old = new ethers.Contract(oldAddr, M.abi, wallet);
    const rep = new ethers.Contract(cfg.reputationManagerV3, R.abi, wallet);

    console.log(`\n=== Marketplace V6.1 redeploy on ${netArg} ${DRY ? '[DRY RUN]' : '[LIVE BROADCAST]'} ${NET.real ? '⚠ REAL USDC' : '(testnet)'} ===`);
    console.log(`deployer ${wallet.address}  balance ${ethers.formatEther(await provider.getBalance(wallet.address))}`);
    console.log(`registry ${cfg.agentRegistryV2}\nreputation ${cfg.reputationManagerV3}\nusdc ${cfg.usdc}\nold marketplace ${oldAddr}`);

    // Preconditions
    let oldVersion = 'V6.0 (no VERSION())'; try { oldVersion = await old.VERSION(); } catch {}
    const oldOwner = await old.owner(); const repOwner = await rep.owner();
    if (oldOwner !== wallet.address || repOwner !== wallet.address) { console.error(`deployer must own old marketplace (${oldOwner}) and reputation (${repOwner})`); process.exit(1); }
    const next = await old.nextLoanId(); let active = 0;
    for (let i = 1n; i < next; i++) if (Number((await old.loans(i)).state) === 1) active++;
    const fees = await old.accumulatedFees();
    const usdc = new ethers.Contract(cfg.usdc, ['function balanceOf(address) view returns (uint256)'], provider);
    const oldBal = await usdc.balanceOf(oldAddr);
    console.log(`old: ${oldVersion}, loans ${next - 1n}, ACTIVE ${active}, balance ${ethers.formatUnits(oldBal, 6)} USDC, fees ${ethers.formatUnits(fees, 6)}, paused ${await old.paused()}`);
    const retireOld = active === 0;
    if (!retireOld) console.log('⚠ old marketplace has ACTIVE loans — will NOT pause/revoke it (lenders/borrowers must close first).');
    if (oldBal - fees > 0n) console.log(`⚠ old marketplace holds ${ethers.formatUnits(oldBal - fees, 6)} USDC of lender/collateral funds — lenders must withdraw from the old one.`);

    const factory = new ethers.ContractFactory(M.abi, M.bytecode, wallet);
    const gas = await provider.estimateGas({ ...(await factory.getDeployTransaction(cfg.agentRegistryV2, cfg.reputationManagerV3, cfg.usdc)), from: wallet.address });
    const gp = (await provider.getFeeData()).gasPrice;
    console.log(`\nplan: deploy V6.1 (~${gas} gas ≈ ${ethers.formatEther(gas * gp)} native) → authorizePool → levers ${JSON.stringify({ ...LEVERS, minHold: String(LEVERS.minHold), minSupply: String(LEVERS.minSupply), feeBps: String(LEVERS.feeBps) })} → setMigrationFinalized → ${retireOld ? 'withdrawFees + pause + revokePool(old)' : '(old left running)'}`);
    if (DRY) { console.log('\nDRY RUN — nothing broadcast. Set DEPLOY_CONFIRM=YES to execute.'); return; }

    console.log('\n⚠ broadcasting in 5s...'); await new Promise(r => setTimeout(r, 5000));
    const mp = await factory.deploy(cfg.agentRegistryV2, cfg.reputationManagerV3, cfg.usdc); await mp.waitForDeployment();
    const newAddr = await mp.getAddress(); console.log(`✅ V6.1 marketplace ${newAddr} (VERSION ${await mp.VERSION()})`);
    await (await rep.authorizePool(newAddr)).wait(); console.log('✅ reputation.authorizePool(new)');
    if (LEVERS.bind) { await (await mp.setBindBorrowToPoolCreator(true)).wait(); console.log('✅ M-1'); }
    await (await mp.setMinHoldForReputationReward(LEVERS.minHold)).wait(); console.log(`✅ M-2 ${LEVERS.minHold}s`);
    await (await mp.setMinSupplyAmount(LEVERS.minSupply)).wait(); console.log(`✅ F-C ${LEVERS.minSupply}`);
    await (await mp.setPlatformFeeRate(LEVERS.feeBps)).wait(); console.log(`✅ fee ${LEVERS.feeBps} bps`);
    await (await mp.setMigrationFinalized()).wait(); console.log('✅ setMigrationFinalized (F-08 closed on new)');
    if (retireOld) {
        if (fees > 0n) { await (await old.withdrawFees()).wait(); console.log(`✅ old.withdrawFees ${ethers.formatUnits(fees, 6)}`); }
        if (!(await old.paused())) { await (await old.pause()).wait(); console.log('✅ old.pause()'); }
        await (await rep.revokePool(oldAddr)).wait(); console.log('✅ reputation.revokePool(old)');
    }
    cfg.agentLiquidityMarketplace_v6_0_retired = oldAddr;
    cfg.agentLiquidityMarketplace_v6 = newAddr;
    cfg.marketplaceVersion = 'V6.1 (2026-09-19 audit fixes F-01/F-02/F-03/F-05/F-07; migration finalized at deploy)';
    cfg.marketplaceRedeployedAt = new Date().toISOString();
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`\n✅ ${NET.file} updated. Next: Sourcify-verify ${newAddr}, run the smoke test, update CLAUDE.md.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
