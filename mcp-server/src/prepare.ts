/**
 * WRITE tools: build PREPARED, UNSIGNED transactions that the agent's own
 * wallet signs and broadcasts. This server never holds a key.
 *
 *  - encodeAction()  pure: validates args, encodes calldata, describes the call.
 *  - prepareTx()     encode + on-chain pre-checks (allowance/balance/state) +
 *                    exact-amount prerequisite approve + optional simulation.
 *
 * Approvals are always EXACT (never MaxUint256) and always to the marketplace.
 */
import { ethers } from 'ethers';
import { getContracts } from './chain.js';
import { IFACE, NetworkConfig } from './networks.js';
import { LOAN_STATES } from './reads.js';
import {
  formatUsdc,
  MAX_LOAN_USDC,
  requireObject,
  validateAddress,
  validateAmountUsdc,
  validateBoolean,
  validateDurationDays,
  validateId,
  validateShortString,
  ValidationError,
} from './validate.js';

export const WRITE_ACTIONS = [
  'register_agent',
  'create_pool',
  'approve_usdc',
  'supply_liquidity',
  'withdraw_liquidity',
  'request_loan',
  'repay_loan',
  'claim_interest',
] as const;
export type WriteAction = (typeof WRITE_ACTIONS)[number];

export function isWriteAction(x: unknown): x is WriteAction {
  return typeof x === 'string' && (WRITE_ACTIONS as readonly string[]).includes(x);
}

export type TargetContract = 'marketplace' | 'registry' | 'usdc';

/** Functions a prepared/broadcast tx may call, per target contract. Admin functions are excluded on purpose. */
export const ALLOWED_FUNCTIONS: Record<TargetContract, readonly string[]> = {
  marketplace: ['createAgentPool', 'supplyLiquidity', 'withdrawLiquidity', 'requestLoan', 'repayLoan', 'claimInterest'],
  registry: ['register'],
  usdc: ['approve'],
};

/** Static gas fallbacks (used when the caller does not ask for simulation). */
const DEFAULT_GAS: Record<WriteAction, bigint> = {
  register_agent: 500_000n,
  create_pool: 300_000n,
  approve_usdc: 80_000n,
  supply_liquidity: 300_000n,
  withdraw_liquidity: 300_000n,
  request_loan: 700_000n,
  repay_loan: 1_600_000n, // interest distribution across up to 50 lenders (measured 1.4M on Arc V6)
  claim_interest: 150_000n,
};

export interface EncodedAction {
  action: WriteAction;
  target: TargetContract;
  to: string;
  data: string;
  functionName: string;
  args: Record<string, string>;
  description: string;
  humanReadableSummary: string;
  warnings: string[];
  /** amount of USDC (base units) the marketplace must be allowed to pull for this call, if known offline */
  pullsUsdc?: bigint;
  defaultGas: bigint;
}

export interface Simulation {
  ok: boolean;
  gasEstimate: string | null;
  revertReason: string | null;
  plainLanguage: string | null;
  from: string;
}

export interface PreparedTx {
  network: string;
  chainId: number;
  realMoney: boolean;
  action: WriteAction;
  from: string;
  to: string;
  data: string;
  value: '0';
  gasEstimate: string;
  gasEstimateSource: 'estimateGas' | 'default';
  description: string;
  humanReadableSummary: string;
  warnings: string[];
  call: { contract: TargetContract; contractAddress: string; function: string; args: Record<string, string> };
  /** Exact-amount USDC approve that must be sent (and mined) BEFORE this tx, or null. */
  prerequisite: PreparedTx | null;
  simulation: Simulation | null;
  signingInstructions: string;
}

const SIGNING_INSTRUCTIONS =
  'Sign {chainId,to,data,value:0} with YOUR OWN wallet (set nonce/gas from your provider; gasEstimate is a hint), then broadcast it yourself or pass the raw signed hex to broadcast_signed_transaction. If `prerequisite` is present, send and confirm it first. This server never sees your private key.';

function realMoneyWarning(cfg: NetworkConfig): string[] {
  return cfg.realMoney ? [`${cfg.name} is a REAL-MONEY network: this transaction moves real USDC.`] : [];
}

