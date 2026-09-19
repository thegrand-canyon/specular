// Unit tests for the V6.1 marketplace interface (2026-09 audit fixes), with
// MOCK contracts injected via chain._setContractsForTest (no RPC, nothing
// broadcast):
//   - prepare_repay_loan sizes the exact approve from previewRepayment().total
//     (bounded late headroom, clamped at the cap) and falls back to the nominal
//     calculateInterest figure on a V6 deployment (no VERSION()).
//   - the new revert strings translate to plain language.
//   - the three new read tools work on V6.1 and return a clear
//     "not supported on this deployment" 400 on V6.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { _setContractsForTest } from '../dist/chain.js';
import { prepareTx, explainRevert, LATE_REPAY_HEADROOM_SECONDS, ALLOWED_FUNCTIONS } from '../dist/prepare.js';
import { callTool, TOOLS } from '../dist/tools.js';
import { interestForSeconds } from '../dist/reads.js';
import { UnsupportedOnDeploymentError, ValidationError } from '../dist/validate.js';
import { getNetwork } from '../dist/networks.js';
import { buildOpenApi } from '../dist/openapi.js';

const NET = 'arc-staging';
const cfg = getNetwork(NET);
const BORROWER = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';
const HOLDER = '0x1111111111111111111111111111111111111111';
const STRANGER = '0x2222222222222222222222222222222222222222';
const DAY = 86400n;
const P = 1_000_000_000n; // 1000 USDC
const RATE = 1500n; // 15% APR
const DUR = 7n * DAY;
const CAP = 30n * DAY;
const NOW = 1_800_000_000n;
const LOAN_ID = 26;

function loanAt({ startedAgo, state = 1n, borrower = BORROWER }) {
  const startTime = NOW - startedAgo;
  return { loanId: BigInt(LOAN_ID), borrower, agentId: 1n, amount: P, collateralAmount: P, interestRate: RATE, startTime, endTime: startTime + DUR, duration: DUR, state };
}

/** Exact mirror of the contract's _interestDue at time NOW. */
function due(loan) {
  const elapsed = NOW - loan.startTime;
  let chargeable = elapsed > DUR ? elapsed : DUR;
  if (chargeable > DUR + CAP) chargeable = DUR + CAP;
  const lateSeconds = NOW > loan.endTime ? NOW - loan.endTime : 0n;
  const interest = interestForSeconds(P, RATE, chargeable);
  return { interest, total: P + interest, chargeableSeconds: chargeable, lateSeconds };
}

function noSelector() {
  // what ethers v6 throws when a V6 contract has no such function: empty return data
  return Object.assign(new Error('could not decode result data (value="0x", info={ "method": "VERSION", "signature": "VERSION()" }, code=BAD_DATA, version=6.16.0)'), { code: 'BAD_DATA' });
}

function mock({ v61, loan, allowance = 0n, balance = 10_000_000_000n, canTopUp = true, activeIds = [BigInt(LOAN_ID)], position = 0n, ownerOf = BORROWER }) {
  const calls = { previewRepayment: 0, calculateInterest: 0, VERSION: 0 };
  const marketplace = {
    VERSION: async () => {
      calls.VERSION++;
      if (!v61) throw noSelector();
      return 'V6.1';
    },
    LATE_INTEREST_CAP: async () => {
      if (!v61) throw noSelector();
      return CAP;
    },
    loans: async () => loan,
    nextLoanId: async () => 27n,
    previewRepayment: async () => {
      calls.previewRepayment++;
      if (!v61) throw noSelector();
      if (loan.state !== 1n) throw Object.assign(new Error('execution reverted: "Loan not active"'), { reason: 'Loan not active' });
      return due(loan);
    },
    calculateInterest: async (p, r, d) => {
      calls.calculateInterest++;
      return interestForSeconds(p, r, d);
    },
    agentPools: async () => ({ agentId: 1n, agentAddress: BORROWER, totalLiquidity: 0n, availableLiquidity: 0n, totalLoaned: P, totalEarned: 0n, isActive: true }),
    canTopUp: async () => {
      if (!v61) throw noSelector();
      return canTopUp;
    },
    getLenderPosition: async () => ({ amount: position, earnedInterest: 0n, depositTimestamp: 0n, shareOfPool: 0n }),
    pendingTranche: async () => ({ amount: 0n, timestamp: 0n }),
    getActiveLoanIds: async () => {
      if (!v61) throw noSelector();
      return activeIds;
    },
  };
  const registry = { addressToAgentId: async () => 1n, ownerOf: async () => ownerOf };
  const usdc = { allowance: async () => allowance, balanceOf: async () => balance };
  const provider = { getBlock: async () => ({ number: 100, timestamp: Math.floor(Date.now() / 1000) }) };
  _setContractsForTest(NET, { provider, marketplace, registry, reputation: {}, usdc });
  return calls;
}

