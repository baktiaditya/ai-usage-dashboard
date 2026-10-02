/**
 * Claude Code spool ingestor.
 *
 * Claude quota is push-shaped, not pull-shaped: the status line only fires
 * while a session is active and only after the first API response of that
 * session. So this ingestor reads whatever the bridge last wrote and is
 * explicit about the three ways there can be nothing to report:
 *
 *   - no spool file          -> `no_event_yet`  ("bridge not installed / never run")
 *   - spool with no quota    -> `not_entitled`  ("bridge ran; this account shows no rate_limits")
 *   - spool older than policy-> a snapshot that the freshness layer marks `stale`
 *
 * Crucially, an old event is never presented as current. The freshness rules
 * live in freshness.ts; this module's job is to hand up a truthful observation
 * with its real `observedAt`.
 */
import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { CollectionError } from '../errors';
import type { ProviderAdapter, QuotaSnapshot, QuotaWindow } from '../domain';
import { epochSecondsToIso, nowIso } from '../time';

export const CLAUDE_SCHEMA_VERSION = 1;
/** Highest spool format this build understands. */
export const SUPPORTED_SPOOL_SCHEMA_VERSION = 1;

/** Display metadata for the windows the bridge is allowed to forward. */
export const CLAUDE_WINDOW_META: Record<string, { label: string; durationMinutes: number | null }> =
  {
    five_hour: { label: '5 hour', durationMinutes: 300 },
    seven_day: { label: '7 day', durationMinutes: 10_080 },
    // A spend limit is a monthly cap expressed as a percentage. It is a gauge
    // like the others, but its window length is account-specific and not stated.
    spend_limit: { label: 'Spend limit', durationMinutes: null },
  };

const windowSchema = z.object({
  usedPercentage: z.number().finite(),
  resetsAt: z.number().int().nullable(),
});

const spoolSchema = z.object({
  spoolSchemaVersion: z.number().int(),
  eventId: z.string().min(8).max(64),
  observedAt: z.string().min(20),
  cliVersion: z.string().nullable(),
  hasRateLimits: z.boolean(),
  rateLimits: z.record(z.string(), windowSchema).nullable(),
});

export type SpoolEvent = z.infer<typeof spoolSchema>;

export function parseSpoolEvent(text: string): SpoolEvent {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CollectionError('schema_mismatch', 'spool file is not valid JSON');
  }

  const parsed = spoolSchema.safeParse(json);
  if (!parsed.success) {
    throw new CollectionError(
      'schema_mismatch',
      `spool event missing fields: ${parsed.error.issues
        .map((i) => i.path.join('.'))
        .slice(0, 5)
        .join(', ')}`,
    );
  }

  // A newer bridge writing an unknown format must fail with version_unsupported
  // so the card shows an error instead of a confidently wrong number.
  if (parsed.data.spoolSchemaVersion > SUPPORTED_SPOOL_SCHEMA_VERSION) {
    throw new CollectionError(
      'version_unsupported',
      `spool schema v${parsed.data.spoolSchemaVersion} is newer than supported v${SUPPORTED_SPOOL_SCHEMA_VERSION}`,
    );
  }

  if (!Number.isFinite(Date.parse(parsed.data.observedAt))) {
    throw new CollectionError('schema_mismatch', 'spool observedAt is not a valid timestamp');
  }

  return parsed.data;
}

export function spoolEventToSnapshot(event: SpoolEvent): QuotaSnapshot {
  if (!event.hasRateLimits || event.rateLimits === null) {
    throw new CollectionError(
      'not_entitled',
      'the status line ran but this account exposed no rate_limits',
    );
  }

  const windows: QuotaWindow[] = Object.entries(event.rateLimits)
    // Only windows this build knows how to label are kept; an unknown key is
    // ignored rather than rendered with a guessed duration.
    .filter(([key]) => key in CLAUDE_WINDOW_META)
    .map(([key, w]) => ({
      bucketId: key,
      windowKind: key,
      usedPercent: w.usedPercentage,
      windowDurationMinutes: CLAUDE_WINDOW_META[key]?.durationMinutes ?? null,
      resetsAt: epochSecondsToIso(w.resetsAt),
    }));

  if (windows.length === 0) {
    throw new CollectionError('not_entitled', 'no recognised rate-limit window in the spool event');
  }

  return {
    kind: 'quota',
    provider: 'claude',
    observedAt: new Date(event.observedAt).toISOString(),
    collectedAt: nowIso(),
    sourceVersion: event.cliVersion ? `claude-code/${event.cliVersion}` : 'claude-code/unknown',
    schemaVersion: CLAUDE_SCHEMA_VERSION,
    usageAllowed: null,
    limitReachedCode: null,
    // The dedup key: re-reading an unchanged spool file inserts nothing.
    sourceEventId: event.eventId,
    windows,
  };
}

export interface ClaudeIngestorOptions {
  readonly spoolPath: string;
  readonly timeoutMs?: number;
}

export function createClaudeIngestor(
  options: ClaudeIngestorOptions,
): ProviderAdapter<QuotaSnapshot> {
  return {
    provider: 'claude',
    schemaVersion: CLAUDE_SCHEMA_VERSION,
    timeoutMs: options.timeoutMs ?? 2000,
    // Reading one small local file needs no cancellation signal.
    async collect(): Promise<QuotaSnapshot> {
      let text: string;
      try {
        statSync(options.spoolPath);
        text = readFileSync(options.spoolPath, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new CollectionError(
            'no_event_yet',
            'no status-line event has been recorded yet; run `pnpm run claude:install-statusline` and start a Claude Code session',
          );
        }
        throw new CollectionError('io_error', 'the spool file could not be read');
      }
      return spoolEventToSnapshot(parseSpoolEvent(text));
    },
  };
}
