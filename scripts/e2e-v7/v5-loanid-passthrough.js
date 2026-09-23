/**
 * V5 — M2-d: the marketplace passes `loanId` into every reputation call.
 *
 * ON-CHAIN (arc-staging). Two loans of the SAME amount are opened concurrently on one
 * agent and repaid in the OPPOSITE order. Under V3's amount-matching this was ambiguous
 * (the report's scratch contract resolved it oldest-first / FIFO), which is why the
 * signature changed. Two independent proofs that the attribution is exact:
 *
 *  (1) STATE — `openLoans(pool, loanId)` is keyed by (marketplace, loanId). Repaying the YOUNGER loan clears
 *      the younger record and leaves the older record's `start` untouched. FIFO would
 *      have consumed the older one.
 *  (2) HOLD TIME — the M1-1 bonus is `onTimeBonus · min(amt,ref)/ref · min(held,refDuration)/refDuration`
 *      with `held` taken from THAT loanId's recordBorrow timestamp. The score delta on the
 *      first repayment matches the YOUNGER loan's hold time exactly, and is strictly
 *      smaller than the FIFO counterfactual computed from the older loan's timestamp.
 *
 * `refDuration` is set to 600 s for this script (restored at the end) purely so hold
 * time is measurable inside a single run; it is a clock lever, not a model parameter.
 */
const L = require('./_lib');
const { USDC, fmt } = L;
const S = 'v5-loanid-passthrough';
const REF_DURATION = 600;    // seconds, for this script only
const GAP_SECONDS = 60;      // between the two borrows
const HOLD_SECONDS = 36;     // before the first (younger-loan) repayment
const MIN_HOLD_FOR_RUN = 10; // seconds, for this script only (live value is 86400)
const SCORE_HEADROOM = 100n; // reputation points the proof needs to be able to observe

// The marketplace's `minHoldForReputationReward` gates the reward ENTIRELY, not just its
// size (scenario V9's O-1): a loan held for less than minHold reports onTime=false and
// earns nothing, however the pro-rata hold-time term would round. At the live 1-day
// minHold that is every loan this script opens, so modelling only the pro-rata term makes
// the expectation wrong whenever the hold happens to round up to >= 1 point — a flake that
// depends purely on how long the RPC took. Gate first, then pro-rate.
const bonusOf = (onTimeBonus, held, rd, minHold) =>
    held < Number(minHold) ? 0n : (BigInt(onTimeBonus) * BigInt(Math.min(held, rd))) / BigInt(rd);

