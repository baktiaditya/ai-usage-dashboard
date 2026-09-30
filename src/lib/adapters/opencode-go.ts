/**
 * OpenCode Go adapter — GET https://opencode.ai/zen/go/v1/usage
 *
 * Added upstream in anomalyco/opencode#16513 and verified live 2026-09-30
 * (docs/discovery/m0-discovery.md). OpenCode's public docs do not describe it
 * yet, so the shape below is observed, not contractual:
 *
 *   { usage: { rolling|weekly|monthly: { status: "ok" | "rate-limited",
 *                                        percent: <used, 0..100>,
 *                                        resetsAt: <ISO-8601> } } }
 *
 * Only the Bearer header is read. `401` is a rejected key; `403` is a valid key
 * with no Go subscription behind it, which is `not_entitled`, not a broken
 * credential.
 *
 * The response carries percentages only: no dollar limit, no plan tier, no
 * account identifier. Nothing here derives dollars from them (plan §10).
 *
 * `usageAllowed` is always `null`. A `rate-limited` window means the plan's own
 * allowance is spent, but the console's "Use balance" option can keep requests
 * flowing on Zen credit, and the response does not say whether it is on.
 */
import { z } from 'zod';
import { CollectionError } from '../errors';
import type { CollectContext, ProviderAdapter, QuotaSnapshot, QuotaWindow } from '../domain';
import { nowIso } from '../time';
import { getJsonLossless, withBoundedRetry } from './http';

export const OPENCODE_GO_SCHEMA_VERSION = 1;
export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
export const OPENCODE_GO_SOURCE_VERSION = 'opencode-api/zen-go-v1-usage';

/**
 * The three windows, in the order a limit-reached code is chosen from.
 * `weekly` is a calendar week ending Monday 00:00 UTC, so it always lasts seven
 * days; `monthly` runs from the billing anniversary and has no fixed length.
 */
const WINDOWS = [
  { key: 'rolling', durationMinutes: 300 },
  { key: 'weekly', durationMinutes: 10080 },
  { key: 'monthly', durationMinutes: null },
] as const;

/**
 * `getJsonLossless` hands every JSON number over as its source text, so a
 * percentage arrives as `{ __rawNumber: "41" }`, not `41`. A plain number is
 * accepted too, for payloads parsed any other way. The source value is kept,
 * never clamped; presentation clamps.
 */
const percentSchema = z
  .union([z.number(), z.object({ __rawNumber: z.string() })])
  .transform((v) => (typeof v === 'number' ? v : Number(v.__rawNumber)))
  .pipe(z.number().min(0));

const windowSchema = z
  .object({
    status: z.enum(['ok', 'rate-limited']),
    percent: percentSchema,
    resetsAt: z.iso.datetime({ offset: true }),
  })
  .loose();

const usageResponseSchema = z
  .object({
    usage: z.object({ rolling: windowSchema, weekly: windowSchema, monthly: windowSchema }).loose(),
  })
  .loose();

export function normalizeOpencodeGoResponse(
  raw: unknown,
  observedAt: string = nowIso(),
): QuotaSnapshot {
  const parsed = usageResponseSchema.safeParse(raw);
  if (!parsed.success) {
    // Only field paths are reported: the payload itself is never echoed.
    throw new CollectionError(
      'schema_mismatch',
      `usage payload did not match: ${parsed.error.issues
        .map((i) => i.path.join('.'))
        .slice(0, 5)
        .join(', ')}`,
    );
  }
  const usage = parsed.data.usage;

  const windows: QuotaWindow[] = WINDOWS.map(({ key, durationMinutes }) => ({
    bucketId: 'go',
    windowKind: key,
    usedPercent: usage[key].percent,
    windowDurationMinutes: durationMinutes,
    resetsAt: new Date(usage[key].resetsAt).toISOString(),
  }));

  const limited = WINDOWS.find(({ key }) => usage[key].status === 'rate-limited');

  return {
    kind: 'quota',
    provider: 'opencode_go',
    observedAt,
    collectedAt: nowIso(),
    sourceVersion: OPENCODE_GO_SOURCE_VERSION,
    schemaVersion: OPENCODE_GO_SCHEMA_VERSION,
    usageAllowed: null,
    limitReachedCode: limited ? `${limited.key}_rate_limited` : null,
    sourceEventId: null,
    windows,
  };
}

export interface OpencodeGoAdapterOptions {
  readonly apiKey: string | null;
  readonly timeoutMs?: number;
  /** Tests only. The key is never sent anywhere but the canonical host. */
  readonly url?: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxRetries?: number;
}

export function createOpencodeGoAdapter(
  options: OpencodeGoAdapterOptions,
): ProviderAdapter<QuotaSnapshot> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return {
    provider: 'opencode_go',
    schemaVersion: OPENCODE_GO_SCHEMA_VERSION,
    timeoutMs,
    async collect(signal: AbortSignal, context?: CollectContext): Promise<QuotaSnapshot> {
      if (!options.apiKey) {
        throw new CollectionError('not_configured', 'OpenCode Go API key is not saved in Settings');
      }
      let value: unknown;
      try {
        // A read-only GET that spends no quota, so a transient failure is
        // safe to retry.
        ({ value } = await withBoundedRetry(
          () =>
            getJsonLossless({
              url: options.url ?? OPENCODE_GO_USAGE_URL,
              bearerToken: options.apiKey as string,
              timeoutMs,
              signal,
              ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
            }),
          {
            maxRetries: options.maxRetries ?? 2,
            baseDelayMs: 500,
            signal,
            onRetry: () => context?.recordRetry(),
          },
        ));
      } catch (err) {
        if (err instanceof CollectionError && err.code === 'insufficient_scope') {
          throw new CollectionError('not_entitled', 'this key has no OpenCode Go subscription');
        }
        throw err;
      }
      return normalizeOpencodeGoResponse(value);
    },
  };
}
