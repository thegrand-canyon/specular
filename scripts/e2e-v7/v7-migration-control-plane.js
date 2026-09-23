/**
 * V7 — migration finalized + control plane, read back against the LIVE staging levers.
 *
 * Run this LAST (after 99-restore-levers.js) so it measures the configuration the
 * staging stack is actually left in.
 *
 *   - migrationFinalized == true; `seedPool` / `seedPosition` revert "Migration finalized"
 *     even for the owner, and `setMigrationFinalized` cannot be re-run
 *   - both contracts are owned by the secure wallet; ownership cannot be renounced
 *   - the marketplace is an AUTHORIZED pool on ReputationManagerV4, and no other
 *     address (e.g. the superseded V6.1 marketplace) is
 *   - every live lever reads back at its documented value
 */
const L = require('./_lib');
const { USDC, fmt } = L;
const S = 'v7-migration-control-plane';
const SECURE = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';

async function main() {
    await L.assertStaging();
    const R = new L.Results(S, 'migration finalized, ownership, pool authorization, live lever read-back (on-chain)');
    const { mp, rep } = L.contracts();
    const mpOwner = L.contracts(L.deployer).mp;
    const A = L.roleWallet('A');
    const aId = Number(await L.contracts().reg.addressToAgentId(A.address));

    // ---------------------------------------------- versions
    R.check('marketplace VERSION == "V6.2"', (await mp.VERSION()) === 'V6.2');
    R.check('reputation manager VERSION == "V4"', (await rep.VERSION()) === 'V4');
    // The pair is read from the CANONICAL keys of the address file, never hardcoded:
    // a redeploy rewrites those keys and must not need a scenario edit. What is
    // asserted is that the suite ran against the canonical pair and that the pair is
    // not one of the superseded stacks the address file lists.
    const canonMp = L.cfg.agentLiquidityMarketplace_v62, canonRep = L.cfg.reputationManagerV4;
    const superseded = (L.cfg.supersededDeployments || []);
    const supersededMps = superseded.map(d => d.marketplace.toLowerCase());
    const supersededReps = superseded.map(d => d.reputationManager.toLowerCase());
    R.check('addresses are the configured V7 pair (canonical keys of arc-testnet-v6-addresses.json)',
        L.MP.toLowerCase() === canonMp.toLowerCase() && L.REP.toLowerCase() === canonRep.toLowerCase(),
        `${L.MP} / ${L.REP}`);
    R.check('the live pair is NOT one of the superseded deployments',
        !supersededMps.includes(L.MP.toLowerCase()) && !supersededReps.includes(L.REP.toLowerCase()),
        `${superseded.length} superseded stack(s) on file`);

    // ---------------------------------------------- migration
    R.check('migrationFinalized == true', (await mp.migrationFinalized()) === true);
    const rvSeedPool = await L.expectRevert(mpOwner.seedPool(aId, A.address, USDC(1), USDC(1), 0n), 'Migration finalized');
    R.check('seedPool REVERTS "Migration finalized" even for the owner', rvSeedPool.reverted && rvSeedPool.matched, rvSeedPool.message.slice(0, 130));
    const rvSeedPos = await L.expectRevert(mpOwner.seedPosition(aId, A.address, USDC(1), 0n, 1n), 'Migration finalized');
    R.check('seedPosition REVERTS "Migration finalized" even for the owner', rvSeedPos.reverted && rvSeedPos.matched, rvSeedPos.message.slice(0, 130));
    const rvFinal = await L.expectRevert(mpOwner.setMigrationFinalized(), 'Migration finalized');
    R.check('setMigrationFinalized cannot be re-run (latch is one-way)', rvFinal.reverted && rvFinal.matched, rvFinal.message.slice(0, 130));

    // ---------------------------------------------- ownership
    R.check('marketplace owner == the secure wallet', (await mp.owner()).toLowerCase() === SECURE.toLowerCase(), await mp.owner());
    R.check('reputation manager owner == the secure wallet', (await rep.owner()).toLowerCase() === SECURE.toLowerCase(), await rep.owner());
    R.check('marketplace is NOT paused', (await mp.paused()) === false);
    const rvRen1 = await L.expectRevert(mpOwner.renounceOwnership(), 'Ownership cannot be renounced');
    R.check('marketplace renounceOwnership REVERTS (I-1)', rvRen1.reverted && rvRen1.matched, rvRen1.message.slice(0, 120));
    const rvRen2 = await L.expectRevert(L.contracts(L.deployer).rep.renounceOwnership(), 'Ownership cannot be renounced');
    R.check('reputation manager renounceOwnership REVERTS (I-1)', rvRen2.reverted && rvRen2.matched, rvRen2.message.slice(0, 120));
    R.check('both are Ownable2Step with no pending owner', (await mp.pendingOwner()) === L.ethers.ZeroAddress && (await rep.pendingOwner()) === L.ethers.ZeroAddress);

    // ---------------------------------------------- pool authorization
    R.check('authorizePool is wired: authorizedPools[V6.2 marketplace] == true', (await rep.authorizedPools(L.MP)) === true);
    // Every marketplace the address file records as superseded (V6.0, V6.1, the
    // pre-scale-fix V6.2) must be unauthorized on THIS ReputationManagerV4. Driven
    // off the address file so a new supersession is covered without a scenario edit.
    const staleMps = [
        ...superseded.map(d => ({ addr: d.marketplace, label: d.version })),
        { addr: L.cfg.agentLiquidityMarketplace_v6_0_legacy_still_live, label: 'V6.0 legacy (still live)' },
        { addr: L.cfg.agentLiquidityMarketplacePrevious, label: 'previous marketplace' }
    ].filter(x => x.addr && x.addr.toLowerCase() !== L.MP.toLowerCase());
    R.check('every superseded / legacy marketplace on file is UNAUTHORIZED on this ReputationManagerV4',
        (await Promise.all(staleMps.map(x => rep.authorizedPools(x.addr)))).every(v => v === false),
        staleMps.map(x => `${x.label} ${x.addr}`).join(' | '));
    R.check('the superseded reputation managers are not this one (V7 reputation did NOT migrate)',
        !supersededReps.includes(L.REP.toLowerCase()), supersededReps.join(', ') || 'none');
    const rvUnauth = await L.expectRevert(L.contracts(L.deployer).rep.recordBorrow(A.address, 999999, USDC(1)), 'Only authorized pools');
    R.check('an unauthorized caller (even the owner EOA) cannot write reputation ("Only authorized pools")', rvUnauth.reverted && rvUnauth.matched, rvUnauth.message.slice(0, 120));

    // ---------------------------------------------- live levers
    const lv = await L.readLevers();
    R.check('M-1 bindBorrowToPoolCreator == true', lv.mp.bind === true);
    R.check('minHoldForReputationReward == 86400 s (1 day)', lv.mp.minHold === 86400n, lv.mp.minHold);
    R.check('minSupplyAmount == 10 USDC', lv.mp.minSupply === USDC(10), fmt(lv.mp.minSupply));
    R.check('platformFeeRate == 100 bps', lv.mp.feeBps === 100n, lv.mp.feeBps);
    R.check('reputation rate limit == 5 points per 86400 s', lv.rep.rateMaxGain === 5n && lv.rep.rateWindow === 86400n, `${lv.rep.rateMaxGain}/${lv.rep.rateWindow}`);
    R.check('ladder: creditMultiple 2, growthStep 100 USDC, bootstrapLimit 100 USDC, refDuration 7 days',
        lv.rep.creditMultiple === 2n && lv.rep.growthStep === USDC(100) && lv.rep.bootstrapLimit === USDC(100) && lv.rep.refDuration === 604800n);
    R.check('onTimeRepaymentBonus 10, bonusReferenceAmount 100 USDC',
        lv.rep.onTimeBonus === 10n && lv.rep.bonusReferenceAmount === USDC(100));
    R.check('defaultLockout == 180 days (15,552,000 s)', lv.rep.defaultLockout === 15552000n, lv.rep.defaultLockout);
    R.check('default penalty: base 50, large 100, largeLoanThreshold 1,000 USDC',
        lv.rep.defaultPenaltyBase === 50n && lv.rep.defaultPenaltyLarge === 100n && lv.rep.largeLoanThreshold === USDC(1000));
    const lateB = await rep.latePenaltyBase(), lateD = await rep.latePenaltyPerDay(), lateM = await rep.latePenaltyMax();
    R.check('late penalty: base 10, 5/day, cap 100', lateB === 10n && lateD === 5n && lateM === 100n, `${lateB}/${lateD}/${lateM}`);
    const tiers = [];
    for (let i = 0; i < 6; i++) tiers.push(await rep.tierLimits(i));
    R.check('tier limits [1000, 5000, 10000, 10000, 2500, 5000] USDC and MAX_TIER_LIMIT 10,000 USDC',
        tiers.map(fmt).join(',') === '1000.0,5000.0,10000.0,10000.0,2500.0,5000.0' && (await rep.MAX_TIER_LIMIT()) === USDC(10000),
        tiers.map(fmt).join(','));
    R.check('marketplace constants: MIN_LOAN_DURATION 7d, MAX_ACTIVE_LOANS_PER_AGENT 10, MAX_LENDERS_PER_POOL 50, LATE_INTEREST_CAP 30d',
        (await mp.MIN_LOAN_DURATION()) === 604800n && (await mp.MAX_ACTIVE_LOANS_PER_AGENT()) === 10n &&
        (await mp.MAX_LENDERS_PER_POOL()) === 50n && (await mp.LATE_INTEREST_CAP()) === 2592000n);

    R.finish({ levers: JSON.parse(JSON.stringify(lv, (k, v) => typeof v === 'bigint' ? v.toString() : v)) });
}
main().catch(e => { console.error(e); process.exit(1); });
