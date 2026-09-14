/**
 * Redaction boundary.
 *
 * Everything that leaves the process — logs, persisted diagnostics, API
 * responses, rendered HTML — passes through here first. The rule is
 * allowlist-then-scrub: adapters already select the handful of fields the
 * dashboard needs, and this module is the second line of defence for free-text
 * that can still carry a secret (an upstream error string, a stack trace, a
 * child-process stderr line).
 */

/** Patterns that must never survive into output, ordered most specific first. */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Authorization / bearer headers. The value runs to end-of-line: a scheme
  // token plus the credential ("Bearer sk-…"), so consuming only `\S+` would
  // strip the word "Bearer" and leave the secret in place.
  [/\b(authorization|proxy-authorization)\s*[:=]\s*[^\r\n]+/gi, '$1: [redacted]'],
  [/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  // Provider key shapes.
  [/\bsk-or-v1-[A-Za-z0-9._-]{8,}/gi, '[redacted:openrouter-key]'],
  [/\bsk-[A-Za-z0-9._-]{16,}/gi, '[redacted:api-key]'],
  [/\b(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g, '[redacted:jwt]'],
  // Generic credential-ish assignments: apiKey=..., "access_token": "...".
  [
    /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|secret|password|passwd|management[_-]?key|session[_-]?key)\b(["']?\s*[:=]\s*["']?)([^\s"',}]{4,})/gi,
    '$1$2[redacted]',
  ],
  // Identity.
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted:email]'],
  [
    /\b(account[_-]?id|accountid|org[_-]?id|user[_-]?id)\b(["']?\s*[:=]\s*["']?)([^\s"',}]{2,})/gi,
    '$1$2[redacted]',
  ],
  // Bare UUIDs are account/org/session identifiers in every payload we touch.
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '[redacted:uuid]'],
  // Absolute home paths leak the OS username; collapse them back to `~`.
  [/(?:\/home\/|\/Users\/)[^/\s"',:]+/g, '~'],
];

const MAX_MESSAGE_LENGTH = 500;

/** Scrub a free-text string and clamp its length. */
export function redactText(input: string): string {
  let out = input;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  if (out.length > MAX_MESSAGE_LENGTH) {
    out = `${out.slice(0, MAX_MESSAGE_LENGTH)}…[truncated]`;
  }
  return out;
}

/** Keys whose *values* are dropped wholesale regardless of shape. */
const DENIED_KEYS = new Set(
  [
    'authorization',
    'apiKey',
    'api_key',
    'accessToken',
    'access_token',
    'refreshToken',
    'refresh_token',
    'idToken',
    'id_token',
    'token',
    'secret',
    'password',
    'cookie',
    'setCookie',
    'set-cookie',
    'email',
    'accountId',
    'account_id',
    'orgId',
    'org_id',
    'userId',
    'user_id',
    'sessionId',
    'session_id',
    'transcriptPath',
    'transcript_path',
    'managementKey',
    'management_key',
  ].map((k) => k.toLowerCase()),
);

/** Recursively redact an arbitrary value for logging. Never throws. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[redacted:depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) return redactText(`${value.name}: ${value.message}`);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactValue(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = DENIED_KEYS.has(k.toLowerCase()) ? '[redacted]' : redactValue(v, depth + 1);
    }
    return out;
  }
  return '[redacted:unsupported]';
}

/**
 * Turn an unknown thrown value into a message that is safe to persist and show.
 * Stack traces are dropped entirely — they carry absolute paths and argv.
 */
export function safeErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    // `CollectionError` already travels with a machine-readable `code` that the
    // UI renders separately, so prefixing its class name onto the human message
    // is pure noise. Any other Error keeps its name, which is real information.
    const prefix = err.name === 'CollectionError' ? '' : `${err.name}: `;
    return redactText(`${prefix}${err.message}`);
  }
  if (typeof err === 'string') return redactText(err);
  return 'unknown error';
}
