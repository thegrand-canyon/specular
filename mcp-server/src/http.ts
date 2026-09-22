#!/usr/bin/env node
/**
 * Specular remote server: MCP over Streamable HTTP (POST /mcp) plus a REST
 * surface (/v1/...) and OpenAPI (/openapi.json), in one Express process.
 *
 * NON-CUSTODIAL: there is no signing code path in this file or anything it
 * imports for remote mode. Write tools return unsigned transactions.
 *
 * Env: PORT, HOST, SPECULAR_MCP_TOKEN (optional bearer), SPECULAR_ALLOWED_ORIGINS,
 *      SPECULAR_RATE_LIMIT_PER_MIN, SPECULAR_BROADCAST_LIMIT_PER_MIN,
 *      SPECULAR_ENABLED_NETWORKS, SPECULAR_RPC_*, SPECULAR_TRUST_PROXY,
 *      SPECULAR_CLIENT_IP_HEADER, SPECULAR_MAX_INFLIGHT, SPECULAR_HEALTH_CACHE_MS,
 *      SPECULAR_REQUEST_DEADLINE_MS, SPECULAR_RPC_CACHE*, SPECULAR_READ_CACHE*, LOG_LEVEL.
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cors from 'cors';
import { timingSafeEqual } from 'node:crypto';
import express, { NextFunction, Request, Response } from 'express';
import { describeRpcError, rpcStatus } from './chain.js';
import { isRequestDeadlineError, requestDeadlineMs, runWithDeadline } from './deadline.js';
import { isUpstreamUnavailable, rpcHealth, UpstreamUnavailableError } from './rpc.js';
import { errorFields, logger } from './logger.js';
import { createMcpServer, SERVER_VERSION } from './mcp.js';
import { enabledNetworks, getNetwork, NetworkError } from './networks.js';
import { buildOpenApi } from './openapi.js';
import { readCacheStats, TOOLS } from './tools.js';
import { ValidationError } from './validate.js';

// ---------------------------------------------------------------- config
const PORT = Number(process.env.PORT || 3400);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.SPECULAR_MCP_TOKEN || '';
const RATE_PER_MIN = Number(process.env.SPECULAR_RATE_LIMIT_PER_MIN || 120);
const BROADCAST_PER_MIN = Number(process.env.SPECULAR_BROADCAST_LIMIT_PER_MIN || 20);
const BODY_LIMIT = process.env.SPECULAR_BODY_LIMIT || '256kb';
/** Max concurrently executing tool requests (RPC-bound); beyond it we shed with 503 instead of queueing (H-7). */
const MAX_INFLIGHT = Number(process.env.SPECULAR_MAX_INFLIGHT || 64);
/** /health is unauthenticated and fans out one RPC call per network; cache it (H-6). */
const HEALTH_CACHE_MS = Number(process.env.SPECULAR_HEALTH_CACHE_MS || 10_000);
/**
 * Optional header carrying the real client IP, set by a proxy that OVERWRITES it
 * (e.g. Railway's edge sets X-Real-IP). When set, it takes precedence over the
 * X-Forwarded-For hop walk for rate-limit keying. Leave unset unless verified.
 */
const CLIENT_IP_HEADER = (process.env.SPECULAR_CLIENT_IP_HEADER || '').toLowerCase();

if (process.env.SPECULAR_PRIVATE_KEY) {
  // Defence in depth: the remote server must never be started with a key in its environment.
  logger.error('SPECULAR_PRIVATE_KEY is set in the environment of the REMOTE server. The remote server is non-custodial and refuses to start with a key present.');
  process.exit(2);
}

// ----------------------------------------------------------- rate limiter
class SlidingWindow {
  private hits = new Map<string, number[]>();
  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}
  hit(key: string): { allowed: boolean; remaining: number; retryAfterSec: number } {
    const now = Date.now();
    const arr = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.limit) {
      this.hits.set(key, arr);
      return { allowed: false, remaining: 0, retryAfterSec: Math.ceil((arr[0] + this.windowMs - now) / 1000) };
    }
    arr.push(now);
    this.hits.set(key, arr);
    if (this.hits.size > 50_000) this.sweep(now);
    return { allowed: true, remaining: this.limit - arr.length, retryAfterSec: 0 };
  }
  private sweep(now: number) {
    for (const [k, v] of this.hits) if (v.every((t) => now - t >= this.windowMs)) this.hits.delete(k);
  }
}
const generalLimiter = new SlidingWindow(RATE_PER_MIN);
const broadcastLimiter = new SlidingWindow(BROADCAST_PER_MIN);

