/**
 * V3 — M1-2: the credit ladder, measured rung by rung against the shipped parameters.
 *
 * ON-CHAIN (arc-staging), at k = 2 / growthStep = 100 USDC / bootstrapLimit = 100 USDC
 * (the live shipped values — NOT altered by this suite).
 *
 *   creditLimit = min( tierLimit(score), max(bootstrapLimit, k·maxRepaidPrincipal + growthStep) )
 *
 * `onTimeRepaymentBonus` is set to 0 for the duration of this script so the agent's
 * SCORE (and therefore its tier) is held constant and the ladder is isolated. The
 * ladder advances on `onTime`, independently of the bonus, so this changes nothing
 * being measured. Restored to the suite value at the end.
 *
 * The rung table is COMPUTED from the parameters read off chain, never hardcoded, and
 * the run allocates a VIRGIN agent (`V3LADDER-n`): the measurement has to start at
 * `maxRepaidPrincipal == 0` and nothing can put a used agent back there. At the
 * shipped parameters and tier 0 (limit 1,000 USDC) that table is:
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

    // This scenario measures the ladder FROM THE BOOTSTRAP RUNG, so it needs an agent
    // with `maxRepaidPrincipal == 0`. Nothing on chain can put an agent back there
    // (only a default resets it, and that arms a 180-day lockout), so the run consumes
    // its agent: allocate the next virgin one instead of reusing a fixed role. That
    // also makes the scenario correct on a FRESH V7 deploy, where reputation does not
    // migrate and every agent is back at the bootstrap rung anyway.
    const { wallet: A, role: aRole } = await L.freshRoleWallet('V3LADDER', async (w) => {
        const id = await reg.addressToAgentId(w.address);
        if (id === 0n) return true;
        return (await rep.maxRepaidPrincipal(id)) === 0n && (await mp.activeLoanCount(id)) === 0n;
    });
    const LA = L.roleWallet('LA');
    const mpA = L.contracts(A).mp, mpLA = L.contracts(LA).mp, repOwner = L.contracts(L.deployer).rep;

    await L.fundNative(A, '1.2', S);
    const aId = await L.ensureAgent(A, S, aRole);
    R.note('ladder agent (virgin, allocated for this run)', `${aRole} #${aId} ${A.address}`);

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

        // ---- the rung table is COMPUTED from the shipped parameters read above and
        //      from the agent's own tier limit, never hardcoded. The score is frozen
        //      (onTimeBonus = 0) for the duration, so `tierLimit` is constant, and each
        //      rung borrows exactly `creditLimit` and repays it, so the next
        //      `maxRepaidPrincipal` is the limit just borrowed.
        const RUNGS = 5;
        const expected = [];
        for (let i = 0, mr = 0n; i < RUNGS; i++) {
            const ladder = (k * mr + step) > boot ? (k * mr + step) : boot;
            const limit = ladder < st.tierLimit ? ladder : st.tierLimit;
            expected.push({ maxRepaid: mr, ladder, limit, borrow: i < RUNGS - 1 ? limit : null });
            mr = limit;
        }
        R.note('expected rungs (computed from the shipped parameters)',
            expected.map(e => `maxRepaid ${fmt(e.maxRepaid)} -> ladder ${fmt(e.ladder)} / limit ${fmt(e.limit)}`).join(' | '));

        // fund the agent for its largest single collateralised borrow, plus interest
        const peakBorrow = expected.reduce((m, e) => (e.borrow && e.borrow > m ? e.borrow : m), 0n);
        await L.ensureUsdc(A, Number(fmt(peakBorrow)) + 50, Number(fmt(peakBorrow)) + 400, S);
        await L.approveMax(A, 100000, S, `${aRole} approve`);
        const poolNeed = peakBorrow + peakBorrow / 10n;
        if ((await mp.agentPools(aId)).availableLiquidity < poolNeed) {
            await L.ensureUsdc(LA, Number(fmt(poolNeed)), Number(fmt(poolNeed)) + 400, S);
            R.tx('lender supply', await L.send(S, `LA supply ${fmt(poolNeed)} USDC to pool #${aId}`, mpLA.supplyLiquidity(aId, poolNeed)));
        }

        // ------------------------------------------------- rung-by-rung
        const rungs = [];
        for (let i = 0; i < expected.length; i++) {
            const e = expected[i];
            st = await L.creditState(aId, A.address);
            const ladderChain = await rep.ladderLimit(aId);

            R.check(`rung ${i}: maxRepaidPrincipal == ${fmt(e.maxRepaid)} USDC`, st.maxRepaid === e.maxRepaid, fmt(st.maxRepaid));
            R.check(`rung ${i}: ladderLimit == max(bootstrap, k·maxRepaid + step) == ${fmt(e.ladder)} USDC`,
                ladderChain === e.ladder && ladderChain === (k * st.maxRepaid + step > boot ? k * st.maxRepaid + step : boot),
                `${fmt(ladderChain)}`);
            R.check(`rung ${i}: calculateCreditLimit == min(tierLimit ${fmt(st.tierLimit)}, ladder ${fmt(ladderChain)}) == ${fmt(e.limit)} USDC`,
                st.limit === e.limit && st.limit === (ladderChain < st.tierLimit ? ladderChain : st.tierLimit), fmt(st.limit));
            R.check(`rung ${i}: creditLimit <= tier limit`, st.limit <= st.tierLimit, `${fmt(st.limit)} <= ${fmt(st.tierLimit)}`);
            rungs.push({ rung: i, score: st.score.toString(), maxRepaid: fmt(st.maxRepaid), ladder: fmt(ladderChain), tierLimit: fmt(st.tierLimit), creditLimit: fmt(st.limit) });

            if (i === 0) {
                const rvOver = await L.expectRevert(mpA.requestLoan(st.limit + 1n, 7), 'Exceeds credit limit');
                R.check('rung 0: borrowing creditLimit + 1 base unit REVERTS "Exceeds credit limit"', rvOver.reverted && rvOver.matched, rvOver.message.slice(0, 120));
            }
            if (e.borrow === null) break;

            const rcReq = await L.send(S, `rung ${i}: A requestLoan ${fmt(e.borrow)} USDC (== creditLimit)`, mpA.requestLoan(e.borrow, 7));
            const loanId = L.loanIdFromReceipt(mp, rcReq);
            R.tx(`rung ${i} requestLoan ${fmt(e.borrow)}`, rcReq);
            await L.sleep(2500);
            const rcRep = await L.send(S, `rung ${i}: A repayLoan ${loanId}`, mpA.repayLoan(loanId));
            R.tx(`rung ${i} repayLoan ${loanId}`, rcRep);
            const cap = L.eventFromReceipt(rep.interface, rcRep, 'CreditCapacityUpdated');
            R.check(`rung ${i}: CreditCapacityUpdated(agent, ${fmt(e.borrow)}) emitted on the on-time repayment`,
                cap !== null && cap.args.maxRepaidPrincipal === e.borrow, cap ? fmt(cap.args.maxRepaidPrincipal) : 'not emitted');
        }

        // ------------------------------------------------- strict growth / no deadlock
        const ladders = rungs.map(r => Number(r.ladder));
        const strictly = ladders.every((v, i) => i === 0 || v > ladders[i - 1]);
        R.check('the ladder STRICTLY GROWS at every rung (no k=1 deadlock)', strictly, ladders.join(' -> '));
        R.check('the ladder is never bounded by itself: head-room always exceeds the record it beat',
            rungs.every(r => Number(r.ladder) > Number(r.maxRepaid)), rungs.map(r => `${r.maxRepaid}->${r.ladder}`).join(', '));
        R.check('credit limit never exceeded the tier limit at any rung',
            rungs.every(r => Number(r.creditLimit) <= Number(r.tierLimit)), rungs.map(r => `${r.creditLimit}<=${r.tierLimit}`).join(', '));
        // The tier cap must bind at the first rung whose ladder head-room exceeds the
        // tier limit, and at every rung after it — the rung index is derived, not assumed.
        const firstCapped = expected.findIndex(e => e.ladder > e.limit);
        R.check('the TIER CAP binds at the first rung whose ladder exceeds the tier limit, and at every rung after it',
            firstCapped > 0 && rungs.slice(firstCapped).every((r, j) =>
                r.creditLimit === r.tierLimit && Number(r.ladder) > Number(r.tierLimit)),
            `first capped rung ${firstCapped}: ` + rungs.map(r => `${r.ladder}/${r.tierLimit}->${r.creditLimit}`).join(', '));

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
