/**
 * READ tools: executed server-side against the public RPC of the requested
 * network. Every result carries `rpc` (block number / age / stale flag).
 */
import { ethers } from 'ethers';
import { getContracts, marketplaceCapabilities, rpcStatus, RpcStatus, unsupportedMessage } from './chain.js';
import { NetworkConfig, publicNetworkInfo } from './networks.js';
import { formatUsdc, UnsupportedOnDeploymentError, ValidationError } from './validate.js';

export const LOAN_STATES = ['REQUESTED', 'ACTIVE', 'REPAID', 'DEFAULTED'] as const;

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

export function tierFor(score: number): { tier: string; collateralPct: number; aprPct: number; creditLimitUsdc: number } {
  if (score >= 800) return { tier: 'Excellent', collateralPct: 0, aprPct: 5, creditLimitUsdc: 50_000 };
  if (score >= 600) return { tier: 'Good', collateralPct: 0, aprPct: 7, creditLimitUsdc: 25_000 };
  if (score >= 500) return { tier: 'Fair', collateralPct: 25, aprPct: 10, creditLimitUsdc: 10_000 };
  if (score >= 400) return { tier: 'Building', collateralPct: 100, aprPct: 10, creditLimitUsdc: 10_000 };
  if (score >= 200) return { tier: 'Low', collateralPct: 100, aprPct: 15, creditLimitUsdc: 5_000 };
  return { tier: 'New', collateralPct: 100, aprPct: 15, creditLimitUsdc: 1_000 };
}

const MAX_LIST = 200;

export async function readNetworkInfo(cfg: NetworkConfig) {
  const rpc = await rpcStatus(cfg);
  return { ...publicNetworkInfo(cfg), rpc };
}

export async function readProtocolStatus(cfg: NetworkConfig) {
  const c = getContracts(cfg);
  const [rpc, paused, totalPools, nextLoanId, totalAgents, minSupply, bind, minHold, feeRate, maxActive, activeAgents] = await Promise.all([
    rpcStatus(cfg),
    c.marketplace.paused() as Promise<boolean>,
    c.marketplace.totalPools() as Promise<bigint>,
    c.marketplace.nextLoanId() as Promise<bigint>,
    c.registry.totalAgents() as Promise<bigint>,
    c.marketplace.minSupplyAmount() as Promise<bigint>,
    c.marketplace.bindBorrowToPoolCreator() as Promise<boolean>,
    c.marketplace.minHoldForReputationReward() as Promise<bigint>,
    c.marketplace.platformFeeRate() as Promise<bigint>,
    c.marketplace.MAX_ACTIVE_LOANS_PER_AGENT() as Promise<bigint>,
    c.marketplace.getActiveAgents() as Promise<bigint[]>,
  ]);

  // TVL = sum of pool totalLiquidity across active pools (bounded walk).
  let tvl = 0n;
  let available = 0n;
  let loaned = 0n;
  const ids = activeAgents.slice(0, MAX_LIST);
  const pools = await Promise.all(ids.map((id) => c.marketplace.agentPools(id)));
  for (const p of pools) {
    tvl += p.totalLiquidity as bigint;
    available += p.availableLiquidity as bigint;
    loaned += p.totalLoaned as bigint;
  }
  return {
    network: cfg.name,
    label: cfg.label,
    realMoney: cfg.realMoney,
    chainId: cfg.chainId,
    marketplace: cfg.addresses.marketplace,
    paused,
    totalPools: Number(totalPools),
    activePools: activeAgents.length,
    totalLoans: Number(nextLoanId) - 1,
    totalAgents: Number(totalAgents),
    tvlUsdc: formatUsdc(tvl),
    availableLiquidityUsdc: formatUsdc(available),
    totalLoanedUsdc: formatUsdc(loaned),
    parameters: {
      minSupplyUsdc: formatUsdc(minSupply),
      borrowRestrictedToPoolCreator: bind,
      minHoldForReputationRewardSeconds: Number(minHold),
      platformFeeBps: Number(feeRate),
      maxActiveLoansPerAgent: Number(maxActive),
      loanDurationDays: { min: 7, max: 365 },
    },
    truncated: activeAgents.length > MAX_LIST ? `TVL computed over first ${MAX_LIST} pools only` : undefined,
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
    c.marketplace.activeLoanCount(agentId) as Promise<bigint>,
    c.marketplace.outstandingPrincipal(agentId) as Promise<bigint>,
    c.marketplace.MAX_ACTIVE_LOANS_PER_AGENT() as Promise<bigint>,
  ]);
  const s = Number(score);
  const tier = tierFor(s);
  const remaining = (limit as bigint) - (outstanding as bigint);
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
    reputation: { score: s, tier: tier.tier, max: 1000 },
    credit: {
      creditLimitUsdc: formatUsdc(limit),
      outstandingPrincipalUsdc: formatUsdc(outstanding),
      remainingCreditUsdc: formatUsdc(remaining < 0n ? 0n : remaining),
      collateralPercent: Number(collateralPct),
      interestRateBps: Number(rateBps),
      interestRateAprPercent: Number(rateBps) / 100,
      activeLoans: Number(activeLoans),
      maxActiveLoans: Number(maxActive),
      canBorrow: Number(activeLoans) < Number(maxActive) && remaining > 0n,
    },
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
  const [rpc, ids] = await Promise.all([rpcStatus(cfg), c.marketplace.getActiveAgents() as Promise<bigint[]>]);
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
    c.marketplace.activeLoanCount(agentId) as Promise<bigint>,
    c.marketplace.outstandingPrincipal(agentId) as Promise<bigint>,
    c.marketplace.minSupplyAmount() as Promise<bigint>,
    c.marketplace.MAX_LENDERS_PER_POOL() as Promise<bigint>,
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
    activeLoans: Number(activeLoans),
    outstandingPrincipalUsdc: formatUsdc(outstanding),
    borrower: {
      reputationScore: s,
      tier: tierFor(s).tier,
      interestRateAprPercent: Number(rateBps) / 100,
      collateralPercent: Number(collateralPct),
    },
    lenderCapacity: { lenders: summary.lenderCount, max: Number(lenderCap), full: summary.lenderCount >= Number(lenderCap) },
    minSupplyUsdc: formatUsdc(minSupply),
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

