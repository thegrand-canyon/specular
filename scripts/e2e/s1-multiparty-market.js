/**
 * S1 — Multi-party market via the JS SDK (SpecularQuickstart, network 'arc-staging').
 *
 * Agents A, B each create a pool. Lenders L1/L2/L3 supply to A's pool (100/50/30),
 * a sub-minimum supply for a NEW slot must revert. A borrows 100 USDC (score 0 →
 * 100% collateral), repays; interest shares are asserted exact to the base unit
 * against calculateInterest × share − 1% fee; L2 claims; L3 withdraws fully; pool
 * and global accounting are asserted from direct contract reads.
 *
 * Re-runnable: `node scripts/e2e/s1-multiparty-market.js` (wallets persist under
 * forensics/output/testing-2026-09-20/e2e-wallets.json).
 */
const L = require('./_lib');
const { SpecularQuickstart } = require('../../src/sdk/SpecularQuickstart');
const { ethers, USDC, fmt } = L;

const S = 'S1';

async function main() {
    await L.assertStaging();
    const R = new L.Results(S);
    const { mp, reg, rep, usdc } = L.contracts();
    const mpAddr = L.cfg.agentLiquidityMarketplace_v6;

    const A = L.roleWallet('A'), B = L.roleWallet('B');
    const L1 = L.roleWallet('L1'), L2 = L.roleWallet('L2'), L3 = L.roleWallet('L3');
    const Lsmall = L.roleWallet('Lsmall');
    console.log('roles', { A: A.address, B: B.address, L1: L1.address, L2: L2.address, L3: L3.address, Lsmall: Lsmall.address });

    // --- funding (gas + MockUSDC) ---
    for (const w of [A, B, L1, L2, L3, Lsmall]) await L.fundNative(w, '1.0', S);
    await L.mintUsdc(A.address, 300, S);
    await L.mintUsdc(L1.address, 200, S);
    await L.mintUsdc(L2.address, 100, S);
    await L.mintUsdc(L3.address, 100, S);
    await L.mintUsdc(Lsmall.address, 10, S);

    const minSupply = await mp.minSupplyAmount();
    R.note('minSupplyAmount (staging lever)', `${fmt(minSupply)} USDC`);

    // --- onboarding via SDK ---
    const sdkA = new SpecularQuickstart(A, 'arc-staging');
    const sdkB = new SpecularQuickstart(B, 'arc-staging');
    R.check('SDK detects V6.1', (await sdkA.marketplaceVersion()) === 'V6.1', await sdkA.marketplaceVersion());
    const onA = await sdkA.onboard('ipfs://e2e-A');
    const onB = await sdkB.onboard('ipfs://e2e-B');
    const aId = onA.agentId, bId = onB.agentId;
    console.log('onboard A', onA, 'onboard B', onB);
    R.check('A registered + pool active', (await mp.agentPools(aId)).isActive && Number(await reg.addressToAgentId(A.address)) === aId, `agentId ${aId} registerTx=${onA.registerTx} poolTx=${onA.poolTx}`);
    R.check('B registered + pool active', (await mp.agentPools(bId)).isActive && Number(await reg.addressToAgentId(B.address)) === bId, `agentId ${bId} registerTx=${onB.registerTx} poolTx=${onB.poolTx}`);
    R.check('A and B have distinct pools owned by themselves', (await mp.agentPools(aId)).agentAddress === A.address && (await mp.agentPools(bId)).agentAddress === B.address);

    // --- sub-minimum supply into a NEW slot must revert ---
    {
        const c = L.contracts(Lsmall);
        await L.approve(Lsmall, USDC(5), S, 'Lsmall approve');
        const below = minSupply - 1n; // strictly below the lever
        const rv = await L.expectRevert(c.mp.supplyLiquidity(aId, below), 'Below minimum supply');
        R.check(`supply ${fmt(below)} USDC (< minSupply) into NEW slot reverts "Below minimum supply"`, rv.reverted && rv.matched, rv.message);
        // the task's 5-USDC case: only reverts if the lever is > 5 USDC. Report what staging does.
        let fiveOk = null;
        try { await c.mp.supplyLiquidity.staticCall(aId, USDC(5)); fiveOk = true; } catch (e) { fiveOk = false; }
        if (minSupply > USDC(5)) R.check('supply 5 USDC (< minSupply) reverts', fiveOk === false);
        else R.note('supply 5 USDC into a NEW slot', `would ${fiveOk ? 'SUCCEED' : 'REVERT'} on staging because minSupplyAmount=${fmt(minSupply)} USDC ≤ 5 (not sent; staticCall only)`);
        await L.send(S, 'Lsmall revoke approval', c.usdc.approve(mpAddr, 0n));
    }

    // --- lenders supply via SDK ---
    const lenders = { L1: L1.address, L2: L2.address, L3: L3.address };
    const supplyPlan = [[L1, 100], [L2, 50], [L3, 30]];
    const before = await L.poolSnapshot(aId, lenders);
    for (const [w, amt] of supplyPlan) {
        const sdk = new SpecularQuickstart(w, 'arc-staging');
        const h = await sdk.supply(aId, amt);
        const r = await L.provider.getTransactionReceipt(h);
        L.logTx(S, `SDK supply ${amt} by ${w.address}`, r);
    }
    const afterSupply = await L.poolSnapshot(aId, lenders);
    R.check('positions L1/L2/L3 = 100/50/30 (delta)', afterSupply.positions.L1.amount - before.positions.L1.amount === USDC(100) && afterSupply.positions.L2.amount - before.positions.L2.amount === USDC(50) && afterSupply.positions.L3.amount - before.positions.L3.amount === USDC(30));
    R.check('pool availableLiquidity += 180', afterSupply.availableLiquidity - before.availableLiquidity === USDC(180), `${fmt(afterSupply.availableLiquidity)}`);
    R.check('lender allowances back to 0 after exact-approve supply', (await usdc.allowance(L1.address, mpAddr)) === 0n && (await usdc.allowance(L2.address, mpAddr)) === 0n && (await usdc.allowance(L3.address, mpAddr)) === 0n);
    let nLenders = 0; for (let i = 0; i < 60; i++) { try { await mp.poolLenders(aId, i); nLenders++; } catch (e) { break; } }
    R.check('poolLenders(A) has exactly 3 entries', nLenders === 3, `${nLenders}`);

    // --- A borrows 100 USDC for 7 days (score 0 → 100% collateral) ---
    const credit = await sdkA.creditInfo();
    R.check('A credit: score 0, 100% collateral, 15% APR, 1000 limit', credit.score === 0 && credit.collateralPct === 100 && credit.interestRateBps === 1500 && credit.creditLimit === '1000.0', JSON.stringify(credit));
    const aBal0 = await usdc.balanceOf(A.address);
    const feesBefore = await mp.accumulatedFees();
    const { loanId, tx: borrowTx } = await sdkA.borrow(100, 7);
    L.logTx(S, `SDK borrow 100 USDC 7d by A (loan ${loanId})`, await L.provider.getTransactionReceipt(borrowTx));
    const loan = await mp.loans(loanId);
    R.check('loan ACTIVE, amount 100, collateral 100 (100%), rate 1500, duration 7d', Number(loan.state) === 1 && loan.amount === USDC(100) && loan.collateralAmount === USDC(100) && loan.interestRate === 1500n && loan.duration === 7n * 86400n, `loanId ${loanId}`);
    const aBal1 = await usdc.balanceOf(A.address);
    R.check('A balance unchanged after borrow (collateral 100 out, principal 100 in)', aBal1 === aBal0, `${fmt(aBal0)} -> ${fmt(aBal1)}`);
    const midLoan = await L.poolSnapshot(aId, lenders);
    R.check('pool availableLiquidity 80 / totalLoaned 100 / activeLoanCount 1', midLoan.availableLiquidity === afterSupply.availableLiquidity - USDC(100) && midLoan.totalLoaned === USDC(100) && midLoan.activeLoanCount === 1n);
    R.check('marketplace balance grew by exactly collateral (100) net of principal out', midLoan.mpBalance - afterSupply.mpBalance === 0n, `${fmt(afterSupply.mpBalance)} -> ${fmt(midLoan.mpBalance)}`);
    R.check('getActiveLoanIds(A) == [loanId]', JSON.stringify((await mp.getActiveLoanIds(aId)).map(Number)) === JSON.stringify([loanId]));

    // --- preview + expected interest arithmetic ---
    const pv = await sdkA.previewRepayment(loanId);
    const expInterest = await mp.calculateInterest(USDC(100), 1500n, 7n * 86400n);
    R.check('SDK previewRepayment.interest == calculateInterest(100, 1500, 7d)', pv.interest === expInterest && pv.source === 'previewRepayment', `${pv.interest} (${fmt(pv.interest)} USDC), lateSeconds ${pv.lateSeconds}`);
    R.check('interest mirror (JS interestFor) matches contract', L.interestFor(USDC(100), 1500, 7 * 86400) === expInterest);
    const fee = (expInterest * 100n) / 10000n;
    const lenderInterest = expInterest - fee;
    const qTotal = USDC(180);
    const expShare = { L1: (lenderInterest * USDC(100)) / qTotal, L2: (lenderInterest * USDC(50)) / qTotal, L3: (lenderInterest * USDC(30)) / qTotal };
    const dust = lenderInterest - (expShare.L1 + expShare.L2 + expShare.L3);

    // --- A repays via SDK ---
    const repayTx = await sdkA.repay(loanId);
    L.logTx(S, `SDK repay loan ${loanId} by A`, await L.provider.getTransactionReceipt(repayTx));
    const loanAfter = await mp.loans(loanId);
    R.check('loan REPAID', Number(loanAfter.state) === 2);
    const aBal2 = await usdc.balanceOf(A.address);
    R.check('A paid exactly principal + interest and got collateral back', aBal0 - aBal2 === expInterest, `A delta ${fmt(aBal0 - aBal2)} == interest ${fmt(expInterest)}`);
    R.check('A allowance 0 after repay (exact approval consumed)', (await usdc.allowance(A.address, mpAddr)) === 0n);
    const rec = await mp.repayments(loanId);
    R.check('repayments[loanId]: interestPaid == interest, lateSeconds 0', rec.interestPaid === expInterest && rec.lateSeconds === 0n);

    const afterRepay = await L.poolSnapshot(aId, lenders);
    for (const k of ['L1', 'L2', 'L3']) {
        R.check(`${k} earnedInterest exact: ${expShare[k]} base units`, afterRepay.positions[k].earnedInterest - midLoan.positions[k].earnedInterest === expShare[k], `on-chain ${afterRepay.positions[k].earnedInterest - midLoan.positions[k].earnedInterest}`);
    }
    R.check('accumulatedFees += 1% fee + rounding dust', (await mp.accumulatedFees()) - feesBefore === fee + dust, `fee ${fee} dust ${dust}`);
    R.check('pool.totalEarned += lenderInterest', afterRepay.totalEarned - midLoan.totalEarned === lenderInterest);
    R.check('pool.availableLiquidity == 180 + Σshares (principal back + distributed interest)', afterRepay.availableLiquidity === afterSupply.availableLiquidity + expShare.L1 + expShare.L2 + expShare.L3, `${afterRepay.availableLiquidity}`);
    R.check('per-pool conservation: avail + loaned == Σamount + Σearned', afterRepay.availableLiquidity + afterRepay.totalLoaned === Object.values(afterRepay.positions).reduce((s, p) => s + p.amount + p.earnedInterest, 0n));

    // --- L2 claims ---
    const l2Bal0 = await usdc.balanceOf(L2.address);
    const claimTx = await new SpecularQuickstart(L2, 'arc-staging').claim(aId);
    L.logTx(S, `SDK claim by L2`, await L.provider.getTransactionReceipt(claimTx));
    const l2Bal1 = await usdc.balanceOf(L2.address);
    R.check('L2 received exactly its share', l2Bal1 - l2Bal0 === expShare.L2, `${l2Bal1 - l2Bal0}`);
    const afterClaim = await L.poolSnapshot(aId, lenders);
    R.check('L2 earnedInterest -> 0; availableLiquidity decremented by claim (§S1)', afterClaim.positions.L2.earnedInterest === 0n && afterRepay.availableLiquidity - afterClaim.availableLiquidity === expShare.L2);

    // --- L3 withdraws fully ---
    const l3Bal0 = await usdc.balanceOf(L3.address);
    const wTx = await new SpecularQuickstart(L3, 'arc-staging').withdraw(aId, 30);
    L.logTx(S, `SDK withdraw 30 by L3`, await L.provider.getTransactionReceipt(wTx));
    const afterW = await L.poolSnapshot(aId, lenders);
    R.check('L3 principal back (30), position.amount 0, earnedInterest retained', (await usdc.balanceOf(L3.address)) - l3Bal0 === USDC(30) && afterW.positions.L3.amount === 0n && afterW.positions.L3.earnedInterest === expShare.L3);
    R.check('L3 still in poolLenders (unclaimed interest) — slot not leaked/dropped', await mp.isInPoolLenders(aId, L3.address));
    R.check('pool availableLiquidity after withdraw', afterClaim.availableLiquidity - afterW.availableLiquidity === USDC(30));

    // --- accounting identities ---
    const sumPositions = afterW.positions.L1.amount + afterW.positions.L2.amount + afterW.positions.L3.amount;
    const sumEarned = afterW.positions.L1.earnedInterest + afterW.positions.L2.earnedInterest + afterW.positions.L3.earnedInterest;
    R.check('pool: availableLiquidity == Σpositions + Σearned (no active loans)', afterW.availableLiquidity === sumPositions + sumEarned && afterW.totalLoaned === 0n, `${afterW.availableLiquidity} == ${sumPositions} + ${sumEarned}`);
    const mpDelta = afterW.mpBalance - before.mpBalance;
    const feesDelta = (await mp.accumulatedFees()) - feesBefore;
    R.check('marketplace balance delta == Σpositions + Σearned(unclaimed) + fees delta', mpDelta === sumPositions + sumEarned + feesDelta, `${mpDelta} == ${sumPositions} + ${sumEarned} + ${feesDelta}`);
    const g = await L.globalSolvency();
    R.check('GLOBAL: marketplace balance == Σ_pools available + Σ active collateral + fees', g.exact, `balance ${g.balance} expected ${g.expected} surplus ${g.surplus} pools ${g.pools}`);
    R.check('GLOBAL: every pool conserves avail+loaned == Σamount+Σearned', Object.values(g.perPool).every(p => p.conserved), JSON.stringify(Object.fromEntries(Object.entries(g.perPool).filter(([, p]) => !p.conserved))));

    R.finish({ agentIds: { A: aId, B: bId }, loanId, expected: { interest: expInterest, fee, lenderInterest, shares: expShare, dust } });
}

main().catch((e) => { console.error(e); process.exit(1); });