/**
 * Pure encoder: no RPC. Validates every argument and returns calldata for a
 * Specular contract on the given network. `from` is only used for defaults
 * and the summary text (it is the agent's own wallet).
 */
export function encodeAction(cfg: NetworkConfig, action: WriteAction, rawArgs: unknown, from: string): EncodedAction {
  const a = requireObject(rawArgs ?? {});
  const mp = cfg.addresses.marketplace;
  const base = { warnings: realMoneyWarning(cfg), defaultGas: DEFAULT_GAS[action] };

  switch (action) {
    case 'register_agent': {
      const agentURI = a.agentURI === undefined ? `specular://${from}` : validateShortString(a.agentURI, 'agentURI', { max: 512 });
      const meta: Array<{ key: string; value: string }> = [];
      if (a.metadata !== undefined) {
        if (!Array.isArray(a.metadata) || a.metadata.length > 16) throw new ValidationError('metadata must be an array of at most 16 {key,value} entries', 'metadata');
        for (const m of a.metadata) {
          const o = requireObject(m, 'metadata entry');
          const key = validateShortString(o.key, 'metadata.key', { max: 64 });
          const value = validateShortString(o.value, 'metadata.value', { max: 1024, min: 0 });
          meta.push({ key, value: ethers.hexlify(ethers.toUtf8Bytes(value)) });
        }
      }
      const data = IFACE.registry.encodeFunctionData('register', [agentURI, meta]);
      return {
        ...base,
        action,
        target: 'registry',
        to: cfg.addresses.registry,
        data,
        functionName: 'register',
        args: { agentURI, metadataEntries: String(meta.length) },
        description: 'Register this wallet as a Specular agent (mints the agent NFT, agentId assigned on-chain).',
        humanReadableSummary: `Register ${from} as an agent on ${cfg.name} with URI "${agentURI}"${meta.length ? ` and ${meta.length} metadata entries` : ''}. No USDC moves.`,
      };
    }
    case 'create_pool': {
      const data = IFACE.marketplace.encodeFunctionData('createAgentPool', []);
      return {
        ...base,
        action,
        target: 'marketplace',
        to: mp,
        data,
        functionName: 'createAgentPool',
        args: {},
        description: 'Create the liquidity pool for this registered agent (required once before borrowing or receiving liquidity).',
        humanReadableSummary: `Create the agent liquidity pool for ${from} on ${cfg.name}. No USDC moves.`,
      };
    }
    case 'approve_usdc': {
      const amount = validateAmountUsdc(a.amount, 'amount', { allowZero: true });
      if (a.spender !== undefined && validateAddress(a.spender, 'spender') !== mp) {
        throw new ValidationError(`spender must be the Specular marketplace ${mp} on ${cfg.name}; other spenders are not prepared by this server`, 'spender');
      }
      const data = IFACE.usdc.encodeFunctionData('approve', [mp, amount]);
      return {
        ...base,
        action,
        target: 'usdc',
        to: cfg.addresses.usdc,
        data,
        functionName: 'approve',
        args: { spender: mp, amount: amount.toString(), amountUsdc: formatUsdc(amount) },
        description: 'Approve the Specular marketplace to pull EXACTLY this much USDC (never unlimited). Set amount 0 to revoke.',
        humanReadableSummary: `Allow the Specular marketplace (${mp}) to spend exactly ${formatUsdc(amount)} USDC from ${from} on ${cfg.name}.`,
      };
    }
    case 'supply_liquidity': {
      const agentId = validateId(a.agentId, 'agentId');
      const amount = validateAmountUsdc(a.amount, 'amount');
      const data = IFACE.marketplace.encodeFunctionData('supplyLiquidity', [agentId, amount]);
      return {
        ...base,
        action,
        target: 'marketplace',
        to: mp,
        data,
        functionName: 'supplyLiquidity',
        args: { agentId: String(agentId), amount: amount.toString(), amountUsdc: formatUsdc(amount) },
        pullsUsdc: amount,
        description: 'Supply USDC to an agent pool as a lender and earn interest from that agent\'s loan repayments.',
        humanReadableSummary: `Supply ${formatUsdc(amount)} USDC from ${from} into agent #${agentId}'s pool on ${cfg.name}. Requires a prior exact USDC approval of the same amount.`,
      };
    }
    case 'withdraw_liquidity': {
      const agentId = validateId(a.agentId, 'agentId');
      const amount = validateAmountUsdc(a.amount, 'amount');
      const data = IFACE.marketplace.encodeFunctionData('withdrawLiquidity', [agentId, amount]);
      return {
        ...base,
        action,
        target: 'marketplace',
        to: mp,
        data,
        functionName: 'withdrawLiquidity',
        args: { agentId: String(agentId), amount: amount.toString(), amountUsdc: formatUsdc(amount) },
        description: 'Withdraw supplied principal from an agent pool (interest is claimed separately with claim_interest).',
        humanReadableSummary: `Withdraw ${formatUsdc(amount)} USDC of supplied principal from agent #${agentId}'s pool on ${cfg.name} to ${from}.`,
      };
    }
    case 'request_loan': {
      const amount = validateAmountUsdc(a.amount, 'amount', { max: MAX_LOAN_USDC });
      const durationDays = validateDurationDays(a.durationDays);
      const data = IFACE.marketplace.encodeFunctionData('requestLoan', [amount, durationDays]);
      return {
        ...base,
        action,
        target: 'marketplace',
        to: mp,
        data,
        functionName: 'requestLoan',
        args: { amount: amount.toString(), amountUsdc: formatUsdc(amount), durationDays: String(durationDays) },
        description: 'Request a USDC loan against your reputation. Auto-disbursed from your own agent pool; low-reputation tiers must post collateral (pulled via a prior exact approval).',
        humanReadableSummary: `Borrow ${formatUsdc(amount)} USDC for ${durationDays} days as ${from} on ${cfg.name}. Interest is fixed for the full term at your reputation tier's APR.`,
      };
    }
    case 'repay_loan': {
      const loanId = validateId(a.loanId, 'loanId');
      const data = IFACE.marketplace.encodeFunctionData('repayLoan', [loanId]);
      return {
        ...base,
        action,
        target: 'marketplace',
        to: mp,
        data,
        functionName: 'repayLoan',
        args: { loanId: String(loanId) },
        description: 'Repay a loan in full (principal + fixed-term interest); collateral is returned and reputation updated.',
        humanReadableSummary: `Repay loan #${loanId} in full from ${from} on ${cfg.name}. Requires a prior exact USDC approval of principal + interest.`,
      };
    }
    case 'claim_interest': {
      const agentId = validateId(a.agentId, 'agentId');
      const data = IFACE.marketplace.encodeFunctionData('claimInterest', [agentId]);
      return {
        ...base,
        action,
        target: 'marketplace',
        to: mp,
        data,
        functionName: 'claimInterest',
        args: { agentId: String(agentId) },
        description: 'Claim interest earned as a lender in an agent pool.',
        humanReadableSummary: `Claim accrued lender interest from agent #${agentId}'s pool on ${cfg.name} to ${from}.`,
      };
    }
    default:
      throw new ValidationError(`Unknown action ${String(action)}; valid: ${WRITE_ACTIONS.join(', ')}`, 'action');
  }
}

