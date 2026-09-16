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
 *   - **One run, at most one attempt per provider.** Success and failure
 *     counts are derived from the attempt rows, so a partial run is fully
 *     auditable and the summary can never drift from the detail. An attempt
 *     that could not be written is therefore an error, whatever the adapter
 *     returned. The one run that writes none is a deferred one
 *     (`CollectionDeferred`): it observed nothing and another run owns the
 *     answer, so a row from it would only mask that run's result.
 */
import type { AppConfig } from '../config';
import { CLAUDE_PROBE_SOURCE_VERSION } from '../domain';
import type { CollectContext, CollectionResult, Provider, ProviderAdapter } from '../domain';
import { CollectionDeferred, CollectionError, isRetryable, isUnavailable } from '../errors';
import type { ErrorCode } from '../errors';
import { createClaudeAdapter } from '../adapters/claude-usage';
import { createCodexAdapter } from '../adapters/codex';
import { createDeepseekAdapter } from '../adapters/deepseek';
import { createOpenrouterAdapter } from '../adapters/openrouter';
import { maxAgeMs } from '../freshness';
import type { Db } from '../db/client';
import { readProviderCredentials } from '../db/credentials';
import type { ProviderCredentials } from '../db/credentials';
import {
  applyRetention,
  claimClaudePoll,
  finishRun,
  recordAttempt,
  startRun,
} from '../db/repository';
import type { RunTrigger } from '../db/repository';
import { safeErrorMessage } from '../redact';
import { nowIso } from '../time';
import type { Logger } from '../logger';
import { silentLogger } from '../logger';

/**
 * Exactly one adapter per provider. Claude's is a composite of the optional
 * quota probe and the status-line spool, never a second adapter named `claude`:
 * attempts are partitioned by provider alone, so two would overwrite each
 * other's latest row.
 */
export function buildAdapters(
  config: AppConfig,
  keys: ProviderCredentials,
  db: Db,
): ProviderAdapter[] {
  return [
    createCodexAdapter(),
    createClaudeAdapter({
      spoolPath: config.spoolPath,
      usageToken: keys.claudeUsageToken,
      // The database, not process memory, holds the cadence: the scheduled
      // collector is a fresh process every run, and manual refresh shares it.
      claimPoll: (attemptedAt) =>
        claimClaudePoll(db, attemptedAt, config.claudePollIntervalMinutes * 60_000),
      // A spool reading that would still be fresh as a probe reading answers the
      // run; the probe spends quota only when no session is reporting.
      spoolFreshMs: maxAgeMs('claude', CLAUDE_PROBE_SOURCE_VERSION, config),
    }),
    createDeepseekAdapter({ apiKey: keys.deepseekApiKey }),
    createOpenrouterAdapter({ managementKey: keys.openrouterManagementKey }),
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
  // Counted per call, and read on every exit path: a failure that exhausted its
  // retries, or one cut off by the ceiling, still records what it spent.
  let retries = 0;
  const context: CollectContext = {
    recordRetry: () => {
      retries += 1;
    },
  };
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
    const snapshot = await Promise.race([adapter.collect(controller.signal, context), ceiling]);
    return {
      provider: adapter.provider,
      startedAt,
      finishedAt: nowIso(),
      result: { outcome: 'success', snapshot, retryCount: retries },
    };
  } catch (err) {
    if (err instanceof CollectionDeferred) {
      return {
        provider: adapter.provider,
        startedAt,
        finishedAt: nowIso(),
        result: { outcome: 'deferred', reason: safeErrorMessage(err), retryCount: retries },
      };
    }
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
        retryCount: retries,
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
  /** Providers that recorded no attempt because another run owns the answer. */
  readonly deferred: number;
  readonly deduplicated: number;
  readonly prunedSnapshots: number;
  readonly attempts: readonly {
    provider: Provider;
    outcome: 'success' | 'unavailable' | 'error' | 'deferred';
    code: ErrorCode | null;
  }[];
}

/** One idempotent collection pass. */
export async function collectOnce(options: CollectOptions): Promise<CollectSummary> {
  const log = options.logger ?? silentLogger;
  // Keys are read on every run and never cached, so a key saved in Settings
  // applies to the next scheduled run and to an immediate manual refresh.
  const all =
    options.adapters ??
    buildAdapters(options.config, readProviderCredentials(options.db), options.db);
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
  let deferred = 0;
  let deduplicated = 0;
  const attempts: CollectSummary['attempts'][number][] = [];

  for (const record of records) {
    if (record.result.outcome === 'deferred') {
      // Nothing is written: the latest attempt must stay the run that did the work.
      deferred += 1;
      attempts.push({ provider: record.provider, outcome: 'deferred', code: null });
      log.info('provider deferred', { provider: record.provider, reason: record.result.reason });
      continue;
    }
    let outcome: 'success' | 'unavailable' | 'error' = record.result.outcome;
    let code = record.result.outcome === 'success' ? null : record.result.failure.code;

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
      // Nothing reached the database, so nothing is auditable: reporting the
      // adapter's success would make the run, and the unit's exit code, green
      // over lost data.
      log.error('failed to persist attempt', {
        provider: record.provider,
        error: safeErrorMessage(err),
      });
      outcome = 'error';
      code = 'io_error';
    }
    attempts.push({ provider: record.provider, outcome, code });

    if (outcome === 'success') {
      success += 1;
      log.info('provider collected', { provider: record.provider });
    } else if (outcome === 'unavailable') {
      unavailable += 1;
      log.info('provider unavailable', { provider: record.provider, code });
    } else {
      error += 1;
      if (record.result.outcome !== 'success' && code === record.result.failure.code) {
        log.warn('provider failed', {
          provider: record.provider,
          code,
          message: record.result.failure.safeMessage,
        });
      }
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
    deferred,
    deduplicated,
    prunedSnapshots,
  });

  return {
    runId,
    durationMs,
    success,
    unavailable,
    error,
    deferred,
    deduplicated,
    prunedSnapshots,
    attempts,
  };
}
