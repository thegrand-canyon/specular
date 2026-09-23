/**
 * READ tools: executed server-side against the public RPC of the requested
 * network. Every result carries `rpc` (block number / age / stale flag).
 */
import { ethers } from 'ethers';
import { describeRpcError, getContracts, isTransientRpcFailure, marketplaceCapabilities, reputationCapabilities, rpcStatus, RpcStatus, unsupportedMessage } from './chain.js';
import { NetworkConfig, publicNetworkInfo } from './networks.js';
import { formatUsdc, UnsupportedOnDeploymentError, ValidationError } from './validate.js';

export const LOAN_STATES = ['REQUESTED', 'ACTIVE', 'REPAID', 'DEFAULTED'] as const;

/**
 * [X-2 2026-09-23] A view that the OLDEST deployed generation may not have.
 *
 * Base mainnet runs a V6 build from 2026-05 that predates the 2026-08 launch
 * levers (`minSupplyAmount`, `bindBorrowToPoolCreator`,
 * `minHoldForReputationReward`) and the §S5 counters (`activeLoanCount`,
 * `outstandingPrincipal`). Those calls sat unguarded inside `Promise.all`, so
 * five read routes returned a raw 502 "missing revert data" on Base.
 *
 * `null` means "this deployment does not expose that" — it is NEVER used to
 * paper over a transient RPC failure, which is rethrown so the caller sees 503
 * rather than a fabricated answer.
 */
async function optionalView<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (isTransientRpcFailure(e)) throw e;
    return null;
  }
}

const numOrNull = (x: bigint | null): number | null => (x === null ? null : Number(x));
const usdcOrNull = (x: bigint | null): string | null => (x === null ? null : formatUsdc(x));

// ---------------------------------------------------------------------------
// Repayment quote (V6.1 previewRepayment with V6 fallback)
// ---------------------------------------------------------------------------

/** Mirrors the contract's calculateInterest() exactly (divide-before-multiply), in seconds. */
export function interestForSeconds(principal: bigint, rateBps: bigint, seconds: bigint): bigint {
  const annual = (principal * rateBps) / 10000n;
  return (annual * seconds) / BigInt(365 * 86400);
}

export interface RepaymentQuote {
  principal: bigint;
  interest: bigint;
  /** exactly what repayLoan() pulls at the block the quote was evaluated in */
  total: bigint;
  chargeableSeconds: bigint;
  lateSeconds: bigint;
  durationSeconds: bigint;
  interestRateBps: bigint;
  /** 'previewRepayment' on V6.1, 'calculateInterest' (nominal fixed term — what V6 charges) on V6 */
  source: 'previewRepayment' | 'calculateInterest';
  /** true when the amount grows per second (late AND under the cap on V6.1) */
  accruing: boolean;
  /** the most repayLoan() could ever pull (principal + interest at duration + LATE_INTEREST_CAP); equals total on V6 */
  maxTotal: bigint;
}

/**
 * Quote for an ACTIVE loan `l` (the loans() tuple). On V6.1 uses previewRepayment
 * (late loans pay for elapsed time, capped at duration + LATE_INTEREST_CAP); on V6
 * the nominal fixed-term figure, which is what V6 actually charges.
 */
export async function repaymentQuote(cfg: NetworkConfig, l: any, loanId: number): Promise<RepaymentQuote> {
  const c = getContracts(cfg);
  const caps = await marketplaceCapabilities(cfg);
  const principal = l.amount as bigint;
  const rateBps = l.interestRate as bigint;
  const duration = l.duration as bigint;
  if (caps.v61) {
    const pv = await c.marketplace.previewRepayment(loanId);
    const cap = BigInt(caps.lateInterestCapSeconds ?? 30 * 86400);
    const maxChargeable = duration + cap;
    const chargeable = pv.chargeableSeconds as bigint;
    return {
      principal,
      interest: pv.interest as bigint,
      total: pv.total as bigint,
      chargeableSeconds: chargeable,
      lateSeconds: pv.lateSeconds as bigint,
      durationSeconds: duration,
      interestRateBps: rateBps,
      source: 'previewRepayment',
      accruing: (pv.lateSeconds as bigint) > 0n && chargeable < maxChargeable,
      maxTotal: principal + interestForSeconds(principal, rateBps, maxChargeable),
    };
  }
  const interest = (await c.marketplace.calculateInterest(principal, rateBps, duration)) as bigint;
  return {
    principal,
    interest,
    total: principal + interest,
    chargeableSeconds: duration,
    lateSeconds: 0n,
    durationSeconds: duration,
    interestRateBps: rateBps,
    source: 'calculateInterest',
    accruing: false,
    maxTotal: principal + interest,
  };
}

/** JSON view of a quote (display units). */
export function formatQuote(q: RepaymentQuote) {
  const late = q.lateSeconds > 0n;
  return {
    principalUsdc: formatUsdc(q.principal),
    interestUsdc: formatUsdc(q.interest),
    totalRepaymentUsdc: formatUsdc(q.total),
    chargeableDays: Number(q.chargeableSeconds) / 86400,
    lateSeconds: Number(q.lateSeconds),
    late,
    accruing: q.accruing,
    maxTotalRepaymentUsdc: formatUsdc(q.maxTotal),
    source: q.source,
    note:
      q.source === 'calculateInterest'
        ? 'V6 deployment: interest is fixed for the full term (not pro-rated, no late charge). Approve exactly totalRepaymentUsdc to the marketplace before repayLoan.'
        : late
          ? q.accruing
            ? 'LATE: interest is charged per second on the elapsed time until it caps at duration + 30 days. totalRepaymentUsdc grows until the repay is mined, so approve a little more (prepare_repay_loan adds bounded headroom, never more than maxTotalRepaymentUsdc).'
            : 'LATE and at the cap (duration + 30 days): the amount is now constant. Approve exactly totalRepaymentUsdc.'
          : 'Interest is fixed for the full term when repaid on time. Approve exactly totalRepaymentUsdc to the marketplace before repayLoan.',
  };
}

// ---------------------------------------------------------------------------
// Credit tiers
//
// THE TIER TABLE IS NOT A CLIENT-SIDE CONSTANT. On ReputationManagerV4 (V7) it
// is on-chain, owner-settable state bounded by the immutable MAX_TIER_LIMIT, so
// every limit / collateral % / APR below is READ FROM THE CONTRACT. The only
// thing this module still owns is the human-readable NAME of each tier index,
// which is presentation, not protocol.
//
// On ReputationManagerV3 there is no view to read the table from (it is compiled
// into the contract), so the historic constants are returned and explicitly
// flagged `source: 'v3-constant'` rather than being passed off as chain data.
// ---------------------------------------------------------------------------

/** Presentation labels for tier indices 0..5. Not protocol values. */
export const TIER_NAMES = ['New', 'Low', 'Building', 'Fair', 'Good', 'Excellent'] as const;

/** Tier boundaries, identical in V3 and V4 (set at construction, no setter). */
export const TIER_MIN_SCORE = [0, 200, 400, 500, 600, 800] as const;

/** The table ReputationManagerV3 compiles in. Used ONLY when the deployment is V3. */
const V3_TIERS = [
  { limit: 1_000_000000n, collateralPercent: 100, interestRateBps: 1500 },
  { limit: 5_000_000000n, collateralPercent: 100, interestRateBps: 1500 },
  { limit: 10_000_000000n, collateralPercent: 100, interestRateBps: 1000 },
  { limit: 10_000_000000n, collateralPercent: 25, interestRateBps: 1000 },
  { limit: 25_000_000000n, collateralPercent: 0, interestRateBps: 700 },
  { limit: 50_000_000000n, collateralPercent: 0, interestRateBps: 500 },
];

