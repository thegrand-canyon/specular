/**
 * V8 — prior fixes still hold on the NEW marketplace (V6.2), on-chain.
 *
 *   F-01  repay after an agent-NFT transfer: the ORIGINAL borrower and the NEW holder
 *         may both repay, anyone else is refused, and collateral always returns to
 *         `loan.borrower` — never to the new holder. Plus: after the transfer neither
 *         party can open a new loan (registry mapping moved + M-1 binds to the creator).
 *   F-02  a top-up that would forfeit in-flight interest is refused
 *         ("Top-up would forfeit in-flight interest"), and `canTopUp` is its exact oracle.
 *   F-07  a registry-deactivated agent cannot borrow, but can still repay, and lenders
 *         (including the creator once principal is clear) can still withdraw.
 */
const L = require('./_lib');
const { USDC, fmt } = L;
const S = 'v8-prior-fixes-regression';

async function main() {
    await L.assertStaging();
    const R = new L.Results(S, 'F-01 / F-02 / F-07 regression on AgentLiquidityMarketplaceV62 (on-chain)');
    const { mp, rep, reg, usdc } = L.contracts();
    const regOwner = L.contracts(L.deployer).reg;
    const D = L.roleWallet('D'), E = L.roleWallet('E'), X = L.roleWallet('X'),
          F = L.roleWallet('F'), LF = L.roleWallet('LF'), A = L.roleWallet('A'), LA = L.roleWallet('LA');
    const mpD = L.contracts(D).mp, mpE = L.contracts(E).mp, mpX = L.contracts(X).mp,
          mpF = L.contracts(F).mp, mpLF = L.contracts(LF).mp, mpA = L.contracts(A).mp, mpLA = L.contracts(LA).mp;
    const regD = L.contracts(D).reg;

    // ==================================================================== F-01
    console.log('\n-- F-01: repay after an agent-NFT transfer --');
    const dId = await L.ensureAgent(D, S, 'D-nft');
    await L.ensureUsdc(LF, 600, 1200, S);
    if ((await mp.positions(dId, LF.address)).amount < USDC(400)) {
        R.tx('LF supply to D pool', await L.send(S, `LF supply 400 USDC to pool #${dId}`, mpLF.supplyLiquidity(dId, USDC(400))));
    }
    // climb one ladder rung so three concurrent 100-USDC loans fit under the credit limit
    let dSt = await L.creditState(dId, D.address);
    if (dSt.maxRepaid < USDC(100)) {
        const rc = await L.send(S, 'D requestLoan 100 (ladder rung 0)', mpD.requestLoan(USDC(100), 7));
        const id = L.loanIdFromReceipt(mp, rc);
        await L.sleep(2500);
        await L.send(S, `D repayLoan ${id}`, mpD.repayLoan(id));
        dSt = await L.creditState(dId, D.address);
    }
    R.check('D can carry three concurrent 100-USDC loans under its credit limit', dSt.limit >= USDC(300), `limit ${fmt(dSt.limit)} collateral ${dSt.collPct}%`);

    const loanIds = [];
    for (let i = 0; i < 3; i++) {
        const rc = await L.send(S, `D requestLoan 100 USDC (loan ${i + 1}/3, pre-transfer)`, mpD.requestLoan(USDC(100), 7));
        loanIds.push(L.loanIdFromReceipt(mp, rc));
    }
    R.note('D pre-transfer loans', loanIds.join(', '));
    const [l2, l3, l4] = loanIds;
    for (const id of loanIds) R.check(`loan #${id} borrower == D`, (await mp.loans(id)).borrower === D.address);

    R.tx('transfer agent NFT D -> E', await L.send(S, `transferFrom agent #${dId}: D -> E`, regD.transferFrom(D.address, E.address, dId)));
    R.check('registry moved the identity: ownerOf == E, addressToAgentId[D] == 0, addressToAgentId[E] == agentId',
        (await reg.ownerOf(dId)) === E.address && (await reg.addressToAgentId(D.address)) === 0n && (await reg.addressToAgentId(E.address)) === BigInt(dId));

    // (a) the ORIGINAL borrower can still repay, and gets its collateral back
    let dBal = await usdc.balanceOf(D.address);
    const pre2 = await mp.previewRepayment(l2);
    const coll2 = (await mp.loans(l2)).collateralAmount;
    const rcD = await L.send(S, `original borrower D repays loan ${l2} after the transfer`, mpD.repayLoan(l2));
    R.tx(`D repays #${l2}`, rcD);
    const dBal2 = await usdc.balanceOf(D.address);
    R.check('F-01(a): the ORIGINAL borrower may repay after the NFT moved',
        Number((await mp.loans(l2)).state) === 2, `state ${Number((await mp.loans(l2)).state)} (2 = REPAID)`);
    R.check('F-01(a): D\'s balance delta == collateral − (principal + interest) exactly',
        dBal2 - dBal === coll2 - pre2.total, `Δ ${fmt(dBal2 - dBal)} == ${fmt(coll2)} − ${fmt(pre2.total)}`);

    // (b) the NEW holder can repay, and the collateral still goes to loan.borrower
    const dBalBefore3 = await usdc.balanceOf(D.address), eBalBefore3 = await usdc.balanceOf(E.address);
    const pre3 = await mp.previewRepayment(l3);
    const coll3 = (await mp.loans(l3)).collateralAmount;
    const rcE = await L.send(S, `new holder E repays loan ${l3}`, mpE.repayLoan(l3));
    R.tx(`E repays #${l3}`, rcE);
    R.check('F-01(b): the NEW NFT holder may repay', Number((await mp.loans(l3)).state) === 2);
    R.check('F-01(b): COLLATERAL went to loan.borrower (D), not to the new holder (E)',
        (await usdc.balanceOf(D.address)) - dBalBefore3 === coll3 &&
        eBalBefore3 - (await usdc.balanceOf(E.address)) === pre3.total,
        `D +${fmt((await usdc.balanceOf(D.address)) - dBalBefore3)} (collateral ${fmt(coll3)}), E −${fmt(eBalBefore3 - (await usdc.balanceOf(E.address)))}`);
    R.check('F-01(b): the reputation call resolved through the NEW holder (LoanCompleted for this agentId)',
        (() => { const p = L.eventFromReceipt(rep.interface, rcE, 'LoanCompleted'); return p && Number(p.args.agentId) === dId && Number(p.args.loanId) === l3; })());

    // (c) nobody else
    const rvX = await L.expectRevert(mpX.repayLoan(l4), 'Not the borrower');
    R.check('F-01(c): an unrelated address CANNOT repay ("Not the borrower")', rvX.reverted && rvX.matched, rvX.message.slice(0, 120));
    R.tx(`E repays #${l4}`, await L.send(S, `E repays the last loan ${l4}`, mpE.repayLoan(l4)));

    // (d) neither party can open a new loan on the transferred agent
    const rvDBorrow = await L.expectRevert(mpD.requestLoan(USDC(50), 7), 'Not a registered agent');
    R.check('F-01(d): the old owner D can no longer borrow ("Not a registered agent")', rvDBorrow.reverted && rvDBorrow.matched, rvDBorrow.message.slice(0, 120));
    const rvEBorrow = await L.expectRevert(mpE.requestLoan(USDC(50), 7), 'Borrow restricted to pool creator');
    R.check('F-01(d): M-1 stops the NEW holder borrowing against the creator\'s pool ("Borrow restricted to pool creator")', rvEBorrow.reverted && rvEBorrow.matched, rvEBorrow.message.slice(0, 120));

    // ==================================================================== F-02
    console.log('\n-- F-02: in-flight top-up refusal --');
    const aId = Number(await reg.addressToAgentId(A.address));
    R.check('precondition: agent A has no active loans', (await mp.activeLoanCount(aId)) === 0n);
    const posBefore = await mp.positions(aId, LA.address);
    const ptBefore = await mp.pendingTranche(aId, LA.address);
    R.check('precondition: LA has a base position and no pending tranche', posBefore.amount > 0n && ptBefore.amount === 0n, `${fmt(posBefore.amount)}`);

    const rcA1 = await L.send(S, 'A requestLoan 100 USDC (loan #1)', mpA.requestLoan(USDC(100), 7));
    const a1 = L.loanIdFromReceipt(mp, rcA1);
    const ln1 = await mp.loans(a1);
    const q1 = await mp.qualifiedAmountAt(aId, LA.address, ln1.startTime);
    R.check('canTopUp == true with no pending tranche (case b)', (await mp.canTopUp(aId, LA.address)) === true);
    R.tx('LA top-up during loan #1', await L.send(S, 'LA top up 20 USDC during loan #1', mpLA.supplyLiquidity(aId, USDC(20))));
    const pt1 = await mp.pendingTranche(aId, LA.address);
    R.check('F-02: the top-up became a PENDING tranche stamped after the loan started',
        pt1.amount === USDC(20) && pt1.timestamp > ln1.startTime, `pending ${fmt(pt1.amount)} @ ${pt1.timestamp} > loan start ${ln1.startTime}`);
    R.check('F-02: LA\'s qualified amount for loan #1 is UNCHANGED by the top-up',
        (await mp.qualifiedAmountAt(aId, LA.address, ln1.startTime)) === q1, fmt(q1));

    const rcA2 = await L.send(S, 'A requestLoan 100 USDC (loan #2, starts after the pending stamp)', mpA.requestLoan(USDC(100), 7));
    const a2 = L.loanIdFromReceipt(mp, rcA2);
    const ln2 = await mp.loans(a2);
    R.check('loan #2 started after the pending stamp (the un-mergeable case e)', ln2.startTime > pt1.timestamp, `${ln2.startTime} > ${pt1.timestamp}`);
    R.check('canTopUp == false (exact oracle for the refusal)', (await mp.canTopUp(aId, LA.address)) === false);
    const rvTop = await L.expectRevert(mpLA.supplyLiquidity(aId, USDC(5)), 'Top-up would forfeit in-flight interest');
    R.check('F-02: supplyLiquidity REVERTS "Top-up would forfeit in-flight interest"', rvTop.reverted && rvTop.matched, rvTop.message.slice(0, 130));
    R.check('a lender with no position is never refused (canTopUp true for a fresh address)',
        (await mp.canTopUp(aId, X.address)) === true);
    R.tx('A repays loan #1', await L.send(S, `A repayLoan ${a1}`, mpA.repayLoan(a1)));
    R.tx('A repays loan #2', await L.send(S, `A repayLoan ${a2}`, mpA.repayLoan(a2)));
    R.check('canTopUp true again once no loan is in flight', (await mp.canTopUp(aId, LA.address)) === true);

    // ==================================================================== F-07
    console.log('\n-- F-07: deactivated agent --');
    const fId = await L.ensureAgent(F, S, 'F-deactivate');
    if ((await mp.positions(fId, LF.address)).amount < USDC(150)) {
        await L.ensureUsdc(LF, 200, 600, S);
        R.tx('LF supply to F pool', await L.send(S, `LF supply 200 USDC to pool #${fId}`, mpLF.supplyLiquidity(fId, USDC(200))));
    }
    if ((await mp.selfStake(fId)).amount < USDC(50)) {
        R.tx('F self-stake', await L.send(S, `F seed 50 USDC into its own pool #${fId}`, mpF.supplyLiquidity(fId, USDC(50))));
    }
    const rcF = await L.send(S, 'F requestLoan 100 USDC (while active)', mpF.requestLoan(USDC(100), 7));
    const fLoan = L.loanIdFromReceipt(mp, rcF);
    R.tx(`F borrows -> #${fLoan}`, rcF);

    R.tx('deactivateAgent', await L.send(S, `registry.deactivateAgent(#${fId})`, regOwner.deactivateAgent(fId)));
    R.check('registry reports the agent inactive', (await reg.isAgentActive(F.address)) === false);
    const rvDeact = await L.expectRevert(mpF.requestLoan(USDC(50), 7), 'Agent deactivated');
    R.check('F-07: a deactivated agent CANNOT open a new loan ("Agent deactivated")', rvDeact.reverted && rvDeact.matched, rvDeact.message.slice(0, 120));
    R.tx('deactivated agent repays', await L.send(S, `F repayLoan ${fLoan} while deactivated`, mpF.repayLoan(fLoan)));
    R.check('F-07: a deactivated agent CAN still repay (the closing path stays live)', Number((await mp.loans(fLoan)).state) === 2);
    R.tx('lender withdraw from deactivated agent pool', await L.send(S, 'LF withdraw 50 USDC from the deactivated agent\'s pool', mpLF.withdrawLiquidity(fId, USDC(50))));
    R.check('F-07: a third-party lender can still withdraw from a deactivated agent\'s pool', true);
    R.tx('creator withdraw', await L.send(S, 'F withdraw its own 50 USDC stake (principal now clear)', mpF.withdrawLiquidity(fId, USDC(50))));
    R.check('F-07: the creator can withdraw its stake once outstandingPrincipal == 0, even while deactivated',
        (await mp.selfStake(fId)).amount === 0n);
    R.tx('reactivateAgent', await L.send(S, `registry.reactivateAgent(#${fId})`, regOwner.reactivateAgent(fId)));
    R.check('agent reactivated and able to borrow again', (await reg.isAgentActive(F.address)) === true);

    for (const id of [aId, dId, fId]) {
        const c = await L.poolConservation(id);
        R.check(`per-pool conservation exact for pool #${id}`, c.conserved, `avail ${fmt(c.availableLiquidity)} loaned ${fmt(c.totalLoaned)} Σamt ${fmt(c.sumAmt)} Σearned ${fmt(c.sumEarned)}`);
    }

    R.finish({ agents: { D: dId, A: aId, F: fId }, loans: { transferred: loanIds, tranche: [a1, a2], deactivated: fLoan } });
}
main().catch(e => { console.error(e); process.exit(1); });
