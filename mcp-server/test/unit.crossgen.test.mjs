// Cross-generation regressions (2026-09-23 cross-generation regression round).
//
// The hosted server must behave correctly against ALL THREE deployment
// generations it can be pointed at, and must never turn a transient RPC failure
// into a durable capability answer. Two failure families are covered here:
//
//  X-1  CAPABILITY POISONING (the F-R1 shape, fixed in both SDKs, still open in
//       the server). `marketplaceCapabilities` / `reputationCapabilities` used a
//       bare `try { VERSION() } catch { 'V6' }`. ethers v6 collapses a JSON-RPC
//       `-32005 rate limit exceeded` (and an HTTP 500) on `eth_call` into the
//       SAME `CALL_EXCEPTION: missing revert data` it produces for a selector the
//       contract does not implement, so ONE blip permanently downgraded a V6.2/V4
//       deployment to "V6/V3" for the life of the process — publishing the
//       v3-constant tier table (25,000 / 50,000 USDC) in place of the live
//       on-chain one (2,500 / 5,000) and refusing every self-stake view.
//
//  X-2  OLDEST-GENERATION READS. Base mainnet runs a V6 build that predates the
//       2026-08 levers and the §S5 counter: `minSupplyAmount`,
//       `bindBorrowToPoolCreator`, `minHoldForReputationReward`,
//       `activeLoanCount` and `outstandingPrincipal` are absent from its
//       bytecode, and `getActiveAgents()` is the reverting stub. Those calls sat
//       unguarded inside Promise.all, so get_protocol_status, check_credit_score,
//       get_pool_details, get_available_liquidity and get_lending_positions all
//       returned a raw 502 on Base.
//
//  X-3  LATER-ADDED METHOD PROBE. `getActiveAgents(uint256,uint256)` arrived in a
//       later V6.2 revision than the one first deployed, so the probe is correct
//       — but one transient failure used to disable it permanently, re-arming the
//       unbounded call the pagination exists to avoid.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { _setContractsForTest, marketplaceCapabilities, reputationCapabilities } from '../dist/chain.js';
import {
  readProtocolStatus, readCredit, readPoolDetails, readPools, readPositions, readAgentLoans,
  creditTierTable, _clearTierTableCache, _clearActiveAgentsProbeCache,
} from '../dist/reads.js';
import { getNetwork } from '../dist/networks.js';
import { explainRevert, prepareTx } from '../dist/prepare.js';

const NET = 'arc-staging';
const cfg = getNetwork(NET);
const AGENT = '0x800e305A0caDdE6289dFDFEDF38218f45C06F72C';
const USDC = (n) => ethers.parseUnits(String(n), 6);
const DAY = 86400n;

/** What ethers v6 throws when the deployed bytecode has no such selector. */
const noSelector = (name = 'VERSION') =>
  Object.assign(new Error(`could not decode result data (value="0x", info={ "method": "${name}" }, code=BAD_DATA)`), { code: 'BAD_DATA' });

/**
 * What ethers v6 throws when the RPC answered `eth_call` with a JSON-RPC error.
 * Verified on the live Arc endpoints 2026-09-23: a rate limit arrives as
 * `{code:-32005}` and a genuine revert as `{code:3}`, and BOTH surface as
 * `CALL_EXCEPTION` with `data: null` and `reason: null`. Only `info.error.code`
 * tells them apart.
 */
const rpcCallError = (code, message) =>
  Object.assign(new Error('missing revert data'), {
    code: 'CALL_EXCEPTION', action: 'call', data: null, reason: null, invocation: null, revert: null,
    shortMessage: 'missing revert data',
    info: { error: { code, message }, payload: { method: 'eth_call', params: [] } },
  });
const rateLimited = () => rpcCallError(-32005, 'rate limit exceeded');
const revertedNoData = () => rpcCallError(3, 'execution reverted');

