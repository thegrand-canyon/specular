// Unit tests for the V6.2 / V7 credit model (AgentLiquidityMarketplaceV62 +
// ReputationManagerV4), with MOCK contracts injected via
// chain._setContractsForTest (no RPC, nothing broadcast).
//
// What is under test:
//   - THREE-WAY capability detection (V6 / V6.1 / V6.2) and the reputation
//     generation (V3 / V4), including the bytecode-confirmation fallback.
//   - the two new read tools (required_self_stake, get_self_stake) and their
//     clean "not supported on this deployment" answer on V6 / V6.1.
//   - prepare_request_loan warning before an "Insufficient self-stake" revert,
//     with the exact shortfall, and flagging a post-default lockout.
//   - prepare_withdraw_liquidity warning about the first-loss lock (and NOT
//     masking it with the generic liquidity message).
//   - prepare_supply_liquidity exempting the pool creator from minSupplyAmount
//     on V6.2 only.
//   - plain-language translation of the two new revert strings.
//   - the credit tier table being READ FROM THE CHAIN on V4 (no hardcoded copy).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { _setContractsForTest, marketplaceCapabilities, reputationCapabilities, versionOrdinal } from '../dist/chain.js';
import { prepareTx, explainRevert } from '../dist/prepare.js';
import { callTool, TOOLS } from '../dist/tools.js';
import { creditTierTable, readCredit, _clearTierTableCache, TIER_NAMES, tierNameFor } from '../dist/reads.js';
import { UnsupportedOnDeploymentError } from '../dist/validate.js';
import { getNetwork } from '../dist/networks.js';
import { buildOpenApi } from '../dist/openapi.js';

const NET = 'arc-staging';
const cfg = getNetwork(NET);
const AGENT = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';
const LENDER = '0x3333333333333333333333333333333333333333';
const DAY = 86400n;
const USDC = (n) => ethers.parseUnits(String(n), 6);
const AGENT_ID = 1;

/** what ethers v6 throws when the deployed contract has no such function */
function noSelector(name = 'VERSION') {
  return Object.assign(new Error(`could not decode result data (value="0x", info={ "method": "${name}" }, code=BAD_DATA)`), { code: 'BAD_DATA' });
}

/** V7 shipped tier table (ReputationManagerV4 defaults). */
const V4_TIERS = {
  minScore: [0, 200, 400, 500, 600, 800],
  limits: [USDC(1000), USDC(5000), USDC(10000), USDC(10000), USDC(2500), USDC(5000)],
  collateral: [100, 100, 100, 75, 0, 0],
  rates: [1500, 1500, 1000, 1000, 700, 500],
};
const MAX_TIER_LIMIT = USDC(10000);

function tierOf(score) {
  for (let i = 5; i >= 0; i--) if (score >= V4_TIERS.minScore[i]) return i;
  return 0;
}

/**
 * @param version        'V6' | 'V6.1' | 'V6.2'
 * @param repVersion     'V3' | 'V4'
 * @param selfStake      base units the pool creator holds in its own pool
 * @param requiredStake  base units requiredSelfStake() answers
 */
