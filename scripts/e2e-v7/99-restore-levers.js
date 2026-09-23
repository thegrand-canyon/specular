/**
 * 99 — restore the five compressed clock levers to their live staging values and
 * verify the read-back. Run this after every on-chain scenario; `v7-migration-control-plane.js`
 * then asserts the live configuration independently.
 */
const L = require('./_lib');
const { USDC, fmt } = L;
const S = '99-restore-levers';

async function main() {
    await L.assertStaging();
    const R = new L.Results(S, 'restore live staging levers');
    const before = await L.readLevers();
    R.note('levers before restore', JSON.stringify(before, (k, v) => typeof v === 'bigint' ? v.toString() : v));

    await L.restoreLiveLevers(S);

    const after = await L.readLevers();
    const E = L.LIVE_LEVERS;
    R.check('onTimeRepaymentBonus restored to 10', after.rep.onTimeBonus === BigInt(E.rep.onTimeBonus), after.rep.onTimeBonus);
    R.check('bonusReferenceAmount restored to 100 USDC', after.rep.bonusReferenceAmount === E.rep.bonusReferenceAmount, fmt(after.rep.bonusReferenceAmount));
    R.check('refDuration restored to 7 days (604800 s)', after.rep.refDuration === BigInt(E.rep.refDuration), after.rep.refDuration);
    R.check('reputation rate limit restored to 5 per 86400 s',
        after.rep.rateMaxGain === BigInt(E.rep.rateMaxGain) && after.rep.rateWindow === BigInt(E.rep.rateWindow),
        `${after.rep.rateMaxGain}/${after.rep.rateWindow}`);
    R.check('minHoldForReputationReward restored to 86400 s', after.mp.minHold === BigInt(E.mp.minHold), after.mp.minHold);
    R.check('never-touched levers still at their live values: k=2, step=100, bootstrap=100, lockout=180d, fee=100bps, minSupply=10, bind=true',
        after.rep.creditMultiple === 2n && after.rep.growthStep === USDC(100) && after.rep.bootstrapLimit === USDC(100) &&
        after.rep.defaultLockout === BigInt(E.rep.defaultLockout) && after.mp.feeBps === BigInt(E.mp.feeBps) &&
        after.mp.minSupply === E.mp.minSupply && after.mp.bind === true);
    R.check('defaultPenaltyBase/Large and largeLoanThreshold at shipped values (50 / 100 / 1000 USDC)',
        after.rep.defaultPenaltyBase === 50n && after.rep.defaultPenaltyLarge === 100n && after.rep.largeLoanThreshold === USDC(1000));

    R.finish({ leversAfter: JSON.parse(JSON.stringify(after, (k, v) => typeof v === 'bigint' ? v.toString() : v)) });
}
main().catch(e => { console.error(e); process.exit(1); });