/** The stub AgentLiquidityMarketplace the 2026-05 Base deploy actually is. */
function baseEraMarketplace(extra = {}) {
  const absent = (n) => async () => { throw noSelector(n); };
  return {
    VERSION: absent('VERSION'),
    LATE_INTEREST_CAP: absent('LATE_INTEREST_CAP'),
    // levers added 2026-08, after the Base deploy
    minSupplyAmount: absent('minSupplyAmount'),
    bindBorrowToPoolCreator: absent('bindBorrowToPoolCreator'),
    minHoldForReputationReward: absent('minHoldForReputationReward'),
    // §S5 counter + V6.1 views, also later
    activeLoanCount: absent('activeLoanCount'),
    outstandingPrincipal: absent('outstandingPrincipal'),
    requiredSelfStake: absent('requiredSelfStake'),
    selfStake: absent('selfStake'),
    // the reverting stub this build still carries
    'getActiveAgents()': async () => { throw Object.assign(new Error('execution reverted: "Use front-end to query specific agents"'), { code: 'CALL_EXCEPTION', reason: 'Use front-end to query specific agents', data: '0x08c379a0' }); },
    'getActiveAgents(uint256,uint256)': absent('getActiveAgents'),
    paused: async () => false,
    totalPools: async () => 4n,
    nextLoanId: async () => 15n,
    platformFeeRate: async () => 100n,
    MAX_ACTIVE_LOANS_PER_AGENT: async () => 10n,
    MAX_LENDERS_PER_POOL: async () => 50n,
    // only agentId 1 has a pool; the registry has 7 agents (as Base really does)
    agentPools: async (id) => (Number(id) === 1
      ? { agentId: 1n, agentAddress: AGENT, totalLiquidity: USDC('1.5'), availableLiquidity: USDC('1.501705'), totalLoaned: 0n, totalEarned: USDC('0.001705'), isActive: true }
      : { agentId: BigInt(id), agentAddress: ethers.ZeroAddress, totalLiquidity: 0n, availableLiquidity: 0n, totalLoaned: 0n, totalEarned: 0n, isActive: false }),
    getAgentPool: async (id) => (Number(id) === 1
      ? { agentAddress: AGENT, totalLiquidity: USDC('1.5'), availableLiquidity: USDC('1.501705'), totalLoaned: 0n, totalEarned: USDC('0.001705'), utilizationRate: 0n, lenderCount: 1n }
      : { agentAddress: ethers.ZeroAddress, totalLiquidity: 0n, availableLiquidity: 0n, totalLoaned: 0n, totalEarned: 0n, utilizationRate: 0n, lenderCount: 0n }),
    getLenderPosition: async (id) => (Number(id) === 1
      ? { amount: USDC('1.5'), earnedInterest: 0n, depositTimestamp: 0n, shareOfPool: 10000n }
      : { amount: 0n, earnedInterest: 0n, depositTimestamp: 0n, shareOfPool: 0n }),
    agentLoans: async (_a, i) => { if (Number(i) > 0) throw revertedNoData(); return 1n; },
    loans: async () => ({ loanId: 1n, borrower: AGENT, agentId: 1n, amount: USDC('0.1'), collateralAmount: USDC('0.1'), interestRate: 1500n, startTime: 1779290441n, endTime: 1779895241n, duration: 7n * DAY, state: 2n }),
    calculateInterest: async (p, r, d) => ((p * r) / 10000n * d) / (365n * DAY),
    ...extra,
  };
}

function v3Reputation() {
  return {
    VERSION: async () => { throw noSelector(); },
    'getReputationScore(address)': async () => 110n,
    calculateCreditLimit: async () => USDC(1000),
    calculateCollateralRequirement: async () => 100n,
    calculateInterestRate: async () => 1500n,
  };
}

function registryStub() {
  return {
    totalAgents: async () => 7n,
    addressToAgentId: async () => 1n,
    getAgentInfo: async () => ({ owner: AGENT, agentWallet: AGENT, agentURI: 'ipfs://agent', isActive: true, registrationTime: 1779000000n }),
  };
}

function install({ marketplace, reputation, registry = registryStub() }) {
  _setContractsForTest(NET, {
    provider: { getBlock: async () => ({ number: 1, timestamp: Math.floor(Date.now() / 1000) }) },
    marketplace, reputation, registry,
    usdc: { balanceOf: async () => USDC(10), allowance: async () => 0n },
  });
  _clearTierTableCache();
  _clearActiveAgentsProbeCache();
}

afterEach(() => {
  _setContractsForTest(NET, null);
  _clearTierTableCache();
  _clearActiveAgentsProbeCache();
});

