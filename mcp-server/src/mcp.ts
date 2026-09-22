/**
 * MCP server factory shared by the stdio entry (index.ts) and the remote
 * Streamable HTTP entry (http.ts). Both expose exactly the tools in
 * tools.ts; the remote variant can never sign.
 *
 * Local-only extra: when SPECULAR_LOCAL_SIGNER=1 AND SPECULAR_PRIVATE_KEY is
 * set, the stdio server additionally offers `local_sign_and_broadcast`, which
 * signs a prepared transaction with the key held in the local process. The
 * signed bytes still go through the same allow-list validator as the public
 * relay before being sent.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ethers } from 'ethers';
import { broadcastSignedTx, validateSignedTx } from './broadcast.js';
import { describeRpcError, getProvider } from './chain.js';
import { errorFields, logger } from './logger.js';
import { ALL_NETWORKS, getNetwork, NetworkError } from './networks.js';
import { callTool, ToolDef, toolAnnotations, TOOLS } from './tools.js';
import { requireObject, validateAddress, validateHexData, ValidationError } from './validate.js';

export const SERVER_VERSION = '2.1.0';

export type Mode = 'local' | 'remote';

const INSTRUCTIONS = `Specular Protocol: on-chain credit for AI agents (borrow USDC against reputation, or lend into agent pools).
This server is NON-CUSTODIAL. Read tools query the chain. "prepare_*" tools return UNSIGNED transactions that you sign with your own wallet; "broadcast_signed_transaction" relays bytes you signed. Every tool needs an explicit "network": use "arc-staging" (testnet) to experiment; "base" and "arc-mainnet" move real USDC.
Typical borrower flow: check_credit_score -> (prepare_register_agent, prepare_create_pool once) -> prepare_request_loan (simulate:true) -> sign+send prerequisite approve if present -> sign+send loan tx -> get_transaction -> prepare_repay_loan before the due date.
V6.1 deployments charge a LATE loan interest for the elapsed time (capped at duration + 30 days): size the repay approval from preview_repayment / prepare_repay_loan's prerequisite, never from principal + nominal interest. Lenders with an existing position: call can_top_up before prepare_supply_liquidity, but treat it as ADVISORY - the deployed canTopUp() view is off by one block, so the server returns the conservative answer plus warnings, and a loan can start between the check and your tx; simulate the supply immediately before signing. preview_repayment, can_top_up and get_active_loan_ids return a "not supported" error on pre-V6.1 deployments.`;

export interface McpFactoryOptions {
  mode: Mode;
}

function localSignerEnabled(): boolean {
  return process.env.SPECULAR_LOCAL_SIGNER === '1' && !!process.env.SPECULAR_PRIVATE_KEY;
}

function toJson(x: unknown): string {
  return JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
}

/** Local-mode tool: sign a prepared tx with the process-local key and relay it. Never registered in remote mode. */
function localSignerTool(): ToolDef {
  return {
    name: 'local_sign_and_broadcast',
    kind: 'broadcast',
    description:
      'LOCAL ONLY (SPECULAR_LOCAL_SIGNER=1): sign a prepared transaction with the wallet configured in this process and broadcast it. The signed bytes are validated against the Specular contract allow-list before sending.',
    inputSchema: {
      type: 'object',
      properties: {
        network: { type: 'string', enum: [...ALL_NETWORKS] },
        to: { type: 'string', pattern: '^0x[0-9a-fA-F]{40}$' },
        data: { type: 'string', pattern: '^0x[0-9a-fA-F]*$' },
        gasLimit: { type: 'string', description: 'optional gas limit (default: estimate)' },
      },
      required: ['network', 'to', 'data'],
      additionalProperties: false,
    },
    rest: { method: 'POST', path: '/_local/sign' },
    handler: async (args) => {
      const cfg = getNetwork(args.network);
      const to = validateAddress(args.to, 'to');
      if (!Object.values(cfg.addresses).includes(to)) throw new ValidationError(`to=${to} is not a Specular contract on ${cfg.name}`, 'to');
      const data = validateHexData(args.data, 'data');
      const wallet = new ethers.Wallet(process.env.SPECULAR_PRIVATE_KEY as string, getProvider(cfg));
      const gasLimit = args.gasLimit !== undefined ? BigInt(String(args.gasLimit)) : await wallet.estimateGas({ to, data, value: 0n });
      const populated = await wallet.populateTransaction({ to, data, value: 0n, gasLimit, chainId: cfg.chainId });
      const raw = await wallet.signTransaction(populated);
      validateSignedTx(cfg, raw); // same allow-list as the public relay
      return broadcastSignedTx(cfg, raw);
    },
  };
}

export function toolsFor(mode: Mode): ToolDef[] {
  return mode === 'local' && localSignerEnabled() ? [...TOOLS, localSignerTool()] : TOOLS;
}

export function createMcpServer(opts: McpFactoryOptions): Server {
  const tools = toolsFor(opts.mode);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: 'specular', version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: toolAnnotations(t),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const started = Date.now();
    const tool = byName.get(name);
    if (!tool) {
      // MCP spec: an unknown tool is a protocol error (-32602), not a tool result.
      logger.info('tool', { transport: opts.mode, tool: name, ok: false, ms: 0, error: 'unknown tool' });
      throw new McpError(ErrorCode.InvalidParams, `Unknown tool: ${String(name).slice(0, 80)}`);
    }
    try {
      const args = request.params.arguments === undefined ? {} : requireObject(request.params.arguments);
      const result = tool === byName.get('local_sign_and_broadcast') ? await tool.handler(args) : await callTool(name, args);
      logger.info('tool', { transport: opts.mode, tool: name, network: args.network, ok: true, ms: Date.now() - started });
      return {
        content: [{ type: 'text', text: toJson(result) }],
        structuredContent: result as Record<string, unknown>,
      };
    } catch (e) {
      const expected = e instanceof ValidationError || e instanceof NetworkError;
      logger[expected ? 'info' : 'warn']('tool', { transport: opts.mode, tool: name, ok: false, ms: Date.now() - started, ...errorFields(e) });
      // H-13 (2026-09-21 review): only OUR OWN validation messages are safe to echo.
      // Anything else (an ethers/RPC failure) went back verbatim over MCP, leaking the
      // upstream endpoint ("connect ECONNREFUSED <host:port>") and library internals —
      // the REST path already sanitised this via describeRpcError().
      const message = expected ? (e as Error).message : describeRpcError(e);
      return {
        isError: true,
        content: [{ type: 'text', text: toJson({ error: message, ...(expected && (e as ValidationError).field ? { field: (e as ValidationError).field } : {}) }) }],
      };
    }
  });

  return server;
}