/**
 * Rate-limit key. Express's `trust proxy` hop count resolves req.ip from the
 * right end of X-Forwarded-For; a client can only ever prepend, so with the
 * hop count equal to the number of proxies in front of us the key is the real
 * client. (2026-09-20 review, H-10: on Railway the chain is
 * "<client>, <edge>" so ONE hop keyed every client on the edge IP, making the
 * limiter shared across all users and trivially exhaustible.)
 */
export function clientIp(req: Request): string {
  if (CLIENT_IP_HEADER) {
    const v = req.headers[CLIENT_IP_HEADER];
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === 'string' && s.trim()) return s.trim().slice(0, 64);
  }
  return req.ip || 'unknown';
}

function limit(limiter: SlidingWindow) {
  return (req: Request, res: Response, next: NextFunction) => {
    const r = limiter.hit(clientIp(req));
    res.setHeader('X-RateLimit-Remaining', String(r.remaining));
    if (!r.allowed) {
      res.setHeader('Retry-After', String(r.retryAfterSec));
      res.status(429).json({ error: `rate limit exceeded; retry in ${r.retryAfterSec}s` });
      return;
    }
    next();
  };
}

// ------------------------------------------------------------ load shedding
let inflight = 0;
export function inflightCount(): number {
  return inflight;
}
/** Bound concurrent RPC-bound work; excess requests get an immediate 503 + Retry-After rather than piling up for minutes. */
function shed(req: Request, res: Response, next: NextFunction) {
  if (inflight >= MAX_INFLIGHT) {
    res.setHeader('Retry-After', '1');
    res.status(503).json({ error: `server busy (${MAX_INFLIGHT} requests in flight); retry shortly` });
    return;
  }
  inflight++;
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      inflight--;
    }
  };
  res.on('finish', release);
  res.on('close', release);
  next();
}

// ----------------------------------------------------------- request deadline
/**
 * Bounded waits (2026-09-22). The 2026-09-20 load report measured live requests
 * dying at 164 s (p95) and 300 s (max) — Node's default requestTimeout killing
 * them, not any policy of ours. Every /v1 and /mcp request now runs inside an
 * explicit budget: the RPC layer clamps each upstream attempt to what is left,
 * and a backstop timer answers 504 + Retry-After if a handler somehow overruns.
 */
function deadline(req: Request, res: Response, next: NextFunction) {
  const ms = requestDeadlineMs();
  if (!(ms > 0)) return next();
  const timer = setTimeout(() => {
    if (res.headersSent) return;
    res.setHeader('Retry-After', '1');
    res.status(504).json({
      error: 'Request exceeded the server time budget before the chain answered; try again shortly.',
      retryAfterSeconds: 1,
      deadlineMs: ms,
    });
  }, ms + 250);
  if (typeof timer.unref === 'function') timer.unref();
  const clear = () => clearTimeout(timer);
  res.on('finish', clear);
  res.on('close', clear);
  runWithDeadline(ms, next);
}

// ------------------------------------------------------------------ auth
function bearerOk(req: Request): boolean {
  if (!TOKEN) return true;
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1]);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}
function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (bearerOk(req)) return next();
  res.setHeader('WWW-Authenticate', 'Bearer realm="specular"');
  res.status(401).json({ error: 'missing or invalid bearer token' });
}

// ------------------------------------------------------------- MCP shims
const isPlainObject = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * JSON-RPC parameter pre-check for a single request. The SDK validates with
 * zod and surfaces failures as -32603 "Internal error" carrying the raw zod
 * issue list; the spec wants -32602 Invalid params (H-9).
 */