/** Decode a prepared tx's calldata back into (function, args) using the repo ABI; used by tests and the broadcast validator. */
export function decodeCalldata(target: TargetContract, data: string): { name: string; args: unknown[] } {
  const iface = target === 'usdc' ? IFACE.usdc : target === 'registry' ? IFACE.registry : IFACE.marketplace;
  const parsed = iface.parseTransaction({ data });
  if (!parsed) throw new ValidationError('calldata does not match any known Specular function');
  return { name: parsed.name, args: [...parsed.args] };
}

// ---------------------------------------------------------------------------
// Revert-reason translation
// ---------------------------------------------------------------------------

const REASON_MAP: Array<[RegExp, string]> = [
  [/Not a registered agent|Agent not registered/i, 'This wallet is not registered as an agent on this network. Send register_agent first, then create_pool.'],
  [/No pool for agent/i, 'This agent has no liquidity pool yet. Send create_pool first.'],
  [/Pool already exists/i, 'This agent already has a pool; nothing to do.'],
  [/Agent already registered/i, 'This wallet is already registered; skip register_agent.'],
  [/Insufficient pool liquidity/i, 'The pool does not hold enough available USDC for this amount. Lower the amount, or supply/attract liquidity first.'],
  [/Borrow restricted to pool creator/i, 'Borrowing on this network is restricted to the wallet that created the pool.'],
  [/Invalid duration/i, 'durationDays must be between 7 and 365 (pass days, not seconds).'],
  [/Exceeds credit limit/i, 'Outstanding principal plus this amount exceeds your reputation-based credit limit. Repay existing loans or borrow less.'],
  [/Too many active loans/i, 'You already hold the maximum number of concurrent active loans. Repay one first.'],
  [/Pool not active/i, 'That pool is not active (wrong agentId?).'],
  [/Below minimum supply/i, 'Amount is below the pool\'s minimum supply (see get_protocol_status.parameters.minSupplyUsdc).'],
  [/Pool lender capacity reached|Lender cap/i, 'This pool already has the maximum number of lenders (50). Choose another pool.'],
  [/Insufficient balance/i, 'You are withdrawing more than you supplied to this pool.'],
  [/Not the borrower/i, 'Only the wallet that borrowed this loan can repay it.'],
  [/Loan not active/i, 'This loan is not ACTIVE (already repaid or defaulted).'],
  [/No interest to claim/i, 'There is no claimable interest for this wallet in this pool.'],
  [/Drain underflow/i, 'Pool accounting cannot cover this claim right now; contact the protocol owner.'],
  [/Amount must be > 0/i, 'Amount must be greater than zero.'],
  [/EnforcedPause|Pausable: paused|paused/i, 'The contract is paused by the owner; try later.'],
  [/ERC20InsufficientAllowance|insufficient allowance|exceeds allowance/i, 'The marketplace is not approved to pull enough USDC from your wallet. Send the exact-amount approve_usdc transaction (see `prerequisite`) first.'],
  [/ERC20InsufficientBalance|exceeds balance|insufficient balance for transfer/i, 'Your wallet does not hold enough USDC for this transaction.'],
  [/Ownable|OwnableUnauthorizedAccount|caller is not the owner/i, 'This function is owner-only.'],
];

