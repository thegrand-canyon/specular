/**
 * V3 — M1-2: the credit ladder, measured rung by rung against the shipped parameters.
 *
 * ON-CHAIN (arc-staging), agent A, at k = 2 / growthStep = 100 USDC / bootstrapLimit = 100 USDC
 * (the live shipped values — NOT altered by this suite).
 *
 *   creditLimit = min( tierLimit(score), max(bootstrapLimit, k·maxRepaidPrincipal + growthStep) )
 *
 * `onTimeRepaymentBonus` is set to 0 for the duration of this script so the agent's
 * SCORE (and therefore its tier) is held constant and the ladder is isolated. The
 * ladder advances on `onTime`, independently of the bonus, so this changes nothing
 * being measured. Restored to the suite value at the end.
 *
 * Expected rungs at the shipped parameters, tier 0 (score 100, limit 1,000 USDC):
 *   ladder  100 -> 300 -> 700 -> 1500 -> 2100   (strictly increasing: no k=1 deadlock)
 *   limit   100 -> 300 -> 700 -> 1000 -> 1000   (tier cap binds from rung 3)
 */
const L = require('./_lib');
const { USDC, fmt } = L;
const S = 'v3-credit-ladder';

async function main() {
    await L.assertStaging();
    const R = new L.Results(S, 'M1-2 credit ladder: exact rungs, strict growth, tier cap (on-chain)');
    const { mp, rep, reg } = L.contracts();
    const A = L.roleWallet('A'), LA = L.roleWallet('LA');
    const mpA = L.contracts(A).mp, mpLA = L.contracts(LA).mp, repOwner = L.contracts(L.deployer).rep;
    const aId = Number(await reg.addressToAgentId(A.address));

    const k = await rep.creditMultiple(), step = await rep.growthStep(), boot = await rep.bootstrapLimit();
    R.check('shipped ladder parameters on chain: k = 2, growthStep = 100 USDC, bootstrapLimit = 100 USDC',
        k === 2n && step === USDC(100) && boot === USDC(100), `k=${k} step=${fmt(step)} boot=${fmt(boot)}`);

    // freeze the score so the tier cannot move under the measurement
    const bonusBefore = await rep.onTimeRepaymentBonus();
    await L.send(S, 'setScoringParameters(onTimeBonus = 0) — freeze the score for this measurement',
        repOwner.setScoringParameters(0, L.LIVE_LEVERS.rep.defaultPenaltyBase, L.LIVE_LEVERS.rep.defaultPenaltyLarge, L.LIVE_LEVERS.rep.largeLoanThreshold));

    try {
        let st = await L.creditState(aId, A.address);
        R.note('agent A', `#${aId} score ${st.score} tier limit ${fmt(st.tierLimit)} collateral ${st.collPct}%`);
        R.check('precondition: maxRepaidPrincipal == 0 (agent starts at the bootstrap rung)', st.maxRepaid === 0n, fmt(st.maxRepaid));

        if ((await mp.positions(aId, LA.address)).amount < USDC(1000)) {
            R.tx('lender supply', await L.send(S, `LA supply 1100 USDC to pool #${aId}`, mpLA.supplyLiquidity(aId, USDC(1100))));
        }

        // ------------------------------------------------- rung-by-rung
        const rungs = [];
        const expected = [
            { maxRepaid: 0,    ladder: 100,  limit: 100,  borrow: 100 },
            { maxRepaid: 100,  ladder: 300,  limit: 300,  borrow: 300 },
            { maxRepaid: 300,  ladder: 700,  limit: 700,  borrow: 700 },
            { maxRepaid: 700,  ladder: 1500, limit: 1000, borrow: 1000 }, // tier cap binds
            { maxRepaid: 1000, ladder: 2100, limit: 1000, borrow: null }
        ];

        for (let i = 0; i < expected.length; i++) {
            const e = expected[i];
            st = await L.creditState(aId, A.address);
            const ladderChain = await rep.ladderLimit(aId);

            R.check(`rung ${i}: maxRepaidPrincipal == ${e.maxRepaid} USDC`, st.maxRepaid === USDC(e.maxRepaid), fmt(st.maxRepaid));
            R.check(`rung ${i}: ladderLimit == max(bootstrap, k·maxRepaid + step) == ${e.ladder} USDC`,
                ladderChain === USDC(e.ladder) && ladderChain === (k * st.maxRepaid + step > boot ? k * st.maxRepaid + step : boot),
                `${fmt(ladderChain)}`);
            R.check(`rung ${i}: calculateCreditLimit == min(tierLimit ${fmt(st.tierLimit)}, ladder ${fmt(ladderChain)}) == ${e.limit} USDC`,
                st.limit === USDC(e.limit) && st.limit === (ladderChain < st.tierLimit ? ladderChain : st.tierLimit), fmt(st.limit));
            R.check(`rung ${i}: creditLimit <= tier limit`, st.limit <= st.tierLimit, `${fmt(st.limit)} <= ${fmt(st.tierLimit)}`);
            rungs.push({ rung: i, score: st.score.toString(), maxRepaid: fmt(st.maxRepaid), ladder: fmt(ladderChain), tierLimit: fmt(st.tierLimit), creditLimit: fmt(st.limit) });

            if (i === 0) {
                const rvOver = await L.expectRevert(mpA.requestLoan(st.limit + 1n, 7), 'Exceeds credit limit');
                R.check('rung 0: borrowing creditLimit + 1 base unit REVERTS "Exceeds credit limit"', rvOver.reverted && rvOver.matched, rvOver.message.slice(0, 120));
            }
            if (e.borrow === null) break;

            const rcReq = await L.send(S, `rung ${i}: A requestLoan ${e.borrow} USDC (== creditLimit)`, mpA.requestLoan(USDC(e.borrow), 7));
            const loanId = L.loanIdFromReceipt(mp, rcReq);
            R.tx(`rung ${i} requestLoan ${e.borrow}`, rcReq);
            await L.sleep(2500);
            const rcRep = await L.send(S, `rung ${i}: A repayLoan ${loanId}`, mpA.repayLoan(loanId));
            R.tx(`rung ${i} repayLoan ${loanId}`, rcRep);
            const cap = L.eventFromReceipt(rep.interface, rcRep, 'CreditCapacityUpdated');
            R.check(`rung ${i}: CreditCapacityUpdated(agent, ${e.borrow}) emitted on the on-time repayment`,
                cap !== null && cap.args.maxRepaidPrincipal === USDC(e.borrow), cap ? fmt(cap.args.maxRepaidPrincipal) : 'not emitted');
        }

        // ------------------------------------------------- strict growth / no deadlock
        const ladders = rungs.map(r => Number(r.ladder));
        const strictly = ladders.every((v, i) => i === 0 || v > ladders[i - 1]);
        R.check('the ladder STRICTLY GROWS at every rung (no k=1 deadlock)', strictly, ladders.join(' -> '));
        R.check('the ladder is never bounded by itself: head-room always exceeds the record it beat',
            rungs.every(r => Number(r.ladder) > Number(r.maxRepaid)), rungs.map(r => `${r.maxRepaid}->${r.ladder}`).join(', '));
        R.check('credit limit never exceeded the tier limit at any rung',
            rungs.every(r => Number(r.creditLimit) <= Number(r.tierLimit)), rungs.map(r => `${r.creditLimit}<=${r.tierLimit}`).join(', '));
        R.check('the TIER CAP binds from rung 3 (ladder 1500 > tier 1000 -> limit 1000)',
            rungs[3].ladder === '1500.0' && rungs[3].creditLimit === '1000.0' && rungs[4].ladder === '2100.0' && rungs[4].creditLimit === '1000.0');

        // the k = 1 + step = 0 deadlock is refused by the setter
        const rvStep = await L.expectRevert(repOwner.setLadderParameters(1, 0, USDC(100), 1), 'growthStep must be > 0');
        R.check('setLadderParameters(k=1, growthStep=0) REVERTS "growthStep must be > 0" (deadlock guard)', rvStep.reverted && rvStep.matched, rvStep.message.slice(0, 120));
        R.check('ladder parameters unchanged by the refused call', (await rep.creditMultiple()) === 2n && (await rep.growthStep()) === USDC(100));

        const cons = await L.poolConservation(aId);
        R.check('per-pool conservation exact at the end', cons.conserved, `Σamt ${fmt(cons.sumAmt)} Σearned ${fmt(cons.sumEarned)}`);
        R.finish({ agentId: aId, rungs });
    } finally {
        await L.send(S, `restore setScoringParameters(onTimeBonus = ${bonusBefore})`,
            repOwner.setScoringParameters(bonusBefore, L.LIVE_LEVERS.rep.defaultPenaltyBase, L.LIVE_LEVERS.rep.defaultPenaltyLarge, L.LIVE_LEVERS.rep.largeLoanThreshold));
    }
}
main().catch(e => { console.error(e); process.exit(1); });
