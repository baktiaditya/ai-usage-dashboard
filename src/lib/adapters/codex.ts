/**
 * Codex adapter — official app-server JSON-RPC.
 *
 * Contract verified 2026-09-12 against codex-cli 0.154.0 via
 * `codex app-server generate-json-schema` plus a live
 * `account/rateLimits/read` handshake. See docs/M0_DISCOVERY.md.
 *
 * What this deliberately does *not* do: read ~/.codex/auth.json, extract an
 * OAuth token, call the backend directly, or parse `codex /status` output.
 * Authentication stays entirely inside the CLI.
 */
import { z } from 'zod';
import { CollectionError } from '../errors';
import type { ProviderAdapter, QuotaSnapshot, QuotaWindow } from '../domain';
import { epochSecondsToIso, nowIso } from '../time';
import { JsonRpcProcessClient } from './jsonrpc';

export const CODEX_SCHEMA_VERSION = 1;

/**
 * Runtime validation covers only the subset the dashboard renders.
 *
 * `.passthrough()` on the snapshot is intentional: the app-server adds fields
 * between releases (`rateLimitUpsell`, `individualLimit`, …) and an unknown
 * field must not turn a working read into an error. Fields we do not list are
 * simply never copied out.
 */
const rateLimitWindowSchema = z
  .object({
    usedPercent: z.number().finite(),
    windowDurationMins: z.number().int().nullish(),
    resetsAt: z.number().int().nullish(),
  })
  .loose();

const rateLimitSnapshotSchema = z
  .object({
    limitId: z.string().nullish(),
    primary: rateLimitWindowSchema.nullish(),
    secondary: rateLimitWindowSchema.nullish(),
    rateLimitReachedType: z.string().nullish(),
  })
  .loose();

const rateLimitsResponseSchema = z
  .object({
    ordinaryUsageAllowed: z.boolean().nullish(),
    rateLimits: rateLimitSnapshotSchema,
    rateLimitsByLimitId: z.record(z.string(), rateLimitSnapshotSchema).nullish(),
  })
  .loose();

type RateLimitSnapshotShape = z.infer<typeof rateLimitSnapshotSchema>;

export interface CodexAdapterOptions {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
  readonly cliVersion?: string;
}

/**
 * Flatten one bucket into zero, one, or two windows.
 *
 * `bucketId` comes from the map key or `limitId` — never from array position —
 * so the UI labels a window by what it is, not by where it happened to appear.
 */
function windowsFrom(bucketId: string, snapshot: RateLimitSnapshotShape): QuotaWindow[] {
  const out: QuotaWindow[] = [];
  for (const kind of ['primary', 'secondary'] as const) {
    const w = snapshot[kind];
    if (!w) continue;
    out.push({
      bucketId,
      windowKind: kind,
      usedPercent: w.usedPercent,
      windowDurationMinutes: w.windowDurationMins ?? null,
      resetsAt: epochSecondsToIso(w.resetsAt ?? null),
    });
  }
  return out;
}

export function normalizeCodexResponse(
  raw: unknown,
  sourceVersion: string,
  observedAt: string = nowIso(),
): QuotaSnapshot {
  const parsed = rateLimitsResponseSchema.safeParse(raw);
  if (!parsed.success) {
    throw new CollectionError(
      'schema_mismatch',
      `rateLimits payload missing required fields: ${parsed.error.issues
        .map((i) => i.path.join('.'))
        .slice(0, 5)
        .join(', ')}`,
    );
  }
  const data = parsed.data;

  // Prefer the multi-bucket view; fall back to the legacy single bucket so an
  // older app-server still reports something correct rather than nothing.
  const buckets = new Map<string, RateLimitSnapshotShape>();
  if (data.rateLimitsByLimitId && Object.keys(data.rateLimitsByLimitId).length > 0) {
    for (const [limitId, snapshot] of Object.entries(data.rateLimitsByLimitId)) {
      buckets.set(limitId, snapshot);
    }
  } else {
    buckets.set(data.rateLimits.limitId ?? 'default', data.rateLimits);
  }

  const windows = [...buckets.entries()].flatMap(([id, snap]) => windowsFrom(id, snap));

  if (windows.length === 0) {
    // A structurally valid response with no window at all means this account
    // has no metered quota to show — unavailable, not an error.
    throw new CollectionError('not_entitled', 'no rate limit window reported for this account');
  }

  return {
    kind: 'quota',
    provider: 'codex',
    observedAt,
    collectedAt: nowIso(),
    sourceVersion,
    schemaVersion: CODEX_SCHEMA_VERSION,
    usageAllowed: data.ordinaryUsageAllowed ?? null,
    limitReachedCode: data.rateLimits.rateLimitReachedType ?? null,
    sourceEventId: null,
    windows,
  };
}

export function createCodexAdapter(
  options: CodexAdapterOptions = {},
): ProviderAdapter<QuotaSnapshot> {
  const command = options.command ?? 'codex';
  const args = options.args ?? ['app-server'];
  const timeoutMs = options.timeoutMs ?? 20_000;

  return {
    provider: 'codex',
    schemaVersion: CODEX_SCHEMA_VERSION,
    timeoutMs,
    async collect(signal: AbortSignal): Promise<QuotaSnapshot> {
      const client = new JsonRpcProcessClient({ command, args, timeoutMs });
      try {
        client.start();

        const init = await client.request(
          'initialize',
          { clientInfo: { name: 'ai-usage-dashboard', version: '0.1.0' } },
          signal,
        );
        // The handshake is not complete until `initialized` is sent; the server
        // will not answer subsequent requests without it.
        client.notify('initialized', {});

        const sourceVersion = deriveSourceVersion(init, options.cliVersion);
        const raw = await client.request('account/rateLimits/read', {}, signal);
        return normalizeCodexResponse(raw, sourceVersion);
      } finally {
        // Always reap the child, including when the request threw or aborted.
        client.close();
      }
    },
  };
}

/**
 * Derive a version string for diagnostics.
 *
 * The app-server reports its own version inside `userAgent`; parsing that
 * avoids a second process spawn just to run `codex --version`.
 */
function deriveSourceVersion(init: unknown, override?: string): string {
  if (override) return `codex-cli/${override}`;
  const ua = (init as { userAgent?: unknown } | null)?.userAgent;
  if (typeof ua === 'string') {
    const m = /\/(\d+\.\d+\.\d+)/.exec(ua);
    if (m?.[1]) return `codex-cli/${m[1]}`;
  }
  return 'codex-cli/unknown';
}