const CUSTOM_ERRORS = new ethers.Interface([
  'error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)',
  'error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)',
  'error EnforcedPause()',
  'error ReentrancyGuardReentrantCall()',
  'error OwnableUnauthorizedAccount(address account)',
  'error SafeERC20FailedOperation(address token)',
]);

export function explainRevert(e: unknown): { reason: string; plain: string } {
  let reason = '';
  const err = e as { reason?: string; data?: string; shortMessage?: string; message?: string; info?: { error?: { data?: string; message?: string } } };
  if (typeof err?.reason === 'string' && err.reason) reason = err.reason;
  const data = typeof err?.data === 'string' ? err.data : err?.info?.error?.data;
  if (!reason && typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
    try {
      const parsed = CUSTOM_ERRORS.parseError(data);
      if (parsed) reason = `${parsed.name}(${parsed.args.map(String).join(', ')})`;
    } catch {
      /* not a known custom error */
    }
    if (!reason) {
      try {
        const builtin = ethers.AbiCoder.defaultAbiCoder().decode(['string'], '0x' + data.slice(10));
        if (data.startsWith('0x08c379a0')) reason = String(builtin[0]);
      } catch {
        /* not Error(string) */
      }
    }
  }
  if (!reason) reason = err?.shortMessage || err?.info?.error?.message || err?.message || 'execution reverted';
  reason = reason.replace(/^execution reverted:?\s*/i, '').trim() || 'execution reverted (no reason given)';
  const plain = REASON_MAP.find(([re]) => re.test(reason))?.[1] ?? `The transaction would revert: ${reason}`;
  return { reason: reason.length > 200 ? reason.slice(0, 200) + '…' : reason, plain };
}

