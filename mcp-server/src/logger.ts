/**
 * Structured JSON-lines logger. Never receives request bodies, headers or
 * keys; a redaction pass additionally blanks any field whose name looks like
 * a secret, as defence in depth.
 */
const SECRET_KEY = /(private|secret|token|password|authorization|signedtransaction|mnemonic|seed)/i;

export type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const l = (process.env.LOG_LEVEL || 'info').toLowerCase() as Level;
  return LEVELS[l] ?? LEVELS.info;
}

export function redact(obj: unknown, depth = 0): unknown {
  if (depth > 4) return '[depth]';
  if (Array.isArray(obj)) return obj.slice(0, 20).map((v) => redact(v, depth + 1));
  if (obj && typeof obj === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof obj === 'string' && obj.length > 300) return obj.slice(0, 300) + '…';
  if (typeof obj === 'bigint') return obj.toString();
  return obj;
}

/** stdio MCP mode must keep stdout clean for JSON-RPC; write logs to stderr there. */
let sink: NodeJS.WriteStream = process.stdout;
export function useStderr(): void {
  sink = process.stderr;
}

export function log(level: Level, msg: string, fields: Record<string, unknown> = {}): void {
  if (LEVELS[level] < threshold()) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(redact(fields) as Record<string, unknown>) });
  sink.write(line + '\n');
}

export const logger = {
  debug: (m: string, f?: Record<string, unknown>) => log('debug', m, f),
  info: (m: string, f?: Record<string, unknown>) => log('info', m, f),
  warn: (m: string, f?: Record<string, unknown>) => log('warn', m, f),
  error: (m: string, f?: Record<string, unknown>) => log('error', m, f),
};

export function errorFields(e: unknown): Record<string, unknown> {
  if (e instanceof Error) return { error: e.message, errorName: e.name };
  return { error: String(e) };
}
