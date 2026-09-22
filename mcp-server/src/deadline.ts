/**
 * Per-request deadline propagation.
 *
 * 2026-09-22 RPC-resilience round. The 2026-09-20 load report measured live
 * requests dying at p95 = 164 s and max = 300 s — i.e. they were killed by
 * Node's default `requestTimeout`, not by any policy of ours. A per-attempt
 * upstream timeout alone cannot bound that, because one HTTP request can make
 * dozens of upstream calls (a `/v1/{net}/status` read fans out ~27) and can now
 * additionally fail over between endpoints.
 *
 * So the HTTP layer stamps an absolute deadline on the request and the RPC
 * layer reads it through AsyncLocalStorage: every upstream attempt is clamped
 * to the remaining budget, and once the budget is gone the request fails with
 * an explicit 504 carrying a retry hint instead of hanging.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export const DEFAULT_REQUEST_DEADLINE_MS = 20_000;

/** Total wall-clock budget for one inbound HTTP/MCP request (env SPECULAR_REQUEST_DEADLINE_MS, 0 disables). */
export function requestDeadlineMs(): number {
  const raw = process.env.SPECULAR_REQUEST_DEADLINE_MS;
  if (raw === undefined || raw === '') return DEFAULT_REQUEST_DEADLINE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_REQUEST_DEADLINE_MS;
  return n; // 0 => no deadline
}

interface DeadlineCtx {
  deadlineAt: number;
}

const store = new AsyncLocalStorage<DeadlineCtx>();

/** Error thrown when a request exhausts its overall budget. Mapped to HTTP 504. */
export class RequestDeadlineError extends Error {
  readonly kind = 'deadline';
  readonly retryAfterSeconds: number;
  constructor(message = 'request deadline exceeded', retryAfterSeconds = 1) {
    super(message);
    this.name = 'RequestDeadlineError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function isRequestDeadlineError(e: unknown): e is RequestDeadlineError {
  return e instanceof RequestDeadlineError || (typeof e === 'object' && e !== null && (e as { kind?: string }).kind === 'deadline');
}

/** Run `fn` with an absolute deadline `ms` from now. `ms <= 0` runs with no deadline. */
export function runWithDeadline<T>(ms: number, fn: () => T): T {
  if (!(ms > 0)) return fn();
  return store.run({ deadlineAt: Date.now() + ms }, fn);
}

/** Milliseconds left in the current request budget, or null when unbounded (no deadline in scope). */
export function remainingMs(): number | null {
  const ctx = store.getStore();
  return ctx ? ctx.deadlineAt - Date.now() : null;
}

/** Throws if the current request has already exhausted its budget. */
export function assertBudget(what = 'upstream RPC call'): void {
  const left = remainingMs();
  if (left !== null && left <= 0) {
    throw new RequestDeadlineError(`request deadline exceeded before ${what} could complete`);
  }
}

/**
 * Budget for a single upstream attempt: the smaller of the per-call timeout and
 * whatever is left of the request deadline (minus a small reserve so the handler
 * can still serialise a response).
 */
export function attemptBudgetMs(perCallTimeoutMs: number, reserveMs = 150): number {
  const left = remainingMs();
  if (left === null) return perCallTimeoutMs;
  const usable = left - reserveMs;
  if (usable <= 0) throw new RequestDeadlineError('request deadline exceeded before the next upstream attempt');
  return Math.min(perCallTimeoutMs, usable);
}
