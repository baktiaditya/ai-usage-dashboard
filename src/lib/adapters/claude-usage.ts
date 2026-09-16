/**
 * Claude quota probe — POST https://api.anthropic.com/v1/messages
 *
 * The optional, default-off pull source of plan §3.1, gated in
 * docs/discovery/m0-discovery.md. Every Messages API response to a subscription
 * token carries the account's unified rate-limit state in its headers — the
 * same state Claude Code forwards to the status line — so one minimal request
 * reads quota with no Claude Code session running, which the spool cannot.
 *
 * A `claude setup-token` token is inference-only: it cannot read the
 * `/api/oauth/usage` endpoint, but it may make this request. The request is real
 * inference, so it costs a few tokens of the subscription usage it measures, and
 * the source is undocumented, so a header change is expected rather than
 * exceptional. Therefore:
 *
 *   - it runs only when the status-line spool has no fresh reading, so an active
 *     session never pays for a probe;
 *   - it is sent at most once per run and never retried — not through
 *     `withBoundedRetry`, whose retryable codes include `rate_limited`;
 *   - the cadence is enforced by a durable claim the collector supplies, taken
 *     before the request, so a refusal or crash still spends the interval;
 *   - it asks Claude Haiku for one output token. Haiku accepts a subscription
 *     token without the Claude Code system prompt, so the request never presents
 *     itself as Claude Code;
 *   - only the five-hour and seven-day utilisation and reset headers are read.
 *     The response body is discarded unread, and nothing else is stored.
 *
 * Claude stays one collector adapter. `createClaudeAdapter` composes this probe
 * with the spool ingestor, so a run records one Claude attempt and at most one
 * new snapshot, whichever source observed most recently.
 */
import { CollectionDeferred, CollectionError, classifyHttpStatus } from '../errors';
import { CLAUDE_PROBE_SOURCE_VERSION } from '../domain';
import type { CollectContext, ProviderAdapter, QuotaSnapshot, QuotaWindow } from '../domain';
import { CLAUDE_WINDOW_META, createClaudeIngestor } from '../ingestors/claude-statusline';
import { ageMs, epochSecondsToIso, nowIso } from '../time';
import { postJsonForHeaders } from './http';

export const CLAUDE_PROBE_SCHEMA_VERSION = 1;
export const CLAUDE_PROBE_URL = 'https://api.anthropic.com/v1/messages';
export const CLAUDE_PROBE_ANTHROPIC_VERSION = '2023-06-01';
export const CLAUDE_PROBE_OAUTH_BETA = 'oauth-2025-04-20';

/**
 * The smallest request that returns the headers: the cheapest current model, one
 * output token, one character of input, no system prompt.
 */
export const CLAUDE_PROBE_BODY = Object.freeze({
  model: 'claude-haiku-4-5',
  max_tokens: 1,
  messages: [{ role: 'user', content: '.' }],
});

const CLAUDE_PROBE_TIMEOUT_MS = 15_000;

const UNIFIED_PREFIX = 'anthropic-ratelimit-unified-';

/**
 * Header window names mapped to the status line's window keys. The status line
 * is fed from these same headers, so the two sources share bucket ids, labels,
 * durations, and one history series.
 */
export const CLAUDE_PROBE_WINDOWS: readonly (readonly [header: string, windowKind: string])[] = [
  ['5h', 'five_hour'],
  ['7d', 'seven_day'],
];

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;
const EPOCH_SECONDS = /^\d{1,11}$/;

function drift(message: string): CollectionError {
  return new CollectionError('schema_mismatch', message);
}

/**
 * A 0..1 utilisation fraction as a percentage, shifted in decimal so `0.07`
 * becomes exactly 7 rather than `7.000000000000001`.
 */
function fractionToPercent(value: string): number | null {
  const match = DECIMAL.exec(value);
  if (!match) return null;
  const whole = match[1] ?? '';
  const fraction = match[2] ?? '';
  const shifted = `${whole}${fraction.padEnd(2, '0').slice(0, 2)}`;
  const rest = fraction.slice(2);
  const percent = Number(rest ? `${shifted}.${rest}` : shifted);
  return Number.isFinite(percent) ? percent : null;
}