function mock({
  version = 'V6.2',
  repVersion = 'V4',
  selfStake = USDC(2500),
  requiredStake = USDC(2500),
  outstanding = USDC(0),
  creator = AGENT,
  score = 800,
  creditLimit = USDC(5000),
  lockedOut = false,
  lockedUntil = 0n,
  minSupply = USDC(10),
  allowance = USDC(1_000_000),
  balance = USDC(1_000_000),
  available = USDC(100000),
  selfStakeViewThrows = false,
  position = USDC(2500),
} = {}) {
  const calls = { requiredSelfStake: 0, selfStake: 0, VERSION: 0, repVERSION: 0, tierLimits: 0 };
  const collateralPct = BigInt(V4_TIERS.collateral[tierOf(score)]);
  const marketplace = {
    VERSION: async () => {
      calls.VERSION++;
      if (version === 'V6') throw noSelector();
      return version;
    },
    LATE_INTEREST_CAP: async () => (version === 'V6' ? Promise.reject(noSelector()) : 30n * DAY),
    requiredSelfStake: async (_id, extra) => {
      calls.requiredSelfStake++;
      if (version !== 'V6.2' || selfStakeViewThrows) throw noSelector('requiredSelfStake');
      // mirrors _requiredSelfStake: unsecured/(k) on top of the outstanding exposure
      if (collateralPct >= 100n) return 0n;
      const exposure = outstanding + BigInt(extra ?? 0n);
      const unsecured = (exposure * (100n - collateralPct)) / 100n;
      return extra === undefined || BigInt(extra) === 0n ? requiredStake : unsecured / 2n;
    },
    selfStake: async () => {
      calls.selfStake++;
      if (version !== 'V6.2' || selfStakeViewThrows) throw noSelector('selfStake');
      return { amount: selfStake, locked: outstanding > 0n };
    },
    outstandingPrincipal: async () => outstanding,
    agentPools: async () => ({ agentId: BigInt(AGENT_ID), agentAddress: creator, totalLiquidity: available + outstanding, availableLiquidity: available, totalLoaned: outstanding, totalEarned: 0n, isActive: true }),
    getLenderPosition: async () => ({ amount: position, earnedInterest: USDC(1), depositTimestamp: 0n, shareOfPool: 0n }),
    pendingTranche: async () => ({ amount: 0n, timestamp: 0n }),
    canTopUp: async () => true,
    getActiveLoanIds: async () => [],
    minSupplyAmount: async () => minSupply,
    activeLoanCount: async () => 0n,
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
    VERSION: async () => {
      calls.repVERSION++;
      if (repVersion === 'V3') throw noSelector();
      return repVersion;
    },
    'getReputationScore(address)': async () => BigInt(score),
    calculateCreditLimit: async () => (lockedOut ? 0n : creditLimit),
    calculateCollateralRequirement: async () => collateralPct,
    calculateInterestRate: async () => BigInt(V4_TIERS.rates[tierOf(score)]),
    creditMultiple: async () => 2n,
    tierOf: async (s) => BigInt(tierOf(Number(s))),
    tierLimit: async (s) => V4_TIERS.limits[tierOf(Number(s))],
    tierLimits: async (i) => {
      calls.tierLimits++;
      return V4_TIERS.limits[Number(i)];
    },
    tierMinScore: async (i) => BigInt(V4_TIERS.minScore[Number(i)]),
    tierCollateralPct: async (i) => BigInt(V4_TIERS.collateral[Number(i)]),
    tierInterestBps: async (i) => BigInt(V4_TIERS.rates[Number(i)]),
    unsecuredTierExposure: async (i) => (V4_TIERS.limits[Number(i)] * BigInt(100 - V4_TIERS.collateral[Number(i)])) / 100n,
    MAX_TIER_LIMIT: async () => MAX_TIER_LIMIT,
    ladderLimit: async () => USDC(5100),
    maxRepaidPrincipal: async () => USDC(2500),
    isLockedOut: async () => lockedOut,
    lockedUntil: async () => lockedUntil,
  };
  const registry = {
    addressToAgentId: async (a) => (String(a).toLowerCase() === AGENT.toLowerCase() ? BigInt(AGENT_ID) : 0n),
    ownerOf: async () => AGENT,
    getAgentInfo: async () => ({ owner: AGENT, agentWallet: AGENT, agentURI: 'ipfs://a', isActive: true, registrationTime: 1n }),
    totalAgents: async () => 1n,
  };
  const usdc = { allowance: async () => allowance, balanceOf: async () => balance };
  const provider = { getBlock: async () => ({ number: 100, timestamp: Math.floor(Date.now() / 1000) }) };
  _setContractsForTest(NET, { provider, marketplace, registry, reputation, usdc });
  return calls;
}

afterEach(() => {
  _setContractsForTest(NET, null);
  _clearTierTableCache();
});

// ------------------------------------------------------- capability detection

test('versionOrdinal orders the three generations and fails safe on junk', () => {
  assert.equal(versionOrdinal('V6'), 6);
  assert.equal(versionOrdinal('V6.1'), 6.1);
  assert.equal(versionOrdinal('V6.2'), 6.2);
  assert.equal(versionOrdinal(''), 6, 'unknown sorts as the most conservative generation');
  assert.equal(versionOrdinal('not-a-version'), 6);
  assert.ok(versionOrdinal('V6.2') > versionOrdinal('V6.1'));
});

test('capabilities: V6 deployment has neither v61 nor v62', async () => {
  mock({ version: 'V6', repVersion: 'V3' });
  const caps = await marketplaceCapabilities(cfg);
  assert.equal(caps.version, 'V6');
  assert.equal(caps.v61, false);
  assert.equal(caps.v62, false);
  assert.equal(caps.lateInterestCapSeconds, null);
  assert.equal((await reputationCapabilities(cfg)).v4, false);
});

