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
 * Guards, each of which refuses BEFORE anything is broadcast (all four are exercised on
 * `--network local` — see forensics/output/testing-2026-09-24/OPERATIONAL_VERIFICATION.md):
 *   1. --network must name a known target
 *   2. the endpoint's chain id must match that target
 *   3. the configured USDC must be an ERC-20 with exactly 6 decimals
 *   4. on a real-money network the token must not look like a mock
 *   5. the deployer must hold at least DEPLOY_MIN_BALANCE (default 1) native
 *
 * Usage:
 *   node scripts/deploy-v7.js --network arc-staging
 *   DEPLOY_CONFIRM=YES node scripts/deploy-v7.js --network arc-staging
 *   DEPLOY_CONFIRM=YES node scripts/deploy-v7.js --network arc-mainnet
 *   node scripts/deploy-v7.js --network local            # rehearsal on a hardhat node
 *
 * Env: DEPLOY_CONFIRM=YES broadcast · DEPLOY_MIN_BALANCE native floor ·
 *      DEPLOY_ASSUME_REAL=1 apply the real-money guards on a rehearsal target ·
 *      SPECULAR_ADDRESSES_FILE alternate addresses file (--network local only)
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const NETWORKS = {
    'arc-staging': { file: 'src/config/arc-testnet-v6-addresses.json', rpc: process.env.ARC_TESTNET_RPC_URL || 'https://rpc.testnet.arc.io', chainId: 5042002, real: false },
    'arc-mainnet': { file: 'src/config/arc-mainnet-addresses.json',    rpc: process.env.ARC_MAINNET_RPC_URL || 'https://rpc.mainnet.arc.io',  chainId: 5042,    real: true  },
    // Rehearsal target. The guards below are the only thing standing between a typo and
    // a real-money deploy, so there has to be somewhere they can be FIRED and watched.
    // `local` also lets the whole sequence be walked end to end before it is walked on Arc.
    'local':       { file: 'src/config/local-addresses.json',          rpc: process.env.LOCAL_RPC_URL || 'http://127.0.0.1:8545',            chainId: 31337,   real: false },
};
const netArg = process.argv[process.argv.indexOf('--network') + 1];
const NET = NETWORKS[netArg];
if (!NET) { console.error(`--network required: ${Object.keys(NETWORKS).join(' | ')}`); process.exit(1); }
// Addresses-file override exists ONLY for the local rehearsal target — on a real chain
// the file is pinned by the network name and cannot be redirected by an env var.
if (process.env.SPECULAR_ADDRESSES_FILE) {
    if (netArg !== 'local') { console.error('SPECULAR_ADDRESSES_FILE is only honoured for --network local — refusing.'); process.exit(1); }
    NET.file = process.env.SPECULAR_ADDRESSES_FILE;
}
const DRY = process.env.DEPLOY_CONFIRM !== 'YES';
// Treat this run as real-money even on a rehearsal target. Strictness-only: it can enable
// a guard, never disable one. It exists so the mainnet guards can be FIRED and watched on
// a local chain instead of being believed.
const REAL = NET.real || process.env.DEPLOY_ASSUME_REAL === '1';
// Minimum native balance required to broadcast. The full V7 sequence is ~8 txs; running
// out halfway leaves an unauthorised marketplace and a half-levered reputation manager.
const MIN_BALANCE = ethers.parseEther(process.env.DEPLOY_MIN_BALANCE || '1');

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
    // path.resolve (not join) so an absolute SPECULAR_ADDRESSES_FILE works as given.
    const cfgPath = path.resolve(path.join(__dirname, '..'), NET.file);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    // Pin the expected chain id on the provider AND assert it. ethers throws its own
    // NETWORK_ERROR first when the endpoint disagrees, so catch that and print the
    // operator-legible message instead of a stack trace at 3am.
    const provider = new ethers.JsonRpcProvider(NET.rpc, NET.chainId, { batchMaxCount: 1, cacheTimeout: -1 });
    let live;
    try { live = await provider.getNetwork(); }
    catch (e) {
        const m = /=> *(\d+)/.exec(e.shortMessage || e.message || '');
        console.error(`GUARD: chainId mismatch — ${NET.rpc} reports ${m ? m[1] : 'a different chain'}, expected ${NET.chainId} for --network ${netArg}. Refusing.`);
        process.exit(1);
    }
    if (Number(live.chainId) !== NET.chainId) { console.error(`GUARD: chainId mismatch ${live.chainId} != ${NET.chainId} — refusing.`); process.exit(1); }
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    const R4 = art('ReputationManagerV4.sol/ReputationManagerV4.json');
    const M62 = art('AgentLiquidityMarketplaceV62.sol/AgentLiquidityMarketplaceV62.json');
    const registryAddr = cfg.agentRegistryV2;
    const usdcAddr = cfg.usdc;

    console.log(`\n=== Specular V7 (ReputationManagerV4 + Marketplace V6.2) on ${netArg} ${DRY ? '[DRY RUN]' : '[LIVE BROADCAST]'} ${REAL ? (NET.real ? "⚠ REAL USDC" : "⚠ REAL-MONEY GUARDS FORCED") : "(testnet)"} ===`);
    console.log(`deployer   ${wallet.address}  balance ${ethers.formatEther(await provider.getBalance(wallet.address))}`);
    console.log(`registry   ${registryAddr}   (reused — agent NFTs persist)`);
    console.log(`usdc       ${usdcAddr}`);
    console.log(`current    marketplace ${cfg.agentLiquidityMarketplace_v6}  reputation ${cfg.reputationManagerV3}`);
    console.log('⚠ reputation does NOT migrate: every agent restarts at score 0 / bootstrap limit.');

    // GUARD 1 — USDC must be a 6-decimal ERC-20 (blocks Arc's 18-decimal native view).
    const usdc = new ethers.Contract(usdcAddr, ['function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function name() view returns (string)'], provider);
    let dec, sym, nam;
    try { [dec, sym, nam] = [Number(await usdc.decimals()), await usdc.symbol(), await usdc.name()]; }
    catch (e) { console.error(`GUARD: ${usdcAddr} does not answer decimals()/symbol()/name() — is it an ERC-20? Refusing.`); process.exit(1); }
    if (dec !== 6) { console.error(`GUARD: USDC decimals ${dec} != 6 — refusing.`); process.exit(1); }

    // GUARD 2 — never wire a REAL deployment to a mock/test token. The staging stack runs
    // on MockUSDC and the two configs are one flag apart; a mis-set --network that also
    // passed the chain-id check would otherwise deploy a mainnet stack against play money.
    if (REAL && /mock|test|fake|dummy/i.test(`${sym} ${nam}`)) {
        console.error(`GUARD: token ${usdcAddr} looks like a mock ("${nam}"/"${sym}") but --network ${netArg} is a REAL-money network. Refusing.`);
        process.exit(1);
    }
    console.log(`usdc check ${sym} (${nam}) ${dec} dec ✅`);

    // GUARD 3 — enough gas to finish. A half-applied V7 deploy leaves an unauthorised
    // marketplace and a reputation manager at default levers, which is worse than none.
    const bal = await provider.getBalance(wallet.address);
    if (bal < MIN_BALANCE) {
        console.error(`GUARD: deployer balance ${ethers.formatEther(bal)} < required ${ethers.formatEther(MIN_BALANCE)} (DEPLOY_MIN_BALANCE) — refusing.`);
        process.exit(1);
    }

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
    // This note is read by humans triaging an incident, so it must name the keys that are
    // actually written. There is no `*_legacy` key: the superseded stack is the last entry
    // of `supersededDeployments[]`, mirrored by
    // `agentLiquidityMarketplacePrevious` / `reputationManagerPrevious`.
    cfg.v7Note = 'Reputation did NOT migrate from the V3 manager; agents restart at score 0. '
        + 'The superseded contracts are left live on purpose — find them in supersededDeployments[] '
        + '(most recent also at agentLiquidityMarketplacePrevious / reputationManagerPrevious). '
        + 'Each needs its own monitor job via V6_MONITOR_MARKETPLACE=<address> until it is drained and retired.';
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