export function tierIndexFor(score: number): number {
  for (let i = TIER_MIN_SCORE.length - 1; i >= 0; i--) if (score >= TIER_MIN_SCORE[i]) return i;
  return 0;
}

/** Human-readable tier name for a score. The limit/collateral/APR always come from the chain. */
export function tierNameFor(score: number): string {
  return TIER_NAMES[tierIndexFor(score)];
}

export interface CreditTierRow {
  index: number;
  name: string;
  minScore: number;
  creditLimitUsdc: string;
  collateralPercent: number;
  interestRateBps: number;
  interestRateAprPercent: number;
  /** creditLimit * (100 - collateral%) / 100 — the figure MAX_TIER_LIMIT bounds. */
  unsecuredExposureUsdc: string;
}

export interface CreditTierTable {
  /** 'chain' on ReputationManagerV4 (mutable, owner-settable). 'v3-constant' otherwise. */
  source: 'chain' | 'v3-constant';
  reputationVersion: string;
  /** Immutable ceiling on any tier limit; null on V3, which has no such bound. */
  maxTierLimitUsdc: string | null;
  tiers: CreditTierRow[];
  note: string;
}

/**
 * Per-network tier-table cache. The table is owner-settable, so it is NOT
 * cached for the life of the process like a capability is — but it changes
 * roughly never, and re-reading 13 views on every credit check would undo the
 * RPC-budget work of the 2026-09-22 resilience round.
 */
const tierTableCache = new Map<string, { at: number; value: CreditTierTable }>();
const tierTableTtlMs = (): number => {
  const n = Number(process.env.SPECULAR_TIER_TABLE_CACHE_MS ?? 60_000);
  return Number.isFinite(n) && n >= 0 ? n : 60_000;
};

/** Test/ops hook: forget cached tier tables. */
export function _clearTierTableCache(): void {
  tierTableCache.clear();
}

/** The credit tier table for a network, read from the contract wherever it is readable. */
export async function creditTierTable(cfg: NetworkConfig): Promise<CreditTierTable> {
  const hit = tierTableCache.get(cfg.name);
  if (hit && Date.now() - hit.at < tierTableTtlMs()) return hit.value;
  const c = getContracts(cfg);
  const rcaps = await reputationCapabilities(cfg);
  let value: CreditTierTable;
  if (!rcaps.v4) {
    value = {
      source: 'v3-constant',
      reputationVersion: rcaps.version,
      maxTierLimitUsdc: null,
      tiers: V3_TIERS.map((t, i) => ({
        index: i,
        name: TIER_NAMES[i],
        minScore: TIER_MIN_SCORE[i],
        creditLimitUsdc: formatUsdc(t.limit),
        collateralPercent: t.collateralPercent,
        interestRateBps: t.interestRateBps,
        interestRateAprPercent: t.interestRateBps / 100,
        unsecuredExposureUsdc: formatUsdc((t.limit * BigInt(100 - t.collateralPercent)) / 100n),
      })),
      note:
        'ReputationManagerV3 compiles the tier table into the contract; there is no view to read it from, so these are the known constants for that build. An agent\'s ACTUAL limit is always calculateCreditLimit(address).',
    };
  } else {
    // One TIER at a time (5 concurrent calls per round), not all 31 at once:
    // this route already fans out ~27 eth_calls, and a 31-call spike on a cold
    // cache is the shape that gets batch-refused or rate-limited upstream. The
    // whole table is cached for `SPECULAR_TIER_TABLE_CACHE_MS`, so the extra
    // round-trips are paid roughly once a minute, not per request.
    const maxTierLimit = (await c.reputation.MAX_TIER_LIMIT()) as bigint;
    const tiers: CreditTierRow[] = [];
    for (let i = 0; i < 6; i++) {
      const [minScore, limit, coll, rate, unsecured] = (await Promise.all([
        c.reputation.tierMinScore(i),
        c.reputation.tierLimits(i),
        c.reputation.tierCollateralPct(i),
        c.reputation.tierInterestBps(i),
        c.reputation.unsecuredTierExposure(i),
      ])) as bigint[];
      tiers.push({
        index: i,
        name: TIER_NAMES[i],
        minScore: Number(minScore),
        creditLimitUsdc: formatUsdc(limit),
        collateralPercent: Number(coll),
        interestRateBps: Number(rate),
        interestRateAprPercent: Number(rate) / 100,
        unsecuredExposureUsdc: formatUsdc(unsecured),
      });
    }
    value = {
      source: 'chain',
      reputationVersion: rcaps.version,
      maxTierLimitUsdc: formatUsdc(maxTierLimit),
      tiers,
      note:
        'Read live from ReputationManagerV4. These limits are OWNER-SETTABLE and every entry is bounded by MAX_TIER_LIMIT (an immutable constant) — do not cache them in client code. An agent\'s actual limit is min(tier limit, credit ladder) and 0 during a post-default lockout.',
    };
  }
  tierTableCache.set(cfg.name, { at: Date.now(), value });
  return value;
}

const MAX_LIST = 200;

/**
 * Active agent/pool ids, bounded at the CHAIN call.
 *
 * The zero-arg `getActiveAgents()` returns the whole array and the scale round measured
 * it becoming uncallable past roughly 5,472 pools — an `eth_call` gas failure, so every
 * caller here (protocol status, pool list, positions) would have started returning errors
 * rather than degraded results. Slicing afterwards, which is what these call sites used to
 * do, does not help: the array is already built before it reaches us.
 *
 * V6.2 added a paginated overload. Use it when present and fall back to the legacy call on
 * V6/V6.1 deployments, where the pool counts are small and the ceiling is not reachable.
 * `total` lets callers say honestly that a result was truncated.
 */
const paginatedActiveAgents = new Map<string, boolean>();

/** Test/ops hook: forget which deployments were found to have the paginated overload. */
export function _clearActiveAgentsProbeCache(): void {
  paginatedActiveAgents.clear();
}

/**
 * Some deployments cannot enumerate their pools at all: the 2026-05 Base build
 * still carries the reverting `getActiveAgents()` stub ("Use front-end to query
 * specific agents"). That is a property of the deployment, not an outage, so the
 * routes that enumerate report an explained empty list instead of a 502.
 */
export class PoolEnumerationUnavailable extends Error {}

