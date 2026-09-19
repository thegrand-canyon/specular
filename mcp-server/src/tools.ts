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
  readAgentLoans,
  readCredit,
  readLoan,
  readNetworkInfo,
  readPoolDetails,
  readPools,
  readPositions,
  readProtocolStatus,
  readTransaction,
} from './reads.js';
import { optionalNumber, requireObject, validateAddress, validateHexData, validateId, validateTxHash, ValidationError } from './validate.js';

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

export const TOOLS: ToolDef[] = [
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
    description: 'Protocol-wide statistics for a network: paused flag, pools, loans, TVL, available liquidity, and live parameters (min supply, fee, loan limits).',
    inputSchema: schema({ network: NETWORK_PROP }, ['network']),
    rest: { method: 'GET', path: '/v1/{network}/status', pathParams: ['network'] },
    handler: async (args) => readProtocolStatus(net(args)),
  },
  {
    name: 'check_credit_score',
    kind: 'read',
    description:
      'Credit profile of an agent wallet: registration, reputation score (0-1000) and tier, credit limit, remaining credit, collateral %, APR, active loans, plus USDC balance and current marketplace allowance.',
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
    handler: async (args) =>
      readPools(net(args), {
        minAvailableUsdc: optionalNumber(args.minAvailableUsdc, 'minAvailableUsdc'),
        limit: optionalNumber(args.limit, 'limit', { min: 1, max: 200 }),
      }),
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
    description: 'Status of a loan by ID: borrower, principal, collateral, APR, due date, state (REQUESTED/ACTIVE/REPAID/DEFAULTED) and, if active, the exact repayment amount.',
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
    handler: async (args) => readAgentLoans(net(args), validateAddress(args.address), { limit: optionalNumber(args.limit, 'limit', { min: 1, max: 200 }) }),
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
    'Prepare supplying USDC into an agent pool as a lender.',
    { agentId: ID_PROP('Agent ID of the pool to supply'), amount: AMOUNT_PROP('Amount to supply') },
    ['agentId', 'amount'],
  ),
  prepareTool(
    'withdraw_liquidity',
    'prepare_withdraw_liquidity',
    'Prepare withdrawal of supplied principal from an agent pool.',
    { agentId: ID_PROP('Agent ID of the pool'), amount: AMOUNT_PROP('Amount to withdraw') },
    ['agentId', 'amount'],
  ),
  prepareTool(
    'request_loan',
    'prepare_request_loan',
    'Prepare a loan request against `from`\'s reputation. Includes projected interest, collateral and (if needed) the exact collateral approve.',
    { amount: AMOUNT_PROP('Loan principal'), durationDays: { type: 'integer', minimum: 7, maximum: 365, description: 'Loan term in DAYS (7-365)' } },
    ['amount', 'durationDays'],
  ),
  prepareTool('repay_loan', 'prepare_repay_loan', 'Prepare full repayment of a loan (principal + fixed interest); includes the exact approve if the allowance is short.', { loanId: ID_PROP('Loan ID to repay') }, ['loanId']),
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