afterEach(() => _setContractsForTest(NET, null));

const approveOf = (tx) => (tx.prerequisite ? BigInt(tx.prerequisite.call.args.amount) : null);

// ---------------------------------------------------------------- prepare_repay_loan

test('repay_loan on V6.1, on time: approve == previewRepayment().total exactly', async () => {
  const loan = loanAt({ startedAgo: 2n * DAY });
  const calls = mock({ v61: true, loan });
  const tx = await prepareTx(cfg, 'repay_loan', { from: BORROWER, loanId: LOAN_ID });
  const q = due(loan);
  assert.equal(q.lateSeconds, 0n);
  assert.equal(q.interest, interestForSeconds(P, RATE, DUR), 'on time => nominal fixed-term interest');
  assert.equal(approveOf(tx), q.total);
  assert.equal(tx.call.args.repaymentSource, 'previewRepayment');
  assert.equal(tx.call.args.marketplaceVersion, 'V6.1');
  assert.equal(tx.call.args.totalRepaymentUsdc, ethers.formatUnits(q.total, 6));
  assert.equal(tx.call.args.approveUsdc, ethers.formatUnits(q.total, 6));
  assert.equal(calls.previewRepayment, 1);
  assert.equal(calls.calculateInterest, 0, 'must not size the approve from the nominal figure on V6.1');
  assert.ok(!tx.warnings.some((w) => /late/i.test(w)));
  assert.notEqual(approveOf(tx), ethers.MaxUint256);
});

test('repay_loan on V6.1, 10 days late (accruing): approve == total + bounded headroom, never above the cap total', async () => {
  const loan = loanAt({ startedAgo: 17n * DAY });
  mock({ v61: true, loan });
  const tx = await prepareTx(cfg, 'repay_loan', { from: BORROWER, loanId: LOAN_ID });
  const q = due(loan);
  assert.equal(q.lateSeconds, 10n * DAY);
  assert.equal(q.chargeableSeconds, 17n * DAY);
  const headroom = interestForSeconds(P, RATE, q.chargeableSeconds + BigInt(LATE_REPAY_HEADROOM_SECONDS)) - q.interest;
  assert.ok(headroom > 0n);
  const approved = approveOf(tx);
  assert.equal(approved, q.total + headroom);
  assert.ok(approved > q.total, 'a late loan owes MORE than principal + nominal interest');
  assert.ok(approved > P + interestForSeconds(P, RATE, DUR));
  const maxTotal = P + interestForSeconds(P, RATE, DUR + CAP);
  assert.ok(approved <= maxTotal, 'headroom is clamped at duration + LATE_INTEREST_CAP');
  assert.equal(tx.call.args.maxTotalRepaymentUsdc, ethers.formatUnits(maxTotal, 6));
  assert.equal(tx.call.args.lateSeconds, String(10 * 86400));
  assert.ok(tx.warnings.some((w) => /past due.*accrues per second/i.test(w)));
  assert.match(tx.humanReadableSummary, /10 day\(s\) late/);
  assert.match(tx.prerequisite.warnings.join(' '), /late-accrual headroom/);
});