async function activeAgentIds(
  c: ReturnType<typeof getContracts>,
  cfg: NetworkConfig,
  limit = MAX_LIST,
): Promise<{ ids: bigint[]; total: number; truncated: boolean }> {
  // Probe for the METHOD, not for a version flag. Pagination arrived in a later V6.2
  // revision than the one first deployed to Arc staging, so `caps.v62` does NOT imply it
  // — assuming it did made every read on that deployment fail with a 502. Try the
  // paginated overload once per network and remember the answer.
  //
  // [X-3 2026-09-23] Only a DEFINITE "no such method" may be remembered. One
  // transient RPC error used to pin `false` for the life of the process, which
  // silently re-armed the unbounded call this pagination exists to avoid
  // (uncallable past ~5,472 pools) and dropped the honest `truncated` report.
  if (paginatedActiveAgents.get(cfg.name) !== false) {
    try {
      const [ids, total] = (await c.marketplace['getActiveAgents(uint256,uint256)'](0, limit)) as [bigint[], bigint];
      paginatedActiveAgents.set(cfg.name, true);
      return { ids, total: Number(total), truncated: Number(total) > ids.length };
    } catch (e) {
      if (isTransientRpcFailure(e)) throw e;
      paginatedActiveAgents.set(cfg.name, false);
    }
  }
  try {
    const all = (await c.marketplace['getActiveAgents()']()) as bigint[];
    return { ids: all.slice(0, limit), total: all.length, truncated: all.length > limit };
  } catch (e) {
    if (isTransientRpcFailure(e)) throw e;
    // [X-2] The 2026-05 Base build still carries the reverting stub
    // ("Use front-end to query specific agents") that D12 replaced in 2026-08.
    // Pools are keyed by agentId, so walk the registry instead — bounded by
    // MAX_LIST and honest about truncation. An empty list would read as
    // "this protocol has no pools", which is a wrong answer about TVL.
    return registryScanActiveAgents(c, cfg, limit);
  }
}

/**
 * Enumerate pools by scanning agentIds 1..totalAgents. The fallback for a
 * deployment whose `getActiveAgents()` does not answer. Bounded, and reported as
 * truncated when the registry is larger than the scan window.
 */
async function registryScanActiveAgents(
  c: ReturnType<typeof getContracts>,
  cfg: NetworkConfig,
  limit: number,
): Promise<{ ids: bigint[]; total: number; truncated: boolean }> {
  let totalAgents: number;
  try {
    totalAgents = Number((await c.registry.totalAgents()) as bigint);
  } catch (e) {
    if (isTransientRpcFailure(e)) throw e;
    throw new PoolEnumerationUnavailable(
      `The ${cfg.name} marketplace ${cfg.addresses.marketplace} cannot enumerate its pools: getActiveAgents() ` +
      'does not answer on this deployment and the registry could not be walked either. Query a specific ' +
      'agentId instead — get_pool_details works.',
    );
  }
  const scan = Math.min(totalAgents, MAX_LIST);
  const ids: bigint[] = [];
  const pools = await Promise.all(
    Array.from({ length: scan }, (_, k) => c.marketplace.agentPools(BigInt(k + 1))),
  );
  pools.forEach((p, k) => {
    if (p.isActive) ids.push(BigInt(k + 1));
  });
  return { ids: ids.slice(0, limit), total: ids.length, truncated: totalAgents > scan || ids.length > limit };
}

/** Empty-but-explained result for a deployment that cannot enumerate pools. */
async function noEnumeration<T extends Record<string, unknown>>(
  cfg: NetworkConfig,
  e: unknown,
  rest: T,
): Promise<T & { note: string; rpc: RpcStatus }> {
  if (!(e instanceof PoolEnumerationUnavailable)) throw e;
  return { ...rest, note: e.message, rpc: await rpcStatus(cfg) };
}

export async function readNetworkInfo(cfg: NetworkConfig) {
  const rpc = await rpcStatus(cfg);
  return { ...publicNetworkInfo(cfg), rpc };
}

export async function readProtocolStatus(cfg: NetworkConfig) {
  const c = getContracts(cfg);
  const [mcaps, rcaps, tierTable] = await Promise.all([
    marketplaceCapabilities(cfg).catch(() => null),
    reputationCapabilities(cfg).catch(() => null),
    creditTierTable(cfg).catch(() => null),
  ]);
  // [X-2] The levers and the §S5 counters arrived in 2026-08, AFTER the Base
  // deploy. `optionalView` reports them as null on a deployment that predates
  // them instead of failing the whole route with "missing revert data".
  const [rpc, paused, totalPools, nextLoanId, totalAgents, minSupply, bind, minHold, feeRate, maxActive, activeAgents] = await Promise.all([
    rpcStatus(cfg),
    c.marketplace.paused() as Promise<boolean>,
    c.marketplace.totalPools() as Promise<bigint>,
    c.marketplace.nextLoanId() as Promise<bigint>,
    c.registry.totalAgents() as Promise<bigint>,
    optionalView(c.marketplace.minSupplyAmount() as Promise<bigint>),
    optionalView(c.marketplace.bindBorrowToPoolCreator() as Promise<boolean>),
    optionalView(c.marketplace.minHoldForReputationReward() as Promise<bigint>),
    optionalView(c.marketplace.platformFeeRate() as Promise<bigint>),
    optionalView(c.marketplace.MAX_ACTIVE_LOANS_PER_AGENT() as Promise<bigint>),
    activeAgentIds(c, cfg).catch((e) => {
      if (e instanceof PoolEnumerationUnavailable) return { ids: [] as bigint[], total: 0, truncated: false, note: e.message };
      throw e;
    }),
  ]);

  // TVL = sum of pool totalLiquidity across active pools (bounded walk).
  let tvl = 0n;
  let available = 0n;
  let loaned = 0n;
  const ids = activeAgents.ids;
  const pools = await Promise.all(ids.map((id) => c.marketplace.agentPools(id)));
  for (const p of pools) {
    tvl += p.totalLiquidity as bigint;
    available += p.availableLiquidity as bigint;
    loaned += p.totalLoaned as bigint;
  }
  const enumerationNote = (activeAgents as { note?: string }).note;
  return {
    network: cfg.name,
    label: cfg.label,
    realMoney: cfg.realMoney,
    chainId: cfg.chainId,
    marketplace: cfg.addresses.marketplace,
    paused,
    totalPools: Number(totalPools),
    activePools: activeAgents.total,
    totalLoans: Number(nextLoanId) - 1,
    totalAgents: Number(totalAgents),
    tvlUsdc: formatUsdc(tvl),
    availableLiquidityUsdc: formatUsdc(available),
    totalLoanedUsdc: formatUsdc(loaned),
    capabilities: mcaps
      ? {
          marketplaceVersion: mcaps.version,
          reputationVersion: rcaps?.version ?? null,
          /** previewRepayment / canTopUp / getActiveLoanIds / elapsed-time late interest. */
          v61: mcaps.v61,
          /** V7: requiredSelfStake / selfStake, first-loss lock, creator exempt from minSupplyAmount. */
          v62: mcaps.v62,
          /** V7: tier table is on-chain and owner-settable; credit ladder + post-default lockout. */
          reputationV4: rcaps?.v4 ?? false,
        }
      : null,
    parameters: {
      // null == "this deployment predates that lever", never "the RPC failed".
      minSupplyUsdc: usdcOrNull(minSupply),
      minSupplyAppliesToPoolCreator: minSupply === null ? null : mcaps ? !mcaps.v62 : true,
      borrowRestrictedToPoolCreator: bind,
      minHoldForReputationRewardSeconds: numOrNull(minHold),
      platformFeeBps: numOrNull(feeRate),
      maxActiveLoansPerAgent: numOrNull(maxActive),
      loanDurationDays: { min: 7, max: 365 },
    },
    /**
     * The credit tier table. On ReputationManagerV4 this is LIVE, owner-settable
     * on-chain state — clients must read it from here (or from the contract) and
     * must not carry a hardcoded copy.
     */
    creditTiers: tierTable,
    truncated: activeAgents.truncated ? `TVL computed over the first ${ids.length} of ${activeAgents.total} pools` : undefined,
    note: enumerationNote ? `${enumerationNote} TVL/availableLiquidity/totalLoaned above are therefore 0 — they are not a claim that the pools are empty.` : undefined,
    rpc,
  };
}