/** Whether a response carries any window this adapter reads. */
function hasWindowHeaders(headers: Headers): boolean {
  return CLAUDE_PROBE_WINDOWS.some(
    ([name]) =>
      headers.has(`${UNIFIED_PREFIX}${name}-utilization`) ||
      headers.has(`${UNIFIED_PREFIX}${name}-reset`),
  );
}

/**
 * Map a response's rate-limit headers to a quota snapshot, or throw.
 *
 * Every message names a header only. No header value ever reaches an error.
 */
export function normalizeClaudeRateLimitHeaders(
  headers: Headers,
  observedAt: string = nowIso(),
): QuotaSnapshot {
  const windows: QuotaWindow[] = [];
  for (const [name, windowKind] of CLAUDE_PROBE_WINDOWS) {
    const utilizationHeader = `${UNIFIED_PREFIX}${name}-utilization`;
    const resetHeader = `${UNIFIED_PREFIX}${name}-reset`;
    const utilization = headers.get(utilizationHeader);
    const reset = headers.get(resetHeader);
    // A plan without this window sends neither header.
    if (utilization === null && reset === null) continue;
    if (utilization === null) throw drift(`${utilizationHeader} is absent`);
    if (reset === null) throw drift(`${resetHeader} is absent`);

    const usedPercent = fractionToPercent(utilization.trim());
    if (usedPercent === null) throw drift(`${utilizationHeader} is not a decimal number`);
    if (usedPercent < 0 || usedPercent > 100) throw drift(`${utilizationHeader} is outside 0..1`);

    const resetsAt = EPOCH_SECONDS.test(reset.trim())
      ? epochSecondsToIso(Number(reset.trim()))
      : null;
    if (resetsAt === null) throw drift(`${resetHeader} is not a plausible epoch-seconds time`);

    windows.push({
      bucketId: windowKind,
      windowKind,
      usedPercent,
      windowDurationMinutes: CLAUDE_WINDOW_META[windowKind]?.durationMinutes ?? null,
      resetsAt,
    });
  }

  if (windows.length === 0) {
    const unified = [...headers.keys()].some((key) => key.startsWith(UNIFIED_PREFIX));
    if (unified) throw drift('no rate-limit window this adapter recognises was reported');
    throw new CollectionError(
      'not_entitled',
      'the response carried no subscription rate-limit headers',
    );
  }

  return {
    kind: 'quota',
    provider: 'claude',
    observedAt,
    collectedAt: nowIso(),
    sourceVersion: CLAUDE_PROBE_SOURCE_VERSION,
    schemaVersion: CLAUDE_PROBE_SCHEMA_VERSION,
    // As for the status line: the headers' status fields are not read, and
    // permission is never inferred from a percentage.
    usageAllowed: null,
    limitReachedCode: null,
    // Polled observations are never deduplicated.
    sourceEventId: null,
    windows,
  };
}

export interface ClaudeQuotaProbeOptions {
  readonly token: string;
  readonly timeoutMs?: number;
  readonly url?: string;
  readonly fetchImpl?: typeof fetch;
}

