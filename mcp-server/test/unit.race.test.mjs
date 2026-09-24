// Unit tests for the CONTENTION handling added by the 2026-09-25 concurrency round
// (forensics/output/testing-2026-09-25/CONCURRENCY_REPORT.md).
//
// The round's local harness showed that the V6.2 contract is safe under same-block
// contention in every race driven — but that the loser of each race is told only
// "reverted". The server already translated revert strings into plain language; what it
// did NOT say was (a) which block the simulation belonged to, and (b) whether the
// refusal was somebody else's transaction getting there first (retry) or the caller's
// own problem (do not retry). Two of the plain-language strings actively gave the wrong
// advice in the contended case.
//
// Nothing is broadcast: contracts and provider are mocks injected through
// chain._setContractsForTest.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { _setContractsForTest } from '../dist/chain.js';
import { prepareTx, explainRevert, classifyRace, simulateCall } from '../dist/prepare.js';
import { getNetwork } from '../dist/networks.js';

const NET = 'arc-staging';
const cfg = getNetwork(NET);
const AGENT = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';
const LENDER = '0x3333333333333333333333333333333333333333';
const USDC = (n) => ethers.parseUnits(String(n), 6);
const DAY = 86400n;
const AGENT_ID = 1;

/** Minimal stack: enough for supply/withdraw/borrow prepares plus a controllable simulation. */
function mock({ simulate = 'ok', revertReason = null, blockNumber = 4242, available = USDC(100000) } = {}) {
  const marketplace = {
    VERSION: async () => 'V6.2',
    LATE_INTEREST_CAP: async () => 30n * DAY,
    agentPools: async () => ({ agentId: BigInt(AGENT_ID), agentAddress: AGENT, totalLiquidity: available, availableLiquidity: available, totalLoaned: 0n, totalEarned: 0n, isActive: true }),
    getLenderPosition: async () => ({ amount: USDC(500), earnedInterest: USDC(1), depositTimestamp: 0n, shareOfPool: 0n }),
    pendingTranche: async () => ({ amount: 0n, timestamp: 0n }),
    canTopUp: async () => true,
    getActiveLoanIds: async () => [],
    minSupplyAmount: async () => USDC(10),
    activeLoanCount: async () => 0n,
    outstandingPrincipal: async () => 0n,
    requiredSelfStake: async () => 0n,
    selfStake: async () => ({ amount: USDC(2500), locked: false }),
    MAX_ACTIVE_LOANS_PER_AGENT: async () => 10n,
    MAX_LENDERS_PER_POOL: async () => 50n,
    bindBorrowToPoolCreator: async () => true,
    paused: async () => false,
    calculateInterest: async (p, r, d) => ((p * r) / 10000n * d) / (365n * DAY),
    loans: async () => ({ borrower: ethers.ZeroAddress }),
    nextLoanId: async () => 1n,
    totalPools: async () => 1n,
    getActiveAgents: async () => [BigInt(AGENT_ID)],
    minHoldForReputationReward: async () => DAY,
    platformFeeRate: async () => 100n,
  };
  const reputation = {
    VERSION: async () => 'V4',
    'getReputationScore(address)': async () => 800n,
    calculateCreditLimit: async () => USDC(5000),
    calculateCollateralRequirement: async () => 0n,
    calculateInterestRate: async () => 500n,
    creditMultiple: async () => 2n,
    tierOf: async () => 5n,
    tierLimit: async () => USDC(5000),
    tierLimits: async () => USDC(5000),
    tierMinScore: async () => 800n,
    tierCollateralPct: async () => 0n,
    tierInterestBps: async () => 500n,
    unsecuredTierExposure: async () => USDC(5000),
    MAX_TIER_LIMIT: async () => USDC(10000),
    ladderLimit: async () => USDC(5100),
    maxRepaidPrincipal: async () => USDC(2500),
    isLockedOut: async () => false,
    lockedUntil: async () => 0n,
  };
  const registry = {
    addressToAgentId: async (a) => (String(a).toLowerCase() === AGENT.toLowerCase() ? BigInt(AGENT_ID) : 0n),
    ownerOf: async () => AGENT,
    getAgentInfo: async () => ({ owner: AGENT, agentWallet: AGENT, agentURI: 'ipfs://a', isActive: true, registrationTime: 1n }),
    totalAgents: async () => 1n,
  };
  const usdc = { allowance: async () => USDC(1_000_000), balanceOf: async () => USDC(1_000_000) };
  const provider = {
    getBlock: async () => ({ number: blockNumber, timestamp: Math.floor(Date.now() / 1000) }),
    getBlockNumber: async () => blockNumber,
    call: async () => {
      if (simulate === 'ok') return '0x';
      throw Object.assign(new Error(`execution reverted: ${revertReason}`), { code: 'CALL_EXCEPTION', reason: revertReason });
    },
    estimateGas: async () => 210000n,
  };
  _setContractsForTest(NET, { provider, marketplace, registry, reputation, usdc });
}

afterEach(() => _setContractsForTest(NET, null));

// ────────────────────────────────────────────────── the classification itself
test('classifyRace: the contended refusals are retryable', () => {
  for (const r of [
    'Insufficient pool liquidity',
    'Pool lender capacity reached',
    'Last slot reserved for agent self-stake',
    'Top-up would forfeit in-flight interest',
    'Drain underflow',
    'EnforcedPause()',
  ]) {
    assert.equal(classifyRace(r), 'retryable', `${r} should be retryable`);
  }
});