// ---------------------------------------------------------------- X-1
test('X-1 a transient RPC failure during VERSION() is never cached as a capability answer', async () => {
  let attempts = 0;
  install({
    marketplace: {
      ...baseEraMarketplace(),
      VERSION: async () => { attempts += 1; if (attempts === 1) throw rateLimited(); return 'V6.2'; },
      requiredSelfStake: async () => 0n,
    },
    reputation: v3Reputation(),
  });

  await assert.rejects(
    () => marketplaceCapabilities(cfg),
    (e) => /unavailable|rate limit|could not determine|temporarily/i.test(e.message),
    'a rate-limited VERSION() must surface, not be answered as "V6"',
  );
  // and the failure must NOT have been memoised: the next call sees the truth
  const caps = await marketplaceCapabilities(cfg);
  assert.equal(caps.version, 'V6.2');
  assert.equal(caps.v62, true);
});

test('X-1 a transient failure on the reputation VERSION() probe never yields the v3-constant table', async () => {
  let attempts = 0;
  const V4_LIMITS = [USDC(1000), USDC(5000), USDC(10000), USDC(10000), USDC(2500), USDC(5000)];
  install({
    marketplace: { ...baseEraMarketplace(), VERSION: async () => 'V6.2', requiredSelfStake: async () => 0n },
    reputation: {
      ...v3Reputation(),
      VERSION: async () => { attempts += 1; if (attempts === 1) throw rateLimited(); return 'V4'; },
      MAX_TIER_LIMIT: async () => USDC(10000),
      tierMinScore: async (i) => [0n, 200n, 400n, 500n, 600n, 800n][Number(i)],
      tierLimits: async (i) => V4_LIMITS[Number(i)],
      tierCollateralPct: async (i) => [100n, 100n, 100n, 75n, 0n, 0n][Number(i)],
      tierInterestBps: async (i) => [1500n, 1500n, 1000n, 1000n, 700n, 500n][Number(i)],
      unsecuredTierExposure: async (i) => [0n, 0n, 0n, USDC(2500), USDC(2500), USDC(5000)][Number(i)],
    },
  });

  await assert.rejects(() => reputationCapabilities(cfg), /unavailable|rate limit|could not determine|temporarily/i);
  _clearTierTableCache();
  const table = await creditTierTable(cfg);
  assert.equal(table.source, 'chain', 'must read the live table once the RPC answers');
  assert.equal(table.tiers[5].creditLimitUsdc, '5000.0', 'the v3-constant fallback would have said 50000.0');
});

test('X-1 a genuinely absent VERSION() still resolves to the older generation', async () => {
  install({ marketplace: baseEraMarketplace(), reputation: v3Reputation() });
  const caps = await marketplaceCapabilities(cfg);
  assert.equal(caps.version, 'V6');
  assert.equal(caps.v61, false);
  assert.equal(caps.v62, false);
  const rcaps = await reputationCapabilities(cfg);
  assert.equal(rcaps.version, 'V3');
  assert.equal(rcaps.v4, false);
});

// ---------------------------------------------------------------- X-2
test('X-2 get_protocol_status works on the Base-era V6 (no levers, reverting getActiveAgents)', async () => {
  install({ marketplace: baseEraMarketplace(), reputation: v3Reputation() });
  const s = await readProtocolStatus(cfg);
  assert.equal(s.paused, false);
  assert.equal(s.totalPools, 4);
  assert.equal(s.totalLoans, 14);
  assert.equal(s.capabilities.marketplaceVersion, 'V6');
  // the levers this build predates must be reported as absent, not crash the route
  assert.equal(s.parameters.minSupplyUsdc, null);
  assert.equal(s.parameters.borrowRestrictedToPoolCreator, null);
  assert.equal(s.parameters.minHoldForReputationRewardSeconds, null);
  assert.equal(s.parameters.platformFeeBps, 100);
});

test('X-2 check_credit_score works on the Base-era V6 (no activeLoanCount / outstandingPrincipal)', async () => {
  install({ marketplace: baseEraMarketplace(), reputation: v3Reputation() });
  const c = await readCredit(cfg, AGENT);
  assert.equal(c.registered, true);
  assert.equal(c.reputation.score, 110);
  assert.equal(c.credit.creditLimitUsdc, '1000.0');
  assert.equal(c.credit.outstandingPrincipalUsdc, null);
  assert.equal(c.credit.activeLoans, null);
});

