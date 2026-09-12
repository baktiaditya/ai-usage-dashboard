/**
 * Decimal-safe money handling.
 *
 * Every monetary value in this application is carried as a *canonical decimal
 * string* and is only ever combined through Decimal.js. Binary floating point
 * is never used for money: not in arithmetic, not in storage (no SQLite REAL),
 * and not in transport.
 *
 * The subtle case is JSON. OpenRouter returns `{"total_credits": 100.5}` — a
 * JSON *number*. `JSON.parse` would turn that into an IEEE-754 double and the
 * original decimal text would be gone before we could react. `parseJsonLossless`
 * uses the V8 JSON source-text access (Node >= 22.12) to capture the literal
 * characters as written on the wire, so `0.1 + 0.2` style drift can never enter
 * the system in the first place.
 */
import { Decimal } from 'decimal.js';

// 40 significant digits is far beyond any real balance, and banker-free
// ROUND_HALF_UP keeps presentation predictable.
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -30, toExpPos: 40 });

/** A validated, canonical decimal string such as `"100.5"` or `"-3.25"`. */
export type MoneyString = string & { readonly __brand: 'MoneyString' };

const DECIMAL_LITERAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * Normalise an untrusted decimal *string* into canonical form.
 * Rejects NaN/Infinity and anything that is not a plain decimal literal, so a
 * malformed upstream payload can never masquerade as a number.
 */
export function toMoney(raw: string): MoneyString {
  const trimmed = raw.trim();
  if (!DECIMAL_LITERAL.test(trimmed)) {
    throw new MoneyError(`not a decimal literal: ${JSON.stringify(trimmed.slice(0, 32))}`);
  }
  const d = new Decimal(trimmed);
  if (!d.isFinite()) throw new MoneyError('non-finite decimal');
  return d.toFixed() as MoneyString;
}

/** `toMoney` that yields `null` instead of throwing. */
export function toMoneyOrNull(raw: string | null | undefined): MoneyString | null {
  if (raw === null || raw === undefined) return null;
  try {
    return toMoney(raw);
  } catch {
    return null;
  }
}

export function subtractMoney(a: MoneyString, b: MoneyString): MoneyString {
  return new Decimal(a).minus(new Decimal(b)).toFixed() as MoneyString;
}

export function addMoney(a: MoneyString, b: MoneyString): MoneyString {
  return new Decimal(a).plus(new Decimal(b)).toFixed() as MoneyString;
}

export function compareMoney(a: MoneyString, b: MoneyString): -1 | 0 | 1 {
  return new Decimal(a).comparedTo(new Decimal(b)) as -1 | 0 | 1;
}

export function isMoneyNegative(a: MoneyString): boolean {
  return new Decimal(a).isNegative();
}

/** Fixed-scale rendering for the UI. Never used for arithmetic or storage. */
export function formatMoney(value: MoneyString, decimalPlaces = 2): string {
  return new Decimal(value).toFixed(decimalPlaces);
}

/**
 * `JSON.parse` that preserves the *source text* of every JSON number.
 *
 * Numbers become `{ __rawNumber: "100.50" }` markers so callers must decide
 * explicitly whether a given field is money (keep the string) or an ordinary
 * integer (convert deliberately). This is what makes OpenRouter's float-typed
 * credit fields safe to consume.
 */
export type RawNumber = { readonly __rawNumber: string };

export function isRawNumber(v: unknown): v is RawNumber {
  return typeof v === 'object' && v !== null && typeof (v as RawNumber).__rawNumber === 'string';
}

export function parseJsonLossless(text: string): unknown {
  return JSON.parse(text, function (_key, value, context?: { source?: string }) {
    if (typeof value === 'number' && context && typeof context.source === 'string') {
      return { __rawNumber: context.source } satisfies RawNumber;
    }
    return value;
  });
}

/** Read a lossless-parsed field as money, tolerating both string and number wire types. */
export function rawToMoney(v: unknown): MoneyString | null {
  if (isRawNumber(v)) return toMoneyOrNull(v.__rawNumber);
  if (typeof v === 'string') return toMoneyOrNull(v);
  return null;
}

/** Read a lossless-parsed field as a safe integer (counts, timestamps — never money). */
export function rawToInteger(v: unknown): number | null {
  const text = isRawNumber(v) ? v.__rawNumber : typeof v === 'number' ? String(v) : null;
  if (text === null) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) ? n : null;
}