export async function readCredit(cfg: NetworkConfig, address: string) {
  const c = getContracts(cfg);
  const [rpc, agentIdRaw, usdcBalance, allowance] = await Promise.all([
    rpcStatus(cfg),
    c.registry.addressToAgentId(address) as Promise<bigint>,
    c.usdc.balanceOf(address) as Promise<bigint>,
    c.usdc.allowance(address, cfg.addresses.marketplace) as Promise<bigint>,
  ]);
  const wallet = {
    usdcBalance: formatUsdc(usdcBalance),
    usdcAllowanceToMarketplace: formatUsdc(allowance),
  };
  if (agentIdRaw === 0n) {
    return {
      network: cfg.name,
      address,
      registered: false,
      wallet,
      nextStep: 'Use prepare_register_agent to get an unsigned registration transaction, sign it with this wallet, then prepare_create_pool.',
      rpc,
    };
  }
  const agentId = Number(agentIdRaw);
  const [info, score, limit, collateralPct, rateBps, pool, activeLoans, outstanding, maxActive] = await Promise.all([
    c.registry.getAgentInfo(address),
    c.reputation['getReputationScore(address)'](address) as Promise<bigint>,
    c.reputation.calculateCreditLimit(address) as Promise<bigint>,
    c.reputation.calculateCollateralRequirement(address) as Promise<bigint>,
    c.reputation.calculateInterestRate(address) as Promise<bigint>,
    c.marketplace.agentPools(agentId),
    // [X-2] absent on the 2026-05 Base build (§S5 counters landed 2026-08)
    optionalView(c.marketplace.activeLoanCount(agentId) as Promise<bigint>),
    optionalView(c.marketplace.outstandingPrincipal(agentId) as Promise<bigint>),
    optionalView(c.marketplace.MAX_ACTIVE_LOANS_PER_AGENT() as Promise<bigint>),
  ]);
  const s = Number(score);
  const remaining = (limit as bigint) - (outstanding ?? 0n);

  // [V7] Everything below the tier NAME is chain data. On ReputationManagerV4 the
  // ladder / lockout state explains WHY the limit is what it is (a post-default
  // agent reads creditLimit 0, which otherwise looks like a bug), and on a V6.2
  // marketplace the agent's own first-loss stake is part of its credit picture.
  const [mcaps, rcaps] = await Promise.all([
    marketplaceCapabilities(cfg).catch(() => null),
    reputationCapabilities(cfg).catch(() => null),
  ]);
  let creditModel: Record<string, unknown> | null = null;
  let selfStake: Record<string, unknown> | null = null;
  if (rcaps?.v4) {
    const [tierIdx, tierLimit, ladder, maxRepaid, lockedOut, lockedUntil, maxTierLimit] = await Promise.all([
      c.reputation.tierOf(score) as Promise<bigint>,
      c.reputation.tierLimit(score) as Promise<bigint>,
      c.reputation.ladderLimit(agentId) as Promise<bigint>,
      c.reputation.maxRepaidPrincipal(agentId) as Promise<bigint>,
      c.reputation.isLockedOut(agentId) as Promise<boolean>,
      c.reputation.lockedUntil(agentId) as Promise<bigint>,
      c.reputation.MAX_TIER_LIMIT() as Promise<bigint>,
    ]);
    creditModel = {
      reputationVersion: rcaps.version,
      tierIndex: Number(tierIdx),
      tierLimitUsdc: formatUsdc(tierLimit),
      ladderLimitUsdc: formatUsdc(ladder),
      maxRepaidPrincipalUsdc: formatUsdc(maxRepaid),
      maxTierLimitUsdc: formatUsdc(maxTierLimit),
      lockedOut: Boolean(lockedOut),
      lockedUntil: Number(lockedUntil),
      lockedUntilIso: Number(lockedUntil) ? new Date(Number(lockedUntil) * 1000).toISOString() : null,
      explanation: lockedOut
        ? `Credit limit is 0 because agent #${agentId} is LOCKED OUT after a default until ${new Date(Number(lockedUntil) * 1000).toISOString()}. Its ladder capacity (maxRepaidPrincipal) was reset to 0 as well, so the climb restarts from the bootstrap limit when the lockout ends.`
        : `Credit limit = min(tier limit ${formatUsdc(tierLimit)}, ladder limit ${formatUsdc(ladder)}) USDC. The ladder is creditMultiple x the largest single on-time-repaid loan (${formatUsdc(maxRepaid)} USDC) + growthStep, floored at the bootstrap limit. No tier may ever exceed ${formatUsdc(maxTierLimit)} USDC (MAX_TIER_LIMIT, an immutable constant).`,
    };
  }
  if (mcaps?.v62 && pool.isActive) {
    try {
      const [st, required] = await Promise.all([
        c.marketplace.selfStake(agentId),
        c.marketplace.requiredSelfStake(agentId, 0n) as Promise<bigint>,
      ]);
      const amount = st.amount as bigint;
      const shortfall = required > amount ? required - amount : 0n;
      selfStake = {
        marketplaceVersion: mcaps.version,
        amountUsdc: formatUsdc(amount),
        locked: Boolean(st.locked),
        requiredForCurrentExposureUsdc: formatUsdc(required),
        shortfallUsdc: formatUsdc(shortfall),
        note: st.locked
          ? 'This position is the agent\'s FIRST-LOSS capital and is locked while it carries outstanding principal: withdrawLiquidity would revert "Self-stake locked while borrowing", and it is seized before any third-party lender on a default.'
          : 'The agent holds no outstanding principal, so its first-loss position is currently withdrawable.',
      };
    } catch {
      selfStake = null; // advisory; never fail a credit read on it
    }
  }

  return {
    network: cfg.name,
    address,
    registered: true,
    agentId,
    owner: info.owner,
    agentWallet: info.agentWallet,
    agentURI: info.agentURI,
    isActive: info.isActive,
    registrationTime: Number(info.registrationTime),
    reputation: { score: s, tier: tierNameFor(s), max: 1000 },
    credit: {
      creditLimitUsdc: formatUsdc(limit),
      // null on a deployment without the O(1) counters (Base's 2026-05 V6):
      // "not reported here", not "zero".
      outstandingPrincipalUsdc: usdcOrNull(outstanding),
      remainingCreditUsdc: outstanding === null ? null : formatUsdc(remaining < 0n ? 0n : remaining),
      collateralPercent: Number(collateralPct),
      interestRateBps: Number(rateBps),
      interestRateAprPercent: Number(rateBps) / 100,
      activeLoans: numOrNull(activeLoans),
      maxActiveLoans: numOrNull(maxActive),
      canBorrow: activeLoans === null || maxActive === null || outstanding === null
        ? null
        : Number(activeLoans) < Number(maxActive) && remaining > 0n,
      /** V7 only (ReputationManagerV4): why the limit is what it is. null on V3. */
      model: creditModel,
    },
    /** V7 only (marketplace V6.2): the agent's own first-loss stake. null otherwise. */
    selfStake,
    pool: pool.isActive
      ? {
          agentId,
          totalLiquidityUsdc: formatUsdc(pool.totalLiquidity),
          availableLiquidityUsdc: formatUsdc(pool.availableLiquidity),
          totalLoanedUsdc: formatUsdc(pool.totalLoaned),
        }
      : null,
    wallet,
    rpc,
  };
}

export interface PoolSummary {
  agentId: number;
  agentAddress: string;
  totalLiquidityUsdc: string;
  availableLiquidityUsdc: string;
  totalLoanedUsdc: string;
  totalEarnedUsdc: string;
  utilizationPercent: number;
  lenderCount: number;
}

