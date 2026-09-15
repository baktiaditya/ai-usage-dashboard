/**
 * Collection error taxonomy.
 *
 * Codes are stable, safe to persist, and safe to render. They deliberately
 * carry no upstream text: a `safeMessage` is produced separately and passes
 * through `redactText` first.
 */

export const ERROR_CODES = [
  /** Credential or source is not configured at all. Not a failure. */
  'not_configured',
  /** The source exists but this account/plan does not expose the data. */
  'not_entitled',
  /** No event has ever arrived from an event-driven source. */
  'no_event_yet',
  /** The adapter exceeded its independent timeout. */
  'timeout',
  /** DNS/TCP/TLS failure reaching the upstream. */
  'network_error',
  /** Upstream rejected the credential (HTTP 401). */
  'auth_rejected',
  /** Credential is valid but lacks the required privilege (HTTP 403). */
  'insufficient_scope',
  /** Upstream applied its own rate limit (HTTP 429). */
  'rate_limited',
  /** Upstream 5xx. */
  'upstream_error',
  /** Payload parsed but failed the adapter's schema guard. */
  'schema_mismatch',
  /** Payload is a shape this adapter version does not claim to understand. */
  'version_unsupported',
  /** Child process could not be spawned or exited abnormally. */
  'process_failed',
  /** Local spool/file access problem. */
  'io_error',
  /** Anything not classified above. */
  'unknown_error',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Codes that mean "there is nothing to collect yet", which the dashboard shows
 * as `unavailable` rather than `error`. An unconfigured provider is a normal
 * state, not a fault.
 */
export const UNAVAILABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  'not_configured',
  'not_entitled',
  'no_event_yet',
]);

/** Codes where an immediate bounded retry is safe and potentially useful. */
export const RETRYABLE_CODES: ReadonlySet<ErrorCode> = new Set([
  'timeout',
  'network_error',
  'upstream_error',
  'rate_limited',
]);

export function isUnavailable(code: ErrorCode): boolean {
  return UNAVAILABLE_CODES.has(code);
}

export function isRetryable(code: ErrorCode): boolean {
  return RETRYABLE_CODES.has(code);
}

/** Human-readable, secret-free explanation used by the diagnostics panel. */
export const ERROR_CODE_HINTS: Record<ErrorCode, string> = {
  not_configured: 'No credential is saved yet. Add it in Settings.',
  not_entitled: 'This account or plan does not expose the data.',
  no_event_yet: 'No event has been received from this source yet.',
  timeout: 'The source did not respond within the adapter timeout.',
  network_error: 'The source could not be reached over the network.',
  auth_rejected: 'The credential was rejected by the provider.',
  insufficient_scope: 'The credential lacks the privilege this endpoint requires.',
  rate_limited: 'The provider applied its own rate limit; the next run will retry.',
  upstream_error: 'The provider returned a server-side error.',
  schema_mismatch: 'The response did not match the fields this adapter validates.',
  version_unsupported: 'The response shape is not recognised by this adapter version.',
  process_failed: 'The local CLI process could not be started or exited abnormally.',
  io_error: 'A local file could not be read or written.',
  unknown_error: 'An unclassified error occurred.',
};

/** Error carrying a taxonomy code. Adapters throw this; the collector maps it. */
export class CollectionError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'CollectionError';
    this.code = code;
  }
}

export function classifyHttpStatus(status: number): ErrorCode {
  if (status === 401) return 'auth_rejected';
  if (status === 403) return 'insufficient_scope';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'upstream_error';
  if (status >= 400) return 'schema_mismatch';
  return 'unknown_error';
}
