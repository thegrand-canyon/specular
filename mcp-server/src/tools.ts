/**
 * Shared tool registry: one definition per capability, used by the stdio MCP
 * server, the remote (Streamable HTTP) MCP server, the REST routes and the
 * OpenAPI generator. Handlers take already-JSON-parsed arguments and return
 * plain JSON-serialisable objects; they throw ValidationError / NetworkError
 * for 4xx conditions.
 */
import { ALL_NETWORKS, enabledNetworks, getNetwork, NetworkConfig, publicNetworkInfo } from './networks.js';
import { broadcastSignedTx } from './broadcast.js';
import { prepareTx, simulateCall, WriteAction } from './prepare.js';
import {
  readActiveLoanIds,
  readAgentLoans,
  readCanTopUp,
  readCredit,
  readLoan,
  readNetworkInfo,
  readPoolDetails,
  readPools,
  readPositions,
  readProtocolStatus,
  readRepaymentPreview,
  readRequiredSelfStake,
  readSelfStake,
  readTransaction,
} from './reads.js';
import { optionalInteger, optionalUsdc, requireObject, validateAddress, validateAmountUsdc, validateHexData, validateId, validateTxHash, ValidationError } from './validate.js';
import { CacheStats, registerCache, stableKey, TtlCache } from './cache.js';
import { STALE_AFTER_SECONDS } from './chain.js';

export type ToolKind = 'read' | 'prepare' | 'simulate' | 'broadcast';

export interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolDef {
  name: string;
  kind: ToolKind;
  description: string;
  inputSchema: JsonSchema;
  /** REST binding used by http.ts and the OpenAPI generator. */
  rest: { method: 'GET' | 'POST'; path: string; pathParams?: string[] };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

const NETWORK_PROP = {
  type: 'string',
  enum: [...ALL_NETWORKS],
  description:
    'REQUIRED, no default. "arc-staging" = Arc testnet V6-staging (test USDC, safe to experiment). "base" and "arc-mainnet" move REAL USDC.',
};
const ADDRESS_PROP = (what: string) => ({ type: 'string', pattern: '^0x[0-9a-fA-F]{40}$', description: `${what} (0x-prefixed, EIP-55 checksum accepted)` });
const FROM_PROP = {
  type: 'string',
  pattern: '^0x[0-9a-fA-F]{40}$',
  description: 'The address of YOUR wallet that will sign and send this transaction. The server never sees your key.',
};
const AMOUNT_PROP = (what: string) => ({
  type: ['number', 'string'],
  description: `${what} in USDC display units (e.g. 12.5 = 12.5 USDC, max 6 decimals). Capped per call by the server.`,
});
const SIMULATE_PROP = {
  type: 'boolean',
  default: false,
  description: 'If true, run eth_call + estimateGas from `from` and report success or the revert reason in plain language.',
};
const ID_PROP = (what: string) => ({ type: 'integer', minimum: 1, description: what });

function schema(properties: Record<string, unknown>, required: string[]): JsonSchema {
  return { type: 'object', properties, required, additionalProperties: false };
}

function net(args: Record<string, unknown>): NetworkConfig {
  return getNetwork(args.network);
}

function prepareTool(action: WriteAction, name: string, description: string, extraProps: Record<string, unknown>, extraRequired: string[]): ToolDef {
  return {
    name,
    kind: 'prepare',
    description: `${description} Returns an UNSIGNED transaction {chainId,to,data,value:"0",gasEstimate,...} for YOUR wallet to sign; never executes anything. If a USDC approval is needed first, an exact-amount approve is returned in \`prerequisite\`.`,
    inputSchema: schema({ network: NETWORK_PROP, from: FROM_PROP, ...extraProps, simulate: SIMULATE_PROP }, ['network', 'from', ...extraRequired]),
    rest: { method: 'POST', path: `/v1/{network}/tx/prepare/${action}`, pathParams: ['network'] },
    handler: async (args) => prepareTx(net(args), action, args),
  };
}

const BASE_TOOLS: ToolDef[] = [
  // ------------------------------------------------------------------ reads
  {
    name: 'list_networks',
    kind: 'read',
    description: 'List the networks this server can serve, their chain IDs, contract addresses and whether they move real USDC. Call this first.',
    inputSchema: schema({}, []),
    rest: { method: 'GET', path: '/v1/networks' },
    handler: async () => ({
      networks: enabledNetworks().map((n) => publicNetworkInfo(getNetwork(n))),
      note: 'Every other tool requires an explicit `network`. Use arc-staging to test; base and arc-mainnet are real money.',
    }),
  },
  {
    name: 'get_network_info',
    kind: 'read',
    description: 'Contract addresses, chainId, explorer and live RPC block/staleness for one network.',
    inputSchema: schema({ network: NETWORK_PROP }, ['network']),
    rest: { method: 'GET', path: '/v1/{network}/network', pathParams: ['network'] },
    handler: async (args) => readNetworkInfo(net(args)),
  },
  {
    name: 'get_protocol_status',
    kind: 'read',
    description:
      'Protocol-wide statistics for a network: paused flag, pools, loans, TVL, available liquidity, live parameters (min supply, fee, loan limits), the deployment capability matrix (marketplace V6 / V6.1 / V6.2 and reputation V3 / V4), and creditTiers — the CREDIT TIER TABLE read live from the contract. On ReputationManagerV4 that table is owner-settable on-chain state bounded by an immutable MAX_TIER_LIMIT, so read it from here rather than hardcoding limits.',
    inputSchema: schema({ network: NETWORK_PROP }, ['network']),
    rest: { method: 'GET', path: '/v1/{network}/status', pathParams: ['network'] },
    handler: async (args) => readProtocolStatus(net(args)),
  },
  {
    name: 'check_credit_score',
    kind: 'read',
    description:
      'Credit profile of an agent wallet: registration, reputation score (0-1000) and tier, credit limit, remaining credit, collateral %, APR, active loans, plus USDC balance and current marketplace allowance. On a V7 deployment it also returns credit.model (why the limit is what it is: tier limit vs credit ladder, and whether the agent is LOCKED OUT after a default, which makes the limit exactly 0) and selfStake (the agent\'s own locked first-loss capital). Never assume a tier table client-side: every limit here is read from the chain.',
    inputSchema: schema({ network: NETWORK_PROP, address: ADDRESS_PROP('Agent wallet address') }, ['network', 'address']),
    rest: { method: 'GET', path: '/v1/{network}/agents/{address}/credit', pathParams: ['network', 'address'] },
    handler: async (args) => readCredit(net(args), validateAddress(args.address)),
  },
  {
    name: 'get_available_liquidity',
    kind: 'read',
    description: 'Active agent pools sorted by available USDC (for lenders choosing where to supply, or to see borrowing capacity).',
    inputSchema: schema(
      {
        network: NETWORK_PROP,
        minAvailableUsdc: { type: 'number', minimum: 0, description: 'Only pools with at least this much available USDC (optional)' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
      },
      ['network'],
    ),
    rest: { method: 'GET', path: '/v1/{network}/pools', pathParams: ['network'] },
    handler: async (args) => {
      const cfg = net(args);
      // validate before any RPC (H-4: 7-decimal / exponent values used to reach ethers.parseUnits and surface as 502)
      const minAvailableUsdc = optionalUsdc(args.minAvailableUsdc, 'minAvailableUsdc');
      const limit = optionalInteger(args.limit, 'limit', { min: 1, max: 200 });
      return readPools(cfg, { minAvailableUsdc, limit });
    },
  },
  {
    name: 'get_pool_details',
    kind: 'read',
    description: 'Detailed view of one agent pool (pools are keyed by agentId): liquidity, utilization, lenders, borrower reputation and terms.',
    inputSchema: schema({ network: NETWORK_PROP, agentId: ID_PROP('Agent ID whose pool to inspect') }, ['network', 'agentId']),
    rest: { method: 'GET', path: '/v1/{network}/pools/{agentId}', pathParams: ['network', 'agentId'] },
    handler: async (args) => readPoolDetails(net(args), validateId(args.agentId, 'agentId')),
  },
  {
    name: 'get_loan_status',
    kind: 'read',
    description: 'Status of a loan by ID: borrower, principal, collateral, APR, due date, state (REQUESTED/ACTIVE/REPAID/DEFAULTED) and, if active, the exact repayment amount (V6.1: previewRepayment incl. any late interest; V6: fixed-term interest).',
    inputSchema: schema({ network: NETWORK_PROP, loanId: ID_PROP('Loan ID') }, ['network', 'loanId']),
    rest: { method: 'GET', path: '/v1/{network}/loans/{loanId}', pathParams: ['network', 'loanId'] },
    handler: async (args) => readLoan(net(args), validateId(args.loanId, 'loanId')),
  },
  {
    name: 'get_agent_loans',
    kind: 'read',
    description: 'Loans taken by a wallet (most recent first).',
    inputSchema: schema({ network: NETWORK_PROP, address: ADDRESS_PROP('Borrower wallet address'), limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }, ['network', 'address']),
    rest: { method: 'GET', path: '/v1/{network}/agents/{address}/loans', pathParams: ['network', 'address'] },
    handler: async (args) => {
      const cfg = net(args);
      const address = validateAddress(args.address);
      const limit = optionalInteger(args.limit, 'limit', { min: 1, max: 200 });
      return readAgentLoans(cfg, address, { limit });
    },
  },
  {
    name: 'get_lending_positions',
    kind: 'read',
    description: 'Lender positions of a wallet across all active pools: supplied principal and claimable interest per pool.',
    inputSchema: schema({ network: NETWORK_PROP, address: ADDRESS_PROP('Lender wallet address') }, ['network', 'address']),
    rest: { method: 'GET', path: '/v1/{network}/agents/{address}/positions', pathParams: ['network', 'address'] },
    handler: async (args) => readPositions(net(args), validateAddress(args.address)),
  },
  {
    name: 'preview_repayment',
    kind: 'read',
    description:
      'V6.1 only: the EXACT USDC amount repayLoan(loanId) would pull right now (principal + interest on max(duration, elapsed), capped at duration + 30 days). Use this, not principal + nominal interest, to size the repay approval; a late loan owes more and the figure grows per second until it caps. On a V6 deployment this returns a "not supported" error (get_loan_status.repayment still works there).',
    inputSchema: schema({ network: NETWORK_PROP, loanId: ID_PROP('Loan ID (must be ACTIVE)') }, ['network', 'loanId']),
    rest: { method: 'GET', path: '/v1/{network}/loans/{loanId}/repayment', pathParams: ['network', 'loanId'] },
    handler: async (args) => readRepaymentPreview(net(args), validateId(args.loanId, 'loanId')),
  },
  {
    name: 'can_top_up',
    kind: 'read',
    description:
      'V6.1 only: whether `lender` can add to an EXISTING position in agent pool `agentId` right now without supplyLiquidity reverting "Top-up would forfeit in-flight interest". ADVISORY, not a guarantee: the deployed canTopUp() view is off by one block, so this server also computes the corrected predicate server-side and returns the conservative answer (`onChainView` and `correctedPredicate` show both, `viewDisagrees` flags a mismatch); a loan can also start between this check and your transaction. Always read `warnings` and simulate immediately before signing. A first supply is never refused. Returns a "not supported" error on V6 deployments (which never refuse top-ups).',
    inputSchema: schema({ network: NETWORK_PROP, agentId: ID_PROP('Agent ID of the pool'), lender: ADDRESS_PROP('Lender wallet address (the one that would send supplyLiquidity)') }, ['network', 'agentId', 'lender']),
    rest: { method: 'GET', path: '/v1/{network}/pools/{agentId}/can-top-up/{lender}', pathParams: ['network', 'agentId', 'lender'] },
    handler: async (args) => readCanTopUp(net(args), validateId(args.agentId, 'agentId'), validateAddress(args.lender, 'lender')),
  },
  {
    name: 'get_active_loan_ids',
    kind: 'read',
    description: 'V6.1 only: IDs (and status) of an agent\'s currently ACTIVE loans, straight from the contract\'s bounded active set (at most MAX_ACTIVE_LOANS_PER_AGENT). Returns a "not supported" error on V6 deployments; use get_agent_loans there.',
    inputSchema: schema({ network: NETWORK_PROP, agentId: ID_PROP('Agent ID') }, ['network', 'agentId']),
    rest: { method: 'GET', path: '/v1/{network}/agents/{agentId}/active-loans', pathParams: ['network', 'agentId'] },
    handler: async (args) => readActiveLoanIds(net(args), validateId(args.agentId, 'agentId')),
  },
  {
    name: 'required_self_stake',
    kind: 'read',
    description:
      'V6.2 (V7 credit model) only: how much of its OWN first-loss capital an agent must already hold in its OWN pool before it could borrow `additionalAmount` more. Any exposure the collateral percentage does not cover must be backed at creditMultiple leverage, or requestLoan reverts "Insufficient self-stake". Returns the requirement, what the agent currently holds and the exact shortfall to supply. Pass additionalAmount 0 to price the exposure already outstanding. Returns a "not supported" error on V6 / V6.1 deployments, which have no such requirement (Base mainnet and the current Arc deployments are in that group).',
    inputSchema: schema(
      {
        network: NETWORK_PROP,
        agentId: ID_PROP('Agent ID whose pool holds the self-stake'),
        additionalAmount: { ...AMOUNT_PROP('Additional principal the agent wants to borrow'), default: 0 },
      },
      ['network', 'agentId'],
    ),
    rest: { method: 'GET', path: '/v1/{network}/agents/{agentId}/required-self-stake', pathParams: ['network', 'agentId'] },
    handler: async (args) => {
      const cfg = net(args);
      const agentId = validateId(args.agentId, 'agentId');
      const additional =
        args.additionalAmount === undefined || args.additionalAmount === null || args.additionalAmount === ''
          ? 0n
          : validateAmountUsdc(args.additionalAmount, 'additionalAmount', { allowZero: true });
      return readRequiredSelfStake(cfg, agentId, additional);
    },
  },
  {
    name: 'get_self_stake',
    kind: 'read',
    description:
      'V6.2 (V7 credit model) only: the pool creator\'s own position in its own pool — the agent\'s first-loss capital — and whether it is currently LOCKED. It is locked for as long as the agent carries outstanding principal (withdrawLiquidity then reverts "Self-stake locked while borrowing") and on a default it absorbs the loss BEFORE any third-party lender. Use this before prepare_withdraw_liquidity, and to render an agent\'s own position as subordinated capital rather than ordinary liquidity. Returns a "not supported" error on V6 / V6.1 deployments.',
    inputSchema: schema({ network: NETWORK_PROP, agentId: ID_PROP('Agent ID of the pool') }, ['network', 'agentId']),
    rest: { method: 'GET', path: '/v1/{network}/agents/{agentId}/self-stake', pathParams: ['network', 'agentId'] },
    handler: async (args) => readSelfStake(net(args), validateId(args.agentId, 'agentId')),
  },
  {
    name: 'get_transaction',
    kind: 'read',
    description: 'Look up a transaction hash: pending/confirmed/reverted plus decoded Specular events (e.g. LoanRequested with the new loanId).',
    inputSchema: schema({ network: NETWORK_PROP, hash: { type: 'string', pattern: '^0x[0-9a-fA-F]{64}$', description: 'Transaction hash' } }, ['network', 'hash']),
    rest: { method: 'GET', path: '/v1/{network}/tx/{hash}', pathParams: ['network', 'hash'] },
    handler: async (args) => readTransaction(net(args), validateTxHash(args.hash)),
  },

  // --------------------------------------------------------------- prepares
  prepareTool(
    'register_agent',
    'prepare_register_agent',
    'Prepare the one-time agent registration for `from`.',
    {
      agentURI: { type: 'string', maxLength: 512, description: 'Metadata URI for the agent (default: specular://<from>)' },
      metadata: {
        type: 'array',
        maxItems: 16,
        description: 'Optional key/value metadata stored on-chain',
        items: { type: 'object', properties: { key: { type: 'string', maxLength: 64 }, value: { type: 'string', maxLength: 1024 } }, required: ['key', 'value'], additionalProperties: false },
      },
    },
    [],
  ),
  prepareTool('create_pool', 'prepare_create_pool', 'Prepare creation of the agent liquidity pool for `from` (required once after registration, before borrowing).', {}, []),
  prepareTool(
    'approve_usdc',
    'prepare_approve_usdc',
    'Prepare an EXACT-amount USDC approval to the Specular marketplace (0 revokes). Unlimited approvals are never produced.',
    { amount: AMOUNT_PROP('Exact amount to approve') },
    ['amount'],
  ),
  prepareTool(
    'supply_liquidity',
    'prepare_supply_liquidity',
    'Prepare supplying USDC into an agent pool as a lender. Also the way an agent posts its OWN first-loss self-stake on a V6.2 deployment (supply into your own pool) — the pool creator is exempt from the minimum supply there, and that position is then locked while the agent borrows.',
    { agentId: ID_PROP('Agent ID of the pool to supply'), amount: AMOUNT_PROP('Amount to supply') },
    ['agentId', 'amount'],
  ),
  prepareTool(
    'withdraw_liquidity',
    'prepare_withdraw_liquidity',
    'Prepare withdrawal of supplied principal from an agent pool. On a V6.2 deployment a POOL CREATOR\'s own position is first-loss capital and is LOCKED while the agent carries outstanding principal: the response warns and the transaction would revert "Self-stake locked while borrowing". Ordinary lenders are never locked.',
    { agentId: ID_PROP('Agent ID of the pool'), amount: AMOUNT_PROP('Amount to withdraw') },
    ['agentId', 'amount'],
  ),
  prepareTool(
    'request_loan',
    'prepare_request_loan',
    'Prepare a loan request against `from`\'s reputation. Includes projected interest, collateral and (if needed) the exact collateral approve. On a V6.2 deployment it also checks the first-loss SELF-STAKE gate and returns requiredSelfStakeUsdc / currentSelfStakeUsdc / selfStakeShortfallUsdc, warning before the "Insufficient self-stake" revert; on V7 it also flags a post-default LOCKOUT, which makes the credit limit exactly 0.',
    { amount: AMOUNT_PROP('Loan principal'), durationDays: { type: 'integer', minimum: 7, maximum: 365, description: 'Loan term in DAYS (7-365)' } },
    ['amount', 'durationDays'],
  ),
  prepareTool(
    'repay_loan',
    'prepare_repay_loan',
    'Prepare full repayment of a loan (principal + interest; on V6.1 a LATE loan pays for the elapsed time, capped at duration + 30 days, sized from previewRepayment). Includes the exact approve if the allowance is short (bounded headroom only for an accruing late loan).',
    { loanId: ID_PROP('Loan ID to repay') },
    ['loanId'],
  ),
  prepareTool('claim_interest', 'prepare_claim_interest', 'Prepare claiming earned lender interest from an agent pool.', { agentId: ID_PROP('Agent ID of the pool') }, ['agentId']),

  // --------------------------------------------------------------- simulate
  {
    name: 'simulate_transaction',
    kind: 'simulate',
    description: 'Dry-run any prepared Specular transaction (eth_call + estimateGas from `from`) and explain a revert in plain language. `to` must be a Specular contract on the network.',
    inputSchema: schema(
      { network: NETWORK_PROP, from: FROM_PROP, to: ADDRESS_PROP('Target contract (marketplace, registry or USDC of that network)'), data: { type: 'string', pattern: '^0x[0-9a-fA-F]*$', description: 'Calldata from a prepared transaction' } },
      ['network', 'from', 'to', 'data'],
    ),
    rest: { method: 'POST', path: '/v1/{network}/tx/simulate', pathParams: ['network'] },
    handler: async (args) => {
      const cfg = net(args);
      const from = validateAddress(args.from, 'from');
      const to = validateAddress(args.to, 'to');
      const known = Object.values(cfg.addresses);
      if (!known.includes(to)) throw new ValidationError(`to=${to} is not a Specular contract on ${cfg.name}`, 'to');
      const data = validateHexData(args.data, 'data');
      const sim = await simulateCall(cfg, from, to, data);
      return { network: cfg.name, chainId: cfg.chainId, to, data, ...sim };
    },
  },

  // -------------------------------------------------------------- broadcast
  {
    name: 'broadcast_signed_transaction',
    kind: 'broadcast',
    description:
      'Relay a transaction YOU already signed (raw hex) to the network, for agents without their own RPC. Only accepted if it calls a Specular contract on that network (or is an exact USDC approve to the Specular marketplace); everything else is rejected.',
    inputSchema: schema({ network: NETWORK_PROP, signedTransaction: { type: 'string', pattern: '^0x[0-9a-fA-F]+$', description: 'RLP-encoded signed transaction hex' } }, ['network', 'signedTransaction']),
    rest: { method: 'POST', path: '/v1/{network}/tx/broadcast', pathParams: ['network'] },
    handler: async (args) => broadcastSignedTx(net(args), args.signedTransaction),
  },
];

// ---------------------------------------------------------------------------
// Read-route response cache (2026-09-22 RPC-resilience round)
//
// rpc.ts already caches and coalesces at the JSON-RPC level; this second, route-
// level layer exists for the thing the JSON-RPC layer cannot express: a PER-ROUTE
// TTL that can depend on the ANSWER. A REPAID/DEFAULTED loan and a mined
// transaction can never change, so they are cached for minutes, while live
// protocol state is cached for seconds. It also saves the ABI decode and the
// per-request fan-out entirely on a hit (a /status read is ~27 eth_calls).
//
// Only `kind: 'read'` tools are cached. prepare/simulate/broadcast never are.
// ---------------------------------------------------------------------------

const readCache = new TtlCache<unknown>(Number(process.env.SPECULAR_READ_CACHE_MAX_ENTRIES || 5_000));
registerCache(readCache as unknown as TtlCache<never>);

const readCacheEnabled = (): boolean => !/^(0|false|off|no)$/i.test((process.env.SPECULAR_READ_CACHE ?? '1').trim());
const readTtlMs = (): number => {
  const n = Number(process.env.SPECULAR_READ_CACHE_MS ?? 3_000);
  return Number.isFinite(n) && n >= 0 ? n : 3_000;
};
const readImmutableTtlMs = (): number => {
  const n = Number(process.env.SPECULAR_READ_CACHE_IMMUTABLE_MS ?? 300_000);
  return Number.isFinite(n) && n >= 0 ? n : 300_000;
};

/** Tools whose answer never depends on the chain: no cache needed (and no RPC to save). */
const NO_CACHE_READS = new Set(['list_networks']);

/** True when this result can never change again, so it may be cached for minutes. */
export function isImmutableRead(toolName: string, result: unknown): boolean {
  const r = result as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') return false;
  if (toolName === 'get_loan') return r.state === 'REPAID' || r.state === 'DEFAULTED';
  if (toolName === 'get_transaction') return r.found === true && (r.status === 'confirmed' || r.status === 'reverted') && r.blockNumber != null;
  return false;
}

export function readTtlFor(toolName: string, result: unknown): number {
  if (!readCacheEnabled()) return 0;
  return isImmutableRead(toolName, result) ? readImmutableTtlMs() : readTtlMs();
}

/**
 * Stamp a cached body honestly: say it is cached and how old it is, and
 * recompute block staleness from the cached block timestamp so `rpc.ageSeconds`
 * and `rpc.stale` never lie about how fresh the chain view is.
 */
function stampCached(value: unknown, ageMs: number): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = { ...(value as Record<string, unknown>), cached: true, cacheAgeMs: ageMs };
  const rpc = out.rpc as { blockTimestamp?: number } | undefined;
  if (rpc && typeof rpc.blockTimestamp === 'number') {
    const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - rpc.blockTimestamp);
    const stale = ageSeconds > STALE_AFTER_SECONDS;
    out.rpc = {
      ...rpc,
      ageSeconds,
      stale,
      ...(stale ? { warning: `RPC data may be stale: latest block is ${ageSeconds}s old (> ${STALE_AFTER_SECONDS}s). Values below may not reflect current chain state.` } : {}),
    };
  }
  return out;
}