export function jsonRpcParamError(body: unknown): string | null {
  if (!isPlainObject(body)) return null;
  const p = body.params;
  if (body.method === 'tools/call') {
    if (!isPlainObject(p)) return 'params must be an object with a string "name"';
    if (typeof p.name !== 'string') return 'params.name must be a string';
    if (p.arguments !== undefined && !isPlainObject(p.arguments)) return 'params.arguments must be a JSON object';
  } else if (body.method === 'initialize') {
    if (!isPlainObject(p) || typeof p.protocolVersion !== 'string') return 'params.protocolVersion must be a string';
  }
  return null;
}

/**
 * Response-level safety net for JSON-RPC error shape (2026-09-21 review, H-14).
 *
 * The SDK validates every request with zod and reports a failure as -32603
 * "Internal error" whose message is the raw zod issue array. `jsonRpcParamError`
 * catches the common single-request cases up front, but requests arriving inside
 * a JSON-RPC BATCH bypass it entirely, so a malformed `tools/call` in a batch
 * still came back as -32603 carrying a zod dump. Rewriting at the response level
 * covers every path, batches included.
 */
export function normalizeRpcErrors(payload: unknown): unknown {
  const fixOne = (m: unknown): unknown => {
    if (!isPlainObject(m)) return m;
    const err = m.error as { code?: number; message?: unknown } | undefined;
    if (!err || err.code !== -32603 || typeof err.message !== 'string') return m;
    if (!/"code"\s*:\s*"(invalid_|too_|unrecognized_)|"expected"\s*:/.test(err.message)) return m;
    let detail = '';
    try {
      const issues = JSON.parse(err.message) as Array<{ path?: unknown[]; message?: string }>;
      const first = Array.isArray(issues) ? issues[0] : undefined;
      if (first) detail = `${(first.path || []).join('.') || 'params'}: ${first.message || 'invalid'}`;
    } catch {
      /* not a zod dump after all */
    }
    return { ...m, error: { code: -32602, message: `Invalid params${detail ? `: ${detail}` : ''}`.slice(0, 200) } };
  };
  return Array.isArray(payload) ? payload.map(fixOne) : fixOne(payload);
}

/**
 * Rewrite a single-shot JSON response body on its way out. Used only on `/mcp`,
 * which always answers with one buffered JSON document (`enableJsonResponse`);
 * anything streamed (SSE) or non-JSON passes through untouched.
 */
function interceptJsonBody(res: Response, transform: (parsed: unknown) => unknown): void {
  type Hdrs = Record<string, unknown> | undefined;
  const origWriteHead = res.writeHead.bind(res) as (...a: never[]) => Response;
  const origWrite = res.write.bind(res) as (...a: never[]) => boolean;
  const origEnd = res.end.bind(res) as (...a: never[]) => Response;

  let jsonResponse = false;
  let buffered = 0;
  const MAX_BUFFER = 8 * 1024 * 1024;   // safety valve: never hold an unbounded body in memory
  const chunks: Buffer[] = [];

  const toBuf = (c: unknown): Buffer | null =>
    typeof c === 'string' ? Buffer.from(c, 'utf8')
      : Buffer.isBuffer(c) ? c
        : ArrayBuffer.isView(c) ? Buffer.from(c.buffer as ArrayBuffer, c.byteOffset, c.byteLength) : null;

  // The transport writes headers via writeHead(status, headers) — res.getHeader() cannot see
  // those — so sniff the content type here and drop any content-length (the body may change size).
  res.writeHead = ((status: number, ...rest: unknown[]) => {
    const hdrs = rest.find((r) => r && typeof r === 'object' && !Array.isArray(r)) as Hdrs;
    const ct = String(hdrs?.['content-type'] ?? hdrs?.['Content-Type'] ?? res.getHeader('content-type') ?? '');
    jsonResponse = /application\/json/i.test(ct);
    if (jsonResponse && hdrs) {
      delete hdrs['content-length'];
      delete hdrs['Content-Length'];
    }
    return origWriteHead(status as never, ...(rest as never[]));
  }) as typeof res.writeHead;

  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    const b = jsonResponse ? toBuf(chunk) : null;
    if (b && buffered + b.length <= MAX_BUFFER) {
      chunks.push(b);
      buffered += b.length;
      const cb = rest.find((r) => typeof r === 'function') as (() => void) | undefined;
      cb?.();
      return true;
    }
    if (b) {
      // Too large to rewrite: flush what we held and stream the rest verbatim.
      jsonResponse = false;
      for (const held of chunks.splice(0)) origWrite(held as never);
    }
    return origWrite(chunk as never, ...(rest as never[]));
  }) as typeof res.write;

  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    if (!jsonResponse) return origEnd(chunk as never, ...(rest as never[]));
    const last = typeof chunk === 'function' ? null : toBuf(chunk);
    if (last) chunks.push(last);
    const body = Buffer.concat(chunks).toString('utf8');
    let out = body;
    try {
      out = JSON.stringify(transform(JSON.parse(body)));
    } catch {
      /* not JSON after all: send it back unchanged */
    }
    if (!res.headersSent && res.getHeader('content-length') !== undefined) res.setHeader('content-length', Buffer.byteLength(out));
    const cb = [chunk, ...rest].find((r) => typeof r === 'function') as (() => void) | undefined;
    return origEnd(out as never, ...((cb ? [cb] : []) as never[]));
  }) as typeof res.end;
}

