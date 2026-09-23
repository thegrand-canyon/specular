/**
 * V9 — observation, run at the FULLY RESTORED live staging levers.
 *
 * `minHoldForReputationReward` (M-2, live value 86400 s) is documented as blunting
 * request→repay reputation FARMING. On V6.2 the marketplace folds it into the single
 * `onTime` boolean it passes to `recordLoanCompletion`:
 *
 *     recordLoanCompletion(holder, loanId, amount, onTime && heldLongEnough && paidInterest, lateSeconds)
 *
 * and ReputationManagerV4 advances the M1-2 ladder (`maxRepaidPrincipal`) inside that
 * same `else if (onTime)` branch. So a genuinely punctual repayment held for less than
 * `minHold` earns neither the bonus NOR any credit capacity. This script demonstrates
 * that on chain: a brand-new agent repays a 100 USDC loan on time within the minHold
 * window and its ladder does not move.
 *
 * This is behaviour, not a revert — reported as an informational finding.
 */
const L = require('./_lib');
const { USDC, fmt } = L;
const S = 'v9-minhold-ladder-coupling';

async function main() {
    await L.assertStaging();
    const R = new L.Results(S, 'minHoldForReputationReward also gates the credit ladder (observation, live levers)');
    const { mp, rep, reg } = L.contracts();
    const C = L.roleWallet('C'), T2 = L.roleWallet('T2');
    const mpC = L.contracts(C).mp, mpT2 = L.contracts(T2).mp;
    // Self-contained: agent C is registered here rather than inherited from another
    // scenario, so this runs against a fresh registry too. C stays at the bootstrap
    // rung run after run precisely because of the behaviour being demonstrated —
    // minHold gates the ladder, so C's repayments never advance maxRepaidPrincipal.
    await L.fundNative(C, '0.4', S);
    await L.ensureUsdc(C, 150, 300, S);
    await L.approveMax(C, 100000, S, 'C approve');
    const cId = await L.ensureAgent(C, S, 'C-minhold');

    const lv = await L.readLevers();
    R.check('running at LIVE levers: minHold 86400 s, refDuration 7 d, rate limit 5/day, onTimeBonus 10',
        lv.mp.minHold === 86400n && lv.rep.refDuration === 604800n && lv.rep.rateMaxGain === 5n && lv.rep.onTimeBonus === 10n,
        `minHold ${lv.mp.minHold} refDur ${lv.rep.refDuration}`);

    const boot = await rep.bootstrapLimit();       // the bootstrap rung, read from chain
    const pool = await mp.agentPools(cId);
    if (pool.availableLiquidity < boot + boot / 10n) {
        await L.ensureUsdc(T2, 150, 300, S);
        await L.approveMax(T2, 100000, S, 'T2 approve');
        R.tx('fund C pool', await L.send(S, `T2 supply ${fmt(boot + boot / 5n)} USDC to pool #${cId}`, mpT2.supplyLiquidity(cId, boot + boot / 5n)));
    }

    const before = await L.creditState(cId, C.address);
    R.note('agent C before', `score ${before.score} maxRepaid ${fmt(before.maxRepaid)} ladder ${fmt(before.ladder)} limit ${fmt(before.limit)} coll ${before.collPct}%`);
    R.check(`precondition: agent is at the bootstrap rung (maxRepaidPrincipal 0, limit ${fmt(boot)} USDC)`,
        before.maxRepaid === 0n && before.limit === boot, `maxRepaid ${fmt(before.maxRepaid)} limit ${fmt(before.limit)}`);

    const rcReq = await L.send(S, `C requestLoan ${fmt(boot)} USDC / 7 days`, mpC.requestLoan(boot, 7));
    const loanId = L.loanIdFromReceipt(mp, rcReq);
    R.tx(`requestLoan -> #${loanId}`, rcReq);
    const rcRep = await L.send(S, `C repayLoan ${loanId} well inside the 7-day term`, mpC.repayLoan(loanId));
    R.tx(`repayLoan ${loanId}`, rcRep);

    const loan = await mp.loans(loanId);
    const blk = await L.provider.getBlock(rcRep.blockNumber);
    const held = blk.timestamp - Number(loan.startTime);
    const rec = await mp.repayments(loanId);
    R.check('the repayment was genuinely ON TIME (lateSeconds == 0, well before endTime)',
        rec.lateSeconds === 0n && BigInt(blk.timestamp) < loan.endTime, `held ${held}s, term ${loan.duration}s`);
    R.check('held for less than minHoldForReputationReward', BigInt(held) < lv.mp.minHold, `${held}s < ${lv.mp.minHold}s`);

    const after = await L.creditState(cId, C.address);
    R.check('OBSERVATION: the ladder did NOT advance — maxRepaidPrincipal is still 0 after an on-time repayment',
        after.maxRepaid === 0n && after.ladder === before.ladder && after.limit === before.limit,
        `maxRepaid ${fmt(after.maxRepaid)} ladder ${fmt(after.ladder)} limit ${fmt(after.limit)}`);
    R.check('no LoanCompleted(onTime = true) and no CreditCapacityUpdated were emitted',
        (() => {
            const c = L.eventFromReceipt(rep.interface, rcRep, 'LoanCompleted');
            const cap = L.eventFromReceipt(rep.interface, rcRep, 'CreditCapacityUpdated');
            return c !== null && c.args.onTime === false && cap === null;
        })(), 'LoanCompleted.onTime == false');
    R.check('the score is unchanged too (no bonus, and no penalty — a neutral outcome)',
        after.score === before.score, `${before.score} -> ${after.score}`);
    R.note('reading', 'M-2 is documented as an anti-farming lever for the reputation BONUS; on V6.2/V4 it also gates capacity growth, because the ladder advance sits inside the same `else if (onTime)` branch. At the live minHold of 1 day, no loan held under 24 h can ever raise a credit line.');

    R.finish({ agentId: cId, loanId, heldSeconds: held, minHold: lv.mp.minHold.toString() });
}
main().catch(e => { console.error(e); process.exit(1); });
