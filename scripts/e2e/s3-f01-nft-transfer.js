/**
 * S3 — F-01: agent NFT transfer no longer freezes an active loan (V6.1).
 *
 *  (i)   A opens a loan, transfers the agent NFT to fresh wallet A2. A (loan.borrower,
 *        now unregistered) repays → succeeds; collateral returns to A.
 *  (ii)  A2 (now the agent) tries to borrow: with the M-1 lever ON this reverts
 *        "Borrow restricted to pool creator" (recorded). The owner temporarily turns
 *        M-1 OFF, A2 borrows (loan.borrower = A2), transfers the NFT back to A, and A
 *        repays as the NFT HOLDER (not the borrower): collateral goes to loan.borrower (A2).
 *  (iii) A opens a loan, transfers the NFT to A2: previewRepayment works and the owner's
 *        liquidateLoan reverts "Loan not overdue" (not "Not an agent"). NFT back, A repays.
 *  M-1 is restored to ON at the end (and on any failure).
 */
const L = require('./_lib');
const { SpecularQuickstart } = require('../../src/sdk/SpecularQuickstart');
const { USDC, fmt } = L;
const S = 'S3';

async function main() {
    await L.assertStaging();
    const R = new L.Results(S);
    const { mp, reg, rep, usdc } = L.contracts();
    const mpAddr = L.cfg.agentLiquidityMarketplace_v6;
    const A = L.roleWallet('A'), A2 = L.roleWallet('A2');
    await L.fundNative(A, '1.0', S); await L.fundNative(A2, '1.0', S);
    if ((await usdc.balanceOf(A.address)) < USDC(100)) await L.mintUsdc(A.address, 200, S);
    if ((await usdc.balanceOf(A2.address)) < USDC(50)) await L.mintUsdc(A2.address, 100, S);
    const cA = L.contracts(A), cA2 = L.contracts(A2), cOwner = L.contracts(L.deployer);
    const sdkA = new SpecularQuickstart(A, 'arc-staging');
    const aId = (await sdkA.onboard()).agentId;
    if ((await reg.ownerOf(aId)) !== A.address) throw new Error('precondition: A must hold its NFT');
    if ((await mp.activeLoanCount(aId)) !== 0n) throw new Error('precondition: no active loans on A');
    const pool = await mp.agentPools(aId);
    if (pool.availableLiquidity < USDC(60)) throw new Error('precondition: A pool needs ≥ 60 USDC available (run S1)');

    const transfer = async (from, to, label) => L.send(S, label, L.contracts(from).reg.transferFrom(from.address, to.address, aId));
    const repayDirect = async (wallet, loanId, label) => {
        const pv = await mp.previewRepayment(loanId);
        await L.approve(wallet, pv.total, S, `${label} approve`);
        return L.send(S, label, L.contracts(wallet).mp.repayLoan(loanId));
    };

    let m1Restored = true;
    try {
        // ---------- (i) A borrows, transfers NFT, repays as borrower ----------
        const { loanId: l1, tx: b1 } = await sdkA.borrow(20, 7);
        L.logTx(S, `(i) A borrow 20 (loan ${l1})`, await L.provider.getTransactionReceipt(b1));
        await transfer(A, A2, '(i) transferFrom A -> A2');
        R.check('(i) registry: ownerOf == A2, addressToAgentId(A)==0, addressToAgentId(A2)==aId', (await reg.ownerOf(aId)) === A2.address && (await reg.addressToAgentId(A.address)) === 0n && Number(await reg.addressToAgentId(A2.address)) === aId);
        R.check('(i) loan still ACTIVE after transfer', Number((await mp.loans(l1)).state) === 1);
        const pv1 = await mp.previewRepayment(l1);
        R.check('(i) previewRepayment works after transfer', pv1.total === USDC(20) + pv1.interest && pv1.lateSeconds === 0n, `total ${fmt(pv1.total)}`);
        const aBal0 = await usdc.balanceOf(A.address), a2Bal0 = await usdc.balanceOf(A2.address);
        const score0 = await rep['getReputationScore(uint256)'](aId);
        const rr = await repayDirect(A, l1, '(i) repayLoan by A (borrower, unregistered)');
        R.check('(i) repay by ORIGINAL borrower succeeded (no "Not an agent")', rr.status === 1);
        R.check('(i) loan REPAID', Number((await mp.loans(l1)).state) === 2);
        R.check('(i) collateral returned to A: A delta == -interest', aBal0 - (await usdc.balanceOf(A.address)) === pv1.interest, `${fmt(aBal0 - (await usdc.balanceOf(A.address)))}`);
        R.check('(i) A2 balance untouched', (await usdc.balanceOf(A2.address)) === a2Bal0);
        R.check('(i) reputation keyed by agentId: score unchanged (minHold not met, no bonus) and no revert', (await rep['getReputationScore(uint256)'](aId)) === score0);
        R.check('(i) LoanCompleted emitted for agentId', rr.logs.some(lg => { try { const p = rep.interface.parseLog(lg); return p && p.name === 'LoanCompleted' && Number(p.args.agentId) === aId; } catch (e) { return false; } }));

        // ---------- (ii) A2 is now the agent ----------
        // SDK view from A2: the agent identity moved
        const sdkA2 = new SpecularQuickstart(A2, 'arc-staging');
        R.check('(ii) A2 creditInfo resolves the transferred agent (score/limit)', (await sdkA2.creditInfo()).creditLimit === '1000.0');
        await L.approve(A2, USDC(10), S, '(ii) A2 approve collateral');
        const rvM1 = await L.expectRevert(cA2.mp.requestLoan(USDC(10), 7), 'Borrow restricted to pool creator');
        R.check('(ii) with M-1 ON, A2 (holder, not pool creator) cannot borrow: "Borrow restricted to pool creator"', rvM1.reverted && rvM1.matched, rvM1.message.slice(0, 100));
        // owner turns M-1 OFF temporarily to exercise the holder-repays path
        await L.send(S, '(ii) owner setBindBorrowToPoolCreator(false) [temporary]', cOwner.mp.setBindBorrowToPoolCreator(false));
        m1Restored = false;
        const rq = await L.send(S, '(ii) A2 requestLoan 10 (M-1 off)', cA2.mp.requestLoan(USDC(10), 7));
        const l2 = L.loanIdFromReceipt(mp, rq);
        const ln2 = await mp.loans(l2);
        R.check('(ii) loan by A2: borrower == A2, agentId == aId, collateral 10', ln2.borrower === A2.address && Number(ln2.agentId) === aId && ln2.collateralAmount === USDC(10));
        await transfer(A2, A, '(ii) transferFrom A2 -> A (back)');
        R.check('(ii) A holds the NFT again; A2 unregistered', (await reg.ownerOf(aId)) === A.address && (await reg.addressToAgentId(A2.address)) === 0n);
        // third party (B) must be refused
        const B = L.roleWallet('B'); await L.fundNative(B, '1.0', S);
        const rv3 = await L.expectRevert(L.contracts(B).mp.repayLoan(l2), 'Not the borrower');
        R.check('(ii) third party repay refused "Not the borrower"', rv3.reverted && rv3.matched);
        const aBal1 = await usdc.balanceOf(A.address), a2Bal1 = await usdc.balanceOf(A2.address);
        const pv2 = await mp.previewRepayment(l2);
        const rr2 = await repayDirect(A, l2, '(ii) repayLoan by A (HOLDER, not borrower)');
        R.check('(ii) holder repay succeeded', rr2.status === 1 && Number((await mp.loans(l2)).state) === 2);
        R.check('(ii) A (holder) paid principal + interest', aBal1 - (await usdc.balanceOf(A.address)) === pv2.total, `${fmt(pv2.total)}`);
        R.check('(ii) collateral went to loan.borrower A2 (+10)', (await usdc.balanceOf(A2.address)) - a2Bal1 === USDC(10));
        R.check('(ii) A allowance 0 (exact)', (await usdc.allowance(A.address, mpAddr)) === 0n);
        await L.send(S, '(ii) owner setBindBorrowToPoolCreator(true) [restore]', cOwner.mp.setBindBorrowToPoolCreator(true));
        m1Restored = true;
        R.check('(ii) M-1 lever restored to ON', (await mp.bindBorrowToPoolCreator()) === true);
        await L.send(S, '(ii) A2 revoke leftover approval', cA2.usdc.approve(mpAddr, 0n));

        // ---------- (iii) liquidateLoan on a transferred loan ----------
        const { loanId: l3, tx: b3 } = await sdkA.borrow(15, 7);
        L.logTx(S, `(iii) A borrow 15 (loan ${l3})`, await L.provider.getTransactionReceipt(b3));
        await transfer(A, A2, '(iii) transferFrom A -> A2');
        const pv3 = await mp.previewRepayment(l3);
        R.check('(iii) previewRepayment works while NFT is with A2', pv3.total === USDC(15) + pv3.interest);
        const rvLiq = await L.expectRevert(cOwner.mp.liquidateLoan(l3), 'Loan not overdue');
        R.check('(iii) owner liquidateLoan reverts "Loan not overdue" (NOT "Not an agent")', rvLiq.reverted && rvLiq.matched && !/Not an agent/.test(rvLiq.message), rvLiq.message.slice(0, 100));
        // also: liquidate would resolve holder A2 — prove the resolution path via reputation view
        R.check('(iii) reputation resolves via holder: getReputationScore(A2) == getReputationScore(aId)', (await rep['getReputationScore(address)'](A2.address)) === (await rep['getReputationScore(uint256)'](aId)));
        await transfer(A2, A, '(iii) transferFrom A2 -> A (back)');
        const rr3 = await repayDirect(A, l3, '(iii) A repay loan');
        R.check('(iii) loan REPAID, activeLoanCount 0', rr3.status === 1 && (await mp.activeLoanCount(aId)) === 0n);
        const g = await L.globalSolvency();
        R.check('GLOBAL solvency exact', g.exact, `surplus ${g.surplus}`);
    } finally {
        if (!m1Restored) {
            await L.send(S, 'owner setBindBorrowToPoolCreator(true) [restore in finally]', cOwner.mp.setBindBorrowToPoolCreator(true));
        }
        if ((await reg.ownerOf(aId)) !== A.address) {
            await L.send(S, 'transfer NFT back to A [finally]', cA2.reg.transferFrom(A2.address, A.address, aId));
        }
    }
    R.finish({ agentId: aId });
}
main().catch((e) => { console.error(e); process.exit(1); });