/** previewRepayment(loanId): exact amount repayLoan would pull now. */
export async function readRepaymentPreview(cfg: NetworkConfig, loanId: number) {
  const c = getContracts(cfg);
  const caps = await requireV61(cfg, 'preview_repayment');
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
export const TOP_UP_RACE_WARNING =
  'can_top_up is a point-in-time check: a new loan can start in the pool between this read and your supply transaction, which would make the top-up revert "Top-up would forfeit in-flight interest". Treat a true answer as "likely to succeed", not a guarantee, and simulate immediately before sending.';

/** Warning when the deployed view and the corrected predicate disagree. */
export const TOP_UP_VIEW_BUG_WARNING =
  'The deployed marketplace bytecode answers canTopUp() with a half-open upper bound and says this top-up is allowed, but the corrected predicate (the one the supplyLiquidity transaction actually applies, evaluated a block later) says it would revert "Top-up would forfeit in-flight interest". This server returns the conservative answer. Wait until the pool\'s older active loans close, or open a fresh position from another address (a first supply is never refused).';

/** canTopUp(agentId, lender): whether supplyLiquidity by an existing lender would be refused right now. */
export async function readCanTopUp(cfg: NetworkConfig, agentId: number, lender: string) {
  const c = getContracts(cfg);
  const caps = await requireV61(cfg, 'can_top_up');
  const [rpc, pool, ok, pos, pending, activeStarts] = await Promise.all([
    rpcStatus(cfg),
    c.marketplace.agentPools(agentId),
    c.marketplace.canTopUp(agentId, lender) as Promise<boolean>,
    c.marketplace.getLenderPosition(agentId, lender),
    c.marketplace.pendingTranche(agentId, lender),
    activeLoanStartTimes(cfg, agentId),
  ]);
  if (!pool.isActive) throw new ValidationError(`No active pool for agentId ${agentId} on ${cfg.name}`, 'agentId');
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

/** Start timestamps of every ACTIVE loan in an agent's pool (<= MAX_ACTIVE_LOANS_PER_AGENT entries). */
export async function activeLoanStartTimes(cfg: NetworkConfig, agentId: number): Promise<bigint[]> {
  const c = getContracts(cfg);
  const ids = (await c.marketplace.getActiveLoanIds(agentId)) as bigint[];
  const loans = await Promise.all(ids.map((id) => c.marketplace.loans(id)));
  return loans.map((l) => l.startTime as bigint);
}

/** getActiveLoanIds(agentId): the agent's ACTIVE loans (<= MAX_ACTIVE_LOANS_PER_AGENT). */
export async function readActiveLoanIds(cfg: NetworkConfig, agentId: number) {
  const c = getContracts(cfg);
  const caps = await requireV61(cfg, 'get_active_loan_ids');
  const [rpc, pool, idsRaw] = await Promise.all([rpcStatus(cfg), c.marketplace.agentPools(agentId), c.marketplace.getActiveLoanIds(agentId) as Promise<bigint[]>]);
  if (!pool.isActive) throw new ValidationError(`No active pool for agentId ${agentId} on ${cfg.name}`, 'agentId');
  const ids = idsRaw.map(Number);
  const loans = await Promise.all(ids.map(async (id) => formatLoan(await c.marketplace.loans(id), id)));
  return { network: cfg.name, marketplaceVersion: caps.version, agentId, activeLoans: ids.length, loanIds: ids, loans, rpc };
}


export async function readAgentLoans(cfg: NetworkConfig, address: string, opts: { limit?: number } = {}) {
  const c = getContracts(cfg);
  const rpc = await rpcStatus(cfg);
  const limit = Math.min(opts.limit ?? 50, MAX_LIST);
  const ids: number[] = [];
  // agentLoans(address, i) reverts past the end; walk until revert (bounded).
  for (let i = 0; i < MAX_LIST; i++) {
    try {
      ids.push(Number(await c.marketplace.agentLoans(address, i)));
    } catch {
      break;
    }
  }
  const recent = ids.slice(-limit).reverse();
  const loans = await Promise.all(recent.map(async (id) => formatLoan(await c.marketplace.loans(id), id)));
  return { network: cfg.name, address, totalLoans: ids.length, returned: loans.length, loans, rpc };
}

export async function readPositions(cfg: NetworkConfig, address: string) {
  const c = getContracts(cfg);
  const [rpc, ids] = await Promise.all([rpcStatus(cfg), c.marketplace.getActiveAgents() as Promise<bigint[]>]);
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
