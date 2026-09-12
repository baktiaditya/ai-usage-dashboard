/**
 * Collector orchestration — the single path for both scheduled and manual runs.
 *
 * Two invariants drive the design:
 *
 *   - **Provider isolation.** Providers run concurrently with independent
 *     timeouts, and one failing must never shorten or fail another. Every
 *     adapter result is therefore reduced to a `CollectionResult` before any of
 *     them is awaited together — `Promise.all` over functions that cannot
 *     reject.
 *   - **One run, one attempt per provider.** Success and failure counts are
 *     derived from the attempt rows, so a partial run is fully auditable and
 *     the summary can never drift from the detail.
 */
import type { AppConfig } from '../config';
import type { CollectionResult, Provider, ProviderAdapter } from '../domain';
import { CollectionError, isRetryable, isUnavailable } from '../errors';
import type { ErrorCode } from '../errors';
import { createCodexAdapter } from '../adapters/codex';
import { createDeepseekAdapter } from '../adapters/deepseek';
import { createOpenrouterAdapter } from '../adapters/openrouter';
import { createClaudeIngestor } from '../ingestors/claude-statusline';
import type { Db } from '../db/client';
import { applyRetention, finishRun, recordAttempt, startRun } from '../db/repository';
import type { RunTrigger } from '../db/repository';
import { safeErrorMessage } from '../redact';
import { nowIso } from '../time';
import type { Logger } from '../logger';
import { silentLogger } from '../logger';

export function buildAdapters(config: AppConfig): ProviderAdapter[] {
  return [
    createCodexAdapter(),
    createClaudeIngestor({ spoolPath: config.spoolPath }),
    createDeepseekAdapter({ apiKey: config.credentials.deepseekApiKey }),
    createOpenrouterAdapter({ managementKey: config.credentials.openrouterManagementKey }),
  ];
}

export interface AttemptRecord {
  readonly provider: Provider;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly result: CollectionResult;
}

/**
 * Run one adapter to a terminal state. Never rejects.
 *
 * The timeout is enforced two ways. The `AbortSignal` asks a cooperative
 * adapter to stop, and the `Promise.race` below guarantees the *collector*
 * stops waiting regardless — aborting a signal cannot cancel an adapter that
 * never checks it, and one such adapter must not be able to hold the whole run
 * open. An abandoned adapter still runs its own `finally` when it eventually
 * settles, which is where child processes and sockets get reaped.
 */
export async function runAdapter(adapter: ProviderAdapter): Promise<AttemptRecord> {
  const startedAt = nowIso();
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const ceiling = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort(new Error('timeout'));
      reject(
        new CollectionError(
          'timeout',
          `${adapter.provider} exceeded its ${adapter.timeoutMs}ms budget`,
        ),
      );
    }, adapter.timeoutMs);
  });

  try {
    const snapshot = await Promise.race([adapter.collect(controller.signal), ceiling]);
    return {
      provider: adapter.provider,
      startedAt,
      finishedAt: nowIso(),
      result: { outcome: 'success', snapshot, retryCount: 0 },
    };
  } catch (err) {
    const code: ErrorCode =
      err instanceof CollectionError
        ? err.code
        : controller.signal.aborted
          ? 'timeout'
          : 'unknown_error';

    return {
      provider: adapter.provider,
      startedAt,
      finishedAt: nowIso(),
      result: {
        // A missing credential is a configuration state, not a fault, and the
        // card must say "unavailable" rather than shouting "error".
        outcome: isUnavailable(code) ? 'unavailable' : 'error',
        failure: {
          provider: adapter.provider,
          attemptedAt: startedAt,
          code,
          safeMessage: safeErrorMessage(err),
          retryable: isRetryable(code),
        },
        retryCount: 0,
      },
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export interface CollectOptions {
  readonly db: Db;
  readonly config: AppConfig;
  readonly trigger: RunTrigger;
  /** Restrict the run to these providers (manual per-provider refresh). */
  readonly providers?: readonly Provider[];
  readonly adapters?: readonly ProviderAdapter[];
  readonly logger?: Logger;
  /** Retention runs on scheduled collections only; a manual refresh stays cheap. */
  readonly applyRetentionPolicy?: boolean;
}

export interface CollectSummary {
  readonly runId: number;
  readonly durationMs: number;
  readonly success: number;
  readonly unavailable: number;
  readonly error: number;
  readonly deduplicated: number;
  readonly prunedSnapshots: number;
  readonly attempts: readonly {
    provider: Provider;
    outcome: 'success' | 'unavailable' | 'error';
    code: ErrorCode | null;
  }[];
}

/** One idempotent collection pass. */
export async function collectOnce(options: CollectOptions): Promise<CollectSummary> {
  const log = options.logger ?? silentLogger;
  const all = options.adapters ?? buildAdapters(options.config);
  const selected = options.providers
    ? all.filter((a) => options.providers?.includes(a.provider))
    : all;

  const startedAtMs = Date.now();
  const runId = startRun(options.db, options.trigger);
  log.info('collector run started', {
    runId,
    trigger: options.trigger,
    providers: selected.map((a) => a.provider),
  });

  // Independent providers race in parallel; `runAdapter` never rejects, so one
  // provider's failure cannot reject the whole batch.
  const records = await Promise.all(selected.map((adapter) => runAdapter(adapter)));

  let success = 0;
  let unavailable = 0;
  let error = 0;
  let deduplicated = 0;

  for (const record of records) {
    // Each attempt is its own short transaction, so a write failure for one
    // provider cannot roll back another's observation.
    try {
      const written = recordAttempt(options.db, {
        runId,
        provider: record.provider,
        startedAt: record.startedAt,
        finishedAt: record.finishedAt,
        retryCount: record.result.retryCount,
        result:
          record.result.outcome === 'success'
            ? { outcome: 'success', snapshot: record.result.snapshot }
            : { outcome: record.result.outcome, failure: record.result.failure },
      });
      if (written.deduplicated) deduplicated += 1;
    } catch (err) {
      log.error('failed to persist attempt', {
        provider: record.provider,
        error: safeErrorMessage(err),
      });
    }

    if (record.result.outcome === 'success') {
      success += 1;
      log.info('provider collected', { provider: record.provider });
    } else if (record.result.outcome === 'unavailable') {
      unavailable += 1;
      log.info('provider unavailable', {
        provider: record.provider,
        code: record.result.failure.code,
      });
    } else {
      error += 1;
      log.warn('provider failed', {
        provider: record.provider,
        code: record.result.failure.code,
        message: record.result.failure.safeMessage,
      });
    }
  }

  let prunedSnapshots = 0;
  if (options.applyRetentionPolicy ?? options.trigger === 'scheduled') {
    try {
      prunedSnapshots = applyRetention(options.db, options.config.retentionDays);
    } catch (err) {
      log.error('retention failed', { error: safeErrorMessage(err) });
    }
  }

  finishRun(options.db, runId, startedAtMs);
  const durationMs = Date.now() - startedAtMs;

  log.info('collector run finished', {
    runId,
    durationMs,
    success,
    unavailable,
    error,
    deduplicated,
    prunedSnapshots,
  });

  return {
    runId,
    durationMs,
    success,
    unavailable,
    error,
    deduplicated,
    prunedSnapshots,
    attempts: records.map((r) => ({
      provider: r.provider,
      outcome: r.result.outcome,
      code: r.result.outcome === 'success' ? null : r.result.failure.code,
    })),
  };
}
