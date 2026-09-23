/**
 * V2 — M2-c: the self-stake REQUIREMENT gates the sub-100 %-collateral tiers.
 *
 * ON-CHAIN (arc-staging). Exact boundary test against `requiredSelfStake(agentId, amount)`:
 *   selfStake == required - 1 base unit  -> requestLoan REVERTS "Insufficient self-stake"
 *   selfStake == required exactly        -> requestLoan SUCCEEDS
 * then the same boundary on AGGREGATE exposure with a loan already outstanding,
 * and a control showing the gate is inert at a 100 %-collateral tier.
 */
const L = require('./_lib');
const { USDC, fmt } = L;
const S = 'v2-self-stake-gate';
const LOAN1 = 400, LOAN2 = 100;

async function main() {
    await L.assertStaging();
    const R = new L.Results(S, 'M2-c self-stake requirement gates the unsecured tiers (on-chain)');
    const { mp, rep, reg } = L.contracts();
    const B = L.roleWallet('B'), A = L.roleWallet('A');
    const mpB = L.contracts(B).mp;
    const bId = Number(await reg.addressToAgentId(B.address));
    const aId = Number(await reg.addressToAgentId(A.address));

    const st = await L.creditState(bId, B.address);
    R.note('agent B', `#${bId} score ${st.score} collateral ${st.collPct}% ladder ${fmt(st.ladder)} creditLimit ${fmt(st.limit)} selfStake ${fmt(st.selfStake)}`);
    R.check('precondition: B is at a sub-100 % collateral tier and has no outstanding principal',
        st.collPct < 100n && st.outstanding === 0n, `coll ${st.collPct}%`);
    R.check(`precondition: creditLimit >= ${LOAN1 + LOAN2}`, st.limit >= USDC(LOAN1 + LOAN2), fmt(st.limit));

    // ------------------------------------------------- the requirement matches the spec exactly
    const k = await rep.creditMultiple();
    const required1 = await mp.requiredSelfStake(bId, USDC(LOAN1));
    const expected1 = (USDC(LOAN1) * (100n - st.collPct) / 100n) / k;
    R.check('requiredSelfStake(B, 400) == (outstanding+amount)·(100−collPct)/100 / k EXACTLY',
        required1 === expected1, `chain ${fmt(required1)} == computed ${fmt(expected1)} (k=${k}, collPct=${st.collPct})`);

    // control: the gate is inert where collateral is 100 %
    const aState = await L.creditState(aId, A.address);
    R.check('control: requiredSelfStake == 0 for a 100 %-collateral agent (agent A)',
        (await mp.requiredSelfStake(aId, USDC(100))) === 0n && aState.collPct === 100n, `A coll ${aState.collPct}%`);

    // ------------------------------------------------- set the stake one base unit SHORT
    let stake = (await mp.selfStake(bId)).amount;
    if (stake > required1 - 1n) {
        R.tx('trim stake', await L.send(S, `B withdraw ${fmt(stake - (required1 - 1n))} to sit 1 unit short`, mpB.withdrawLiquidity(bId, stake - (required1 - 1n))));
    } else if (stake < required1 - 1n) {
        R.tx('stake to required-1', await L.send(S, `B supply ${fmt(required1 - 1n - stake)} (creator, below minSupply is allowed)`, mpB.supplyLiquidity(bId, required1 - 1n - stake)));
    }
    stake = (await mp.selfStake(bId)).amount;
    R.check('creator stake is exactly requiredSelfStake − 1 base unit', stake === required1 - 1n, `${stake} vs required ${required1}`);

    const rvShort = await L.expectRevert(mpB.requestLoan(USDC(LOAN1), 7), 'Insufficient self-stake');
    R.check(`requestLoan(${LOAN1}) REVERTS "Insufficient self-stake" at required − 1`, rvShort.reverted && rvShort.matched, rvShort.message.slice(0, 150));
    R.check('the refused loan created no state: nextLoanId and outstanding unchanged',
        (await mp.outstandingPrincipal(bId)) === 0n && (await mp.activeLoanCount(bId)) === 0n);

    // ------------------------------------------------- top up the last base unit
    R.tx('top up 1 unit', await L.send(S, 'B supply the final 1 base unit (0.000001 USDC)', mpB.supplyLiquidity(bId, 1n)));
    stake = (await mp.selfStake(bId)).amount;
    R.check('creator stake is now exactly requiredSelfStake', stake === required1, `${fmt(stake)}`);

    const rc1 = await L.send(S, `B requestLoan ${LOAN1} at exactly the required stake`, mpB.requestLoan(USDC(LOAN1), 7));
    const loan1 = L.loanIdFromReceipt(mp, rc1);
    R.tx(`requestLoan ${LOAN1} -> loan #${loan1}`, rc1);
    R.check(`requestLoan(${LOAN1}) SUCCEEDS at exactly the required stake`,
        (await mp.outstandingPrincipal(bId)) === USDC(LOAN1), `outstanding ${fmt(await mp.outstandingPrincipal(bId))}`);

    // ------------------------------------------------- the requirement is on AGGREGATE exposure
    const required2 = await mp.requiredSelfStake(bId, USDC(LOAN2));
    const expected2 = ((USDC(LOAN1) + USDC(LOAN2)) * (100n - st.collPct) / 100n) / k;
    R.check('requiredSelfStake(B, +100) is computed on AGGREGATE exposure (outstanding 400 + 100)',
        required2 === expected2 && required2 > required1, `${fmt(required2)} (was ${fmt(required1)})`);
    const rvAgg = await L.expectRevert(mpB.requestLoan(USDC(LOAN2), 7), 'Insufficient self-stake');
    R.check(`a SECOND loan of ${LOAN2} REVERTS at the stake that sufficed for the first`, rvAgg.reverted && rvAgg.matched, rvAgg.message.slice(0, 150));

    R.tx('top up to aggregate requirement', await L.send(S, `B supply ${fmt(required2 - required1)} to meet the aggregate requirement`, mpB.supplyLiquidity(bId, required2 - required1)));
    R.check('creator stake now equals the aggregate requirement exactly', (await mp.selfStake(bId)).amount === required2, fmt(required2));
    const rc2 = await L.send(S, `B requestLoan ${LOAN2} (aggregate requirement met)`, mpB.requestLoan(USDC(LOAN2), 7));
    const loan2 = L.loanIdFromReceipt(mp, rc2);
    R.tx(`requestLoan ${LOAN2} -> loan #${loan2}`, rc2);
    R.check('second loan SUCCEEDS once the aggregate stake is met',
        (await mp.outstandingPrincipal(bId)) === USDC(LOAN1 + LOAN2));

    // ------------------------------------------------- unwind
    R.tx(`repay ${loan1}`, await L.send(S, `B repayLoan ${loan1}`, mpB.repayLoan(loan1)));
    R.tx(`repay ${loan2}`, await L.send(S, `B repayLoan ${loan2}`, mpB.repayLoan(loan2)));
    R.check('all principal repaid; self-stake unlocked', (await mp.selfStake(bId)).locked === false);
    const cons = await L.poolConservation(bId);
    R.check('per-pool conservation exact at the end', cons.conserved, `Σamt ${fmt(cons.sumAmt)} Σearned ${fmt(cons.sumEarned)}`);

    R.finish({
        agentId: bId, loans: [loan1, loan2],
        requiredSelfStake: { forFirst: required1.toString(), aggregate: required2.toString() }
    });
}
main().catch(e => { console.error(e); process.exit(1); });