test('capabilities: V6.1 deployment is v61 but NOT v62 (Base / Arc mainnet today)', async () => {
  mock({ version: 'V6.1', repVersion: 'V3' });
  const caps = await marketplaceCapabilities(cfg);
  assert.equal(caps.version, 'V6.1');
  assert.equal(caps.v61, true);
  assert.equal(caps.v62, false, 'V6.1 must never be treated as having the self-stake gate');
  assert.equal(caps.lateInterestCapSeconds, 30 * 86400);
  const r = await reputationCapabilities(cfg);
  assert.equal(r.version, 'V3');
  assert.equal(r.v4, false);
});

test('capabilities: V6.2 deployment is v61 AND v62, with a V4 reputation manager', async () => {
  mock({ version: 'V6.2', repVersion: 'V4' });
  const caps = await marketplaceCapabilities(cfg);
  assert.equal(caps.version, 'V6.2');
  assert.equal(caps.ordinal, 6.2);
  assert.equal(caps.v61, true, 'V6.2 keeps every V6.1 view');
  assert.equal(caps.v62, true);
  const r = await reputationCapabilities(cfg);
  assert.equal(r.version, 'V4');
  assert.equal(r.v4, true);
});

test('capabilities: a contract claiming V6.2 whose self-stake view does not answer is NOT treated as v62', async () => {
  mock({ version: 'V6.2', selfStakeViewThrows: true });
  const caps = await marketplaceCapabilities(cfg);
  assert.equal(caps.version, 'V6.2');
  assert.equal(caps.v62, false, 'the version string alone must not enable the gate');
  assert.equal(caps.v61, true);
});

// ----------------------------------------------------------- required_self_stake

test('required_self_stake: reports requirement, holding and shortfall on V6.2', async () => {
  mock({ selfStake: USDC(1000), requiredStake: USDC(2500), outstanding: USDC(0) });
  const r = await callTool('required_self_stake', { network: NET, agentId: AGENT_ID, additionalAmount: 0 });
  assert.equal(r.marketplaceVersion, 'V6.2');
  assert.equal(r.requiredSelfStakeUsdc, '2500.0');
  assert.equal(r.currentSelfStakeUsdc, '1000.0');
  assert.equal(r.shortfallUsdc, '1500.0');
  assert.equal(r.sufficient, false);
  assert.equal(r.creditMultiple, 2);
  assert.match(r.note, /Insufficient self-stake/);
  assert.match(r.note, /1500\.0 more USDC/);
});

test('required_self_stake: sufficient stake reports no shortfall', async () => {
  mock({ selfStake: USDC(2500), requiredStake: USDC(2500) });
  const r = await callTool('required_self_stake', { network: NET, agentId: AGENT_ID });
  assert.equal(r.shortfallUsdc, '0.0');
  assert.equal(r.sufficient, true);
  assert.doesNotMatch(r.note, /would revert/);
});

test('required_self_stake: a 100%-collateral tier needs no self-stake', async () => {
  mock({ score: 100, requiredStake: 0n, selfStake: 0n, creditLimit: USDC(1000) });
  const r = await callTool('required_self_stake', { network: NET, agentId: AGENT_ID });
  assert.equal(r.collateralPercent, 100);
  assert.equal(r.requiredSelfStakeUsdc, '0.0');
  assert.equal(r.sufficient, true);
  assert.match(r.note, /no self-stake is required/);
});

for (const v of ['V6', 'V6.1']) {
  test(`required_self_stake: clean "not supported" on a ${v} deployment, not a raw revert`, async () => {
    mock({ version: v, repVersion: 'V3' });
    await assert.rejects(
      () => callTool('required_self_stake', { network: NET, agentId: AGENT_ID }),
      (e) => {
        assert.ok(e instanceof UnsupportedOnDeploymentError, `expected UnsupportedOnDeploymentError, got ${e}`);
        assert.equal(e.status, 400);
        assert.equal(e.code, 'UNSUPPORTED_ON_DEPLOYMENT');
        assert.match(e.message, /not supported on this deployment/);
        assert.match(e.message, new RegExp(`version ${v.replace('.', '\\.')}`));
        assert.match(e.message, /requires V6\.2/);
        assert.match(e.message, /not "zero required"/);
        return true;
      },
    );
  });

  test(`get_self_stake: clean "not supported" on a ${v} deployment`, async () => {
    mock({ version: v, repVersion: 'V3' });
    await assert.rejects(
      () => callTool('get_self_stake', { network: NET, agentId: AGENT_ID }),
      (e) => e instanceof UnsupportedOnDeploymentError && /requires V6\.2/.test(e.message),
    );
  });
}