test('X-2 get_pool_details works on the Base-era V6', async () => {
  install({ marketplace: baseEraMarketplace(), reputation: v3Reputation() });
  const p = await readPoolDetails(cfg, 1);
  assert.equal(p.agentId, 1);
  assert.equal(p.totalLiquidityUsdc, '1.5');
  assert.equal(p.outstandingPrincipalUsdc, null);
  assert.equal(p.minSupplyUsdc, null);
});

test('X-2 pool + position enumeration falls back to a registry scan when getActiveAgents() is the reverting stub', async () => {
  install({ marketplace: baseEraMarketplace(), reputation: v3Reputation() });
  const pools = await readPools(cfg);
  // an empty list would read as "this protocol has no pools" — a wrong answer about TVL
  assert.equal(pools.pools.length, 1, 'the registry scan must still find the active pool');
  assert.equal(pools.pools[0].agentId, 1);
  assert.equal(pools.pools[0].totalLiquidityUsdc, '1.5');
  const pos = await readPositions(cfg, AGENT);
  assert.equal(pos.positions.length, 1);
  assert.equal(pos.positions[0].suppliedUsdc, '1.5');
});

test('X-2 enumeration says so, rather than answering "no pools", when even the registry cannot be walked', async () => {
  install({
    marketplace: baseEraMarketplace(),
    reputation: v3Reputation(),
    registry: { ...registryStub(), totalAgents: async () => { throw noSelector('totalAgents'); } },
  });
  const pools = await readPools(cfg);
  assert.equal(pools.pools.length, 0);
  assert.match(String(pools.note ?? ''), /cannot enumerate/i, 'must explain the empty list rather than 502 or imply zero pools');
});

// ---------------------------------------------------------------- X-3
test('X-3 a transient failure on the paginated getActiveAgents probe is not cached as "absent"', async () => {
  let paged = 0;
  let legacy = 0;
  install({
    marketplace: {
      ...baseEraMarketplace(),
      VERSION: async () => 'V6.2',
      requiredSelfStake: async () => 0n,
      minSupplyAmount: async () => USDC(10),
      bindBorrowToPoolCreator: async () => true,
      minHoldForReputationReward: async () => DAY,
      activeLoanCount: async () => 0n,
      outstandingPrincipal: async () => 0n,
      'getActiveAgents(uint256,uint256)': async () => { paged += 1; if (paged === 1) throw rateLimited(); return [[1n], 1n]; },
      'getActiveAgents()': async () => { legacy += 1; return [1n]; },
    },
    reputation: v3Reputation(),
  });

  await readPools(cfg).catch(() => {});
  await readPools(cfg);
  assert.ok(paged >= 2, `the paginated overload must be retried after a transient failure (tried ${paged}x)`);
});

test('X-3 a genuinely absent paginated overload falls back once and stays fallen back', async () => {
  let paged = 0;
  let legacy = 0;
  install({
    marketplace: {
      ...baseEraMarketplace(),
      VERSION: async () => 'V6.2',
      requiredSelfStake: async () => 0n,
      minSupplyAmount: async () => USDC(10),
      bindBorrowToPoolCreator: async () => true,
      minHoldForReputationReward: async () => DAY,
      activeLoanCount: async () => 0n,
      outstandingPrincipal: async () => 0n,
      'getActiveAgents(uint256,uint256)': async () => { paged += 1; throw noSelector('getActiveAgents'); },
      'getActiveAgents()': async () => { legacy += 1; return [1n]; },
    },
    reputation: v3Reputation(),
  });
  await readPools(cfg);
  await readPools(cfg);
  assert.equal(paged, 1, 'a definite "no such method" answer is remembered');
  assert.equal(legacy, 2);
});

// ---------------------------------------------------------------- X-8
//
// The same "absent selector inside an unguarded Promise.all" as X-2, but in the
// WRITE builders: prepare_supply_liquidity and prepare_request_loan both
// returned a raw 502 on Base, i.e. no agent could lend OR borrow through the
// hosted server on the oldest real-money deployment.
test('X-8 prepare_supply_liquidity works on the Base-era V6 (no minSupplyAmount)', async () => {
  install({ marketplace: baseEraMarketplace(), reputation: v3Reputation() });
  const tx = await prepareTx(cfg, 'supply_liquidity', { from: AGENT, agentId: 1, amount: '100' });
  assert.equal(tx.action, 'supply_liquidity');
  assert.ok(tx.prerequisite, 'the exact-amount approve must still be produced');
  assert.equal(tx.prerequisite.call.args.amount, USDC(100).toString());
  assert.notEqual(tx.prerequisite.call.args.amount, ethers.MaxUint256.toString());
  assert.ok(!tx.warnings.some((w) => /minimum supply/i.test(w)), 'no minimum exists on this build, so it must not be claimed');
});

