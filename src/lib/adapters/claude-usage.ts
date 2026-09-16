/**
 * Claude usage poll — GET https://api.anthropic.com/api/oauth/usage
 *
 * The optional, default-off pull source of plan §3.1, gated in
 * docs/discovery/m0-discovery.md. It answers with no Claude Code session
 * running, which the status-line spool cannot. It is undocumented, so a shape
 * change is expected rather than exceptional, and it escalates refusals with no
 * `Retry-After`, so:
 *
 *   - it is called at most once per run and never retried — not through
 *     `withBoundedRetry`, whose retryable codes include `rate_limited`;
 *   - the cadence is enforced by a durable claim the collector supplies, taken
 *     before the request, so a refusal or crash still spends the interval;
 *   - only the normalised `limits[]` projection is read. The individual window
 *     keys, the dollar fields, the per-model breakdown and every unrecognised
 *     key are ignored, and nothing from the payload is stored beyond the
 *     validated gauges.
 *
 * Claude stays one collector adapter. `createClaudeAdapter` composes this poll
 * with the spool ingestor, so a run records one Claude attempt and at most one
 * new snapshot, whichever source observed most recently.
 */
import { CollectionDeferred, CollectionError } from '../errors';
import { CLAUDE_USAGE_SOURCE_VERSION } from '../domain';
import type { CollectContext, ProviderAdapter, QuotaSnapshot, QuotaWindow } from '../domain';
import { createClaudeIngestor } from '../ingestors/claude-statusline';
import { isRawNumber } from '../money';
import { isRealInstant, nowIso } from '../time';
import { getJsonLossless } from './http';

export const CLAUDE_USAGE_SCHEMA_VERSION = 1;
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/**
 * Claude Code identifies itself this way and the endpoint is known to accept
 * it. 2.1.269 is this project's minimum supported CLI, so the poll claims no
 * newer contract than the dashboard already relies on.
 */
export const CLAUDE_USAGE_USER_AGENT = 'claude-cli/2.1.269 (external, cli)';
export const CLAUDE_USAGE_OAUTH_BETA = 'oauth-2025-04-20';

const CLAUDE_USAGE_TIMEOUT_MS = 10_000;

/**
 * `limits[].kind` values this build labels (`WINDOW_LABELS` in
 * src/lib/queries/overview.ts). Any other kind is refused rather than rendered:
 * an unlabelled window would show the endpoint's internal name in the browser.
 */
export const CLAUDE_USAGE_WINDOW_KINDS: ReadonlySet<string> = new Set(['session', 'weekly_all']);

function drift(message: string): CollectionError {
  return new CollectionError('schema_mismatch', message);
}