// ----------------------------------------------------------------- get_self_stake

test('get_self_stake: LOCKED while principal is outstanding, and says why', async () => {
  mock({ selfStake: USDC(2500), outstanding: USDC(5000), requiredStake: USDC(2500) });
  const r = await callTool('get_self_stake', { network: NET, agentId: AGENT_ID });
  assert.equal(r.locked, true);
  assert.equal(r.selfStakeUsdc, '2500.0');
  assert.equal(r.withdrawableUsdc, '0.0');
  assert.equal(r.outstandingPrincipalUsdc, '5000.0');
  assert.match(r.note, /Self-stake locked while borrowing/);
  assert.match(r.note, /absorbs the loss BEFORE any third-party lender/);
  assert.match(r.note, /claimInterest is not affected/);
});

test('get_self_stake: unlocked when no principal is outstanding', async () => {
  mock({ selfStake: USDC(2500), outstanding: 0n, requiredStake: USDC(2500) });
  const r = await callTool('get_self_stake', { network: NET, agentId: AGENT_ID });
  assert.equal(r.locked, false);
  assert.equal(r.withdrawableUsdc, '2500.0');
  assert.match(r.note, /not locked/);
  assert.match(r.note, /locked again the moment the agent opens a loan/);
});

// ------------------------------------------------------------ prepare_request_loan

test('prepare_request_loan: warns BEFORE the "Insufficient self-stake" revert and gives the exact top-up', async () => {
  mock({ selfStake: USDC(100), requiredStake: USDC(2500), outstanding: 0n, score: 800 });
  const tx = await prepareTx(cfg, 'request_loan', { from: AGENT, amount: 5000, durationDays: 30 });
  assert.equal(tx.call.args.requiredSelfStakeUsdc, '2500.0');
  assert.equal(tx.call.args.currentSelfStakeUsdc, '100.0');
  assert.equal(tx.call.args.selfStakeShortfallUsdc, '2400.0');
  const w = tx.warnings.find((x) => /INSUFFICIENT SELF-STAKE/.test(x));
  assert.ok(w, `expected a self-stake warning, got ${JSON.stringify(tx.warnings)}`);
  assert.match(w, /supply 2400\.0 USDC more/);
  assert.match(w, /exempt from the minimum supply/);
  assert.match(tx.humanReadableSummary, /first-loss self-stake/);
});

test('prepare_request_loan: no self-stake warning when the stake already covers the exposure', async () => {
  mock({ selfStake: USDC(2500), requiredStake: USDC(2500), score: 800 });
  const tx = await prepareTx(cfg, 'request_loan', { from: AGENT, amount: 5000, durationDays: 30 });
  assert.equal(tx.call.args.selfStakeShortfallUsdc, '0.0');
  assert.ok(!tx.warnings.some((x) => /INSUFFICIENT SELF-STAKE/.test(x)));
});

test('prepare_request_loan: a 100%-collateral tier never reads the self-stake views', async () => {
  const calls = mock({ score: 100, creditLimit: USDC(1000) });
  const tx = await prepareTx(cfg, 'request_loan', { from: AGENT, amount: 500, durationDays: 30 });
  assert.equal(tx.call.args.collateralPercent, '100');
  assert.equal(tx.call.args.requiredSelfStakeUsdc, undefined, 'no self-stake gate applies at 100% collateral');
  // requiredSelfStake is still probed once by the capability check, never for the quote
  assert.ok(calls.requiredSelfStake <= 1, `unexpected self-stake reads: ${calls.requiredSelfStake}`);
});

test('prepare_request_loan: a post-default LOCKOUT is explained, not left as a bare limit error', async () => {
  const until = BigInt(Math.floor(Date.now() / 1000) + 180 * 86400);
  mock({ lockedOut: true, lockedUntil: until, creditLimit: 0n, selfStake: USDC(2500), requiredStake: USDC(2500) });
  const tx = await prepareTx(cfg, 'request_loan', { from: AGENT, amount: 100, durationDays: 30 });
  assert.equal(tx.call.args.lockedOut, 'true');
  const w = tx.warnings.find((x) => /LOCKED OUT/.test(x));
  assert.ok(w, JSON.stringify(tx.warnings));
  assert.match(w, /credit limit is 0 until then/);
  assert.match(w, /no matter how small the amount/);
});

