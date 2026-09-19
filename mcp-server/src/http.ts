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
 *      SPECULAR_ENABLED_NETWORKS, SPECULAR_RPC_*, SPECULAR_TRUST_PROXY, LOG_LEVEL.
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import cors from 'cors';
import { timingSafeEqual } from 'node:crypto';
import express, { NextFunction, Request, Response } from 'express';
import { describeRpcError, rpcStatus } from './chain.js';
import { errorFields, logger } from './logger.js';
import { createMcpServer, SERVER_VERSION } from './mcp.js';
import { enabledNetworks, getNetwork, NetworkError } from './networks.js';
import { buildOpenApi } from './openapi.js';
import { TOOLS } from './tools.js';
import { ValidationError } from './validate.js';

// ---------------------------------------------------------------- config
const PORT = Number(process.env.PORT || 3400);
const HOST = process.env.HOST || '0.0.0.0';
const TOKEN = process.env.SPECULAR_MCP_TOKEN || '';
const RATE_PER_MIN = Number(process.env.SPECULAR_RATE_LIMIT_PER_MIN || 120);
const BROADCAST_PER_MIN = Number(process.env.SPECULAR_BROADCAST_LIMIT_PER_MIN || 20);
const BODY_LIMIT = process.env.SPECULAR_BODY_LIMIT || '256kb';

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

function limit(limiter: SlidingWindow) {
  return (req: Request, res: Response, next: NextFunction) => {
    const r = limiter.hit(req.ip || 'unknown');
    res.setHeader('X-RateLimit-Remaining', String(r.remaining));
    if (!r.allowed) {
      res.setHeader('Retry-After', String(r.retryAfterSec));
      res.status(429).json({ error: `rate limit exceeded; retry in ${r.retryAfterSec}s` });
      return;
    }
    next();
  };
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

// ------------------------------------------------------------------- app
export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  const trust = process.env.SPECULAR_TRUST_PROXY ?? (process.env.RAILWAY_ENVIRONMENT ? '1' : '');
  if (trust) app.set('trust proxy', /^\d+$/.test(trust) ? Number(trust) : trust);

  // structured access log (no headers, no bodies)
  app.use((req, res, next) => {
    const started = Date.now();
    res.on('finish', () => {
      const f: Record<string, unknown> = { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started, ip: req.ip };
      if (req.path === '/mcp' && req.body && typeof req.body === 'object') {
        const b = Array.isArray(req.body) ? req.body[0] : req.body;
        f.rpc = b?.method;
        if (b?.method === 'tools/call') f.tool = b?.params?.name;
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

  app.get('/health', async (_req, res) => {
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
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', version: SERVER_VERSION, networks: nets });
  });

  app.get('/openapi.json', (req, res) => {
    const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
    res.json(buildOpenApi(process.env.SPECULAR_PUBLIC_URL || `${proto}://${req.get('host')}`));
  });

  // ---- MCP Streamable HTTP (stateless: one server+transport per request)
  app.use('/mcp', requireAuth, limit(generalLimiter));
  app.post('/mcp', async (req, res) => {
    const server = createMcpServer({ mode: 'remote' });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
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
  app.use('/v1', requireAuth, limit(generalLimiter));
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
    res.status(400).json({ error: `unknown action "${req.params.action}"`, valid: TOOLS.filter((t) => t.kind === 'prepare').map((t) => t.rest.path.split('/').pop()) });
  });

  app.use((_req, res) => res.status(404).json({ error: 'not found' }));

  // ---- error mapping
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
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
  app.listen(PORT, HOST, () => {
    logger.info('specular remote server listening', {
      port: PORT,
      host: HOST,
      version: SERVER_VERSION,
      networks: enabledNetworks(),
      auth: TOKEN ? 'bearer' : 'open',
      ratePerMin: RATE_PER_MIN,
      broadcastPerMin: BROADCAST_PER_MIN,
      tools: TOOLS.length,
    });
  });
}