/** A JSON number as the lossless parser leaves it, or as plain `JSON.parse` does. */
function readNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (isRawNumber(value)) {
    const n = Number(value.__rawNumber);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function nullableString(row: Record<string, unknown>, key: string, at: string): string | null {
  if (!Object.hasOwn(row, key)) throw drift(`${at}.${key} is absent`);
  const value = row[key];
  if (value !== null && typeof value !== 'string') {
    throw drift(`${at}.${key} is neither null nor a string`);
  }
  return value;
}

/**
 * The bucket id is derived only from the fields that identify a limit — never
 * from its position — as `kind`, then `group` and `scope` when present.
 */
export function claudeUsageBucketId(kind: string, group: string | null, scope: string | null) {
  return [kind, group, scope].filter((part): part is string => part !== null).join(':');
}

/**
 * Map a `limits[]` payload to a quota snapshot, or throw.
 *
 * Every message names a field and an array index only. No value, and no kind
 * the build does not recognise, ever reaches an error message.
 */
export function normalizeClaudeUsageResponse(
  raw: unknown,
  observedAt: string = nowIso(),
): QuotaSnapshot {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw drift('usage payload is not a JSON object');
  }
  const limits = (raw as Record<string, unknown>)['limits'];
  if (limits === undefined) {
    throw new CollectionError('not_entitled', 'the usage endpoint reported no limits');
  }
  if (!Array.isArray(limits)) throw drift('limits is not an array');

  const active: QuotaWindow[] = [];
  const seen = new Set<string>();
  limits.forEach((entry: unknown, index) => {
    const at = `limits[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw drift(`${at} is not an object`);
    }
    const row = entry as Record<string, unknown>;
    if (typeof row['is_active'] !== 'boolean') throw drift(`${at}.is_active is not a boolean`);
    // An inactive limit is not a gauge; its remaining fields are irrelevant.
    if (!row['is_active']) return;

    const kind = row['kind'];
    if (typeof kind !== 'string' || kind.length === 0) throw drift(`${at}.kind is not a string`);
    // Read for drift only; the dashboard derives its own severity.
    if (typeof row['severity'] !== 'string') throw drift(`${at}.severity is not a string`);
    const group = nullableString(row, 'group', at);
    const scope = nullableString(row, 'scope', at);

    const percent = readNumber(row['percent']);
    if (percent === null) throw drift(`${at}.percent is not a finite number`);
    if (percent < 0 || percent > 100) throw drift(`${at}.percent is outside 0..100`);

    // Already ISO-8601 here, unlike the spool's epoch seconds: stored verbatim.
    const resetsAt = nullableString(row, 'resets_at', at);
    if (resetsAt !== null && !isRealInstant(resetsAt)) {
      throw drift(`${at}.resets_at is not a real ISO-8601 instant`);
    }

    const bucketId = claudeUsageBucketId(kind, group, scope);
    // Two limits with one identity would reach the (snapshot, bucket, kind)
    // unique constraint; letting it pick a survivor would be a guess.
    if (seen.has(bucketId)) throw drift(`${at} repeats the identity of an earlier limit`);
    seen.add(bucketId);

    active.push({
      bucketId,
      windowKind: kind,
      usedPercent: percent,
      // `limits[]` states no duration, and inferring one from a name is a guess.
      windowDurationMinutes: null,
      resetsAt,
    });
  });

  if (active.length === 0) {
    throw new CollectionError('not_entitled', 'the usage endpoint reported no active limit');
  }

  const windows = active.filter((w) => CLAUDE_USAGE_WINDOW_KINDS.has(w.windowKind));
  if (windows.length === 0) {
    throw drift('no active limit has a kind this adapter recognises');
  }

  return {
    kind: 'quota',
    provider: 'claude',
    observedAt,
    collectedAt: nowIso(),
    sourceVersion: CLAUDE_USAGE_SOURCE_VERSION,
    schemaVersion: CLAUDE_USAGE_SCHEMA_VERSION,
    usageAllowed: null,
    limitReachedCode: null,
    // Polled observations are never deduplicated.
    sourceEventId: null,
    windows,
  };
}

export interface ClaudeUsagePollOptions {
  readonly token: string;
  readonly timeoutMs?: number;
  readonly url?: string;
  readonly fetchImpl?: typeof fetch;
}

/** Exactly one request, with no retry of any kind. */
export async function pollClaudeUsage(
  options: ClaudeUsagePollOptions,
  signal: AbortSignal,
): Promise<QuotaSnapshot> {
  const raw = await getJsonLossless({
    url: options.url ?? CLAUDE_USAGE_URL,
    bearerToken: options.token,
    timeoutMs: options.timeoutMs ?? CLAUDE_USAGE_TIMEOUT_MS,
    signal,
    headers: { 'User-Agent': CLAUDE_USAGE_USER_AGENT, 'anthropic-beta': CLAUDE_USAGE_OAUTH_BETA },
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  return normalizeClaudeUsageResponse(raw, nowIso());
}

export interface ClaudeAdapterOptions {
  readonly spoolPath: string;
  /** The saved Claude token. `null` means the poll is off. */
  readonly usageToken: string | null;
  /**
   * Claim the next permitted poll, durably and atomically, at `attemptedAt`.
   * Returns false when another run already polled within the interval.
   */
  readonly claimPoll: (attemptedAt: string) => boolean;
  readonly pollTimeoutMs?: number;
  readonly url?: string;
  readonly fetchImpl?: typeof fetch;
}

/**
 * The single Claude collector adapter.
 *
 * With no token it *is* the spool ingestor, unchanged. With one, it claims and
 * makes at most one poll, always reads the spool too, and returns whichever
 * observation is newer. Any poll failure falls back to the spool; only when the
 * spool has nothing usable does the poll's own error explain the card. A run
 * that lost the claim and has no usable spool defers: it records nothing, so the
 * card keeps the last poll's result and ages it instead of turning
 * `unavailable` over a poll this run never made.
 */
export function createClaudeAdapter(options: ClaudeAdapterOptions): ProviderAdapter<QuotaSnapshot> {
  const spool = createClaudeIngestor({ spoolPath: options.spoolPath });
  const token = options.usageToken;
  if (!token) return spool;

  const pollTimeoutMs = options.pollTimeoutMs ?? CLAUDE_USAGE_TIMEOUT_MS;
  return {
    provider: 'claude',
    schemaVersion: CLAUDE_USAGE_SCHEMA_VERSION,
    // Room for the poll's own timeout and a spool read after it, so a slow poll
    // still falls back instead of being cut off by the collector's ceiling.
    timeoutMs: pollTimeoutMs + spool.timeoutMs + 1000,
    async collect(signal: AbortSignal, context?: CollectContext): Promise<QuotaSnapshot> {
      let polled: QuotaSnapshot | null = null;
      let pollError: CollectionError | null = null;
      const claimed = claim(options.claimPoll);
      if (claimed) {
        try {
          polled = await pollClaudeUsage(
            {
              token,
              timeoutMs: pollTimeoutMs,
              ...(options.url ? { url: options.url } : {}),
              ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            },
            signal,
          );
        } catch (err) {
          pollError =
            err instanceof CollectionError
              ? err
              : new CollectionError('unknown_error', 'the Claude usage poll failed');
        }
      }

      let spooled: QuotaSnapshot | null = null;
      let spoolError: unknown = null;
      try {
        spooled = await spool.collect(signal, context);
      } catch (err) {
        spoolError = err;
      }

      if (polled && spooled) {
        return Date.parse(spooled.observedAt) > Date.parse(polled.observedAt) ? spooled : polled;
      }
      if (polled) return polled;
      if (spooled) return spooled;
      if (!claimed) {
        // This run neither polled nor observed anything. The run holding the
        // claim owns the answer — a stored reading, its error, or a request
        // still in flight — so this one must not record a verdict over it.
        throw new CollectionDeferred(
          'another run holds the Claude usage poll for this interval and the status-line spool has nothing usable',
        );
      }
      // The user configured the token, so the poll's code is the one that
      // explains the card, not the spool's.
      throw pollError ?? spoolError;
    },
  };
}

/**
 * A claim that cannot be written is treated as lost: skipping one poll is
 * always safe, and calling the endpoint without a durable claim is not.
 */
function claim(claimPoll: (attemptedAt: string) => boolean): boolean {
  try {
    return claimPoll(nowIso());
  } catch {
    return false;
  }
}
