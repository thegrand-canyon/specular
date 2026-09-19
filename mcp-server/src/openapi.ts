/**
 * OpenAPI 3.1 document generated from the shared tool registry, so the REST
 * surface and the MCP tools can never drift apart.
 */
import { ALL_NETWORKS } from './networks.js';
import { SERVER_VERSION } from './mcp.js';
import { JsonSchema, TOOLS, ToolDef } from './tools.js';

const ERROR_SCHEMA = {
  type: 'object',
  properties: { error: { type: 'string' }, field: { type: 'string' } },
  required: ['error'],
};

const PREPARED_TX_SCHEMA = {
  type: 'object',
  description: 'An UNSIGNED transaction for the caller\'s own wallet to sign and broadcast.',
  properties: {
    network: { type: 'string', enum: [...ALL_NETWORKS] },
    chainId: { type: 'integer' },
    realMoney: { type: 'boolean' },
    action: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    data: { type: 'string' },
    value: { type: 'string', const: '0' },
    gasEstimate: { type: 'string' },
    gasEstimateSource: { type: 'string', enum: ['estimateGas', 'default'] },
    description: { type: 'string' },
    humanReadableSummary: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    call: { type: 'object' },
    prerequisite: { oneOf: [{ type: 'null' }, { $ref: '#/components/schemas/PreparedTransaction' }] },
    simulation: {
      oneOf: [
        { type: 'null' },
        {
          type: 'object',
          properties: {
            ok: { type: 'boolean' },
            gasEstimate: { type: ['string', 'null'] },
            revertReason: { type: ['string', 'null'] },
            plainLanguage: { type: ['string', 'null'] },
            from: { type: 'string' },
          },
        },
      ],
    },
    signingInstructions: { type: 'string' },
  },
  required: ['network', 'chainId', 'to', 'data', 'value', 'gasEstimate', 'description', 'humanReadableSummary', 'warnings'],
};

function errorResponses(withAuth: boolean) {
  const r: Record<string, unknown> = {
    '400': { description: 'Validation error (bad address/amount/network, unknown loan, etc.)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    '429': { description: 'Rate limited (per IP)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    '502': { description: 'Upstream RPC failure', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  };
  if (withAuth) r['401'] = { description: 'Missing/invalid bearer token (only when SPECULAR_MCP_TOKEN is configured)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
  return r;
}

function operationFor(t: ToolDef) {
  const pathParams = t.rest.pathParams ?? [];
  const props = t.inputSchema.properties;
  const parameters = pathParams.map((p) => ({ name: p, in: 'path', required: true, schema: stripDesc(props[p]) , description: (props[p] as { description?: string })?.description }));
  const remaining: JsonSchema = {
    type: 'object',
    properties: Object.fromEntries(Object.entries(props).filter(([k]) => !pathParams.includes(k))),
    required: (t.inputSchema.required ?? []).filter((k) => !pathParams.includes(k)),
    additionalProperties: false,
  };
  const op: Record<string, unknown> = {
    operationId: t.name,
    summary: t.name,
    description: t.description,
    tags: [t.kind],
    parameters,
    responses: {
      '200': {
        description: 'OK',
        content: { 'application/json': { schema: t.kind === 'prepare' ? { $ref: '#/components/schemas/PreparedTransaction' } : { type: 'object' } } },
      },
      ...errorResponses(true),
    },
  };
  if (t.rest.method === 'GET') {
    (op.parameters as unknown[]).push(
      ...Object.entries(remaining.properties).map(([name, s]) => ({ name, in: 'query', required: remaining.required?.includes(name) ?? false, schema: stripDesc(s), description: (s as { description?: string })?.description })),
    );
  } else {
    op.requestBody = { required: Object.keys(remaining.properties).length > 0, content: { 'application/json': { schema: remaining } } };
  }
  return op;
}

function stripDesc(s: unknown) {
  if (!s || typeof s !== 'object') return s;
  const { description: _d, ...rest } = s as Record<string, unknown>;
  return rest;
}

export function buildOpenApi(publicUrl?: string) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const t of TOOLS) {
    paths[t.rest.path] ??= {};
    paths[t.rest.path][t.rest.method.toLowerCase()] = operationFor(t);
  }
  paths['/health'] = {
    get: { operationId: 'health', summary: 'Liveness + per-network RPC staleness', tags: ['meta'], security: [], responses: { '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } } } },
  };
  paths['/mcp'] = {
    post: {
      operationId: 'mcp',
      summary: 'MCP Streamable HTTP endpoint (JSON-RPC 2.0). Same tools as the REST routes.',
      tags: ['meta'],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', description: 'JSON-RPC request (initialize, tools/list, tools/call)' } } } },
      responses: { '200': { description: 'JSON-RPC response (application/json or text/event-stream depending on Accept)' }, ...errorResponses(true) },
    },
  };
  return {
    openapi: '3.1.0',
    info: {
      title: 'Specular Protocol Agent API',
      version: SERVER_VERSION,
      summary: 'Non-custodial credit infrastructure for AI agents: reads execute server-side; writes are returned as unsigned transactions for your own wallet.',
      description:
        'Every route takes an explicit `network` path segment: `arc-staging` (Arc testnet V6-staging, test USDC), `base` (Base mainnet, REAL USDC) or `arc-mainnet` (Arc mainnet, REAL USDC). There is no default network. ' +
        'POST /v1/{network}/tx/prepare/{action} never executes anything: it returns `{chainId,to,data,value:"0",gasEstimate,...}` for you to sign. Approvals are always exact-amount. ' +
        'POST /v1/{network}/tx/broadcast relays a transaction you signed only if it targets a Specular contract on that network.',
      license: { name: 'MIT' },
    },
    servers: [{ url: publicUrl || process.env.SPECULAR_PUBLIC_URL || 'http://localhost:3400' }],
    tags: [
      { name: 'read', description: 'Read-only chain queries (executed server-side)' },
      { name: 'prepare', description: 'Build unsigned transactions (non-custodial)' },
      { name: 'simulate', description: 'Dry-run a transaction from your address' },
      { name: 'broadcast', description: 'Relay a transaction you already signed' },
      { name: 'meta' },
    ],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Only enforced when the server sets SPECULAR_MCP_TOKEN.' } },
      schemas: { Error: ERROR_SCHEMA, PreparedTransaction: PREPARED_TX_SCHEMA },
    },
    security: [{ bearerAuth: [] }, {}],
    paths,
  };
}
