/**
 * Input validation for every tool / REST argument. All request data is
 * treated as hostile: addresses go through ethers.getAddress, numbers are
 * clamped, strings are length- and charset-limited, and nothing is eval'd.
 */
import { ethers } from 'ethers';

export class ValidationError extends Error {
  readonly status = 400;
  constructor(message: string, readonly field?: string) {
    super(message);
  }
}

/** A V6.1-only feature was requested on a deployment that predates it. 400, same handling as ValidationError. */
export class UnsupportedOnDeploymentError extends ValidationError {
  readonly code = 'UNSUPPORTED_ON_DEPLOYMENT';
  constructor(message: string) {
    super(message, 'network');
  }
}

export const USDC_DECIMALS = 6;

/** Per-call amount sanity caps, in USDC display units. Override with SPECULAR_MAX_AMOUNT_USDC. */
export function maxAmountUsdc(): number {
  const raw = process.env.SPECULAR_MAX_AMOUNT_USDC;
  if (!raw) return 100_000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new Error('SPECULAR_MAX_AMOUNT_USDC must be a positive number');
  return n;
}

/** Highest credit limit any reputation tier grants (score 800+ => 50,000 USDC). */
export const MAX_LOAN_USDC = 50_000;

export const DURATION_DAYS_MIN = 7;
export const DURATION_DAYS_MAX = 365;

export function requireObject(x: unknown, what = 'arguments'): Record<string, unknown> {
  if (x === null || typeof x !== 'object' || Array.isArray(x)) throw new ValidationError(`${what} must be a JSON object`);
  return x as Record<string, unknown>;
}

export function validateAddress(value: unknown, field = 'address'): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new ValidationError(`${field} must be a 0x-prefixed 20-byte hex address`, field);
  }
  try {
    return ethers.getAddress(value); // throws on bad mixed-case checksum
  } catch {
    throw new ValidationError(`${field} has an invalid EIP-55 checksum: ${value}`, field);
  }
}

export function validateTxHash(value: unknown, field = 'hash'): string {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) {
    throw new ValidationError(`${field} must be a 0x-prefixed 32-byte hex transaction hash`, field);
  }
  return value.toLowerCase();
}

/** Non-negative integer id (agentId, loanId) as a safe JS number. */
export function validateId(value: unknown, field: string, { min = 1 }: { min?: number } = {}): number {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > Number.MAX_SAFE_INTEGER) {
    throw new ValidationError(`${field} must be an integer >= ${min}`, field);
  }
  return n;
}

export function validateDurationDays(value: unknown, field = 'durationDays'): number {
  const n = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new ValidationError(`${field} must be an integer number of days`, field);
  if (n > DURATION_DAYS_MAX) {
    const hint = n % 86400 === 0 ? ` (looks like ${n / 86400} days expressed in seconds; pass days)` : '';
    throw new ValidationError(`${field}=${n} exceeds max ${DURATION_DAYS_MAX}${hint}`, field);
  }
  if (n < DURATION_DAYS_MIN) throw new ValidationError(`${field}=${n} is below min ${DURATION_DAYS_MIN}`, field);
  return n;
}

export interface AmountOpts {
  /** cap in display units (USDC) */
  max?: number;
  allowZero?: boolean;
}

/**
 * Parse a USDC amount given in DISPLAY units (e.g. 12.5 = 12.5 USDC) into
 * base units (6 decimals). Accepts number or decimal string. Rejects NaN,
 * Infinity, negatives, > 6 decimals, exponent notation, and anything above
 * the per-call cap.
 */
export function validateAmountUsdc(value: unknown, field = 'amount', opts: AmountOpts = {}): bigint {
  const cap = opts.max ?? maxAmountUsdc();
  let s: string;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ValidationError(`${field} must be a finite number`, field);
    s = value.toString();
  } else if (typeof value === 'string') {
    s = value.trim();
  } else {
    throw new ValidationError(`${field} must be a number or decimal string in USDC (e.g. 12.5)`, field);
  }
  if (!/^\d{1,12}(\.\d{1,6})?$/.test(s)) {
    throw new ValidationError(`${field} must be a positive decimal with at most 6 decimal places (got "${s}")`, field);
  }
  const base = ethers.parseUnits(s, USDC_DECIMALS);
  if (base === 0n && !opts.allowZero) throw new ValidationError(`${field} must be > 0`, field);
  const capBase = ethers.parseUnits(cap.toString(), USDC_DECIMALS);
  if (base > capBase) {
    throw new ValidationError(`${field}=${s} USDC exceeds this server's per-call cap of ${cap} USDC (raise SPECULAR_MAX_AMOUNT_USDC to change)`, field);
  }
  return base;
}

export function formatUsdc(base: bigint | number): string {
  return ethers.formatUnits(BigInt(base), USDC_DECIMALS);
}

/** Bounded, printable string (for agentURI, names). */
export function validateShortString(value: unknown, field: string, { max = 512, min = 1 }: { max?: number; min?: number } = {}): string {
  if (typeof value !== 'string') throw new ValidationError(`${field} must be a string`, field);
  if (value.length < min) throw new ValidationError(`${field} must be at least ${min} character(s)`, field);
  if (value.length > max) throw new ValidationError(`${field} must be at most ${max} characters`, field);
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) throw new ValidationError(`${field} must not contain control characters`, field);
  return value;
}

export function validateBoolean(value: unknown, field: string, dflt = false): boolean {
  if (value === undefined || value === null) return dflt;
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ValidationError(`${field} must be a boolean`, field);
}

export function validateHexData(value: unknown, field = 'data', maxBytes = 8192): string {
  if (typeof value !== 'string' || !/^0x([0-9a-fA-F]{2})*$/.test(value)) {
    throw new ValidationError(`${field} must be 0x-prefixed hex bytes`, field);
  }
  if ((value.length - 2) / 2 > maxBytes) throw new ValidationError(`${field} exceeds ${maxBytes} bytes`, field);
  return value.toLowerCase();
}

export function optionalNumber(value: unknown, field: string, { min = 0, max = 1e12 }: { min?: number; max?: number } = {}): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) {
    throw new ValidationError(`${field} must be a number between ${min} and ${max}`, field);
  }
  return n;
}