async function poolSummary(c: ReturnType<typeof getContracts>, agentId: number): Promise<PoolSummary | null> {
  const p = await c.marketplace.getAgentPool(agentId);
  if (p.agentAddress === ethers.ZeroAddress) return null;
  return {
    agentId,
    agentAddress: p.agentAddress,
    totalLiquidityUsdc: formatUsdc(p.totalLiquidity),
    availableLiquidityUsdc: formatUsdc(p.availableLiquidity),
    totalLoanedUsdc: formatUsdc(p.totalLoaned),
    totalEarnedUsdc: formatUsdc(p.totalEarned),
    utilizationPercent: Number(p.utilizationRate) / 100,
    lenderCount: Number(p.lenderCount),
  };
}

export async function readPools(cfg: NetworkConfig, opts: { minAvailableUsdc?: number; limit?: number } = {}) {
  const c = getContracts(cfg);
  let rpc: RpcStatus;
  let active: { ids: bigint[]; total: number; truncated: boolean };
  try {
    [rpc, active] = await Promise.all([rpcStatus(cfg), activeAgentIds(c, cfg)]);
  } catch (e) {
    // [X-2] the 2026-05 Base build cannot enumerate: say so, don't 502.
    return noEnumeration(cfg, e, { network: cfg.name, totalActivePools: 0, returned: 0, pools: [] as PoolSummary[] });
  }
  const ids = active.ids;
  const limit = Math.min(opts.limit ?? 50, MAX_LIST);
  const minBase = opts.minAvailableUsdc !== undefined ? ethers.parseUnits(opts.minAvailableUsdc.toString(), 6) : 0n;
  const all = await Promise.all(ids.slice(0, MAX_LIST).map((id) => poolSummary(c, Number(id))));
  const pools = all
    .filter((p): p is PoolSummary => p !== null && ethers.parseUnits(p.availableLiquidityUsdc, 6) >= minBase)
    .sort((a, b) => Number(ethers.parseUnits(b.availableLiquidityUsdc, 6) - ethers.parseUnits(a.availableLiquidityUsdc, 6)))
    .slice(0, limit);
  return { network: cfg.name, totalActivePools: ids.length, returned: pools.length, pools, rpc };
}

export async function readPoolDetails(cfg: NetworkConfig, agentId: number) {
  const c = getContracts(cfg);
  const [rpc, summary, raw, activeLoans, outstanding, minSupply, lenderCap] = await Promise.all([
    rpcStatus(cfg),
    poolSummary(c, agentId),
    c.marketplace.agentPools(agentId),
    // [X-2] absent on the 2026-05 Base build
    optionalView(c.marketplace.activeLoanCount(agentId) as Promise<bigint>),
    optionalView(c.marketplace.outstandingPrincipal(agentId) as Promise<bigint>),
    optionalView(c.marketplace.minSupplyAmount() as Promise<bigint>),
    optionalView(c.marketplace.MAX_LENDERS_PER_POOL() as Promise<bigint>),
  ]);
  if (!summary || !raw.isActive) {
    throw new ValidationError(`No active pool for agentId ${agentId} on ${cfg.name}`, 'agentId');
  }
  const [score, rateBps, collateralPct] = await Promise.all([
    c.reputation['getReputationScore(address)'](summary.agentAddress) as Promise<bigint>,
    c.reputation.calculateInterestRate(summary.agentAddress) as Promise<bigint>,
    c.reputation.calculateCollateralRequirement(summary.agentAddress) as Promise<bigint>,
  ]);
  const s = Number(score);
  return {
    network: cfg.name,
    ...summary,
    isActive: raw.isActive,
    activeLoans: numOrNull(activeLoans),
    outstandingPrincipalUsdc: usdcOrNull(outstanding),
    borrower: {
      reputationScore: s,
      tier: tierNameFor(s),
      interestRateAprPercent: Number(rateBps) / 100,
      collateralPercent: Number(collateralPct),
    },
    lenderCapacity: { lenders: summary.lenderCount, max: numOrNull(lenderCap), full: lenderCap === null ? null : summary.lenderCount >= Number(lenderCap) },
    minSupplyUsdc: usdcOrNull(minSupply),
    rpc,
  };
}

export function formatLoan(l: any, loanId: number) {
  const state = LOAN_STATES[Number(l.state)] ?? `UNKNOWN(${l.state})`;
  const now = Math.floor(Date.now() / 1000);
  const endTime = Number(l.endTime);
  return {
    loanId,
    borrower: l.borrower,
    agentId: Number(l.agentId),
    principalUsdc: formatUsdc(l.amount),
    collateralUsdc: formatUsdc(l.collateralAmount),
    interestRateBps: Number(l.interestRate),
    interestRateAprPercent: Number(l.interestRate) / 100,
    durationDays: Number(l.duration) / 86400,
    startTime: Number(l.startTime),
    endTime,
    dueDate: endTime ? new Date(endTime * 1000).toISOString() : null,
    secondsUntilDue: endTime ? endTime - now : null,
    overdue: state === 'ACTIVE' && endTime > 0 && now > endTime,
    state,
  };
}

export async function readLoan(cfg: NetworkConfig, loanId: number) {
  const c = getContracts(cfg);
  const [rpc, l, nextId] = await Promise.all([rpcStatus(cfg), c.marketplace.loans(loanId), c.marketplace.nextLoanId() as Promise<bigint>]);
  if (loanId >= Number(nextId) || l.borrower === ethers.ZeroAddress) {
    throw new ValidationError(`Loan ${loanId} does not exist on ${cfg.name} (highest loanId is ${Number(nextId) - 1})`, 'loanId');
  }
  const loan = formatLoan(l, loanId);
  let repayment: Record<string, unknown> | null = null;
  if (loan.state === 'ACTIVE') repayment = formatQuote(await repaymentQuote(cfg, l, loanId));
  return { network: cfg.name, ...loan, repayment, explorer: `${cfg.explorerAddress}${cfg.addresses.marketplace}`, rpc };
}

// ---------------------------------------------------------------------------
// V6.1-only reads (each guarded: a V6 deployment gets a clear 400, not a raw revert)
// ---------------------------------------------------------------------------

async function requireV61(cfg: NetworkConfig, what: string) {
  const caps = await marketplaceCapabilities(cfg);
  if (!caps.v61) throw new UnsupportedOnDeploymentError(unsupportedMessage(cfg, caps, what));
  return caps;
}

/**
 * Gate a V6.2-only (V7 credit model) read. A V6 / V6.1 deployment gets a clean
 * 400 explaining the version it actually runs — never a raw revert or, worse,
 * a fabricated zero that would read as "no self-stake required".
 */
async function requireV62(cfg: NetworkConfig, what: string) {
  const caps = await marketplaceCapabilities(cfg);
  if (!caps.v62) {
    throw new UnsupportedOnDeploymentError(
      `${unsupportedMessage(cfg, caps, what, 'V6.2')} The first-loss self-stake requirement is part of the V7 credit model and does not exist on this deployment, so there is nothing to report — not "zero required".`,
    );
  }
  return caps;
}

/**
 * requiredSelfStake(agentId, additionalAmount): the first-loss capital the agent
 * must already hold in its OWN pool before it could borrow `additionalAmount`
 * more. V6.2 only.
 */