test('prepare_request_loan: on a V6.1 deployment nothing self-stake-related is reported', async () => {
  mock({ version: 'V6.1', repVersion: 'V3', score: 800 });
  const tx = await prepareTx(cfg, 'request_loan', { from: AGENT, amount: 1000, durationDays: 30 });
  assert.equal(tx.call.args.requiredSelfStakeUsdc, undefined);
  assert.equal(tx.call.args.lockedOut, undefined);
  assert.ok(!tx.warnings.some((x) => /SELF-STAKE/i.test(x)));
});

// -------------------------------------------------------- prepare_withdraw_liquidity

test('prepare_withdraw_liquidity: warns that the creator position is LOCKED first-loss capital', async () => {
  mock({ creator: AGENT, outstanding: USDC(5000), selfStake: USDC(2500), position: USDC(2500), available: 0n });
  const tx = await prepareTx(cfg, 'withdraw_liquidity', { from: AGENT, agentId: AGENT_ID, amount: 100 });
  assert.equal(tx.call.args.selfStakeLocked, 'true');
  assert.equal(tx.call.args.outstandingPrincipalUsdc, '5000.0');
  const w = tx.warnings.find((x) => /SELF-STAKE LOCKED/.test(x));
  assert.ok(w, JSON.stringify(tx.warnings));
  assert.match(w, /Self-stake locked while borrowing/);
  assert.match(w, /ordinary lenders in this pool are not locked/i);
  // The contract checks the lock BEFORE the liquidity require exactly so the real
  // reason is not masked after a full draw; the warnings must not mask it either.
  assert.ok(!tx.warnings.some((x) => /only has .* available/.test(x)), 'the lock must not be masked by the generic liquidity warning');
});

test('prepare_withdraw_liquidity: an unlocked creator is told the position is first-loss capital anyway', async () => {
  mock({ creator: AGENT, outstanding: 0n, selfStake: USDC(2500), position: USDC(2500) });
  const tx = await prepareTx(cfg, 'withdraw_liquidity', { from: AGENT, agentId: AGENT_ID, amount: 100 });
  assert.equal(tx.call.args.selfStakeLocked, 'false');
  assert.ok(tx.warnings.some((x) => /currently UNLOCKED/.test(x)));
});

test('prepare_withdraw_liquidity: an ordinary lender is never warned about the lock', async () => {
  mock({ creator: AGENT, outstanding: USDC(5000), selfStake: USDC(2500), position: USDC(1000), available: USDC(10000) });
  const tx = await prepareTx(cfg, 'withdraw_liquidity', { from: LENDER, agentId: AGENT_ID, amount: 100 });
  assert.equal(tx.call.args.selfStakeLocked, undefined);
  assert.ok(!tx.warnings.some((x) => /SELF-STAKE LOCKED/.test(x)));
});

test('prepare_withdraw_liquidity: no lock reporting on a V6.1 deployment', async () => {
  mock({ version: 'V6.1', repVersion: 'V3', creator: AGENT, outstanding: USDC(5000), position: USDC(2500) });
  const tx = await prepareTx(cfg, 'withdraw_liquidity', { from: AGENT, agentId: AGENT_ID, amount: 100 });
  assert.equal(tx.call.args.selfStakeLocked, undefined);
  assert.ok(!tx.warnings.some((x) => /SELF-STAKE/i.test(x)));
});

// ---------------------------------------------------------- prepare_supply_liquidity

test('prepare_supply_liquidity: the pool creator is EXEMPT from minSupplyAmount on V6.2', async () => {
  mock({ creator: AGENT, minSupply: USDC(10), position: 0n });
  const tx = await prepareTx(cfg, 'supply_liquidity', { from: AGENT, agentId: AGENT_ID, amount: 6.25 });
  assert.ok(!tx.warnings.some((w) => /below the minimum supply of/.test(w)), JSON.stringify(tx.warnings));
  const w = tx.warnings.find((x) => /creator of pool/.test(x));
  assert.ok(w, JSON.stringify(tx.warnings));
  assert.match(w, /will NOT revert/);
  assert.match(w, /locked while the agent borrows/);
});

