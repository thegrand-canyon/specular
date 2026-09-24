/**
 * OpenAPI 3.1 document generated from the shared tool registry, so the REST
 * surface and the MCP tools can never drift apart.
 */
import { ALL_NETWORKS } from './networks.js';
import { SERVER_VERSION } from './mcp.js';
import { JsonSchema, TOOLS, ToolDef } from './tools.js';

const ERROR_SCHEMA = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    field: { type: 'string' },
    network: { type: 'string', description: 'Set on 503 when a network\'s upstream RPC endpoints are all cold.' },
    retryAfterSeconds: { type: 'integer', description: 'Set on 503/504; mirrors the Retry-After header.' },
  },
  required: ['error'],
};

const CACHE_STATS_SCHEMA = {
  type: 'object',
  properties: {
    hits: { type: 'integer' },
    misses: { type: 'integer' },
    coalesced: { type: 'integer', description: 'Requests that shared an in-flight upstream call instead of issuing their own.' },
    stores: { type: 'integer' },
    evictions: { type: 'integer' },
    entries: { type: 'integer' },
    hitRate: { type: 'number', description: '(hits + coalesced) / (hits + misses + coalesced)' },
  },
};

const ENDPOINT_HEALTH_SCHEMA = {
  type: 'object',
  properties: {
    endpoint: { type: 'string', description: 'REDACTED endpoint: a well-known public default verbatim, anything operator-configured reduced to scheme://host/.' },
    state: { type: 'string', enum: ['up', 'cold', 'probing'] },
    consecutiveFailures: { type: 'integer' },
    coldForMs: { type: 'integer', description: 'Remaining backoff before this endpoint is tried again.' },
    lastErrorClass: { type: ['string', 'null'], enum: ['rate_limited', 'timeout', 'connection', 'server_error', 'bad_response', 'other', null] },
    lastErrorAt: { type: ['string', 'null'], format: 'date-time' },
    calls: { type: 'integer' },
    successes: { type: 'integer' },
    failures: { type: 'integer' },
  },
};

const NETWORK_RPC_HEALTH_SCHEMA = {
  type: 'object',
  properties: {
    network: { type: 'string' },
    endpoints: { type: 'array', items: { $ref: '#/components/schemas/EndpointHealth' } },
    circuitOpen: { type: 'boolean', description: 'True when every endpoint for this network is cold: reads fail fast with 503 rather than queueing.' },
    circuitOpens: { type: 'integer' },
    retryAfterSeconds: { type: 'integer' },
  },
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
            simulatedAtBlock: { type: ['integer', 'null'], description: 'Block this simulation was evaluated against. Your transaction executes later; another wallet can change the outcome in between.' },
            raceClass: { type: ['string', 'null'], enum: ['retryable', 'actionable', 'terminal', null], description: "What to do about a refusal: 'retryable' = another wallet got there first, re-send the identical call; 'actionable' = change something first; 'terminal' = never retry." },
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
    '502': { description: 'Upstream RPC failure (attempts across every endpoint exhausted)', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    '503': { description: 'Network temporarily unavailable (every RPC endpoint for this network is cold), or the server is shedding load. Carries Retry-After.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
    '504': { description: 'The request exceeded SPECULAR_REQUEST_DEADLINE_MS before the chain answered. Carries Retry-After.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
  };
  if (withAuth) r['401'] = { description: 'Missing or invalid bearer token', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } };
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

/**
 * `authRequired` defaults to whether THIS process enforces a token, so the document a
 * live server serves describes that server. The generator writes the unauthenticated
 * shape unless told otherwise.
 */
export function buildOpenApi(publicUrl?: string, authRequired = !!process.env.SPECULAR_MCP_TOKEN) {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const t of TOOLS) {
    paths[t.rest.path] ??= {};
    paths[t.rest.path][t.rest.method.toLowerCase()] = operationFor(t);
  }
  paths['/health'] = {
    get: {
      operationId: 'health',
      summary: 'Liveness + per-network RPC staleness, with a compact upstream summary',
      description: 'Cached for SPECULAR_HEALTH_CACHE_MS. `upstream` carries the cache hit rates and, per network, whether the circuit breaker is open and how many configured RPC endpoints are healthy.',
      tags: ['meta'],
      security: [],
      responses: {
        '200': { description: 'OK', content: { 'application/json': { schema: { type: 'object' } } } },
        '503': { description: 'At least one enabled network is stale or unreachable', content: { 'application/json': { schema: { type: 'object' } } } },
      },
    },
  };
  paths['/rpc-health'] = {
    get: {
      operationId: 'rpcHealth',
      summary: 'Upstream RPC observability: per-endpoint health, circuit-breaker state and cache counters',
      description:
        'Read-only and makes no upstream call. Endpoint URLs are REDACTED: a well-known public default is shown verbatim, anything operator-configured is reduced to scheme://host/ so credentials in a paid RPC URL are never published.',
      tags: ['meta'],
      security: [],
      responses: {
        '200': {
          description: 'Upstream health snapshot',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['ok', 'degraded'] },
                  version: { type: 'string' },
                  caches: {
                    type: 'object',
                    properties: { jsonRpc: { $ref: '#/components/schemas/CacheStats' }, readRoutes: { $ref: '#/components/schemas/CacheStats' } },
                  },
                  networks: { type: 'array', items: { $ref: '#/components/schemas/NetworkRpcHealth' } },
                  config: { type: 'object' },
                },
                required: ['status', 'caches', 'networks', 'config'],
              },
            },
          },
        },
      },
    },
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
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Required. Issue one token per connector; the operator sets it on the service.' } },
      schemas: {
        Error: ERROR_SCHEMA,
        PreparedTransaction: PREPARED_TX_SCHEMA,
        CacheStats: CACHE_STATS_SCHEMA,
        EndpointHealth: ENDPOINT_HEALTH_SCHEMA,
        NetworkRpcHealth: NETWORK_RPC_HEALTH_SCHEMA,
      },
    },
    // [C1 2026-09-24] Emit the alternative `{}` (= "no auth accepted") ONLY when this
    // server genuinely runs without a token. Emitting it unconditionally told every
    // generator that anonymous access was valid, so a Muse connector built from this
    // document sent no Authorization header and got 401 on every call — the document
    // said the request was legal and the server disagreed.
    security: authRequired ? [{ bearerAuth: [] }] : [{ bearerAuth: [] }, {}],
    paths,
  };
}