export async function readRequiredSelfStake(cfg: NetworkConfig, agentId: number, additionalAmount: bigint) {
  const c = getContracts(cfg);
  const caps = await requireV62(cfg, 'required_self_stake');
  const [rpc, pool] = await Promise.all([rpcStatus(cfg), c.marketplace.agentPools(agentId)]);
  if (!pool.isActive) throw new ValidationError(`No active pool for agentId ${agentId} on ${cfg.name}`, 'agentId');
  const [required, st, outstanding, collateralPct, creditMultiple] = await Promise.all([
    c.marketplace.requiredSelfStake(agentId, additionalAmount) as Promise<bigint>,
    c.marketplace.selfStake(agentId),
    c.marketplace.outstandingPrincipal(agentId) as Promise<bigint>,
    c.reputation.calculateCollateralRequirement(pool.agentAddress) as Promise<bigint>,
    (c.reputation.creditMultiple() as Promise<bigint>).catch(() => null),
  ]);
  const held = st.amount as bigint;
  const shortfall = required > held ? required - held : 0n;
  return {
    network: cfg.name,
    marketplaceVersion: caps.version,
    agentId,
    agentAddress: pool.agentAddress,
    additionalAmountUsdc: formatUsdc(additionalAmount),
    outstandingPrincipalUsdc: formatUsdc(outstanding),
    collateralPercent: Number(collateralPct),
    creditMultiple: creditMultiple === null ? null : Number(creditMultiple),
    requiredSelfStakeUsdc: formatUsdc(required),
    currentSelfStakeUsdc: formatUsdc(held),
    shortfallUsdc: formatUsdc(shortfall),
    sufficient: shortfall === 0n,
    note:
      Number(collateralPct) >= 100
        ? 'This agent is at a 100%-collateral tier, so none of its exposure is unsecured and no self-stake is required.'
        : shortfall === 0n
          ? 'The agent already holds enough first-loss capital for this exposure; requestLoan will not revert on the self-stake gate.'
          : `requestLoan would revert "Insufficient self-stake". The agent must supply ${formatUsdc(shortfall)} more USDC into ITS OWN pool (prepare_supply_liquidity with agentId ${agentId} from ${pool.agentAddress}) first. That capital is then LOCKED until every loan is repaid and is seized before any third-party lender on a default.`,
    rpc,
  };
}

/** selfStake(agentId): the pool creator's own first-loss position and its lock state. V6.2 only. */
export async function readSelfStake(cfg: NetworkConfig, agentId: number) {
  const c = getContracts(cfg);
  const caps = await requireV62(cfg, 'get_self_stake');
  const [rpc, pool] = await Promise.all([rpcStatus(cfg), c.marketplace.agentPools(agentId)]);
  if (!pool.isActive) throw new ValidationError(`No active pool for agentId ${agentId} on ${cfg.name}`, 'agentId');
  const [st, required, outstanding, position] = await Promise.all([
    c.marketplace.selfStake(agentId),
    c.marketplace.requiredSelfStake(agentId, 0n) as Promise<bigint>,
    c.marketplace.outstandingPrincipal(agentId) as Promise<bigint>,
    c.marketplace.getLenderPosition(agentId, pool.agentAddress),
  ]);
  const amount = st.amount as bigint;
  const locked = Boolean(st.locked);
  const shortfall = required > amount ? required - amount : 0n;
  const excess = amount > required ? amount - required : 0n;
  return {
    network: cfg.name,
    marketplaceVersion: caps.version,
    agentId,
    agentAddress: pool.agentAddress,
    selfStakeUsdc: formatUsdc(amount),
    locked,
    outstandingPrincipalUsdc: formatUsdc(outstanding),
    requiredForCurrentExposureUsdc: formatUsdc(required),
    shortfallUsdc: formatUsdc(shortfall),
    withdrawableUsdc: locked ? '0.0' : formatUsdc(amount),
    /** Stake above what the current exposure demands; still locked while any principal is outstanding. */
    excessOverRequirementUsdc: formatUsdc(excess),
    claimableInterestUsdc: formatUsdc(position.earnedInterest as bigint),
    note: locked
      ? `Agent #${agentId} carries ${formatUsdc(outstanding)} USDC of outstanding principal, so this position is LOCKED: withdrawLiquidity from ${pool.agentAddress} reverts "Self-stake locked while borrowing". It is subordinated first-loss capital — on a default it absorbs the loss BEFORE any third-party lender. Repay the outstanding loans to unlock it. claimInterest is not affected by the lock.`
      : `Agent #${agentId} has no outstanding principal, so this position is not locked and can be withdrawn like any lender position. It becomes locked again the moment the agent opens a loan.`,
    rpc,
  };
}

/** previewRepayment(loanId): exact amount repayLoan would pull now. */
export async function readRepaymentPreview(cfg: NetworkConfig, loanId: number) {
  const c = getContracts(cfg);
  // [X-6] `repaymentQuote` ALREADY answers on V6 (the nominal fixed-term figure
  // from calculateInterest, which is exactly what V6 charges) and both SDKs
  // return it. Gating the route on V6.1 made that fallback dead code and made
  // the hosted server refuse a question the SDKs answer correctly.
  const caps = await marketplaceCapabilities(cfg);
  const [rpc, l, nextId] = await Promise.all([rpcStatus(cfg), c.marketplace.loans(loanId), c.marketplace.nextLoanId() as Promise<bigint>]);
  if (loanId >= Number(nextId) || l.borrower === ethers.ZeroAddress) {
    throw new ValidationError(`Loan ${loanId} does not exist on ${cfg.name} (highest loanId is ${Number(nextId) - 1})`, 'loanId');
  }
  const state = LOAN_STATES[Number(l.state)] ?? `UNKNOWN(${l.state})`;
  if (state !== 'ACTIVE') throw new ValidationError(`Loan ${loanId} is ${state}, not ACTIVE; nothing to repay.`, 'loanId');
  const q = await repaymentQuote(cfg, l, loanId);
  return {
    network: cfg.name,
    marketplaceVersion: caps.version,
    loanId,
    borrower: l.borrower,
    agentId: Number(l.agentId),
    endTime: Number(l.endTime),
    dueDate: new Date(Number(l.endTime) * 1000).toISOString(),
    lateInterestCapDays: (caps.lateInterestCapSeconds ?? 0) / 86400,
    ...formatQuote(q),
    rpc,
  };
}

/**
 * Off-chain replication of the CORRECTED `canTopUp` predicate.
 *
 * The bytecode deployed on Arc mainnet (0x358c5E69…) and Arc staging (0xB2d88bbF…)
 * evaluates the second window as the HALF-OPEN `[pending.timestamp, block.timestamp)`,
 * so an ACTIVE loan that started in the very block the view is read against falls
 * outside it and the view answers `true`. The `supplyLiquidity` tx lands in a LATER
 * block, where that same loan IS inside `[pending.timestamp, tx.timestamp)`, and the
 * tx reverts "Top-up would forfeit in-flight interest". The repo source fixes this with
 * an inclusive upper bound (`block.timestamp + 1`) but that fix is NOT deployed, and we
 * are deliberately not redeploying the marketplace for it alone. So the server must
 * never present the on-chain view as authoritative.
 *
 * Here the upper bound is effectively open-ended: every currently ACTIVE loan started at
 * or before "now", and the supply tx is mined strictly after "now", so any active loan
 * with `startTime >= pending.timestamp` will be inside the tx's window.
 *
 * No funds are at risk either way — the failure mode is a reverted tx and wasted gas.
 */
