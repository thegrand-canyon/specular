/**
 * Redeploy ONLY the marketplace (V6.1 — 2026-09-19 audit fixes F-01/02/03/05/07) on an
 * existing Specular stack, keeping AgentRegistryV2 / ReputationManagerV3 / Faucet as-is.
 *
 * Steps: deploy V6.1(registry, reputation, usdc) → reputation.authorizePool(new) →
 *        levers on new → new.setMigrationFinalized() [F-08: fresh deploy needs no migration]
 *        → retire old: withdrawFees, pause, reputation.revokePool(old)  [only if old has no ACTIVE loans]
 *        → rewrite the addresses JSON (the superseded stack is APPENDED to
 *          `supersededDeployments[]`; `agentLiquidityMarketplace_v6_0_retired` /
 *          `..._legacy_still_live` are kept only as back-compat pointers).
 *
 * ⚠️ THIS SCRIPT DEPLOYS V6.1, WHICH IS OLDER THAN WHAT IS LIVE.
 * Arc mainnet and Arc staging both run V6.2 + ReputationManagerV4 (the V7 credit model)
 * since 2026-09-22/23. Pointing this script at either of them is a DOWNGRADE: it drops the
 * M2 self-stake — the F-04 mitigation — repoints the canonical config key at the older
 * contract, and (because the live V6.2 holds nothing but its own fees) trips the retirement
 * branch, i.e. it PAUSES AND REVOKES the live canonical marketplace. A version guard now
 * refuses that; override only with ALLOW_VERSION_DOWNGRADE=YES and only deliberately.
 * For a new generation use `scripts/deploy-v7.js`.
 *
 * SAFETY: dry run by default. DEPLOY_CONFIRM=YES to broadcast. Network is REQUIRED.
 * Guards, all of which refuse before anything is broadcast: network name, chain id,
 * deployer owns both contracts, USDC is a 6-decimal non-mock ERC-20 on a real network,
 * deployer balance, and no version downgrade.
 *
 * Usage:
 *   node scripts/redeploy-marketplace-v6.1.js --network arc-staging     # testnet rehearsal (dry)
 *   DEPLOY_CONFIRM=YES node scripts/redeploy-marketplace-v6.1.js --network arc-staging
 *   node scripts/redeploy-marketplace-v6.1.js --network arc-mainnet     # REAL MONEY (dry)
 *   DEPLOY_CONFIRM=YES node scripts/redeploy-marketplace-v6.1.js --network arc-mainnet
 * Lever env (same names as deploy-arc-mainnet.js): SPECULAR_BIND_BORROW=1,
 *   SPECULAR_MIN_HOLD_SECONDS, SPECULAR_MIN_SUPPLY, SPECULAR_PLATFORM_FEE_BPS.
 *   Defaults mirror the levers actually in force on Arc mainnet (read 2026-09-24):
 *   bind on, minHold 86400 s, minSupply 10 USDC, fee 100 bps.
 */
