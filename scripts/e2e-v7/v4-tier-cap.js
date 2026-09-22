/**
 * V4 — M1-4: the tier table is on-chain data, bounded by an immutable ceiling.
 *
 * ON-CHAIN (arc-staging).
 *   - the six tier limits read back as the shipped [1000, 5000, 10000, 10000, 2500, 5000] USDC
 *   - MAX_TIER_LIMIT is a constant 10,000 USDC and every tier limit is <= it
 *   - creditLimitOf(agent) <= tierLimit(score) <= MAX_TIER_LIMIT for every live agent
 *   - setTierLimits REVERTS "Tier limit exceeds ceiling" if ANY entry exceeds the ceiling,
 *     and "Tier limit must be > 0" on a zero entry (owner txs, state unchanged)
 *   - a VALID owner change applies and is restored
 */
const L = require('./_lib');
const { USDC, fmt } = L;
const S = 'v4-tier-cap';

const SHIPPED = [1000, 5000, 10000, 10000, 2500, 5000].map(USDC);
const SHIPPED_COLL = [100n, 100n, 100n, 75n, 0n, 0n];
const SHIPPED_MIN_SCORE = [0n, 200n, 400n, 500n, 600n, 800n];

async function main() {
    await L.assertStaging();
    const R = new L.Results(S, 'M1-4 tier table, immutable ceiling and setTierLimits guard (on-chain)');
    const { mp, rep, reg } = L.contracts();
    const repOwner = L.contracts(L.deployer).rep;

    const ceiling = await rep.MAX_TIER_LIMIT();
    R.check('MAX_TIER_LIMIT == 10,000 USDC', ceiling === USDC(10000), fmt(ceiling));

    const onChain = [];
    for (let i = 0; i < 6; i++) onChain.push(await rep.tierLimits(i));
    R.check('tierLimits read from chain == [1000, 5000, 10000, 10000, 2500, 5000] USDC',
        onChain.every((v, i) => v === SHIPPED[i]), onChain.map(fmt).join(', '));
    R.check('every tier limit <= MAX_TIER_LIMIT', onChain.every(v => v <= ceiling));

    const coll = [], minScore = [], unsec = [];
    for (let i = 0; i < 6; i++) { coll.push(await rep.tierCollateralPct(i)); minScore.push(await rep.tierMinScore(i)); unsec.push(await rep.unsecuredTierExposure(i)); }
    R.check('tierCollateralPct == [100, 100, 100, 75, 0, 0]', coll.every((v, i) => v === SHIPPED_COLL[i]), coll.join(','));
    R.check('tierMinScore == [0, 200, 400, 500, 600, 800]', minScore.every((v, i) => v === SHIPPED_MIN_SCORE[i]), minScore.join(','));
    R.check('unsecuredTierExposure is monotone and capped at 5,000 USDC',
        unsec.every(v => v <= USDC(5000)) && unsec.map(fmt).join(',') === '0.0,0.0,0.0,2500.0,2500.0,5000.0', unsec.map(fmt).join(','));

    // ---------------------------------------------- the cap holds for every live agent
    const A = L.roleWallet('A'), B = L.roleWallet('B');
    const ids = [];
    for (const w of [A, B]) ids.push(Number(await reg.addressToAgentId(w.address)));
    let allCapped = true; const detail = [];
    for (const id of ids) {
        const score = await rep['getReputationScore(uint256)'](id);
        const lim = await rep.creditLimitOf(id);
        const tl = await rep.tierLimit(score);
        if (!(lim <= tl && tl <= ceiling)) allCapped = false;
        detail.push(`#${id} score ${score}: limit ${fmt(lim)} <= tier ${fmt(tl)} <= ${fmt(ceiling)}`);
    }
    // also a synthetic sweep across the whole score domain
    for (let s = 0; s <= 1000; s += 50) {
        const tl = await rep.tierLimit(s);
        if (tl > ceiling) allCapped = false;
    }
    R.check('creditLimitOf <= tierLimit(score) <= MAX_TIER_LIMIT for every live agent, and tierLimit(score) <= ceiling across the whole 0..1000 score domain',
        allCapped, detail.join(' | '));

    // ---------------------------------------------- the setter guards
    const over = [...SHIPPED]; over[2] = ceiling + 1n;
    const rvOver = await L.expectRevert(repOwner.setTierLimits(over), 'Tier limit exceeds ceiling');
    R.check('setTierLimits with one entry at MAX_TIER_LIMIT + 1 REVERTS "Tier limit exceeds ceiling"', rvOver.reverted && rvOver.matched, rvOver.message.slice(0, 130));
    const overTop = [...SHIPPED]; overTop[5] = USDC(50000);
    const rvTop = await L.expectRevert(repOwner.setTierLimits(overTop), 'Tier limit exceeds ceiling');
    R.check('setTierLimits cannot restore the old 50,000 USDC top tier', rvTop.reverted && rvTop.matched, rvTop.message.slice(0, 130));
    const zero = [...SHIPPED]; zero[0] = 0n;
    const rvZero = await L.expectRevert(repOwner.setTierLimits(zero), 'Tier limit must be > 0');
    R.check('setTierLimits with a zero entry REVERTS "Tier limit must be > 0"', rvZero.reverted && rvZero.matched, rvZero.message.slice(0, 130));

    const after = [];
    for (let i = 0; i < 6; i++) after.push(await rep.tierLimits(i));
    R.check('the three refused owner calls changed NOTHING on chain', after.every((v, i) => v === SHIPPED[i]), after.map(fmt).join(', '));

    // ---------------------------------------------- a valid owner change, then restore
    const bumped = [...SHIPPED]; bumped[5] = ceiling; // 5,000 -> 10,000, i.e. exactly at the ceiling
    R.tx('setTierLimits (valid, tier 5 -> ceiling)', await L.send(S, 'setTierLimits tier5 = MAX_TIER_LIMIT (valid owner change)', repOwner.setTierLimits(bumped)));
    R.check('valid change applied and reads back', (await rep.tierLimits(5)) === ceiling, fmt(await rep.tierLimits(5)));
    R.check('the ceiling still bounds the changed table', (await rep.tierLimits(5)) <= ceiling);
    R.tx('setTierLimits (restore)', await L.send(S, 'setTierLimits restore to the shipped table', repOwner.setTierLimits(SHIPPED)));
    const restored = [];
    for (let i = 0; i < 6; i++) restored.push(await rep.tierLimits(i));
    R.check('shipped tier table restored exactly', restored.every((v, i) => v === SHIPPED[i]), restored.map(fmt).join(', '));

    R.finish({ tierLimits: restored.map(v => v.toString()), maxTierLimit: ceiling.toString() });
}
main().catch(e => { console.error(e); process.exit(1); });
