/**
 * S6 — M-1 / M-2 launch levers on staging.
 *  M-1: a wallet that is not the pool creator (A2 holding A's NFT) cannot borrow from A's pool.
 *       (a wallet with no agent at all fails earlier with "Not a registered agent")
 *  M-2: A's on-time repayment of a loan held < minHoldForReputationReward earns NO reputation.
 */
const L = require('./_lib');
const { SpecularQuickstart } = require('../../src/sdk/SpecularQuickstart');
const { USDC, fmt } = L;
const S = 'S6';

async function main() {
    await L.assertStaging();
    const R = new L.Results(S);
    const { mp, reg, rep, usdc } = L.contracts();
    const mpAddr = L.cfg.agentLiquidityMarketplace_v6;
    const A = L.roleWallet('A'), A2 = L.roleWallet('A2'), X = L.roleWallet('X');
    for (const w of [A, A2, X]) await L.fundNative(w, '1.0', S);
    if ((await usdc.balanceOf(A2.address)) < USDC(20)) await L.mintUsdc(A2.address, 50, S);
    const sdkA = new SpecularQuickstart(A, 'arc-staging');
    const aId = (await sdkA.onboard()).agentId;
    if ((await reg.ownerOf(aId)) !== A.address) throw new Error('precondition: A must hold its NFT');

    R.check('M-1 lever bindBorrowToPoolCreator == true', (await mp.bindBorrowToPoolCreator()) === true);
    const minHold = await mp.minHoldForReputationReward();
    R.check('M-2 lever minHoldForReputationReward == 86400', minHold === 86400n, `${minHold}`);

    // wallet with no agent at all
    const rvX = await L.expectRevert(L.contracts(X).mp.requestLoan(USDC(1), 7), 'Not a registered agent');
    R.check('unregistered wallet X cannot borrow: "Not a registered agent"', rvX.reverted && rvX.matched);

    // M-1 via NFT transfer: A2 holds the agent but did not create the pool
    await L.send(S, 'transferFrom A -> A2', L.contracts(A).reg.transferFrom(A.address, A2.address, aId));
    try {
        R.check('pool.agentAddress still A (creator) while A2 holds the NFT', (await mp.agentPools(aId)).agentAddress === A.address && (await reg.ownerOf(aId)) === A2.address);
        await L.approve(A2, USDC(5), S, 'A2 approve collateral');
        const rv = await L.expectRevert(L.contracts(A2).mp.requestLoan(USDC(5), 7), 'Borrow restricted to pool creator');
        R.check('M-1: A2 requestLoan reverts "Borrow restricted to pool creator"', rv.reverted && rv.matched, rv.message.slice(0, 90));
        await L.send(S, 'A2 revoke approval', L.contracts(A2).usdc.approve(mpAddr, 0n));
    } finally {
        await L.send(S, 'transferFrom A2 -> A (back)', L.contracts(A2).reg.transferFrom(A2.address, A.address, aId));
    }
    R.check('A holds NFT again', (await reg.ownerOf(aId)) === A.address);

    // M-2: quick on-time repay earns nothing
    const score0 = await rep['getReputationScore(uint256)'](aId);
    const gained0 = await rep.gainedInWindow(aId);
    const { loanId, tx } = await sdkA.borrow(100, 7); // ≥ bonusReferenceAmount so the bonus would be the full 10 if eligible
    L.logTx(S, `A borrow 100 (loan ${loanId})`, await L.provider.getTransactionReceipt(tx));
    const ln = await mp.loans(loanId);
    const rp = await sdkA.repay(loanId);
    const rc = await L.provider.getTransactionReceipt(rp);
    L.logTx(S, `A repay loan ${loanId} immediately`, rc);
    const held = BigInt((await L.provider.getBlock(rc.blockNumber)).timestamp) - ln.startTime;
    const score1 = await rep['getReputationScore(uint256)'](aId);
    R.check(`M-2: held ${held}s < minHold ${minHold}s → score unchanged (${score0} → ${score1})`, held < minHold && score1 === score0);
    R.check('M-2: gainedInWindow unchanged', (await rep.gainedInWindow(aId)) === gained0);
    const completed = rc.logs.map(lg => { try { return rep.interface.parseLog(lg); } catch (e) { return null; } }).find(p => p && p.name === 'LoanCompleted');
    R.check('LoanCompleted emitted with onTime=false (bonus gated), no ReputationUpdated', completed && completed.args.onTime === false && !rc.logs.some(lg => { try { const p = rep.interface.parseLog(lg); return p && p.name === 'ReputationUpdated'; } catch (e) { return false; } }));
    R.check('loan was on time and paid interest (so ONLY minHold blocked the bonus)', (await mp.repayments(loanId)).lateSeconds === 0n && (await mp.repayments(loanId)).interestPaid > 0n, `interest ${fmt((await mp.repayments(loanId)).interestPaid)}`);
    R.finish({ agentId: aId, loanId });
}
main().catch((e) => { console.error(e); process.exit(1); });