test('prepare_supply_liquidity: a non-creator below the minimum is still warned', async () => {
  mock({ creator: AGENT, minSupply: USDC(10), position: 0n });
  const tx = await prepareTx(cfg, 'supply_liquidity', { from: LENDER, agentId: AGENT_ID, amount: 6.25 });
  assert.ok(tx.warnings.some((w) => /below the minimum supply of 10\.0 USDC/.test(w)), JSON.stringify(tx.warnings));
});

test('prepare_supply_liquidity: on V6.1 even the creator is held to minSupplyAmount', async () => {
  mock({ version: 'V6.1', repVersion: 'V3', creator: AGENT, minSupply: USDC(10), position: 0n });
  const tx = await prepareTx(cfg, 'supply_liquidity', { from: AGENT, agentId: AGENT_ID, amount: 6.25 });
  assert.ok(tx.warnings.some((w) => /below the minimum supply of 10\.0 USDC/.test(w)), JSON.stringify(tx.warnings));
  assert.ok(!tx.warnings.some((w) => /exempt/.test(w)));
});

// ------------------------------------------------------------ revert translation

test('explainRevert: "Insufficient self-stake" becomes an actionable instruction', () => {
  const { reason, plain } = explainRevert({ reason: 'Insufficient self-stake' });
  assert.equal(reason, 'Insufficient self-stake');
  assert.match(plain, /V7 credit model/);
  assert.match(plain, /required_self_stake/);
  assert.match(plain, /prepare_supply_liquidity/);
  assert.notEqual(plain, 'The transaction would revert: Insufficient self-stake');
});

test('explainRevert: "Self-stake locked while borrowing" explains the lock and the way out', () => {
  const { plain } = explainRevert({ reason: 'Self-stake locked while borrowing' });
  assert.match(plain, /first-loss self-stake/);
  assert.match(plain, /prepare_repay_loan/);
  assert.match(plain, /ordinary lenders in the same pool are NOT locked/i);
});

test('explainRevert: the two new reasons survive an ABI-encoded Error(string)', () => {
  for (const msg of ['Insufficient self-stake', 'Self-stake locked while borrowing']) {
    const data = '0x08c379a0' + ethers.AbiCoder.defaultAbiCoder().encode(['string'], [msg]).slice(2);
    const { reason, plain } = explainRevert({ data });
    assert.equal(reason, msg);
    assert.notEqual(plain, `The transaction would revert: ${msg}`, 'must be translated, not echoed');
  }
});

test('explainRevert: "Exceeds credit limit" now also points at the post-default lockout', () => {
  const { plain } = explainRevert({ reason: 'Exceeds credit limit' });
  assert.match(plain, /LOCKED OUT/);
  assert.match(plain, /lockedOut/);
});

test('explainRevert: "Below minimum supply" mentions the V6.2 creator exemption', () => {
  const { plain } = explainRevert({ reason: 'Below minimum supply' });
  assert.match(plain, /pool CREATOR/);
  assert.match(plain, /exempt/);
});

// ------------------------------------------------------------- the tier table

test('creditTierTable: read FROM THE CHAIN on ReputationManagerV4', async () => {
  const calls = mock({ repVersion: 'V4' });
  const t = await creditTierTable(cfg);
  assert.equal(t.source, 'chain');
  assert.equal(t.reputationVersion, 'V4');
  assert.equal(t.tiers.length, 6);
  assert.ok(calls.tierLimits >= 6, 'every tier limit must come from a contract read');
  assert.deepEqual(t.tiers.map((x) => x.creditLimitUsdc), ['1000.0', '5000.0', '10000.0', '10000.0', '2500.0', '5000.0']);
  assert.deepEqual(t.tiers.map((x) => x.collateralPercent), [100, 100, 100, 75, 0, 0]);
  assert.equal(t.maxTierLimitUsdc, '10000.0');
  // The V3 numbers this client used to hardcode must not appear anywhere.
  assert.ok(!t.tiers.some((x) => x.creditLimitUsdc === '25000.0' || x.creditLimitUsdc === '50000.0'));
  assert.match(t.note, /OWNER-SETTABLE/);
  assert.deepEqual(t.tiers.map((x) => x.name), [...TIER_NAMES]);
});