// ---------------------------------------------------------------------------
// Full prepare (encode + pre-checks + prerequisite approve + simulate)
// ---------------------------------------------------------------------------

export async function simulateCall(cfg: NetworkConfig, from: string, to: string, data: string): Promise<Simulation> {
  const { provider } = getContracts(cfg);
  try {
    await provider.call({ from, to, data, value: 0n });
    let gas: bigint | null = null;
    try {
      gas = await provider.estimateGas({ from, to, data, value: 0n });
    } catch {
      gas = null;
    }
    return { ok: true, gasEstimate: gas === null ? null : gas.toString(), revertReason: null, plainLanguage: null, from };
  } catch (e) {
    const { reason, plain } = explainRevert(e);
    return { ok: false, gasEstimate: null, revertReason: reason, plainLanguage: plain, from };
  }
}

function toPrepared(cfg: NetworkConfig, from: string, enc: EncodedAction, extraWarnings: string[], prerequisite: PreparedTx | null, sim: Simulation | null): PreparedTx {
  const gasFromSim = sim?.ok && sim.gasEstimate ? BigInt(sim.gasEstimate) : null;
  const gasEstimate = gasFromSim !== null ? (gasFromSim + gasFromSim / 5n).toString() : enc.defaultGas.toString();
  return {
    network: cfg.name,
    chainId: cfg.chainId,
    realMoney: cfg.realMoney,
    action: enc.action,
    from,
    to: enc.to,
    data: enc.data,
    value: '0',
    gasEstimate,
    gasEstimateSource: gasFromSim !== null ? 'estimateGas' : 'default',
    description: enc.description,
    humanReadableSummary: enc.humanReadableSummary,
    warnings: [...enc.warnings, ...extraWarnings],
    call: { contract: enc.target, contractAddress: enc.to, function: enc.functionName, args: enc.args },
    prerequisite,
    simulation: sim,
    signingInstructions: SIGNING_INSTRUCTIONS,
  };
}

/** Build the exact-amount approve prerequisite for `needed` if the current allowance is short. */
function approvePrerequisite(cfg: NetworkConfig, from: string, needed: bigint, allowance: bigint, why: string): { tx: PreparedTx | null; warning?: string } {
  if (needed === 0n || allowance >= needed) return { tx: null };
  const enc = encodeAction(cfg, 'approve_usdc', { amount: formatUsdc(needed) }, from);
  const tx = toPrepared(cfg, from, enc, [`Approving exactly ${formatUsdc(needed)} USDC for: ${why}. Current allowance is ${formatUsdc(allowance)} USDC.`], null, null);
  return { tx, warning: `Marketplace allowance (${formatUsdc(allowance)} USDC) is below the ${formatUsdc(needed)} USDC this call pulls. Send \`prerequisite\` (exact approve) first or the main transaction will revert.` };
}

export interface PrepareOptions {
  simulate?: boolean;
}