function withReadCache(t: ToolDef): ToolDef {
  if (t.kind !== 'read' || NO_CACHE_READS.has(t.name)) return t;
  const inner = t.handler;
  return {
    ...t,
    handler: async (args) => {
      if (!readCacheEnabled()) return inner(args);
      const key = `${t.name}|${stableKey(args)}`;
      return readCache.wrap(key, (v) => readTtlFor(t.name, v), () => inner(args), stampCached);
    },
  };
}

export const TOOLS: ToolDef[] = BASE_TOOLS.map(withReadCache);

/** Read-route cache counters for /rpc-health. */
export function readCacheStats(): CacheStats {
  return readCache.stats();
}

/** Test/ops hook. */
export function _resetReadCache(): void {
  readCache.clear();
  readCache.resetStats();
}

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

export async function callTool(name: string, rawArgs: unknown): Promise<unknown> {
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) throw new ValidationError(`Unknown tool: ${name}`);
  const args = rawArgs === undefined || rawArgs === null ? {} : requireObject(rawArgs);
  return tool.handler(args);
}

/** MCP annotations derived from tool kind. */
export function toolAnnotations(t: ToolDef) {
  return {
    title: t.name,
    readOnlyHint: t.kind === 'read' || t.kind === 'simulate' || t.kind === 'prepare',
    destructiveHint: t.kind === 'broadcast',
    idempotentHint: t.kind !== 'broadcast',
    openWorldHint: true,
  };
}