test('creditTierTable: an owner-changed tier limit is reflected, not the compiled-in default', async () => {
  mock({ repVersion: 'V4' });
  await creditTierTable(cfg); // prime the cache
  _clearTierTableCache();
  // The owner raises the top tier to the ceiling; the client must follow.
  V4_TIERS.limits[5] = USDC(10000);
  try {
    const t = await creditTierTable(cfg);
    assert.equal(t.tiers[5].creditLimitUsdc, '10000.0');
  } finally {
    V4_TIERS.limits[5] = USDC(5000);
  }
});

test('creditTierTable: V3 answers with the compiled-in constants, honestly labelled', async () => {
  mock({ version: 'V6.1', repVersion: 'V3' });
  const t = await creditTierTable(cfg);
  assert.equal(t.source, 'v3-constant');
  assert.equal(t.maxTierLimitUsdc, null, 'V3 has no MAX_TIER_LIMIT ceiling');
  assert.equal(t.tiers[4].creditLimitUsdc, '25000.0');
  assert.equal(t.tiers[5].creditLimitUsdc, '50000.0');
  assert.match(t.note, /no view to read it from/);
});

test('tierNameFor is presentation only and covers every band', () => {
  assert.deepEqual([0, 199, 200, 399, 400, 499, 500, 599, 600, 799, 800, 1000].map(tierNameFor), [
    'New', 'New', 'Low', 'Low', 'Building', 'Building', 'Fair', 'Fair', 'Good', 'Good', 'Excellent', 'Excellent',
  ]);
});

// ------------------------------------------------------------------ check_credit

test('check_credit_score: V7 credit profile carries the model and the self-stake', async () => {
  mock({ score: 800, creditLimit: USDC(5000), selfStake: USDC(2500), outstanding: USDC(1000), requiredStake: USDC(500) });
  const r = await readCredit(cfg, AGENT);
  assert.equal(r.registered, true);
  assert.equal(r.reputation.tier, 'Excellent');
  assert.equal(r.credit.creditLimitUsdc, '5000.0');
  assert.equal(r.credit.model.reputationVersion, 'V4');
  assert.equal(r.credit.model.tierLimitUsdc, '5000.0');
  assert.equal(r.credit.model.ladderLimitUsdc, '5100.0');
  assert.equal(r.credit.model.maxTierLimitUsdc, '10000.0');
  assert.equal(r.credit.model.lockedOut, false);
  assert.match(r.credit.model.explanation, /min\(tier limit/);
  assert.equal(r.selfStake.locked, true);
  assert.equal(r.selfStake.amountUsdc, '2500.0');
  assert.match(r.selfStake.note, /FIRST-LOSS/);
});

test('check_credit_score: a locked-out agent is explained, not left reading limit 0 as a bug', async () => {
  const until = BigInt(Math.floor(Date.now() / 1000) + 180 * 86400);
  mock({ lockedOut: true, lockedUntil: until, creditLimit: 0n });
  const r = await readCredit(cfg, AGENT);
  assert.equal(r.credit.creditLimitUsdc, '0.0');
  assert.equal(r.credit.model.lockedOut, true);
  assert.ok(r.credit.model.lockedUntilIso);
  assert.match(r.credit.model.explanation, /LOCKED OUT after a default/);
  assert.match(r.credit.model.explanation, /reset to 0/);
});

test('check_credit_score: V6.1/V3 deployment reports no V7 fields rather than faking them', async () => {
  mock({ version: 'V6.1', repVersion: 'V3', score: 800 });
  const r = await readCredit(cfg, AGENT);
  assert.equal(r.credit.model, null);
  assert.equal(r.selfStake, null);
  assert.equal(r.reputation.tier, 'Excellent');
});

// ---------------------------------------------------------------- registration

test('the two new tools are registered, read-only, and exposed over REST + OpenAPI', () => {
  for (const name of ['required_self_stake', 'get_self_stake']) {
    const t = TOOLS.find((x) => x.name === name);
    assert.ok(t, `${name} missing from TOOLS`);
    assert.equal(t.kind, 'read');
    assert.equal(t.rest.method, 'GET');
    assert.ok(t.inputSchema.required.includes('network'), 'network must stay explicit and required');
    assert.ok(t.inputSchema.required.includes('agentId'));
    assert.match(t.description, /V6\.2/);
    assert.match(t.description, /not supported/);
  }
  const spec = buildOpenApi();
  assert.ok(spec.paths['/v1/{network}/agents/{agentId}/required-self-stake']);
  assert.ok(spec.paths['/v1/{network}/agents/{agentId}/self-stake']);
});
