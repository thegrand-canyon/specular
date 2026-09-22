/**
 * 00 — staging preflight, throwaway-wallet funding and calendar compression.
 *
 * Why levers are touched: the live staging levers are calibrated for a real calendar
 * (minHold 1 day per loan, 5 reputation points per rolling day, a 7-day bonus
 * reference duration). A tier-3/4 agent — the only place the M2-c self-stake gate can
 * bind — is 80+ days away at those settings. This script therefore compresses the
 * CLOCK levers only, as the staging owner:
 *
 *      onTimeRepaymentBonus      10  -> 50      (setScoringParameters)
 *      bonusReferenceAmount     100  -> 1 USDC  (setBonusReferenceAmount)
 *      refDuration            7 days -> 1 s     (setLadderParameters, k/step/bootstrap UNCHANGED)
 *      reputation rate limit  5/day  -> 0 (unlimited)
 *      minHoldForReputationReward 1 day -> 0
 *
 * NOT touched, anywhere in this suite: creditMultiple (2), growthStep (100 USDC),
 * bootstrapLimit (100 USDC), the tier table, tierCollateralPct, defaultLockout,
 * platformFeeRate, minSupplyAmount, bindBorrowToPoolCreator, migrationFinalized.
 * `99-restore-levers.js` puts the five compressed levers back and `v7-*.js` re-reads them.
 *
 * Re-runnable: wallets, registrations, pools and reputation are idempotent.
 */
const L = require('./_lib');
const { USDC, fmt } = L;
const S = '00-setup';

const ROLES = ['A', 'B', 'LA', 'LB', 'T', 'C', 'T2', 'D', 'E', 'F', 'LF', 'X'];