test('classifyRace: the caller\'s own preconditions are actionable, not retryable', () => {
  for (const r of [
    'Exceeds credit limit',
    'Too many active loans',
    'Insufficient self-stake',
    'Self-stake locked while borrowing',
    'Remaining below minimum supply',
    'Below minimum supply',
    'Insufficient balance',
    'ERC20InsufficientAllowance(0x0, 0, 1)',
  ]) {
    assert.equal(classifyRace(r), 'actionable', `${r} should be actionable`);
  }
});

test('classifyRace: "Loan not active" is TERMINAL — the repay-vs-liquidate race must not be retried blindly', () => {
  assert.equal(classifyRace('Loan not active'), 'terminal');
  const { plain } = explainRevert({ reason: 'Loan not active' });
  assert.match(plain, /liquidat/i, 'must warn that this can mean the loan was liquidated');
  assert.match(plain, /DEFAULTED|state/i, 'must tell the agent to read the loan state');
  assert.match(plain, /not retry|Do NOT retry/i);
});

test('"Drain underflow" is explained as liquidity being out on loan, not as an accounting fault', () => {
  const { plain, raceClass } = explainRevert({ reason: 'Drain underflow' });
  assert.equal(raceClass, 'retryable');
  assert.match(plain, /out on loan|availableLiquidity/i, 'must name the real cause');
  assert.match(plain, /retry/i);
  assert.match(plain, /TRANSIENT|transient/);
});

test('classifyRace: anything unmapped fails closed as terminal', () => {
  assert.equal(classifyRace('some brand new require string'), 'terminal');
  assert.equal(classifyRace(''), 'terminal');
});

test('explainRevert carries the raceClass alongside the plain language', () => {
  const liq = explainRevert({ reason: 'Insufficient pool liquidity' });
  assert.equal(liq.raceClass, 'retryable');
  assert.match(liq.plain, /CONTENTION|retry/i, 'the liquidity message must mention the contended case');
  assert.match(liq.plain, /nothing of yours moved|nothing.*moved/i);

  const cap = explainRevert({ reason: 'Pool lender capacity reached' });
  assert.equal(cap.raceClass, 'retryable');
  assert.match(cap.plain, /retry/i, 'must not say only "choose another pool" — a slot can free next block');

  const stake = explainRevert({ reason: 'Insufficient self-stake' });
  assert.equal(stake.raceClass, 'actionable');
});

// ───────────────────────────────────────── the simulation reports its own block
test('simulateCall records the block it was evaluated against (success path)', async () => {
  mock({ simulate: 'ok', blockNumber: 777 });
  const sim = await simulateCall(cfg, AGENT, cfg.addresses.marketplace, '0x12345678');
  assert.equal(sim.ok, true);
  assert.equal(sim.simulatedAtBlock, 777);
  assert.equal(sim.raceClass, null);
});

test('simulateCall reports block + raceClass on a contended refusal', async () => {
  mock({ simulate: 'revert', revertReason: 'Insufficient pool liquidity', blockNumber: 999 });
  const sim = await simulateCall(cfg, AGENT, cfg.addresses.marketplace, '0x12345678');
  assert.equal(sim.ok, false);
  assert.equal(sim.revertReason, 'Insufficient pool liquidity');
  assert.equal(sim.raceClass, 'retryable');
  assert.equal(sim.simulatedAtBlock, 999);
});

// ────────────────────────── the prepared tx tells the agent the answer is stale
test('a simulated prepare on a CONTENDED action warns that the simulation can be invalidated before the tx lands', async () => {
  mock({ simulate: 'ok', blockNumber: 4242 });
  const tx = await prepareTx(cfg, 'request_loan', { from: AGENT, amount: '100', durationDays: 7, simulate: true });
  assert.equal(tx.simulation.ok, true);
  assert.equal(tx.simulation.simulatedAtBlock, 4242);
  const w = tx.warnings.join(' | ');
  assert.match(w, /block 4242/, 'the warning must name the block the simulation belongs to');
  assert.match(w, /Insufficient pool liquidity/, 'must name the refusal the agent will actually see');
  assert.match(w, /retryable/i);
});

test('the contention warning is NOT attached to actions nobody can contend', async () => {
  mock({ simulate: 'ok', blockNumber: 4242 });
  const tx = await prepareTx(cfg, 'approve_usdc', { from: AGENT, amount: '100', simulate: true });
  assert.ok(!tx.warnings.join(' | ').includes('Simulated against block'),
    'approve_usdc is not contended and must not carry the race warning');
});

test('a prepare whose simulation already failed with a retryable reason says so explicitly', async () => {
  mock({ simulate: 'revert', revertReason: 'Insufficient pool liquidity', blockNumber: 31337 });
  const tx = await prepareTx(cfg, 'supply_liquidity', { from: LENDER, agentId: AGENT_ID, amount: '50', simulate: true });
  assert.equal(tx.simulation.ok, false);
  assert.equal(tx.simulation.raceClass, 'retryable');
  const w = tx.warnings.join(' | ');
  assert.match(w, /RETRYABLE/);
  assert.match(w, /block 31337/);
});

test('the OpenAPI schema advertises the two new simulation fields', async () => {
  const { buildOpenApi } = await import('../dist/openapi.js');
  const doc = buildOpenApi('https://example.invalid');
  const props = JSON.stringify(doc).includes('simulatedAtBlock') && JSON.stringify(doc).includes('raceClass');
  assert.ok(props, 'simulatedAtBlock and raceClass must appear in the published schema');
});