export function correctedCanTopUp(input: {
  positionAmount: bigint;
  depositTimestamp: bigint;
  pendingAmount: bigint;
  pendingTimestamp: bigint;
  activeLoanStartTimes: bigint[];
}): boolean {
  const { positionAmount, depositTimestamp, pendingAmount, pendingTimestamp, activeLoanStartTimes } = input;
  if (positionAmount === 0n || activeLoanStartTimes.length === 0 || pendingAmount === 0n) return true;
  // (c) fold is still available while no active loan started inside [deposit, pending) — unchanged by the bug.
  if (!activeLoanStartTimes.some((s) => s >= depositTimestamp && s < pendingTimestamp)) return true;
  // (d) merge: the deployed view uses `< block.timestamp`; the tx will use `< tx.timestamp`, which is later.
  return !activeLoanStartTimes.some((s) => s >= pendingTimestamp);
}

/** Warning every top-up carries: the check and the tx are in different blocks. */
/**
 * [2026-09-23] The V6 hazard `canTopUp: true` does NOT cover.
 *
 * "Will it revert?" and "is it safe?" are different questions, and on V6 they have
 * different answers. V6's `supplyLiquidity` sets `position.depositTimestamp =
 * block.timestamp` on EVERY supply, and `_distributeInterest` only pays lenders whose
 * `depositTimestamp <= loanStartTime` (verified in the bytecode-matching source at tag
 * arc-mainnet-v6-deployed-2026-09-19, lines 249 and 559/584). So a top-up while a loan is
 * open silently forfeits the WHOLE position's accrued interest on that loan — the F-02
 * finding, fixed in V6.1 by pending tranches and still live on Base.
 *
 * Answering "yes, you can top up" without this would be technically true and cost a
 * lender real money.
 */
const V6_TOP_UP_FORFEITS_INTEREST =
  'This deployment predates the V6.1 pending-tranche fix. A top-up here resets your position\'s deposit timestamp, so you FORFEIT the interest already accrued on every loan currently open in this pool (finding F-02). The transaction will succeed and the loss is silent. If the pool has open loans, wait for them to close before topping up, or supply from a different address.';

export const TOP_UP_RACE_WARNING =
  'can_top_up is a point-in-time check: a new loan can start in the pool between this read and your supply transaction, which would make the top-up revert "Top-up would forfeit in-flight interest". Treat a true answer as "likely to succeed", not a guarantee, and simulate immediately before sending.';

/** Warning when the deployed view and the corrected predicate disagree. */
export const TOP_UP_VIEW_BUG_WARNING =
  'The deployed marketplace bytecode answers canTopUp() with a half-open upper bound and says this top-up is allowed, but the corrected predicate (the one the supplyLiquidity transaction actually applies, evaluated a block later) says it would revert "Top-up would forfeit in-flight interest". This server returns the conservative answer. Wait until the pool\'s older active loans close, or open a fresh position from another address (a first supply is never refused).';

/** canTopUp(agentId, lender): whether supplyLiquidity by an existing lender would be refused right now. */
export async function readCanTopUp(cfg: NetworkConfig, agentId: number, lender: string) {
  const c = getContracts(cfg);
  const caps = await marketplaceCapabilities(cfg);
  // [X-6] V6 has no pending-tranche accounting at all, so a top-up can never
  // forfeit in-flight interest: the answer is unconditionally `true`, which is
  // what both SDKs return. Refusing the question here made one deployment give
  // three different answers to the same question.
  if (!caps.v61) {
    const [rpc, pool, pos] = await Promise.all([
      rpcStatus(cfg),
      c.marketplace.agentPools(agentId),
      c.marketplace.getLenderPosition(agentId, lender),
    ]);
    if (!pool.isActive) throw new ValidationError(`No active pool for agentId ${agentId} on ${cfg.name}`, 'agentId');
    return {
      network: cfg.name,
      marketplaceVersion: caps.version,
      agentId,
      lender,
      canTopUp: true,
      onChainView: null,
      correctedPredicate: true,
      viewDisagrees: false,
      hasPosition: (pos.amount as bigint) > 0n,
      suppliedUsdc: formatUsdc(pos.amount),
      pendingTrancheUsdc: null,
      activeLoansInPool: null,
      warnings: [TOP_UP_RACE_WARNING, V6_TOP_UP_FORFEITS_INTEREST],
      note: 'This deployment predates the pending-tranche accounting (V6.1), so supplyLiquidity never REFUSES a top-up on those grounds — the answer is unconditionally true, as it is in the JS and Python SDKs. It does not follow that topping up is safe here: see the forfeiture warning.',
      rpc,
    };
  }
  const [rpc, pool, ok, pos, pending] = await Promise.all([
    rpcStatus(cfg),
    c.marketplace.agentPools(agentId),
    c.marketplace.canTopUp(agentId, lender) as Promise<boolean>,
    c.marketplace.getLenderPosition(agentId, lender),
    c.marketplace.pendingTranche(agentId, lender),
  ]);
  if (!pool.isActive) throw new ValidationError(`No active pool for agentId ${agentId} on ${cfg.name}`, 'agentId');
  const activeStarts = await activeLoanStartTimes(cfg, agentId, pool.agentAddress as string);
  const hasPosition = (pos.amount as bigint) > 0n;
  const corrected = correctedCanTopUp({
    positionAmount: pos.amount as bigint,
    depositTimestamp: pos.depositTimestamp as bigint,
    pendingAmount: pending.amount as bigint,
    pendingTimestamp: pending.timestamp as bigint,
    activeLoanStartTimes: activeStarts,
  });
  // Conservative: only report a top-up as possible when BOTH agree.
  const answer = ok && corrected;
  const warnings = [TOP_UP_RACE_WARNING];
  if (ok !== corrected) warnings.unshift(TOP_UP_VIEW_BUG_WARNING);
  return {
    network: cfg.name,
    marketplaceVersion: caps.version,
    agentId,
    lender,
    canTopUp: answer,
    /** Raw answer of the deployed `canTopUp()` view — NOT authoritative (see warnings). */
    onChainView: ok,
    /** The predicate `supplyLiquidity` will actually apply, computed server-side from the active loans. */
    correctedPredicate: corrected,
    viewDisagrees: ok !== corrected,
    hasPosition,
    suppliedUsdc: formatUsdc(pos.amount),
    pendingTrancheUsdc: formatUsdc(pending.amount),
    activeLoansInPool: activeStarts.length,
    warnings,
    note: answer
      ? hasPosition
        ? 'A top-up now keeps all existing principal qualified for the interest of loans already in flight (nothing is forfeited). Not a guarantee: see warnings.'
        : 'No existing position: a first supply is never refused.'
      : 'supplyLiquidity would revert "Top-up would forfeit in-flight interest". Wait for the pool\'s older active loans to close and check again, or open a fresh position from another address.',
    rpc,
  };
}

/**
 * [X-6 2026-09-23] The agent's ACTIVE loan ids on ANY generation.
 *
 * V6.1+ has `getActiveLoanIds`. V6 does not, so the answer is computed the way
 * both SDKs compute it: walk the pool creator's `agentLoans[]` and keep state
 * ACTIVE. Refusing the question on V6 (which the server used to do) made the
 * same question return different answers from the three clients.
 */
