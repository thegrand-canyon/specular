/**
 * V1 — M2-a: the pool creator's own position is LOCKED while the agent borrows.
 *
 * ON-CHAIN (arc-staging). Agent B is at the 0 %-collateral tier, so its own stake is
 * genuine first-loss capital and the lock is the thing that makes it unrecoverable.
 *
 *   1. read selfStake(agentId) with no loan open            -> (amount, locked=false)
 *   2. creator tops its stake to the M2-c requirement, a THIRD PARTY (T) supplies too
 *   3. creator borrows                                       -> locked flips to true
 *   4. creator withdrawLiquidity REVERTS "Self-stake locked while borrowing"
 *      (both a 1-unit probe and the whole position)
 *   5. the third-party lender in the SAME pool CAN still withdraw
 *   6. creator repays                                        -> locked flips to false
 *   7. creator withdraws its whole stake successfully
 */
const L = require('./_lib');
const { USDC, fmt } = L;
const S = 'v1-self-stake-lock';
const LOAN = 500;

async function main() {
    await L.assertStaging();
    const R = new L.Results(S, 'M2-a self-stake lock while borrowing (on-chain)');
    const { mp, rep } = L.contracts();
    const B = L.roleWallet('B'), T = L.roleWallet('T');
    const mpB = L.contracts(B).mp, mpT = L.contracts(T).mp;
    const bId = Number(await L.contracts().reg.addressToAgentId(B.address));
    R.note('agent', `B = #${bId} (${B.address}), third-party lender T = ${T.address}`);

    // ---------------------------------------------------------------- 1. unlocked baseline
    let ss = await mp.selfStake(bId);
    R.check('precondition: no outstanding principal', (await mp.outstandingPrincipal(bId)) === 0n);
    R.check('selfStake().locked == false with no loan outstanding', ss.locked === false, `amount ${fmt(ss.amount)}`);

    // ---------------------------------------------------------------- 2. stake + third party
    const required = await mp.requiredSelfStake(bId, USDC(LOAN));
    R.note('requiredSelfStake(B, 500)', `${fmt(required)} USDC  (= 500 × (100-0)/100 / k=2)`);
    if (ss.amount < required) {
        R.tx('creator top-up', await L.send(S, `B top up self-stake to ${fmt(required)}`, mpB.supplyLiquidity(bId, required - ss.amount)));
    }
    const tPosBefore = (await mp.positions(bId, T.address)).amount;
    if (tPosBefore < USDC(400)) {
        R.tx('third-party supply', await L.send(S, `T (third party) supply 400 USDC to pool #${bId}`, mpT.supplyLiquidity(bId, USDC(400))));
    }
    ss = await mp.selfStake(bId);
    R.check('creator stake now >= requiredSelfStake', ss.amount >= required, `${fmt(ss.amount)} >= ${fmt(required)}`);

    // ---------------------------------------------------------------- 3. borrow
    const rcReq = await L.send(S, `B requestLoan ${LOAN} USDC (0 % collateral tier)`, mpB.requestLoan(USDC(LOAN), 7));
    const loanId = L.loanIdFromReceipt(mp, rcReq);
    R.tx(`requestLoan ${LOAN} -> loan #${loanId}`, rcReq);
    const ssLocked = await mp.selfStake(bId);
    R.check('selfStake().locked FLIPPED to true once principal is outstanding',
        ssLocked.locked === true && ssLocked.amount === ss.amount,
        `amount ${fmt(ssLocked.amount)} locked ${ssLocked.locked}, outstanding ${fmt(await mp.outstandingPrincipal(bId))}`);

    const poolMid = await mp.agentPools(bId);
    R.note('pool after draw', `availableLiquidity ${fmt(poolMid.availableLiquidity)} totalLoaned ${fmt(poolMid.totalLoaned)}`);

    // ---------------------------------------------------------------- 4. creator is refused
    const rv1 = await L.expectRevert(mpB.withdrawLiquidity(bId, 1n), 'Self-stake locked while borrowing');
    R.check('creator withdrawLiquidity(1 unit) REVERTS "Self-stake locked while borrowing"', rv1.reverted && rv1.matched, rv1.message.slice(0, 150));
    const rvAll = await L.expectRevert(mpB.withdrawLiquidity(bId, ssLocked.amount), 'Self-stake locked while borrowing');
    R.check('creator withdrawLiquidity(whole position) REVERTS with the same reason', rvAll.reverted && rvAll.matched, rvAll.message.slice(0, 150));
    R.check('failed withdrawals changed nothing: creator position intact',
        (await mp.positions(bId, B.address)).amount === ssLocked.amount, fmt(ssLocked.amount));

    // ---------------------------------------------------------------- 5. third party is NOT locked
    const tBefore = (await mp.positions(bId, T.address)).amount;
    const rcT = await L.send(S, `T withdraw 100 USDC from the SAME pool while the loan is open`, mpT.withdrawLiquidity(bId, USDC(100)));
    R.tx('third-party withdraw during the loan', rcT);
    const tAfter = (await mp.positions(bId, T.address)).amount;
    R.check('THIRD-PARTY lender can withdraw from the same pool while the creator cannot',
        tAfter === tBefore - USDC(100), `${fmt(tBefore)} -> ${fmt(tAfter)}`);
    R.check('the loan is still outstanding during that third-party withdrawal',
        (await mp.outstandingPrincipal(bId)) === USDC(LOAN), fmt(await mp.outstandingPrincipal(bId)));

    // ---------------------------------------------------------------- 6. repay
    const rcRep = await L.send(S, `B repayLoan ${loanId}`, mpB.repayLoan(loanId));
    R.tx(`repayLoan ${loanId}`, rcRep);
    const ssFree = await mp.selfStake(bId);
    R.check('selfStake().locked FLIPPED back to false after repayment',
        ssFree.locked === false && (await mp.outstandingPrincipal(bId)) === 0n, `amount ${fmt(ssFree.amount)}`);

    // ---------------------------------------------------------------- 7. creator can now exit
    const balBefore = await L.contracts().usdc.balanceOf(B.address);
    const rcW = await L.send(S, `B withdraw its whole ${fmt(ssFree.amount)} USDC self-stake`, mpB.withdrawLiquidity(bId, ssFree.amount));
    R.tx('creator withdraw after repayment', rcW);
    const balAfter = await L.contracts().usdc.balanceOf(B.address);
    const ssEnd = await mp.selfStake(bId);
    R.check('creator withdrawal SUCCEEDS once outstandingPrincipal == 0',
        ssEnd.amount === 0n && balAfter - balBefore === ssFree.amount, `+${fmt(balAfter - balBefore)} USDC returned`);

    const cons = await L.poolConservation(bId);
    R.check('per-pool conservation exact at the end', cons.conserved,
        `avail ${fmt(cons.availableLiquidity)} + loaned ${fmt(cons.totalLoaned)} == Σamt ${fmt(cons.sumAmt)} + Σearned ${fmt(cons.sumEarned)}`);

    R.finish({ agentId: bId, loanId, requiredSelfStake: required.toString(), loanAmount: USDC(LOAN).toString() });
}
main().catch(e => { console.error(e); process.exit(1); });
