/**
 * Structured logger that redacts before it writes.
 *
 * There is intentionally no way to log a raw object without redaction: every
 * field passes through `redactValue`, so a future adapter cannot accidentally
 * log an upstream payload.
 */
import { redactValue, redactText } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function emit(
  minLevel: LogLevel,
  bindings: Record<string, unknown>,
  level: LogLevel,
  message: string,
  fields?: Record<string, unknown>,
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    msg: redactText(message),
    ...(redactValue(bindings) as Record<string, unknown>),
    ...(fields ? (redactValue(fields) as Record<string, unknown>) : {}),
  };
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(`${JSON.stringify(line)}\n`);
}

export function createLogger(
  minLevel: LogLevel = 'info',
  bindings: Record<string, unknown> = {},
): Logger {
  return {
    debug: (m, f) => emit(minLevel, bindings, 'debug', m, f),
    info: (m, f) => emit(minLevel, bindings, 'info', m, f),
    warn: (m, f) => emit(minLevel, bindings, 'warn', m, f),
    error: (m, f) => emit(minLevel, bindings, 'error', m, f),
    child: (extra) => createLogger(minLevel, { ...bindings, ...extra }),
  };
}

/** Discards everything. Used by tests that assert on behaviour, not output. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