test('repay_loan on V6.1, 300 days late (at cap): amount is constant, approve == total exactly', async () => {
  const loan = loanAt({ startedAgo: 307n * DAY });
  mock({ v61: true, loan });
  const tx = await prepareTx(cfg, 'repay_loan', { from: BORROWER, loanId: LOAN_ID });
  const q = due(loan);
  assert.equal(q.chargeableSeconds, DUR + CAP);
  assert.equal(approveOf(tx), q.total);
  assert.equal(approveOf(tx), P + interestForSeconds(P, RATE, 37n * DAY));
  assert.ok(tx.warnings.some((w) => /at the interest cap/i.test(w)));
});

test('repay_loan on V6 (no VERSION()): falls back to calculateInterest, previewRepayment never called', async () => {
  const loan = loanAt({ startedAgo: 17n * DAY }); // late, but V6 charges nothing extra
  const calls = mock({ v61: false, loan });
  const tx = await prepareTx(cfg, 'repay_loan', { from: BORROWER, loanId: LOAN_ID });
  assert.equal(calls.previewRepayment, 0);
  assert.equal(calls.calculateInterest, 1);
  assert.equal(approveOf(tx), P + interestForSeconds(P, RATE, DUR));
  assert.equal(tx.call.args.repaymentSource, 'calculateInterest');
  assert.equal(tx.call.args.marketplaceVersion, 'V6');
  assert.equal(tx.call.args.lateSeconds, undefined);
  assert.ok(!tx.warnings.some((w) => /late/i.test(w)));
});

test('repay_loan: existing allowance that already covers the amount => no prerequisite; short allowance => exact top-up', async () => {
  const loan = loanAt({ startedAgo: 2n * DAY });
  const q = due(loan);
  mock({ v61: true, loan, allowance: q.total });
  assert.equal((await prepareTx(cfg, 'repay_loan', { from: BORROWER, loanId: LOAN_ID })).prerequisite, null);
  mock({ v61: true, loan, allowance: q.total - 1n });
  assert.equal(approveOf(await prepareTx(cfg, 'repay_loan', { from: BORROWER, loanId: LOAN_ID })), q.total);
});

test('repay_loan by the agent NFT holder: allowed on V6.1 (collateral goes to the borrower), refused on V6', async () => {
  const loan = loanAt({ startedAgo: 2n * DAY });
  mock({ v61: true, loan, ownerOf: HOLDER });
  let tx = await prepareTx(cfg, 'repay_loan', { from: HOLDER, loanId: LOAN_ID });
  assert.ok(tx.warnings.some((w) => /may repay it as the current holder/.test(w) && /Collateral is returned to/.test(w)));
  assert.ok(!tx.warnings.some((w) => /belongs to .* the transaction will revert/.test(w)));
  assert.equal(approveOf(tx), due(loan).total);

  mock({ v61: true, loan, ownerOf: HOLDER });
  tx = await prepareTx(cfg, 'repay_loan', { from: STRANGER, loanId: LOAN_ID });
  assert.ok(tx.warnings.some((w) => /belongs to .* the transaction will revert/.test(w) && /borrower or the current holder/.test(w)));

  mock({ v61: false, loan, ownerOf: HOLDER });
  tx = await prepareTx(cfg, 'repay_loan', { from: HOLDER, loanId: LOAN_ID });
  assert.ok(tx.warnings.some((w) => /belongs to .* the transaction will revert/.test(w)));
  assert.ok(!tx.warnings.some((w) => /current holder/.test(w)));
});

test('repay_loan on a non-ACTIVE loan: warns, no approve, no preview call', async () => {
  const loan = loanAt({ startedAgo: 2n * DAY, state: 2n });
  const calls = mock({ v61: true, loan });
  const tx = await prepareTx(cfg, 'repay_loan', { from: BORROWER, loanId: LOAN_ID });
  assert.equal(tx.prerequisite, null);
  assert.ok(tx.warnings.some((w) => /is REPAID, not ACTIVE/.test(w)));
  assert.equal(calls.previewRepayment, 0);
});