require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const NETWORKS = {
    // Default staging RPC is rpc.testnet.arc.io, not arc-testnet.drpc.org: dRPC rate-limits
    // this host (see CLAUDE.md), and every other tool in the repo already defaults here.
    'arc-staging': { file: 'src/config/arc-testnet-v6-addresses.json', rpc: process.env.ARC_TESTNET_RPC_URL || 'https://rpc.testnet.arc.io', chainId: 5042002, real: false },
    'arc-mainnet': { file: 'src/config/arc-mainnet-addresses.json',    rpc: process.env.ARC_MAINNET_RPC_URL || 'https://rpc.mainnet.arc.io', chainId: 5042,    real: true },
    'local':       { file: 'src/config/local-addresses.json',          rpc: process.env.LOCAL_RPC_URL || 'http://127.0.0.1:8545',            chainId: 31337,   real: false },
};
const netArg = process.argv[process.argv.indexOf('--network') + 1];
const NET = NETWORKS[netArg];
if (!NET) { console.error(`--network required: ${Object.keys(NETWORKS).join(' | ')}`); process.exit(1); }
// Resume: --new <addr> skips deploy+wiring (already done) and only runs retirement + config write.
const RESUME_NEW = process.argv.includes('--new') ? ethers.getAddress(process.argv[process.argv.indexOf('--new') + 1]) : null;
const DRY = process.env.DEPLOY_CONFIRM !== 'YES';
const LEVERS = {
    bind: (process.env.SPECULAR_BIND_BORROW ?? '1') === '1',
    minHold: BigInt(process.env.SPECULAR_MIN_HOLD_SECONDS ?? '86400'),
    // 10 USDC. The old default was 1 USDC while the header claimed the defaults mirrored
    // the mainnet launch config — mainnet has been at 10 USDC since the 2026-09-19
    // post-audit tightening (minSupplyAmount == 10000000, re-read on chain 2026-09-24).
    minSupply: BigInt(process.env.SPECULAR_MIN_SUPPLY ?? '10000000'),
    feeBps: BigInt(process.env.SPECULAR_PLATFORM_FEE_BPS ?? '100'),
};
const MIN_BALANCE = ethers.parseEther(process.env.DEPLOY_MIN_BALANCE || '1');
// Generations this script is allowed to replace. Anything newer is a downgrade.
const REPLACEABLE = ['V6.0 (no VERSION())', 'V6', 'V6.0', 'V6.1'];
const art = (r) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'artifacts', 'contracts', 'core', r), 'utf8'));