async function main() {
    await L.assertStaging();
    const R = new L.Results(S, 'M2-d loanId pass-through: concurrent equal-size loans, out-of-order repayment (on-chain)');
    const { mp, rep, reg } = L.contracts();

    // Proof (2) reads the M1-1 bonus off the agent's SCORE DELTA, so it needs an agent
    // with room below MAX_SCORE. A long-lived pumped agent saturates at 1000 after a few
    // suite runs and every delta silently becomes 0 — which would make the hold-time leg
    // vacuous (0 == 0 proves nothing about attribution) while still reporting PASS.
    // Allocate an agent that still has headroom; one is reused until it runs out.
    const MAX_SCORE = await rep.MAX_SCORE();
    const { wallet: B, role: bRole } = await L.freshRoleWallet('V5LOANID', async (w) => {
        const id = await reg.addressToAgentId(w.address);
        if (id === 0n) return true;
        const score = await rep['getReputationScore(uint256)'](id);
        return score + SCORE_HEADROOM <= MAX_SCORE && (await mp.activeLoanCount(id)) === 0n;
    });
    const LB = L.roleWallet('LB');
    const mpB = L.contracts(B).mp, mpLB = L.contracts(LB).mp, repOwner = L.contracts(L.deployer).rep;

    await L.fundNative(B, '1.0', S);
    const bId = await L.ensureAgent(B, S, bRole);

    // Size everything from chain: climb the ladder until two concurrent equal loans fit,
    // then take the per-loan amount from the live head-room. Nothing is hardcoded, so a
    // redeploy (which resets reputation) just re-climbs.
    const boot = await rep.bootstrapLimit();
    const targetLimit = boot * 4n;
    await L.ensureUsdc(B, Number(fmt(targetLimit)) * 3, Number(fmt(targetLimit)) * 4, S);
    await L.approveMax(B, 100000, S, `${bRole} approve`);
    if ((await mp.agentPools(bId)).availableLiquidity < targetLimit * 3n) {
        await L.ensureUsdc(LB, Number(fmt(targetLimit)) * 3, Number(fmt(targetLimit)) * 4, S);
        await L.send(S, `LB supply ${fmt(targetLimit * 3n)} USDC to pool #${bId}`, mpLB.supplyLiquidity(bId, targetLimit * 3n));
    }
    const rungs = await L.climbLadderTo(S, B, bId, targetLimit);
    if (rungs.length) R.note('ladder climbed for the loanId agent', JSON.stringify(rungs));
    const sz = await L.borrowableNow(bId, B.address, { slots: 2, reserveUsdc: 20 });
    const AMOUNT_UNITS = sz.per;
    R.note('loanId agent (score headroom required)',
        `${bRole} #${bId} ${B.address} score ${await rep['getReputationScore(uint256)'](bId)}/${MAX_SCORE}, two concurrent loans of ${fmt(AMOUNT_UNITS)} USDC`);
    R.check('the agent has reputation head-room for the bonus deltas this proof measures',
        (await rep['getReputationScore(uint256)'](bId)) + SCORE_HEADROOM <= MAX_SCORE,
        `score ${await rep['getReputationScore(uint256)'](bId)} + ${SCORE_HEADROOM} <= ${MAX_SCORE}`);
    R.check('two concurrent equal loans fit under the live credit limit', AMOUNT_UNITS > 0n && sz.limit >= AMOUNT_UNITS * 2n,
        `per-loan ${fmt(AMOUNT_UNITS)}, limit ${fmt(sz.limit)}`);

    const mpOwner = L.contracts(L.deployer).mp;
    const rdBefore = await rep.refDuration();
    const minHoldBefore = await mp.minHoldForReputationReward();
    await L.send(S, `setLadderParameters(refDuration = ${REF_DURATION}s) — hold time measurable in one run`,
        repOwner.setLadderParameters(L.LIVE_LEVERS.rep.creditMultiple, L.LIVE_LEVERS.rep.growthStep, L.LIVE_LEVERS.rep.bootstrapLimit, REF_DURATION));
    // minHoldForReputationReward gates the reward ENTIRELY (V9's O-1). At the live 1-day
    // setting every loan this script opens earns exactly 0, which makes the hold-time
    // proof below vacuous (0 == 0 proves nothing about attribution). Lower it alongside
    // refDuration for the run — same class of clock lever — and restore both in `finally`.
    const MIN_HOLD = BigInt(MIN_HOLD_FOR_RUN);
    await L.send(S, `setMinHoldForReputationReward(${MIN_HOLD_FOR_RUN}s) — so a short hold can earn at all`,
        mpOwner.setMinHoldForReputationReward(MIN_HOLD));

    try {
        const onTimeBonus = await rep.onTimeRepaymentBonus();
        const bonusRef = await rep.bonusReferenceAmount();
        R.note('bonus levers for this run', `onTimeBonus ${onTimeBonus}, bonusReferenceAmount ${fmt(bonusRef)} USDC, refDuration ${REF_DURATION}s → bonus = ${onTimeBonus}·min(held,${REF_DURATION})/${REF_DURATION}`);

        let st = await L.creditState(bId, B.address);
        R.check('precondition: no active loans on agent B', st.outstanding === 0n);
        const need = await mp.requiredSelfStake(bId, AMOUNT_UNITS * 2n);
        if (st.selfStake < need) R.tx('top up self-stake', await L.send(S, `B top self-stake to ${fmt(need)}`, mpB.supplyLiquidity(bId, need - st.selfStake)));

        // ------------------------------------------------- two identical concurrent loans
        const rc1 = await L.send(S, `B requestLoan ${fmt(AMOUNT_UNITS)} USDC (loan X, older)`, mpB.requestLoan(AMOUNT_UNITS, 7));
        const loanX = L.loanIdFromReceipt(mp, rc1);
        R.tx(`requestLoan X -> #${loanX}`, rc1);
        console.log(`    waiting ${GAP_SECONDS}s before the second borrow...`);
        await L.sleep(GAP_SECONDS * 1000);
        const rc2 = await L.send(S, `B requestLoan ${fmt(AMOUNT_UNITS)} USDC (loan Y, younger)`, mpB.requestLoan(AMOUNT_UNITS, 7));
        const loanY = L.loanIdFromReceipt(mp, rc2);
        R.tx(`requestLoan Y -> #${loanY}`, rc2);

        const MP_ADDR = await mp.getAddress();
        const olX = await rep.openLoans(MP_ADDR, loanX), olY = await rep.openLoans(MP_ADDR, loanY);
        R.check('both loans are the SAME amount (the case amount-matching cannot resolve)',
            (await mp.loans(loanX)).amount === (await mp.loans(loanY)).amount, `${fmt(olX.amount)} == ${fmt(olY.amount)}`);
        R.check('recordBorrow created a per-loanId open-loan record for EACH loan',
            olX.start > 0n && olY.start > 0n && olX.agentId === BigInt(bId) && olY.agentId === BigInt(bId) &&
            olX.amount === AMOUNT_UNITS && olY.amount === AMOUNT_UNITS,
            `X{start ${olX.start}, amt ${fmt(olX.amount)}, agent ${olX.agentId}}  Y{start ${olY.start}, amt ${fmt(olY.amount)}, agent ${olY.agentId}}`);
        R.check('the younger loan has a strictly later recordBorrow timestamp', olY.start > olX.start, `${olX.start} -> ${olY.start} (+${olY.start - olX.start}s)`);
        R.check('both loans are ACTIVE concurrently', (await mp.activeLoanCount(bId)) === 2n && (await mp.outstandingPrincipal(bId)) === AMOUNT_UNITS * 2n);

        // ------------------------------------------------- repay the YOUNGER first
        console.log(`    holding ${HOLD_SECONDS}s before repaying the younger loan...`);
        await L.sleep(HOLD_SECONDS * 1000);
        const scoreBefore = await rep['getReputationScore(uint256)'](bId);
        const rcRY = await L.send(S, `B repayLoan ${loanY} (the YOUNGER loan, out of order)`, mpB.repayLoan(loanY));
        R.tx(`repay Y (#${loanY})`, rcRY);
        const blkY = await L.provider.getBlock(rcRY.blockNumber);
        const scoreAfterY = await rep['getReputationScore(uint256)'](bId);

        const heldY = blkY.timestamp - Number(olY.start);
        const heldFifo = blkY.timestamp - Number(olX.start);
        const expY = bonusOf(onTimeBonus, heldY, REF_DURATION, MIN_HOLD);
        const expFifo = bonusOf(onTimeBonus, heldFifo, REF_DURATION, MIN_HOLD);

        const completedY = L.eventFromReceipt(rep.interface, rcRY, 'LoanCompleted');
        R.check('LoanCompleted carries the repaid loanId (indexed), not an amount match',
            completedY !== null && Number(completedY.args.loanId) === loanY, completedY ? `loanId ${completedY.args.loanId}` : 'no event');
        R.check(`score delta on repaying Y == bonus from Y's OWN hold time (${heldY}s → ${expY} pts)`,
            scoreAfterY - scoreBefore === expY, `delta ${scoreAfterY - scoreBefore}, expected ${expY}`);
        R.check(`FIFO/amount-matching counterfactual would have paid ${expFifo} pts (X's ${heldFifo}s hold) — strictly more, so attribution is by loanId`,
            expFifo > expY && scoreAfterY - scoreBefore !== expFifo, `byLoanId ${expY} < FIFO ${expFifo}`);

        const olYAfter = await rep.openLoans(MP_ADDR, loanY), olXAfter = await rep.openLoans(MP_ADDR, loanX);
        R.check('openLoans(Y) deleted by the repayment', olYAfter.start === 0n && olYAfter.amount === 0n);
        R.check('openLoans(X) UNTOUCHED: same start, amount and agentId as at recordBorrow',
            olXAfter.start === olX.start && olXAfter.amount === olX.amount && olXAfter.agentId === olX.agentId,
            `start ${olXAfter.start} amt ${fmt(olXAfter.amount)}`);
        R.check('the older loan is still ACTIVE on the marketplace', (await mp.activeLoanCount(bId)) === 1n && (await mp.outstandingPrincipal(bId)) === AMOUNT_UNITS);

        // ------------------------------------------------- then the older one
        const rcRX = await L.send(S, `B repayLoan ${loanX} (the OLDER loan)`, mpB.repayLoan(loanX));
        R.tx(`repay X (#${loanX})`, rcRX);
        const blkX = await L.provider.getBlock(rcRX.blockNumber);
        const scoreAfterX = await rep['getReputationScore(uint256)'](bId);
        const heldX = blkX.timestamp - Number(olX.start);
        const expX = bonusOf(onTimeBonus, heldX, REF_DURATION, MIN_HOLD);
        const completedX = L.eventFromReceipt(rep.interface, rcRX, 'LoanCompleted');
        R.check('LoanCompleted for the older loan carries ITS loanId',
            completedX !== null && Number(completedX.args.loanId) === loanX, completedX ? `loanId ${completedX.args.loanId}` : 'no event');
        R.check(`score delta on repaying X == bonus from X's own ${heldX}s hold (${expX} pts)`,
            scoreAfterX - scoreAfterY === expX, `delta ${scoreAfterX - scoreAfterY}, expected ${expX}`);
        R.check('openLoans(X) deleted; no open-loan records remain for this agent',
            (await rep.openLoans(MP_ADDR, loanX)).start === 0n && (await mp.activeLoanCount(bId)) === 0n);

        const cons = await L.poolConservation(bId);
        R.check('per-pool conservation exact at the end', cons.conserved, `Σamt ${fmt(cons.sumAmt)} Σearned ${fmt(cons.sumEarned)}`);

        R.finish({
            agentId: bId, agentRole: bRole, perLoanAmount: fmt(AMOUNT_UNITS), loanX, loanY,
            timings: { startX: Number(olX.start), startY: Number(olY.start), repayY: blkY.timestamp, repayX: blkX.timestamp, heldY, heldX, heldFifoCounterfactual: heldFifo },
            bonuses: { byLoanId: expY.toString(), fifoCounterfactual: expFifo.toString(), olderLoan: expX.toString() }
        });
    } finally {
        await L.send(S, `restore setLadderParameters(refDuration = ${rdBefore})`,
            repOwner.setLadderParameters(L.LIVE_LEVERS.rep.creditMultiple, L.LIVE_LEVERS.rep.growthStep, L.LIVE_LEVERS.rep.bootstrapLimit, rdBefore));
        await L.send(S, `restore setMinHoldForReputationReward(${minHoldBefore})`,
            mpOwner.setMinHoldForReputationReward(minHoldBefore));
    }
}
main().catch(e => { console.error(e); process.exit(1); });