test('the relay allow-list gained no write functions (V6.1 adds views only)', () => {
  assert.deepEqual([...ALLOWED_FUNCTIONS.marketplace], ['createAgentPool', 'supplyLiquidity', 'withdrawLiquidity', 'requestLoan', 'repayLoan', 'claimInterest']);
});

// ---------------------------------------------------------------- revert translation

test('explainRevert: "Agent deactivated" and "Top-up would forfeit in-flight interest" get plain-language guidance', () => {
  const a = explainRevert({ reason: 'Agent deactivated' });
  assert.equal(a.reason, 'Agent deactivated');
  assert.match(a.plain, /deactivated in the registry/);
  assert.match(a.plain, /cannot borrow or create a pool/);
  assert.match(a.plain, /can still be repaid/);

  // as an ABI-encoded Error(string) from eth_call, the way an RPC returns it
  const data = '0x08c379a0' + ethers.AbiCoder.defaultAbiCoder().encode(['string'], ['Top-up would forfeit in-flight interest']).slice(2);
  const b = explainRevert({ data });
  assert.equal(b.reason, 'Top-up would forfeit in-flight interest');
  assert.match(b.plain, /can_top_up\(agentId, lender\)/);
  assert.match(b.plain, /older active loans close/);
  assert.match(b.plain, /fresh position from another address/);

  const c = explainRevert({ shortMessage: 'execution reverted: "Not the borrower"' });
  assert.match(c.plain, /current holder of the agent NFT/);
});

// ---------------------------------------------------------------- new read tools

test('the three V6.1 read tools are registered, GET-bound and in the OpenAPI document', () => {
  const byName = new Map(TOOLS.map((t) => [t.name, t]));
  for (const [name, path] of [
    ['preview_repayment', '/v1/{network}/loans/{loanId}/repayment'],
    ['can_top_up', '/v1/{network}/pools/{agentId}/can-top-up/{lender}'],
    ['get_active_loan_ids', '/v1/{network}/agents/{agentId}/active-loans'],
  ]) {
    const t = byName.get(name);
    assert.ok(t, `${name} registered`);
    assert.equal(t.kind, 'read');
    assert.equal(t.rest.method, 'GET');
    assert.equal(t.rest.path, path);
    assert.ok(buildOpenApi('http://x').paths[path]?.get, `${path} in openapi`);
    assert.match(t.description, /V6.1 only/);
  }
});

test('preview_repayment on V6.1 returns the exact quote; on V6 a clear "not supported" 400', async () => {
  const loan = loanAt({ startedAgo: 17n * DAY });
  mock({ v61: true, loan });
  const r = await callTool('preview_repayment', { network: NET, loanId: LOAN_ID });
  const q = due(loan);
  assert.equal(r.marketplaceVersion, 'V6.1');
  assert.equal(r.totalRepaymentUsdc, ethers.formatUnits(q.total, 6));
  assert.equal(r.interestUsdc, ethers.formatUnits(q.interest, 6));
  assert.equal(r.lateSeconds, 10 * 86400);
  assert.equal(r.late, true);
  assert.equal(r.accruing, true);
  assert.equal(r.chargeableDays, 17);
  assert.equal(r.lateInterestCapDays, 30);
  assert.equal(r.source, 'previewRepayment');
  assert.match(r.note, /LATE/);
  assert.ok(r.rpc.blockNumber === 100);

  mock({ v61: false, loan });
  await assert.rejects(
    callTool('preview_repayment', { network: NET, loanId: LOAN_ID }),
    (e) => e instanceof UnsupportedOnDeploymentError && e instanceof ValidationError && e.status === 400 && /preview_repayment is not supported on this deployment/.test(e.message) && /reports version V6/.test(e.message),
  );
});