export async function prepareTx(cfg: NetworkConfig, action: WriteAction, rawArgs: unknown, opts: PrepareOptions = {}): Promise<PreparedTx> {
  const a = requireObject(rawArgs ?? {});
  const from = validateAddress(a.from, 'from');
  const simulate = validateBoolean(a.simulate ?? opts.simulate, 'simulate', false);
  const enc = encodeAction(cfg, action, a, from);
  const c = getContracts(cfg);
  const mp = cfg.addresses.marketplace;
  const warnings: string[] = [];
  let prerequisite: PreparedTx | null = null;

  const agentIdOf = async (addr: string) => Number((await c.registry.addressToAgentId(addr)) as bigint);

  switch (action) {
    case 'register_agent': {
      if ((await agentIdOf(from)) !== 0) warnings.push('This wallet is already registered; the transaction will revert.');
      break;
    }
    case 'create_pool': {
      const id = await agentIdOf(from);
      if (id === 0) warnings.push('This wallet is not registered; send register_agent first or this will revert.');
      else if ((await c.marketplace.agentPools(id)).isActive) warnings.push(`Agent #${id} already has a pool; the transaction will revert.`);
      break;
    }
    case 'approve_usdc': {
      const bal = (await c.usdc.balanceOf(from)) as bigint;
      const amt = BigInt(enc.args.amount);
      if (amt > bal) warnings.push(`Approving ${formatUsdc(amt)} USDC but wallet holds only ${formatUsdc(bal)} USDC.`);
      break;
    }
    case 'supply_liquidity': {
      const agentId = Number(enc.args.agentId);
      const amt = enc.pullsUsdc!;
      const [pool, allowance, bal, minSupply] = await Promise.all([
        c.marketplace.agentPools(agentId),
        c.usdc.allowance(from, mp) as Promise<bigint>,
        c.usdc.balanceOf(from) as Promise<bigint>,
        c.marketplace.minSupplyAmount() as Promise<bigint>,
      ]);
      if (!pool.isActive) warnings.push(`Agent #${agentId} has no active pool; the transaction will revert.`);
      if (amt < minSupply) warnings.push(`Amount is below the minimum supply of ${formatUsdc(minSupply)} USDC.`);
      if (amt > bal) warnings.push(`Wallet holds ${formatUsdc(bal)} USDC, less than the ${formatUsdc(amt)} USDC being supplied.`);
      const pre = approvePrerequisite(cfg, from, amt, allowance, `supplyLiquidity(${agentId}, ${formatUsdc(amt)})`);
      prerequisite = pre.tx;
      if (pre.warning) warnings.push(pre.warning);
      break;
    }
    case 'withdraw_liquidity': {
      const agentId = Number(enc.args.agentId);
      const amt = BigInt(enc.args.amount);
      const [pos, pool] = await Promise.all([c.marketplace.getLenderPosition(agentId, from), c.marketplace.agentPools(agentId)]);
      if ((pos.amount as bigint) < amt) warnings.push(`You have ${formatUsdc(pos.amount)} USDC supplied in pool #${agentId}, less than the ${formatUsdc(amt)} requested; the transaction will revert.`);
      if ((pool.availableLiquidity as bigint) < amt) warnings.push(`Pool #${agentId} only has ${formatUsdc(pool.availableLiquidity)} USDC available (rest is lent out); withdraw less or wait for repayments.`);
      break;
    }
    case 'request_loan': {
      const amt = BigInt(enc.args.amount);
      const id = await agentIdOf(from);
      if (id === 0) {
        warnings.push('This wallet is not registered as an agent; register_agent + create_pool are required first.');
        break;
      }
      const [pool, limit, outstanding, collateralPct, rateBps, active, maxActive, bind, allowance, bal, paused] = await Promise.all([
        c.marketplace.agentPools(id),
        c.reputation.calculateCreditLimit(from) as Promise<bigint>,
        c.marketplace.outstandingPrincipal(id) as Promise<bigint>,
        c.reputation.calculateCollateralRequirement(from) as Promise<bigint>,
        c.reputation.calculateInterestRate(from) as Promise<bigint>,
        c.marketplace.activeLoanCount(id) as Promise<bigint>,
        c.marketplace.MAX_ACTIVE_LOANS_PER_AGENT() as Promise<bigint>,
        c.marketplace.bindBorrowToPoolCreator() as Promise<boolean>,
        c.usdc.allowance(from, mp) as Promise<bigint>,
        c.usdc.balanceOf(from) as Promise<bigint>,
        c.marketplace.paused() as Promise<boolean>,
      ]);
      if (paused) warnings.push('The marketplace is paused; the transaction will revert.');
      if (!pool.isActive) warnings.push(`Agent #${id} has no pool; send create_pool first.`);
      else if ((pool.availableLiquidity as bigint) < amt) warnings.push(`Pool #${id} has only ${formatUsdc(pool.availableLiquidity)} USDC available; the request for ${formatUsdc(amt)} USDC will revert.`);
      if (bind && pool.isActive && String(pool.agentAddress).toLowerCase() !== from.toLowerCase()) warnings.push('Borrowing is restricted to the pool creator on this network.');
      if (outstanding + amt > limit) warnings.push(`Outstanding ${formatUsdc(outstanding)} + ${formatUsdc(amt)} exceeds credit limit ${formatUsdc(limit)} USDC.`);
      if (active >= maxActive) warnings.push(`Already at the maximum of ${maxActive} active loans.`);
      const collateral = (amt * collateralPct) / 100n;
      const durationDays = Number(enc.args.durationDays);
      const interest = (await c.marketplace.calculateInterest(amt, rateBps, BigInt(durationDays) * 86400n)) as bigint;
      enc.args.collateralRequired = collateral.toString();
      enc.args.collateralRequiredUsdc = formatUsdc(collateral);
      enc.args.collateralPercent = collateralPct.toString();
      enc.args.interestRateBps = rateBps.toString();
      enc.args.projectedInterestUsdc = formatUsdc(interest);
      enc.args.projectedTotalRepaymentUsdc = formatUsdc(amt + interest);
      enc.humanReadableSummary += ` At your current tier: ${Number(rateBps) / 100}% APR, ${collateralPct}% collateral (${formatUsdc(collateral)} USDC), projected repayment ${formatUsdc(amt + interest)} USDC.`;
      if (collateral > 0n) {
        if (collateral > bal) warnings.push(`Collateral of ${formatUsdc(collateral)} USDC exceeds wallet balance ${formatUsdc(bal)} USDC.`);
        const pre = approvePrerequisite(cfg, from, collateral, allowance, `collateral for requestLoan(${formatUsdc(amt)}, ${durationDays}d)`);
        prerequisite = pre.tx;
        if (pre.warning) warnings.push(pre.warning);
      }
      break;
    }
    case 'repay_loan': {
      const loanId = Number(enc.args.loanId);
      const l = await c.marketplace.loans(loanId);
      if (l.borrower === ethers.ZeroAddress) {
        warnings.push(`Loan #${loanId} does not exist on ${cfg.name}.`);
        break;
      }
      const state = LOAN_STATES[Number(l.state)];
      if (String(l.borrower).toLowerCase() !== from.toLowerCase()) warnings.push(`Loan #${loanId} belongs to ${l.borrower}, not ${from}; the transaction will revert.`);
      if (state !== 'ACTIVE') warnings.push(`Loan #${loanId} is ${state}, not ACTIVE; the transaction will revert.`);
      const interest = (await c.marketplace.calculateInterest(l.amount, l.interestRate, l.duration)) as bigint;
      const total = (l.amount as bigint) + interest;
      const [allowance, bal] = await Promise.all([c.usdc.allowance(from, mp) as Promise<bigint>, c.usdc.balanceOf(from) as Promise<bigint>]);
      enc.args.principalUsdc = formatUsdc(l.amount);
      enc.args.interestUsdc = formatUsdc(interest);
      enc.args.totalRepaymentUsdc = formatUsdc(total);
      enc.humanReadableSummary += ` Total due: ${formatUsdc(total)} USDC (${formatUsdc(l.amount)} principal + ${formatUsdc(interest)} interest).`;
      if (total > bal) warnings.push(`Wallet holds ${formatUsdc(bal)} USDC, less than the ${formatUsdc(total)} USDC due.`);
      if (state === 'ACTIVE') {
        const pre = approvePrerequisite(cfg, from, total, allowance, `repayLoan(${loanId})`);
        prerequisite = pre.tx;
        if (pre.warning) warnings.push(pre.warning);
      }
      break;
    }
    case 'claim_interest': {
      const agentId = Number(enc.args.agentId);
      const pos = await c.marketplace.getLenderPosition(agentId, from);
      enc.args.claimableUsdc = formatUsdc(pos.earnedInterest);
      if ((pos.earnedInterest as bigint) === 0n) warnings.push(`No claimable interest for ${from} in pool #${agentId}; the transaction will revert.`);
      break;
    }
  }

  const sim = simulate ? await simulateCall(cfg, from, enc.to, enc.data) : null;
  if (sim && !sim.ok && prerequisite) {
    sim.plainLanguage = `${sim.plainLanguage} (A prerequisite approve is included in this response; simulate again after it is mined.)`;
  }
  return toPrepared(cfg, from, enc, warnings, prerequisite, sim);
}
