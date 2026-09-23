/**
 * S9 — JS SDK side of the Python parity check. Runs the Python reader first
 * (python3 scripts/e2e/s9-python-parity.py, or $S9_PYTHON) then reads the same
 * values through SpecularQuickstart and compares field by field.
 *
 * Usage: node scripts/e2e/s9-python-parity.js
 */
const L = require('./_lib');
const { SpecularQuickstart } = require('../../src/sdk/SpecularQuickstart');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const S = 'S9';

async function main() {
    await L.assertStaging();
    const R = new L.Results(S);
    const py = process.env.S9_PYTHON || 'python3';
    const role0 = process.env.S9_ROLE || 'A';
    // Optionally open a small loan on the role so the ACTIVE-loan previewRepayment path is compared too.
    let openedLoan = null, sdk0 = null;
    if (process.env.S9_OPEN_LOAN === '1') {
        const w = L.roleWallet(role0); await L.fundNative(w, '1.0', S);
        sdk0 = new SpecularQuickstart(w, 'arc-staging');
        const { loanId, tx } = await sdk0.borrow(5, 7);
        L.logTx(S, `${role0} borrow 5 (loan ${loanId}) for parity read`, await L.provider.getTransactionReceipt(tx));
        openedLoan = loanId;
    }
    let pyOut;
    try {
        execFileSync(py, [path.join(__dirname, 's9-python-parity.py')], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, E2E_ARC_RPC_URL: L.RPC_URL } });
        pyOut = JSON.parse(fs.readFileSync(path.join(L.RESULTS_DIR, 'S9-python.json'), 'utf8'));
    } catch (e) {
        R.blocked('python client run', `${py} failed: ${(e.stderr || e.message || '').toString().slice(0, 300)}`);
        R.finish();
        return;
    }
    const role = process.env.S9_ROLE || 'A';
    const A = L.roleWallet(role);
    const sdk = new SpecularQuickstart(A, 'arc-staging');
    const { mp, reg } = L.contracts();
    const aId = Number(await reg.addressToAgentId(A.address));
    const ci = await sdk.creditInfo();
    // agentPools() = (agentId, agentAddress, totalLiquidity, availableLiquidity, totalLoaned, totalEarned, isActive);
    // getAgentPool() is a different tuple (see the note in s9-python-parity.py) — keep both sides on agentPools().
    const pool = await mp.agentPools(aId);
    const active = await sdk.activeLoanIds(aId);
    const loans = await sdk.loans();
    const L1 = L.roleWallet('L1').address;
    const pos = await mp.getLenderPosition(aId, L1);

    R.check('agentId', pyOut.agentId === aId, `${pyOut.agentId} vs ${aId}`);
    R.check('marketplaceVersion', pyOut.marketplaceVersion === (await sdk.marketplaceVersion()));
    R.check('creditInfo.score', pyOut.creditInfo.score === ci.score, `${pyOut.creditInfo.score} vs ${ci.score}`);
    R.check('creditInfo.creditLimit', Number(pyOut.creditInfo.creditLimitUsdc) === Number(ci.creditLimit), `${pyOut.creditInfo.creditLimitUsdc} vs ${ci.creditLimit}`);
    R.check('creditInfo.collateralPct', pyOut.creditInfo.collateralPct === ci.collateralPct);
    R.check('creditInfo.interestRateApr', pyOut.creditInfo.interestRateApr === ci.interestRateAPR, `${pyOut.creditInfo.interestRateApr} vs ${ci.interestRateAPR}`);
    R.check('pool.availableLiquidity (base units)', BigInt(pyOut.pool.availableLiquidity) === pool[3] || BigInt(pyOut.pool.availableLiquidity) === pool.availableLiquidity, `${pyOut.pool.availableLiquidity} vs ${pool[3]}`);
    R.check('pool.totalLiquidity/totalLoaned/totalEarned', BigInt(pyOut.pool.totalLiquidity) === pool[2] && BigInt(pyOut.pool.totalLoaned) === pool[4] && BigInt(pyOut.pool.totalEarned) === pool[5]);
    R.check('pool.agentAddress/isActive', pyOut.pool.agentAddress === pool[1] && pyOut.pool.isActive === pool[6]);
    R.check('activeLoanIds', JSON.stringify(pyOut.activeLoanIds) === JSON.stringify(active), `${JSON.stringify(pyOut.activeLoanIds)} vs ${JSON.stringify(active)}`);
    R.check('loans(): count', pyOut.loanCount === loans.length, `${pyOut.loanCount} vs ${loans.length}`);
    const mism = loans.filter((l, i) => { const p = pyOut.loans[i]; return !p || p.loanId !== l.id || Number(p.amountUsdc) !== Number(l.amount) || p.interestRateBps !== l.interestRate || p.state !== l.state || p.endTime !== l.endTime; });
    R.check('loans(): every entry equal (id, amount, rate, state, endTime)', mism.length === 0, mism.length ? JSON.stringify(mism.slice(0, 2)) : `${loans.length} loans`);
    R.check('lenderPosition(L1) amount/earned/depositTimestamp', BigInt(pyOut.lenderPositionL1.amount) === pos[0] && BigInt(pyOut.lenderPositionL1.earnedInterest) === pos[1] && BigInt(pyOut.lenderPositionL1.depositTimestamp) === pos[2]);
    R.check('canTopUp(L1)', pyOut.canTopUpL1 === (await sdk.canTopUp(aId, L1)));
    if (active.length) {
        const pv = await sdk.previewRepayment(active[0]);
        const p = pyOut.previewRepayment;
        R.check('previewRepayment on active loan: principal/interest/total/chargeable/late/source', p && BigInt(p.principal) === pv.principal && BigInt(p.interest) === pv.interest && BigInt(p.total) === pv.total && BigInt(p.chargeable_seconds) === pv.chargeableSeconds && BigInt(p.late_seconds) === pv.lateSeconds && p.source === pv.source, JSON.stringify(p));
    } else {
        R.note('previewRepayment on an ACTIVE loan', 'no active loan for this agent at run time — compared the REPAID-loan error path and nominal interest instead');
    }
    if (pyOut.nominalInterestRepaidLoan) {
        const n = pyOut.nominalInterestRepaidLoan;
        const loan = await mp.loans(n.loanId);
        const js = await mp.calculateInterest(loan.amount, loan.interestRate, loan.duration);
        const mirror = SpecularQuickstart.interestForSeconds(loan.amount, loan.interestRate, loan.duration);
        R.check(`nominal interest for repaid loan ${n.loanId}: python == contract == JS mirror`, BigInt(n.interest) === js && BigInt(n.mirror) === mirror && js === mirror, `${n.interest} / ${js} / ${mirror}`);
        let jsErr = null; try { await sdk.previewRepayment(n.loanId); } catch (e) { jsErr = e.message || ''; }
        R.check('previewRepayment on REPAID loan surfaces "Loan not active" in BOTH clients', /Loan not active/.test(jsErr || '') && /Loan not active/.test(pyOut.previewRepaymentInactiveError || ''), `py: ${pyOut.previewRepaymentInactiveError} | js: ${(jsErr || '').slice(0, 60)}`);
    }
    if (openedLoan !== null) {
        const h = await sdk0.repay(openedLoan);
        L.logTx(S, `${role0} repay loan ${openedLoan}`, await L.provider.getTransactionReceipt(h));
        R.check('cleanup: parity loan repaid', Number((await mp.loans(openedLoan)).state) === 2);
    }
    R.finish({ python: pyOut });
}
main().catch((e) => { console.error(e); process.exit(1); });