test('preview_repayment: non-existent or non-ACTIVE loan is a validation error, not a raw revert', async () => {
  mock({ v61: true, loan: loanAt({ startedAgo: DAY, state: 2n }) });
  await assert.rejects(callTool('preview_repayment', { network: NET, loanId: LOAN_ID }), /is REPAID, not ACTIVE/);
  mock({ v61: true, loan: loanAt({ startedAgo: DAY, borrower: ethers.ZeroAddress }) });
  await assert.rejects(callTool('preview_repayment', { network: NET, loanId: LOAN_ID }), /does not exist/);
});

test('can_top_up on V6.1 (refused / allowed / no position); on V6 "not supported"', async () => {
  const loan = loanAt({ startedAgo: DAY });
  mock({ v61: true, loan, canTopUp: false, position: 5_000_000n });
  let r = await callTool('can_top_up', { network: NET, agentId: 1, lender: HOLDER });
  assert.equal(r.canTopUp, false);
  assert.equal(r.hasPosition, true);
  assert.equal(r.suppliedUsdc, '5.0');
  assert.match(r.note, /would revert "Top-up would forfeit in-flight interest"/);

  mock({ v61: true, loan, canTopUp: true, position: 5_000_000n });
  r = await callTool('can_top_up', { network: NET, agentId: 1, lender: HOLDER });
  assert.equal(r.canTopUp, true);
  assert.match(r.note, /nothing is forfeited/);

  mock({ v61: true, loan, canTopUp: true, position: 0n });
  r = await callTool('can_top_up', { network: NET, agentId: 1, lender: HOLDER });
  assert.equal(r.hasPosition, false);
  assert.match(r.note, /first supply is never refused/);

  await assert.rejects(callTool('can_top_up', { network: NET, agentId: 1, lender: 'nope' }), /lender must be a 0x-prefixed/);

  mock({ v61: false, loan });
  await assert.rejects(callTool('can_top_up', { network: NET, agentId: 1, lender: HOLDER }), (e) => e instanceof UnsupportedOnDeploymentError && /can_top_up is not supported on this deployment/.test(e.message));
});

test('get_active_loan_ids on V6.1 lists the active set with loan details; on V6 "not supported"', async () => {
  const loan = loanAt({ startedAgo: DAY });
  mock({ v61: true, loan, activeIds: [26n] });
  const r = await callTool('get_active_loan_ids', { network: NET, agentId: 1 });
  assert.equal(r.activeLoans, 1);
  assert.deepEqual(r.loanIds, [26]);
  assert.equal(r.loans[0].loanId, 26);
  assert.equal(r.loans[0].state, 'ACTIVE');
  assert.equal(r.loans[0].principalUsdc, '1000.0');

  mock({ v61: false, loan });
  await assert.rejects(callTool('get_active_loan_ids', { network: NET, agentId: 1 }), (e) => e instanceof UnsupportedOnDeploymentError && /get_active_loan_ids is not supported/.test(e.message));
});

test('get_loan_status.repayment uses previewRepayment on V6.1 (late-aware) and calculateInterest on V6', async () => {
  const loan = loanAt({ startedAgo: 17n * DAY });
  mock({ v61: true, loan });
  let r = await callTool('get_loan_status', { network: NET, loanId: LOAN_ID });
  assert.equal(r.repayment.source, 'previewRepayment');
  assert.equal(r.repayment.late, true);
  assert.equal(r.repayment.totalRepaymentUsdc, ethers.formatUnits(due(loan).total, 6));

  mock({ v61: false, loan });
  r = await callTool('get_loan_status', { network: NET, loanId: LOAN_ID });
  assert.equal(r.repayment.source, 'calculateInterest');
  assert.equal(r.repayment.late, false);
  assert.equal(r.repayment.totalRepaymentUsdc, ethers.formatUnits(P + interestForSeconds(P, RATE, DUR), 6));
  assert.match(r.repayment.note, /V6 deployment/);
});
