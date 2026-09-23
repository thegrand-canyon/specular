/**
 * S2 — F-02 pending-tranche semantics on V6.1 (top-ups while loans are in flight).
 *
 *  1. A opens loan #1; L1 tops up → case (b) new pending tranche; L1's qualified
 *     amount for loan #1 unchanged.
 *  2. L1 tops up again with only loan #1 open → case (d) merge+re-stamp; still lossless.
 *  3. A opens loan #2 (starts after the pending stamp); L1 top-up → case (e):
 *     canTopUp == false, contract reverts "Top-up would forfeit in-flight interest",
 *     SDK supply() refuses before sending.
 *  4. A repays loan #1 → top-up now folds (case c): base keeps its stamp, pending :=
 *     new money; qualified amount for loan #2 unchanged.
 *  5. A repays loan #2; interest shares asserted exact using the qualified amounts.
 *  6. With no loans open a top-up merges everything into the base tranche (case a).
 *
 * Requires S1 to have run (uses A's pool with L1/L2 positions). Re-runnable.
 */
const L = require('./_lib');
const { SpecularQuickstart } = require('../../src/sdk/SpecularQuickstart');
const { USDC, fmt } = L;
const S = 'S2';

async function main() {
    await L.assertStaging();
    const R = new L.Results(S);
    const { mp, usdc } = L.contracts();
    const A = L.roleWallet('A'), L1 = L.roleWallet('L1'), L2 = L.roleWallet('L2'), L3 = L.roleWallet('L3');
    await L.fundNative(A, '1.0', S); await L.fundNative(L1, '1.0', S);
    if ((await usdc.balanceOf(L1.address)) < USDC(60)) await L.mintUsdc(L1.address, 100, S);
    if ((await usdc.balanceOf(A.address)) < USDC(150)) await L.mintUsdc(A.address, 200, S);

    const sdkA = new SpecularQuickstart(A, 'arc-staging');
    const sdkL1 = new SpecularQuickstart(L1, 'arc-staging');
    const aId = (await sdkA.onboard()).agentId;
    const lenders = { L1: L1.address, L2: L2.address, L3: L3.address };
    const mpL1 = L.contracts(L1).mp;

    // Pre-condition: no active loans, L1 has a base position with no pending tranche
    if ((await mp.activeLoanCount(aId)) !== 0n) throw new Error('precondition: A must have no active loans (run S1 first / let S2 finish)');
    let s0 = await L.poolSnapshot(aId, lenders);
    if (s0.positions.L1.amount === 0n) { await sdkL1.supply(aId, 100); s0 = await L.poolSnapshot(aId, lenders); }
    R.note('L1 starting position', `amount ${fmt(s0.positions.L1.amount)} pending ${fmt(s0.positions.L1.pendingAmount)} depositTs ${s0.positions.L1.depositTimestamp}`);
    const baseTs0 = s0.positions.L1.depositTimestamp;
    const baseAmt0 = s0.positions.L1.amount - s0.positions.L1.pendingAmount;

    // 1. loan #1
    const { loanId: loan1, tx: b1 } = await sdkA.borrow(50, 7);
    L.logTx(S, `A borrow 50 (loan ${loan1})`, await L.provider.getTransactionReceipt(b1));
    const ln1 = await mp.loans(loan1);
    const q1Before = await mp.qualifiedAmountAt(aId, L1.address, ln1.startTime);
    R.check('L1 qualified for loan #1 == full pre-loan position', q1Before === s0.positions.L1.amount, `${q1Before}`);

    const canB = await mp.canTopUp(aId, L1.address);
    R.check('canTopUp(A, L1) true before first top-up (no pending tranche → case b)', canB === true);
    const t1 = await sdkL1.supply(aId, 20);
    L.logTx(S, 'L1 top-up 20 during loan #1 (case b)', await L.provider.getTransactionReceipt(t1));
    let s1 = await L.poolSnapshot(aId, lenders);
    R.check('case (b): base tranche timestamp unchanged, pending = 20 stamped now', s1.positions.L1.depositTimestamp === baseTs0 && s1.positions.L1.pendingAmount === USDC(20) && s1.positions.L1.pendingTimestamp > ln1.startTime, `pendingTs ${s1.positions.L1.pendingTimestamp} loan1.start ${ln1.startTime}`);
    R.check('position.amount += 20', s1.positions.L1.amount === s0.positions.L1.amount + USDC(20));
    R.check('L1 qualified for loan #1 UNCHANGED after top-up (F-02 fixed)', (await mp.qualifiedAmountAt(aId, L1.address, ln1.startTime)) === q1Before);

    // 2. second top-up, still only loan #1 open → case (d) merge + re-stamp
    R.check('canTopUp still true (no active loan started since pending stamp → case d)', (await mp.canTopUp(aId, L1.address)) === true);
    const t2 = await sdkL1.supply(aId, 10);
    L.logTx(S, 'L1 top-up 10 during loan #1 (case d)', await L.provider.getTransactionReceipt(t2));
    let s2 = await L.poolSnapshot(aId, lenders);
    R.check('case (d): pending merged to 30 and re-stamped; base ts unchanged', s2.positions.L1.pendingAmount === USDC(30) && s2.positions.L1.pendingTimestamp >= s1.positions.L1.pendingTimestamp && s2.positions.L1.depositTimestamp === baseTs0);
    R.check('L1 qualified for loan #1 still unchanged', (await mp.qualifiedAmountAt(aId, L1.address, ln1.startTime)) === q1Before);
    const pendingTsBeforeLoan2 = s2.positions.L1.pendingTimestamp;

    // 3. loan #2 opens after the pending stamp → un-mergeable case (e)
    const { loanId: loan2, tx: b2 } = await sdkA.borrow(30, 7);
    L.logTx(S, `A borrow 30 (loan ${loan2})`, await L.provider.getTransactionReceipt(b2));
    const ln2 = await mp.loans(loan2);
    R.check('loan #2 started after pending stamp', ln2.startTime > pendingTsBeforeLoan2, `${ln2.startTime} > ${pendingTsBeforeLoan2}`);
    const q2 = await mp.qualifiedAmountAt(aId, L1.address, ln2.startTime);
    R.check('L1 qualified for loan #2 == base + pending (130)', q2 === s2.positions.L1.amount, `${q2}`);
    R.check('canTopUp(A, L1) == false (case e)', (await mp.canTopUp(aId, L1.address)) === false);
    R.check('SDK canTopUp mirrors contract', (await sdkL1.canTopUp(aId)) === false);
    await L.approve(L1, USDC(5), S, 'L1 approve (for direct revert probe)');
    const rv = await L.expectRevert(mpL1.supplyLiquidity(aId, USDC(5)), 'Top-up would forfeit in-flight interest');
    R.check('direct supplyLiquidity reverts "Top-up would forfeit in-flight interest"', rv.reverted && rv.matched, rv.message.slice(0, 120));
    let sdkErr = null;
    try { await sdkL1.supply(aId, 5); } catch (e) { sdkErr = e.message; }
    R.check('SDK supply() refuses before sending (pre-check message)', sdkErr && /would forfeit in-flight interest/.test(sdkErr), (sdkErr || '').slice(0, 140));
    R.check('a NEW lender is never refused (L3 with 0 principal can supply)', (await mp.canTopUp(aId, L3.address)) === true);
    await L.send(S, 'L1 revoke approval', L.contracts(L1).usdc.approve(L.cfg.agentLiquidityMarketplace_v6, 0n));
    const s3 = await L.poolSnapshot(aId, lenders);
    R.check('failed top-up changed nothing', s3.positions.L1.amount === s2.positions.L1.amount && s3.positions.L1.pendingAmount === USDC(30));

    // 4. repay loan #1 → case (c) fold becomes possible
    const feesA = await mp.accumulatedFees();
    const int1 = await mp.calculateInterest(ln1.amount, ln1.interestRate, ln1.duration);
    const lenderInt1 = int1 - (int1 * 100n) / 10000n;
    const qTot1 = (await mp.qualifiedAmountAt(aId, L1.address, ln1.startTime)) + (await mp.qualifiedAmountAt(aId, L2.address, ln1.startTime)) + (await mp.qualifiedAmountAt(aId, L3.address, ln1.startTime));
    const expL1_1 = (lenderInt1 * q1Before) / qTot1;
    const expL2_1 = (lenderInt1 * (await mp.qualifiedAmountAt(aId, L2.address, ln1.startTime))) / qTot1;
    const r1 = await sdkA.repay(loan1);
    L.logTx(S, `A repay loan ${loan1}`, await L.provider.getTransactionReceipt(r1));
    const s4 = await L.poolSnapshot(aId, lenders);
    R.check('loan #1 interest: L1 share uses base-only qualified amount (pending 30 excluded)', s4.positions.L1.earnedInterest - s3.positions.L1.earnedInterest === expL1_1, `L1 +${s4.positions.L1.earnedInterest - s3.positions.L1.earnedInterest} expected ${expL1_1} (q ${q1Before}/${qTot1})`);
    R.check('loan #1 interest: L2 share exact', s4.positions.L2.earnedInterest - s3.positions.L2.earnedInterest === expL2_1, `${expL2_1}`);
    R.check('canTopUp(A, L1) true again after loan #1 closed (case c)', (await mp.canTopUp(aId, L1.address)) === true);
    const t3 = await sdkL1.supply(aId, 10);
    L.logTx(S, 'L1 top-up 10 with only loan #2 open (case c fold)', await L.provider.getTransactionReceipt(t3));
    const s5 = await L.poolSnapshot(aId, lenders);
    R.check('case (c): pending := 10 (new money only), old pending folded into base, base ts unchanged', s5.positions.L1.pendingAmount === USDC(10) && s5.positions.L1.depositTimestamp === baseTs0 && s5.positions.L1.amount === s4.positions.L1.amount + USDC(10), `amount ${fmt(s5.positions.L1.amount)} pending ${fmt(s5.positions.L1.pendingAmount)}`);
    R.check('L1 qualified for loan #2 UNCHANGED by the fold (lossless)', (await mp.qualifiedAmountAt(aId, L1.address, ln2.startTime)) === q2, `${await mp.qualifiedAmountAt(aId, L1.address, ln2.startTime)} == ${q2}`);
    R.check('pending ⊆ amount invariant', s5.positions.L1.pendingAmount <= s5.positions.L1.amount);

    // 5. repay loan #2 — shares exact with qualified amounts
    const int2 = await mp.calculateInterest(ln2.amount, ln2.interestRate, ln2.duration);
    const lenderInt2 = int2 - (int2 * 100n) / 10000n;
    const qL1 = await mp.qualifiedAmountAt(aId, L1.address, ln2.startTime), qL2 = await mp.qualifiedAmountAt(aId, L2.address, ln2.startTime), qL3 = await mp.qualifiedAmountAt(aId, L3.address, ln2.startTime);
    const qTot2 = qL1 + qL2 + qL3;
    const r2 = await sdkA.repay(loan2);
    L.logTx(S, `A repay loan ${loan2}`, await L.provider.getTransactionReceipt(r2));
    const s6 = await L.poolSnapshot(aId, lenders);
    R.check('loan #2 interest: L1 share == lenderInterest × 130/180 exact', s6.positions.L1.earnedInterest - s5.positions.L1.earnedInterest === (lenderInt2 * qL1) / qTot2, `+${s6.positions.L1.earnedInterest - s5.positions.L1.earnedInterest} (q ${qL1}/${qTot2})`);
    R.check('loan #2 interest: L2 share exact', s6.positions.L2.earnedInterest - s5.positions.L2.earnedInterest === (lenderInt2 * qL2) / qTot2);
    const dust = (lenderInt1 - expL1_1 - expL2_1) + (lenderInt2 - (lenderInt2 * qL1) / qTot2 - (lenderInt2 * qL2) / qTot2);
    R.check('fees += 1% of both interests + dust', (await mp.accumulatedFees()) - feesA === (int1 * 100n) / 10000n + (int2 * 100n) / 10000n + dust, `dust ${dust}`);
    R.check('activeLoanCount 0, getActiveLoanIds empty', s6.activeLoanCount === 0n && (await mp.getActiveLoanIds(aId)).length === 0);

    // 6. no loans open → case (a): everything becomes one base tranche stamped now
    const t4 = await sdkL1.supply(aId, 5);
    const rc4 = await L.provider.getTransactionReceipt(t4);
    L.logTx(S, 'L1 top-up 5 with no loans open (case a)', rc4);
    const s7 = await L.poolSnapshot(aId, lenders);
    const blk = await L.provider.getBlock(rc4.blockNumber);
    R.check('case (a): pending cleared, depositTimestamp re-stamped to the top-up block', s7.positions.L1.pendingAmount === 0n && s7.positions.L1.pendingTimestamp === 0n && Number(s7.positions.L1.depositTimestamp) === blk.timestamp && s7.positions.L1.amount === s6.positions.L1.amount + USDC(5), `ts ${s7.positions.L1.depositTimestamp} block ${blk.timestamp}`);
    R.check('PendingTrancheUpdated(…,0,0) emitted on clear', rc4.logs.some(lg => { try { const p = mp.interface.parseLog(lg); return p && p.name === 'PendingTrancheUpdated' && p.args.pendingAmount === 0n; } catch (e) { return false; } }));
    R.check('per-pool conservation holds', s7.availableLiquidity + s7.totalLoaned === Object.values(s7.positions).reduce((s, p) => s + p.amount + p.earnedInterest, 0n));
    const g = await L.globalSolvency();
    R.check('GLOBAL solvency exact', g.exact, `surplus ${g.surplus}`);

    R.finish({ agentId: aId, loans: [loan1, loan2] });
}
main().catch((e) => { console.error(e); process.exit(1); });