async function main() {
    const cfgPath = path.join(__dirname, '..', NET.file);
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
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
    if (oldOwner !== wallet.address || repOwner !== wallet.address) { console.error(`GUARD: deployer must own old marketplace (${oldOwner}) and reputation (${repOwner}) — refusing.`); process.exit(1); }

    // GUARD — no silent downgrade. The canonical pointer on Arc mainnet and Arc staging
    // names a V6.2 contract; replacing it with V6.1 drops the M2 self-stake (the F-04
    // mitigation) AND, since the live V6.2 holds only its own fees, the retirement branch
    // below would pause and revoke the CANONICAL marketplace.
    if (!REPLACEABLE.includes(oldVersion) && process.env.ALLOW_VERSION_DOWNGRADE !== 'YES') {
        console.error(`GUARD: the canonical marketplace on ${netArg} is ${oldVersion}; this script deploys V6.1, which is OLDER.`);
        console.error('       That would drop the M2 self-stake (F-04) and pause/revoke the live contract.');
        console.error('       Use scripts/deploy-v7.js for a new generation. To override deliberately: ALLOW_VERSION_DOWNGRADE=YES');
        process.exit(1);
    }

    // GUARD — USDC shape, and never a mock token on a real-money network.
    {
        const t = new ethers.Contract(cfg.usdc, ['function decimals() view returns (uint8)', 'function symbol() view returns (string)', 'function name() view returns (string)'], provider);
        let dec, sym, nam;
        try { [dec, sym, nam] = [Number(await t.decimals()), await t.symbol(), await t.name()]; }
        catch { console.error(`GUARD: ${cfg.usdc} does not answer decimals()/symbol()/name() — refusing.`); process.exit(1); }
        if (dec !== 6) { console.error(`GUARD: USDC decimals ${dec} != 6 — refusing.`); process.exit(1); }
        if (NET.real && /mock|test|fake|dummy/i.test(`${sym} ${nam}`)) {
            console.error(`GUARD: token ${cfg.usdc} looks like a mock ("${nam}"/"${sym}") on REAL-money network ${netArg} — refusing.`);
            process.exit(1);
        }
        console.log(`usdc check ${sym} (${nam}) ${dec} dec ✅`);
    }

    // GUARD — enough gas to finish; a half-applied redeploy leaves an unauthorised
    // marketplace and an un-levered one, which is worse than not starting.
    {
        const bal = await provider.getBalance(wallet.address);
        if (bal < MIN_BALANCE) {
            console.error(`GUARD: deployer balance ${ethers.formatEther(bal)} < required ${ethers.formatEther(MIN_BALANCE)} (DEPLOY_MIN_BALANCE) — refusing.`);
            process.exit(1);
        }
    }
    const next = await old.nextLoanId(); let active = 0;
    for (let i = 1n; i < next; i++) if (Number((await old.loans(i)).state) === 1) active++;
    const fees = await old.accumulatedFees();
    const usdc = new ethers.Contract(cfg.usdc, ['function balanceOf(address) view returns (uint256)'], provider);
    const oldBal = await usdc.balanceOf(oldAddr);
    console.log(`old: ${oldVersion}, loans ${next - 1n}, ACTIVE ${active}, balance ${ethers.formatUnits(oldBal, 6)} USDC, fees ${ethers.formatUnits(fees, 6)}, paused ${await old.paused()}`);
    // Retirement policy: pause() freezes lender exits (audit 2026-09 I-5) and revokePool()
    // makes repayLoan revert on the old contract. So we only retire when NOTHING is left:
    // no ACTIVE loans AND no lender/collateral funds (balance == accumulatedFees).
    const lenderFunds = oldBal - fees;
    const retireOld = active === 0 && lenderFunds === 0n;
    if (active > 0) console.log('⚠ old marketplace has ACTIVE loans — will NOT pause/revoke it (borrowers must close first).');
    if (lenderFunds > 0n) console.log(`⚠ old marketplace holds ${ethers.formatUnits(lenderFunds, 6)} USDC of lender/collateral funds — will NOT pause/revoke it (pausing would freeze their exits). Lenders must withdraw; re-run with --new <addr> afterwards to retire it.`);

    const factory = new ethers.ContractFactory(M.abi, M.bytecode, wallet);
    const gas = await provider.estimateGas({ ...(await factory.getDeployTransaction(cfg.agentRegistryV2, cfg.reputationManagerV3, cfg.usdc)), from: wallet.address });
    const gp = (await provider.getFeeData()).gasPrice;
    const retirePlan = retireOld ? 'withdrawFees(all) + pause + revokePool(old)' : (fees > 0n ? 'withdrawFees(all) only; old left running' : '(old left running)');
    console.log(`\nplan: ${RESUME_NEW ? `RESUME with new=${RESUME_NEW} (skip deploy/wiring)` : `deploy V6.1 (~${gas} gas ≈ ${ethers.formatEther(gas * gp)} native) → authorizePool → levers ${JSON.stringify({ ...LEVERS, minHold: String(LEVERS.minHold), minSupply: String(LEVERS.minSupply), feeBps: String(LEVERS.feeBps) })} → setMigrationFinalized`} → ${retirePlan}`);
    if (DRY) { console.log('\nDRY RUN — nothing broadcast. Set DEPLOY_CONFIRM=YES to execute.'); return; }

    console.log('\n⚠ broadcasting in 5s...'); await new Promise(r => setTimeout(r, 5000));
    let newAddr;
    if (RESUME_NEW) {
        const nm = new ethers.Contract(RESUME_NEW, M.abi, provider);
        const ver = await nm.VERSION(); const auth = await rep.authorizedPools(RESUME_NEW); const fin = await nm.migrationFinalized();
        if (ver !== 'V6.1' || !auth || !fin) { console.error(`--new ${RESUME_NEW} not ready: VERSION=${ver} authorized=${auth} migrationFinalized=${fin}`); process.exit(1); }
        newAddr = RESUME_NEW; console.log(`↩ resuming with V6.1 marketplace ${newAddr} (authorized, migration finalized)`);
    } else {
        const mp = await factory.deploy(cfg.agentRegistryV2, cfg.reputationManagerV3, cfg.usdc); await mp.waitForDeployment();
        newAddr = await mp.getAddress(); console.log(`✅ V6.1 marketplace ${newAddr} (VERSION ${await mp.VERSION()})`);
        await (await rep.authorizePool(newAddr)).wait(); console.log('✅ reputation.authorizePool(new)');
        if (LEVERS.bind) { await (await mp.setBindBorrowToPoolCreator(true)).wait(); console.log('✅ M-1'); }
        await (await mp.setMinHoldForReputationReward(LEVERS.minHold)).wait(); console.log(`✅ M-2 ${LEVERS.minHold}s`);
        await (await mp.setMinSupplyAmount(LEVERS.minSupply)).wait(); console.log(`✅ F-C ${LEVERS.minSupply}`);
        await (await mp.setPlatformFeeRate(LEVERS.feeBps)).wait(); console.log(`✅ fee ${LEVERS.feeBps} bps`);
        await (await mp.setMigrationFinalized()).wait(); console.log('✅ setMigrationFinalized (F-08 closed on new)');
    }
    if (fees > 0n) { await (await old.withdrawFees(fees)).wait(); console.log(`✅ old.withdrawFees(${ethers.formatUnits(fees, 6)})`); }
    if (retireOld) {
        if (!(await old.paused())) { await (await old.pause()).wait(); console.log('✅ old.pause()'); }
        await (await rep.revokePool(oldAddr)).wait(); console.log('✅ reputation.revokePool(old)');
    } else {
        console.log('ℹ old marketplace left running (still authorized, unpaused) until lenders/borrowers exit.');
    }
    // Superseded stacks APPEND to a list. A fixed key loses the previous generation on the
    // second redeploy — on Arc staging that dropped the last reference to a marketplace
    // still holding 482 USDC of lender funds (V7_MAINNET_MIGRATION_RUNBOOK §5b). The fixed
    // keys are kept as back-compat pointers to the MOST RECENT superseded contract only.
    cfg.supersededDeployments = Array.isArray(cfg.supersededDeployments) ? cfg.supersededDeployments : [];
    if (!cfg.supersededDeployments.some(d => (d.marketplace || '').toLowerCase() === oldAddr.toLowerCase())) {
        cfg.supersededDeployments.push({
            supersededAt: new Date().toISOString(),
            marketplace: oldAddr,
            reputationManager: cfg.reputationManagerV3,
            version: oldVersion,
            note: retireOld
                ? 'Retired: fees withdrawn, paused, pool revoked. Holds nothing.'
                : 'Left running and authorized on purpose (pausing would freeze lender exits). Monitor it with V6_MONITOR_MARKETPLACE=<address> until drained, then retire.',
        });
    }
    cfg[retireOld ? 'agentLiquidityMarketplace_v6_0_retired' : 'agentLiquidityMarketplace_v6_0_legacy_still_live'] = oldAddr;
    cfg.agentLiquidityMarketplacePrevious = oldAddr;
    cfg.agentLiquidityMarketplace_v6 = newAddr;
    cfg.marketplaceVersion = 'V6.1 (2026-09-19 audit fixes F-01/F-02/F-03/F-05/F-07; migration finalized at deploy)';
    cfg.marketplaceRedeployedAt = new Date().toISOString();
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`\n✅ ${NET.file} updated. Next: Sourcify-verify ${newAddr}, run the smoke test, update CLAUDE.md.`);
    if (!retireOld) {
        console.log('\n⚠️  MONITORING: the canonical pointer now names the NEW marketplace, so the');
        console.log('    invariant monitor follows it and STOPS WATCHING the superseded one, which is');
        console.log('    still live and may hold lender funds. Add a second launchd job — by ADDRESS,');
        console.log('    because superseded stacks live in the supersededDeployments LIST and no fixed');
        console.log('    config key resolves them (a key that does not exist makes the monitor exit 2');
        console.log('    and alert for ever while watching nothing):');
        console.log(`      V6_MONITOR_NETWORK=${netArg} V6_MONITOR_MARKETPLACE=${oldAddr} \\`);
        console.log('        node forensics/monitor/v6-invariants.js');
        console.log('    Setting V6_MONITOR_MARKETPLACE also gives that job its own state/log/heartbeat,');
        console.log('    so it cannot overwrite the canonical job\'s change-detection baseline.');
    }
}
main().catch((e) => { console.error(e); process.exit(1); });