async function activeLoanIdsFor(cfg: NetworkConfig, agentId: number, poolCreator: string): Promise<bigint[]> {
  const c = getContracts(cfg);
  const caps = await marketplaceCapabilities(cfg);
  if (caps.v61) return (await c.marketplace.getActiveLoanIds(agentId)) as bigint[];
  if (!poolCreator || poolCreator === ethers.ZeroAddress) return [];
  const out: bigint[] = [];
  for (let i = 0; i < MAX_LIST; i++) {
    let lid: bigint;
    try {
      lid = (await c.marketplace.agentLoans(poolCreator, i)) as bigint;
    } catch (e) {
      if (!isTransientRpcFailure(e)) break; // [X-4] end of array only
      throw e;
    }
    const l = await c.marketplace.loans(lid);
    if (Number(l.state) === 1) out.push(lid);
  }
  return out;
}

/** Start timestamps of every ACTIVE loan in an agent's pool (<= MAX_ACTIVE_LOANS_PER_AGENT entries). */
export async function activeLoanStartTimes(cfg: NetworkConfig, agentId: number, poolCreator = ''): Promise<bigint[]> {
  const c = getContracts(cfg);
  const ids = await activeLoanIdsFor(cfg, agentId, poolCreator);
  const loans = await Promise.all(ids.map((id) => c.marketplace.loans(id)));
  return loans.map((l) => l.startTime as bigint);
}

/** getActiveLoanIds(agentId): the agent's ACTIVE loans (<= MAX_ACTIVE_LOANS_PER_AGENT). */
export async function readActiveLoanIds(cfg: NetworkConfig, agentId: number) {
  const c = getContracts(cfg);
  const [rpc, caps, pool] = await Promise.all([rpcStatus(cfg), marketplaceCapabilities(cfg), c.marketplace.agentPools(agentId)]);
  if (!pool.isActive) throw new ValidationError(`No active pool for agentId ${agentId} on ${cfg.name}`, 'agentId');
  const ids = (await activeLoanIdsFor(cfg, agentId, pool.agentAddress as string)).map(Number);
  const loans = await Promise.all(ids.map(async (id) => formatLoan(await c.marketplace.loans(id), id)));
  return {
    network: cfg.name,
    marketplaceVersion: caps.version,
    agentId,
    activeLoans: ids.length,
    loanIds: ids,
    loans,
    source: caps.v61 ? 'getActiveLoanIds' : 'agentLoans-walk',
    ...(caps.v61 ? {} : { note: 'This deployment predates getActiveLoanIds(); the list was computed by walking the pool creator\'s agentLoans[] and keeping the ACTIVE ones — the same way the JS and Python SDKs answer it.' }),
    rpc,
  };
}


export async function readAgentLoans(cfg: NetworkConfig, address: string, opts: { limit?: number } = {}) {
  const c = getContracts(cfg);
  const rpc = await rpcStatus(cfg);
  const limit = Math.min(opts.limit ?? 50, MAX_LIST);
  const ids: number[] = [];
  // agentLoans(address, i) reverts past the end; walk until revert (bounded).
  //
  // [X-4 2026-09-23] Only a DEFINITE revert ends the walk. Treating ANY error as
  // "end of array" meant one rate-limited eth_call silently truncated the list —
  // and an empty result reads as "this agent has no loans", which is a wrong
  // answer about outstanding debt.
  for (let i = 0; i < MAX_LIST; i++) {
    try {
      ids.push(Number(await c.marketplace.agentLoans(address, i)));
    } catch (e) {
      if (!isTransientRpcFailure(e)) break;
      throw Object.assign(
        new Error(
          `Could not enumerate ${address}'s loans on ${cfg.name}: the RPC failed at index ${i} of the agentLoans ` +
          `walk (${describeRpcError(e)}). Refusing to report a truncated loan list as complete — retry shortly.`,
        ),
        { cause: e },
      );
    }
  }
  const recent = ids.slice(-limit).reverse();
  const loans = await Promise.all(recent.map(async (id) => formatLoan(await c.marketplace.loans(id), id)));
  return { network: cfg.name, address, totalLoans: ids.length, returned: loans.length, loans, rpc };
}

export async function readPositions(cfg: NetworkConfig, address: string) {
  const c = getContracts(cfg);
  let rpc: RpcStatus;
  let active: { ids: bigint[]; total: number; truncated: boolean };
  try {
    [rpc, active] = await Promise.all([rpcStatus(cfg), activeAgentIds(c, cfg)]);
  } catch (e) {
    // [X-2] the 2026-05 Base build cannot enumerate pools, so positions cannot
    // be discovered by scanning. Say that — an empty list would read as "you
    // have no positions", which is a wrong answer about money.
    return noEnumeration(cfg, e, {
      network: cfg.name, address, totalSuppliedUsdc: null, totalClaimableInterestUsdc: null,
      positions: [] as Array<Record<string, unknown>>,
    });
  }
  const ids = active.ids;
  const positions: Array<Record<string, unknown>> = [];
  let totalSupplied = 0n;
  let totalEarned = 0n;
  const results = await Promise.all(ids.slice(0, MAX_LIST).map((id) => c.marketplace.getLenderPosition(id, address)));
  results.forEach((p, i) => {
    if ((p.amount as bigint) === 0n && (p.earnedInterest as bigint) === 0n) return;
    totalSupplied += p.amount as bigint;
    totalEarned += p.earnedInterest as bigint;
    positions.push({
      agentId: Number(ids[i]),
      suppliedUsdc: formatUsdc(p.amount),
      claimableInterestUsdc: formatUsdc(p.earnedInterest),
      depositTimestamp: Number(p.depositTimestamp),
      shareOfPoolPercent: Number(p.shareOfPool) / 100,
    });
  });
  return {
    network: cfg.name,
    address,
    totalSuppliedUsdc: formatUsdc(totalSupplied),
    totalClaimableInterestUsdc: formatUsdc(totalEarned),
    positions,
    truncated: ids.length > MAX_LIST ? `scanned first ${MAX_LIST} pools only` : undefined,
    rpc,
  };
}

export async function readTransaction(cfg: NetworkConfig, hash: string) {
  const c = getContracts(cfg);
  const [rpc, tx, receipt] = await Promise.all([rpcStatus(cfg), c.provider.getTransaction(hash), c.provider.getTransactionReceipt(hash)]);
  if (!tx && !receipt) return { network: cfg.name, hash, found: false, status: 'unknown', hint: 'Not seen by this RPC yet (or never broadcast).', rpc };
  const events: Array<Record<string, unknown>> = [];
  if (receipt) {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== cfg.addresses.marketplace.toLowerCase() && log.address.toLowerCase() !== cfg.addresses.registry.toLowerCase()) continue;
      const iface = log.address.toLowerCase() === cfg.addresses.marketplace.toLowerCase() ? c.marketplace.interface : c.registry.interface;
      try {
        const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
        if (parsed) {
          const args: Record<string, string> = {};
          parsed.fragment.inputs.forEach((inp, i) => (args[inp.name || String(i)] = String(parsed.args[i])));
          events.push({ name: parsed.name, args });
        }
      } catch {
        /* unknown event */
      }
    }
  }
  return {
    network: cfg.name,
    hash,
    found: true,
    status: receipt ? (receipt.status === 1 ? 'confirmed' : 'reverted') : 'pending',
    blockNumber: receipt?.blockNumber ?? null,
    from: tx?.from ?? receipt?.from ?? null,
    to: tx?.to ?? receipt?.to ?? null,
    gasUsed: receipt ? receipt.gasUsed.toString() : null,
    events,
    explorer: `${cfg.explorerTx}${hash}`,
    rpc,
  };
}

export type { RpcStatus };