test('X-8 prepare_request_loan works on the Base-era V6 (no bind / activeLoanCount / outstandingPrincipal)', async () => {
  install({ marketplace: baseEraMarketplace(), reputation: v3Reputation() });
  const tx = await prepareTx(cfg, 'request_loan', { from: AGENT, amount: '50', durationDays: 30 });
  assert.equal(tx.action, 'request_loan');
  // collateral is still priced from the chain: 50 USDC at the 100 % tier
  assert.equal(tx.call.args.collateralRequired, USDC(50).toString());
  assert.equal(tx.call.args.collateralPercent, '100');
  assert.equal(tx.prerequisite.call.args.amount, USDC(50).toString());
  assert.notEqual(tx.prerequisite.call.args.amount, ethers.MaxUint256.toString());
  // over the limit is still caught, with an honest caveat about what is missing
  const over = await prepareTx(cfg, 'request_loan', { from: AGENT, amount: '5000', durationDays: 30 });
  assert.ok(over.warnings.some((w) => /exceeds the credit limit/i.test(w)));
  assert.ok(over.warnings.some((w) => /does not expose outstandingPrincipal/i.test(w)));
});

// ---------------------------------------------------------------- X-10/X-11
test('X-10 the V6.2 withdraw-side minimum is not explained with supply-side advice', () => {
  const withdrawSide = explainRevert(Object.assign(new Error('execution reverted: "Remaining below minimum supply"'), { reason: 'Remaining below minimum supply' }));
  assert.match(withdrawSide.plain, /withdraw your position in FULL|at least the minimum remains/i);
  assert.doesNotMatch(withdrawSide.plain, /CREATOR supplying into its own pool is exempt/i);

  const supplySide = explainRevert(Object.assign(new Error('execution reverted: "Below minimum supply"'), { reason: 'Below minimum supply' }));
  assert.match(supplySide.plain, /minimum supply/i);
  assert.match(supplySide.plain, /CREATOR/i);
});

test('X-10 the reserved last lender slot is a distinct refusal, not a generic capacity error', () => {
  const r = explainRevert(Object.assign(new Error('execution reverted: "Last slot reserved for agent self-stake"'), { reason: 'Last slot reserved for agent self-stake' }));
  assert.match(r.plain, /reserved for the agent's OWN first-loss self-stake/i);
  assert.doesNotMatch(r.plain, /maximum number of lenders/i);
});

test('X-11 an ERC-721 receiver rejection during register_agent is explained', () => {
  // AgentRegistryV2.register() _safeMints; an EIP-7702-delegated EOA reverts here.
  const data = new ethers.Interface(['error ERC721InvalidReceiver(address receiver)'])
    .encodeErrorResult('ERC721InvalidReceiver', [AGENT]);
  const r = explainRevert(Object.assign(new Error('execution reverted (unknown custom error)'), { code: 'CALL_EXCEPTION', data }));
  assert.match(r.reason, /ERC721InvalidReceiver/);
  assert.match(r.plain, /delegation|plain EOA/i);
});

// ---------------------------------------------------------------- X-4
test('X-4 the agentLoans walk stops at the end of the array but never on a rate limit', async () => {
  // genuine end of array -> a complete list
  install({ marketplace: baseEraMarketplace(), reputation: v3Reputation() });
  const ok = await readAgentLoans(cfg, AGENT);
  assert.equal(ok.totalLoans, 1);

  // transient failure at index 1 -> must NOT be reported as "one loan"
  install({
    marketplace: {
      ...baseEraMarketplace(),
      agentLoans: async (_a, i) => { if (Number(i) === 1) throw rateLimited(); if (Number(i) > 1) throw revertedNoData(); return BigInt(Number(i) + 1); },
    },
    reputation: v3Reputation(),
  });
  await assert.rejects(() => readAgentLoans(cfg, AGENT), /rate limit|unavailable|enumerat|temporarily/i,
    'a truncated loan list must never be presented as complete');
});
