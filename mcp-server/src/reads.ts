/**
 * READ tools: executed server-side against the public RPC of the requested
 * network. Every result carries `rpc` (block number / age / stale flag).
 */
import { ethers } from 'ethers';
import { getContracts, rpcStatus, RpcStatus } from './chain.js';
import { NetworkConfig, publicNetworkInfo } from './networks.js';
import { formatUsdc, ValidationError } from './validate.js';

export const LOAN_STATES = ['REQUESTED', 'ACTIVE', 'REPAID', 'DEFAULTED'] as const;

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
  if (loan.state === 'ACTIVE') {
    const interest = (await c.marketplace.calculateInterest(l.amount, l.interestRate, l.duration)) as bigint;
    repayment = {
      interestUsdc: formatUsdc(interest),
      totalRepaymentUsdc: formatUsdc((l.amount as bigint) + interest),
      note: 'Interest is fixed for the full term (not pro-rated). Approve exactly totalRepaymentUsdc to the marketplace before repayLoan.',
    };
  }
  return { network: cfg.name, ...loan, repayment, explorer: `${cfg.explorerAddress}${cfg.addresses.marketplace}`, rpc };
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