/**
 * The SDK returns 406 unless Accept lists BOTH application/json and
 * text/event-stream. This server is stateless and always answers JSON, so a
 * client that accepts JSON (or anything) is served (H-8).
 */
export function normalizeAccept(accept: string | undefined): string {
  const a = accept || '';
  const json = /application\/json|\*\/\*|application\/\*/i.test(a);
  const sse = /text\/event-stream/i.test(a);
  if (json && sse) return a;
  return 'application/json, text/event-stream';
}

// ------------------------------------------------------------------- app
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Railway: client -> edge (appends client IP) -> internal hop (appends edge IP) -> app  => 2 hops.
  // Verify after deploy: the access log's "ip" must equal your real address (the "xff" field shows the chain).
  const trust = process.env.SPECULAR_TRUST_PROXY ?? (process.env.RAILWAY_ENVIRONMENT ? '2' : '');
  if (trust) app.set('trust proxy', /^\d+$/.test(trust) ? Number(trust) : trust);

  // structured access log (no headers except the forwarded-IP chain, no bodies)
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const f: Record<string, unknown> = { method: req.method, path: req.path.slice(0, 200), status: res.statusCode, ms: Date.now() - started, ip: clientIp(req) };
      const xff = req.headers['x-forwarded-for'];
      if (xff) f.xff = String(xff).slice(0, 200);
      if (req.path === '/mcp' && req.body && typeof req.body === 'object') {
        const b = Array.isArray(req.body) ? req.body[0] : req.body;
        f.rpc = typeof b?.method === 'string' ? b.method.slice(0, 64) : undefined;
        if (b?.method === 'tools/call') f.tool = typeof b?.params?.name === 'string' ? b.params.name.slice(0, 64) : undefined;
      }
      logger.info('http', f);
    });
    next();
  });

  const origins = (process.env.SPECULAR_ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim());
  app.use(
    cors({
      origin: origins.includes('*') ? true : origins,
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Mcp-Session-Id', 'Mcp-Protocol-Version', 'Last-Event-ID'],
      exposedHeaders: ['Mcp-Session-Id', 'X-RateLimit-Remaining', 'Retry-After'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: BODY_LIMIT, strict: true }));

  // ---- meta
  app.get('/', (_req, res) => {
    res.json({
      name: 'specular-agent-api',
      version: SERVER_VERSION,
      custody: 'non-custodial: reads execute server-side; writes are returned unsigned for your own wallet',
      mcp: { transport: 'streamable-http', endpoint: '/mcp' },
      rest: { base: '/v1', openapi: '/openapi.json' },
      networks: enabledNetworks(),
      auth: TOKEN ? 'bearer token required for /mcp and /v1' : 'open (rate-limited per IP)',
      docs: 'https://github.com/thegrand-canyon/specular/tree/main/docs/integrations',
    });
  });

  type HealthBody = { status: string; version: string; networks: unknown[] };
  let healthCache: { at: number; body: HealthBody; ok: boolean } | null = null;
  let healthInflight: Promise<{ body: HealthBody; ok: boolean }> | null = null;
  async function computeHealth(): Promise<{ body: HealthBody; ok: boolean }> {
    const nets = await Promise.all(
      enabledNetworks().map(async (n) => {
        try {
          const s = await rpcStatus(getNetwork(n));
          return { network: n, ok: !s.stale, ...s };
        } catch (e) {
          return { network: n, ok: false, error: describeRpcError(e) };
        }
      }),
    );
    const ok = nets.every((n) => n.ok);
    return { ok, body: { status: ok ? 'ok' : 'degraded', version: SERVER_VERSION, networks: nets } };
  }
  /** Compact, secret-free upstream summary attached to every /health answer. */
  function upstreamSummary() {
    const h = rpcHealth();
    return {
      rpcCacheHitRate: h.cache.hitRate,
      readCacheHitRate: readCacheStats().hitRate,
      networks: h.networks.map((n) => ({
        network: n.network,
        circuitOpen: n.circuitOpen,
        endpointsUp: n.endpoints.filter((e) => e.state === 'up').length,
        endpointsTotal: n.endpoints.length,
      })),
    };
  }

  app.get('/health', deadline, async (_req, res) => {
    const now = Date.now();
    if (healthCache && now - healthCache.at < HEALTH_CACHE_MS) {
      res.status(healthCache.ok ? 200 : 503).json({ ...healthCache.body, cached: true, cacheAgeMs: now - healthCache.at, upstream: upstreamSummary() });
      return;
    }
    if (!healthInflight) {
      healthInflight = computeHealth().finally(() => {
        healthInflight = null;
      });
    }
    const r = await healthInflight;
    healthCache = { at: Date.now(), body: r.body, ok: r.ok };
    if (res.headersSent) return;
    res.status(r.ok ? 200 : 503).json({ ...r.body, cached: false, cacheAgeMs: 0, upstream: upstreamSummary() });
  });

  /**
   * Read-only upstream observability (2026-09-22). Endpoint URLs are REDACTED by
   * the same rule as /v1/networks (H-3): a well-known public default verbatim,
   * anything operator-configured reduced to scheme://host/ — never userinfo, a
   * path key or a query key. No upstream call is made to serve this route.
   */
  app.get('/rpc-health', (_req, res) => {
    const h = rpcHealth();
    res.json({
      status: h.networks.some((n) => n.circuitOpen) ? 'degraded' : 'ok',
      version: SERVER_VERSION,
      caches: { jsonRpc: h.cache, readRoutes: readCacheStats() },
      networks: h.networks,
      config: { ...h.config, requestDeadlineMs: requestDeadlineMs(), maxInflight: MAX_INFLIGHT, inflight: inflight },
    });
  });

  const openapiCache = new Map<string, unknown>();
  app.get('/openapi.json', (req, res) => {
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
    const url = process.env.SPECULAR_PUBLIC_URL || `${proto}://${req.get('host')}`;
    let doc = openapiCache.get(url);
    if (!doc) {
      if (openapiCache.size > 16) openapiCache.clear();
      doc = buildOpenApi(url);
      openapiCache.set(url, doc);
    }
    res.json(doc);
  });

  // ---- MCP Streamable HTTP (stateless: one server+transport per request)
  app.use('/mcp', requireAuth, limit(generalLimiter), deadline);
  app.post('/mcp', shed, async (req, res) => {
    const body = req.body;
    const isBatch = Array.isArray(body);
    // JSON-RPC 2.0 §6: an empty batch is an Invalid Request, not an accepted notification (H-14).
    if (isBatch && body.length === 0) {
      res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request: empty batch' } });
      return;
    }
    const paramErr = jsonRpcParamError(body);
    if (paramErr) {
      const id = isPlainObject(body) && 'id' in body ? (body.id as unknown) : null;
      if (id === undefined || id === null) res.status(202).end();
      else res.status(200).json({ jsonrpc: '2.0', id, error: { code: -32602, message: `Invalid params: ${paramErr}` } });
      return;
    }
    // The SDK transport writes straight to the Node response (via @hono/node-server), so
    // Express's res.json is never called: intercept the raw write instead (H-14).
    interceptJsonBody(res, (parsed) => {
      const normalized = normalizeRpcErrors(parsed);
      return isBatch && !Array.isArray(normalized) ? [normalized] : normalized;
    });
    req.headers.accept = normalizeAccept(req.headers.accept);
    const server = createMcpServer({ mode: 'remote' });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      logger.error('mcp request failed', errorFields(e));
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
    }
  });
  const methodNotAllowed = (_req: Request, res: Response) => {
    res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Stateless server: use POST /mcp' }, id: null });
  };
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);

  // ---- REST, generated from the same tool registry
  app.use('/v1', requireAuth, limit(generalLimiter), deadline, shed);
  for (const t of TOOLS) {
    const expressPath = t.rest.path.replace(/\{(\w+)\}/g, ':$1');
    const handler = async (req: Request, res: Response, next: NextFunction) => {
      try {
        const source = t.rest.method === 'GET' ? req.query : req.body;
        if (t.rest.method === 'POST' && (req.body === undefined || req.body === null || typeof req.body !== 'object' || Array.isArray(req.body))) {
          throw new ValidationError('request body must be a JSON object');
        }
        const args: Record<string, unknown> = { ...(source as Record<string, unknown>), ...req.params };
        const result = await t.handler(args);
        if (res.headersSent) return; // the deadline backstop already answered 504
        res.json(result);
      } catch (e) {
        next(e);
      }
    };
    if (t.rest.method === 'GET') app.get(expressPath, handler);
    else if (t.kind === 'broadcast') app.post(expressPath, limit(broadcastLimiter), handler);
    else app.post(expressPath, handler);
  }
  // prepare with an unknown action -> 400 (not 404) with the valid list
  app.post('/v1/:network/tx/prepare/:action', (req, res) => {
    res.status(400).json({ error: `unknown action "${String(req.params.action).slice(0, 64)}"`, valid: TOOLS.filter((t) => t.kind === 'prepare').map((t) => t.rest.path.split('/').pop()) });
  });

  app.use((_req, res) => res.status(404).json({ error: 'not found' }));

  // ---- error mapping
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return; // the deadline backstop (504) already answered
    // Circuit breaker open: every upstream for this network is cold. Fail fast,
    // say so plainly, and hand back a retry hint instead of queueing (§5).
    if (isUpstreamUnavailable(err)) {
      const e = err as UpstreamUnavailableError;
      res.setHeader('Retry-After', String(e.retryAfterSeconds));
      res.status(503).json({ error: e.message, network: e.network, retryAfterSeconds: e.retryAfterSeconds });
      return;
    }
    if (isRequestDeadlineError(err)) {
      res.setHeader('Retry-After', '1');
      res.status(504).json({ error: describeRpcError(err), retryAfterSeconds: 1, deadlineMs: requestDeadlineMs() });
      return;
    }
    if (err instanceof ValidationError || err instanceof NetworkError) {
      res.status(400).json({ error: err.message, ...(err instanceof ValidationError && err.field ? { field: err.field } : {}) });
      return;
    }
    const anyErr = err as { type?: string; status?: number; message?: string };
    if (anyErr?.type === 'entity.too.large') return void res.status(413).json({ error: `request body exceeds ${BODY_LIMIT}` });
    if (anyErr?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'malformed JSON body' });
    if (typeof anyErr?.status === 'number' && anyErr.status >= 400 && anyErr.status < 500) return void res.status(anyErr.status).json({ error: anyErr.message || 'bad request' });
    logger.warn('request failed', errorFields(err));
    res.status(502).json({ error: describeRpcError(err) });
  });

  return app;
}

// ------------------------------------------------------------------ main
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const app = createApp();
  const server = app.listen(PORT, HOST, () => {
    logger.info('specular remote server listening', {
      port: PORT,
      host: HOST,
      version: SERVER_VERSION,
      networks: enabledNetworks(),
      auth: TOKEN ? 'bearer' : 'open',
      ratePerMin: RATE_PER_MIN,
      broadcastPerMin: BROADCAST_PER_MIN,
      maxInflight: MAX_INFLIGHT,
      requestDeadlineMs: requestDeadlineMs(),
      rpcEndpoints: Object.fromEntries(enabledNetworks().map((n) => [n, getNetwork(n).rpcUrls.length])),
      trustProxy: app.get('trust proxy') ?? null,
      clientIpHeader: CLIENT_IP_HEADER || null,
      tools: TOOLS.length,
    });
  });
  // Slowloris hygiene: bound header/request time (Node defaults are 60s/300s).
  server.headersTimeout = 30_000;
  server.requestTimeout = 120_000;
}