async function main() {
    await L.assertStaging();
    const R = new L.Results(S, 'preflight, funding, calendar compression, agent B pumped to the 0%-collateral tier');
    const { mp, rep, usdc } = L.contracts();

    const before = await L.readLevers();
    R.note('live levers before compression', JSON.stringify(before, (k, v) => typeof v === 'bigint' ? v.toString() : v));

    // ---- wallets + gas
    const W = {};
    for (const r of ROLES) { W[r] = L.roleWallet(r); }
    console.log('  throwaway wallets:', ROLES.map(r => `${r}=${W[r].address}`).join(' '));
    // Arc staging gas: ~0.0225 native per 500k-gas tx. A and B send the most.
    const GAS_TARGET = { A: '1.6', B: '2.0', D: '0.8', F: '0.8' };
    for (const r of ROLES) await L.fundNative(W[r], GAS_TARGET[r] || '0.5', S);
    R.check('all throwaway roles funded with native gas', true, ROLES.join(','));

    // ---- compress the clock levers
    await L.setLevers(S, { onTimeBonus: 50, bonusRef: USDC(1), refDuration: 1, rateMaxGain: 0, rateWindow: 86400, minHold: 0 });
    const comp = await L.readLevers();
    R.check('compression applied: onTimeBonus 50, bonusRef 1 USDC, refDuration 1s, rate limit unlimited, minHold 0',
        comp.rep.onTimeBonus === 50n && comp.rep.bonusReferenceAmount === USDC(1) && comp.rep.refDuration === 1n &&
        comp.rep.rateMaxGain === 0n && comp.mp.minHold === 0n);
    R.check('LADDER PARAMETERS UNCHANGED by compression (k=2, growthStep=100, bootstrap=100)',
        comp.rep.creditMultiple === 2n && comp.rep.growthStep === USDC(100) && comp.rep.bootstrapLimit === USDC(100),
        `k=${comp.rep.creditMultiple} step=${fmt(comp.rep.growthStep)} boot=${fmt(comp.rep.bootstrapLimit)}`);
    R.check('tier table / lockout / fee / minSupply / bind UNCHANGED',
        comp.rep.defaultLockout === 15552000n && comp.mp.feeBps === 100n && comp.mp.minSupply === USDC(10) && comp.mp.bind === true);

    // ---- agents A (ladder) and B (tiered)
    const aId = await L.ensureAgent(W.A, S, 'A-ladder');
    const bId = await L.ensureAgent(W.B, S, 'B-tier');
    R.note('agents', `A(ladder)=#${aId} ${W.A.address}   B(tier)=#${bId} ${W.B.address}`);

    // ---- funding: MockUSDC (mint is owner-only; these are test tokens with no value)
    await L.ensureUsdc(W.A, 1500, 2500, S);
    await L.ensureUsdc(W.B, 1500, 2500, S);
    await L.ensureUsdc(W.LA, 1100, 1500, S);
    await L.ensureUsdc(W.LB, 1100, 1500, S);
    await L.ensureUsdc(W.T, 500, 800, S);
    await L.ensureUsdc(W.C, 100, 200, S);
    await L.ensureUsdc(W.T2, 100, 200, S);
    await L.ensureUsdc(W.D, 600, 900, S);
    await L.ensureUsdc(W.E, 600, 900, S);
    await L.ensureUsdc(W.F, 400, 600, S);
    await L.ensureUsdc(W.LF, 400, 600, S);

    for (const r of ['A', 'B', 'LA', 'LB', 'T', 'C', 'T2', 'D', 'E', 'F', 'LF']) {
        await L.approveMax(W[r], 100000, S, `${r} approve`);
    }

    // ---- B's pool liquidity: third-party lender LB + B's own first-loss stake
    const mpB = L.contracts(W.B).mp, mpLB = L.contracts(W.LB).mp;
    let bPool = await mp.agentPools(bId);
    if ((await mp.positions(bId, W.LB.address)).amount < USDC(1000)) {
        await L.send(S, `LB supply 1100 USDC to pool #${bId}`, mpLB.supplyLiquidity(bId, USDC(1100)));
    }
    if ((await mp.positions(bId, W.B.address)).amount < USDC(200)) {
        await L.send(S, `B self-stake 200 USDC into own pool #${bId}`, mpB.supplyLiquidity(bId, USDC(200)));
    }

    // ---- pump B to score >= 600 (the 0 %-collateral tier), 50 pts per on-time repayment
    //      Loan sizes follow the SHIPPED ladder: an agent can only borrow what the
    //      ladder already allows, so the pump itself is a ladder climb.
    let st = await L.creditState(bId, W.B.address);
    R.note('B before pump', `score ${st.score} limit ${fmt(st.limit)} ladder ${fmt(st.ladder)} maxRepaid ${fmt(st.maxRepaid)}`);
    let i = 0;
    while (st.score < 600n && i < 16) {
        i++;
        const cap = st.limit < USDC(1000) ? st.limit : USDC(1000);
        const amount = cap;
        if (amount === 0n) throw new Error('B credit limit is 0 — cannot pump');
        const pool = await mp.agentPools(bId);
        if (pool.availableLiquidity < amount) throw new Error(`pool liquidity ${fmt(pool.availableLiquidity)} < ${fmt(amount)}`);
        const rcReq = await L.send(S, `pump#${i} B requestLoan ${fmt(amount)} (score ${st.score}, coll ${st.collPct}%)`, mpB.requestLoan(amount, 7));
        const loanId = L.loanIdFromReceipt(mp, rcReq);
        await L.sleep(3000); // hold >= 1s so the principal-TIME bonus is non-zero
        await L.send(S, `pump#${i} B repayLoan ${loanId}`, mpB.repayLoan(loanId));
        st = await L.creditState(bId, W.B.address);
        console.log(`    pump#${i}: score ${st.score} maxRepaid ${fmt(st.maxRepaid)} ladder ${fmt(st.ladder)} limit ${fmt(st.limit)} coll ${st.collPct}%`);
    }
    R.check('agent B reached the 0 %-collateral tier (score >= 600)', st.score >= 600n, `score ${st.score} after ${i} pump loans`);
    R.check('agent B collateral requirement is now 0 %', st.collPct === 0n, `${st.collPct}%`);
    R.check('agent B tier limit is the capped 2,500 USDC (tier 4)', st.tierLimit === USDC(2500), fmt(st.tierLimit));
    R.note('B after pump', `score ${st.score} maxRepaid ${fmt(st.maxRepaid)} ladder ${fmt(st.ladder)} limit ${fmt(st.limit)} selfStake ${fmt(st.selfStake)}`);

    const cons = await L.poolConservation(bId);
    R.check('pool #B per-pool conservation exact after the pump', cons.conserved,
        `avail ${fmt(cons.availableLiquidity)} + loaned ${fmt(cons.totalLoaned)} == Σamt ${fmt(cons.sumAmt)} + Σearned ${fmt(cons.sumEarned)}`);

    R.finish({ agents: { A: aId, B: bId }, wallets: Object.fromEntries(ROLES.map(r => [r, W[r].address])), pumpLoans: i, leversBefore: before, leversCompressed: comp });
}
main().catch(e => { console.error(e); process.exit(1); });