/** Exactly one request, with no retry of any kind. */
export async function probeClaudeQuota(
  options: ClaudeQuotaProbeOptions,
  signal: AbortSignal,
): Promise<QuotaSnapshot> {
  const response = await postJsonForHeaders({
    url: options.url ?? CLAUDE_PROBE_URL,
    bearerToken: options.token,
    timeoutMs: options.timeoutMs ?? CLAUDE_PROBE_TIMEOUT_MS,
    signal,
    headers: {
      'anthropic-version': CLAUDE_PROBE_ANTHROPIC_VERSION,
      'anthropic-beta': CLAUDE_PROBE_OAUTH_BETA,
    },
    body: CLAUDE_PROBE_BODY,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const observedAt = nowIso();
  const ok = response.status >= 200 && response.status < 300;
  // A subscription at its limit is refused with 429 but still reports the
  // windows that refused it: that is a reading, not a failure.
  if (ok || (response.status === 429 && hasWindowHeaders(response.headers))) {
    return normalizeClaudeRateLimitHeaders(response.headers, observedAt);
  }
  throw new CollectionError(
    classifyHttpStatus(response.status),
    `provider responded with HTTP ${response.status}`,
  );
}

export interface ClaudeAdapterOptions {
  readonly spoolPath: string;
  /** The saved Claude token. `null` means the probe is off. */
  readonly usageToken: string | null;
  /**
   * Claim the next permitted probe, durably and atomically, at `attemptedAt`.
   * Returns false when another run already probed within the interval.
   */
  readonly claimPoll: (attemptedAt: string) => boolean;
  /**
   * A status-line reading no older than this answers the run by itself, and no
   * probe is sent: the collector passes the probe's own freshness budget.
   */
  readonly spoolFreshMs: number;
  readonly probeTimeoutMs?: number;
  readonly url?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * The single Claude collector adapter.
 *
 * With no token it *is* the spool ingestor, unchanged. With one, it reads the
 * spool first and stops there when that reading is fresh. Otherwise it claims
 * and makes at most one probe, and returns whichever observation is newer. Any
 * probe failure falls back to the spool; only when the spool has nothing usable
 * does the probe's own error explain the card. A run that lost the claim and has
 * no usable spool defers: it records nothing, so the card keeps the last probe's
 * result and ages it instead of turning `unavailable` over a probe this run
 * never made.
 */
export function createClaudeAdapter(options: ClaudeAdapterOptions): ProviderAdapter<QuotaSnapshot> {
  const spool = createClaudeIngestor({ spoolPath: options.spoolPath });
  const token = options.usageToken;
  if (!token) return spool;

  const probeTimeoutMs = options.probeTimeoutMs ?? CLAUDE_PROBE_TIMEOUT_MS;
  return {
    provider: 'claude',
    schemaVersion: CLAUDE_PROBE_SCHEMA_VERSION,
    // Room for a spool read and the probe's own timeout after it, so a slow
    // probe still falls back instead of being cut off by the collector's ceiling.
    timeoutMs: spool.timeoutMs + probeTimeoutMs + 1000,
    async collect(signal: AbortSignal, context?: CollectContext): Promise<QuotaSnapshot> {
      let spooled: QuotaSnapshot | null = null;
      let spoolError: unknown = null;
      try {
        spooled = await spool.collect(signal, context);
      } catch (err) {
        spoolError = err;
      }
      // A live session is already reporting: a probe would spend quota to learn
      // nothing new.
      if (spooled && ageMs(spooled.observedAt) <= options.spoolFreshMs) return spooled;

      let probed: QuotaSnapshot | null = null;
      let probeError: CollectionError | null = null;
      const claimed = claim(options.claimPoll);
      if (claimed) {
        try {
          probed = await probeClaudeQuota(
            {
              token,
              timeoutMs: probeTimeoutMs,
              ...(options.url ? { url: options.url } : {}),
              ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            },
            signal,
          );
        } catch (err) {
          probeError =
            err instanceof CollectionError
              ? err
              : new CollectionError('unknown_error', 'the Claude quota probe failed');
        }
      }

      if (probed && spooled) {
        return Date.parse(spooled.observedAt) > Date.parse(probed.observedAt) ? spooled : probed;
      }
      if (probed) return probed;
      if (spooled) return spooled;
      if (!claimed) {
        // This run neither probed nor observed anything. The run holding the
        // claim owns the answer — a stored reading, its error, or a request
        // still in flight — so this one must not record a verdict over it.
        throw new CollectionDeferred(
          'another run holds the Claude quota probe for this interval and the status-line spool has nothing usable',
        );
      }
      // The user configured the token, so the probe's code is the one that
      // explains the card, not the spool's.
      throw probeError ?? spoolError;
    },
  };
}

/**
 * A claim that cannot be written is treated as lost: skipping one probe is
 * always safe, and sending one without a durable claim is not.
 */
function claim(claimPoll: (attemptedAt: string) => boolean): boolean {
  try {
    return claimPoll(nowIso());
  } catch {
    return false;
  }
}
