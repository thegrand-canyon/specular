/**
 * Deploy the Specular V7 credit model — ReputationManagerV4 + AgentLiquidityMarketplaceV62
 * — against an EXISTING AgentRegistryV2 and USDC on a chosen network.
 *
 * Why both contracts: the tier table was hardcoded in ReputationManagerV3 and the
 * marketplace holds `reputationManager` as `immutable`, so fixing F-04 is a fresh
 * deploy of the pair. The registry (and therefore every agent NFT) persists.
 *
 * ⚠️ REPUTATION DOES NOT MIGRATE. V4 deliberately ships no seeding helper — a seed
 * path is exactly the F-08 owner-drain shape we just closed. Every agent restarts at
 * score 0 / bootstrap limit. Deploy while the population is small.
 *
 * SAFETY: dry run by default. DEPLOY_CONFIRM=YES to broadcast. Network is REQUIRED.
 * The old marketplace is NOT touched (no pause, no revoke): per the 2026-09 audit,
 * pause() freezes lender exits, and revoking its pool would break repayment. Retire
 * it separately once it holds nothing.
 *
 * Usage:
 *   node scripts/deploy-v7.js --network arc-staging
 *   DEPLOY_CONFIRM=YES node scripts/deploy-v7.js --network arc-staging
 *   DEPLOY_CONFIRM=YES node scripts/deploy-v7.js --network arc-mainnet
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const NETWORKS = {
    'arc-staging': { file: 'src/config/arc-testnet-v6-addresses.json', rpc: process.env.ARC_TESTNET_RPC_URL || 'https://rpc.testnet.arc.io', chainId: 5042002, real: false },
    'arc-mainnet': { file: 'src/config/arc-mainnet-addresses.json',    rpc: process.env.ARC_MAINNET_RPC_URL || 'https://rpc.mainnet.arc.io',  chainId: 5042,    real: true  },
};
const netArg = process.argv[process.argv.indexOf('--network') + 1];
const NET = NETWORKS[netArg];
if (!NET) { console.error(`--network required: ${Object.keys(NETWORKS).join(' | ')}`); process.exit(1); }
const DRY = process.env.DEPLOY_CONFIRM !== 'YES';

// Launch config. Marketplace levers mirror the live V6.1 settings; the V4 ladder
// parameters are the validated defaults from V7_DESIGN_AND_VALIDATION.md.
const LEVERS = {
    bind: (process.env.SPECULAR_BIND_BORROW ?? '1') === '1',
    minHold: BigInt(process.env.SPECULAR_MIN_HOLD_SECONDS ?? '86400'),
    minSupply: BigInt(process.env.SPECULAR_MIN_SUPPLY ?? '10000000'),   // 10 USDC
    feeBps: BigInt(process.env.SPECULAR_PLATFORM_FEE_BPS ?? '100'),
    repRateMax: BigInt(process.env.SPECULAR_REP_RATE_MAX ?? '5'),
    repRateWindow: BigInt(process.env.SPECULAR_REP_RATE_WINDOW ?? '86400'),
};
const art = (r) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', 'core', r), 'utf8'));

async function main() {
    const cfgPath = path.join(__dirname, '..', NET.file);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const provider = new ethers.JsonRpcProvider(NET.rpc, NET.chainId, { batchMaxCount: 1 });
    const live = await provider.getNetwork();
    if (Number(live.chainId) !== NET.chainId) { console.error(`chainId mismatch ${live.chainId} != ${NET.chainId}`); process.exit(1); }
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    const R4 = art('ReputationManagerV4.sol/ReputationManagerV4.json');
    const M62 = art('AgentLiquidityMarketplaceV62.sol/AgentLiquidityMarketplaceV62.json');
    const registryAddr = cfg.agentRegistryV2;
    const usdcAddr = cfg.usdc;

    console.log(`\n=== Specular V7 (ReputationManagerV4 + Marketplace V6.2) on ${netArg} ${DRY ? '[DRY RUN]' : '[LIVE BROADCAST]'} ${NET.real ? '⚠ REAL USDC' : '(testnet)'} ===`);
    console.log(`deployer   ${wallet.address}  balance ${ethers.formatEther(await provider.getBalance(wallet.address))}`);
    console.log(`registry   ${registryAddr}   (reused — agent NFTs persist)`);
    console.log(`usdc       ${usdcAddr}`);
    console.log(`current    marketplace ${cfg.agentLiquidityMarketplace_v6}  reputation ${cfg.reputationManagerV3}`);
    console.log('⚠ reputation does NOT migrate: every agent restarts at score 0 / bootstrap limit.');

    // Sanity: USDC must be a 6-decimal ERC-20 (blocks Arc's 18-decimal native view).
    const usdc = new ethers.Contract(usdcAddr, ['function decimals() view returns (uint8)', 'function symbol() view returns (string)'], provider);
    const dec = Number(await usdc.decimals());
    if (dec !== 6) { console.error(`USDC decimals ${dec} != 6 — refusing.`); process.exit(1); }
    console.log(`usdc check ${await usdc.symbol()} ${dec} dec ✅`);

    const f4 = new ethers.ContractFactory(R4.abi, R4.bytecode, wallet);
    const f62 = new ethers.ContractFactory(M62.abi, M62.bytecode, wallet);
    const gas4 = await provider.estimateGas({ ...(await f4.getDeployTransaction(registryAddr)), from: wallet.address });
    const gp = (await provider.getFeeData()).gasPrice;
    console.log(`\nplan: deploy ReputationManagerV4(registry) ~${gas4} gas → deploy V6.2(registry, V4, usdc) → V4.authorizePool(V6.2) → levers ${JSON.stringify({ ...LEVERS, minHold: String(LEVERS.minHold), minSupply: String(LEVERS.minSupply), feeBps: String(LEVERS.feeBps), repRateMax: String(LEVERS.repRateMax), repRateWindow: String(LEVERS.repRateWindow) })} → V6.2.setMigrationFinalized()`);
    console.log(`       (old marketplace + reputation are left running and untouched)`);
    if (DRY) { console.log(`\nDRY RUN — nothing broadcast. gasPrice ${ethers.formatUnits(gp, 'gwei')} gwei. Set DEPLOY_CONFIRM=YES to execute.`); return; }

    console.log('\n⚠ broadcasting in 5s...'); await new Promise(r => setTimeout(r, 5000));
    const rep = await f4.deploy(registryAddr); await rep.waitForDeployment();
    const repAddr = await rep.getAddress(); console.log(`✅ ReputationManagerV4 ${repAddr}`);
    const mp = await f62.deploy(registryAddr, repAddr, usdcAddr); await mp.waitForDeployment();
    const mpAddr = await mp.getAddress(); console.log(`✅ AgentLiquidityMarketplaceV62 ${mpAddr} (VERSION ${await mp.VERSION()})`);

    await (await rep.authorizePool(mpAddr)).wait(); console.log('✅ reputation.authorizePool(marketplace)');
    if (LEVERS.bind) { await (await mp.setBindBorrowToPoolCreator(true)).wait(); console.log('✅ M-1'); }
    await (await mp.setMinHoldForReputationReward(LEVERS.minHold)).wait(); console.log(`✅ M-2 ${LEVERS.minHold}s`);
    await (await mp.setMinSupplyAmount(LEVERS.minSupply)).wait(); console.log(`✅ F-C minSupply ${LEVERS.minSupply}`);
    await (await mp.setPlatformFeeRate(LEVERS.feeBps)).wait(); console.log(`✅ fee ${LEVERS.feeBps} bps`);
    await (await rep.setReputationRateLimit(LEVERS.repRateMax, LEVERS.repRateWindow)).wait(); console.log(`✅ rate limit ${LEVERS.repRateMax}/${LEVERS.repRateWindow}s`);
    await (await mp.setMigrationFinalized()).wait(); console.log('✅ setMigrationFinalized (F-08 closed at deploy)');

    // Read back the on-chain tier table so the recorded config is authoritative.
    const tiers = [];
    for (let i = 0; i < 6; i++) tiers.push(String(await rep.tierLimits(i)));
    console.log(`✅ tier limits on-chain: [${tiers.join(', ')}] (MAX_TIER_LIMIT ${String(await rep.MAX_TIER_LIMIT())})`);

    // Superseded deployments APPEND to a list; they must never overwrite each other.
    // A fixed `*_legacy` key loses the previous generation on the second redeploy — that
    // happened on Arc staging 2026-09-22 and dropped the last reference to a marketplace
    // still holding lender funds. An address we cannot name is an address we cannot
    // monitor, drain or retire.
    cfg.supersededDeployments = Array.isArray(cfg.supersededDeployments) ? cfg.supersededDeployments : [];
    const alreadyRecorded = (a) => cfg.supersededDeployments.some(d => (d.marketplace || '').toLowerCase() === (a || '').toLowerCase());
    if (cfg.agentLiquidityMarketplace_v6 && !alreadyRecorded(cfg.agentLiquidityMarketplace_v6)) {
        cfg.supersededDeployments.push({
            supersededAt: new Date().toISOString(),
            marketplace: cfg.agentLiquidityMarketplace_v6,
            reputationManager: cfg.reputationManagerV3,
            version: cfg.marketplaceVersion || 'unknown',
            note: 'Left running and authorized on purpose: pause() freezes lender exits and revoking its pool breaks repayment. Monitor it (V6_MONITOR_MARKETPLACE) until drained, then retire.',
        });
    }
    // Back-compat single-value pointers to the MOST RECENT superseded stack.
    cfg.reputationManagerPrevious = cfg.reputationManagerV3;
    cfg.agentLiquidityMarketplacePrevious = cfg.agentLiquidityMarketplace_v6;
    cfg.reputationManagerV4 = repAddr;
    cfg.agentLiquidityMarketplace_v62 = mpAddr;
    cfg.agentLiquidityMarketplace_v6 = mpAddr;   // canonical pointer clients follow
    cfg.reputationManagerV3 = repAddr;           // canonical pointer clients follow
    cfg.marketplaceVersion = 'V6.2 + ReputationManagerV4 (V7 credit model: M1 ladder + M2 self-stake)';
    cfg.v7DeployedAt = new Date().toISOString();
    cfg.v7Note = 'Reputation did NOT migrate from the V3 manager; agents restart at score 0. Legacy contracts remain live under *_legacy keys.';
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`\n✅ ${NET.file} updated. Next: Sourcify-verify both, run the E2E rehearsal, update CLAUDE.md.`);
    console.log('\n⚠️  MONITORING: the canonical pointer now names the V6.2 marketplace, so the');
    console.log('    invariant monitor follows V7 and STOPS WATCHING the superseded deployment —');
    console.log('    which still holds lender funds and may have open loans. Add a second job:');
    // Address form, NOT a config key: superseded stacks now live in the
    // `supersededDeployments` LIST, so no fixed key resolves them. Printing a key that
    // does not exist would make the monitor exit(2) and alert forever while watching
    // nothing — the precise failure this second job exists to prevent.
    console.log(`      V6_MONITOR_NETWORK=${netArg} V6_MONITOR_MARKETPLACE=${cfg.agentLiquidityMarketplacePrevious} \\`);
    console.log('        node forensics/monitor/v6-invariants.js');
    console.log('    Keep it running until that contract is drained and retired.');
}
main().catch((e) => { console.error(e); process.exit(1); });
